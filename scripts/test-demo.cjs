/* 示例数据：写入 / 计数 / 清除 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---- 用 electron stub 加载 store ---- */
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return 'D:/AI_Workspace/Project/test-tool/scripts/_stub-electron.cjs';
  return origResolve.call(this, request, ...args);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-test-'));
process.env.TT_DATA_DIR = tmp;

const store = require('../electron/store.js');
const demo = require('../electron/demo.js');
const collections = require('../shared/collections.js');

(async () => {
  await store.init(tmp);

  /* ============================================================
   * 1. demo 数据定义本身
   * ============================================================ */
  check('有 11 条示例数据', demo.DEMO_RECORDS.length === 11, demo.DEMO_RECORDS.length);

  // 每个集合都有
  const byColl = {};
  for (const r of demo.DEMO_RECORDS) byColl[r.collection] = (byColl[r.collection] || 0) + 1;
  check('sites 有 2 条', byColl.sites === 2, byColl.sites);
  check('sqls 有 2 条', byColl.sqls === 2, byColl.sqls);
  check('apis 有 3 条', byColl.apis === 3, byColl.apis);
  check('runs 有 2 条', byColl.runs === 2, byColl.runs);
  check('pages 有 2 条', byColl.pages === 2, byColl.pages);

  // 字段合法性
  let badField = [];
  for (const rec of demo.DEMO_RECORDS) {
    const conf = collections.COLLECTION_MAP[rec.collection];
    if (!conf) {
      badField.push(rec.collection + ': 未知集合');
      continue;
    }
    const valid = new Set(conf.fields.map((f) => f.key));
    const extra = Object.keys(rec.data).filter((k) => !valid.has(k));
    if (extra.length) badField.push(rec.collection + ': 多余 ' + extra.join(','));
    if (!rec.data[conf.titleField]) badField.push(rec.collection + ': 缺 ' + conf.titleField);
  }
  check('所有示例字段合法', badField.length === 0, badField);

  /* ============================================================
   * 2. 写入
   * ============================================================ */
  const demoRoot = path.join(tmp, 'demo');
  const seedRes = demo.seedDemo(store, demoRoot);
  check('写入成功', seedRes.seeded === true, seedRes.seeded);
  check('写入 11 条', seedRes.records === 11, seedRes.records);

  // 各集合数量
  check('sites 落库 2 条', store.list('sites').length === 2, store.list('sites').length);
  check('apis 落库 3 条', store.list('apis').length === 3, store.list('apis').length);
  check('pages 落库 2 条', store.list('pages').length === 2, store.list('pages').length);

  // 带「示例」标签
  const allHaveTag = ['sites', 'sqls', 'apis', 'runs', 'pages'].every((k) =>
    store.list(k).every((r) => {
      const tags = Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(',');
      return tags.map((t) => String(t).trim()).includes('示例');
    })
  );
  check('所有记录带「示例」标签', allHaveTag, 'no tag');

  // 幂等：再写一次不重复
  const seedRes2 = demo.seedDemo(store, demoRoot);
  check('重复调用不重复写', seedRes2.seeded === false, seedRes2.seeded);
  check('数量没变', store.list('sites').length === 2, store.list('sites').length);

  /* ============================================================
   * 3. 配套文件
   * ============================================================ */
  check('示例项目目录存在', fs.existsSync(path.join(demoRoot, 'project')), 'no project');
  check('pom.xml 存在', fs.existsSync(path.join(demoRoot, 'project', 'pom.xml')), 'no pom');
  check(
    'LoginApiTest.java 存在',
    fs.existsSync(path.join(demoRoot, 'project', 'src', 'test', 'java', 'com', 'example', 'demo', 'LoginApiTest.java')),
    'no java'
  );
  check('allure-results 存在', fs.existsSync(path.join(demoRoot, 'allure-results')), 'no allure');

  /* 示例项目能被代码体检扫出问题（验证它是"有用"的示例） */
  {
    const codescan = require('../electron/codescan.js');
    const scan = codescan.scanHardcoded(path.join(demoRoot, 'project'));
    check('示例项目能扫出硬编码密码', scan.issues.some((i) => i.rule === 'hardcoded-password'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出 sleep', scan.issues.some((i) => i.rule === 'sleep'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出绝对 XPath', scan.issues.some((i) => i.rule === 'absolute-xpath'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出弱断言', scan.issues.some((i) => i.rule === 'weak-assertion'), scan.issues.map((i) => i.rule));

    const deps = require('../electron/deps.js').checkDeps(path.join(demoRoot, 'project'));
    check('示例项目能查依赖', deps.ok && deps.poms === 1, { poms: deps.poms });
  }

  /* 示例 allure 报告能被解析（演示失败聚类） */
  {
    const allure = require('../electron/allure.js');
    const parsed = allure.parseAllureDir(path.join(demoRoot, 'allure-results'));
    check('示例报告解析成功', parsed.ok === true, parsed.message);
    check('示例报告 3 个用例', parsed.tests.length === 3, parsed.tests.length);
    check('1 通过 2 失败', parsed.summary.passed === 1 && parsed.summary.failed === 2, parsed.summary);
    const clusters = allure.clusterFailures(parsed.tests);
    check('失败能聚成 1 组', clusters.length === 1, clusters.length);
    check('聚类有 2 个用例', clusters[0] && clusters[0].count === 2, clusters[0] && clusters[0].count);
  }

  /* ============================================================
   * 4. 计数
   * ============================================================ */
  check('countDemo 返回 11', demo.countDemo(store) === 11, demo.countDemo(store));

  /* ============================================================
   * 5. 清除
   * ============================================================ */
  // 先手动加一条"用户自己的"数据（不该被清）
  store.save({ collection: 'sites', data: { name: '我自己的站点', url: 'https://mine.com' }, tags: [], favorite: false });
  check('手动加了 1 条', store.list('sites').length === 3, store.list('sites').length);

  const clearRes = demo.clearDemo(store, demoRoot);
  check('清除 11 条', clearRes.removed === 11, clearRes.removed);
  check('用户自己的数据还在', store.list('sites').length === 1, store.list('sites').length);
  check('用户那条是「我自己的站点」', store.list('sites')[0].data.name === '我自己的站点', store.list('sites')[0].data.name);
  check('示例文件已删', !fs.existsSync(demoRoot), fs.existsSync(demoRoot));
  check('清除后 countDemo 是 0', demo.countDemo(store) === 0, demo.countDemo(store));

  // 清除后再 seed 不会重新写（用户主动删了就不该长回来）
  const seedRes3 = demo.seedDemo(store, demoRoot);
  check('清除后不再自动写入', seedRes3.seeded === false, seedRes3.seeded);

  /* ============================================================
   * 6. IPC / 前端接线
   * ============================================================ */
  const mainSrc = require('./_electron-src.cjs').readElectronSource();
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');

  check('有 demo:count IPC', /ipcMain\.handle\('demo:count'/.test(mainSrc), 'no count');
  check('有 demo:clear IPC', /ipcMain\.handle\('demo:clear'/.test(mainSrc), 'no clear');
  check('有 demo:paths IPC', /ipcMain\.handle\('demo:paths'/.test(mainSrc), 'no paths');
  check('启动时调用 seedDemo', /demo\.seedDemo\(store/.test(mainSrc), 'not called');
  check('preload 暴露 demoCount', /demoCount:/.test(preloadSrc), 'no');
  check('preload 暴露 demoClear', /demoClear:/.test(preloadSrc), 'no');
  check('设置页有清除按钮', /清除示例/.test(settingsSrc), 'no btn');

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('===== 示例数据测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('测试崩了:', e);
  process.exit(1);
});