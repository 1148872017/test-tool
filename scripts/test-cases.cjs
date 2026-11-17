/* 用例解析冒烟测试：直接跑真实用例目录，检查两种格式解析结果 */
const { scanCases } = require('../electron/cases.js');

const ROOT = process.env.CASES_ROOT || 'D:\\AI_Workspace\\test_cases';
const res = scanCases(ROOT, {});
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

console.log('root =', res.root);
console.log('files =', res.totalFiles, ' cases =', res.totalCases, ' errors =', res.errors.length);
if (res.errors.length) console.log(res.errors.slice(0, 5));

// 按特征找，不写死文件名：用例目录会持续新增文件
const byName = (re) => res.files.find((f) => re.test(f.name));
const stdFile = byName(/商家门户重构.*混合.*修正版\.md$/) || byName(/混合.*修正版\.md$/);
const chainFile = byName(/极简链路/);
check('找到标准 TC 文件', !!stdFile, res.files.map((f) => f.name).slice(0, 5));
if (stdFile) {
  check('标准 TC 解析出 ≥50 条用例', stdFile.cases.length >= 50, stdFile.cases.length);
  const c = stdFile.cases[0];
  check('标准 TC 提取风险等级', !!c.risk, c.risk);
  check('标准 TC 提取类型', !!c.type, c.type);
  check('标准 TC 识别核心路径 🛤️', c.corePath === true, c.corePath);
  check('标准 TC 提取模块', !!c.module, c.module);
  check('标准 TC 提取分支', !!c.branch, c.branch);
  check('标准 TC 前置项 ≥1', c.pre.length >= 1, c.pre);
  check('标准 TC 操作非空', c.steps.length >= 1, c.steps);
  check('标准 TC 预期含结果1/结果2', c.expects.length >= 2, c.expects.map((e) => e.text.slice(0, 12)));
  check('标准 TC 断言迹拆成 3 维', c.assertions.length >= 3, c.assertions);
  check('标准 TC 断言含 UI 维', c.assertions.some((a) => a.dim === 'UI'), c.assertions);
  check('标准 TC 断言含 API 维', c.assertions.some((a) => a.dim === 'API'), c.assertions);
  check('标准 TC 覆盖规则提取到规则号', c.covers.length >= 1 && /^R\d/.test(c.covers[0]), c.covers);
  check('标准 TC 标题不带标签', c.title.indexOf('[') < 0 && c.title.indexOf('🛤') < 0, c.title);
  console.log('\n[标准 TC 第一条]');
  console.log(JSON.stringify(c, null, 1).slice(0, 1400));
}

check('找到极简链路文件', !!chainFile);
if (chainFile) {
  check('极简链路解析出 5 条链路', chainFile.cases.length === 5, chainFile.cases.length);
  const c = chainFile.cases[0];
  check('极简链路 kind=chain', c.kind === 'chain', c.kind);
  check('极简链路 id=C1', c.id === 'C1', c.id);
  check('极简链路识别冒烟标签', c.tags.indexOf('冒烟') >= 0, c.tags);
  check('极简链路前置非空', c.pre.length >= 1, c.pre);
  check('极简链路操作步骤 ≥5', c.steps.length >= 5, c.steps.length);
  check('极简链路预期 ≥4', c.expects.length >= 4, c.expects.length);
  check('极简链路检查项 ≥3', c.checklist.length >= 3, c.checklist);
  check('极简链路覆盖流程已记', c.chainMeta.some((m) => m.indexOf('覆盖回归流程') >= 0), c.chainMeta);
  check('极简链路标题干净', c.title.indexOf('[冒烟]') < 0, c.title);
  console.log('\n[极简链路 C1]');
  console.log(JSON.stringify(c, null, 1).slice(0, 1400));
}

const noCase = res.files.filter((f) => f.kind === 'doc');
check('默认不返回纯文档文件', noCase.length === 0, noCase.length);

const withDocs = scanCases(ROOT, { includeDocs: true });
check('includeDocs 能返回全部 md', withDocs.totalFiles > res.totalFiles, { all: withDocs.totalFiles, casesOnly: res.totalFiles });

