'use strict';
/**
 * browser-session.js —— 「用系统浏览器实时高亮定位器」的会话管理（主进程侧）。
 *
 * ============================================================
 * 它负责什么
 * ============================================================
 *   1. 选浏览器：`auto` 读系统默认浏览器（注册表 UserChoice 的 ProgId），
 *      认不出就 Edge → Chrome；也可以显式指定 `edge` / `chrome`
 *      （路径不写死，全部由环境变量拼）；
 *   2. 拉起：随机空闲端口（10000-60000，实际由浏览器自己挑）+ 只绑 127.0.0.1 +
 *      独立 profile（`<dataDir>/sniff-profile`），不带 first-run 弹窗；
 *   3. 等就绪：**只认 `<profile>/DevToolsActivePort` + `/json/version`**
 *      （≤45 秒）。子进程的 exitCode 只记日志，不参与判断（见下面 v0.56 说明）；
 *   4. 单会话：已有会话就复用，url 不同才导航；用户自己关窗口/进程退出时
 *      status 必须如实返回 running:false；
 *   5. 只在自己的 target 上操作：连的是我们拉起的那个 page target，
 *      只发 Page/Runtime 的几个命令 + 关闭用的 Browser.close，
 *      不读 cookie/storage/页面内容。
 *
 * ============================================================
 * v0.56 真机 bug（同一根因链）修复要点
 * ============================================================
 *   bug1「浏览器刚拉起来就退出了…」：
 *     以前 waitDevToolsPort 用 `child.exitCode !== null` 判「提前退出」。
 *     Windows 上 Edge/Chrome 冷启动时 spawn 出来的往往只是一个**转发进程**：
 *     把命令行交给真正的主进程后它自己就退了，浏览器其实活得好好的。
 *     现在完全不看子进程存活/退出：只轮询 DevToolsActivePort 和 /json/version，
 *     子进程的 exit / error 只写日志。
 *
 *   bug2「首次校验开两个窗口 / 越点越多 / 后面被占用」：
 *     · 每次启动前先清残留：本平台拉起的 pid 记账在 `<profile>/tt-pids.json`
 *       （启动后立即写），下次启动前读它，**逐个用命令行校验**（该 pid 的命令行里
 *       必须含本 profile 的绝对路径 + `sniff-profile`）后才 kill；
 *       命令行不认识 / 不是 msedge/chrome 的 pid 一律不碰；
 *     · 不再「失败就换干净 profile 重试」（那就是第二个窗口的来源）；
 *       重试改成「先杀再重试」，并且只在 DevToolsActivePort 超时、
 *       且确实拿不到任何可用实例时才重试一次；
 *     · stop 三级：CDP `Browser.close`（浏览器级通道）→ taskkill 已知 pid 树 →
 *       还不行就如实报错，不假装关掉了。
 *
 * ============================================================
 * 为什么状态全在闭包里
 * ============================================================
 * 全局单例会让测试互相污染（上一个用例的浏览器跑到下一个用例里）。
 * createSession() 造实例，IPC 域只造一个；测试可以造自己的。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const highlight = require('./highlight');
const { createCdpClient, isClosedError } = require('./cdp');

/** 调试端口范围（需求指定：10000-60000 的随机空闲端口；实际由浏览器自己挑） */
const PORT_MIN = 10000;
const PORT_MAX = 60000;
/** 拉起浏览器后等就绪的上限
 *
 * 为什么是 45 秒：冷启动 + 首次建 profile 的机器上实测要 10 秒以上，15 秒余量太薄。
 * 宁可多等一会儿，也不要误判一个正在起来的浏览器。
 */
const READY_TIMEOUT_MS = 45000;
/** 轮询间隔 */
const POLL_INTERVAL_MS = 150;
/** 单条 CDP 命令默认超时 */
const CDP_TIMEOUT_MS = 15000;
/** 导航后等 load 事件的上限 */
const NAV_LOAD_TIMEOUT_MS = 8000;
/** 收到 Browser.close / taskkill 之后，等进程真正消失的上限 */
const KILL_TIMEOUT_MS = 6000;
/** 列进程（PowerShell/CIM）本身的超时 */
const PROC_LIST_TIMEOUT_MS = 20000;

const DEFAULT_MODE = 'css';

/** 浏览器选择：auto = 跟系统默认浏览器 */
const BROWSER_CHOICES = ['auto', 'edge', 'chrome'];
const DEFAULT_BROWSER_CHOICE = 'auto';
const BROWSER_LABEL = { edge: 'Edge', chrome: 'Chrome' };

/** 本平台浏览器的配置目录名（命令行里一定能看到它，是「这是我们的进程」的硬标记） */
const PROFILE_DIR_NAME = 'sniff-profile';
/** 命令行校验用的标记：profile 目录名本身 */
const PROFILE_MARKER = PROFILE_DIR_NAME;
/** pid 账本（写在 profile 里，随 profile 一起清） */
const PID_FILE_NAME = 'tt-pids.json';

/** 系统默认浏览器的注册表位置（HKCU 是「当前用户」的关联，不需要管理员） */
const URL_ASSOC_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';
/** 备用键：只有 http 认不出浏览器时才补看 https（极少数机器两个键不一致） */
const URL_ASSOC_KEY_HTTPS =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';

/** 只认这几种浏览器进程（不认识的 pid 一律不碰） */
const BROWSER_EXE_RE = /^(msedge|chrome|chromium)\.exe$/i;
const BROWSER_POSIX_RE = /^(msedge|chrome|chromium|google-chrome|google-chrome-stable|microsoft-edge)$/i;

/**
 * 两个地址是不是「同一个页面」。
 *
 * 只比 origin + pathname + search，忽略结尾斜杠和 hash：
 *   https://a.com/x 与 https://a.com/x/ 算同一个页面（很多站点会补斜杠）。
 */
function samePage(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(String(u || ''));
      const pathName = x.pathname.replace(/\/+$/, '') || '/';
      return x.origin + pathName + (x.search || '');
    } catch (e) {
      return '';
    }
  };
  const na = norm(a);
  const nb = norm(b);
  return !!na && na === nb;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** url 只允许 http/https（file:/javascript:/data: 一律拒绝） */
