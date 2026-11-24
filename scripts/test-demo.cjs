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
  if (request === 'electron') return path.join(__dirname, '_stub-electron.cjs');
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

  /* ---- 示例项目用 TestNG（跟着用户的技术栈，不是别人家的框架） ---- */
  const projDir = path.join(demoRoot, 'project');
  const pomPath = path.join(projDir, 'pom.xml');
  const javaPath = path.join(projDir, 'src', 'test', 'java', 'com', 'example', 'demo', 'LoginApiTest.java');
  const pomSrc = fs.readFileSync(pomPath, 'utf8');
  const javaSrc = fs.readFileSync(javaPath, 'utf8');

  check('pom 依赖 testng', /<artifactId>testng<\/artifactId>/.test(pomSrc), 'no testng');
  check(
    'pom 的 testng 版本是 7.9.0',
    /<artifactId>testng<\/artifactId>\s*<version>7\.9\.0<\/version>/.test(pomSrc),
    'version'
  );
  check('pom 已彻底去掉 junit（不是两个都在）', !/junit/i.test(pomSrc), 'still has junit');
  check('pom 保留 rest-assured', /<artifactId>rest-assured<\/artifactId>/.test(pomSrc), 'no rest-assured');
  check('pom 配了 maven-surefire-plugin', /<artifactId>maven-surefire-plugin<\/artifactId>/.test(pomSrc), 'no surefire');

  check(
    '示例类用 org.testng.annotations.Test',
    /import\s+org\.testng\.annotations\.Test;/.test(javaSrc),
    'no testng import'
  );
  check('示例类不含 org.junit', !javaSrc.includes('org.junit'), 'still junit');
  check('示例类用 org.testng.Assert', /import\s+static\s+org\.testng\.Assert\./.test(javaSrc), 'no testng assert');

  /* 4 个故意埋的问题不能因为换框架就丢了（这是示例的价值） */
  check('埋点 1：硬编码密码还在', /PASSWORD\s*=\s*"admin123"/.test(javaSrc), 'no hardcoded password');
  check(
    '埋点 2：硬编码地址还在',
    /BASE_URL\s*=\s*"https:\/\/demo-shop\.example\.com"/.test(javaSrc),
    'no hardcoded url'
  );
  check('埋点 3：Thread.sleep 还在', /Thread\.sleep\(\s*2000\s*\)/.test(javaSrc), 'no sleep');
  check('埋点 4：弱断言（只 statusCode）还在', /\.statusCode\(200\)\s*;/.test(javaSrc), 'no weak assertion');

  /* TestNG 特有演示：不能只是换个 import */
  check(
    '有 TestNG 特有演示（@DataProvider 或 @BeforeMethod）',
    /@DataProvider\s*\(|@BeforeMethod\b/.test(javaSrc),
    'no testng-only feature'
  );

  /* 示例项目能被代码体检扫出问题（验证它是"有用"的示例） */
  {
    const codescan = require('../electron/codescan.js');
    const scan = codescan.scanHardcoded(projDir);
    check('示例项目能扫出硬编码密码', scan.issues.some((i) => i.rule === 'hardcoded-password'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出硬编码地址', scan.issues.some((i) => i.rule === 'hardcoded-url'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出 sleep', scan.issues.some((i) => i.rule === 'sleep'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出绝对 XPath', scan.issues.some((i) => i.rule === 'absolute-xpath'), scan.issues.map((i) => i.rule));
    check('示例项目能扫出弱断言', scan.issues.some((i) => i.rule === 'weak-assertion'), scan.issues.map((i) => i.rule));

    // 4 类埋点必须同时被抓到，少一类示例就白给了
    const wantRules = ['hardcoded-password', 'hardcoded-url', 'sleep', 'weak-assertion'];
    const missing = wantRules.filter((r) => !scan.issues.some((i) => i.rule === r));
    check('4 类埋点问题都能被代码体检抓到', missing.length === 0, missing);

    const deps = require('../electron/deps.js').checkDeps(projDir);
    check('示例项目能查依赖', deps.ok && deps.poms === 1, { poms: deps.poms });

    // 项目列表的框架识别也要跟着变（不然示例还是被标成 JUnit）
    const projInfo = require('../electron/projects.js').inspectProject(projDir);
    const fwKeys = projInfo.frameworks.map((f) => f.key);
    check('示例项目被识别成 TestNG', fwKeys.includes('testng'), fwKeys);
    check('示例项目不再被识别成 JUnit', !fwKeys.includes('junit'), fwKeys);
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

    /* labels 要和示例项目一致：framework=testng，testClass/testMethod 照旧 */
    const allureDir = path.join(demoRoot, 'allure-results');
    const rawTests = fs
      .readdirSync(allureDir)
      .filter((f) => f.endsWith('-result.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(allureDir, f), 'utf8')));
    const labelsOf = (t, name) => (t.labels || []).filter((l) => l.name === name).map((l) => l.value);

    check(
      '示例报告 labels 的 framework 是 testng',
      rawTests.length === 3 && rawTests.every((t) => labelsOf(t, 'framework').length === 1 && labelsOf(t, 'framework')[0] === 'testng'),
      rawTests.map((t) => labelsOf(t, 'framework'))
    );
    check(
      '示例报告里没有 junit5 标签',
      !JSON.stringify(rawTests).includes('junit5'),
      'still junit5'
    );
    check(
      '示例报告保留 testClass 标签',
      rawTests.every((t) => labelsOf(t, 'testClass').includes('com.example.demo.LoginApiTest')),
      rawTests.map((t) => labelsOf(t, 'testClass'))
    );
    check(
      '示例报告保留 testMethod 标签',
      rawTests.every((t) => labelsOf(t, 'testMethod').length === 1 && !!labelsOf(t, 'testMethod')[0]),
      rawTests.map((t) => labelsOf(t, 'testMethod'))
    );
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

  check('有 demo:count IPC', /handle\('demo:count'/.test(mainSrc), 'no count');
  check('有 demo:clear IPC', /handle\('demo:clear'/.test(mainSrc), 'no clear');
  check('有 demo:paths IPC', /handle\('demo:paths'/.test(mainSrc), 'no paths');
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