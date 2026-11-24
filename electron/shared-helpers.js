'use strict';
/**
 * shared-helpers.js —— 多个 IPC 域共用的后端辅助逻辑。
 *
 * 从 main.js 搬迁而来，行为与搬迁前完全一致。
 * 这几个函数被 3 个以上的域用到（app / settings / jmx / jmxgen / jtl），
 * 放这里而不是塞进某一个域，避免域与域之间互相 require。
 *
 * 注意：settings 是 main.js 里的活对象（loadSettings() 会整体替换），
 * 所以这里一律由调用方传进来，**不在本模块里缓存**。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assertCommandPath, buildCmdExeInvocation } = require('../shared/shell-safety');
const { isInsideRoot } = require('./scan-rules');

function publicSettings(settings) {
  return {
    projectDir: settings.projectDir || '',
    javaHome: settings.javaHome || '',
    pythonPath: settings.pythonPath || '',
    mvnPath: settings.mvnPath || '',
    themeColor: settings.themeColor || 'purple',
    bgImage: settings.bgImage || '',
    bgOpacity: settings.bgOpacity === undefined ? 85 : settings.bgOpacity,
    bgTextMode: settings.bgTextMode || 'auto',
    bgOverlay: settings.bgOverlay === undefined ? 35 : settings.bgOverlay,
    bgOverlayColor: settings.bgOverlayColor === 'light' ? 'light' : 'dark',
    autoLockMinutes: settings.autoLockMinutes,
    clipboardClearSeconds: settings.clipboardClearSeconds,
    openCopyPassword: settings.openCopyPassword !== false,
    closeAction: settings.closeAction === 'quit' ? 'quit' : 'tray',
    workspaceDir: settings.workspaceDir || '',
    casesDir: settings.casesDir || '',
    jmxDir: settings.jmxDir || '',
    reportDir: settings.reportDir || '',
    allureDir: settings.allureDir || '',
    kbDir: settings.kbDir || '',
    notesDir: settings.notesDir || '',
    jmeterPath: settings.jmeterPath || '',
    hasPin: !!settings.pin
  };
}

/**
 * 探测 JMeter。优先级：
 *   1. 设置里存的路径
 *   2. 环境变量 JMETER_HOME（指向 JMeter 安装目录，不是 bin）
 *   3. PATH 里的 jmeter
 *   4. 常见安装位置（兜底，不保证存在）
 * 探测到就写回设置，否则设置页永远显示空、用户以为没生效。
 */
function detectJmeter(settings, saveSettings) {
  const candidates = [];
  if (settings.jmeterPath) candidates.push(settings.jmeterPath);

  // 环境变量：JMETER_HOME 指向安装目录
  const home = process.env.JMETER_HOME;
  if (home) {
    candidates.push(path.join(home, 'bin', 'jmeter.bat'));
    candidates.push(path.join(home, 'bin', 'jmeter'));
  }

  // PATH 里的 jmeter（Windows 上可能是 .bat 或 .cmd）
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'jmeter.bat'));
    candidates.push(path.join(dir, 'jmeter.cmd'));
  }

  // 常见安装位置兜底
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const ver of ['5.6.3', '5.5', '5.4.3']) {
      candidates.push(path.join(drive + path.sep, `apache-jmeter-${ver}`, 'bin', 'jmeter.bat'));
    }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      if (settings.jmeterPath !== c) {
        settings.jmeterPath = c;
        try {
          saveSettings();
        } catch (err) {
          /* 存不下也不影响本次使用 */
        }
      }
      return c;
    }
  }
  return '';
}

/**
 * 读 JMeter 版本（不启动 JMeter）。
 * jar 名不带版本号，所以依次试：目录名 → jmeter.properties 里的注释 → jar 的 MANIFEST。
 */
