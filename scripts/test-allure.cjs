/* Allure 报告解析 + 失败聚类 + Flaky 追踪 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
/* 真实目录不存在时显式跳过：跳过要进汇总，不能静默变全绿 */
const skipped = [];
const skip = (name) => skipped.push(name);

const allure = require('../electron/allure.js');

/* ---------- 1. 解析真实 allure-results ----------
 * 用「相对本仓库」的示例项目路径，不写死 D:/AI_Workspace/...；
 * 目录不在就显式跳过，换台机器不影响 unit 档全绿。 */
const realDir = path.resolve(__dirname, '..', '..', 'example', 'allure-results');
if (fs.existsSync(realDir)) {
  const res = allure.parseAllureDir(realDir);
  check('解析真实目录成功', res.ok === true, res.message);
  check('解析出用例', res.tests.length >= 1, res.tests.length);
  // 汇总不写死 12：要求它和 tests 的实际状态对得上
  check('汇总 total = 用例数', res.summary.total === res.tests.length, { total: res.summary.total, tests: res.tests.length });
  check('汇总 broken = 实际 broken 数', res.summary.broken === res.tests.filter((t) => t.status === 'broken').length, { broken: res.summary.broken });
  check('用例有 name', !!res.tests[0].name, res.tests[0]);
  check('用例有 status', !!res.tests[0].status, res.tests[0]);
  check('用例有 testClass', !!res.tests[0].testClass, res.tests[0]);
  check('用例有 duration', res.tests[0].duration > 0, res.tests[0].duration);

  // 聚类
  const failedCount = res.tests.filter((t) => t.status === 'failed' || t.status === 'broken').length;
  const clusters = allure.clusterFailures(res.tests);
  check('聚类有结果', clusters.length > 0, clusters.length);
  check('聚类组数不超过失败用例数', clusters.length <= failedCount, { clusters: clusters.length, failedCount });
  check('聚类 count 合计 = 失败用例数', clusters.reduce((s, c) => s + c.count, 0) === failedCount, clusters.map((c) => c.count));
  check('聚类 pattern 已归一化（再归一化不变）', clusters.every((c) => allure.normalizeMessage(c.pattern) === c.pattern), clusters.map((c) => c.pattern));
  check('聚类没有具体数字', !/\b\d{3,}\b/.test(clusters[0].pattern), clusters[0].pattern);
} else {
  skip('真实 allure 目录（不存在：' + realDir + '，13 项解析/聚类断言整体跳过）');
}

/* ---------- 2. 归一化 ---------- */
check('归一化：数字 → <N>', allure.normalizeMessage('Timeout 3000ms') === 'Timeout <N>ms', allure.normalizeMessage('Timeout 3000ms'));
check('归一化：两个不同数字归一化后相同',
  allure.normalizeMessage('Timeout 3000ms') === allure.normalizeMessage('Timeout 5000ms'),
  [allure.normalizeMessage('Timeout 3000ms'), allure.normalizeMessage('Timeout 5000ms')]);
check('归一化：UUID → <UUID>', /<UUID>/.test(allure.normalizeMessage('id 550e8400-e29b-41d4-a716-446655440000 not found')), allure.normalizeMessage('id 550e8400-e29b-41d4-a716-446655440000 not found'));
check('归一化：时间戳 → <TS>', /<TS>/.test(allure.normalizeMessage('at 1795428064423')), allure.normalizeMessage('at 1795428064423'));
check('归一化：Windows 路径 → <PATH>', /<PATH>/.test(allure.normalizeMessage('file D:\\test\\a.txt missing')), allure.normalizeMessage('file D:\\test\\a.txt missing'));
check('归一化：只取第一行', !allure.normalizeMessage('line1\nline2\nline3').includes('line2'), allure.normalizeMessage('line1\nline2\nline3'));
check('归一化：空串返回空', allure.normalizeMessage('') === '', allure.normalizeMessage(''));
check('归一化：null 不崩', allure.normalizeMessage(null) === '', allure.normalizeMessage(null));

/* ---------- 3. 聚类 ---------- */
const fakeTests = [
  { id: '1', name: 'A', status: 'failed', message: 'Timeout 3000ms waiting for #btn' },
  { id: '2', name: 'B', status: 'failed', message: 'Timeout 5000ms waiting for #btn' },
  { id: '3', name: 'C', status: 'broken', message: 'NullPointerException at line 42' },
  { id: '4', name: 'D', status: 'passed', message: '' },
  { id: '5', name: 'E', status: 'failed', message: 'Timeout 1000ms waiting for #btn' }
];
const cl = allure.clusterFailures(fakeTests);
check('聚类：2 组（Timeout + NPE）', cl.length === 2, cl.length);
check('聚类：Timeout 组 3 个', cl.find((c) => /Timeout/.test(c.pattern)).count === 3, cl.map((c) => c.count));
check('聚类：按数量降序', cl[0].count >= cl[1].count, cl.map((c) => c.count));
check('聚类：passed 不参与', !cl.some((c) => c.tests.some((t) => t.status === 'passed')), 'passed included');

