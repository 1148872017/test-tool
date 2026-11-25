'use strict';
/**
 * ipc-sniff.js —— 「用系统浏览器实时高亮定位器」的 IPC 域。
 *
 * ============================================================
 * 五个通道（全部走 deps.handle + assertUnlocked）
 * ============================================================
 *   sniff:status     入参 {}                              查会话状态（界面轮询用）
 *   sniff:start      入参 {url,name,mode,selector,browser} 起浏览器 + 打开页面 + 高亮
 *   sniff:highlight  入参 {name,mode,selector,browser}     不导航，只重新框
 *                                                        （浏览器被关掉了会按记住的地址自动拉起）
 *   sniff:reopen     入参 {url,browser}                    重新导航并框住当前元素
 *   sniff:stop       入参 {}                              关掉浏览器（幂等）
 *
 * browser（v0.56 新增，默认 auto）：
 *   'auto'   —— 跟系统默认浏览器（注册表 UserChoice 的 ProgId：
 *               ChromeHTML→chrome、MSEdgeHTM→edge），认不出就 Edge → Chrome
 *   'edge'   —— 只用 Edge（找不到回明确错误，不偷偷换 Chrome）
 *   'chrome' —— 只用 Chrome（同上）
 *
 * 统一返回形状（五个通道完全一致，前端只认一套）：
 *   { ok, running, browser, browserChosen, url, name, mode, selector,
 *     found, total, visible, inIframe, reason, message, browserVersion }
 *
 *   ok        —— 这一次操作本身成没成（status 恒为 true：查询成功就是成功，
 *                浏览器在不在看 running，免得界面轮询时老弹错误）
 *   running   —— 浏览器会话还在不在（用户自己关窗口后会变 false）
 *   browser   —— 实际用的：'edge' | 'chrome'（没起来过是空串）
 *   browserChosen —— 用户选的：'auto' | 'edge' | 'chrome'（界面回显用）
 *   found     —— 匹配到几个元素
 *   total     —— 上报上下文里的匹配总数（正常等于 found）
 *   visible   —— 第一个是否可见
 *   inIframe  —— 是否在 iframe 里
 *   reason    —— '' / 'not-found' / 'in-iframe' / 'shadow-dom'
 *   message   —— 一句人话（只描述事实，不判对错）
 *
 * ============================================================
 * 安全边界
 * ============================================================
 *   · url 只允许 http/https，非法**直接**回 ok:false；
 *     这里不用 assertPathIn —— 那是文件路径守卫，对 URL 没有意义（也会误判）；
 *   · 不读 cookie / localStorage / 页面内容，只做「导航 + 注入高亮」；
 *   · 浏览器只监听 127.0.0.1 的随机端口（见 sniffer/browser-session.js）；
 *   · 应用退出时（before-quit / process exit）同步杀掉浏览器进程，不留残尸。
 */

const sessionModule = require('../sniffer/browser-session');
const { spawn, spawnSync } = require('child_process');

/** process exit 钩子只挂一次（多次 require/register 不重复挂） */
let exitHooked = false;
/** 所有活着的会话（退出时统一收尾；正常只有一个） */
const liveSessions = [];

/** 非法 url 的统一回执文案 */
const URL_REJECT = '只支持 http:// 或 https:// 开头的链接';

/** Java 录制走 npx（cmd 子进程），地址里不能带会破坏命令行的字符 */
const JAVA_URL_REJECT = '这个页面地址里有不能安全传给命令行的字符（双引号 / 百分号 / 换行）。请先手动运行 npx playwright codegen --target java 后再把代码贴回来';

/**
 * 探测本机有没有 Node 版 Playwright（Java 录制必须用它）。
 *
 * **绝不联网、绝不自动安装**：
 *   · npm_config_offline=true —— 没装时直接失败，不会去 registry 拉包；
 *   · npm_config_yes=false    —— 不替用户回答 npx 的安装确认；
 *   · 超时 20s，失败只返回探测详情，不弹任何窗口。
 *
 * Windows 上 npx 是 npx.cmd，Node 18.20+ 不允许 spawn 批处理不走 shell，
 * 所以这里显式用 cmd.exe /d /s /c 跑一条**没有用户拼接**的固定命令。
 */
function probeNodePlaywright() {
  const isWin = process.platform === 'win32';
  const env = Object.assign({}, process.env, {
    npm_config_offline: 'true',
    npm_config_yes: 'false',
    npm_config_loglevel: 'error'
  });
  const probe = isWin
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx playwright --version'], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        env
      })
    : spawnSync('npx', ['playwright', '--version'], {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        env
      });
  const stdout = String((probe && probe.stdout) || '').trim();
  const stderr = String((probe && probe.stderr) || (probe && probe.error && probe.error.message) || '').trim();
  if (probe && !probe.error && probe.status === 0 && /playwright/i.test(stdout)) {
    return { ok: true, version: stdout };
  }
  return { ok: false, detail: stderr || stdout };
}

