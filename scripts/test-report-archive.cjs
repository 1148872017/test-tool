/* 报告归档到「测试执行」：
 *   后端 allure:archive（写 runs 一条 + reportDir 锚点 + 幂等策略 + 清晰错误）
 *   前端「关联报告」入口、归档按钮、两页互跳的交接槽
 *
 * 风格和 test-main.cjs 一致：stub 掉 electron，真 require main.js，
 * 用临时数据目录 + 临时 allure-results，不碰任何本机真实资产。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), 'tt-archive-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

const handlers = {};

const fakeElectron = {
  app: {
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getPath(p) {
      return path.join(tmp, p);
    },
    requestSingleInstanceLock() {
      return true;
    },
    on() {},
    once() {},
    whenReady() {
      return Promise.resolve();
    },
    quit() {},
    getVersion() {
      return '0.1.0';
    },
    commandLine: { appendSwitch() {} }
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send() {}, on() {}, toggleDevTools() {} };
    }
    loadFile() {
      return Promise.resolve();
    }
    once() {}
    on() {}
    show() {}
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
  },
  ipcMain: {
    handle(channel, fn) {
      handlers[channel] = fn;
    }
  },
  clipboard: { writeText() {}, readText() { return ''; }, clear() {} },
  shell: { openExternal: async () => true, openPath: async () => '' },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
  Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
  globalShortcut: { register() {}, unregisterAll() {} },
  dialog: {
    showErrorBox(title, msg) {
      console.error('DIALOG', title, msg);
    },
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true })
  },
  nativeImage: { createFromPath() { return {}; } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

process.env.TT_DATA_DIR = tmp;
process.env.TT_NO_DEMO = '1';
delete process.env.TT_DEBUG;

require(path.join(ROOT, 'electron', 'main.js'));

const call = (channel, payload) => handlers[channel]({}, payload);

/** 造一个 allure-results 目录（stop - start = 单条耗时） */
function writeAllureDir(root, name, cases) {
  const dir = path.join(root, name, 'allure-results');
  fs.mkdirSync(dir, { recursive: true });
  cases.forEach((c, i) => {
    fs.writeFileSync(
      path.join(dir, 'c' + i + '-result.json'),
      JSON.stringify({
        uuid: name + '-' + i,
        name: c.name || '用例' + i,
        fullName: 'demo.' + name + '.' + i,
        status: c.status,
        start: c.start,
        stop: c.stop,
        labels: [{ name: 'suite', value: '归档用例' }]
      }),
      'utf8'
    );
  });
  return dir;
}

const readRuns = () => call('records:list', { collection: 'runs' });
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/**
 * 去掉注释再断言「没写死集合 key」。
 * 组件里的注释会写「旧实现写的是 xxx」，直接匹配源码会把说明文字当成代码。
 */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

