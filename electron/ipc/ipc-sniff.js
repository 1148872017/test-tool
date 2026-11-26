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
const fs = require('fs');
const path = require('path');
const { buildCmdExeInvocation } = require('../../shared/shell-safety');

/** process exit 钩子只挂一次（多次 require/register 不重复挂） */
let exitHooked = false;
/** 所有活着的会话（退出时统一收尾；正常只有一个） */
const liveSessions = [];

/** 非法 url 的统一回执文案 */
const URL_REJECT = '只支持 http:// 或 https:// 开头的链接';

/** Java 录制走 npx（cmd 子进程），地址里不能带会破坏命令行的字符 */
const JAVA_URL_REJECT = '这个页面地址里有不能安全传给命令行的字符（双引号 / 百分号 / 换行）。请先手动运行 npx playwright codegen --target java 后再把代码贴回来';

/* ============================================================
 * 录制器启动：**必须给它一个宽限期**（v0.57 真机 bug）
 *
 * 录制器失败的样子是「黑窗口一闪」：浏览器内核没装、npx 找不到包、参数不对……
 * 以前 spawn 完就回 ok:true，用户只看到一闪 + 一句「已启动」，完全无从下手。
 * 现在：输出落到 <dataDir>/codegen.log，3 秒内退出就把退出码 + 日志尾部带回去。
 * ============================================================ */

/**
 * 在 Maven 本地仓库里找一套能直接跑的 Playwright Java jar。
 *
 * 为什么这条路最好（v0.59 实测）：
 *   Playwright Java 的 CLI 只是个 Java 入口，真正的实现在 3 个 jar 里：
 *     playwright-<v>.jar（很小）+ driver-<v>.jar + driver-bundle-<v>.jar（大，含 node 驱动）
 *   只要这台机器上用 Maven 装过一次 playwright（用户的项目就是这么装的），
 *   这三个 jar 就已经在 ~/.m2 里了 —— 平台**直接 java -cp 跑它**，
 *   既不需要用户的 pom，也不需要 exec 插件，更不需要联网。
 *
 * 实测：`java -cp "playwright.jar;driver.jar;driver-bundle.jar" com.microsoft.playwright.CLI codegen <url>`
 * 能直接拉起 Playwright Inspector（Java 目标语言）。
 */
