'use strict';
/**
 * GUI 冒烟套件（P1-4）：用浏览器预览产物 + playwright-core 驱动本机 chromium，
 * 把「19 个路由都能打开、控制台不报错、关键交互能用」变成一条可自动跑的命令。
 *
 * 为什么走预览而不是 Electron GUI：
 *   沙箱里起不了 Electron 窗口（120 秒超时），而 `dist/preview` 是同一份 React 代码
 *   加一层内存 mock（`src/mockApi.ts`），路由、组件、antd 交互完全一致。
 *   所以 GUI 层能自动化的那部分全部挂在这里，真·桌面外壳交给 asar/打包链路验证。
 *
 * 零新增依赖、零联网：
 *   · playwright-core 已在 devDependencies
 *   · chromium 用本机 ms-playwright 缓存里的（找不到就**失败并说清怎么装**，绝不偷偷下载）
 *   · 静态服务用 node 内置 http（照 _scratch/2026-10-28/serve.mjs 的写法）
 *
 * 产物不在会自动构建一次（`node scripts/build.mjs -- --preview`），换台干净机器也能直接跑。
 *
 * 用法：
 *   node scripts/test-gui-smoke.cjs                 # 建议由 run-unit 当普通套件跑
 *   $env:CHROME_PATH="D:\...\chrome.exe"; node scripts/test-gui-smoke.cjs   # 指定浏览器
 *
 * 退出码：0 全通过 / 1 有失败（包括「预览产物构建失败」「找不到 chromium」）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIX_DIR = path.join(ROOT, 'dist', 'preview');
const HTML = 'preview.html';

const results = [];
const consoleErrors = []; // 全局：任何时刻的 console error
const pageErrors = []; // 全局：任何未捕获异常
let currentStep = '启动';
/** 只放过这一条噪声：浏览器自动请求 favicon 的 404 */
const IGNORED_CONSOLE = /Failed to load resource[\s\S]*favicon\.ico/;
const ignoredConsole = [];

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? '' : String(detail || '') });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : detail ? '  -> ' + detail : ''));
  return !!ok;
}
function pass(name) {
  return record(name, true);
}
function fail(name, detail) {
  return record(name, false, detail);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 期望的路由表：从 shared/collections.js 推导，不在脚本里写死 19 这个数  */
/* ------------------------------------------------------------------ */
function expectedRoutes() {
  const { COLLECTIONS, TOOLS } = require(path.join(ROOT, 'shared', 'collections.js'));
  const assets = COLLECTIONS.filter((c) => c.group === '资产').map((c) => c.name);
  const auto = TOOLS.filter((t) => t.group === '自动化').map((t) => t.name);
  const misc = TOOLS.filter((t) => t.group === '辅助').map((t) => t.name);
  /* 分组顺序 = Sidebar.tsx 里的 groups 顺序；每组的项也要逐个对，不能只对组名 */
  const groups = [
    { label: '资产', items: assets.concat(['回收站']) },
    { label: '索引', items: ['测试用例', '压测脚本', '知识库', '测试笔记'] },
    { label: '自动化', items: auto },
    { label: '辅助', items: misc }
  ];
  return { groups, names: groups.reduce((acc, g) => acc.concat(g.items), []) };
}

/* ------------------------------------------------------------------ */
/* 预览产物：不在**或已过期**就构建一次（不许静默跳过）                  */
/* ------------------------------------------------------------------ */

/**
 * 递归取一个目录里最新的文件修改时间。
 *
 * v0.70 加的：这里原来只判断「产物存不存在」，不看新旧 ——
 * 于是改了 src/ 或 shared/ 但没重建 preview 时，GUI 冒烟会拿**旧产物**去跑，
 * 结果是假红（源码已改、断言跟着改，产物还是老的）甚至假绿（新代码有 bug 但旧产物能过）。
 * 实测踩到过一次：交换侧栏两项后，测试期望是新顺序、实际读到旧产物，报「第 3 项期望测试执行，实际接口记录」。
 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'assets') continue;
        walk(full);
      } else {
        try {
          const t = fs.statSync(full).mtimeMs;
          if (t > newest) newest = t;
        } catch (e2) {
          /* 读不到就算了，不影响判断 */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

function ensurePreviewBuild() {
  const js = path.join(FIX_DIR, 'preview.js');
  const html = path.join(FIX_DIR, HTML);
  const exists = fs.existsSync(js) && fs.existsSync(html);

  let stale = false;
  if (exists) {
    // 产物时间 vs 源码时间：源码更新过就重建
    const builtAt = Math.min(fs.statSync(js).mtimeMs, fs.statSync(html).mtimeMs);
    const srcAt = Math.max(
      newestMtime(path.join(ROOT, 'src')),
      newestMtime(path.join(ROOT, 'shared')),
      fs.existsSync(path.join(ROOT, 'src', 'styles.css'))
        ? fs.statSync(path.join(ROOT, 'src', 'styles.css')).mtimeMs
        : 0
    );
    stale = srcAt > builtAt;
    if (stale) console.log('  [build] 源码比 dist/preview 新，先重建（避免拿旧产物测出假结果）…');
  }

  if (exists && !stale) return true;
  if (!exists) console.log('  [build] dist/preview 不完整，先跑一次 preview 构建…');

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--', '--preview'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (r.stdout) console.log(r.stdout.trim());
  if (r.status !== 0) {
    console.log(r.stderr || '');
    return '预览构建失败（exit=' + r.status + '）：先手工跑 node scripts/build.mjs -- --preview 看报错';
  }
  if (!fs.existsSync(js)) return '预览构建跑完了但没有 dist/preview/preview.js';
  return true;
}

/* ------------------------------------------------------------------ */
/* 浏览器：优先 CHROME_PATH，其次本机 ms-playwright 缓存（零联网）        */
/* ------------------------------------------------------------------ */
function findChromium() {
  const tried = [];
  const ok = (p) => p && fs.existsSync(p);
  if (process.env.CHROME_PATH) {
    tried.push('CHROME_PATH=' + process.env.CHROME_PATH);
    if (ok(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  }
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(base)) {
    tried.push('ms-playwright 缓存目录不存在：' + base);
    return { error: '找不到 chromium。' + tried.join('；') + '。装法：npx playwright install chromium（或设 CHROME_PATH 指向 chrome.exe）' };
  }
  const dirs = fs
    .readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(base, d, sub, 'chrome.exe');
      if (ok(p)) return p;
    }
    tried.push(base + '\\' + d + '\\chrome-win64\\chrome.exe');
  }
  return {
    error:
      '找不到 chromium 可执行文件（' +
      (dirs.length ? '缓存里只有 ' + dirs.join('、') + '，但里面没有 chrome.exe' : '缓存里没有任何 chromium-*') +
      '）。装法：npx playwright install chromium（或设 CHROME_PATH 指向 chrome.exe）'
  };
}

