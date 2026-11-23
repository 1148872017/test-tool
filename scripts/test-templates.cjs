/* 脚本模板库测试：结构完整性 + 代码质量检查 */
const { NO_CODE_NEEDED, TEMPLATES } = require('../shared/scriptTemplates.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 结构 ---------- */
check('有「不用写代码」对照表', Array.isArray(NO_CODE_NEEDED) && NO_CODE_NEEDED.length >= 6, NO_CODE_NEEDED.length);
check('对照表每项都有 need/use/how', NO_CODE_NEEDED.every((r) => r.need && r.use && r.how), NO_CODE_NEEDED.filter((r) => !r.need || !r.use || !r.how));
check('模板数量 >= 8', TEMPLATES.length >= 8, TEMPLATES.length);

const ids = TEMPLATES.map((t) => t.id);
check('模板 id 唯一', new Set(ids).size === ids.length, ids);

const required = ['id', 'name', 'when', 'where', 'code', 'gotcha'];
for (const t of TEMPLATES) {
  const missing = required.filter((k) => !t[k]);
  check(`模板「${t.name}」字段完整`, missing.length === 0, missing);
}

/* ---------- 代码质量 ---------- */
for (const t of TEMPLATES) {
  // 不能有 markdown 粗体标记（界面上不渲染）
  check(`模板「${t.name}」没有 markdown 标记`, !/\*\*/.test(t.when) && !/\*\*/.test(t.code), t.when.slice(0, 40));

  // 代码里必须有注释（这是模板库的核心价值）
  check(`模板「${t.name}」代码带注释`, /\/\//.test(t.code), t.code.slice(0, 60));

  // 必须有「可改位置」的指引：要么是 {{变量}} 占位符，要么是「改成你的」注释
  const hasPlaceholder = /\{\{[^}]+\}\}/.test(t.code);
  const hasGuide = /改成你的|↓|改成你|复制时填/.test(t.code);
  check(`模板「${t.name}」标了要改哪里`, hasPlaceholder || hasGuide, t.code.slice(0, 80));

  // 不能有 macOS 路径（用户踩过这个坑）
  check(`模板「${t.name}」没有 macOS 路径`, !/\/Users\//.test(t.code), t.code.match(/\/Users\/[^\s"]*/));

  // 不能有单个反斜杠路径（会被当转义符）
  const badPath = /"[A-Za-z]:\\[^\\"]/.test(t.code);
  check(`模板「${t.name}」路径用 / 或 \\\\`, !badPath, t.code.match(/"[A-Za-z]:\\[^\\"]*/));
}

/* ---------- 关键模板存在 ---------- */
const need = ['assert-code', 'assert-body-contains', 'assert-json-field', 'extract-token', 'extract-write-file', 'read-file-to-var', 'random-data', 'sign-md5'];
for (const id of need) {
  check(`有模板 ${id}`, ids.indexOf(id) >= 0, ids);
}

/* ---------- Groovy 语法粗检 ---------- */
for (const t of TEMPLATES) {
  const code = t.code;
  // 括号配对（粗检，忽略字符串里的）
  const stripped = code.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/gm, '');
  const pairs = { '{': '}', '(': ')', '[': ']' };
  let ok = true;
  for (const [open, close] of Object.entries(pairs)) {
    const o = (stripped.match(new RegExp('\\' + open, 'g')) || []).length;
    const c = (stripped.match(new RegExp('\\' + close, 'g')) || []).length;
    if (o !== c) ok = false;
  }
  check(`模板「${t.name}」括号配对`, ok, { code: code.slice(0, 100) });
}

/* ---------- 内容正确性 ---------- */
const writeFile = TEMPLATES.find((t) => t.id === 'extract-write-file');
check('写文件模板用 append 而不是覆盖', /\.append\(/.test(writeFile.code), writeFile.code.match(/new File[^\n]*/));
check('写文件模板提示目录要存在', /目录要已存在|不会自动建目录/.test(writeFile.gotcha), writeFile.gotcha);

const jsonTpl = TEMPLATES.find((t) => t.id === 'assert-json-field');
check('JSON 模板用 Groovy 自带 JsonSlurper', /JsonSlurper/.test(jsonTpl.code), jsonTpl.code.slice(0, 80));
check('JSON 模板说明不用额外 jar', /不用 import 任何 jar|Groovy 自带/.test(jsonTpl.gotcha), jsonTpl.gotcha);

const tokenTpl = TEMPLATES.find((t) => t.id === 'extract-token');
check('token 模板区分 vars 和 props', /vars 是线程级|props 是全局/.test(tokenTpl.gotcha), tokenTpl.gotcha);

const randTpl = TEMPLATES.find((t) => t.id === 'random-data');
check('随机数模板提示内置函数更快', /__time|__Random|__UUID/.test(randTpl.gotcha), randTpl.gotcha);

/* ---------- 对照表质量 ---------- */
const noCodeUses = NO_CODE_NEEDED.map((r) => r.use);
check('对照表覆盖 JSON 提取器', noCodeUses.some((u) => /JSON 提取器/.test(u)), noCodeUses);
check('对照表覆盖响应断言', noCodeUses.some((u) => /响应断言/.test(u)), noCodeUses);
check('对照表覆盖持续时间断言', noCodeUses.some((u) => /持续时间断言/.test(u)), noCodeUses);
check('对照表覆盖 CSV', noCodeUses.some((u) => /CSV/.test(u)), noCodeUses);
check('对照表覆盖集合点', noCodeUses.some((u) => /同步定时器/.test(u)), noCodeUses);


/* ---------- 占位符 + vars（速填功能）---------- */

// 每个模板都必须有 vars 字段（速填弹窗靠它显示说明）
for (const t of TEMPLATES) {
  check(`模板「${t.name}」有 vars 字段`, Array.isArray(t.vars), typeof t.vars);
}

// 模板代码里的 {{变量}} 必须都能在 vars 里找到说明
for (const t of TEMPLATES) {
  const inCode = (t.code.match(/\{\{\s*([^{}]+?)\s*\}\}/g) || []).map((m) =>
    m.replace(/\{\{|\}\}/g, '').trim()
  );
  const inVars = (t.vars || []).map((v) => v.name);
  const missing = inCode.filter((n) => !inVars.includes(n));
  check(`模板「${t.name}」占位符都有说明`, missing.length === 0, missing);
}

// vars 里的每个变量都必须有 name 和 desc
for (const t of TEMPLATES) {
  const bad = (t.vars || []).filter((v) => !v.name || !v.desc);
  check(`模板「${t.name}」vars 都有 name/desc`, bad.length === 0, bad);
}

// 至少一半模板有占位符（说明速填功能真的用得上）
const withPlaceholder = TEMPLATES.filter((t) => /\{\{[^}]+\}\}/.test(t.code));
check('多数模板有 {{变量}} 占位符', withPlaceholder.length >= TEMPLATES.length / 2, withPlaceholder.length + '/' + TEMPLATES.length);

// 所有模板都有占位符（本次改造目标）
check('全部模板都有 {{变量}} 占位符', withPlaceholder.length === TEMPLATES.length, withPlaceholder.length + '/' + TEMPLATES.length);

const failed = results.filter((r) => !r.ok);
console.log('===== 脚本模板库测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
