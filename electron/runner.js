'use strict';
/**
 * 代码运行器：spawn 子进程跑脚本，流式返回输出。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **流式输出**
 *    不等跑完再返回，边跑边推（IPC event）。用户能实时看到进度。
 *
 * 2. **Windows 的 .cmd 坑**
 *    Node 不能直接 spawn `.bat` / `.cmd`（CVE-2024-27980），
 *    必须 `shell: true` 或 `cmd /c`。mvn.cmd 就是这种情况。
 *
 * 3. **中文乱码**
 *    Windows 控制台默认 GBK，Node 按 UTF-8 解会乱码。
 *    用 `iconv-lite` 转（或让子进程输出 UTF-8）。
 *
 * 4. **超时 kill**
 *    跑 5 分钟没结束就杀，防止卡死。
 *    注意：Windows 上 kill 要连子进程（`taskkill /t`）。
 *
 * 5. **环境探测**
 *    自动找 java / python / mvn 路径，找不到就报错让用户配。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 默认超时：5 分钟 */
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/** 当前正在跑的进程（id → { proc, timer }） */
const running = new Map();

let seq = 0;

/**
 * 探测可执行文件路径。
 * @param {string} name 命令名（java / python / mvn）
 * @returns {string} 绝对路径，找不到返回空串
 */
function detect(name) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];

  // 1. 先看 PATH
  const pathDirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch (e) {
        /* ignore */
      }
    }
  }

  // 2. 常见安装位置（Windows）
  if (isWin) {
    const candidates = {
      java: [
        'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe',
        'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe'
      ],
      python: [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        'D:\\python\\python.exe',
        'C:\\Python312\\python.exe'
      ],
      mvn: ['D:\\apache-maven-3.9.12\\bin\\mvn.cmd', 'C:\\apache-maven\\bin\\mvn.cmd']
    };
    for (const c of candidates[name] || []) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (e) {
        /* ignore */
      }
    }
  }

  return '';
}

/**
 * 探测所有运行器需要的环境。
 * @returns {{java: string, python: string, mvn: string, jmeter: string}}
 */
/**
 * 探测 JAVA_HOME。
 *
 * 为什么需要：Maven 用 JAVA_HOME 决定 JDK 版本，不是 PATH 里的 java。
 * 用户系统里 JAVA_HOME 可能指向 JDK 8，而项目要求 17 → 编译报「无效目标发行版」。
 *
 * 策略：
 *   1. 用户级 JAVA_HOME（优先，用户自己配的）
 *   2. 系统级 JAVA_HOME
 *   3. 从 PATH 里的 java 反推（java.exe 在 {JAVA_HOME}/bin/java.exe）
 */
/**
 * 找所有已安装的 JDK。
 * @returns {{version: string, home: string}[]} 按版本降序
 */
function listJdks() {
  const roots = ['D:\\Java', 'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft'];
  const out = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const home = path.join(root, ent.name);
      const javaExe = path.join(home, 'bin', 'java.exe');
      if (!fs.existsSync(javaExe)) continue;
      // 从目录名猜版本：jdk-17 / jdk1.8.0_371 / jdk-17.0.12
      const m = /(?:jdk-?)(\d+)(?:\.(\d+))?/i.exec(ent.name);
      const major = m ? Number(m[1]) : 0;
      out.push({ version: major, home, name: ent.name });
    }
  }
  return out.sort((a, b) => b.version - a.version);
}

/**
 * 探测 JAVA_HOME。
 *
 * 为什么需要：Maven 用 JAVA_HOME 决定 JDK 版本，不是 PATH 里的 java。
 * 用户系统里 JAVA_HOME 可能指向 JDK 8，而项目要求 17 → 编译报「无效目标发行版」。
 *
 * @param {number} [wantVersion] 项目要求的 Java 版本（从 pom.xml 读）
 * @returns {string} JAVA_HOME 路径
 */
function detectJavaHome(wantVersion) {
  const jdks = listJdks();

  // 1. 项目要求了版本 → 找匹配的
  if (wantVersion) {
    const hit = jdks.find((j) => j.version === wantVersion);
    if (hit) return hit.home;
  }

  // 2. 环境变量
  const fromEnv = process.env.JAVA_HOME || '';
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'bin', 'java.exe'))) return fromEnv;

  // 3. 从 java 路径反推
  const javaPath = detect('java');
  if (javaPath) {
    const home = path.dirname(path.dirname(javaPath));
    if (fs.existsSync(path.join(home, 'bin', 'java.exe'))) return home;
  }

  // 4. 最高版本
  return jdks.length ? jdks[0].home : '';
}