/* ------------------------------------------------------------------ */
/* 静态服务（照 _scratch/2026-10-28/serve.mjs）                          */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function startServer(root) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? HTML : urlPath.replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (!file.toLowerCase().startsWith(root.toLowerCase())) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* 页面小工具                                                          */
/* ------------------------------------------------------------------ */
/** 侧栏点一项（等它变成 active） */
async function clickNav(page, name) {
  await page.click('.nav-item:has(.nav-name:text-is("' + name + '"))', { timeout: 8000 });
}

/** 关掉所有可见的 antd 弹窗（首次引导、各种抽屉弹框）。返回关掉几个 */
async function dismissModals(page) {
  let closed = 0;
  for (let i = 0; i < 3; i++) {
    const opened = await page.locator('.ant-modal-wrap:visible').count();
    if (!opened) break;
    const closer = page.locator('.ant-modal-wrap:visible .ant-modal-close').last();
    if (await closer.count()) {
      await closer.click({ timeout: 3000 }).catch(() => {});
    } else {
      const primary = page.locator('.ant-modal-wrap:visible .ant-modal-footer .ant-btn-primary').last();
      if (await primary.count()) await primary.click({ timeout: 3000 }).catch(() => {});
    }
    await sleep(250);
    closed++;
  }
  return closed;
}

