'use strict';
/**
 * browser-session.js —— 「用系统浏览器实时高亮定位器」的会话管理（主进程侧）。
 *
 * ============================================================
 * 它负责什么
 * ============================================================
 *   1. 找浏览器：Edge → Chrome（本机 Edge 在 Program Files (x86)，Chrome 在
 *      %LOCALAPPDATA%，两种安装位置都要认；路径不写死，全部由环境变量拼）；
 *   2. 拉起：随机空闲端口（10000-60000）+ 只绑 127.0.0.1 + 独立 profile
 *      （`<dataDir>/sniff-profile`），不带 first-run 弹窗；
 *   3. 等就绪：轮询 /json/version（≤15 秒），失败就把进程收掉，不留残尸；
 *   4. 单会话：已有会话就复用，url 不同才导航；用户自己关窗口/进程退出时
 *      status 必须立刻如实返回 running:false（不能还在界面上显示「正在高亮」）；
 *   5. 只在自己的 target 上操作：连的是我们拉起的那个 page target，
 *      只发 Page/Runtime 的几个命令，不读 cookie/storage/页面内容。
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

/** 调试端口范围（需求指定：10000-60000 的随机空闲端口） */
const PORT_MIN = 10000;
const PORT_MAX = 60000;
/** 拉起浏览器后等调试端口就绪的上限
 *
 * 为什么从 15 秒提到 45 秒（v0.54.1 真机 bug）：
 *   冷启动 + 首次建 profile 的机器上实测要 10 秒以上，15 秒的余量太薄，
 *   一旦超时就会「浏览器刚拉起来就退出了」，用户看到的是一脸疑惑 + 空白页。
 *   宁可多等一会儿，也不要误杀一个正在起来的浏览器。
 */
const READY_TIMEOUT_MS = 45000;
/** 轮询间隔 */
const POLL_INTERVAL_MS = 150;
/** 单条 CDP 命令默认超时 */
const CDP_TIMEOUT_MS = 15000;
/** 导航后等 load 事件的上限 */
const NAV_LOAD_TIMEOUT_MS = 8000;

const DEFAULT_MODE = 'css';

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

/**
 * 候选浏览器路径（**纯函数**，只拼路径不碰磁盘，方便单测）。
 *
 * 顺序就是需求定的：先 Edge 再 Chrome；每种都覆盖
 *   Program Files / Program Files (x86) / %LOCALAPPDATA%
 * 三种安装位置（本机 Edge 实测装在 x86，Chrome 在 LOCALAPPDATA）。
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
 * 找一台能用的浏览器。
 * @param {object} [env]
 * @returns {{ok: true, name: 'edge'|'chrome', path: string, tried: string[]}
 *          |{ok: false, tried: string[], message: string}}
 */