function isHttpUrl(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** 端口是否在需求范围内（只认数字：字符串从 UI 来时要先 Number） */
function isPortInRange(port) {
  return typeof port === 'number' && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
}

/** 从可执行文件名/路径猜浏览器类型 */
function browserNameOf(exePath) {
  return /edge/i.test(String(exePath || '')) ? 'edge' : 'chrome';
}

function isFileSync(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (e) {
    /* 权限不够就当没有 */
    return false;
  }
}

/**
 * 候选浏览器路径（**纯函数**，只拼路径不碰磁盘，方便单测）。
 *
 * 顺序是「显式指定 → 先 Edge 再 Chrome」；每种都覆盖
 *   Program Files / Program Files (x86) / %LOCALAPPDATA%
 * 三种安装位置（本机 Edge 实测装在 x86，Chrome 在 LOCALAPPDATA）。
 *
 * 注意：这里只管「有哪些路径」；**用哪个浏览器**由 resolveBrowser() 决定
 * （默认浏览器是 Chrome 就该先用 Chrome，v0.56 的真机 bug3）。
 *
 * @param {object} [env] 环境变量（默认 process.env）
 * @returns {Array<{name: 'edge'|'chrome', path: string}>}
 */
function browserCandidates(env) {
  const e = env || process.env;
  const out = [];
  const seen = new Set();
  const add = (name, p) => {
    const value = String(p || '').trim();
    if (!value) return;
    if (seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase());
    out.push({ name: name === 'edge' ? 'edge' : 'chrome', path: value });
  };

  const pf = e.ProgramFiles || e.PROGRAMFILES || '';
  const pf86 = e['ProgramFiles(x86)'] || e['PROGRAMFILES(X86)'] || '';
  const local = e.LOCALAPPDATA || '';

  // 显式指定优先：排查问题 / 装在不常见位置时用
  if (e.TT_SNIFF_BROWSER) add(browserNameOf(e.TT_SNIFF_BROWSER), e.TT_SNIFF_BROWSER);

  if (pf86) add('edge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (pf) add('edge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (local) add('edge', path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));

  if (e.CHROME_PATH) add('chrome', e.CHROME_PATH);
  if (pf) add('chrome', path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (pf86) add('chrome', path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (local) add('chrome', path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));

  return out;
}

/**
 * 找一台能用的浏览器（**老接口，保留**：Edge 优先）。
 *
 * 新的选择逻辑走 resolveBrowser()；这个函数留着是因为它是最朴素的
 * 「按候选顺序找第一台存在的」，排查时很好用。
 *
 * @param {object} [env]
 * @returns {{ok: true, name: 'edge'|'chrome', path: string, tried: string[]}
 *          |{ok: false, tried: string[], message: string}}
 */
function findBrowser(env) {
  const candidates = browserCandidates(env);
  const tried = [];
  for (const item of candidates) {
    tried.push(item.path);
    if (isFileSync(item.path)) {
      return { ok: true, name: item.name, path: item.path, tried, chosen: DEFAULT_BROWSER_CHOICE };
    }
  }
  return {
    ok: false,
    tried,
    message:
      '没有找到 Edge / Chrome（找过 ' +
      (tried.length ? tried.length + ' 个位置' : '0 个位置') +
      '）。可以用环境变量 TT_SNIFF_BROWSER 指定浏览器 exe 的完整路径'
  };
}

/* ============================================================
 * 浏览器选择（bug3）
 * ============================================================ */

/**
 * 宽松归一化：认不出的一律当 auto。
 * 严格校验走 parseBrowserChoice()（IPC 入参用它，好把写错的值得回给用户）。
 */
function normalizeBrowserChoice(value) {
  const raw = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();
  return BROWSER_CHOICES.indexOf(raw) >= 0 ? raw : DEFAULT_BROWSER_CHOICE;
}

/**
 * 严格解析入参里的 browser。
 *
 * 缺省 / 空串 → auto；只认 auto / edge / chrome；写错了要明确报错，
 * 而不是悄悄当成 auto（那样用户会以为「我指定了 Chrome」）。
 *
 * @param {*} value
 * @returns {{ok: boolean, choice: 'auto'|'edge'|'chrome', message?: string}}
 */
function parseBrowserChoice(value) {
  if (value === undefined || value === null) return { ok: true, choice: DEFAULT_BROWSER_CHOICE };
  const raw = String(value).trim().toLowerCase();
  if (!raw) return { ok: true, choice: DEFAULT_BROWSER_CHOICE };
  if (BROWSER_CHOICES.indexOf(raw) >= 0) return { ok: true, choice: raw };
  return {
    ok: false,
    choice: DEFAULT_BROWSER_CHOICE,
    message: '浏览器只能是 auto / edge / chrome（收到「' + String(value).slice(0, 40) + '」）'
  };
}

/**
 * 注册表里的 ProgId → 浏览器名（**纯函数**）。
 *
 * Chrome 是 `ChromeHTML`，Edge 是 `MSEdgeHTM`；别的浏览器（Firefox 的
 * `FirefoxURL-*`、PDF 阅读器的 `AcrobatURL` 之类）一律认不出 → 空串。
 *
 * @param {string} progId
 * @returns {'chrome'|'edge'|''}
 */
function progIdToBrowser(progId) {
  const v = String(progId === undefined || progId === null ? '' : progId).trim();
  if (!v) return '';
  if (/^chromehtml/i.test(v)) return 'chrome';
  if (/^(msedgehtm|microsoftedge)/i.test(v)) return 'edge';
  return '';
}

/**
 * 读一条 UserChoice 的 ProgId（内部工具，**纯读取**：失败/没有键都回空串）。
 *
 * @param {string} key 注册表键
 * @param {Function} run spawnSync
 * @returns {string}
 */
function queryProgId(key, run) {
  try {
    const r = run('reg', ['query', key, '/v', 'ProgId'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    if (!r || r.error || r.status !== 0) return '';
    const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(r.stdout || ''));
    return m ? String(m[1]).trim() : '';
  } catch (e) {
    return '';
  }
}

/**
 * 读「当前用户默认浏览器」的 ProgId。
 *
 * 需求写的是 `...\UrlAssociations\http\UserChoice`；这里以 **http 键为准**，
 * 只有 http 认不出浏览器时（键不存在 / ProgId 是 AcrobatURL 这类非浏览器）才
 * 补看一眼 **https 键**——极少数机器上两个键会指向不同程序，多看一只能少一次
 * 「明明设了 Chrome 却按 Edge 起」的困惑。两个都认不出就回空串，
 * 调用方据此退回 Edge → Chrome 的顺序。**不抛异常、不联网**。
 *
 * @param {object} [options] {spawnSync, defaultProgId}（defaultProgId 用于单测注入）
 * @returns {string}
 */
function readDefaultBrowserProgId(options) {
  const o = options || {};
  if (o.defaultProgId !== undefined) return String(o.defaultProgId === null ? '' : o.defaultProgId).trim();
  if (process.platform !== 'win32') return '';
  const run = typeof o.spawnSync === 'function' ? o.spawnSync : spawnSync;
  const http = queryProgId(URL_ASSOC_KEY, run);
  if (progIdToBrowser(http)) return http;
  const https = queryProgId(URL_ASSOC_KEY_HTTPS, run);
  if (progIdToBrowser(https)) return https;
  // 两个都不是浏览器：把 http 的原值回给日志（排查时能看出「系统默认是 PDF 阅读器」这种事实）
  return http || https;
}

/**
 * 决定这次用哪个浏览器（**纯选择逻辑 + 一次只读注册表**）。
 *
 *   auto   → 先看系统默认浏览器；识别得出就先它、再另一个；认不出就 Edge → Chrome
 *   edge   → 只用 Edge（找不到就明确报错，不偷偷换成 Chrome）
 *   chrome → 只用 Chrome（同上）
 *
 * @param {'auto'|'edge'|'chrome'} choice
 * @param {object} [env]
 * @param {object} [options] {spawnSync, defaultProgId}
 * @returns {{ok:true, name:'edge'|'chrome', path:string, tried:string[], chosen:string,
 *            source:string, progId?:string}
 *          |{ok:false, chosen:string, tried:string[], message:string}}
 */
function resolveBrowser(choice, env, options) {
  const o = options || {};
  const parsed = parseBrowserChoice(choice);
  if (!parsed.ok) return { ok: false, chosen: parsed.choice, tried: [], message: parsed.message };
  const chosen = parsed.choice;

  const tried = [];
  const pick = (names) => {
    for (const name of names) {
      for (const c of browserCandidates(env)) {
        if (c.name !== name) continue;
        tried.push(c.path);
        if (isFileSync(c.path)) return c;
      }
    }
    return null;
  };

  const triedText = tried.length ? tried.length + ' 个位置' : '0 个位置';
  const notFound = (names) => {
    const list = names.map((n) => BROWSER_LABEL[n] || n).join(' / ');
    return {
      ok: false,
      chosen,
      tried,
      message:
        '没有找到 ' + list + '（找过 ' + triedText + '）。' +
        '可以用环境变量 TT_SNIFF_BROWSER 指定浏览器 exe 的完整路径'
    };
  };

  if (chosen === 'edge' || chosen === 'chrome') {
    const hit = pick([chosen]);
    if (!hit) {
      const miss = notFound([chosen]);
      miss.message = '你指定用 ' + BROWSER_LABEL[chosen] + '，但本机没找到它的可执行文件：' + miss.message;
      return miss;
    }
    return { ok: true, name: hit.name, path: hit.path, tried, chosen, source: 'explicit' };
  }

  const progId = o.defaultProgId !== undefined ? String(o.defaultProgId || '') : readDefaultBrowserProgId(o);
  const preferred = progIdToBrowser(progId);
  const order = preferred ? [preferred, preferred === 'edge' ? 'chrome' : 'edge'] : ['edge', 'chrome'];
  const hit = pick(order);
  if (!hit) {
    const miss = notFound(['edge', 'chrome']);
    miss.progId = progId;
    return miss;
  }
  const source = !preferred
    ? 'no-default-info'
    : hit.name === preferred
      ? 'default-browser'
      : 'fallback';
  return { ok: true, name: hit.name, path: hit.path, tried, chosen, source, progId, preferred };
}

/** resolveBrowser 的结果 → 一句人话（日志/排查用） */
function describeBrowserSource(resolved) {
  const r = resolved || {};
  if (r.source === 'explicit') return '按你的选择';
  if (r.source === 'default-browser') return '系统默认浏览器' + (r.progId ? '（' + r.progId + '）' : '');
  if (r.source === 'fallback') {
    return '系统默认浏览器是 ' + (BROWSER_LABEL[r.preferred] || r.preferred) + '，但没找到它的程序，退而用 ' + (BROWSER_LABEL[r.name] || r.name);
  }
  return '认不出系统默认浏览器（' + (r.progId || '无 ProgId') + '），按 Edge → Chrome 的顺序找';
}

/* ============================================================
 * 进程盘点：只认「命令行里写着我们 profile 的浏览器进程」
 * ============================================================ */

/** 把命令行/路径归一化，便于大小写、斜杠不敏感地比对 */
function normalizeForMatch(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * 这条命令行是不是「本平台为本会话拉起的浏览器」（**纯函数**）。
 *
 * 两个条件必须同时满足：
 *   1. 命令行里有 `sniff-profile`（本平台专用目录名）；
 *   2. 命令行里有**本次会话 profile 的绝对路径**（避免误伤别的会话/别的临时目录）。
 *
 * @param {string} cmd 进程命令行
 * @param {string} profileDir 本次会话的 profile 目录
 */
function isOurProfileCommand(cmd, profileDir) {
  const c = normalizeForMatch(cmd);
  if (!c) return false;
  if (c.indexOf(PROFILE_MARKER) < 0) return false;
  const dir = normalizeForMatch(profileDir).replace(/\\+$/, '');
  if (!dir) return true;
  return c.indexOf(dir) >= 0;
}

/** 是不是浏览器主进程（主进程没有 --type=，渲染/GPU/工具进程都有） */
function isMainBrowserProcess(cmd) {
  const text = String(cmd || '');
  if (!text) return false;
  return !/--type=/.test(text);
}

/** 进程名是不是浏览器（不认的进程一律不碰） */
function isBrowserProcessName(name) {
  const v = String(name || '').trim();
  if (!v) return false;
  return BROWSER_EXE_RE.test(v) || BROWSER_POSIX_RE.test(v);
}

const WIN_PROCESS_QUERY =
  '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe' or Name='chromium.exe'\" | " +
  'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';

/**
 * 解析 `Get-CimInstance ... | ConvertTo-Json` 的输出（**纯函数**）。
 * @returns {{ok:boolean, list:Array<{pid:number,name:string,cmd:string}>, message?:string}}
 */
function parseProcessList(stdout) {
  const text = String(stdout === undefined || stdout === null ? '' : stdout).replace(/^\uFEFF/, '').trim();
  if (!text) return { ok: true, list: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, list: [], message: '进程列表不是合法 JSON：' + String((e && e.message) || e) };
  }
  if (!data) return { ok: true, list: [] };
  const arr = Array.isArray(data) ? data : [data];
  const list = [];
  for (const one of arr) {
    if (!one || typeof one !== 'object') continue;
    const pid = Number(one.ProcessId !== undefined ? one.ProcessId : one.processId);
    const name = String(one.Name !== undefined ? one.Name : one.name || '');
    const cmd = String(one.CommandLine !== undefined ? one.CommandLine : one.commandLine || '');
    if (!Number.isInteger(pid) || pid <= 0) continue;
    list.push({ pid, name, cmd });
  }
  return { ok: true, list };
}

/** 解析 POSIX `ps -axo pid=,comm=,args=` 的输出（**纯函数**，只在非 Windows 用） */
function parsePsOutput(stdout) {
  const list = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    list.push({ pid: Number(m[1]), name: path.basename(m[2]), cmd: m[3] });
  }
  return { ok: true, list };
}

/**
 * 列本机所有浏览器进程（pid + 名字 + 命令行）。
 *
 * 为什么用命令行：Windows 上 spawn 出来的 `child.pid` 可能只是个转发进程，
 * 真正的浏览器主进程是另一个 pid。**只有命令行里写着我们 profile 的进程才是我们的**。
 *
 * 失败（没有 PowerShell / 超时）时回 ok:false —— 这时候**不要杀任何东西**，
 * 让上层如实报错，而不是瞎猜。
 *
 * @param {object} [options] {spawnSync, powershellPath}
 */
function listBrowserProcesses(options) {
  const o = options || {};
  const run = typeof o.spawnSync === 'function' ? o.spawnSync : spawnSync;
  try {
    if (process.platform === 'win32') {
      const ps = String(o.powershellPath || 'powershell.exe');
      const r = run(
        ps,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PROCESS_QUERY],
        { encoding: 'utf8', timeout: PROC_LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
      );
      if (!r || r.error || r.status !== 0) {
        const detail = String((r && r.error && r.error.message) || (r && r.stderr) || '').trim();
        return { ok: false, list: [], message: '列浏览器进程失败：' + (detail || '没有输出') };
      }
      return parseProcessList(r.stdout);
    }
    const r = run('ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8', timeout: PROC_LIST_TIMEOUT_MS });
    if (!r || r.error || r.status !== 0) {
      return { ok: false, list: [], message: '列浏览器进程失败：' + String((r && r.error && r.error.message) || '') };
    }
    return parsePsOutput(r.stdout);
  } catch (e) {
    return { ok: false, list: [], message: '列浏览器进程失败：' + String((e && e.message) || e) };
  }
}

/* ============================================================
 * pid 账本（<profile>/tt-pids.json）
 * ============================================================ */

function pidFilePath(profileDir) {
  return path.join(String(profileDir || ''), PID_FILE_NAME);
}

/**
 * 读账本。坏文件/不存在都当空账本（**不抛**）。
 * @returns {{pids:number[], browser:string, exe:string, profile:string, updatedAt:number}}
 */
function readPidFile(profileDir) {
  const empty = { pids: [], browser: '', exe: '', profile: String(profileDir || ''), updatedAt: 0 };
  try {
    const raw = fs.readFileSync(pidFilePath(profileDir), 'utf8');
    const data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object') return empty;
    const pids = (Array.isArray(data.pids) ? data.pids : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
    return {
      pids: Array.from(new Set(pids)),
      browser: String(data.browser || ''),
      exe: String(data.exe || ''),
      profile: String(data.profile || profileDir || ''),
      updatedAt: Number(data.updatedAt) || 0
    };
  } catch (e) {
    return empty;
  }
}

/**
 * 写账本。默认**合并**已有 pid（启动后立即写的就是 proc.pid）；
 * `replace: true` 用给定列表整体替换（清理完 / 收尾后把死 pid 去掉）。
 *
 * @returns {{ok:boolean, data?:object, message?:string}}
 */
function writePidFile(profileDir, patch, options) {
  const o = options || {};
  const p = String(profileDir || '');
  if (!p) return { ok: false, message: 'profile 目录为空' };
  const prev = readPidFile(p);
  const given = ((patch && patch.pids) || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  const pids = o.replace ? Array.from(new Set(given)) : Array.from(new Set(prev.pids.concat(given)));
  const data = {
    writer: 'test-tool/sniffer',
    pids,
    browser: String((patch && patch.browser) || prev.browser || ''),
    exe: String((patch && patch.exe) || prev.exe || ''),
    profile: p,
    updatedAt: Date.now()
  };
  try {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(pidFilePath(p), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

function clearPidFile(profileDir) {
  try {
    fs.unlinkSync(pidFilePath(profileDir));
  } catch (e) {
    /* 本来就不存在 */
  }
}

/**
 * 找出「属于本次会话 profile」的浏览器进程。
 *
 * 判定条件（两条都要满足，缺一不可）：
 *   · 进程名是 msedge.exe / chrome.exe / chromium.exe（不认识的进程不碰）；
 *   · 命令行里同时有本次 profile 的绝对路径和 `sniff-profile` 标记。
 *
 * 来源有两路：账本里记的 pid（必须先按上面的条件验明正身）+ 现场扫到的
 * 「命令行明确写着我们 profile」的进程（兜住上一轮记账前就起来的子孙进程）。
 * 账本里记着、但命令行不匹配的 pid 记进 skipped，**绝不 kill**。
 *
 * @returns {{ok:boolean, ours:Array<{pid:number,name:string,cmd:string}>, skipped:Array<{pid:number,why:string}>, message?:string}}
 */
function collectOwnedPids(profileDir, options) {
  const dir = String(profileDir || '');
  /**
   * 没有 profile 目录时**一个都不认领**：
   * 这时 isOurProfileCommand 只能退回「含 sniff-profile 标记」，可能误伤别的会话，
   * 宁可什么都不做（上层会如实报「数据目录没准备好」）。
   */
  if (!dir) return { ok: false, ours: [], skipped: [], message: 'profile 目录为空，不认领任何进程' };
  const listed = listBrowserProcesses(options);
  const recorded = readPidFile(dir).pids;
  const byPid = new Map(listed.list.map((p) => [p.pid, p]));
  const ours = [];
  const skipped = [];

  for (const pid of recorded) {
    const p = byPid.get(pid);
    if (!p) {
      skipped.push({ pid, why: '进程已经不在了' });
      continue;
    }
    if (!isBrowserProcessName(p.name)) {
      skipped.push({ pid, why: '不是 msedge/chrome 进程（' + (p.name || '未知') + '）' });
      continue;
    }
    if (!isOurProfileCommand(p.cmd, dir)) {
      skipped.push({ pid, why: '命令行里没有本平台 profile，不认识的 pid 不碰' });
      continue;
    }
    ours.push(p);
  }

  for (const p of listed.list) {
    if (ours.some((x) => x.pid === p.pid)) continue;
    if (!isBrowserProcessName(p.name)) continue;
    if (!isOurProfileCommand(p.cmd, dir)) continue;
    ours.push(p);
  }

  return { ok: listed.ok, ours, skipped, message: listed.message };
}

/* ============================================================
 * 端口发现 / 启动参数
 * ============================================================ */

/** 端口能不能只绑 127.0.0.1 拿下来 */
function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        server.close();
      } catch (e) {
        /* ignore */
      }
      resolve(ok);
    };
    server.once('error', () => finish(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => finish(true));
  });
}

/**
 * 随机挑一个 10000-60000 的空闲端口（只绑 127.0.0.1 试）。
 * 保留给「不想让浏览器自己挑端口」的排查场景；正常启动用 port 0。
 * @param {() => number} [rand]
 * @param {number} [maxTries]
 * @returns {Promise<number>} 0 = 没挑到
 */
async function pickFreePort(rand, maxTries) {
  const random = typeof rand === 'function' ? rand : Math.random;
  const tries = Math.max(1, Number(maxTries) || 20);
  for (let i = 0; i < tries; i++) {
    const port = PORT_MIN + Math.floor(random() * (PORT_MAX - PORT_MIN + 1));
    if (!isPortInRange(port)) continue;
    if (await canBindPort(port)) return port;
  }
  return 0;
}

/**
 * 调试端口发现：**不猜端口**。
 *
 * 传 `--remote-debugging-port=0` 让浏览器自己挑，然后读它写在 profile 目录里的
 * `DevToolsActivePort`（第一行是端口，第二行是 ws 路径）。这是 Chrome/Edge 的
 * 官方约定，好处：
 *   · 不会「我们 bind 一个空闲端口 → 关掉 → 浏览器去 bind 时被别人抢走」；
 *   · 浏览器想用别的端口也照样能连上；
 *   · 拿不到文件本身就是**明确信号**（浏览器没起来 / 被转发给已有实例了）。
 */
function devToolsPortPath(profileDir) {
  return path.join(profileDir, 'DevToolsActivePort');
}

/** 启动前必须清掉上一轮留下的 DevToolsActivePort，否则会读到旧端口 */
function clearDevToolsPort(profileDir) {
  try {
    fs.unlinkSync(devToolsPortPath(profileDir));
  } catch (e) {
    /* 本来就不存在 */
  }
}

/** 读 DevToolsActivePort（没写/没写完都回 null） */
function readDevToolsPort(profileDir) {
  let text = '';
  try {
    text = fs.readFileSync(devToolsPortPath(profileDir), 'utf8');
  } catch (e) {
    return null;
  }
  if (!text) return null;
  const lines = String(text).trim().split(/\r?\n/);
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { port, wsPath: String(lines[1] || '') };
}

/**
 * 浏览器启动参数（**纯函数**，可单测）。
 *
 * 只加必要开关：
 *   --remote-debugging-port / -address  = 只在本机回环上开调试口
 *   --user-data-dir                     = 独立 profile，不碰用户自己的浏览器数据
 *   --no-first-run / --no-default-browser-check = 别弹「设为默认浏览器」
 * headless 只在自动化测试里打开（生产要走用户看得见的窗口）。
 */
function buildLaunchArgs(options) {
  const opt = options || {};
  const port = Number(opt.port);
  const args = [
    '--remote-debugging-port=' + (Number.isInteger(port) ? port : 0),
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + String(opt.userDataDir || ''),
    '--no-first-run',
    '--no-default-browser-check'
  ];
  if (opt.headless) {
    args.push('--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio');
  }
  args.push(String(opt.url || 'about:blank'));
  return args;
}

function emptyFacts() {
  return {
    found: 0,
    total: 0,
    visible: false,
    inIframe: false,
    reason: '',
    label: ''
  };
}

/** 把事实翻成一句人话（只描述事实，不判对错） */
function factsMessage(facts) {
  const f = facts || emptyFacts();
  if (f.invalid) return '定位值写错了：' + (f.error || '选择器解析失败');
  if (!f.found) return '没找到匹配的元素';
  if (f.reason === 'shadow-dom') return '匹配到 ' + f.found + ' 个，但它们在 shadow DOM 里，画不了框';
  if (f.reason === 'in-iframe') return '匹配到 ' + f.found + ' 个，但它们在 iframe 里，画不了框';
  if (!f.visible) return '匹配到 ' + f.found + ' 个，第一个当前不可见（已画红色虚线框）';
  return '已高亮' + (f.label ? '「' + f.label + '」' : '') + '（匹配 ' + f.found + ' 个）';
}

/**
 * 造一个浏览器会话。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（profile 落在 <dataDir>/sniff-profile）
 * @param {object} [options.env] 环境变量（默认 process.env）
 * @param {boolean} [options.headless] 无头模式（优先于 env.TT_SNIFF_HEADLESS=1）
 * @param {'auto'|'edge'|'chrome'} [options.browser] 初始浏览器选择（默认 auto）
 * @param {Function} [options.log] 日志回调（写 startup.log 用）
 * @param {Function} [options.spawn] 注入 spawn（测试用）
 * @param {Function} [options.spawnSync] 注入 spawnSync（测试/列进程用）
 * @param {string} [options.defaultProgId] 注入「系统默认浏览器 ProgId」（测试用）
 * @param {Function} [options.createCdpClient] 注入 CDP 工厂（测试用）
 * @returns {object} session
 */
function createSession(options) {
  const opt = options || {};
  const env = opt.env || process.env;
  const dataDir = String(opt.dataDir || '');
  const headless =
    opt.headless === undefined || opt.headless === null
      ? /^(1|true|yes|on)$/i.test(String(env.TT_SNIFF_HEADLESS || ''))
      : !!opt.headless;
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const fetchImpl = typeof opt.fetch === 'function' ? opt.fetch : (url, init) => fetch(url, init);
  const spawnImpl = typeof opt.spawn === 'function' ? opt.spawn : spawn;
  const spawnSyncImpl = typeof opt.spawnSync === 'function' ? opt.spawnSync : spawnSync;
  const cdpFactory = typeof opt.createCdpClient === 'function' ? opt.createCdpClient : createCdpClient;
  const readyTimeoutMs = Number(opt.readyTimeoutMs) || READY_TIMEOUT_MS;
  const pollIntervalMs = Number(opt.pollIntervalMs) || POLL_INTERVAL_MS;
  const powershellPath = opt.powershellPath;

  /** 解析/列进程时要透传的注入项（测试里能全换掉） */
  const procOptions = () => ({ spawnSync: spawnSyncImpl, powershellPath });
  const resolveOptions = () => ({ spawnSync: spawnSyncImpl, defaultProgId: opt.defaultProgId });

  /* ---------------- 运行期状态 ---------------- */
  /** 浏览器子进程（可能只是转发进程；null = 没起过或已收干净） */
  let proc = null;
  /**
   * 会话是否真的活着。
   *
   * **只由「CDP/调试端口能不能连上」决定**，不看 proc.exitCode：
   * Windows 上转发进程退了不代表浏览器退了（bug1 的根因）。
   */
  let alive = false;
  let cdp = null;
  /** 浏览器级通道（只用来发 Browser.close） */
  let browserCdp = null;
  let browserWsUrl = '';
  let debugPort = 0;
  let browserName = '';
  let browserPath = '';
  let browserVersion = '';
  /** 本会话浏览器的**主进程** pid（进程盘点的结果；0 = 还没盘点出来） */
  let rootPid = 0;
  let targetId = '';
  let scriptId = '';
  /** 页面里最后一次读到的事实 */
  let lastFacts = null;
  /** 当前会话的定位意图（浏览器关了也保留，界面还要显示） */
  const current = {
    url: '',
    name: '',
    mode: DEFAULT_MODE,
    selector: '',
    /** 用户选的浏览器（'auto' | 'edge' | 'chrome'），跨 stop/start 保留 */
    browserChoice: normalizeBrowserChoice(opt.browser)
  };
  /** 标签页里实际加载的地址（用来判断「url 不同才导航」） */
  let loadedUrl = '';
  /**
   * 拉起浏览器时**作为启动参数**交给它的地址（不是自己点出来的空白页）。
   *
   * 有这个值就说明「浏览器一打开就已经在目标页面上了」，start() 里就不用再
   * 用 CDP naviate 一次（少一次整页重载）；只需要等 readyState 到 complete。
   */
  let launchedUrl = '';

  function isRunning() {
    return alive;
  }

  function profilePath() {
    return dataDir ? path.join(dataDir, PROFILE_DIR_NAME) : '';
  }

  /** 统一返回形状（5 个通道全用它，前端只需要认一套） */
  function result(ok, message, over) {
    const facts = lastFacts || emptyFacts();
    return Object.assign(
      {
        ok: !!ok,
        running: isRunning(),
        browser: browserName,
        /** 用户选的浏览器（界面回显用）：'auto' | 'edge' | 'chrome' */
        browserChosen: current.browserChoice,
        url: current.url,
        name: current.name,
        mode: current.mode,
        selector: current.selector,
        found: facts.found,
        total: facts.total,
        visible: facts.visible,
        inIframe: facts.inIframe,
        reason: facts.reason,
        message: String(message === undefined || message === null ? '' : message)
      },
      over || {}
    );
  }

  function reject(message) {
    return result(false, message);
  }

  /* ---------------- 内部工具 ---------------- */

  function resetRuntime() {
    closeCdp();
    closeBrowserCdp();
    proc = null;
    alive = false;
    debugPort = 0;
    browserWsUrl = '';
    rootPid = 0;
    targetId = '';
    scriptId = '';
    lastFacts = null;
    loadedUrl = '';
    launchedUrl = '';
  }

  function closeCdp() {
    const client = cdp;
    cdp = null;
    if (client) {
      try {
        client.close();
      } catch (e) {
        /* 已经断了 */
      }
    }
  }

  function closeBrowserCdp() {
    const client = browserCdp;
    browserCdp = null;
    if (client) {
      try {
        client.close();
      } catch (e) {
        /* 已经断了 */
      }
    }
  }

  function baseUrl() {
    return 'http://127.0.0.1:' + debugPort;
  }

  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch (e) {
        /* ignore */
      }
    }, Math.max(200, Number(timeoutMs) || 1000));
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res || !res.ok) return { ok: false, message: 'HTTP ' + (res ? res.status : '无响应') };
      const data = await res.json();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function evaluate(expression, timeoutMs) {
    if (!cdp || cdp.closed) return { ok: false, message: '调试通道已断开', dead: true };
    let res;
    try {
      res = await cdp.send(
        'Runtime.evaluate',
        { expression: String(expression), returnByValue: true, awaitPromise: false },
        timeoutMs
      );
    } catch (e) {
      return {
        ok: false,
        message: String((e && e.message) || e),
        dead: isClosedError(e) || (e && e.code === 'CDP_CLOSED')
      };
    }
    if (res && res.exceptionDetails) {
      const detail = res.exceptionDetails;
      const desc = (detail.exception && detail.exception.description) || detail.text || '';
      return { ok: false, message: '页面里执行出错：' + desc, dead: false };
    }
    return { ok: true, value: res && res.result ? res.result.value : undefined };
  }

  /** 读一次页面里的事实（失败不抛，返回 dead 让上层判断） */
  async function readFacts() {
    if (!cdp || cdp.closed) return { ok: false, dead: true };
    const r = await evaluate('window.__ttSniff', 1500);
    if (!r.ok) return { ok: false, dead: r.dead === true };
    lastFacts = highlight.parseSniffState(r.value);
    return { ok: true, facts: lastFacts };
  }

  /** 连上「我们自己那个」页面 target 的 CDP 通道 */
  async function connect() {
    if (cdp && !cdp.closed) return { ok: true };
    if (!debugPort) return { ok: false, message: '浏览器还没启动' };
    const list = await fetchJson(baseUrl() + '/json/list', 3000);
    if (!list.ok) return { ok: false, message: '读不到调试目标列表：' + list.message };
    const pages = (Array.isArray(list.data) ? list.data : []).filter(
      (t) => t && t.type === 'page' && t.webSocketDebuggerUrl
    );
    if (!pages.length) return { ok: false, message: '浏览器里已经没有页面标签了' };
    let target = targetId ? pages.find((t) => String(t.id) === targetId) : null;
    if (!target) {
      target = pages.find((t) => current.url && String(t.url || '').indexOf(current.url) === 0) || pages[0];
    }
    if (!target) return { ok: false, message: '浏览器里已经没有页面标签了' };
    targetId = String(target.id || '');
    try {
      cdp = await cdpFactory(String(target.webSocketDebuggerUrl), {
        timeout: CDP_TIMEOUT_MS,
        onClose: () => {
          log('sniff cdp closed: ' + targetId);
        }
      });
    } catch (e) {
      cdp = null;
      return { ok: false, message: '连不上页面的调试通道：' + String((e && e.message) || e) };
    }
    return { ok: true };
  }

  /** 连浏览器级通道（/json/version 给的 ws，用来发 Browser.close） */
  async function connectBrowserLevel() {
    if (browserCdp && !browserCdp.closed) return { ok: true };
    let ws = browserWsUrl;
    if (!ws && debugPort) {
      const info = await fetchJson(baseUrl() + '/json/version', 2500);
      if (info.ok && info.data) {
        ws = String(info.data.webSocketDebuggerUrl || '');
        if (!ws) return { ok: false, message: '/json/version 里没有 webSocketDebuggerUrl' };
      } else {
        return { ok: false, message: '/json/version 读不到：' + info.message };
      }
    }
    if (!ws) return { ok: false, message: '还没有浏览器级调试地址' };
    try {
      browserCdp = await cdpFactory(ws, {
        timeout: CDP_TIMEOUT_MS,
        onClose: () => {
          log('sniff browser-level cdp closed');
        }
      });
      browserWsUrl = ws;
      return { ok: true };
    } catch (e) {
      browserCdp = null;
      return { ok: false, message: '连不上浏览器级调试通道：' + String((e && e.message) || e) };
    }
  }

  /**
   * 等浏览器就绪：**只认 DevToolsActivePort + /json/version**。
   *
   * 关键点（bug1）：这里没有 child 参数 —— 子进程退出/存活**不参与判断**。
   * Windows 上 Edge/Chrome 冷启动时 spawn 出来的常常只是转发进程，转完就退，
   * 真正的浏览器还在跑；以前用 exitCode 判「提前退出」就会误报
   * 「浏览器刚拉起来就退出了…」、状态却还是未启动。
   *
   * @returns {Promise<{ok:true, port:number, wsPath:string, browser:string, webSocketDebuggerUrl:string}
   *                  |{ok:false, reason:'dap-timeout'|'version-timeout', message:string}>}
   */
  async function waitForDevTools(profileDir, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let sawFile = false;
    let lastPort = 0;
    let lastError = '';
    while (Date.now() < deadline) {
      const dap = readDevToolsPort(profileDir);
      if (dap) {
        sawFile = true;
        lastPort = dap.port;
        const info = await fetchJson('http://127.0.0.1:' + dap.port + '/json/version', 2500);
        if (info.ok && info.data) {
          return {
            ok: true,
            port: dap.port,
            wsPath: dap.wsPath,
            browser: String(info.data.Browser || ''),
            webSocketDebuggerUrl: String(info.data.webSocketDebuggerUrl || '')
          };
        }
        lastError = info.message || lastError;
      }
      await sleep(pollIntervalMs);
    }
    const seconds = Math.round(timeoutMs / 1000);
    if (sawFile) {
      return {
        ok: false,
        reason: 'version-timeout',
        message:
          'DevToolsActivePort 写了端口 ' + lastPort + '，但等了 ' + seconds +
          ' 秒 /json/version 还没响应（' + (lastError || '无响应') + '）'
      };
    }
    return {
      ok: false,
      reason: 'dap-timeout',
      message:
        '等了 ' + seconds + ' 秒，浏览器一直没写出 DevToolsActivePort（调试端口没开）。' +
        '配置目录：' + profileDir
    };
  }

  /**
   * 等页面加载完（只在「浏览器启动时就已经打开目标页」这条路径上用）。
   *
   * 为什么不挂 Page.loadEventFired：启动参数打开的页面，导航在我们连上 CDP 之前
   * 就可能已经开始了，load 事件有机会错过。轮询 readyState 更保险。
   *
   * @returns {Promise<boolean>} 是否等到 complete（超时不算失败，只是早点高亮）
   */
  async function waitDocumentReady(timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || NAV_LOAD_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const state = await evaluate('document.readyState', 1200);
      if (state.ok && state.value === 'complete') return true;
      if (state.dead) return false;
      await sleep(120);
    }
    return false;
  }

  async function navigate(url) {
    const connected = await connect();
    if (!connected.ok) return { ok: false, message: connected.message };
    try {
      await cdp.send('Page.enable', {}, 5000);
    } catch (e) {
      log('Page.enable failed: ' + String((e && e.message) || e));
    }

    // 先挂上「load 事件」再导航：顺序反了会等不到
    const loadWait = cdp.waitFor('Page.loadEventFired', NAV_LOAD_TIMEOUT_MS).then(
      () => true,
      () => false
    );

    let res;
    try {
      res = await cdp.send('Page.navigate', { url }, 10000);
    } catch (e) {
      return { ok: false, message: '导航失败：' + String((e && e.message) || e) };
    }
    if (res && res.errorText) return { ok: false, message: '打开页面失败：' + res.errorText };

    const loaded = await loadWait;
    if (loaded) return { ok: true };

    // 没有 load 事件（同文档导航 / 页面自己接管）：退回轮询 readyState
    const deadline = Date.now() + NAV_LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await evaluate('document.readyState', 1200);
      if (state.ok && state.value === 'complete') return { ok: true };
      if (state.dead) return { ok: false, message: state.message };
      await sleep(120);
    }
    return { ok: true, message: '页面加载较慢，先按当前内容高亮' };
  }

  /** 把高亮脚本注入页面 + 注册成「新文档也注入」 */
  async function applyHighlight() {
    const connected = await connect();
    if (!connected.ok) return { ok: false, message: connected.message };

    let source;
    try {
      source = highlight.buildHighlightScript(current.mode, current.selector, { name: current.name });
    } catch (e) {
      return { ok: false, message: '生成高亮脚本失败：' + String((e && e.message) || e) };
    }

    try {
      await cdp.send('Page.enable', {}, 5000);
    } catch (e) {
      /* 有些 target 不需要 enable，失败不影响注入 */
    }

    // 刷新 / 新标签页之后仍然要能框住：注册成「每个新文档都注入」
    if (scriptId) {
      try {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }, 5000);
      } catch (e) {
        /* 旧 id 失效就算了 */
      }
      scriptId = '';
    }
    try {
      const reg = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, 5000);
      scriptId = reg && reg.identifier ? String(reg.identifier) : '';
    } catch (e) {
      scriptId = '';
      log('addScriptToEvaluateOnNewDocument failed: ' + String((e && e.message) || e));
    }

    // 包一层：保证拿回来的就是这个脚本最后写下的 window.__ttSniff
    const wrapped = '(function () { return (' + source + '); })()';
    const run = await evaluate(wrapped, 8000);
    if (!run.ok) return { ok: false, message: run.message };

    const facts = highlight.parseSniffState(run.value);
    lastFacts = facts;
    if (facts.invalid) return { ok: false, message: factsMessage(facts) };
    return { ok: true, message: factsMessage(facts) };
  }

  /* ---------------- 进程收尾 ---------------- */

  /** 杀掉一批 pid 的进程树（Windows 上 /T 连渲染/GPU 子进程一起收） */
  function killPidTrees(pids) {
    const list = Array.from(new Set((pids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)));
    const killed = [];
    const failed = [];
    for (const pid of list) {
      try {
        if (process.platform === 'win32') {
          const r = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          });
          if (r && r.status === 0) killed.push(pid);
          else failed.push(pid);
        } else {
          process.kill(pid, 'SIGKILL');
          killed.push(pid);
        }
      } catch (e) {
        failed.push(pid);
        log('taskkill pid ' + pid + ' 失败：' + String((e && e.message) || e));
      }
    }
    return { killed, failed };
  }

  /** 等「本会话的浏览器进程」全部消失 */
  async function waitOwnedGone(profileDir, timeoutMs) {
    const deadline = Date.now() + (Number(timeoutMs) || KILL_TIMEOUT_MS);
    let last = { ours: [] };
    while (Date.now() < deadline) {
      last = collectOwnedPids(profileDir, procOptions());
      if (!last.ours.length) return { ok: true, remaining: [] };
      await sleep(400);
    }
    return { ok: !last.ours.length, remaining: last.ours };
  }

  /** 按「命令行验明正身」的结果杀掉本会话的浏览器，并等它真的消失 */
  async function killOwnedAndWait(profileDir, timeoutMs) {
    closeCdp();
    closeBrowserCdp();
    if (!profileDir) return { killed: 0, remaining: [], scanned: { ok: false, ours: [] } };
    const scanned = collectOwnedPids(profileDir, procOptions());
    const pids = scanned.ours.map((p) => p.pid);
    if (!scanned.ok) log('sniff: 列进程失败（' + (scanned.message || '未知原因') + '），不敢乱杀 pid');
    if (pids.length) {
      const r = killPidTrees(pids);
      log('sniff: taskkill 进程树 ' + r.killed.length + '/' + pids.length + ' 个' + (r.failed.length ? '（失败 ' + r.failed.join(',') + '）' : ''));
    }
    const gone = await waitOwnedGone(profileDir, timeoutMs);
    writePidFile(profileDir, { pids: gone.remaining.map((p) => p.pid) }, { replace: true });
    return { killed: pids.length, remaining: gone.remaining.map((p) => p.pid), scanned };
  }

  /**
   * 启动前的残留清理（bug2 ①）。
   *
   * 只动「账本里的 pid 且命令行验明是本平台 profile 的浏览器进程」，
   * 外加现场扫到的「命令行明确写着本 profile」的浏览器进程；
   * 其它 pid 一律不碰（认识的留下证，不认识的绝不猜）。
   */
  async function cleanupResidual(profileDir) {
    const recorded = readPidFile(profileDir);
    const scanned = collectOwnedPids(profileDir, procOptions());
    if (!scanned.ok) {
      log('sniff: 列进程失败（' + (scanned.message || '未知原因') + '），这轮不做残留清理');
      return { killed: 0, remaining: [], skipped: [], listFailed: true };
    }
    for (const s of scanned.skipped) log('sniff: 跳过 pid ' + s.pid + '（' + s.why + '）');
    const pids = scanned.ours.map((p) => p.pid);
    if (!pids.length) {
      writePidFile(profileDir, { pids: [], browser: recorded.browser, exe: recorded.exe }, { replace: true });
      return { killed: 0, remaining: [], skipped: scanned.skipped };
    }
    log('sniff: 启动前清残留，' + pids.length + ' 个属于本平台的浏览器进程：' + pids.join(', '));
    const r = killPidTrees(pids);
    const gone = await waitOwnedGone(profileDir, KILL_TIMEOUT_MS);
    const remaining = gone.remaining.map((p) => p.pid);
    writePidFile(profileDir, { pids: remaining, browser: recorded.browser, exe: recorded.exe }, { replace: true });
    log('sniff: 清残留结果：杀掉 ' + r.killed.length + ' 个，仍存活 ' + remaining.length + ' 个');
    return { killed: r.killed.length, remaining, skipped: scanned.skipped };
  }

  /** 记账：把现场扫到的本会话进程写进 <profile>/tt-pids.json，并记下主进程 pid */
  function recordOwnedPids(profileDir, resolved) {
    const scanned = collectOwnedPids(profileDir, procOptions());
    const pids = scanned.ours.map((p) => p.pid);
    const main = scanned.ours.find((p) => isMainBrowserProcess(p.cmd));
    if (main) rootPid = main.pid;
    else if (!rootPid && proc && proc.pid) rootPid = proc.pid;
    if (!scanned.ok) log('sniff: 列进程失败（' + (scanned.message || '未知原因') + '），账本先只记 spawn 出来的 pid');
    writePidFile(
      profileDir,
      { pids: pids.length ? pids : proc && proc.pid ? [proc.pid] : [], browser: (resolved && resolved.name) || browserName, exe: (resolved && resolved.path) || browserPath },
      { replace: true }
    );
    if (pids.length) log('sniff: 记账 ' + pids.length + ' 个进程，主进程 pid=' + (rootPid || 0));
    return { pids, mainPid: rootPid };
  }

  /* ---------------- 启动 ---------------- */

  /**
   * 用指定 profile 拉起一次浏览器并等到 CDP 可用。
   *
   * @returns {Promise<{ok:boolean, reason?:string, retried?:boolean, message?:string}>}
   */
  async function launchOnce(profileDir, resolved, targetUrl, isRetry) {
    const args = buildLaunchArgs({ port: 0, userDataDir: profileDir, headless, url: targetUrl });
    let child;
    try {
      child = spawnImpl(resolved.path, args, { stdio: 'ignore', windowsHide: headless, detached: false });
    } catch (e) {
      return { ok: false, reason: 'spawn-failed', retried: isRetry, message: '启动浏览器失败：' + String((e && e.message) || e) };
    }
    if (!child || !child.pid) return { ok: false, reason: 'spawn-failed', retried: isRetry, message: '启动浏览器失败：拿不到进程号' };

    proc = child;
    alive = false;
    debugPort = 0;
    browserWsUrl = '';
    rootPid = child.pid;
    browserName = resolved.name;
    browserPath = resolved.path;
    browserVersion = '';
    targetId = '';
    scriptId = '';
    lastFacts = null;
    loadedUrl = '';
    launchedUrl = targetUrl === 'about:blank' ? '' : targetUrl;

    // 启动后**立即**记账：哪怕这个 pid 只是转发进程，它也是「我们拉起的」
    const rec = writePidFile(profileDir, { pids: [child.pid], browser: resolved.name, exe: resolved.path });
    if (!rec.ok) log('sniff: pid 账本写不进去（' + rec.message + '），残留清理只能靠命令行匹配');

    /**
     * 子进程退出/出错**只记日志**（bug1）：
     * 转发进程转完就退是常态，真正的浏览器进程还活着，绝不能据此判「浏览器没起来」。
     */
    child.on('exit', (code, signal) => {
      log('sniff browser child exited: pid=' + child.pid + ' code=' + code + ' signal=' + signal + '（只记日志，不代表浏览器已退出）');
    });
    child.on('error', (e) => {
      log('sniff browser child error: ' + String((e && e.message) || e) + '（只记日志）');
    });

    log(
      'sniff browser launched: ' + resolved.name + ' pid=' + child.pid + ' profile=' + profileDir +
        (headless ? ' (headless)' : '') + (isRetry ? ' (retry)' : '')
    );

    const wait = await waitForDevTools(profileDir, readyTimeoutMs);
    if (!wait.ok) {
      /**
       * 这里**只回报失败，不自己收进程**：
       * 万一浏览器只是慢了一步（刚好在超时之后才写好 DevToolsActivePort），
       * 上层还能用 findUsableInstance() 认领它，而不是先杀再拉一个新的。
       * 收尾由 launchFresh() 按「有没有可用实例 / 要不要重试」决定。
       */
      return { ok: false, reason: wait.reason, retried: isRetry, message: wait.message };
    }
    debugPort = wait.port;
    browserVersion = wait.browser;
    browserWsUrl = wait.webSocketDebuggerUrl;
    if (/edg\//i.test(browserVersion)) browserName = 'edge';
    else if (/chrome\//i.test(browserVersion)) browserName = 'chrome';
    alive = true;
    log('sniff devtools ready: port=' + debugPort + ' version=' + browserVersion);

    recordOwnedPids(profileDir, resolved);

    const connected = await connect();
    if (!connected.ok) {
      await killOwnedAndWait(profileDir, KILL_TIMEOUT_MS);
      resetRuntime();
      return { ok: false, reason: 'connect-failed', retried: isRetry, message: connected.message };
    }
    return { ok: true, retried: isRetry };
  }

  /** 手上这个会话还活着时，用 /json/version 复核一次（不看子进程） */
  async function probeCurrent() {
    if (!debugPort) return { ok: false, message: '还没有调试端口' };
    const info = await fetchJson(baseUrl() + '/json/version', 1500);
    if (!info.ok || !info.data) return { ok: false, message: info.message || '调试端口无响应' };
    return { ok: true, data: info.data };
  }

  /**
   * 有没有「已经在跑、还能连上」的实例可以直接用（只读 DevToolsActivePort）。
   * 重试判断就用它：**确实拿不到任何可用实例**才值得再拉一次。
   */
  async function findUsableInstance(profileDir) {
    const dap = readDevToolsPort(profileDir);
    if (!dap) return { ok: false };
    const info = await fetchJson('http://127.0.0.1:' + dap.port + '/json/version', 2500);
    if (!info.ok || !info.data) return { ok: false };
    return {
      ok: true,
      port: dap.port,
      browser: String(info.data.Browser || ''),
      webSocketDebuggerUrl: String(info.data.webSocketDebuggerUrl || '')
    };
  }

  /** 认下一个已经在跑的实例（不再 spawn，直接复用） */
  async function adoptInstance(found, resolved) {
    debugPort = found.port;
    browserVersion = found.browser;
    browserWsUrl = found.webSocketDebuggerUrl;
    if (/edg\//i.test(browserVersion)) browserName = 'edge';
    else if (/chrome\//i.test(browserVersion)) browserName = 'chrome';
    else if (resolved && resolved.name) browserName = resolved.name;
    alive = true;
    targetId = '';
    scriptId = '';
    lastFacts = null;
    loadedUrl = '';
    log('sniff: 复用已经在跑的实例，端口 ' + debugPort);
    recordOwnedPids(profilePath(), resolved);
    const connected = await connect();
    if (!connected.ok) breakAdoption(connected.message);
    return { ok: connected.ok, message: connected.message };
  }

  /** 认领失败就回到「没有会话」的状态（不动进程，收尾交给上层/stop） */
  function breakAdoption(message) {
    alive = false;
    debugPort = 0;
    browserWsUrl = '';
    closeCdp();
    closeBrowserCdp();
    log('sniff: 认领实例失败：' + (message || '未知原因'));
  }

  /**
   * 起一套全新的浏览器会话（先清残留 → 拉起 → 等 DAP → 连 CDP）。
   * 重试只有一条路：DAP 超时 + 没有可用实例 → 先杀再试一次（绝不换 profile）。
   */
  async function launchFresh(resolved, openUrl) {
    const profileDir = profilePath();
    if (!profileDir) return { ok: false, message: '数据目录没准备好，浏览器配置存不下来' };
    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch (e) {
      return { ok: false, message: '建浏览器配置目录失败：' + String((e && e.message) || e) };
    }

    const cleaned = await cleanupResidual(profileDir);
    if (cleaned.remaining.length) {
      log('sniff: 警告：清残留后仍有 ' + cleaned.remaining.length + ' 个进程活着（' + cleaned.remaining.join(',') + '），继续尝试启动');
    }
    // 上一轮残留的端口文件必须清掉，否则会连到一个早就没了的端口
    clearDevToolsPort(profileDir);

    /**
     * 启动时直接把目标地址交给浏览器（而不是 about:blank 再导航）：
     *   1. 用户看到的就是目标页面，不会先闪一下空白页；
     *   2. 万一 CDP 连不上，页面也已经打开了，至少不是「一片白」；
     *   3. 地址非法（不是 http/https）时退回 about:blank，不把脏值交给命令行。
     */
    const targetUrl = isHttpUrl(openUrl) ? String(openUrl) : 'about:blank';

    const first = await launchOnce(profileDir, resolved, targetUrl, false);
    if (first.ok) return { ok: true, message: '' };
    if (first.reason !== 'dap-timeout') {
      // 不是 DAP 超时（端口开了但 /json/version 不响应 / 连不上页面）：收干净再如实报错
      await killOwnedAndWait(profileDir, KILL_TIMEOUT_MS);
      resetRuntime();
      return { ok: false, message: first.message };
    }

    // 只在这一种情况下重试：DAP 超时，而且确实拿不到任何可用实例
    const usable = await findUsableInstance(profileDir);
    if (usable.ok) {
      const adopted = await adoptInstance(usable, resolved);
      if (adopted.ok) return { ok: true, message: '连上了已经在跑的浏览器实例（复用，没有另开窗口）' };
    }

    log('sniff: ' + first.message + '；先杀掉残留再重试一次（不换 profile，不开第二个窗口）');
    await killOwnedAndWait(profileDir, KILL_TIMEOUT_MS);
    clearDevToolsPort(profileDir);
    const second = await launchOnce(profileDir, resolved, targetUrl, true);
    if (second.ok) return { ok: true, message: '' };
    // 重试也失败：把半死的浏览器收干净，不留在桌面上
    await killOwnedAndWait(profileDir, KILL_TIMEOUT_MS);
    resetRuntime();
    return { ok: false, message: second.message + '（已先清理残留再重试一次）' };
  }

  /**
   * 保证有一台「符合 browser 选择」的浏览器可用。
   *
   * 已有会话且**实际浏览器没变** → 复用（不重开窗口，bug2 的核心之一）；
   * 变了 → 先停旧的再起新的（bug3）。
   */
  async function ensureBrowser(openUrl) {
    if (!dataDir) return { ok: false, message: '数据目录没准备好，浏览器配置存不下来' };
    const resolved = resolveBrowser(current.browserChoice, env, resolveOptions());
    if (!resolved.ok) {
      log('sniff: 选浏览器失败：' + resolved.message);
      return { ok: false, message: resolved.message };
    }
    log(
      'sniff: 选用浏览器 ' + resolved.name + '（' + describeBrowserSource(resolved) + '）：' + resolved.path
    );

    if (alive) {
      const probe = await probeCurrent();
      if (probe.ok) {
        if (browserName && resolved.name !== browserName) {
          log('sniff: 浏览器从 ' + browserName + ' 换成 ' + resolved.name + '，先关旧会话再起新的');
          const stopped = await stopInternal();
          if (!stopped.ok) return { ok: false, message: '切换浏览器时旧会话没关掉：' + stopped.message };
        } else {
          if (!cdp || cdp.closed) {
            const reconnected = await connect();
            if (!reconnected.ok) return { ok: true, message: reconnected.message };
          }
          return { ok: true, message: '' };
        }
      } else {
        // 会话已经不在（用户关了窗口 / 端口断了）：不能假装还在跑，先清残留
        log('sniff: 上次的浏览器已经不在了（' + (probe.message || '调试端口无响应') + '），先清残留再重起');
        await killOwnedAndWait(profilePath(), KILL_TIMEOUT_MS);
        resetRuntime();
      }
    }
    return launchFresh(resolved, openUrl);
  }

  /* ---------------- 关闭（三级） ---------------- */

  /** 第一级：CDP Browser.close */
  async function closeViaBrowserCdp() {
    const conn = await connectBrowserLevel();
    if (!conn.ok) return { ok: false, message: conn.message };
    const client = browserCdp;
    try {
      await client.send('Browser.close', {}, 3000);
      log('sniff: 已发 CDP Browser.close');
      return { ok: true, message: 'Browser.close 已下发' };
    } catch (e) {
      /**
       * 浏览器关自己时经常不回包、直接把 ws 断掉 —— 这不算失败，
       * 后面用「进程是否真的没了」来验证，验证不过才降级 taskkill。
       */
      const msg = String((e && e.message) || e);
      log('sniff: Browser.close 没拿到回包（' + msg + '），按「可能已关闭」处理，稍后按进程验证');
      return { ok: true, message: msg, maybe: true };
    }
  }

  /**
   * 关掉当前会话（三级）。
   *
   *   1. CDP Browser.close（我们已经有浏览器级 ws，最干净）；
   *   2. 不行就 taskkill 命令行验明过的已知 pid 树；
   *   3. 再不行就如实报错（ok:false），绝不假装关掉了。
   *
   * @returns {Promise<{ok:boolean, level:string, message:string}>}
   */
  async function stopInternal() {
    const profileDir = profilePath();
    const known = profileDir ? collectOwnedPids(profileDir, procOptions()) : { ours: [] };
    const recorded = profileDir ? readPidFile(profileDir).pids : [];
    if (!alive && !known.ours.length && !recorded.length && !proc) {
      if (profileDir) clearPidFile(profileDir);
      resetRuntime();
      return { ok: true, level: 'none', message: '本来就没在运行' };
    }

    // ---- 1) Browser.close ----
    let closed = { ok: false, message: '没有可用的浏览器级通道' };
    if (alive || debugPort) closed = await closeViaBrowserCdp();
    if (closed.ok) {
      const gone = await waitOwnedGone(profileDir, KILL_TIMEOUT_MS);
      if (gone.ok) {
        clearPidFile(profileDir);
        resetRuntime();
        return { ok: true, level: 'browser-close', message: '浏览器已关闭' };
      }
      log('sniff: Browser.close 之后还有 ' + gone.remaining.length + ' 个进程，降级 taskkill');
    } else {
      log('sniff: Browser.close 走不通（' + closed.message + '），降级 taskkill');
    }

    // ---- 2) taskkill 已知 pid 树 ----
    // 没有 profile 目录时没法按命令行认领，只能退回「杀自己 spawn 出来的那个 pid」
    const killed = profileDir
      ? await killOwnedAndWait(profileDir, KILL_TIMEOUT_MS)
      : { killed: proc && proc.pid ? killPidTrees([proc.pid]).killed.length : 0, remaining: [] };
    if (!killed.remaining.length) {
      clearPidFile(profileDir);
      resetRuntime();
      const msg = killed.killed
        ? '浏览器已关闭（Browser.close 没生效，已用 taskkill 收掉进程树）'
        : '浏览器已关闭（进程自己已经退出，只剩记录）';
      return { ok: true, level: 'taskkill', message: msg };
    }

    // ---- 3) 关不掉：如实报错 ----
    const pidsText = killed.remaining.slice(0, 6).join(', ');
    return {
      ok: false,
      level: 'failed',
      message:
        '浏览器没能关掉：还有 ' + killed.remaining.length + ' 个进程在跑（pid ' + pidsText + '）。' +
        '可以到任务管理器里结束这些进程'
    };
  }

  /* ---------------- 对外 API ---------------- */

  /**
   * 当前状态（界面轮询用）。
   *
   * ok 只表示「这次查询本身成功了」，浏览器在不在看 running ——
   * 这样前台轮询不会因为「用户把浏览器关了」而弹错误提示。
   */
  async function status() {
    if (!alive && !proc) return result(true, '没有在运行的浏览器');
    if (!alive) {
      resetRuntime();
      return result(true, '浏览器已经关闭');
    }
    const probe = await probeCurrent();
    if (!probe.ok) {
      await killOwnedAndWait(profilePath(), KILL_TIMEOUT_MS);
      resetRuntime();
      return result(true, '调试端口已断开，浏览器已经关闭');
    }
    if (!cdp || cdp.closed) {
      const reconnected = await connect();
      if (!reconnected.ok) return result(true, '页面标签已经关掉了，可以点「重新打开」');
    } else {
      const read = await readFacts();
      if (read.dead) {
        const reconnected = await connect();
        if (!reconnected.ok) return result(true, '页面标签已经关掉了，可以点「重新打开」');
      }
    }
    return result(true, factsMessage(lastFacts));
  }

  /**
   * 启动（或复用）会话并高亮。
   * 已有会话时：url 一样就不重新导航（保留用户滚动位置），url 不同才导航。
   */
  async function start(input) {
    const payload = input || {};
    const urlRaw = String(payload.url === undefined || payload.url === null ? '' : payload.url).trim();
    if (!isHttpUrl(urlRaw)) return reject('只支持 http/https 链接（http:// 或 https:// 开头）');

    if (payload.browser !== undefined) {
      const parsed = parseBrowserChoice(payload.browser);
      if (!parsed.ok) return reject(parsed.message);
      current.browserChoice = parsed.choice;
    }

    current.url = urlRaw;
    if (payload.name !== undefined) current.name = String(payload.name === null ? '' : payload.name);
    if (payload.mode !== undefined) current.mode = highlight.normalizeMode(payload.mode);
    if (payload.selector !== undefined) {
      current.selector = String(payload.selector === null ? '' : payload.selector);
    }
    if (!current.selector) return reject('定位值不能为空');

    const ensured = await ensureBrowser(current.url);
    if (!ensured.ok) return reject(ensured.message);
    if (ensured.message) log('sniff: ' + ensured.message);

    if (loadedUrl !== current.url) {
      if (launchedUrl && launchedUrl === current.url) {
        /**
         * 浏览器启动时就已经把目标页面打开了：不再整页重载，只等加载完。
         * 但要**核对一下真的在那个页面上**——首次启动时浏览器可能先落在
         * 新标签页上（我们连的就是那个空标签），那就得补一次导航。
         */
        await waitDocumentReady(NAV_LOAD_TIMEOUT_MS);
        const href = await evaluate('location.href', 2000);
        const same = href.ok && samePage(String(href.value || ''), current.url);
        if (!same) {
          const nav = await navigate(current.url);
          if (!nav.ok) return result(false, nav.message);
        }
        loadedUrl = current.url;
      } else {
        const nav = await navigate(current.url);
        if (!nav.ok) return result(false, nav.message);
        loadedUrl = current.url;
      }
    }
    const applied = await applyHighlight();
    return result(applied.ok, applied.message);
  }

  /** 用户要求换浏览器时：先判一下「现在跑的这台」是不是就不对了 */
  async function browserNeedsSwitch() {
    const resolved = resolveBrowser(current.browserChoice, env, resolveOptions());
    if (!resolved.ok) return true; // 让调用方走 start()，由它把明确的错误文案带回去
    return !!browserName && resolved.name !== browserName;
  }

  /** 三个入口共用：把入参里的 browser 收进会话状态（写错了就回明确错误） */
  function applyBrowserInput(payload) {
    if (!payload || payload.browser === undefined) return { ok: true, changed: false };
    const parsed = parseBrowserChoice(payload.browser);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const changed = parsed.choice !== current.browserChoice;
    current.browserChoice = parsed.choice;
    return { ok: true, changed };
  }

  /**
   * 只重新框（换定位方式/定位值时用）。
   *
   * 不导航 —— 但**会话被用户关掉之后要能自己恢复**：
   * 界面上的「重新高亮」按钮不要求先点「启动」，所以这里复用 start()
   * （它会重新拉起浏览器并按记住的 url 导航一次），语义仍然是「按当前元素重新框」。
   */
  async function highlightOnly(input) {
    const payload = input || {};
    const choice = applyBrowserInput(payload);
    if (!choice.ok) return reject(choice.message);
    if (payload.name !== undefined) current.name = String(payload.name === null ? '' : payload.name);
    if (payload.mode !== undefined) current.mode = highlight.normalizeMode(payload.mode);
    if (payload.selector !== undefined) {
      current.selector = String(payload.selector === null ? '' : payload.selector);
    }
    if (!current.selector) return reject('定位值不能为空');

    if (isRunning() && choice.changed && (await browserNeedsSwitch())) {
      if (!current.url) return reject('没有记住的页面地址，先点「启动」');
      const restarted = await start({
        url: current.url,
        name: current.name,
        mode: current.mode,
        selector: current.selector,
        browser: current.browserChoice
      });
      return Object.assign({}, restarted, { browserChosen: current.browserChoice });
    }
    if (!isRunning()) {
      if (!current.url) return reject('没有在运行的浏览器，先点「启动」');
      const restarted = await start({
        url: current.url,
        name: current.name,
        mode: current.mode,
        selector: current.selector,
        browser: current.browserChoice
      });
      return Object.assign({}, restarted, { browserChosen: current.browserChoice });
    }

    const applied = await applyHighlight();
    return result(applied.ok, applied.message);
  }

  /** 重新导航并框住当前元素（浏览器被关掉了就重新拉起） */
  async function reopen(input) {
    const payload = input || {};
    const choice = applyBrowserInput(payload);
    if (!choice.ok) return reject(choice.message);
    const nextUrl = String(payload.url === undefined || payload.url === null ? '' : payload.url).trim();
    if (nextUrl) {
      if (!isHttpUrl(nextUrl)) return reject('只支持 http/https 链接（http:// 或 https:// 开头）');
      current.url = nextUrl;
    }
    if (!current.url) return reject('还没有要打开的地址');
    if (!current.selector) return reject('定位值不能为空');

    if (!isRunning() || (choice.changed && (await browserNeedsSwitch()))) {
      const restarted = await start({
        url: current.url,
        name: current.name,
        mode: current.mode,
        selector: current.selector,
        browser: current.browserChoice
      });
      return Object.assign({}, restarted, { browserChosen: current.browserChoice });
    }

    const nav = await navigate(current.url);
    if (!nav.ok) return result(false, nav.message);
    loadedUrl = current.url;
    const applied = await applyHighlight();
    return result(applied.ok, applied.message);
  }

  /** 关掉浏览器（幂等；三级关闭，关不掉就如实报 ok:false） */
  async function stop() {
    const stopped = await stopInternal();
    return result(stopped.ok, stopped.message);
  }

  /**
   * 同步收尾：before-quit / process exit 里用（异步等不了）。
   *
   * 退出路径上**不做进程盘点**（PowerShell 起一次要 1 秒以上，会把退出拖住），
   * 只按账本 + spawn 的 pid 打 taskkill；账本是我们在启动成功后立即写的，
   * 里面的 pid 都是本平台拉起的进程。
   */
  function stopSync() {
    closeCdp();
    closeBrowserCdp();
    const profileDir = profilePath();
    let pids = profileDir ? readPidFile(profileDir).pids.slice() : [];
    if (rootPid) pids.push(rootPid);
    if (proc && proc.pid) pids.push(proc.pid);
    pids = Array.from(new Set(pids));
    if (pids.length) {
      const r = killPidTrees(pids);
      log('sniff: 退出时 taskkill ' + r.killed.length + '/' + pids.length + ' 个 pid');
    }
    if (profileDir) clearPidFile(profileDir);
    resetRuntime();
  }

  return {
    status,
    start,
    highlight: highlightOnly,
    reopen,
    stop,
    reject,
    stopSync,
    isRunning,
    isHttpUrl,
    /** 测试/排查用：本会话浏览器主进程 pid（0 = 没有） */
    pid: () => (rootPid || (proc && proc.pid ? proc.pid : 0)),
    debugPort: () => debugPort,
    browserPath: () => browserPath,
    browserVersion: () => browserVersion,
    browserChosen: () => current.browserChoice,
    /** 测试/排查用：当前 profile 目录 */
    profileDir: () => profilePath(),
    log
  };
}

module.exports = {
  PORT_MIN,
  PORT_MAX,
  READY_TIMEOUT_MS,
  DEFAULT_MODE,
  BROWSER_CHOICES,
  DEFAULT_BROWSER_CHOICE,
  PROFILE_DIR_NAME,
  PROFILE_MARKER,
  PID_FILE_NAME,
  isHttpUrl,
  isPortInRange,
  browserNameOf,
  browserCandidates,
  findBrowser,
  normalizeBrowserChoice,
  parseBrowserChoice,
  progIdToBrowser,
  readDefaultBrowserProgId,
  resolveBrowser,
  describeBrowserSource,
  isOurProfileCommand,
  isMainBrowserProcess,
  isBrowserProcessName,
  parseProcessList,
  parsePsOutput,
  listBrowserProcesses,
  collectOwnedPids,
  pidFilePath,
  readPidFile,
  writePidFile,
  clearPidFile,
  devToolsPortPath,
  readDevToolsPort,
  pickFreePort,
  canBindPort,
  buildLaunchArgs,
  factsMessage,
  emptyFacts,
  createSession
};