const failed = results.filter((r) => !r.ok);
console.log('\n===== 解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));

// ---------- 目录树（一级目录 / 二级文件名） ----------
const { buildCaseTree, inScope, ROOT_LABEL } = require('../shared/caseTree.js');
const tree = buildCaseTree(res.files);
check('目录树一级 = 目录数', tree.length === new Set(res.files.map((f) => f.dir || ROOT_LABEL)).size, tree.map((d) => d.name));
check('二级 = 该目录下的用例文件', tree.every((d) => d.files.length >= 1 && d.files.every((f) => f.name && f.relPath)), tree.map((d) => [d.name, d.files.length]));
check('二级条数之和 = 一级条数', tree.every((d) => d.files.reduce((s, f) => s + f.count, 0) === d.count), tree.map((d) => [d.name, d.count]));
check('全部条数之和 = totalCases', tree.reduce((s, d) => s + d.count, 0) === res.totalCases, { sum: tree.reduce((s, d) => s + d.count, 0), total: res.totalCases });
check('目录按条数从多到少', tree.every((d, i) => i === 0 || tree[i - 1].count >= d.count), tree.map((d) => d.count));
check('同一目录下文件按文件名排序', tree.every((d) => d.files.every((f, i) => i === 0 || d.files[i - 1].name.localeCompare(f.name, 'zh-Hans-CN') <= 0)));
check('根目录文件归到「（根目录）」而不是空名', (() => {
  const t = buildCaseTree([{ relPath: 'a.md', name: 'a.md', dir: '', cases: [{}] }]);
  return t.length === 1 && t[0].name === ROOT_LABEL && t[0].count === 1;
})(), buildCaseTree([{ relPath: 'a.md', name: 'a.md', dir: '', cases: [{}] }]));
check('同一目录下多份文件各自成二级（不合并）', (() => {
  const t = buildCaseTree([
    { relPath: '洗车卡券/TC_新人券模块_20250109.md', name: 'TC_新人券模块_20250109.md', dir: '洗车卡券', cases: [{}, {}] },
    { relPath: '洗车卡券/TC_洗车卡券_核销_20250210.md', name: 'TC_洗车卡券_核销_20250210.md', dir: '洗车卡券', cases: [{}] }
  ]);
  const names = t[0].files.map((f) => f.name);
  return t.length === 1 && t[0].name === '洗车卡券' && t[0].count === 3 && t[0].files.length === 2 &&
    names.indexOf('TC_新人券模块_20250109.md') >= 0 && names.indexOf('TC_洗车卡券_核销_20250210.md') >= 0;
})(), buildCaseTree([{ relPath: 'x/y.md', name: 'y.md', dir: 'x', cases: [{}] }]));

const f1 = { relPath: '洗车卡券/TC_新人券模块_20250109.md', dir: '洗车卡券' };
const f2 = { relPath: '洗车卡券/TC_洗车卡券_核销.md', dir: '洗车卡券' };
const f3 = { relPath: 'a.md', dir: '' };
check('不选目录 = 全都要', inScope(f1, '', '') && inScope(f3, '', ''));
check('选目录 = 整个目录', inScope(f1, '洗车卡券', '') && inScope(f2, '洗车卡券', '') && !inScope(f3, '洗车卡券', ''));
check('选文件 = 只看那个文件', inScope(f1, '洗车卡券', f1.relPath) && !inScope(f2, '洗车卡券', f1.relPath));
check('文件筛选优先于目录（不会自相矛盾）', inScope(f1, '别的目录', f1.relPath) === true);
check('根目录筛选能命中根文件', inScope(f3, ROOT_LABEL, '') && !inScope(f1, ROOT_LABEL, ''));
check('空 files / 脏数据不抛异常', (() => {
  try {
    buildCaseTree(null);
    buildCaseTree([null, { cases: [] }]);
    return true;
  } catch (e) {
    return false;
  }
})());

const failed2 = results.filter((r) => !r.ok);
console.log('\n===== 解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed2.length) + '/' + results.length + ' passed');
process.exit(failed2.length ? 1 : 0);