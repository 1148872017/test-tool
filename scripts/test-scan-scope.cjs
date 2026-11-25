/* 代码体检：范围选定（v0.46.0）
 *
 * 覆盖四件事：
 *   1. 【Bug】新增接口后「模块范围」下拉不更新 —— 扫描前自动刷 + 手动刷新入口
 *   2. 【优化】范围选定前置 —— 从结果区搬到工具条，扫描前就能设
 *   3. 【优化】页面覆盖也有范围 —— 切到「页面覆盖」按 project 聚合
 *   4. 【优化】范围支持选单个接口/页面 —— codescan:coverage 多认一个 ids
 *
 * 前两类是源码结构断言（位置就是语义：范围在结果区里 = 扫完才出现），
 * 第四类直接 require 真的 ipc-scan.js、用假 store 跑 handler（行为断言，不是正则）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const root = path.join(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(root, 'src', 'pages', 'CodeScanPage.tsx'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const ipcScanSrc = fs.readFileSync(path.join(root, 'electron', 'ipc', 'ipc-scan.js'), 'utf8');

/* ============================================================
 * 一、刷新：扫描前自动刷 + 手动刷（Bug：新增接口后下拉不更新）
 * ============================================================ */
{
  check('doScan 是 async（要先等清单回来再扫）', /const doScan = async \(\) => \{/.test(pageSrc), 'doScan not async');
  check(
    'doScan 覆盖分支里 await loadModules',
    /const doScan = async \(\) => \{[\s\S]{0,300}?await loadModules\(covKind\)/.test(pageSrc),
    'no auto refresh'
  );
  // 顺序：先刷清单，再调 doCoverage —— 反了就等于拿旧清单去筛，等于没修
  const scanSeg = pageSrc.slice(pageSrc.indexOf('const doScan = async'), pageSrc.indexOf('const doScan = async') + 500);
  check(
    '自动刷新在 doCoverage 之前（顺序错了等于没修）',
    scanSeg.indexOf('await loadModules') > 0 && scanSeg.indexOf('await loadModules') < scanSeg.indexOf('await doCoverage'),
    scanSeg.slice(0, 200)
  );
  check('有手动刷新函数 refreshScope', /const refreshScope = async \(\) => \{/.test(pageSrc), 'no refreshScope');
  check('刷新按钮绑在 refreshScope 上', /onClick=\{refreshScope\}/.test(pageSrc), 'no onClick');
  check('刷新按钮有 aria-label（图标按钮要能被读屏念出来）', /aria-label="刷新范围选项"/.test(pageSrc), 'no aria-label');
  check('刷新用 SyncOutlined，和「开始扫描」的 ReloadOutlined 分开', /SyncOutlined/.test(pageSrc) && /ReloadOutlined/.test(pageSrc), 'icon conflated');
  check('手动刷完有 toast 回报', /范围选项已刷新/.test(pageSrc), 'no toast');
  check('清单读取失败不把整页顶成错误（退化成全部）', /setRecords\(Array\.isArray\(res\.records\)/.test(pageSrc), 'no fallback');
}

/* ============================================================
 * 二、前置：范围在工具条（扫描按钮之前），不在结果区
 * ============================================================ */
{
  const scopeIdx = pageSrc.indexOf('className="cov-scope"');
  const mainIdx = pageSrc.indexOf('className="codescan-main"');
  check('有 .cov-scope 范围行', scopeIdx > 0, 'no scope row');
  check('范围行在主内容区之前（工具条区域）', scopeIdx > 0 && mainIdx > scopeIdx, { scopeIdx, mainIdx });
  // 结果区从 .codescan-main 开始：这之后的源码里不许再出现范围控件
  const mainPart = mainIdx > 0 ? pageSrc.slice(mainIdx) : '';
  check('结果区里没有范围控件（不再「扫完才出现」）', mainPart.length > 0 && !/cov-scope/.test(mainPart), 'scope still in result area');
  check('结果区里没有旧的「清除筛选并重扫」按钮', !/清除筛选并重扫/.test(mainPart), 'old button left');

  // 范围和「开始扫描」在同一条工具条里，且按钮在范围控件之后
  const scanBtnIdx = pageSrc.indexOf('开始扫描', scopeIdx);
  check('开始扫描在范围控件之后（先选范围再扫）', scopeIdx > 0 && scanBtnIdx > scopeIdx, { scopeIdx, scanBtnIdx });
  const scopeBlock = pageSrc.slice(scopeIdx, pageSrc.indexOf('{rulesDrawer}'));
  check('范围行里同时有范围下拉和开始扫描', /<Select/.test(scopeBlock) && /开始扫描/.test(scopeBlock), 'not in same bar');
  // 注意用 lastIndexOf：刷新按钮的 Tooltip 里也提到了「开始扫描」（"每次点开始扫描前也会自动刷"），
  // 取最后一次出现的才是真正那个按钮的文案。
  check(
    '范围行内的顺序：范围标签 → 下拉 → 刷新 → 说明 → 开始扫描',
    scopeBlock.indexOf('<Select') > 0 &&
      scopeBlock.indexOf('onClick={refreshScope}') > scopeBlock.indexOf('<Select') &&
      scopeBlock.lastIndexOf('开始扫描') > scopeBlock.indexOf('onClick={refreshScope}'),
    {
      select: scopeBlock.indexOf('<Select'),
      refresh: scopeBlock.indexOf('onClick={refreshScope}'),
      scanBtn: scopeBlock.lastIndexOf('开始扫描')
    }
  );
  // 结果区 rail / 摘要条还在（只搬了范围，没动别的）
  check('摘要条还在结果区', /codescan-statbar/.test(pageSrc), 'no statbar');
}

/* ============================================================
 * 三、页面覆盖也有范围（kind 决定聚合维度 + 文案）
 * ============================================================ */
{
  check('切到页面覆盖按 page 取清单', /const k = t === 'cov-page' \? 'page' : 'api'/.test(pageSrc), 'no kind map');
  check('切 kind 时重取清单', /if \(k !== covKind\) \{[\s\S]{0,200}?loadModules\(k\)/.test(pageSrc), 'no reload on kind change');
  check('标签按 kind 变：接口「模块范围」/ 页面「项目范围」', /covKind === 'page' \? '项目范围' : '模块范围'/.test(pageSrc), 'label not kind-aware');
  check('占位文案按 kind 变', /'项目或单个页面' : '模块或单个接口'/.test(pageSrc), 'placeholder not kind-aware');
  check('记录分组名按 kind 变', /'按单个页面' : '按单个接口'/.test(pageSrc), 'group label not kind-aware');
  check(
    '换 kind 时两种粒度的选中项都清掉',
    /const resetScope = \(\) => \{[\s\S]{0,160}?setPickedModules\(\[\]\)[\s\S]{0,80}?setPickedIds\(\[\]\)/.test(pageSrc),
    'not reset'
  );
}

/* ============================================================
 * 四、单选记录：ids 参数 + 前端接线（静态部分）
 * ============================================================ */
{
  check('IPC 解构里认 ids', /\{ root, kind, modules, ids, ruleIds \} = \{\}/.test(ipcScanSrc), 'no ids param');
  check('ids 与 modules 都传时取并集（scopeMode = mixed）', /'mixed'/.test(ipcScanSrc), 'no mixed mode');
  check('ids 里脏值被过滤（null/空串不算选中）', /\.filter\(Boolean\)/.test(ipcScanSrc), 'no filter');
  check(
    'preload 传 ids 且前四个参数顺序不变',
    /codescanCoverage: \(root, kind, modules, ruleIds, ids\) => invoke\('codescan:coverage', \{ root, kind, modules, ruleIds, ids \}\)/.test(
      preloadSrc
    ),
    'preload args changed'
  );
  check(
    '前端把 pickedIds 作为第 5 个参数传下去',
    /api\.codescanCoverage\(root \|\| undefined, k, pickedModules, covIds, pickedIds\)/.test(pageSrc),
    'frontend not passing ids'
  );
  check('范围下拉用多选 + 两组选项', /mode="multiple"/.test(pageSrc) && /scopeGroupModule/.test(pageSrc) && /scopeGroupRecord/.test(pageSrc), 'not grouped');
  check('modules 通道回 records（不新开通道）', /records\.push\(\{/.test(ipcScanSrc) && /label: recordLabel\(k, d, it\)/.test(ipcScanSrc), 'no records');
  check('没有为此新开 IPC 通道（通道总数不变）', !/codescan:records'/.test(ipcScanSrc), 'new channel added');
}

/* ============================================================
 * 五、行为测试：直接跑真的 ipc-scan.js handler
 * ============================================================ */
const APIS = [
  { id: 'a1', title: '登录', data: { method: 'POST', url: '/api/login', module: '认证' } },
  { id: 'a2', title: '下单', data: { method: 'POST', url: '/api/order', module: '订单' } },
  { id: 'a3', title: '查用户', data: { method: 'GET', url: '/api/user', module: '认证' } },
  { id: 'a4', title: '退款', data: { method: 'POST', url: '/api/refund', module: '订单' } },
  { id: 'a5', title: '探活', data: { method: 'GET', url: '/api/ping' } }
];
const PAGES = [
  { id: 'p1', title: '登录页', data: { url: '/login', project: '销售' } },
  { id: 'p2', title: '订单页', data: { url: '/order', project: '销售' } },
  { id: 'p3', title: '设置页', data: { url: '/setting', project: '后台' } }
];

/* 造一小片「代码」：三条接口调用都能在清单里找到，两条页面跳转同理 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-scope-'));
fs.writeFileSync(
  path.join(tmp, 'ApiCalls.java'),
  ['given().get("/api/login");', 'given().get("/api/order");', 'given().get("/api/user");'].join('\n'),
  'utf8'
);
fs.writeFileSync(path.join(tmp, 'Pages.java'), ['page.navigate("/login");', 'page.navigate("/order");'].join('\n'), 'utf8');

const handlers = {};
const pathChecks = [];
require(path.join(root, 'electron', 'ipc', 'ipc-scan')).register({
  // v0.43.0 起各域统一走 deps.handle 注册（默认带解锁守卫），这里给直通版本
  handle: (channel, fn) => {
    handlers[channel] = fn;
  },
  dialog: {},
  // 假 store：只回两份固定清单，不碰真实数据库
  store: { list: (col) => (col === 'pages' ? PAGES : col === 'apis' ? APIS : []) },
  getWindow: () => null,
  getSettings: () => ({ projectDir: '' }),
  assertUnlocked: () => {},
  assertPathIn: (p) => {
    pathChecks.push(p);
    return null;
  },
  rememberPicked: () => {}
});

const coverage = (payload) => handlers['codescan:coverage']({}, payload);
const modulesOf = (kind) => handlers['codescan:modules']({}, { kind });

(async () => {
  check('注册了 codescan:coverage', typeof handlers['codescan:coverage'] === 'function', 'no handler');
  check('注册了 codescan:modules', typeof handlers['codescan:modules'] === 'function', 'no handler');

  /* ---- 5.1 ids：只对比点名的几条 ---- */
  const two = await coverage({ root: tmp, kind: 'api', ids: ['a1', 'a2'] });
  check('传 ids: [a1,a2] → 只对比这 2 条', two.ok === true && two.total === 2, two.total);
  check(
    '传 ids: [a1,a2] → 结果只含这两条',
    two.coveredList.concat(two.uncovered).every((x) => x.id === 'a1' || x.id === 'a2'),
    two.coveredList.concat(two.uncovered).map((x) => x.id)
  );
  check('传 ids → scopeMode = ids', two.scopeMode === 'ids', two.scopeMode);
  check('传 ids → filtered = true', two.filtered === true, two.filtered);
  check('传 ids → scopeCount = 2', two.scopeCount === 2, two.scopeCount);

  const one = await coverage({ root: tmp, kind: 'api', ids: ['a4'] });
  check('传 ids: [a4] → 只 1 条且落在未覆盖里', one.total === 1 && one.uncovered.length === 1 && one.uncovered[0].id === 'a4', one);

  /* ---- 5.2 modules：老行为不变 ---- */
  const byModule = await coverage({ root: tmp, kind: 'api', modules: ['订单'] });
  check('传 modules: [订单] → 只对比该模块 2 条', byModule.total === 2, byModule.total);
  check(
    '传 modules → 结果都是订单模块',
    byModule.coveredList.concat(byModule.uncovered).every((x) => x.module === '订单'),
    byModule.coveredList.concat(byModule.uncovered).map((x) => x.module)
  );
  check('传 modules → scopeMode = modules', byModule.scopeMode === 'modules', byModule.scopeMode);

  /* ---- 5.3 都不传 = 全量（老调用一个字节都没变）---- */
  const all = await coverage({ root: tmp, kind: 'api' });
  check('两个都不传 → 全量 5 条', all.ok === true && all.total === 5, all.total);
  check('两个都不传 → scopeMode = all / filtered = false', all.scopeMode === 'all' && all.filtered === false, all.scopeMode);
  check('两个都不传 → 老字段还在（covered/total/coveredList）', typeof all.covered === 'number' && Array.isArray(all.coveredList), all.covered);
  check('两个都不传 → 已覆盖 3 条、未覆盖 2 条', all.covered === 3 && all.uncovered.length === 2, [all.covered, all.uncovered.length]);

  /* ---- 5.4 两个都传 = 并集（单条 id 不被模块拦住）---- */
  const both = await coverage({ root: tmp, kind: 'api', modules: ['订单'], ids: ['a1'] });
  check('两个都传 → 并集 3 条（订单 2 + 认证里点名 1）', both.total === 3, both.total);
  check(
    '两个都传 → a1（不在订单模块）也进来了',
    both.coveredList.concat(both.uncovered).some((x) => x.id === 'a1'),
    both.coveredList.concat(both.uncovered).map((x) => x.id)
  );
  check('两个都传 → scopeMode = mixed', both.scopeMode === 'mixed', both.scopeMode);

  const dup = await coverage({ root: tmp, kind: 'api', modules: ['认证'], ids: ['a1'] });
  check('模块已含的 id 不重复计算（认证 2 条，不是 3 条）', dup.total === 2, dup.total);

  /* ---- 5.5 边界：脏参数不报错 ---- */
  const missing = await coverage({ root: tmp, kind: 'api', ids: ['nope-1', 'nope-2'] });
  check('ids 里有不存在的 id → 不报错，只是匹配不到', missing.ok === true && missing.total === 0, missing.total);
  check('ids 全不存在 → 未覆盖/已覆盖都是空数组', missing.uncovered.length === 0 && missing.coveredList.length === 0, missing);

  const dirty = await coverage({ root: tmp, kind: 'api', ids: [null, '', undefined, '   '] });
  check('ids 里全是脏值 → 退化成全量（不报错）', dirty.ok === true && dirty.total === 5 && dirty.scopeMode === 'all', dirty.scopeMode);

  const emptyArr = await coverage({ root: tmp, kind: 'api', ids: [], modules: [] });
  check('ids/modules 都是空数组 → 全量', emptyArr.total === 5, emptyArr.total);

  const repeated = await coverage({ root: tmp, kind: 'api', ids: ['a2', 'a2', 'a2'] });
  check('ids 重复 → 去重，只对比 1 条', repeated.total === 1, repeated.total);

  const noDir = await coverage({ root: path.join(tmp, 'not-exist'), kind: 'api', ids: ['a1'] });
  check('目录不存在 → ok:false（ids 也绕不过目录校验）', noDir.ok === false, noDir);
  check('每次覆盖扫描都过 assertPathIn 守卫', pathChecks.length >= 8, pathChecks.length);

  /* ---- 5.6 页面覆盖：同样支持范围 ---- */
  const pageIds = await coverage({ root: tmp, kind: 'page', ids: ['p1'] });
  check('页面覆盖 + ids:p1 → 只对比这 1 个页面', pageIds.ok === true && pageIds.kind === 'page' && pageIds.total === 1, pageIds.total);
  check('页面覆盖的条目没有 method', pageIds.coveredList.concat(pageIds.uncovered).every((x) => x.method === ''), 'has method');

  const pageMod = await coverage({ root: tmp, kind: 'page', modules: ['销售'] });
  check('页面覆盖 + modules:销售 → 2 个页面', pageMod.total === 2, pageMod.total);
  check('页面覆盖的范围选项按 project 聚合', (await modulesOf('page')).modules.every((m) => m.name === '销售' || m.name === '后台'), (await modulesOf('page')).modules);

  /* ---- 5.7 modules 通道多回的那份 records ---- */
  const modResp = await modulesOf('api');
  check('modules 通道回 records', Array.isArray(modResp.records) && modResp.records.length === 5, modResp.records && modResp.records.length);
  check(
    'records 每条都有 id/label/method/url/module',
    modResp.records.every(
      (r) =>
        'id' in r && typeof r.label === 'string' && 'method' in r && 'url' in r && 'module' in r && r.label.length > 0
    ),
    modResp.records[0]
  );
  check('接口 label = 「方法 路径 · 接口名」', modResp.records.some((r) => r.label === 'POST /api/login · 登录'), modResp.records.map((r) => r.label));
  check('modules 聚合还在（认证 2 / 订单 2）', modResp.modules.find((m) => m.name === '认证').count === 2 && modResp.modules.find((m) => m.name === '订单').count === 2, modResp.modules);
  check('noModule 计数还在（a5 没标模块 = 1）', modResp.noModule === 1, modResp.noModule);
  const pageResp = await modulesOf('page');
  check('页面 label = 「页面名 路径」', pageResp.records.some((r) => r.label === '登录页 /login'), pageResp.records.map((r) => r.label));
  check('页面 records 不带 method', pageResp.records.every((r) => r.method === ''), 'has method');

  /* ---- 5.8 通道总数没变：ipc-scan 里仍是 6 个 handle ---- */
  check(
    'ipc-scan 通道数不变（6 个，只加参数不加通道）',
    (ipcScanSrc.match(/handle\('codescan:/g) || []).length === 6,
    (ipcScanSrc.match(/handle\('codescan:[^']+'/g) || []).length
  );

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('===== 代码体检范围选定测试（v0.46.0） =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  // 汇总口径与 run-unit 的解析规则一致（X passed, Y failed, Z skipped），否则统计会显示「未解析」
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, 0 skipped`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('测试自身崩了：', e);
  process.exit(1);
});