/**
 * 归一化 sniff:reopen 的入参（**纯函数**，可单测）。
 *
 * 为什么需要这一层（v0.56）：
 *   preload 里 sniffReopen 目前还是老形状 —— `sniffReopen: (url) => invoke('sniff:reopen', { url })`，
 *   而界面按新契约传的是 `{ url, browser }`，于是真正到主进程的 payload 变成了
 *   `{ url: { url, browser } }`。不拆这一层，url 会被判成非法、browser 也丢了。
 *
 *   preload 归别人改，这里先做**兼容拆包**（preload 修好之后这段自然不生效，不冲突）：
 *   · 字符串 payload（`sniffReopen(url)` 直调）→ 当成 url；
 *   · `{ url: {url, browser} }`          → 用内层的 url / browser；
 *   · `{ url, browser }`                 → 原样用；
 *   · 其余 → url 空串（= 用会话里记住的地址），browser 取外层。
 *
 * @param {*} payload
 * @returns {{url: string, browser: (string|undefined)}}
 */
function normalizeReopenPayload(payload) {
  const asUrl = (v) => String(v === undefined || v === null ? '' : v).trim();
  if (typeof payload === 'string') return { url: asUrl(payload), browser: undefined };
  if (!payload || typeof payload !== 'object') return { url: '', browser: undefined };
  const inner = payload.url && typeof payload.url === 'object' ? payload.url : null;
  if (inner) {
    return {
      url: asUrl(inner.url),
      browser: inner.browser !== undefined ? inner.browser : payload.browser
    };
  }
  return { url: asUrl(payload.url), browser: payload.browser };
}