/**
 * 从 pom.xml 读项目要求的 Java 版本。
 * @param {string} projectDir
 * @returns {number} 版本号，读不到返回 0
 */
function readJavaVersion(projectDir) {
  try {
    const pom = fs.readFileSync(path.join(projectDir, 'pom.xml'), 'utf8');
    // <java.version>17</java.version> 或 <maven.compiler.source>17</maven.compiler.source>
    const m = /<(?:java\.version|maven\.compiler\.(?:source|target|release))>\s*(\d+)/.exec(pom);
    return m ? Number(m[1]) : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 找所有已安装的 Python。
 *
 * 常见位置：
 *   - PATH 里的 python / python3
 *   - %LOCALAPPDATA%\Programs\Python\Python3xx
 *   - D:\python / C:\Python3xx
 *   - py launcher（Windows）
 *
 * @returns {{version: string, path: string, name: string}[]} 按版本降序
 */
function listPythons() {
  const out = [];
  const seen = new Set();

  const push = (exePath, name) => {
    if (!exePath || seen.has(exePath)) return;
    try {
      if (!fs.existsSync(exePath)) return;
    } catch (e) {
      return;
    }
    seen.add(exePath);
    // 从路径猜版本：Python312 / python3.12 / python.exe
    const m = /(?:Python|python)[- ]?(\d+)\.(\d+)/i.exec(exePath) || /Python(\d)(\d+)/i.exec(exePath);
    const version = m ? `${m[1]}.${m[2]}` : '';
    out.push({ version, path: exePath, name: name || path.basename(exePath) });
  };

  // 1. PATH 里的
  push(detect('python'), 'python');
  push(detect('python3'), 'python3');

  // 2. 常见安装目录
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'),
    'D:\\python',
    'C:\\Python312',
    'C:\\Python311',
    'C:\\Python310'
  ];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        push(path.join(root, ent.name, 'python.exe'), ent.name);
      } else if (/^python\.exe$/i.test(ent.name)) {
        push(path.join(root, ent.name), path.basename(root));
      }
    }
  }

  // 路径里没版本号的，跑一次 --version 拿（同步，最多 2 秒）
  for (const item of out) {
    if (item.version) continue;
    try {
      const res = require('child_process').spawnSync(item.path, ['--version'], {
        timeout: 2000,
        encoding: 'utf8',
        windowsHide: true
      });
      const text = String(res.stdout || '') + String(res.stderr || '');
      const m = /Python\s+(\d+)\.(\d+)/i.exec(text);
      if (m) item.version = `${m[1]}.${m[2]}`;
    } catch (e) {
      /* ignore */
    }
  }

  // 按版本降序（空版本排最后）
  return out.sort((a, b) => {
    const va = a.version ? Number(a.version.split('.')[0]) * 100 + Number(a.version.split('.')[1] || 0) : -1;
    const vb = b.version ? Number(b.version.split('.')[0]) * 100 + Number(b.version.split('.')[1] || 0) : -1;
    return vb - va;
  });
}

/**
 * 探测 Playwright 浏览器缓存。
 *
 * Java 和 Python 的 Playwright 共享同一个缓存目录：
 *   Windows: %LOCALAPPDATA%\ms-playwright
 *   macOS:   ~/Library/Caches/ms-playwright
 *   Linux:   ~/.cache/ms-playwright
 *
 * @returns {{found: boolean, dir: string, browsers: {name: string, size: number}[], totalSize: number}}
 */
function detectPlaywrightBrowsers() {
  const isWin = process.platform === 'win32';
  const dir = isWin
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright');

  if (!fs.existsSync(dir)) return { found: false, dir, browsers: [], totalSize: 0 };

  const browsers = [];
  let totalSize = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { found: false, dir, browsers: [], totalSize: 0 };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // 跳过 .links / .settings 这类元数据目录
    if (ent.name.startsWith('.')) continue;
    // 只认 chromium-* / firefox-* / webkit-*
    if (!/^(chromium|firefox|webkit)/i.test(ent.name)) continue;
    const full = path.join(dir, ent.name);
    let size = 0;
    try {
      size = dirSize(full);
    } catch (e) {
      size = 0;
    }
    browsers.push({ name: ent.name, size });
    totalSize += size;
  }

  return { found: browsers.length > 0, dir, browsers, totalSize };
}

