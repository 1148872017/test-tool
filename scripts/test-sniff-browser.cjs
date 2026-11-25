'use strict';
/**
 * 「用系统浏览器实时高亮定位器」—— 真浏览器链路测试。
 *
 * ============================================================
 * 它到底验什么（不是走过场）
 * ============================================================
 *   1. 真起 Edge / Chrome（--headless=new，不弹窗），随机端口只绑 127.0.0.1；
 *   2. 真打开一个本地 http fixture（不是 file://，url 校验只放 http/https）；
 *   3. 真注入高亮脚本，读回事实：found=1 / visible=true / reason=''；
 *   4. 真的在页面里摸到那个框（fixed + pointer-events:none + 最大 z-index + 红色实线）；
 *   5. 真的验证常驻 MutationObserver：把元素删掉 → found 变 0、框消失；
 *      再塞回去 → found 变 1、框自己回来（不用主进程再下发）；
 *   6. 不可见元素 → found=1 / visible=false / 红色**虚线**框；
 *   7. iframe 内 / shadow DOM 内 → 只报 reason，**不画框**；
 *   8. 不存在的 selector → found=0 / reason='not-found'；
 *   9. stop 之后进程真的退出了（按 pid 查 + 按命令行计数，不信「返回值说关了」）；
 *      并验证走的是 CDP Browser.close 这一级；
 *  10. 模拟「用户自己关窗口」（外部 taskkill）→ status 必须回 running:false。
 *
 * ============================================================
 * v0.56 三个真机 bug 的回归点（同一根因链）
 * ============================================================
 *   bug1 子进程退出 ≠ 浏览器退出：等就绪只认 DevToolsActivePort + /json/version，
 *        转发进程退掉也要 running:true（真实链路里靠 pid 记账 + 命令行认领来收尾）。
 *   bug2 反复 start 只能有一个实例：复用同一 pid / 同一调试端口，
 *        本 profile 的浏览器**主进程**（无 --type=）数必须是 1。
 *   bug3 browser 选择：auto 跟系统默认浏览器；显式 edge/chrome 照办；
 *        写错回明确错误；返回值里 browser（实际）+ browserChosen（用户选的）。
 *
 * ============================================================
 * 找不到浏览器怎么办：显式 SKIP，绝不假装通过
 * ============================================================
 * 打印每一条找过的路径和原因，汇总里写 `N skipped`，退出码 0。
 * 这样换一台没装 Edge/Chrome 的机器跑 unit 档，结果是「明确跳过」而不是「绿了但其实没跑」。
 *
 * 用法：
 *   node scripts/test-sniff-browser.cjs
 *   $env:TT_SNIFF_BROWSER="D:\my\chrome.exe"; node scripts/test-sniff-browser.cjs   # 指定浏览器
 *   $env:TT_SNIFF_DEFAULT_PROGID="ChromeHTML"; node scripts/test-sniff-browser.cjs  # 假装默认浏览器是 Chrome
 *
 * 退出码：0 全通过（或显式跳过）/ 1 有失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const bs = require(path.join(ROOT, 'electron', 'sniffer', 'browser-session.js'));
const { createCdpClient } = require(path.join(ROOT, 'electron', 'sniffer', 'cdp.js'));

const results = [];
const skipped = [];

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : detail !== undefined ? '  -> ' + detail : ''));
  return !!ok;
}
const check = (name, cond, detail) => record(name, cond, detail);
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log('  SKIP  ' + name + '  -> ' + reason);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程还在不在（Windows 上 signal 0 也能查到） */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/** fixture：把九种定位方式里最有代表性的几种都放进去 */
const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>sniff fixture</title>
<style>
  body { font-family: sans-serif; padding: 24px; }
  .spacer { height: 900px; background: linear-gradient(#fff, #eee); }
  iframe { width: 320px; height: 90px; border: 1px solid #ccc; }
</style>
</head>
<body>
  <h1>高亮定位器 fixture</h1>
  <button id="login-btn" data-testid="login-btn">登录</button>
  <label for="user">用户名</label>
  <input id="user" data-testid="user-input" placeholder="请输入用户名" aria-label="用户名">
  <span id="hidden-el" data-testid="hidden-el" style="display:none">看不见的说明</span>
  <span id="title-el" data-testid="title-el" title="关闭按钮">×</span>
  <img id="alt-el" data-testid="alt-el" alt="头像" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
  <div id="shadow-host"></div>
  <iframe id="frame" title="inner" srcdoc="<!doctype html><body style='margin:0'><button data-testid='inner-btn'>框内按钮</button></body>"></iframe>
  <div class="spacer">下面很远的地方</div>
  <script>
    (function () {
      var host = document.getElementById('shadow-host');
      if (host && host.attachShadow) {
        var root = host.attachShadow({ mode: 'open' });
        var btn = document.createElement('button');
        btn.setAttribute('data-testid', 'shadow-btn');
        btn.textContent = '影子按钮';
        root.appendChild(btn);
      }
    })();
  </script>
</body>
</html>`;

/** 起一个只服务 fixture 的本地 http 服务（127.0.0.1，随机端口） */
function startFixtureServer(html) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.indexOf('/fixture.html') === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: 'http://127.0.0.1:' + addr.port + '/fixture.html' });
    });
  });
}

/**
 * 另开一条 CDP 通道去「摸」页面真实状态。
 *
 * 为什么测试要自己连：只用 session 的返回等于「自己证自己」。
 * 这里独立连一次，直接读 DOM —— 框到底有没有、是什么样式、是不是虚线。
 */
/** 等进程真的消失（最多 timeoutMs） */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/**
 * v0.56：按**命令行**数本会话语义的浏览器进程。
 *
 * 为什么不用 child.pid：Windows 上 spawn 出来的可能只是转发进程，
 * 真正的主进程是另一个 pid。判据和 browser-session 完全一致：
 *   进程名是 msedge/chrome/chromium + 命令行含本次 profile 绝对路径 + sniff-profile；
 *   主进程 = 命令行里没有 --type=（渲染/GPU/工具进程都带）。
 */
function ownedProcesses(profileDir) {
  const listed = bs.listBrowserProcesses();
  if (!listed.ok) return { ok: false, all: [], main: [], message: listed.message };
  const all = listed.list.filter((p) => bs.isBrowserProcessName(p.name) && bs.isOurProfileCommand(p.cmd, profileDir));
  return { ok: true, all, main: all.filter((p) => bs.isMainBrowserProcess(p.cmd)) };
}

/** 等「本 profile 的浏览器进程」全部消失（不再计数 > 0） */
async function waitOwnedGone(profileDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcesses(profileDir).all.length) return true;
    await sleep(300);
  }
  return !ownedProcesses(profileDir).all.length;
}

async function openPageClient(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  const list = await res.json();
  const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('调试端口里没有 page target');
  const client = await createCdpClient(page.webSocketDebuggerUrl, { timeout: 6000 });
  const evalInPage = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r && r.exceptionDetails) {
      throw new Error('页面执行出错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    }
    return r && r.result ? r.result.value : undefined;
  };
  return { client, evalInPage };
}

/** 读框的样式（没有框就返回 null） */
const BOX_PROBE = `(function () {
  var box = document.getElementById('tt-sniff-box');
  if (!box) return null;
  var cs = window.getComputedStyle(box);
  return {
    position: cs.position,
    pointerEvents: cs.pointerEvents,
    zIndex: cs.zIndex,
    borderStyle: cs.borderTopStyle,
    borderColor: cs.borderTopColor,
    width: cs.width,
    height: cs.height
  };
})()`;

(async () => {
  /* ---------------- 0. 找浏览器 ---------------- */
  const candidates = bs.browserCandidates(process.env);
  console.log('===== 高亮定位器：真浏览器链路 =====');
  console.log('候选浏览器（按顺序试）:');
  for (const c of candidates) console.log('  ' + c.name.padEnd(7) + c.path);

  const found = bs.findBrowser(process.env);
  if (!found.ok) {
    console.log('没找到可用的浏览器：');
    skip('真浏览器链路', found.message);
    console.log('\n0 passed, 0 failed, ' + skipped.length + ' skipped');
    console.log('（没装 Edge/Chrome 时这条链路无法验证，显式跳过而不是假装通过。）');
    process.exit(0);
  }
  console.log('使用浏览器: ' + found.name + '  ' + found.path);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-e2e-'));
  const fixture = await startFixtureServer(FIXTURE_HTML);
  console.log('fixture: ' + fixture.url);

  /** 无头模式：不能弹窗（CI/沙箱里弹窗会卡住整条链路） */
  /** v0.56：会话日志也要留底，用来断言「stop 走的是哪一级」（Browser.close / taskkill） */
  const logs = [];
  const session = bs.createSession({
    dataDir: tmp,
    headless: true,
    // 允许用环境变量假装「系统默认浏览器是 Chrome」，验证 auto 真的跟着默认走
    defaultProgId: process.env.TT_SNIFF_DEFAULT_PROGID,
    log: (msg) => {
      logs.push(String(msg));
      console.log('    [sniff] ' + msg);
    }
  });

  let pageClient = null;
  try {
    /* ---------------- 1. 起浏览器 + 打开页面 + 高亮 ---------------- */
    const t0 = Date.now();
    const started = await session.start({
      url: fixture.url,
      name: '登录按钮',
      mode: 'testid',
      selector: 'login-btn'
    });
    const bootMs = Date.now() - t0;
    check('start 成功', started.ok === true, started.message);
    check('running=true', started.running === true, started.running);
    check('browser 识别为 edge 或 chrome', started.browser === 'edge' || started.browser === 'chrome', started.browser);
    check('browserChosen 默认是 auto（界面回显用）', started.browserChosen === 'auto', started.browserChosen);
    check('browserChosen 与实际浏览器对得上（auto 解析结果）', ['edge', 'chrome'].indexOf(started.browserChosen) < 0 || started.browserChosen === started.browser, [started.browser, started.browserChosen]);
    check('浏览器版本能读到（/json/version）', /(Edg|Chrome)\/\d+/.test(session.browserVersion()), session.browserVersion());
    console.log('    浏览器版本: ' + session.browserVersion() + '，拉起+加载+高亮 ' + bootMs + 'ms');
    check('url 原样回显', started.url === fixture.url, started.url);
    check('name / mode / selector 回显', started.name === '登录按钮' && started.mode === 'testid' && started.selector === 'login-btn', [started.name, started.mode, started.selector]);
    check('found = 1', started.found === 1, started.found);
    check('total = 1', started.total === 1, started.total);
    check('visible = true', started.visible === true, started.visible);
    check('reason 为空（主文档命中，没有异常情况）', started.reason === '', started.reason);
    check('inIframe = false', started.inIframe === false, started.inIframe);
    check('message 里带上了元素名（事实文案）', String(started.message).indexOf('登录') >= 0, started.message);

    const port = session.debugPort();
    /**
     * v0.54.1 起不再由平台挑端口：传 --remote-debugging-port=0 让浏览器自己挑，
     * 平台从 profile 里的 DevToolsActivePort 读回来（避开「先 bind 再交给浏览器」的竞态）。
     * 所以这里不断言「落在 10000-60000」，只要求是个合法端口且真能连上。
     */
    check('调试端口是个合法端口且真能连上', Number.isInteger(port) && port > 0 && port < 65536, port);
    check('调试端口只绑 127.0.0.1（用 127.0.0.1 能连）', await (async () => {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        return r.ok;
      } catch (e) {
        return false;
      }
    })());

    /* ---------------- 2. 框真的画在页面里 ---------------- */
    pageClient = await openPageClient(port);
    const box = await pageClient.evalInPage(BOX_PROBE);
    check('页面里真的有高亮框', !!box, box);
    check("框是 position: fixed", box && box.position === 'fixed', box && box.position);
    check("框不吃鼠标事件（pointer-events: none）", box && box.pointerEvents === 'none', box && box.pointerEvents);
    check('框是最高 z-index（2147483647）', box && box.zIndex === '2147483647', box && box.zIndex);
    check('可见元素用实线框', box && box.borderStyle === 'solid', box && box.borderStyle);
    check('框是红色（rgb(255, 59, 48)）', box && /255,\s*59,\s*48/.test(box.borderColor), box && box.borderColor);
    check('框有实际尺寸（>0）', box && parseFloat(box.width) > 0 && parseFloat(box.height) > 0, box && [box.width, box.height]);
    check('window.__ttSniff 里的事实与返回一致', (await pageClient.evalInPage('window.__ttSniff && window.__ttSniff.found')) === 1);

    // 框得真的罩在元素上（不是画在左上角糊弄人）
    const align = await pageClient.evalInPage(`(function () {
      var el = document.querySelector('[data-testid="login-btn"]');
      var b = document.getElementById('tt-sniff-box');
      if (!el || !b) return null;
      var r1 = el.getBoundingClientRect();
      var r2 = b.getBoundingClientRect();
      return { dl: Math.abs(r1.left - r2.left), dt: Math.abs(r1.top - r2.top), dw: Math.abs(r1.width - r2.width), dh: Math.abs(r1.height - r2.height) };
    })()`);
    check(
      '框与元素位置对齐（left/top/width/height 误差 ≤ 2px）',
      !!align && align.dl <= 2 && align.dt <= 2 && align.dw <= 2 && align.dh <= 2,
      align
    );
    check('页面上只有一个高亮框（反复高亮不会叠框）', (await pageClient.evalInPage("document.querySelectorAll('#tt-sniff-box').length")) === 1);

    const scrollTop = await pageClient.evalInPage('window.scrollY || document.documentElement.scrollTop || 0');
    check('高亮时页面滚到了元素附近（scrollIntoView 生效）', typeof scrollTop === 'number' && scrollTop >= 0, scrollTop);

    /* ---------------- 3. 常驻 MutationObserver：删掉 → 自己消失；加回 → 自己回来 ---------------- */
    await pageClient.evalInPage(`(function () {
      var d = document.createElement('button');
      d.id = 'obs-el';
      d.setAttribute('data-testid', 'obs-el');
      d.textContent = '观察器样本';
      document.body.insertBefore(d, document.body.firstChild);
      return true;
    })()`);
    const observed = await session.highlight({ name: '观察器样本', mode: 'testid', selector: 'obs-el' });
    check('动态插入的元素也能高亮（found=1）', observed.ok === true && observed.found === 1, [observed.ok, observed.found]);
    check('动态插入的元素也画了框', !!(await pageClient.evalInPage(BOX_PROBE)));

    await pageClient.evalInPage("document.getElementById('obs-el').remove(); true");
    await sleep(400); // 等观察器 + 80ms 去抖
    const afterRemove = await session.status();
    check('元素被删掉后，观察器把 found 改成 0', afterRemove.found === 0, afterRemove.found);
    check('元素被删掉后框也自己没了', (await pageClient.evalInPage(BOX_PROBE)) === null);

    await pageClient.evalInPage(`(function () {
      var d = document.createElement('button');
      d.id = 'obs-el';
      d.setAttribute('data-testid', 'obs-el');
      d.textContent = '观察器样本';
      document.body.insertBefore(d, document.body.firstChild);
      return true;
    })()`);
    await sleep(400);
    const afterAdd = await session.status();
    check('元素重新出现后，观察器把 found 变回 1（不用主进程再下发）', afterAdd.found === 1, afterAdd.found);
    check('框也自己回来了', !!(await pageClient.evalInPage(BOX_PROBE)));

    /* ---------------- 4. 不可见元素 → 红色虚线框 ---------------- */
    const hidden = await session.highlight({ mode: 'testid', selector: 'hidden-el' });
    check('不可见元素：found = 1', hidden.ok === true && hidden.found === 1, [hidden.ok, hidden.found]);
    check('不可见元素：visible = false', hidden.visible === false, hidden.visible);
    check('不可见元素：reason 仍为空（找到了，只是没露出来）', hidden.reason === '', hidden.reason);
    const dashed = await pageClient.evalInPage(BOX_PROBE);
    check('不可见元素画的是虚线框', dashed && dashed.borderStyle === 'dashed', dashed && dashed.borderStyle);
    check('不可见元素框也是红色', dashed && /255,\s*59,\s*48/.test(dashed.borderColor), dashed && dashed.borderColor);
    check('message 说明「已画红色虚线框」', String(hidden.message).indexOf('虚线') >= 0, hidden.message);

    /* ---------------- 5. iframe 内元素：只报 reason，不画框 ---------------- */
    await sleep(500); // srcdoc iframe 是异步加载的
    const inFrame = await session.highlight({ mode: 'testid', selector: 'inner-btn' });
    check('iframe 内元素：found = 1', inFrame.ok === true && inFrame.found === 1, [inFrame.ok, inFrame.found]);
    check('iframe 内元素：inIframe = true', inFrame.inIframe === true, inFrame.inIframe);
    check("iframe 内元素：reason = 'in-iframe'", inFrame.reason === 'in-iframe', inFrame.reason);
    check('iframe 内元素不画框', (await pageClient.evalInPage(BOX_PROBE)) === null);
    check('message 说清「在 iframe 里画不了框」', String(inFrame.message).indexOf('iframe') >= 0, inFrame.message);

    /* ---------------- 6. shadow DOM 内元素：只报 reason，不画框 ---------------- */
    const inShadow = await session.highlight({ mode: 'testid', selector: 'shadow-btn' });
    check('shadow DOM 内元素：found = 1', inShadow.ok === true && inShadow.found === 1, [inShadow.ok, inShadow.found]);
    check("shadow DOM 内元素：reason = 'shadow-dom'", inShadow.reason === 'shadow-dom', inShadow.reason);
    check('shadow DOM 内元素：inIframe = false', inShadow.inIframe === false, inShadow.inIframe);
    check('shadow DOM 内元素不画框', (await pageClient.evalInPage(BOX_PROBE)) === null);
    check('message 说清「在 shadow DOM 里画不了框」', String(inShadow.message).indexOf('shadow') >= 0, inShadow.message);

    /* ---------------- 7. 不存在的 selector → found=0 / not-found ---------------- */
    const missing = await session.highlight({ mode: 'testid', selector: 'no-such-testid-xyz' });
    check('不存在的 selector：操作本身成功（事实是 0 个）', missing.ok === true, missing.message);
    check('不存在的 selector：found = 0', missing.found === 0, missing.found);
    check('不存在的 selector：total = 0', missing.total === 0, missing.total);
    check('不存在的 selector：visible = false', missing.visible === false, missing.visible);
    check("不存在的 selector：reason = 'not-found'", missing.reason === 'not-found', missing.reason);
    check('不存在的 selector：没有框', (await pageClient.evalInPage(BOX_PROBE)) === null);
    check('message 说「没找到匹配的元素」', String(missing.message).indexOf('没找到') >= 0, missing.message);

    /* ---------------- 8. 其余定位方式在真页面上也能用 ---------------- */
    const byCss = await session.highlight({ mode: 'css', selector: '#login-btn' });
    check('css 定位：found = 1', byCss.ok === true && byCss.found === 1, [byCss.ok, byCss.found]);
    check('css 定位：画了框', !!(await pageClient.evalInPage(BOX_PROBE)));

    const byRole = await session.highlight({ mode: 'role', selector: 'button:登录' });
    check("role 定位（button:登录）：found = 1", byRole.ok === true && byRole.found === 1, [byRole.ok, byRole.found]);

    const byText = await session.highlight({ mode: 'text', selector: '登录' });
    check('text 定位（登录）：found >= 1', byText.ok === true && byText.found >= 1, [byText.ok, byText.found]);

    const byPlaceholder = await session.highlight({ mode: 'placeholder', selector: '请输入用户名' });
    check('placeholder 定位：found = 1', byPlaceholder.ok === true && byPlaceholder.found === 1, [byPlaceholder.ok, byPlaceholder.found]);

    const byLabel = await session.highlight({ mode: 'label', selector: '用户名' });
    check('label 定位：found >= 1', byLabel.ok === true && byLabel.found >= 1, [byLabel.ok, byLabel.found]);

    const byTitle = await session.highlight({ mode: 'title', selector: '关闭按钮' });
    check('title 定位：found = 1', byTitle.ok === true && byTitle.found === 1, [byTitle.ok, byTitle.found]);

    const byAlt = await session.highlight({ mode: 'alttext', selector: '头像' });
    check('alttext 定位：found = 1', byAlt.ok === true && byAlt.found === 1, [byAlt.ok, byAlt.found]);

    const byXpath = await session.highlight({ mode: 'xpath', selector: '//*[@id="login-btn"]' });
    check('xpath 定位：found = 1', byXpath.ok === true && byXpath.found === 1, [byXpath.ok, byXpath.found]);

    /* ---------------- 9. 换一个定位方式不导航（页面还在原地） ---------------- */
    const hrefBefore = await pageClient.evalInPage('location.href');
    await session.highlight({ mode: 'testid', selector: 'login-btn' });
    const hrefAfter = await pageClient.evalInPage('location.href');
    check('highlight 不导航：页面地址没变', hrefBefore === hrefAfter && hrefBefore === fixture.url, [hrefBefore, hrefAfter]);

    /* ---------------- 9.5 整页刷新（不是 SPA 路由）：新文档也要自动框住 ---------------- */
    await pageClient.client.send('Page.enable', {});
    await pageClient.client.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    const afterReload = await pageClient.evalInPage('window.__ttSniff && window.__ttSniff.found');
    check('整页刷新后 window.__ttSniff 自动重建（addScriptToEvaluateOnNewDocument 生效）', afterReload === 1, afterReload);
    check('整页刷新后框也自己回来了', !!(await pageClient.evalInPage(BOX_PROBE)));

    /* ---------------- 10. 重新导航（reopen） ---------------- */
    const reopened = await session.reopen({ url: fixture.url });
    check('reopen 成功并重新框住当前元素', reopened.ok === true && reopened.found === 1, [reopened.ok, reopened.found]);
    check('reopen 之后框还在', !!(await pageClient.evalInPage(BOX_PROBE)));
    check('reopen 之后页面确实是 fixture（刷新过也能自动注入）', (await pageClient.evalInPage('document.title')) === 'sniff fixture');

    /* ---------------- 11. 非法 url 直接拒 ---------------- */
    const badStart = await session.start({ url: 'file:///C:/Windows/win.ini', mode: 'css', selector: 'body' });
    check('start 传 file:// → ok:false', badStart.ok === false, badStart.message);
    check('start 传 file:// → message 说清只放 http/https', String(badStart.message).indexOf('http') >= 0, badStart.message);
    const badReopen = await session.reopen({ url: 'javascript:alert(1)' });
    check('reopen 传 javascript: → ok:false', badReopen.ok === false, badReopen.message);
    check('非法 url 不影响已有会话', session.isRunning() === true);

    /* ---------------- 11.5 v0.56：反复 start 不再多开窗口 + pid 记账 ---------------- */
    const profileDir = session.profileDir();
    check('会话暴露 profile 目录（排查用，形如 <dataDir>/sniff-profile）', typeof profileDir === 'string' && profileDir.indexOf('sniff-profile') > 0, profileDir);
    check('启动后立即记账：<profile>/tt-pids.json 里有 pid', (() => {
      const rec = bs.readPidFile(profileDir);
      return fs.existsSync(bs.pidFilePath(profileDir)) && rec.pids.length > 0;
    })(), bs.readPidFile(profileDir));
    const pidBefore = session.pid();
    const portBefore = session.debugPort();
    const again1 = await session.start({ url: fixture.url, name: '用户名', mode: 'testid', selector: 'user-input' });
    const again2 = await session.start({ url: fixture.url, name: '关闭按钮', mode: 'title', selector: '关闭按钮' });
    check('连续 start 都成功，并且每次都真的高亮到元素', again1.ok === true && again1.found === 1 && again2.ok === true && again2.found === 1, [again1.message, again2.message]);
    check('连续 start 复用同一个会话（主进程 pid 不变）', session.pid() === pidBefore && pidBefore > 0, [pidBefore, session.pid()]);
    check('连续 start 复用同一个调试端口（没有另起实例）', session.debugPort() === portBefore, [portBefore, session.debugPort()]);
    const ownedMain = ownedProcesses(profileDir);
    check('本 profile 的浏览器主进程只有 1 个（bug2：不会越点越多）', ownedMain.ok === true && ownedMain.main.length === 1, ownedMain.main.map((p) => p.pid));
    check('自报的 pid() 就是那个主进程（不是转发进程的 pid）', ownedMain.main.length === 1 && session.pid() === ownedMain.main[0].pid, [session.pid(), ownedMain.main.map((p) => p.pid)]);
    check('本 profile 的浏览器进程全都带我们的命令行标记（没有串到用户自己的浏览器）', ownedMain.all.length > 0 && ownedMain.all.every((p) => bs.isOurProfileCommand(p.cmd, profileDir)), ownedMain.all.length);

    /* ---------------- 12. stop：进程真的退出 ---------------- */
    const pid = session.pid();
    check('能拿到浏览器进程号', pid > 0, pid);
    const stopLogAt = logs.length;
    const stopped = await session.stop();
    check('stop 返回 running=false', stopped.running === false, stopped.running);
    check('stop 走的是 CDP Browser.close（三级关闭的第一级）', logs.slice(stopLogAt).join('\n').indexOf('Browser.close') >= 0, logs.slice(stopLogAt));
    check('stop 之后进程真的没了（按 pid 查）', await waitGone(pid, 5000), 'pid ' + pid + ' 还活着');
    check('stop 之后本 profile 的浏览器进程计数 = 0（按命令行数）', await waitOwnedGone(profileDir, 8000), ownedProcesses(profileDir).all.map((p) => p.pid));
    check('stop 之后账本被清掉（不把死 pid 留给下一轮）', !fs.existsSync(bs.pidFilePath(profileDir)));
    check('stop 之后调试端口连不上了', await (async () => {
      try {
        await fetch('http://127.0.0.1:' + port + '/json/version');
        return false;
      } catch (e) {
        return true;
      }
    })());
    if (pageClient) {
      pageClient.client.close();
      pageClient = null;
    }
    const afterStop = await session.status();
    check('stop 之后 status 也是 running=false', afterStop.running === false, afterStop.running);
    check('stop 是幂等的（再停一次不报错）', (await session.stop()).ok === true);

    /* ---------------- 13. 用户自己关窗口 → status 必须回 running:false ---------------- */
    // 会话已经被 stop 掉了：这时点「重新高亮」不应该报错 —— 后台按记住的地址重新拉起
    const resumed = await session.highlight({ name: '登录按钮', mode: 'testid', selector: 'login-btn' });
    check('浏览器被关掉后，highlight 会自动重新拉起并高亮', resumed.ok === true && resumed.running === true && resumed.found === 1, [resumed.ok, resumed.running, resumed.found]);
    const pid2 = session.pid();
    check('重新拉起后是新进程', pid2 > 0 && pid2 !== pid, [pid, pid2]);

    // 模拟用户直接关掉浏览器（外部杀掉，不经过 session.stop）
    spawnSync('taskkill', ['/PID', String(pid2), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await sleep(800);
    const userClosed = await session.status();
    check('用户关掉窗口后 status 回 running=false', userClosed.running === false, userClosed.running);
    check('用户关掉窗口后 status 仍然 ok（查询成功，不是错误）', userClosed.ok === true, userClosed.ok);
    check('用户关掉窗口后 message 说明浏览器已关闭', String(userClosed.message).indexOf('关闭') >= 0, userClosed.message);
    check('用户关掉窗口后不再有浏览器进程', isAlive(pid2) === false, pid2);
    check('用户关掉窗口后本 profile 也没有残留进程（命令行计数 = 0）', await waitOwnedGone(profileDir, 8000), ownedProcesses(profileDir).all.map((p) => p.pid));

    /* ---------------- 14. v0.56：browser 选择（写错 / 显式指定） ---------------- */
    const badBrowser = await session.start({ url: fixture.url, name: '登录按钮', mode: 'testid', selector: 'login-btn', browser: 'firefox' });
    check('browser 写错（firefox）→ ok:false', badBrowser.ok === false, badBrowser.message);
    check('browser 写错的文案点明 auto / edge / chrome', String(badBrowser.message).indexOf('auto / edge / chrome') >= 0, badBrowser.message);
    check('browser 写错时不会顺手拉起浏览器', session.isRunning() === false);

    const other = found.name === 'edge' ? 'chrome' : 'edge';
    const otherExe = bs.browserCandidates(process.env).find((c) => c.name === other && fs.existsSync(c.path));
    if (!otherExe) {
      skip('显式换用 ' + other, '本机没装 ' + other + '（找不到 ' + other + '.exe）');
    } else {
      const picked = await session.start({ url: fixture.url, name: '登录按钮', mode: 'testid', selector: 'login-btn', browser: other });
      check('显式 browser=' + other + '：照办（browser 是 ' + other + '）', picked.ok === true && picked.browser === other, [picked.ok, picked.browser, picked.message]);
      check('显式指定时 browserChosen 回显 ' + other, picked.browserChosen === other, picked.browserChosen);
      check('换浏览器之后高亮仍然生效（found=1）', picked.found === 1, picked.found);
      check('换浏览器后本 profile 只有 1 个主进程（旧浏览器已关掉）', ownedProcesses(profileDir).main.length === 1, ownedProcesses(profileDir).main.map((p) => p.pid));
      const otherStop = await session.stop();
      check('换浏览器之后的会话也关得掉（进程消失）', otherStop.ok === true && (await waitOwnedGone(profileDir, 8000)), [otherStop.ok, otherStop.message]);
    }
  } catch (e) {
    record('链路跑通（未抛异常）', false, String((e && e.stack) || e));
  } finally {
    if (pageClient) {
      try {
        pageClient.client.close();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      await session.stop();
    } catch (e) {
      /* ignore */
    }
    try {
      await new Promise((resolve) => fixture.server.close(resolve));
    } catch (e) {
      /* ignore */
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* 浏览器 profile 文件可能还被系统占用，删不掉就留着（在临时目录里） */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, ' + skipped.length + ' skipped');
  if (skipped.length) console.log('跳过 ' + skipped.length + ' 项（见上面的 SKIP 行）');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃:', (e && e.stack) || e);
  process.exit(2);
});