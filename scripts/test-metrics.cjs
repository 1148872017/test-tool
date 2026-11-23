/* 压测指标表格 + 场景选择器 的纯逻辑测试 */
const path = require('path');
const fs = require('fs');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. runs 字段定义检查 ---------- */
const collections = require('../shared/collections.js');
const runs = collections.COLLECTION_MAP.runs;

const perfFields = runs.fields.filter((f) => f.onlyFor && f.onlyFor.kind === 'perf');
const apiFields = runs.fields.filter((f) => f.onlyFor && f.onlyFor.kind === 'api');

check('有 perfMetrics 汇总字段', runs.fields.some((f) => f.key === 'perfMetrics' && f.type === 'metrics'), runs.fields.map((f) => f.key));
check('perfMetrics 只在压测显示', runs.fields.find((f) => f.key === 'perfMetrics').onlyFor.kind === 'perf');

// 这些字段已聚合到表格，详情页不该单独展示
const AGGREGATED = ['concurrency', 'duration', 'tps', 'p90', 'p95', 'p99', 'errRate', 'samples'];
for (const k of AGGREGATED) {
  const f = runs.fields.find((x) => x.key === k);
  check(`${k} 已标记 hideInDetail`, f && f.hideInDetail === true, f && f.hideInDetail);
}

// 接口测试的通过/失败也聚合
for (const k of ['passCount', 'failCount']) {
  const f = runs.fields.find((x) => x.key === k);
  check(`${k} 已标记 hideInDetail`, f && f.hideInDetail === true, f && f.hideInDetail);
}

check('scene 字段类型是 scene', runs.fields.find((f) => f.key === 'scene').type === 'scene', runs.fields.find((f) => f.key === 'scene').type);

// 关键回归：perfMetrics 是虚拟字段（不存数据），不能被 hideEmpty 过滤掉
const metricsField = runs.fields.find((f) => f.key === 'perfMetrics');
check('perfMetrics 是虚拟字段（不存数据）', metricsField && metricsField.type === 'metrics', metricsField && metricsField.type);
check('perfMetrics 标了 hideEmpty', metricsField && metricsField.hideEmpty === true, metricsField && metricsField.hideEmpty);

// RecordDetail 必须对 metrics 类型豁免 hideEmpty 判断
const detailSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RecordDetail.tsx'), 'utf8');
check(
  'RecordDetail 对 metrics 豁免 hideEmpty',
  /f\.type === 'metrics'\)\s*return true/.test(detailSrc),
  'no exemption'
);

/* ---------- 2. MetricsTable 的取值逻辑（转译后测）---------- */
const tsx = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MetricsTable.tsx'), 'utf8');
const out = esbuild.transformSync(tsx, { loader: 'tsx', format: 'cjs', jsx: 'transform' });
check('MetricsTable 能转译', out.code.length > 0, out.code.length);
check('MetricsTable 处理 perf 分支', /isPerf/.test(out.code), 'no isPerf');
check('MetricsTable 处理 api 分支', /passCount/.test(out.code), 'no passCount');
check('MetricsTable 分位拆成独立列', /P90 \(ms\)/.test(out.code) && /P95 \(ms\)/.test(out.code) && /P99 \(ms\)/.test(out.code), 'no pct cols');
// 横向 2 行 N 列：thead 一行指标名，tbody 一行值（检查源码，转译后 JSX 会变成 createElement）
check('MetricsTable 是横向布局（thead 遍历 cols）', /<thead>[\s\S]*?cols\.map/.test(tsx), 'not horizontal');
check('MetricsTable 只有一行 tbody', (tsx.match(/<tr>/g) || []).length === 2, (tsx.match(/<tr>/g) || []).length);
check('MetricsTable 不再有「指标/值」两列', !/指标<\/th>/.test(tsx), 'still vertical');

/* ---------- 3. ScenePicker 的匹配逻辑 ---------- */
const picker = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ScenePicker.tsx'), 'utf8');
check('ScenePicker 调 jmxScan', /api\.jmxScan/.test(picker), 'no jmxScan');
check('ScenePicker 支持只读', /readOnly/.test(picker), 'no readOnly');
check('ScenePicker 有重新扫描', /loadJmx/.test(picker), 'no reload');
check('ScenePicker 显示采样器数', /samplers/.test(picker), 'no samplers');

/* ---------- 4. body 类型标签去重 ---------- */
const detail = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RecordDetail.tsx'), 'utf8');
check('RecordDetail 不再在 body 标签旁渲染 Tag', !/f\.key === 'body' && data\.bodyType/.test(detail), 'still has duplicate tag');
check('RecordDetail 仍渲染 metrics', /case 'metrics'/.test(detail), 'no metrics case');
check('RecordDetail 仍渲染 scene', /case 'scene'/.test(detail), 'no scene case');

/* ---------- 5. 参数表格列宽自适应（CSS Grid）---------- */
const toggle = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'JsonTableToggle.tsx'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

check('参数表格不再用固定 flexBasis 百分比', !/flexBasis: '\d+%'/.test(toggle), 'still has fixed flexBasis');
check('参数表格用 param-grid 类', /param-grid/.test(toggle), 'no param-grid');
// 关键：必须用 Grid 而不是 flex——flex 每行独立算宽度，列对不齐
check('参数表格用 CSS Grid', /\.param-grid \.json-table-row\s*\{[^}]*display:\s*grid/.test(css), 'not grid');
check('Grid 定义 4 列模板', /grid-template-columns:\s*minmax\(120px, 30%\)\s+max-content\s+max-content\s+minmax\(0, 1fr\)/.test(css), 'no grid-template');
check('位置/类型列用 max-content（按内容）', (css.match(/max-content/g) || []).length >= 2, 'no max-content');
check('说明列占满剩余（1fr）', /minmax\(0, 1fr\)/.test(css), 'no 1fr');
check('参数名列有最小宽度', /minmax\(120px, 30%\)/.test(css), 'no minmax');
check('参数名列超出省略', /\.param-grid \.json-table-key\s*\{[^}]*text-overflow:\s*ellipsis/.test(css), 'no ellipsis');
check('不再有旧的 param-in/param-type flex 规则', !/\.param-in\s*\{[^}]*flex:/.test(css), 'old flex rule remains');

const failed = results.filter((r) => !r.ok);
console.log('===== 压测指标 + 场景选择器测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
