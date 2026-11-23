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
function detectAll() {
  return {
    java: detect('java'),
    python: detect('python'),
    mvn: detect('mvn'),
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

module.exports = { run, cancel, cancelAll, detect, detectAll, DEFAULT_TIMEOUT };