function findBrowser(env) {
  const candidates = browserCandidates(env);
  const tried = [];
  for (const item of candidates) {
    tried.push(item.path);
    try {
      if (fs.existsSync(item.path) && fs.statSync(item.path).isFile()) {
        return { ok: true, name: item.name, path: item.path, tried };
      }
    } catch (e) {
      /* 权限不够就当没有 */
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
 * 调试端口发现：**不再自己猜端口**。
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

/** 等 DevToolsActivePort 写出来（同时在等的时候盯着进程有没有提前退出） */
async function waitDevToolsPort(profileDir, child, timeoutMs) {
  const file = devToolsPortPath(profileDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      // 进程提前退出：典型是「同一 profile 已有实例在跑，命令被转发过去，自己退了」
      return {
        ok: false,
        handoff: true,
        message: '浏览器刚拉起来就退出了（通常是因为上次的浏览器进程还占着配置目录）'
      };
    }
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      text = '';
    }
    if (text) {
      const lines = text.trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0) return { ok: true, port, wsPath: String(lines[1] || '') };
      // 文件已出现但还没写完：下一轮再读
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    handoff: false,
    message: '等了 ' + Math.round(timeoutMs / 1000) + ' 秒，浏览器调试端口还没准备好'
  };
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
 * @param {Function} [options.log] 日志回调（写 startup.log 用）
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

  /* ---------------- 运行期状态 ---------------- */
  /** 浏览器子进程（null = 没起过或已收干净） */
  let proc = null;
  let exited = false;
  let cdp = null;
  let debugPort = 0;
  let browserName = '';
  let browserPath = '';
  let browserVersion = '';
  let targetId = '';
  let scriptId = '';
  /** 页面里最后一次读到的事实 */
  let lastFacts = null;
  /** 当前会话的定位意图（浏览器关了也保留，界面还要显示） */
  const current = { url: '', name: '', mode: DEFAULT_MODE, selector: '' };
  /** 标签页里实际加载的地址（用来判断「url 不同才导航」） */
  let loadedUrl = '';
  /**
   * 拉起浏览器时**作为启动参数**交给它的地址（不是自己点出来的空白页）。
   *
   * 有这个值就说明「浏览器一打开就已经在目标页面上了」，start() 里就不用再
   * 用 CDP naviate 一次（少一次整页重载）；只需要等 readyState 到 complete。
   */
  let launchedUrl = '';
  /** 本次会话要额外告诉用户的一句话（比如「换用干净配置，需要重新登录」） */
  let notice = '';

  function isRunning() {
    return !!proc && !exited && proc.exitCode === null;
  }

  /** 统一返回形状（5 个通道全用它，前端只需要认一套） */
  function result(ok, message, over) {
    const facts = lastFacts || emptyFacts();
    /**
     * notice 是「这次会话的额外说明」（比如换用干净 profile，需要重新登录）。
     * 必须拼进 message 一起回给界面——只写进日志等于没告诉用户。
     */
    const base = String(message === undefined || message === null ? '' : message);
    const text = notice ? (base ? base + '（' + notice + '）' : notice) : base;
    return Object.assign(
      {
        ok: !!ok,
        running: isRunning(),
        browser: browserName,
        url: current.url,
        name: current.name,
        mode: current.mode,
        selector: current.selector,
        found: facts.found,
        total: facts.total,
        visible: facts.visible,
        inIframe: facts.inIframe,
        reason: facts.reason,
        message: text
      },
      over || {}
    );
  }

  function reject(message) {
    return result(false, message);
  }

  /* ---------------- 内部工具 ---------------- */

  function resetRuntime() {
    proc = null;
    exited = false;
    debugPort = 0;
    targetId = '';
    scriptId = '';
    lastFacts = null;
    loadedUrl = '';
    launchedUrl = '';
    notice = '';
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

  async function waitForReady(port) {
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      if (exited || (proc && proc.exitCode !== null)) {
        return { ok: false, message: '浏览器刚拉起来就退出了（端口 ' + port + '），' + (lastError || '可能 profile 被占用') };
      }
      const info = await fetchJson('http://127.0.0.1:' + port + '/json/version', 1500);
      if (info.ok && info.data) {
        return {
          ok: true,
          browser: String(info.data.Browser || ''),
          webSocketDebuggerUrl: String(info.data.webSocketDebuggerUrl || '')
        };
      }
      lastError = info.message || lastError;
      await sleep(pollIntervalMs);
    }
    return {
      ok: false,
      message: '等了 ' + Math.round(readyTimeoutMs / 1000) + ' 秒调试端口还没起来（' + (lastError || '无响应') + '）'
    };
  }

  async function ensureBrowser(openUrl) {
    if (isRunning()) {
      if (!cdp || cdp.closed) {
        const reconnected = await connect();
        if (!reconnected.ok) return { ok: true, message: reconnected.message };
      }
      return { ok: true };
    }

    const found = findBrowser(env);
    if (!found.ok) return { ok: false, message: found.message };
    if (!dataDir) return { ok: false, message: '数据目录没准备好，浏览器配置存不下来' };

    /**
     * 启动时直接把目标地址交给浏览器（而不是 about:blank 再导航）：
     *   1. 用户看到的就是目标页面，不会先闪一下空白页；
     *   2. 万一 CDP 连不上，页面也已经打开了，至少不是「一片白」；
     *   3. 地址非法（不是 http/https）时退回 about:blank，不把脏值交给命令行。
     */
    const targetUrl = isHttpUrl(openUrl) ? String(openUrl) : 'about:blank';

    /**
     * 先试稳定 profile（登录态能留下来）。
     * 如果浏览器「刚拉起来就退出」——典型是上次没退干净、还活着的实例占着这个目录，
     * 新进程把命令转发过去然后自己退了（调试端口根本不会开）——就用干净 profile 重试一次。
     */
    const stableProfile = path.join(dataDir, 'sniff-profile');
    let launched = await launchWith(stableProfile, found, targetUrl);

    if (!launched.ok && launched.handoff) {
      const cleanProfile = path.join(dataDir, 'sniff-profile-clean');
      try {
        fs.rmSync(cleanProfile, { recursive: true, force: true });
      } catch (e) {
        /* 删不掉就算了，反正马上要重建 */
      }
      log('sniff: 稳定 profile 起不来（疑似被占用），改用干净 profile 重试');
      launched = await launchWith(cleanProfile, found, targetUrl);
      if (launched.ok) {
        notice = '上次的浏览器进程还占着配置目录，已换用干净配置启动，这次需要重新登录一次';
        log('sniff: ' + notice);
      }
    }
    if (!launched.ok) return { ok: false, message: launched.message };
    return { ok: true, message: launched.message || '' };
  }

  /**
   * 用指定 profile 拉起一次浏览器并等到 CDP 可用。
   *
   * 端口不再猜：传 `--remote-debugging-port=0`，读 profile 里的 DevToolsActivePort
   * 拿到浏览器实际用的端口（见 waitDevToolsPort 的注释）。
   *
   * @returns {Promise<{ok:boolean, message?:string, handoff?:boolean}>}
   */
  async function launchWith(profileDir, found, targetUrl) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch (e) {
      return { ok: false, message: '建浏览器配置目录失败：' + String((e && e.message) || e) };
    }
    // 上一轮残留的端口文件必须清掉，否则会连到一个早就没了的端口
    clearDevToolsPort(profileDir);

    const args = buildLaunchArgs({ port: 0, userDataDir: profileDir, headless, url: targetUrl });
    let child;
    try {
      child = spawnImpl(found.path, args, { stdio: 'ignore', windowsHide: headless, detached: false });
    } catch (e) {
      return { ok: false, message: '启动浏览器失败：' + String((e && e.message) || e) };
    }
    if (!child || !child.pid) return { ok: false, message: '启动浏览器失败：拿不到进程号' };

    proc = child;
    exited = false;
    debugPort = 0;
    browserName = found.name;
    browserPath = found.path;
    browserVersion = '';
    targetId = '';
    scriptId = '';
    lastFacts = null;
    loadedUrl = '';
    launchedUrl = targetUrl === 'about:blank' ? '' : targetUrl;

    child.on('exit', () => {
      exited = true;
      log('sniff browser exited: pid=' + child.pid);
      closeCdp();
      lastFacts = null;
    });
    child.on('error', (e) => {
      exited = true;
      log('sniff browser error: ' + String((e && e.message) || e));
      closeCdp();
    });

    log('sniff browser launched: ' + found.name + ' pid=' + child.pid + ' profile=' + profileDir + (headless ? ' (headless)' : ''));

    const found_port = await waitDevToolsPort(profileDir, child, readyTimeoutMs);
    if (!found_port.ok) {
      await killProcess();
      resetRuntime();
      return { ok: false, handoff: !!found_port.handoff, message: found_port.message };
    }
    debugPort = found_port.port;
    log('sniff devtools port: ' + debugPort);

    const ready = await waitForReady(debugPort);
    if (!ready.ok) {
      await killProcess();
      resetRuntime();
      return { ok: false, message: ready.message };
    }
    browserVersion = ready.browser;
    if (/edg\//i.test(ready.browser)) browserName = 'edge';
    else if (/chrome\//i.test(ready.browser)) browserName = 'chrome';

    const connected = await connect();
    if (!connected.ok) {
      await killProcess();
      resetRuntime();
      return { ok: false, message: connected.message };
    }
    return { ok: true };
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

  async function killProcess() {
    const child = proc;
    if (!child) {
      closeCdp();
      return;
    }
    const pid = child.pid;
    if (child.exitCode !== null) {
      closeCdp();
      return;
    }
    if (pid) {
      try {
        if (process.platform === 'win32') {
          // /T 连子孙进程一起收：Chrome 会自己再开渲染/GPU 进程
          spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch (e) {
        log('taskkill failed: ' + String((e && e.message) || e));
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && child.exitCode === null && !exited) {
      await sleep(100);
    }
    if (child.exitCode === null && !exited) {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* 已经没了 */
      }
      await sleep(200);
    }
    closeCdp();
  }

  /* ---------------- 对外 API ---------------- */

  /**
   * 当前状态（界面轮询用）。
   *
   * ok 只表示「这次查询本身成功了」，浏览器在不在看 running ——
   * 这样前台轮询不会因为「用户把浏览器关了」而弹错误提示。
   */
  async function status() {
    if (!proc) return result(true, '没有在运行的浏览器');
    if (exited || proc.exitCode !== null) {
      resetRuntime();
      return result(true, '浏览器已经关闭');
    }

    const info = await fetchJson(baseUrl() + '/json/version', 900);
    if (!info.ok) {
      await killProcess();
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
         * 但要**核对一下真的在那个页面上**——干净 profile 首次启动时，浏览器可能
         * 先落在新标签页上（我们连的就是那个空标签），那就得补一次导航。
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

  /**
   * 只重新框（换定位方式/定位值时用）。
   *
   * 不导航 —— 但**会话被用户关掉之后要能自己恢复**：
   * 界面上的「重新高亮」按钮不要求先点「启动」，所以这里复用 start()
   * （它会重新拉起浏览器并按记住的 url 导航一次），语义仍然是「按当前元素重新框」。
   */
  async function highlightOnly(input) {
    const payload = input || {};
    if (payload.name !== undefined) current.name = String(payload.name === null ? '' : payload.name);
    if (payload.mode !== undefined) current.mode = highlight.normalizeMode(payload.mode);
    if (payload.selector !== undefined) {
      current.selector = String(payload.selector === null ? '' : payload.selector);
    }
    if (!current.selector) return reject('定位值不能为空');
    if (!isRunning()) {
      if (!current.url) return reject('没有在运行的浏览器，先点「启动」');
      return start({ url: current.url, name: current.name, mode: current.mode, selector: current.selector });
    }

    const applied = await applyHighlight();
    return result(applied.ok, applied.message);
  }

  /** 重新导航并框住当前元素（浏览器被关掉了就重新拉起） */
  async function reopen(input) {
    const payload = input || {};
    const nextUrl = String(payload.url === undefined || payload.url === null ? '' : payload.url).trim();
    if (nextUrl) {
      if (!isHttpUrl(nextUrl)) return reject('只支持 http/https 链接（http:// 或 https:// 开头）');
      current.url = nextUrl;
    }
    if (!current.url) return reject('还没有要打开的地址');
    if (!current.selector) return reject('定位值不能为空');

    if (!isRunning()) {
      return start({ url: current.url, name: current.name, mode: current.mode, selector: current.selector });
    }

    const nav = await navigate(current.url);
    if (!nav.ok) return result(false, nav.message);
    loadedUrl = current.url;
    const applied = await applyHighlight();
    return result(applied.ok, applied.message);
  }

  /** 关掉浏览器（幂等） */
  async function stop() {
    if (!proc) {
      resetRuntime();
      return result(true, '本来就没在运行');
    }
    await killProcess();
    resetRuntime();
    return result(true, '浏览器已关闭');
  }

  /**
   * 同步收尾：before-quit / process exit 里用（异步等不了）。
   * 只做「杀进程」这一件事，别的都交给操作系统。
   */
  function stopSync() {
    const child = proc;
    const pid = child && child.pid;
    closeCdp();
    if (pid && child.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (e) {
        /* 已经没了 */
      }
    }
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
    /** 测试/排查用：当前浏览器进程号（0 = 没有） */
    pid: () => (proc && proc.pid ? proc.pid : 0),
    debugPort: () => debugPort,
    browserPath: () => browserPath,
    browserVersion: () => browserVersion,
    log
  };
}

module.exports = {
  PORT_MIN,
  PORT_MAX,
  READY_TIMEOUT_MS,
  DEFAULT_MODE,
  isHttpUrl,
  isPortInRange,
  browserNameOf,
  browserCandidates,
  findBrowser,
  pickFreePort,
  canBindPort,
  buildLaunchArgs,
  factsMessage,
  emptyFacts,
  createSession
};