/* ---------- 4. Flaky 追踪 ---------- */
const run1 = [
  { fullName: 'test.a', name: 'A', status: 'passed' },
  { fullName: 'test.b', name: 'B', status: 'passed' },
  { fullName: 'test.c', name: 'C', status: 'failed' }
];
const run2 = [
  { fullName: 'test.a', name: 'A', status: 'failed' },  // 翻转
  { fullName: 'test.b', name: 'B', status: 'passed' },  // 稳定
  { fullName: 'test.c', name: 'C', status: 'failed' }   // 稳定失败
];
const run3 = [
  { fullName: 'test.a', name: 'A', status: 'passed' },  // 又翻转
  { fullName: 'test.b', name: 'B', status: 'passed' },
  { fullName: 'test.c', name: 'C', status: 'failed' }
];

const flaky = allure.trackFlaky([run1, run2, run3]);
check('Flaky：只标记 test.a', flaky.length === 1, flaky.length);
check('Flaky：test.a 被标记', flaky[0].fullName === 'test.a', flaky[0].fullName);
check('Flaky：history 有 3 条', flaky[0].history.length === 3, flaky[0].history);
check('Flaky：稳定通过的 test.b 不标记', !flaky.some((f) => f.fullName === 'test.b'), 'b marked');
check('Flaky：一直失败的 test.c 不标记', !flaky.some((f) => f.fullName === 'test.c'), 'c marked');

// 翻转次数
check('flipCount: pass→fail→pass = 2', allure.flipCount(['passed', 'failed', 'passed']) === 2, allure.flipCount(['passed', 'failed', 'passed']));
check('flipCount: 全 pass = 0', allure.flipCount(['passed', 'passed']) === 0, allure.flipCount(['passed', 'passed']));

/* ---------- 5. 扫描 allure-results ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allure-test-'));
const proj1 = path.join(tmp, 'proj1', 'allure-results');
fs.mkdirSync(proj1, { recursive: true });
fs.writeFileSync(path.join(proj1, 'x-result.json'), JSON.stringify({ uuid: 'x', name: 'T', status: 'passed', start: 1, stop: 2, labels: [] }), 'utf8');

const proj2 = path.join(tmp, 'proj2', 'target', 'allure-results');
fs.mkdirSync(proj2, { recursive: true });
fs.writeFileSync(path.join(proj2, 'y-result.json'), JSON.stringify({ uuid: 'y', name: 'T2', status: 'failed', start: 1, stop: 2, labels: [] }), 'utf8');

const scan = allure.scanAllureRoots(tmp);
check('扫描找到 2 个 allure-results', scan.ok && scan.dirs.length === 2, scan.dirs);

// 空目录
const emptyDir = path.join(tmp, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });
check('空目录解析失败', allure.parseAllureDir(emptyDir).ok === false, 'should fail');
check('不存在目录解析失败', allure.parseAllureDir('D:/nonexistent-xyz').ok === false, 'should fail');

fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- 6. IPC 已注册 ---------- */
const mainSrc = require('./_electron-src.cjs').readElectronSource();
check('有 allure:scan', /handle\('allure:scan'/.test(mainSrc), 'no scan');
check('有 allure:parse', /handle\('allure:parse'/.test(mainSrc), 'no parse');
check('有 allure:flaky', /handle\('allure:flaky'/.test(mainSrc), 'no flaky');
check('有 allure:pickDir', /handle\('allure:pickDir'/.test(mainSrc), 'no pickDir');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 allureScan', /allureScan:/.test(preloadSrc), 'no scan');
check('preload 有 allureParse', /allureParse:/.test(preloadSrc), 'no parse');
check('preload 有 allureFlaky', /allureFlaky:/.test(preloadSrc), 'no flaky');

/* ---------- 7. 前端页面 ---------- */
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ReportPage.tsx'), 'utf8');
check('页面有扫描', /doScan/.test(pageSrc), 'no scan');
check('页面有解析', /doParse/.test(pageSrc), 'no parse');
check('页面有 Flaky 比对', /doFlaky/.test(pageSrc), 'no flaky');
check('页面有失败聚类视图', /view === 'clusters'/.test(pageSrc), 'no clusters');
check('页面有用例列表视图', /view === 'tests'/.test(pageSrc), 'no tests');
check('页面有 Flaky 视图', /view === 'flaky'/.test(pageSrc), 'no flaky view');
check('页面有汇总统计', /report-summary/.test(pageSrc), 'no summary');

/* ---------- 8. 侧边栏入口 ---------- */
const collections = require('../shared/collections.js');
check('TOOLS 有报告分析', collections.TOOLS.some((t) => t.key === 'report'), collections.TOOLS.map((t) => t.key));
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
check('App 有 report 路由', /route\.key === 'report'/.test(appSrc), 'no route');

const failed = results.filter((r) => !r.ok);
console.log('===== 报告分析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
for (const name of skipped) console.log('  SKIP  ' + name);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
process.exit(failed.length ? 1 : 0);
