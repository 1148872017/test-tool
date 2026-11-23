/* 安装器进程检测：必须用退出码，不能硬编码 tasklist 的提示文本 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');

/* ---------- 1. 必须用 find 的退出码 ---------- */
check('用 find 过滤 tasklist 输出', /tasklist[^']*\| find \/I/.test(nsh), 'no find pipe');
check('用退出码判断（StrCmp $R2 "0"）', /StrCmp \$R2 "0"/.test(nsh), 'no exit-code check');

/* ---------- 2. 不能硬编码 tasklist 的提示文本 ---------- */
// 这是 v0.26.13~0.29.0 的 bug：硬编码中文提示，英文系统 100% 误报
// 注意：只检查**非注释行**（注释里会提到这些文本作为说明）
const codeLines = nsh
  .split('\n')
  .filter((l) => !/^\s*;/.test(l))
  .join('\n');
check('不再硬编码中文提示', !/信息: 没有运行的任务匹配指定标准/.test(codeLines), 'still hardcoded Chinese');
check('不再硬编码英文提示', !/INFO: No tasks are running which match/.test(codeLines), 'still hardcoded English');

/* ---------- 3. 循环确认进程退出 ---------- */
check('taskkill 带 /t（连子进程）', /taskkill \/f \/im \$\{APP_EXECUTABLE_FILENAME\} \/t/.test(nsh), 'no /t');
check('有循环确认', /checkLoop:/.test(nsh) && /IntCmp \$R6 10/.test(nsh), 'no loop');

/* ---------- 4. 宏结构完整 ---------- */
const opens = (nsh.match(/!macro\s+\w+/g) || []).length;
const closes = (nsh.match(/!macroend/g) || []).length;
check('!macro 和 !macroend 数量一致', opens === closes, `${opens} vs ${closes}`);
check('有 customInit', /!macro customInit/.test(nsh), 'no customInit');
check('有 customInstall', /!macro customInstall/.test(nsh), 'no customInstall');
check('有 customFinishPage', /!macro customFinishPage/.test(nsh), 'no customFinishPage');

/* ---------- 5. 覆盖提示还在 ---------- */
check('有覆盖安装提示', /检测到「\$\{PRODUCT_NAME\}」已安装/.test(nsh), 'no overwrite prompt');

/* ---------- 6. 图标版本号用 VERSION 不是 APP_VERSION ---------- */
check('图标版本号用 VERSION', /!ifdef VERSION/.test(nsh), 'no VERSION ifdef');
check('不用不存在的 APP_VERSION', !/!ifdef APP_VERSION/.test(nsh), 'still uses APP_VERSION');

const failed = results.filter((r) => !r.ok);
console.log('===== 安装器进程检测测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