function register(deps) {
  const { handle, assertUnlocked, dataDir, app, logStartup, getSettings } = deps;

  /**
   * 一个 IPC 域一个会话（模块级单例，但不放全局）：
   * 浏览器关了再开是同一个会话对象，界面状态不会丢（url/name/mode/selector 都还在）。
   */
  const sniffer = sessionModule.createSession({
    dataDir,
    log: typeof logStartup === 'function' ? (msg) => logStartup('[sniff] ' + msg) : undefined
  });

  /**
   * 应用退出要杀干净。
   *
   * 为什么挂在这里而不是 main.js：
   *   本域是自己接线的（main.js 里 IPC 域是自动加载的），
   *   为了一个功能去改装配层不划算；deps.app 就是真 app，挂事件一样有效。
   * before-quit 里只做同步 taskkill（异步等不到），所以用 stopSync。
   */
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      sniffer.stopSync();
    });
    app.on('will-quit', () => {
      sniffer.stopSync();
    });
  }
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const one of liveSessions) {
        try {
          one.stopSync();
        } catch (e) {
          /* 退出路径上不能再抛 */
        }
      }
    });
  }
  liveSessions.push(sniffer);

  // ---- 状态 ----
  handle('sniff:status', async () => {
    assertUnlocked();
    return sniffer.status();
  });

  // ---- 起浏览器 + 打开页面 + 高亮 ----
  handle('sniff:start', async (e, payload = {}) => {
    assertUnlocked();
    const { url, name, mode, selector, browser } = payload || {};
    if (!sniffer.isHttpUrl(url)) return sniffer.reject(URL_REJECT);
    return sniffer.start({ url, name, mode, selector, browser });
  });

  // ---- 只重新框（不导航） ----
  handle('sniff:highlight', async (e, payload = {}) => {
    assertUnlocked();
    const { name, mode, selector, browser } = payload || {};
    return sniffer.highlight({ name, mode, selector, browser });
  });

  // ---- 重新导航并框住当前元素 ----
  handle('sniff:reopen', async (e, payload = {}) => {
    assertUnlocked();
    const norm = normalizeReopenPayload(payload);
    // 不传 url = 用会话里的地址重开；传了就必须是 http/https
    if (norm.url && !sniffer.isHttpUrl(norm.url)) return sniffer.reject(URL_REJECT);
    return sniffer.reopen({ url: norm.url, browser: norm.browser });
  });

  // ---- 关掉浏览器 ----
  handle('sniff:stop', async () => {
    assertUnlocked();
    return sniffer.stop();
  });

  /**
   * 拉起 Playwright codegen（v0.54.1 / v0.55 加 lang）。
   *
   * 语言语义（已核实的事实）：
   *   · `python -m playwright codegen` **只能出 Python**，官方没有 --target；
   *   · Java 代码必须用 Node 版的 `npx playwright codegen --target java`。
   * 所以：
   *   lang = python / pytest → 走本机配置的 Python（原路径不变）；
   *   lang = java            → 先探测 npx playwright，**不自动安装、不联网**；
   *                            可用才拉起，不可用就回 ok:false + 明确文案。
   *
   * 安全：url 只放行 http/https；Python 用 spawn 数组参数不过 shell；
   * Java 走 npx.cmd 时必须过 shell，所以额外拒绝 `" % 换行` 这类会破坏命令行的字符。
   * codegen 是独立进程（detached + unref），平台退出不连带杀它 —— 录制器是用户自己的窗口。
   */
  handle('sniff:codegen', async (e, payload = {}) => {
    assertUnlocked();
    const url = String((payload && payload.url) || '').trim();
    if (!sniffer.isHttpUrl(url)) return { ok: false, message: URL_REJECT };

    const langRaw = String((payload && payload.lang) || 'python')
      .trim()
      .toLowerCase();
    const lang = langRaw === 'java' ? 'java' : langRaw === 'pytest' ? 'pytest' : 'python';

    const settings = typeof getSettings === 'function' ? getSettings() || {} : {};
    const python = String(settings.pythonPath || process.env.PYTHON || '').trim();
    const exe = python || 'python';

    /* ---------------- Java：Node 版 Playwright（先探测，不装不联网） ---------------- */
    if (lang === 'java') {
      if (/["%\r\n]/.test(url)) {
        return { ok: false, code: 'UNSAFE_URL', lang, message: JAVA_URL_REJECT };
      }
      const node = probeNodePlaywright();
      if (!node.ok) {
        const detail = String(node.detail || '').trim();
        return {
          ok: false,
          code: 'NO_NODE_PLAYWRIGHT',
          lang,
          message:
            'Java 录制需要 Node 版 Playwright（npx playwright codegen --target java），但本机没探测到可用的 npx playwright' +
            (detail ? '（' + detail + '）' : '') +
            '。平台不会自动安装、也不会联网下载：请先在装了 Node 的环境里执行 npm i -D playwright，再点一次；' +
            '或者把「录制 / 解析语言」切回 Python 系，用本机 Python 录制器（它只能出 Python）。'
        };
      }

      const isWin = process.platform === 'win32';
      const nodeEnv = Object.assign({}, process.env, { npm_config_offline: 'true', npm_config_yes: 'false' });
      let child;
      try {
        if (isWin) {
          // 固定前缀 + 只把已校验的 url 放进双引号里（& | < > 在引号内是普通字符）
          child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx playwright codegen --target java "' + url + '"'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            env: nodeEnv
          });
        } else {
          child = spawn('npx', ['playwright', 'codegen', '--target', 'java', url], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            env: nodeEnv
          });
        }
      } catch (err) {
        return { ok: false, code: 'CODEGEN_SPAWN_FAILED', lang, message: '拉起 Java codegen 失败：' + String((err && err.message) || err) };
      }
      if (child && typeof child.unref === 'function') child.unref();

      return {
        ok: true,
        pid: child && child.pid ? child.pid : 0,
        lang,
        nodePlaywright: node.version,
        message: 'Playwright codegen（Java · Node 版）已启动。录完在录制器里点「Copy」，把 Java 代码贴回下面的框里。'
      };
    }

    /* ---------------- Python 系：原路径（python -m playwright codegen） ---------------- */
    /**
     * 先探一下这个解释器里有没有 playwright。
     * 不探的话，用户点下去只会看到一个黑窗口闪一下 —— 那种失败最难排查。
     */
    const probe = spawnSync(exe, ['-m', 'playwright', '--version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true
    });
    if (probe.error || probe.status !== 0) {
      const detail = String((probe.stderr || '') || (probe.error && probe.error.message) || '').trim();
      return {
        ok: false,
        code: 'NO_PLAYWRIGHT',
        lang,
        message:
          '这个 Python 里没有 Playwright（' + exe + '）' + (detail ? '：' + detail : '') + '。' +
          '先在命令行跑 pip install playwright，再到「设置 → 开发环境」把 Python 指向装了它的那个解释器。'
      };
    }

    let child;
    try {
      child = spawn(exe, ['-m', 'playwright', 'codegen', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
    } catch (err) {
      return { ok: false, lang, message: '拉起 codegen 失败：' + String((err && err.message) || err) };
    }
    if (child && typeof child.unref === 'function') child.unref();

    return {
      ok: true,
      pid: child && child.pid ? child.pid : 0,
      python: exe,
      lang,
      message:
        'Playwright codegen（Python 录制器 · ' + exe + '）已启动。录完在录制器里点「Copy」，把代码贴回下面的框里。' +
        (lang === 'pytest' ? '（pytest 用同一个录制器，贴回来照样识别）' : '')
    };
  });
}

module.exports = { register, URL_REJECT, normalizeReopenPayload };