(async () => {
  // 等 main.js 的 whenReady → store.init 跑完（和 test-main 同一个节奏）
  await new Promise((r) => setTimeout(r, 2500));
  const init = await call('app:init');
  check('应用已启动且未锁定（能调 IPC）', init && init.locked === false, init && init.locked);

  /* ---------------------------------------------------------------- *
   * 1. 通道 / 预加载存在
   * ---------------------------------------------------------------- */
  const { readElectronSource } = require('./_electron-src.cjs');
  const electronSrc = readElectronSource();
  check("后端注册了 ipcMain.handle('allure:archive')", /handle\('allure:archive'/.test(electronSrc), 'no channel');
  check('通道在运行时真的注册上了', typeof handlers['allure:archive'] === 'function', typeof handlers['allure:archive']);

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  check('preload 暴露 allureArchive', /allureArchive:\s*\(payload\)\s*=>\s*invoke\('allure:archive'/.test(preloadSrc), 'no preload');

  const mockSrc = fs.readFileSync(path.join(ROOT, 'src', 'mockApi.ts'), 'utf8');
  check('浏览器预览的 mock 也实现了 allureArchive', /allureArchive:\s*async/.test(mockSrc), 'no mock');

  /* ---------------------------------------------------------------- *
   * 2. 归档行为：通过 / 失败 / 耗时 / 结果判定 / kind / reportDir
   * ---------------------------------------------------------------- */
  const allureRoot = path.join(tmp, 'allure-root');
  // 4 条用例：2 通过 / 1 失败 / 1 跳过；最后一条 stop=4000 用来验执行时间
  const mixedDir = writeAllureDir(allureRoot, 'run-mixed', [
    { status: 'passed', start: 1000, stop: 2000 },
    { status: 'passed', start: 2000, stop: 2500 },
    { status: 'failed', start: 2500, stop: 4000, name: '登录失败' },
    { status: 'skipped', start: 4000, stop: 4000 }
  ]);
  const passDir = writeAllureDir(allureRoot, 'run-pass', [{ status: 'passed', start: 5000, stop: 6000 }]);

  // 路径守卫只认白名单目录：把报告根目录配成 allureDir（用户真实操作也是这个顺序）
  await call('settings:set', { allureDir: allureRoot });

  const before = await readRuns();
  check('归档前测试执行是空的', before.length === 0, before.length);

  const a1 = await call('allure:archive', {
    dir: mixedDir,
    name: '登录回归-1125',
    env: 'test',
    passCount: 2,
    failCount: 1,
    total: 4,
    duration: 5000,
    note: '失败是环境超时'
  });
  check('归档返回 ok 且带记录 id', !!(a1 && a1.ok && a1.id), a1);

  const runs1 = await readRuns();
  check('归档后 runs 多了一条', runs1.length === 1, runs1.length);
  const r1 = runs1[0] || { data: {} };
  check('reportDir 原样存下来（关联报告的锚点）', norm(r1.data.reportDir) === norm(mixedDir), r1.data.reportDir);
  check('passCount 存对', r1.data.passCount === 2, r1.data.passCount);
  check('failCount 存对', r1.data.failCount === 1, r1.data.failCount);
  check('duration 存对（毫秒，前端传的优先）', r1.data.duration === 5000, r1.data.duration);
  check('有失败 → result = bad', r1.data.result === 'bad', r1.data.result);
  check("kind 用 'api'（runs 只有 api/perf 两档）", r1.data.kind === 'api', r1.data.kind);
  check('标题用传入的名称', r1.title === '登录回归-1125', r1.title);
  check('env 存对', r1.data.env === 'test', r1.data.env);
  check('备注落进「结论」', r1.data.conclusion === '失败是环境超时', r1.data.conclusion);
  check('执行时间取最后一条用例的 stop', r1.data.ranAt === 4000, r1.data.ranAt);
  check('首次归档 duplicated = false', a1.duplicated === false, a1.duplicated);
  check('返回里带统计（含跳过 = 4-2-1）', a1.counts && a1.counts.total === 4 && a1.counts.skipped === 1, a1.counts);

  /* 全过的一份：不传统计和名称，验证「回落到重新解析」+ 默认名 */
  const a2 = await call('allure:archive', { dir: passDir });
  check('全过的报告 result = ok', a2 && a2.ok && a2.result === 'ok', a2);
  const runs2 = await readRuns();
  check('归档后 runs 有两条', runs2.length === 2, runs2.length);
  const r2 = runs2.find((r) => norm(r.data.reportDir) === norm(passDir)) || { data: {} };
  check('没传统计时用解析结果（1 通过 0 失败）', r2.data.passCount === 1 && r2.data.failCount === 0, [r2.data.passCount, r2.data.failCount]);
  check('没传 duration 时用解析出的总耗时 1000ms', r2.data.duration === 1000, r2.data.duration);
  check('没传名称时自动生成「Allure 归档-月-日 时:分」', /^Allure 归档-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(r2.title || '')), r2.title);
  check('没传 env 时默认 test', r2.data.env === 'test', r2.data.env);

  /* ---------------------------------------------------------------- *
   * 3. 幂等：同一个 reportDir 再归档 → 新建一条 + duplicated 提示
   * ---------------------------------------------------------------- */
  const dup = await call('allure:archive', {
    dir: mixedDir,
    name: '登录回归-1125（复核）',
    env: 'staging',
    passCount: 2,
    failCount: 1,
    total: 4,
    duration: 5000
  });
  const runs3 = await readRuns();
  check('重复归档仍返回 ok', !!(dup && dup.ok), dup);
  check('重复归档新建一条（不覆盖原记录）', runs3.length === 3, runs3.length);
  check('重复归档的 id 和第一次不同', dup.id !== a1.id, [dup.id, a1.id]);
  check('重复归档返回 duplicated = true', dup.duplicated === true, dup.duplicated);
  check('重复归档回报已归档次数 = 1', dup.duplicates === 1, dup.duplicates);
  check('两条同目录记录都在，结论各自保留', runs3.filter((r) => norm(r.data.reportDir) === norm(mixedDir)).length === 2, runs3.length);
  const dupRecord = runs3.find((r) => r.id === dup.id) || { data: {} };
  check('第二条记录的环境按新传的存（staging）', dupRecord.data.env === 'staging', dupRecord.data.env);

  /* ---------------------------------------------------------------- *
   * 3.5 账本口径（v0.50.x）：kind 不再写死 api，可记成 UI 测试
   *     不传 kind = 老行为（api）；传 ui 存 ui；乱传回落 api
   * ---------------------------------------------------------------- */
  const a3 = await call('allure:archive', { dir: passDir, name: 'UI 冒烟-1125', kind: 'ui' });
  check('归档可以记成 UI 测试（kind 不再写死 api）', !!(a3 && a3.ok) && a3.kind === 'ui', a3 && a3.kind);
  const uiRec = (await readRuns()).find((r) => r.id === (a3 && a3.id)) || { data: {} };
  check('落库的 kind 是 ui', uiRec.data.kind === 'ui', uiRec.data.kind);
  const a4 = await call('allure:archive', { dir: passDir, name: '乱传类型-1125', kind: 'nonsense' });
  check('不认识的 kind 回落到 api（不写脏值）', !!(a4 && a4.ok) && a4.kind === 'api', a4 && a4.kind);

  /* ---------------------------------------------------------------- *
   * 4. 错误：缺目录 / 目录不存在 / 不是 allure 目录 / 越界
   * ---------------------------------------------------------------- */
  const runsBeforeErr = (await readRuns()).length;

  const noDir = await call('allure:archive', {});
  check('缺目录 → ok:false + NO_DIR', noDir && noDir.ok === false && noDir.code === 'NO_DIR', noDir);

  const missingDir = path.join(allureRoot, 'nope', 'allure-results');
  const notExist = await call('allure:archive', { dir: missingDir });
  check('目录不存在 → 明确错误', notExist && notExist.ok === false && notExist.code === 'DIR_NOT_FOUND', notExist);
  check('目录不存在的错误文案说得出是哪个目录', /不存在/.test(String(notExist.message || '')) && String(notExist.message || '').indexOf('allure-results') >= 0, notExist.message);

  const emptyDir = path.join(allureRoot, 'empty-run', 'allure-results');
  fs.mkdirSync(emptyDir, { recursive: true });
  const notAllure = await call('allure:archive', { dir: emptyDir });
  check('空目录 → 明确错误（不是 allure-results）', notAllure && notAllure.ok === false && notAllure.code === 'NOT_ALLURE_DIR', notAllure);
  check('不是 allure 目录的错误文案可读', /不是 allure-results 目录/.test(String(notAllure.message || '')), notAllure.message);

  const outsideRoot = path.join(os.tmpdir(), 'tt-outside-' + Date.now(), 'allure-results');
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(
    path.join(outsideRoot, 'z-result.json'),
    JSON.stringify({ uuid: 'z', name: 'Z', status: 'passed', start: 1, stop: 2, labels: [] }),
    'utf8'
  );
  const outside = await call('allure:archive', { dir: outsideRoot });
  check('白名单外的目录被守卫拒绝', outside && outside.ok === false && outside.code === 'OUTSIDE_ROOT', outside);

  check('报错的这几次都没有写脏记录', (await readRuns()).length === runsBeforeErr, (await readRuns()).length);

  /* ---------------------------------------------------------------- *
   * 5. 后端实现要点（按源码断言，防止以后改回去）
   * ---------------------------------------------------------------- */
  const ipcAllureSrc = fs.readFileSync(path.join(ROOT, 'electron', 'ipc', 'ipc-allure.js'), 'utf8');
  check('归档逻辑解析目录后再写库（不采信前端统计）', /allure\.parseAllureDir\(dir\)/.test(ipcAllureSrc), 'no re-parse');
  check('result 判定有 ok / bad / unknown 三种', /'bad'/.test(ipcAllureSrc) && /'ok'/.test(ipcAllureSrc) && /'unknown'/.test(ipcAllureSrc));
  check('幂等策略写明了「新建一条 + duplicated」', /duplicated:\s*duplicates > 0/.test(ipcAllureSrc), 'no duplicated flag');
  check('目录比较做了大小写/斜杠归一化', /function dirKey/.test(ipcAllureSrc), 'no dirKey');

  /* ---------------------------------------------------------------- *
   * 6. 前端：关联报告入口（runs 有、其余 4 个集合没有）
   * ---------------------------------------------------------------- */
  const { COLLECTIONS } = require('../shared/collections.js');
  const runsConf = COLLECTIONS.find((c) => c.key === 'runs');
  const linked = runsConf && runsConf.capabilities && runsConf.capabilities.linkedReport;
  check('runs 配了 capabilities.linkedReport → reportDir', !!linked && linked.field === 'reportDir', linked);
  // equals 归一化成数组（v0.50.x）：Allure 归档现在有 api / ui 两档，两档都要能回报告；
  // 压测（perf）的 reportDir 指向 JMeter 报告，报告分析页解析不了，必须排除
  const whenKinds =
    linked && linked.when && Array.isArray(linked.when.equals)
      ? linked.when.equals
      : [linked && linked.when ? linked.when.equals : ''];
  check(
    '关联报告在 api / ui 上给入口、压测不给（目录里是 JMeter 报告，解析不了）',
    !!linked && !!linked.when && linked.when.field === 'kind' && whenKinds.indexOf('api') >= 0 && whenKinds.indexOf('ui') >= 0 && whenKinds.indexOf('perf') < 0,
    linked && linked.when
  );
  const others = COLLECTIONS.filter((c) => c.key !== 'runs');
  check('其余集合都没有 linkedReport（列表不受影响）', others.every((c) => !(c.capabilities && c.capabilities.linkedReport)), others.map((c) => c.key));
  check('reportDir 字段不再限定只给压测（api 记录也要能看）', (() => {
    const f = runsConf.fields.find((x) => x.key === 'reportDir');
    return !!f && !f.onlyFor && !!f.formHidden && !!String(f.formHiddenReason || '').trim();
  })(), runsConf.fields.find((x) => x.key === 'reportDir'));

  const capsSrc = fs.readFileSync(path.join(ROOT, 'src', 'features', 'collections', 'capabilities.ts'), 'utf8');
  check('capabilities 暴露 linkedReport（页面不按集合 key 写 if/else）', /linkedReport:\s*LinkedReportCapability \| null/.test(capsSrc), 'no linkedReport');
  check('linkedReport 会校验字段真实存在', /function asLinkedReport/.test(capsSrc), 'no validator');

  const collectionSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'CollectionPage.tsx'), 'utf8');
  const collectionCode = stripComments(collectionSrc);
  check('列表渲染了「关联报告」图标', /title-report-link/.test(collectionCode) && /FileTextOutlined/.test(collectionCode), 'no icon');
  check('只有存在报告目录时才渲染图标', /linkedReportDir\(r\)\s*\?/.test(collectionCode), 'unguarded');
  check('入口按能力里的 when 条件过滤（压测不挂）', /cap\.when/.test(collectionCode), 'no when check');
  check('点图标不进详情（stopPropagation）', /e\.stopPropagation\(\);\s*\n\s*openLinkedReport\(r\)/.test(collectionCode), 'no stopPropagation');
  check('读取目录靠 caps.linkedReport，不硬编码 runs', /caps\.linkedReport/.test(collectionCode) && !/conf\.key === 'runs'/.test(collectionCode), 'hardcoded');

  /* ---------------------------------------------------------------- *
   * 7. 前端：归档按钮（独立组件，便于接入正在改的 ReportPage）
   * ---------------------------------------------------------------- */
  const archivePath = path.join(ROOT, 'src', 'components', 'AllureArchive.tsx');
  const archiveSrc = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf8') : '';
  check('归档按钮组件存在', archiveSrc.length > 0, 'missing');
  check('按钮文案是「归档到执行记录」', /归档到执行记录/.test(archiveSrc), 'no label');
  check('按钮调 allure:archive', /api\.allureArchive\(/.test(archiveSrc), 'no invoke');
  check('预填自动生成的名称', /defaultName\(new Date\(\)\)/.test(archiveSrc), 'no prefill');
  check('环境下拉用共享的 ENV_OPTIONS', /ENV_OPTIONS/.test(archiveSrc), 'no env options');
  check('有备注输入（写进结论）', /Input\.TextArea/.test(archiveSrc), 'no note');
  check('摘要显示「N 个用例，x 通过 / y 失败 / z 跳过」', /\{counts\.total\} 个用例/.test(archiveSrc) && /counts\.failed/.test(archiveSrc) && /counts\.skipped/.test(archiveSrc), 'no summary');
  check('成功后给「去测试执行」的入口', /去「测试执行」页查看/.test(archiveSrc) && /type: 'collection', key: 'runs'/.test(archiveSrc), 'no link');
  check('重复归档时提示「之前归档过 N 次」', /duplicated/.test(archiveSrc) && /duplicates/.test(archiveSrc), 'no dup hint');

  const reportSrc = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'ReportPage.tsx'), 'utf8');
  const reportWired = /AllureArchive/.test(reportSrc);
  // 报告页正在被别人改（步骤展示）：没接入不算失败，但要在汇总里喊出来
  if (!reportWired) console.log('  NOTE  报告页还没接入 <AllureArchive />（见交付 notes 的 3 行补丁）');

  /* ---------------------------------------------------------------- *
   * 8. 互跳：模块级交接槽 + App 的导航传参
   * ---------------------------------------------------------------- */
  const handoffPath = path.join(ROOT, 'src', 'features', 'allure', 'handoff.ts');
  const handoffSrc = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '';
  check('有 allure 的交接槽模块', /export function setAllureHandoff/.test(handoffSrc) && /export function takeAllureHandoff/.test(handoffSrc), 'no handoff');
  check('交接槽取完即清空（只能消费一次）', /pending = null;\s*\n\s*return value;/.test(handoffSrc), 'not consumed once');
  check('交接槽提供了挂载即消费的钩子', /export function useAllureHandoff/.test(handoffSrc), 'no hook');
  check('测试执行点图标时写入交接槽', /setAllureHandoff\(\{\s*dir/.test(collectionCode), 'no set');

  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8');
  check('App 给 CollectionPage 传了 onNavigate', /<CollectionPage[\s\S]{0,600}onNavigate=\{setRoute\}/.test(appSrc), 'no onNavigate');
  check('App 给 ReportPage 传了 onNavigate', /<ReportPage onNavigate=\{setRoute\}/.test(appSrc), 'no onNavigate');

  /* ---------------------------------------------------------------- */
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 报告归档测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, 0 skipped`);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(outsideRoot), { recursive: true, force: true });
  } catch (e) {
    /* 临时目录删不掉不影响结论 */
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});