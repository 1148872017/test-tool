/* 导入/导出按钮的 hover 提示 + 导出安全默认值 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const collSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CollectionPage.tsx'), 'utf8');
const setSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');

/* ============================================================
 * 1. 集合页：导入 / 导出都有 Tooltip
 * ============================================================ */
check('集合页用 Tooltip 包了导入按钮', /<Tooltip[\s\S]{0,600}?导入备份[\s\S]{0,60}?<\/Button>[\s\S]{0,20}?<\/Tooltip>/.test(collSrc), 'no tooltip');
check('集合页用 Tooltip 包了导出按钮', /<Tooltip[\s\S]{0,600}?导出[\s\S]{0,60}?<\/Button>[\s\S]{0,20}?<\/Tooltip>/.test(collSrc), 'no tooltip');

// 文案要说明「导入什么 / 导出什么」
check('导入提示说明是 JSON 备份', /从 JSON 备份文件/.test(collSrc), 'no desc');
check('导入提示说明是合并语义', /合并/.test(collSrc), 'no merge');
check('导入提示说明只认 json', /只认 \.json/.test(collSrc), 'no format');
check('导出提示带集合名和条数', /把「\{conf\.name\}」的[\s\S]{0,80}?条/.test(collSrc), 'no count');
check('导出提示说明存到哪', /存到桌面/.test(collSrc), 'no path');

/* ============================================================
 * 2. 集合导出默认不含密码（安全）
 * ============================================================ */
check('集合导出传 false（不含密码）', /api\.exportData\(false, conf\.key\)/.test(collSrc), 'still true');
check('不再传 true', !/api\.exportData\(true, conf\.key\)/.test(collSrc), 'still true');
check('导出提示写明不含密码', /不含密码明文/.test(collSrc), 'not stated');
check('导出提示指向设置页的含密码导出', /导出含密码/.test(collSrc), 'no pointer');

/* ============================================================
 * 3. 设置页：4 个按钮都有 Tooltip
 * ============================================================ */
const needTips = ['导出整库', '导出', '导出含密码', '导入'];
for (const label of needTips) {
  // 找这个按钮前面 800 字内有没有 <Tooltip
  const idx = setSrc.indexOf('>' + '\n                ' + label);
  const alt = setSrc.indexOf(label + '\n                </Button>');
  const pos = alt >= 0 ? alt : idx;
  const before = pos >= 0 ? setSrc.slice(Math.max(0, pos - 900), pos) : '';
  check('设置页「' + label + '」有 Tooltip', /<Tooltip/.test(before), 'no tooltip');
}

check('导出整库说明是 .db', /data\.db/.test(setSrc), 'no db mention');
check('导出整库说明可回滚', /回滚/.test(setSrc), 'no rollback');
check('导出说明不含密码', /不含密码明文/.test(setSrc), 'no mention');
check('导出含密码有风险提示', /别外发|别进 git/.test(setSrc), 'no warning');
check('导入说明 JSON/.db 区别', /合并/.test(setSrc) && /整库覆盖/.test(setSrc), 'no diff');

/* ============================================================
 * 4. 不只集合页，其他页面的 IO 按钮也该有提示（抽查）
 * ============================================================ */
// 有导入/导出按钮的页面清单
const ioPages = [
  { file: 'src/components/CollectionPage.tsx', name: '集合页' }
];
for (const p of ioPages) {
  const src = fs.readFileSync(path.join(__dirname, '..', p.file), 'utf8');
  const btnCount = (src.match(/>\s*导入备份\s*</g) || []).length + (src.match(/>\s*导出\s*</g) || []).length;
  const tipCount = (src.match(/<Tooltip/g) || []).length;
  check(p.name + ' Tooltip 数 ≥ 按钮数', tipCount >= btnCount, { tips: tipCount, btns: btnCount });
}

const failed = results.filter((r) => !r.ok);
console.log('===== 导入/导出提示测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);