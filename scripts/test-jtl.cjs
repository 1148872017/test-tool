/* jtl / statistics.json 解析测试：跑真实压测报告目录（REPORT_ROOT 环境变量） */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseJtl,
  parseJtlCsv,
  parseStatistics,
  findReportFiles,
  parseReportDir,
  scanReportRoot
} = require('../electron/jtl.js');

const ROOT = process.env.REPORT_ROOT || path.join(os.homedir(), 'Documents', '测试工作台', 'jmx', '压测结果');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
/* 大文件性能样本是可选增强：没有就显式跳过，不能让「静默跳过」混进全绿 */
const skipped = [];
const skip = (name) => skipped.push(name);

/* ---------- 1. 真实目录 ---------- */
const files = findReportFiles(ROOT);
console.log('=== 找到的文件 ===');
console.log('  jtl:', files.jtl);
console.log('  statistics:', files.statistics);
console.log('  htmlIndex:', files.htmlIndex);

check('找到 result.jtl', !!files.jtl, files);
check('找到 statistics.json', !!files.statistics, files);
check('找到 html-report/index.html', !!files.htmlIndex, files);

const rep = parseReportDir(ROOT);
console.log('\n=== 解析结果 ===');
console.log(JSON.stringify({
  sources: rep.sources,
  samples: rep.samples,
  fails: rep.fails,
  errRate: rep.errRate,
  tps: rep.tps,
  durationS: rep.durationS,
  concurrency: rep.concurrency,
  p50: rep.p50,
  p90: rep.p90,
  p95: rep.p95,
  p99: rep.p99,
  labels: rep.labels
}, null, 1));

check('样本数 50', rep.samples === 50, rep.samples);
check('失败数 0', rep.fails === 0, rep.fails);
check('错误率 0', rep.errRate === 0, rep.errRate);
check('TPS 约 29.4', Math.abs(rep.tps - 29.4) < 0.5, rep.tps);
check('时长从 jtl 算出来', rep.durationS > 0, rep.durationS);
check('P95 从 jtl 算（不是 statistics 的 pct2）', rep.p95 === 4, rep.p95);
check('P90/P99 也有', rep.p90 !== null && rep.p99 !== null, { p90: rep.p90, p99: rep.p99 });
check('按接口拆出 1 个', rep.labels.length === 1 && rep.labels[0].label === '商品详情', rep.labels);
check('接口级 p95 也补上了', rep.labels[0].p95 === 4, rep.labels[0]);
check('两个来源都记了', rep.sources.length === 2, rep.sources);
check('没有解析警告', rep.warnings.length === 0, rep.warnings);

/* ---------- 2. 只有 jtl ---------- */
const jtlOnly = parseJtl(fs.readFileSync(files.jtl, 'utf8'));
check('单独解析 jtl 成功', jtlOnly.samples === 50, jtlOnly.samples);
check('jtl 带并发数', typeof jtlOnly.concurrency === 'number', jtlOnly.concurrency);

/* ---------- 3. 只有 statistics.json ---------- */
const statOnly = parseStatistics(fs.readFileSync(files.statistics, 'utf8'));
check('单独解析 statistics 成功', statOnly.samples === 50, statOnly.samples);
check('statistics 不提供 p95（避免误读 pct2）', statOnly.labels[0].p95 === null, statOnly.labels[0]);
check('statistics 没有时长字段', statOnly.durationS === null, statOnly.durationS);

/* ---------- 4. 容错 ---------- */
let threw = false;
try {
  parseJtlCsv('a,b,c\n1,2,3');
} catch (e) {
  threw = /缺少必需列/.test(e.message);
}
check('缺列的 jtl 报明确错误', threw);

threw = false;
try {
  parseStatistics('{bad json');
} catch (e) {
  threw = /不是合法 JSON/.test(e.message);
}
check('坏 JSON 报明确错误', threw);

threw = false;
try {
  parseReportDir('D:\\不存在的目录');
} catch (e) {
  threw = /没找到/.test(e.message);
}
check('空目录报明确错误', threw);

/* ---------- 5. 扫描根目录 ---------- */
const scan = scanReportRoot(ROOT);
check('扫描根目录能识别出报告', scan.reports.length >= 1, scan.reports.length);
check('扫描结果带目录名', scan.reports[0] && !!scan.reports[0].name, scan.reports[0] && scan.reports[0].name);

/* ---------- 6. 大文件性能 ---------- */
const BIG = process.env.BIG_JTL || path.join(os.tmpdir(), 'test-tool-big.jtl');
if (fs.existsSync(BIG)) {
  const t0 = Date.now();
  const big = parseJtl(fs.readFileSync(BIG, 'utf8'));
  const ms = Date.now() - t0;
  console.log(`\n大文件（20 万行 / 17MB）解析耗时: ${ms}ms`);
  check('20 万行能在 3 秒内解析完', ms < 3000, ms);
  check('大文件样本数正确', big.samples === 200000, big.samples);
  check('大文件 P95 合理', big.p95 > 0 && big.p95 < 1000, big.p95);
} else {
  skip('大文件性能（没有 ' + BIG + '，可用 BIG_JTL 指定）');
}

const failed = results.filter((r) => !r.ok);
console.log('\n===== jtl 解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
for (const name of skipped) console.log('  SKIP  ' + name);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
process.exit(failed.length ? 1 : 0);