function textsOf(page, selector) {
  return page.$$eval(selector, (els) => els.map((e) => (e.textContent || '').trim()));
}

/**
 * 可见弹窗数量。
 * 注意：`:visible` 是 Playwright 的伪类，**在 page.evaluate 里的 querySelectorAll 会直接报语法错**，
 * 所以页面内必须自己做可见性判断（antd 关掉的弹窗是 display:none，但节点还留在 DOM 里）。
 */
function visibleModalCount(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => {
        const st = getComputedStyle(w);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = w.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length
  );
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */
async function main() {
  console.log('===== GUI 冒烟（浏览器预览 + playwright-core）=====');

  /* ---------- 0. 准备：产物 / 浏览器 ---------- */
  currentStep = '准备预览产物与浏览器';
  const built = ensurePreviewBuild();
  if (built !== true) {
    fail('预览产物可用（dist/preview）', built);
    return;
  }
  pass('预览产物可用（dist/preview）');

  const chrome = findChromium();
  if (typeof chrome !== 'string') {
    fail('找得到本机 chromium', chrome.error);
    return;
  }
  console.log('  chromium: ' + chrome);
  pass('找得到本机 chromium（零联网，不用 playwright install）');

  let chromium;
  try {
    ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core')));
  } catch (e) {
    fail('playwright-core 已在 devDependencies', e.message);
    return;
  }
  pass('playwright-core 已安装（无新增依赖）');

  const { server, port } = await startServer(FIX_DIR);
  const url = 'http://127.0.0.1:' + port + '/' + HTML;
  console.log('  静态服务: ' + url + '  root=' + FIX_DIR);

  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (IGNORED_CONSOLE.test(text)) {
      ignoredConsole.push(text.slice(0, 120));
      return;
    }
    consoleErrors.push('[' + currentStep + '] ' + text.slice(0, 200));
  });
  page.on('pageerror', (e) => {
    pageErrors.push('[' + currentStep + '] ' + String(e).slice(0, 200));
  });

  try {
    const expected = expectedRoutes();

    /* ---------- 1. 启动 + 侧栅导航 ---------- */
    currentStep = '启动预览页';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await sleep(700);
    pass('预览页能启动，侧栅渲染出 nav-item');

    currentStep = '侧栅导航';
    const navNames = await textsOf(page, '.nav-item .nav-name');
    const firstDiff = navNames.findIndex((n, i) => n !== expected.names[i]);
    record(
      '侧栅导航共 ' + expected.names.length + ' 项且顺序与 collections.js 一致',
      navNames.length === expected.names.length && firstDiff < 0,
      navNames.length !== expected.names.length
        ? '数量不对：实际 ' + navNames.length + ' 项（' + navNames.join('、') + '）'
        : '第 ' + (firstDiff + 1) + ' 项期望「' + expected.names[firstDiff] + '」，实际「' + navNames[firstDiff] + '」'
    );
    const groupLabels = await textsOf(page, '.nav-group-label');
    record(
      '侧栅 4 个分组（' + expected.groups.map((g) => g.label).join(' / ') + '）顺序一致',
      groupLabels.join('|') === expected.groups.map((g) => g.label).join('|'),
      groupLabels.join('、')
    );
    /* 每个分组里的项也要逐个对：只对组名会漏掉「项被搬到别的分组」这类回归 */
    const domGroups = await page.$$eval('.nav-group', (els) =>
      els.map((g) => ({
        label: ((g.querySelector('.nav-group-label') || {}).textContent || '').trim(),
        items: [...g.querySelectorAll('.nav-name')].map((e) => (e.textContent || '').trim())
      }))
    );
    const groupDiffs = [];
    for (let i = 0; i < Math.max(domGroups.length, expected.groups.length); i++) {
      const want = expected.groups[i];
      const got = domGroups[i];
      if (!want || !got) {
        groupDiffs.push('第 ' + (i + 1) + ' 组：期望 ' + (want ? want.label : '(无)') + ' 实际 ' + (got ? got.label : '(无)'));
        continue;
      }
      if (want.label !== got.label) groupDiffs.push(want.label + ' → ' + got.label);
      if (want.items.join('|') !== got.items.join('|')) {
        groupDiffs.push(want.label + ' 组内容不同：期望 ' + want.items.join('/') + ' 实际 ' + got.items.join('/'));
      }
    }
    record('每个分组里的导航项都符合预期（共 ' + expected.names.length + ' 项）', groupDiffs.length === 0, groupDiffs.join('；'));

    /* ---------- 2. 引导弹窗：出现 → 知道了 → 消失 ---------- */
    currentStep = '引导弹窗';
    await page.evaluate(() => localStorage.removeItem('runner-guide-seen'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav-item', { timeout: 20000 });
    await sleep(700);
    await clickNav(page, '代码调试');
    await page.waitForSelector('.ant-modal-wrap:visible', { timeout: 8000 }).catch(() => {});
    await sleep(300);
    const guideTitles = await textsOf(page, '.ant-modal-wrap:visible .ant-modal-title');
    const guideVisible = await page.locator('.ant-modal-wrap:visible').count();
    record('首次进「代码调试」弹出引导弹窗（先配置开发环境）', guideVisible > 0 && guideTitles.indexOf('先配置开发环境') >= 0, guideTitles.join('、'));

    const knowBtn = page.locator('.ant-modal-wrap:visible .ant-modal-footer .ant-btn-primary');
    record('引导弹窗有「知道了」按钮', (await knowBtn.count()) > 0, 'footer 主按钮不见了');
    if (await knowBtn.count()) await knowBtn.first().click();
    await sleep(600);
    const stillOpen = await page.locator('.ant-modal-wrap:visible').count();
    const guideFlag = await page.evaluate(() => localStorage.getItem('runner-guide-seen'));
    record('点「知道了」后弹窗真的关掉，并记下 runner-guide-seen', stillOpen === 0 && !!guideFlag, 'stillOpen=' + stillOpen + ' flag=' + guideFlag);

    /* ---------- 3. 19 个路由逐个可达 ---------- */
    currentStep = '路由巡检';
    console.log('  --- 路由巡检（' + expected.names.length + ' 个）---');
    const bad = [];
    for (const name of expected.names) {
      currentStep = '路由 ' + name;
      const before = consoleErrors.length + pageErrors.length;
      let active = '';
      let signals = { textLen: 0, controls: 0, boundary: 0 };
      try {
        await clickNav(page, name);
        await sleep(500);
        await dismissModals(page);
        await sleep(200);
        active = await page.$eval('.nav-item.active .nav-name', (e) => (e.textContent || '').trim()).catch(() => '');
        signals = await page.evaluate(() => {
          const main = document.querySelector('.main');
          if (!main) return { textLen: 0, controls: 0, boundary: 0 };
          return {
            textLen: (main.innerText || '').replace(/\s+/g, ' ').trim().length,
            controls: main.querySelectorAll('button, input, textarea, table, [role="row"]').length,
            /* 路由级兜底边界：ErrorBoundary 的兜底节点带 data-scope，普通的 antd Alert 不带 */
            boundary: main.querySelectorAll('[role="alert"][data-scope]').length
          };
        });
      } catch (e) {
        bad.push(name + '（点击失败：' + String(e).slice(0, 80) + '）');
        fail('路由可达：' + name, '点击/渲染失败：' + String(e).slice(0, 120));
        continue;
      }
      const errs = consoleErrors.length + pageErrors.length - before;
      const ok = active === name && signals.boundary === 0 && signals.textLen > 60 && signals.controls > 0 && errs === 0;
      const why = [];
      if (active !== name) why.push('active=' + (active || '(空)'));
      if (signals.boundary) why.push('进了错误兜底 ' + signals.boundary + ' 处');
      if (signals.textLen <= 60) why.push('正文只有 ' + signals.textLen + ' 字');
      if (!signals.controls) why.push('没有任何可交互控件');
      if (errs) why.push('本页新增 ' + errs + ' 条报错');
      record(
        '路由可达：' + name + '（active/正文 ' + signals.textLen + ' 字/控件 ' + signals.controls + '）',
        ok,
        why.join('；')
      );
      if (!ok) bad.push(name);
    }
    record('19 个路由全部可达（应等于侧栅 ' + expected.names.length + ' 项）', bad.length === 0, '有问题的：' + bad.join('、'));

    /* 设置页：脚部按钮，不在 nav-item 里，单独点一次 */
    currentStep = '设置页';
    await page.click('.sidebar-foot button:has-text("设置")', { timeout: 8000 });
    await sleep(700);
    const settingsSig = await page.evaluate(() => {
      const main = document.querySelector('.main');
      return {
        textLen: (main.innerText || '').replace(/\s+/g, ' ').trim().length,
        boundary: main.querySelectorAll('[role="alert"][data-scope]').length,
        has: (main.innerText || '').indexOf('目录配置') >= 0
      };
    });
    record('设置页可达（脚部按钮 → 目录配置可见）', settingsSig.textLen > 60 && settingsSig.boundary === 0 && settingsSig.has, JSON.stringify(settingsSig));
    await dismissModals(page);

    /* ---------- 4. 表格分页 ---------- */
    currentStep = '表格分页';
    /* 预览 mock 每个集合只有几条，先在页面里用 mock API 灌到 60+，分页才会出现 */
    const seeded = await page.evaluate(async () => {
      for (let i = 1; i <= 60; i++) {
        await window.api.saveRecord({
          collection: 'sites',
          data: { name: '分页样本 ' + i, url: 'https://seed.local/' + i, env: ['test'], accounts: [], note: '' },
          tags: [],
          favorite: false
        });
      }
      return (await window.api.records('sites')).length;
    });
    record('预览数据可灌入（sites 现有 ' + seeded + ' 条）', seeded >= 61, '只有 ' + seeded + ' 条');

    await clickNav(page, '网站管理');
    await sleep(800);
    const pg1 = await page.evaluate(() => ({
      rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length,
      pag: document.querySelectorAll('.ant-pagination').length,
      pages: [...document.querySelectorAll('.ant-pagination-item')].map((e) => (e.textContent || '').trim()),
      first: (document.querySelector('.ant-table-tbody tr.ant-table-row td') || {}).innerText || ''
    }));
    record('表格出现分页器且分成 2 页（第 1 页 50 条）', pg1.pag > 0 && pg1.pages.indexOf('2') >= 0 && pg1.rows === 50, JSON.stringify(pg1));

    const p2 = page.locator('.ant-pagination-item-2').first();
    if (await p2.count()) {
      await p2.click();
      await sleep(700);
      const pg2 = await page.evaluate(() => ({
        rows: document.querySelectorAll('.ant-table-tbody tr.ant-table-row').length,
        first: (document.querySelector('.ant-table-tbody tr.ant-table-row td') || {}).innerText || ''
      }));
      record(
        '点第 2 页真的换了一页（' + pg2.rows + ' 条，首行与第 1 页不同）',
        pg2.rows === seeded - 50 && pg2.first !== pg1.first,
        JSON.stringify(pg2) + ' 期望 ' + (seeded - 50) + ' 条'
      );
    } else {
      fail('点第 2 页真的换了一页', '找不到 .ant-pagination-item-2');
    }

    /* ---------- 5. 表单保存 ---------- */
    currentStep = '表单保存';
    const beforeSave = await page.evaluate(async () => (await window.api.records('sites')).length);
    await page.click('.pg-actions button:has-text("新增")', { timeout: 8000 });
    await page.waitForSelector('.ant-modal-wrap:visible', { timeout: 8000 });
    await sleep(400);
    const formTitle = await page.$eval('.ant-modal-wrap:visible .ant-modal-title', (e) => (e.textContent || '').trim()).catch(() => '');
    record('点「新增」打开表单（标题：' + formTitle + '）', formTitle.indexOf('新增') === 0, formTitle);

    const nameInput = page.locator(
      'xpath=//div[contains(@class,"kv-label") and starts-with(normalize-space(.),"名称")]/following-sibling::input[1]'
    );
    const TITLE = '冒烟测试-表单保存-1125';
    await nameInput.fill(TITLE);
    await sleep(150);
    await page.click('.ant-modal-wrap:visible .ant-modal-footer .ant-btn-primary', { timeout: 8000 });
    await sleep(1300);
    const afterSave = await page.evaluate(async () => ({
      msgs: [...document.querySelectorAll('.ant-message-notice-content')].map((e) => (e.innerText || '').trim()),
      total: (await window.api.records('sites')).length,
      rows: [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row td')].map((e) => (e.innerText || '').trim())
    }));
    afterSave.openModals = await visibleModalCount(page);
    record('保存后弹窗关闭', afterSave.openModals === 0, '还有 ' + afterSave.openModals + ' 个弹窗');
    record('保存后提示「已新增」', afterSave.msgs.join('|').indexOf('已新增') >= 0, afterSave.msgs.join('|'));
    record(
      '保存真的落库（' + beforeSave + ' → ' + afterSave.total + '）',
      afterSave.total === beforeSave + 1,
      beforeSave + ' → ' + afterSave.total
    );

    /* ---------- 6. 锁屏解锁 ---------- */
    currentStep = '锁屏解锁';
    await page.click('.sidebar-foot button:has-text("锁定")', { timeout: 8000 });
    await sleep(800);
    const lockShown = await page.locator('.lock-screen').count();
    record('点「锁定」进入锁屏', lockShown === 1, 'lock-screen 有 ' + lockShown + ' 个');
    await page.fill('.lock-screen input', '1234');
    await page.click('.lock-screen button', { timeout: 8000 });
    await sleep(900);
    const afterUnlock = await page.evaluate(() => ({
      lock: document.querySelectorAll('.lock-screen').length,
      sidebar: document.querySelectorAll('.sidebar').length
    }));
    record('输入密码后解锁回到主界面', afterUnlock.lock === 0 && afterUnlock.sidebar === 1, JSON.stringify(afterUnlock));

    /* ---------- 7. 全程 0 报错 ---------- */
    currentStep = '报错汇总';
    record('全程 0 条 console error', consoleErrors.length === 0, consoleErrors.slice(0, 8).join(' | '));
    record('全程 0 条 page error（未捕获异常）', pageErrors.length === 0, pageErrors.slice(0, 8).join(' | '));
    if (ignoredConsole.length) {
      console.log('  （忽略 ' + ignoredConsole.length + ' 条 favicon 404 噪声，不算失败）');
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r)).catch(() => {});
  }
}

/* ================================================================== */
(async () => {
  try {
    await main();
  } catch (e) {
    console.log('');
    console.log('脚本异常：' + ((e && e.stack) || e));
    record('脚本自身跑完没抛异常', false, String((e && e.message) || e));
  }
  const failed = results.filter((r) => !r.ok);
  const total = results.length;
  const passed = total - failed.length;
  console.log('');
  console.log('===== GUI 冒烟汇总 =====');
  if (failed.length) {
    console.log('  失败项：');
    for (const r of failed) console.log('    - ' + r.name + (r.detail ? '  -> ' + r.detail : ''));
  }
  console.log((total ? '' : '（没有任何断言被执行）') + passed + '/' + total + ' passed');
  process.exit(failed.length || !total ? 1 : 0);
})();