function findM2JarSet(env) {
  const home = String((env || process.env).USERPROFILE || (env || process.env).HOME || '').trim();
  if (!home) return { ok: false, reason: 'no-home' };
  const repo = path.join(home, '.m2', 'repository', 'com', 'microsoft', 'playwright');
  if (!fs.existsSync(repo)) return { ok: false, reason: 'no-repo', repo };

  const byVersion = new Map();
  let artifacts = [];
  try {
    artifacts = fs.readdirSync(repo).filter((n) => {
      try {
        return fs.statSync(path.join(repo, n)).isDirectory();
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return { ok: false, reason: 'no-repo', repo };
  }

  for (const artifact of artifacts) {
    const dir = path.join(repo, artifact);
    let versions = [];
    try {
      versions = fs.readdirSync(dir).filter((v) => {
        try {
          return fs.statSync(path.join(dir, v)).isDirectory();
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      continue;
    }
    for (const version of versions) {
      const jar = path.join(dir, version, artifact + '-' + version + '.jar');
      if (!fs.existsSync(jar)) continue;
      if (!byVersion.has(version)) byVersion.set(version, {});
      byVersion.get(version)[artifact] = jar;
    }
  }

  const usable = [];
  for (const [version, jars] of byVersion) {
    // driver 有 jar 更好，没有也能跑（1.40 之后一般都有）
    if (!jars.playwright || !jars['driver-bundle']) continue;
    usable.push({ version, jars });
  }
  if (!usable.length) return { ok: false, reason: 'no-usable', repo };

  usable.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  const pick = usable[usable.length - 1];
  const sep = process.platform === 'win32' ? ';' : ':';
  const cp = [pick.jars.playwright, pick.jars.driver, pick.jars['driver-bundle']]
    .filter(Boolean)
    .join(sep);
  return { ok: true, version: pick.version, jars: pick.jars, classpath: cp, repo };
}

/** 拼「直接用 m2 里的 jar 跑 codegen」的命令 */
function buildM2CodegenCommand(javaExe, classpath, url) {
  const args = ['-Dfile.encoding=UTF-8', '-cp', classpath, 'com.microsoft.playwright.CLI', 'codegen', url];
  const printable = '"' + javaExe + '" -cp "' + classpath + '" com.microsoft.playwright.CLI codegen ' + url;
  return { args, printable };
}

/**
 * 探测「用用户自己的 Maven 项目跑 Java 录制」这条路通不通。
 *
 * 为什么优先走这条路（v0.58）：
 *   Playwright 的 Java 绑定**自带 CLI**，用户项目里通常已经这么用过——
 *     com.microsoft.playwright.CLI.main(new String[]{"codegen", "<url>"})
 *   只要 pom 里有 exec-maven-plugin + playwright 依赖，平台就能在他自己的项目里
 *   把同一个入口拉起来，录出来的**直接就是 Java 代码**，不需要另装 Node。
 *
 * 只读 pom.xml 判断，不执行任何东西；跑不跑得起来交给真正的 mvn 去说。
 */
function detectJavaCodegenProject(projectDir) {
  const dir = String(projectDir || '').trim();
  if (!dir) return { ok: false, reason: 'no-project' };
  const pom = path.join(dir, 'pom.xml');
  let text = '';
  try {
    text = fs.readFileSync(pom, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'no-pom' };
  }
  const hasExec = /exec-maven-plugin/.test(text);
  const hasPlaywright = /<artifactId>playwright<\/artifactId>/.test(text);
  if (!hasExec) return { ok: false, reason: 'no-exec', pom };
  if (!hasPlaywright) return { ok: false, reason: 'no-playwright', pom };
  return { ok: true, pom, dir };
}

/**
 * 拼「通过 Maven 跑 Playwright Java CLI」的命令（返回可复制的字符串 + argv）。
 *
 * 为什么用 `exec:exec` 而不是 `exec:java`（v0.58 实测踩到）：
 *   用户的 pom 里通常写着 `<configuration><mainClass>XxxTask</mainClass></configuration>`
 *   （exec-maven-plugin 的显式配置**优先于** -Dexec.mainClass），
 *   于是 `-Dexec.mainClass=com.microsoft.playwright.CLI` 根本不生效，
 *   Maven 会去跑他项目里那个默认主类，报一句看不懂的 "An exception occurred..."。
 *   `exec:exec` 是「启动一个外部进程」的目标：executable/args 走 `exec.executable` / `exec.args`
 *   两个属性，pom 里一般没配，所以命令行能盖住；再用 `%classpath` 拿到项目依赖（含 target/classes）。
 */
function buildJavaCodegenCommand(javaExe, pom, url) {
  const args = [
    '-q',
    '-f',
    pom,
    'exec:exec',
    '-Dexec.executable=' + javaExe,
    '-Dexec.args=-cp %classpath com.microsoft.playwright.CLI codegen ' + url
  ];
  const printable = '"' + javaExe + '" -cp %classpath com.microsoft.playwright.CLI codegen ' + url;
  return { args, printable };
}

/**
 * 录制器该用哪个浏览器 channel。
 *
 * 为什么必须带 channel（v0.59 真机根因）：
 *   Playwright 升级后常常「要求某个版本的 chromium」，而用户机器上装的是旧版本，
 *   于是 `codegen` 秒退并报 `Executable doesn't exist at ...chromium-1255...`。
 *   但 CLI 支持 `--channel=chrome|msedge`，**直接用系统里已装的浏览器**，
 *   完全绕开「下载对应版本内核」这件事。
 *
 * @param {'auto'|'edge'|'chrome'} choice 和「实时校验」共用的浏览器偏好
 *   显式选了就优先用它；auto 时按系统默认浏览器（注册表），再试另一个。
 */
function channelOrder(choice) {
  const want = String(choice || 'auto').toLowerCase();
  if (want === 'chrome') return ['chrome', 'msedge'];
  if (want === 'edge') return ['msedge', 'chrome'];
  let first = 'chrome';
  try {
    const browserSession = require('../sniffer/browser-session');
    const r = browserSession.resolveBrowser('auto');
    if (r && r.ok && r.name === 'edge') first = 'msedge';
  } catch (e) {
    /* 解析不出来就用 chrome */
  }
  return [first, first === 'chrome' ? 'msedge' : 'chrome'];
}

/** 录制器秒退时最常见的两种原因，补一句能直接照做的提示 */
function codegenFailureHint(message, exe) {
  const text = String(message || '');
  if (/Executable doesn't exist|is not installed|please run the following command/i.test(text)) {
    return (
      text +
      '\n这通常是 Playwright 的浏览器版本和当前 playwright 包对不上：在命令行跑 ' +
      exe +
      ' -m playwright install chromium 补一次（会下载几十 MB），再点一次「启动录制器」。'
    );
  }
  if (/No module named playwright/i.test(text)) {
    return text + '\n这个 Python 里没有 Playwright，先 pip install playwright。';
  }
  return text;
}

/** 录制器日志文件（dataDir 不可用时返回空串，退化成不记录） */
function codegenLogPath(dataDir) {
  const dir = String(dataDir || '').trim();
  return dir ? path.join(dir, 'codegen.log') : '';
}

/** 日志太大就清掉，只保留最近一次运行的输出 */
function trimLog(file) {
  if (!file) return;
  try {
    if (fs.statSync(file).size > 200 * 1024) fs.writeFileSync(file, '');
  } catch (e) {
    /* 文件不存在就算了 */
  }
}

/** 读日志尾部几行（失败时给用户看，比"一闪"有用） */
function logTail(file, max) {
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - 4000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = String(buf.toString('utf8') || '')
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-5);
    return lines.join(' | ').slice(0, Number(max) || 500);
  } catch (e) {
    return '';
  }
}

/**
 * 拉起一个会自己开窗口的进程，并给它 graceMs 的宽限期判断是否秒退。
 *
 * @returns {Promise<{ok:boolean, pid?:number, code?:string, message?:string, logFile?:string}>}
 */
function spawnDetached(cmd, args, opts) {
  const o = opts || {};
  const logFile = o.logFile || '';
  let fd = -1;
  if (logFile) {
    trimLog(logFile);
    try {
      fd = fs.openSync(logFile, 'a');
    } catch (e) {
      fd = -1;
    }
  }
  const stdio = fd >= 0 ? ['ignore', fd, fd] : 'ignore';

  let child;
  try {
    child = spawn(cmd, args, Object.assign({
      detached: true,
      stdio,
      windowsHide: true,
      env: o.env || process.env
    }, o.spawnOptions || {}));
  } catch (e) {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch (e2) {
        /* ignore */
      }
    }
    return Promise.resolve({
      ok: false,
      code: 'CODEGEN_SPAWN_FAILED',
      logFile,
      message: '拉起录制器失败：' + String((e && e.message) || e)
    });
  }
  if (fd >= 0) {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* 子进程已经拿到自己的副本 */
    }
  }

  const graceMs = Number(o.graceMs) || 3000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const timer = setTimeout(() => {
      if (typeof child.unref === 'function') child.unref();
      finish({ ok: true, pid: child.pid || 0, logFile });
    }, graceMs);

    child.on('error', (e) =>
      finish({ ok: false, code: 'CODEGEN_SPAWN_FAILED', logFile, message: '拉起录制器失败：' + String((e && e.message) || e) })
    );

    child.on('exit', (code) => {
      // 宽限期内就退了：不管退出码是不是 0，录制器都不该自己退
      const tail = logTail(logFile, 400);
      finish({
        ok: false,
        code: 'CODEGEN_EXITED',
        exitCode: code,
        logFile,
        message:
          '录制器启动后立刻退出了（退出码 ' + code + '）' +
          (tail ? '：' + tail : '（没有任何输出）') +
          (logFile ? '。完整日志：' + logFile : '')
      });
    });
  });
}

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

    const langRaw = String((payload && payload.lang) || 'auto')
      .trim()
      .toLowerCase();
    /** auto = 不指定：按「Python 录制器 → 本机 jar → 你的项目 → Node」自动挑一个 */
    const autoMode = !langRaw || langRaw === 'auto';

    const settings = typeof getSettings === 'function' ? getSettings() || {} : {};
    const python = String(settings.pythonPath || process.env.PYTHON || '').trim();
    const exe = python || 'python';
    const logFile = codegenLogPath(dataDir);

    /**
     * AUTO 第一步：Python 录制器。为什么它排第一——
     *   起得最快（3 秒宽限期够用），而且 **Inspector 右上角 Target 能切输出语言**，
     *   也就是说用它录出来的也可以直接是 Java 代码。语言不再是「启动器」的属性。
     * Python 不可用时**不报错**，继续往下走 Java 链（这才叫自动）。
     */
    let forceJava = false;
    if (autoMode || langRaw === 'python' || langRaw === 'pytest') {
      const pyProbe = spawnSync(exe, ['-m', 'playwright', '--version'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true
      });
      const pyUsable = !pyProbe.error && pyProbe.status === 0;
      if (!pyUsable) {
        if (autoMode) {
          forceJava = true; // 继续往下，交给 Java 链
        } else {
          const detail = String((pyProbe.stderr || '') || (pyProbe.error && pyProbe.error.message) || '').trim();
          return {
            ok: false,
            code: 'NO_PLAYWRIGHT',
            lang: 'python',
            message:
              '这个 Python 里没有 Playwright（' + exe + '）' + (detail ? '：' + detail : '') + '。' +
              '先在命令行跑 pip install playwright，再到「设置 → 开发环境」把 Python 指向装了它的那个解释器。'
          };
        }
      } else {
        /**
         * 先用系统浏览器（--channel）起：这样不会因为「Playwright 要的 chromium 版本
         * 和本机装的不一致」而秒退。两次都不行才退回不带 channel 的老调用。
         */
        let lastFailure = null;
        for (const ch of channelOrder(payload && payload.browser)) {
          const started = await spawnDetached(exe, ['-m', 'playwright', 'codegen', '--channel=' + ch, url], {
            logFile,
            graceMs: 3500
          });
          if (started.ok) {
            return {
              ok: true,
              pid: started.pid || 0,
              via: 'python',
              lang: 'python',
              python: exe,
              channel: ch,
              logFile,
              message:
                'Playwright codegen（Python 录制器 · 用你系统的 ' +
                (ch === 'msedge' ? 'Edge' : 'Chrome') +
                '）已启动。Inspector 右上角 Target 可切输出语言；录完点「Copy」把代码贴回下面的框里。'
            };
          }
          lastFailure = started;
          if (typeof logStartup === 'function') {
            logStartup('[sniff] codegen --channel=' + ch + ' 失败：' + String(started.message || '').slice(0, 200));
          }
        }

        // 退回不带 channel 的调用（极老的 playwright 没有 --channel）
        const plain = await spawnDetached(exe, ['-m', 'playwright', 'codegen', url], { logFile });
        if (plain.ok) {
          return {
            ok: true,
            pid: plain.pid || 0,
            via: 'python',
            lang: 'python',
            python: exe,
            logFile,
            message:
              'Playwright codegen（Python 录制器 · ' + exe + '）已启动。' +
              'Inspector 右上角 Target 可切输出语言；录完点「Copy」把代码贴回下面的框里。'
          };
        }

        return {
          ok: false,
          code: plain.code || (lastFailure && lastFailure.code),
          lang: 'python',
          pid: 0,
          logFile,
          message: codegenFailureHint(String(plain.message || (lastFailure && lastFailure.message) || ''), exe)
        };
      }
    }

    const lang = forceJava || langRaw === 'java' ? 'java' : langRaw === 'pytest' ? 'pytest' : 'python';

    /* ---------------- Java：直跑本机 jar → 你的 Maven 项目 → Node 版 ---------------- */
    if (lang === 'java') {
      if (/["%\r\n]/.test(url)) {
        return { ok: false, code: 'UNSAFE_URL', lang, message: JAVA_URL_REJECT };
      }
      const javaExe = String(settings.javaHome || '').trim()
        ? path.join(String(settings.javaHome).trim(), 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
        : 'java';

      /* ---- ① 首选：直接用 Maven 本地仓库里的 Playwright jar（不依赖项目，也不需要联网） ---- */
      const m2 = findM2JarSet(process.env);
      if (m2.ok) {
        const built = buildM2CodegenCommand(javaExe, m2.classpath, url);
        const started = await spawnDetached(javaExe, built.args, { logFile, graceMs: 12000 });
        if (!started.ok) {
          return {
            ok: false,
            code: started.code,
            lang,
            pid: 0,
            logFile,
            command: built.printable,
            message: started.message + '\n这条命令可以手动跑一次看看：' + built.printable
          };
        }
        return {
          ok: true,
          pid: started.pid || 0,
          lang,
          via: 'm2-jar',
          playwrightVersion: m2.version,
          logFile,
          command: built.printable,
          message:
            'Playwright codegen（Java · 平台直跑本机 Playwright ' +
            m2.version +
            ' 的 jar，不需要你的项目）已启动。' +
            'Inspector 右上角 Target 选 Java，录完点「Copy」贴回下面的框里。'
        };
      }

      /* ---- ② 其次：用用户自己的 Maven 项目（pom 有 exec 插件 + playwright 依赖） ---- */
      const mvnTarget = detectJavaCodegenProject(settings.projectDir);
      if (mvnTarget.ok) {
        const mvnExe = String(settings.mvnPath || 'mvn').trim() || 'mvn';
        const built = buildJavaCodegenCommand(javaExe, mvnTarget.pom, url);
        let file = mvnExe;
        let argv = built.args;
        let spawnOptions = {};
        if (process.platform === 'win32') {
          const inv = buildCmdExeInvocation(mvnExe, built.args);
          file = inv.file;
          argv = inv.args;
          spawnOptions = { windowsVerbatimArguments: true };
        }
        // Maven 要解析依赖 + 起 JVM，比 python 慢得多，宽限期给 20 秒
        const started = await spawnDetached(file, argv, { logFile, graceMs: 20000, spawnOptions });
        if (!started.ok) {
          return {
            ok: false,
            code: started.code,
            lang,
            pid: 0,
            logFile,
            command: built.printable,
            message: started.message + '\n这条命令可以手动跑一次看看：' + built.printable
          };
        }
        return {
          ok: true,
          pid: started.pid || 0,
          lang,
          via: 'maven',
          logFile,
          command: built.printable,
          message:
            'Playwright codegen（Java · 走你的 Maven 项目 com.microsoft.playwright.CLI）已启动。' +
            'Inspector 右上角 Target 选 Java，录完点「Copy」把代码贴回下面的框里。'
        };
      }

      /* ---- ② 退而求其次：本机 Node 版 Playwright ---- */
      const node = probeNodePlaywright();
      if (node.ok) {
        const isWin = process.platform === 'win32';
        const nodeEnv = Object.assign({}, process.env, { npm_config_offline: 'true', npm_config_yes: 'false' });
        const started = isWin
          ? await spawnDetached(
              process.env.ComSpec || 'cmd.exe',
              ['/d', '/s', '/c', 'npx playwright codegen --target java "' + url + '"'],
              { logFile, env: nodeEnv }
            )
          : await spawnDetached('npx', ['playwright', 'codegen', '--target', 'java', url], { logFile, env: nodeEnv });

        if (!started.ok) {
          return { ok: false, code: started.code, lang, pid: 0, logFile, message: codegenFailureHint(started.message, 'npx') };
        }

        return {
          ok: true,
          pid: started.pid || 0,
          lang,
          via: 'node',
          nodePlaywright: node.version,
          logFile,
          message: 'Playwright codegen（Java · Node 版）已启动。录完在录制器里点「Copy」，把 Java 代码贴回下面的框里。'
        };
      }

      /* ---- ④ 都不通：说清每条路差什么 + 给可复制的命令 ---- */
      const detail = String(node.detail || '').trim();
      const manualCmd = 'mvn exec:exec -Dexec.executable=java "-Dexec.args=-cp %classpath com.microsoft.playwright.CLI codegen ' + url + '"';
      const whyM2 = {
        'no-home': '读不到用户主目录',
        'no-repo': 'Maven 本地仓库里没有 com/microsoft/playwright（' + String(m2.repo || '') + '）',
        'no-usable': '仓库里的 playwright 版本缺少 driver-bundle jar，跑不起来'
      }[m2.reason] || 'Maven 仓库里没有可用的 jar';
      const whyProject = {
        'no-project': '「设置 → 目录配置 → 项目代码」还没指向你的自动化工程',
        'no-pom': '那个目录里没有 pom.xml',
        'no-exec': 'pom.xml 里没有 exec-maven-plugin',
        'no-playwright': 'pom.xml 里没有 playwright 依赖'
      }[mvnTarget.reason] || '项目没法直接跑';
      return {
        ok: false,
        code: 'NO_JAVA_RECORDER',
        lang,
        logFile,
        command: manualCmd,
        message:
          '没找到可用的 Java 录制器。\n' +
          '· 直跑 jar 这条路不通：' + whyM2 + '\n' +
          '· 你的 Maven 项目这条路也不通：' + whyProject + '\n' +
          '· 本机也没有 Node 版 Playwright' + (detail ? '（' + detail + '）' : '') + '\n' +
          '平台不会自动安装、也不会联网下载。三条路：\n' +
          '① 【推荐】随便在一个 Java 项目里执行一次 mvn dependency:get -Dartifact=com.microsoft.playwright:playwright:1.62.0:jar:with-dependencies，' +
          '让 jar 落进 ~/.m2，之后再点「启动录制器」——平台会直接跑这些 jar，不需要那个项目；\n' +
          '② 把「设置 → 目录配置 → 项目代码」指到你的自动化工程（pom 有 exec-maven-plugin + playwright 依赖）；\n' +
          '③ 切回 Python 系录制（只出 Python 代码），贴回来照样能解析入库。'
      };
    }

    /**
     * 走到这里说明 lang 是 python 系、但 auto 分支没接住（理论上不会发生）。
     * 兜底回一句明确的错误，而不是静默什么都不做。
     */
    return {
      ok: false,
      code: 'NO_RECORDER',
      lang,
      message: '没找到可用的录制器：Python 与 Java 两条路都没起来，请看 codegen.log 或手动跑一次。'
    };
  });
}

module.exports = {
  register,
  URL_REJECT,
  normalizeReopenPayload,
  spawnDetached,
  logTail,
  codegenLogPath,
  codegenFailureHint,
  detectJavaCodegenProject,
  buildJavaCodegenCommand,
  findM2JarSet,
  buildM2CodegenCommand
};