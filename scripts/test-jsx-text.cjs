/* JSX 文本里的裸 ${} 会导致运行时 ReferenceError（踩过一次） */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/**
 * 扫「JSX 文本节点里的裸 ${...}」。
 *
 * 判定（全部满足才算危险）：
 *   1. 行内有 ${ 或 ${xxx}
 *   2. 行内没有反引号 `（模板字符串是安全的）
 *   3. 行内没有单/双引号（字符串字面量是安全的）
 *   4. 行内没有 JSX 标签（< >）
 *   5. 不是注释行
 *
 * 这是踩坑 #95 的回归防线：
 *   esbuild 把 JSX 文本里的 ${} 转成模板字符串 → 运行时 ReferenceError。
 */
function findBadLines(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/\$\{/.test(l)) continue;
    // 有反引号 / 引号 → 是 JS 字符串或模板字符串，安全
    if (/[`'"]/.test(l)) continue;
    // 有 JSX 标签 → 是标签行，不是纯文本
    if (/[<>]/.test(l)) continue;
    // 注释
    if (/^\s*(\/\/|\*|\/\*|\{?\/\*)/.test(l)) continue;
    out.push({ line: i + 1, text: l.trim() });
  }
  return out;
}

const srcRoot = path.join(__dirname, '..', 'src');
const files = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (/\.tsx$/.test(ent.name)) files.push(full);
  }
})(srcRoot);

check('扫到了 tsx 文件', files.length > 0, files.length);

let badTotal = 0;
const badDetail = [];
for (const f of files) {
  const bad = findBadLines(f);
  if (bad.length) {
    const rel = path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');
    for (const b of bad) badDetail.push(rel + ':' + b.line + ' ' + b.text.slice(0, 70));
    badTotal += bad.length;
  }
}
check('JSX 文本里没有裸 ${}', badTotal === 0, badDetail);

/* 反向验证：故意的坏样本能被抓出来 */
{
  const tmp = path.join(require('os').tmpdir(), 'jsx-dollar-test.tsx');
  fs.writeFileSync(tmp, '<div>\n  请求里用 ${变量名} 引用\n</div>\n', 'utf8');
  const bad = findBadLines(tmp);
  check('能抓住裸 ${} 的坏样本', bad.length === 1, bad);
  fs.rmSync(tmp, { force: true });
}

/* 反向验证：合法写法不误报 */
{
  const tmp = path.join(require('os').tmpdir(), 'jsx-dollar-ok.tsx');
  fs.writeFileSync(
    tmp,
    [
      '<div>',
      "  {'请求里用 ${变量名} 引用'}",
      '  {`动态 ${x} 值`}',
      "  <span title={'${y}'} />",
      '  toast(`已导入 ${n} 条`);',
      '</div>'
    ].join('\n'),
    'utf8'
  );
  const bad = findBadLines(tmp);
  check('合法写法不误报', bad.length === 0, bad);
  fs.rmSync(tmp, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log('===== JSX ${} 检查 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);