function jmeterVersionOf(batPath) {
  try {
    const home = path.dirname(path.dirname(batPath));
    // 1) 目录名里通常带版本：apache-jmeter-5.4.3
    const m = /jmeter[-_]?([\d]+\.[\d]+(?:\.[\d]+)?)/i.exec(path.basename(home));
    if (m) return m[1];

    // 2) jmeter.properties 顶部注释
    const propsFile = path.join(home, 'bin', 'jmeter.properties');
    if (fs.existsSync(propsFile)) {
      const head = fs.readFileSync(propsFile, 'utf8').slice(0, 2000);
      const pm = /jmeter[- ]?([\d]+\.[\d]+(?:\.[\d]+)?)/i.exec(head);
      if (pm) return pm[1];
    }

    // 3) jar 的 MANIFEST.MF（zip 里找 Implementation-Version）
    const jar = path.join(home, 'lib', 'ext', 'ApacheJMeter_core.jar');
    if (fs.existsSync(jar)) {
      const buf = fs.readFileSync(jar);
      const text = buf.toString('latin1');
      const vm = /Implementation-Version:\s*([\d.]+)/.exec(text);
      if (vm) return vm[1];
    }
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * 启动 JMeter。
 *
 * Windows 上**不能直接 spawn 一个 .bat**：Node 从 CVE-2024-27980 修复后
 * 禁止直接执行批处理文件，会抛 EINVAL。必须经 cmd.exe。
 *
 * 但**不能**开 shell 模式（v0.42.0 的做法）：那条路上 jmxFile 会被拼进
 * 一个字符串，`x.jmx & calc` 就是两条命令。现在用
 * `cmd.exe /d /s /c ""jmeter.bat" "-t" "x.jmx""`，每个参数单独加引号，
 * 并且先校验脚本路径里没有会被 cmd 解释的字符（见 shared/shell-safety.js）。
 */
function launchJmeter(settings, saveSettings, jmxFile) {
  /**
   * 先校验入参，再探 JMeter：
   * 非法脚本路径属于「输入错误」，不管本机装没装 JMeter 都该直接拒绝，
   * 否则没装 JMeter 的机器会返回 JMETER_NOT_FOUND，掩盖掉真实的注入尝试。
   */
  let jmx = '';
  if (jmxFile) {
    const jmxCheck = assertCommandPath(jmxFile, 'JMeter 脚本');
    if (!jmxCheck.ok) return { ok: false, code: jmxCheck.code, message: jmxCheck.message };
    jmx = jmxCheck.value;
    if (!fs.existsSync(jmx)) {
      return { ok: false, code: 'JMX_NOT_FOUND', message: '脚本文件不存在：' + jmx };
    }
  }

  const bat = detectJmeter(settings, saveSettings);
  if (!bat) {
    return {
      ok: false,
      code: 'JMETER_NOT_FOUND',
      message: '没找到 JMeter。请到「设置 → 压测」里点「选择…」指定 jmeter.bat 的路径（通常在 JMeter 安装目录的 bin 下）'
    };
  }

  // 命令行注入防线：启动脚本路径也会被拼进命令行，同样过白名单
  const batCheck = assertCommandPath(bat, 'JMeter 启动脚本');
  if (!batCheck.ok) return { ok: false, code: batCheck.code, message: batCheck.message };

  const args = jmx ? ['-t', jmx] : [];
  // 只用于界面展示与排查（"命令到底是什么"），实际执行走 argv
  const command = [quoteForDisplay(bat)].concat(args.map(quoteForDisplay)).join(' ');

  try {
    const child =
      process.platform === 'win32'
        ? (() => {
            const inv = buildCmdExeInvocation(bat, args);
            return spawn(inv.file, inv.args, {
              cwd: path.dirname(bat),
              detached: true,
              stdio: 'ignore',
              windowsHide: false,
              windowsVerbatimArguments: true
            });
          })()
        : spawn(bat, args, { cwd: path.dirname(bat), detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.error('[jmeter] spawn error', err);
    });
    child.unref();
    return { ok: true, jmeter: bat, version: jmeterVersionOf(bat), command };
  } catch (err) {
    const code = (err && err.code) || '';
    let message = (err && err.message) || '启动 JMeter 失败';
    if (code === 'EINVAL') {
      message = '启动失败（EINVAL）：Windows 不允许直接执行 .bat，已改用 cmd.exe 方式；如果仍失败请检查路径是否含特殊字符';
    } else if (code === 'ENOENT') {
      message = '启动失败：找不到 ' + bat + '，请到设置里重新指定';
    } else if (code === 'EACCES') {
      message = '启动失败：没有执行权限，' + bat;
    }
    return { ok: false, code, message };
  }
}

/** 展示用的引号（不做安全承诺，执行走 argv） */
function quoteForDisplay(p) {
  return '"' + String(p) + '"';
}

/* ==========================================================================
 * 路径归属校验：assertPathIn / isPathAllowed
 *
 * 背景（v0.42.0 的安全缺口）：
 *   scan-rules.js 里早就写好了 isInsideRoot()（realpath 归一化、大小写统一、
 *   兄弟目录拒绝），scripts/test-rules.cjs 也测了越界用例 ——
 *   但**全仓零业务调用**，于是所有 `{ root }` / `{ file }` 入参照单全收。
 *   渲染进程传 `C:\Windows\System32\drivers\etc\hosts` 就能让主进程读它、
 *   传任意目录就能让 shell 打开它。
 *
 * 白名单 = 下面三种「可信根」的并集：
 *   1. 当前 settings 里的目录（工作区 / 用例 / jmx / 报告 / allure / 知识库 /
 *      笔记 / 代码项目）—— 用户自己配的，认定可信；
 *   2. 本次会话里 dialog 明确选过的路径（pickDir / pickFile 的返回值）；
 *   3. 本次会话里显式扫描过的根目录（*:scan 的 root 参数，见 ipc-guard.js）。
 *
 * 2 和 3 是**会话内记忆**：关掉程序就清空，不落盘。
 * ========================================================================== */

/** 参与白名单的 settings 字段（都是用户自己配的目录） */
const DIR_SETTING_KEYS = [
  'workspaceDir',
  'casesDir',
  'jmxDir',
  'reportDir',
  'allureDir',
  'kbDir',
  'notesDir',
  'projectDir'
];

/** 会话内可信根（dialog 选的 + 显式扫描的） */
const sessionRoots = new Set();

/**
 * 归一化：存在就 realpath（拆掉符号链接/目录联接），不存在就 resolve。
 * 目录联接是 Windows 上真实存在的绕过手法：`mklink /J link C:\Windows`
 * 之后 `link\System32\...` 字符串上不像越界，realpath 之后才露出来。
 */
function realOrResolve(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  try {
    return fs.realpathSync(s);
  } catch (e) {
    try {
      return path.resolve(s);
    } catch (e2) {
      return s;
    }
  }
}

function addSessionRoot(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  const real = realOrResolve(s);
  if (real) sessionRoots.add(real);
  return real;
}

/**
 * 记住 dialog 里明确选过的路径。
 * 传目录记目录本身；传文件记它所在的目录（openFile 只要放行所在目录）。
 * @param {string} p
 */
function rememberPicked(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  try {
    if (fs.existsSync(s) && fs.statSync(s).isFile()) return addSessionRoot(path.dirname(s));
  } catch (e) {
    /* 路径不存在就按目录处理 */
  }
  return addSessionRoot(s);
}

/**
 * 记住显式扫描过的根目录。
 * 为什么允许这种「间接信任」：界面上的「打开文件 / 定位」按钮拿到的路径
 * 来自扫描结果，扫描根本身就是用户给的。不记的话「选了目录 → 打开文件」
 * 这条正常流程会被守卫拦掉。
 * @param {string} p
 */
function rememberRoot(p) {
  return addSessionRoot(p);
}

/** 清空会话内记忆（测试用；正常运行只在进程退出时随进程消失） */
function resetSessionRoots() {
  sessionRoots.clear();
}

/** 当前会话记住的根（测试 / 日志用） */
function sessionRootsSnapshot() {
  return Array.from(sessionRoots);
}

/** settings 里的目录（空值跳过） */
function settingsRoots(settings) {
  const s = settings || {};
  const out = [];
  for (const key of DIR_SETTING_KEYS) {
    const v = String(s[key] == null ? '' : s[key]).trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 这个路径是否落在允许的根目录内。
 *
 * @param {string} target 待校验路径
 * @param {string[]} [extraRoots] 额外可信根（数据目录、备份目录…）
 * @param {object} [settings] 当前设置；不传则只看会话内记忆和 extraRoots
 * @returns {boolean}
 */
function isPathAllowed(target, extraRoots, settings) {
  const t = String(target == null ? '' : target).trim();
  if (!t) return false;
  const roots = settingsRoots(settings)
    .concat(Array.from(sessionRoots))
    .concat(Array.isArray(extraRoots) ? extraRoots : []);
  const nt = realOrResolve(t);
  if (!nt) return false;
  for (const r of roots) {
    const root = String(r == null ? '' : r).trim();
    if (!root) continue;
    const nr = realOrResolve(root);
    if (nr && isInsideRoot(nr, nt)) return true;
  }
  return false;
}

/**
 * 入参守卫：路径不在白名单内就返回一个**可以直接回给界面**的错误对象。
 *
 * 为什么返回对象而不是抛异常：
 *   这些 handler 的返回约定是 `{ ok:false, message }`，
 *   抛出去会被 Electron 包成 "Error invoking remote method"，用户看不懂。
 *
 * 用法：
 *   const bad = assertPathIn(dir);
 *   if (bad) return bad;
 *
 * @param {string} target
 * @param {string[]} [extraRoots]
 * @param {object} [settings]
 * @returns {null | {ok: false, code: string, message: string}} null = 通过
 */
function assertPathIn(target, extraRoots, settings) {
  const t = String(target == null ? '' : target).trim();
  if (!t) {
    return { ok: false, code: 'BAD_PATH', message: '缺少路径参数' };
  }
  if (isPathAllowed(t, extraRoots, settings)) return null;
  return {
    ok: false,
    code: 'OUTSIDE_ROOT',
    message: '路径不在允许的目录内，已拒绝：' + t
  };
}

/**
 * 皮肤背景图文件名白名单。
 *
 * **这是一个真实的路径穿越点**：settings.bgImage 被 path.join(skinDir(), bgImage)
 * 直接拼接，传 `..\..\..\Users\x\.ssh\id_rsa` 就能把私钥读成 data URL 回给界面。
 * 所以只接受「basename + 图片扩展名」，其余一律当空处理。
 *
 * @param {string} name
 * @returns {string} 合法文件名，或空串（= 没有背景图）
 */
const SKIN_FILE_RE = /^bg\.(?:png|jpe?g|webp|gif|bmp)$/i;
function safeSkinFileName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '';
  if (raw.indexOf('/') >= 0 || raw.indexOf('\\') >= 0) return '';
  if (path.basename(raw) !== raw) return '';
  if (raw === '.' || raw === '..') return '';
  if (!SKIN_FILE_RE.test(raw)) return '';
  return raw;
}

module.exports = {
  publicSettings,
  detectJmeter,
  jmeterVersionOf,
  launchJmeter,
  DIR_SETTING_KEYS,
  rememberPicked,
  rememberRoot,
  resetSessionRoots,
  sessionRootsSnapshot,
  settingsRoots,
  isPathAllowed,
  assertPathIn,
  safeSkinFileName
};