/** 递归算目录大小（字节） */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch (e) {
      /* ignore */
    }
  }
  return total;
}

function detectAll() {
  return {
    java: detect('java'),
    python: detect('python'),
    mvn: detect('mvn'),
    javaHome: detectJavaHome(),
    playwright: detectPlaywrightBrowsers(),
    jmeter: '' // 由调用方从 settings 里取
  };
}

/**
 * 跑一个命令，流式回调输出。
 *
 * @param {object} opts
 * @param {string} opts.cmd 可执行文件
 * @param {string[]} opts.args 参数
 * @param {string} [opts.cwd] 工作目录
 * @param {object} [opts.env] 额外环境变量
 * @param {number} [opts.timeout] 超时（毫秒）
 * @param {(chunk: {stream: 'stdout'|'stderr', text: string}) => void} opts.onData 输出回调
 * @param {(result: {code: number|null, signal: string|null, duration: number, timedOut: boolean}) => void} opts.onExit 退出回调
 * @returns {string} 运行 id（可用于 cancel）
 */
function run(opts) {
  const id = `run-${++seq}-${Date.now()}`;
  const started = Date.now();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  // Windows 的 .cmd / .bat 必须 shell: true
  const isWin = process.platform === 'win32';
  const needsShell = isWin && /\.(cmd|bat)$/i.test(opts.cmd);

  let proc;
  try {
    proc = spawn(opts.cmd, opts.args || [], {
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, opts.env || {}),
      shell: needsShell,
      windowsHide: true
    });
  } catch (e) {
    opts.onExit({ code: -1, signal: null, duration: 0, timedOut: false, error: String(e && e.message) });
    return id;
  }

  // 超时 kill
  const timer = setTimeout(() => {
    try {
      if (isWin) {
        // Windows：连子进程一起杀
        spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true });
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) {
      /* ignore */
    }
    timedOut = true;
  }, timeout);

  let timedOut = false;

  // 输出解码：Windows 中文是 GBK
  const decode = (buf) => {
    // 先试 UTF-8，失败再试 GBK
    const utf8 = buf.toString('utf8');
    // 如果出现大量替换字符（U+FFFD），说明不是 UTF-8
    if (utf8.indexOf('\uFFFD') >= 0) {
      try {
        // Node 没有内置 GBK，用 TextDecoder
        return new TextDecoder('gbk').decode(buf);
      } catch (e) {
        return utf8;
      }
    }
    return utf8;
  };

  proc.stdout.on('data', (buf) => {
    opts.onData({ stream: 'stdout', text: decode(buf) });
  });
  proc.stderr.on('data', (buf) => {
    opts.onData({ stream: 'stderr', text: decode(buf) });
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    running.delete(id);
    opts.onExit({
      code: -1,
      signal: null,
      duration: Date.now() - started,
      timedOut,
      error: String(err && err.message)
    });
  });

  proc.on('close', (code, signal) => {
    clearTimeout(timer);
    running.delete(id);
    opts.onExit({
      code,
      signal,
      duration: Date.now() - started,
      timedOut
    });
  });

  running.set(id, { proc, timer });
  return id;
}

/**
 * 取消一个正在跑的任务。
 * @param {string} id
 * @returns {boolean} 是否找到并取消
 */
function cancel(id) {
  const hit = running.get(id);
  if (!hit) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(hit.proc.pid), '/f', '/t'], { windowsHide: true });
    } else {
      hit.proc.kill('SIGKILL');
    }
  } catch (e) {
    /* ignore */
  }
  clearTimeout(hit.timer);
  running.delete(id);
  return true;
}

/** 取消所有正在跑的任务（退出时调用） */
function cancelAll() {
  for (const id of Array.from(running.keys())) cancel(id);
}

module.exports = {
  run,
  cancel,
  cancelAll,
  detect,
  detectAll,
  detectJavaHome,
  detectPlaywrightBrowsers,
  listJdks,
  listPythons,
  readJavaVersion,
  DEFAULT_TIMEOUT
};
