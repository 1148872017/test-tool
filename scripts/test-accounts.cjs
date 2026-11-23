/* 账号合并进站点：加密嵌套路径 + 解析/序列化 + 一键启动选账号逻辑 */
const fs = require('fs');
const path = require('path');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 集合结构 ---------- */
const collections = require('../shared/collections.js');
const sites = collections.COLLECTION_MAP.sites;

check('accounts 集合已删除', !collections.COLLECTION_MAP.accounts, Object.keys(collections.COLLECTION_MAP));
check('sites 有 accounts 字段', sites.fields.some((f) => f.key === 'accounts'), sites.fields.map((f) => f.key));
check('sites 不再有顶层 account', !sites.fields.some((f) => f.key === 'account'), sites.fields.map((f) => f.key));
check('sites 不再有顶层 password', !sites.fields.some((f) => f.key === 'password'), sites.fields.map((f) => f.key));

/* ---------- 2. 加密路径 ---------- */
const secretKeys = collections.SECRET_KEYS.sites || [];
check('SECRET_KEYS 含嵌套路径', secretKeys.indexOf('accounts[].password') >= 0, secretKeys);

/* ---------- 3. applySecretPath 逻辑（从 store.js 提取）---------- */
const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
check('store 有 applySecretPath', /function applySecretPath/.test(storeSrc), 'no applySecretPath');
check('支持数组路径正则', /\\\[\\\]\\\./.test(storeSrc), 'no array path regex');
check('serialize 用 applySecretPath', /applySecretPath\(out, key, encrypt\)/.test(storeSrc), 'serialize not using it');
check('deserialize 用 applySecretPath', /applySecretPath\(out, key, decrypt\)/.test(storeSrc), 'deserialize not using it');
check('serialize 深拷贝（不改调用方）', /JSON\.parse\(JSON\.stringify/.test(storeSrc), 'no deep clone');

/* ---------- 4. AccountsEditor 纯函数 ---------- */
const tsx = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AccountsEditor.tsx'), 'utf8');
const cut = tsx.indexOf('export default function AccountsEditor');
const pure = tsx
  .slice(0, cut)
  .replace(/^import .*$/gm, '')
  .replace(/export function/g, 'function')
  // 去掉 JSX 组件（RoleTags 里有 JSX，转译会失败）
  .replace(/function RoleTags[\s\S]*?\n}\n/, '');

const out = esbuild.transformSync(pure + '\nmodule.exports = { parseAccounts, serializeAccounts };', {
  loader: 'tsx',
  format: 'cjs'
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
const { parseAccounts, serializeAccounts } = mod.exports;

// 解析
const rows = parseAccounts(
  JSON.stringify([
    { label: '管理员', account: 'admin', password: 'p1', role: ['admin'], isDefault: true, note: 'n1' },
    { label: '商家', account: 'shop', password: 'p2', role: ['merchant'], isDefault: false, note: '' }
  ])
);
check('解析：2 个账号', rows.length === 2, rows.length);
check('解析：label 正确', rows[0].label === '管理员' && rows[1].label === '商家', rows.map((r) => r.label));
check('解析：role 是数组', Array.isArray(rows[0].role) && rows[0].role[0] === 'admin', rows[0].role);
check('解析：isDefault 正确', rows[0].isDefault === true && rows[1].isDefault === false, rows.map((r) => r.isDefault));

// 边界
check('解析：空字符串返回空数组', parseAccounts('').length === 0);
check('解析：null 不崩', parseAccounts(null).length === 0);
check('解析：坏 JSON 返回空数组', parseAccounts('[{bad').length === 0);
check('解析：非数组返回空数组', parseAccounts('{"a":1}').length === 0);

// 序列化
const s1 = serializeAccounts(rows);
check('序列化：是 JSON 数组', s1.startsWith('['), s1.slice(0, 20));
check('序列化：能反解', parseAccounts(s1).length === 2, parseAccounts(s1).length);
check('序列化：空数组返回空串', serializeAccounts([]) === '', serializeAccounts([]));

// 往返
const round = parseAccounts(serializeAccounts(rows));
check('往返：内容一致', round[0].account === 'admin' && round[1].role[0] === 'merchant', round);

/* ---------- 5. 一键启动选账号逻辑 ---------- */
// 从 CollectionPage 源码检查逻辑分支
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CollectionPage.tsx'), 'utf8');
check('openSite 用 parseAccounts', /const accounts = parseAccounts/.test(pageSrc), 'no parseAccounts');
check('优先默认账号', /accounts\.find\(\(a\) => a\.isDefault\)/.test(pageSrc), 'no default find');
check('唯一账号自动用', /accounts\.length === 1/.test(pageSrc), 'no single auto');
check('多个弹窗选', /pickAccount\(accounts\)/.test(pageSrc), 'no picker');
check('没有账号只打开', /这个站点还没记账号/.test(pageSrc), 'no empty hint');
check('有选账号弹窗', /accountPicker/.test(pageSrc), 'no picker state');

/* ---------- 6. 角色标签显式表达 ---------- */
check('AccountsEditor 有 RoleTags', /function RoleTags/.test(tsx), 'no RoleTags');
check('RoleTags 用 fieldOptions 映射', /fieldOptions/.test(tsx), 'no role mapping');
check('只读表格有角色列', /<th[^>]*>角色<\/th>/.test(tsx), 'no role column');
check('选账号弹窗显示角色', /ROLE_OPTIONS\.find/.test(pageSrc), 'picker no role');

/* ---------- 7. 迁移 ---------- */
const migSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'migrations.js'), 'utf8');
check('SCHEMA_VERSION 是 5', /SCHEMA_VERSION = 5/.test(migSrc), 'not 5');
check('有 v5 迁移', /to: 5/.test(migSrc), 'no v5');
check('v5 迁移 accounts 到 sites', /api\.records\('accounts'\)/.test(migSrc), 'no accounts read');
check('v5 删掉 accounts 集合', /DELETE FROM records WHERE collection = 'accounts'/.test(migSrc), 'no delete');
check('v5 保证有默认账号', /isDefault = true/.test(migSrc), 'no default');
check('v5 处理无归属站点的账号', /未归类账号/.test(migSrc), 'no orphan handling');
check('v5 去重（同 account+role 只留一条）', /const seen = new Set\(\)/.test(migSrc) && /seen\.has\(key\)/.test(migSrc), 'no dedup');
check('v5 新建记录用 INSERT 不用 write', /INSERT INTO records/.test(migSrc), 'no INSERT');


/* ---------- 8. 列表页只显示默认账号 ---------- */
const pageSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CollectionPage.tsx'), 'utf8');
check('列表渲染有 accounts 分支', /f\.type === 'accounts'/.test(pageSrc2), 'no accounts branch');
check('列表只取默认账号', /list\.find\(\(a\) => a\.isDefault\)/.test(pageSrc2), 'no default pick');
check('列表有「+N」更多提示', /account-cell-more/.test(pageSrc2), 'no more badge');
check('账号单元格单行省略', /account-cell-account/.test(pageSrc2), 'no ellipsis class');
check('完整信息放 Tooltip', /另有 \$\{more\} 个账号/.test(pageSrc2), 'no tooltip detail');
check('sites 名称列收窄到 32%', /conf\.key === 'sites' \? 32/.test(pageSrc2), 'title width not adjusted');
check('accounts 字段加权', /accounts: 2\.2/.test(pageSrc2), 'no weight');
check('账号单元格单行省略', /account-cell-account/.test(pageSrc2), 'no ellipsis class');

/* ---------- 9. 角色选项从配置读（不是空数组）---------- */
const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AccountsEditor.tsx'), 'utf8');
check('AccountsEditor 不再用 ROLE_OPTIONS', !/ROLE_OPTIONS/.test(editorSrc), 'still uses ROLE_OPTIONS');
check('AccountsEditor 用 fieldOptions', /fieldOptions/.test(editorSrc), 'no fieldOptions');
check('AccountsEditor 加载 opts', /loadOptions\(\)/.test(editorSrc), 'no loadOptions');
check('角色下拉用 roleOptions', /options=\{roleOptions\}/.test(editorSrc), 'no roleOptions');
check('RoleTags 接收 opts', /RoleTags.*opts/.test(editorSrc), 'no opts prop');

/* ---------- 10. 详情页账号列表是 6 列 ---------- */
check('只读表格有 6 列（th 数 = 6）', (editorSrc.match(/<th[ >]/g) || []).length === 6, (editorSrc.match(/<th[ >]/g) || []).length);
check('表格有「密码」列', /<th[^>]*>密码<\/th>/.test(editorSrc), 'no password col');
check('表格有「默认」列', /<th[^>]*>默认<\/th>/.test(editorSrc), 'no default col');
check('表格有「角色」列', /<th[^>]*>角色<\/th>/.test(editorSrc), 'no role col');

/* ---------- 11. 导出时嵌套密码也要清空 ---------- */
const storeSrc2 = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
check('exportAll 用 applySecretPath 清空', /applySecretPath\(data, key, \(\) => ''\)/.test(storeSrc2), 'export not using applySecretPath');
check('exportAll 深拷贝', /JSON\.parse\(JSON\.stringify\(r\.data/.test(storeSrc2), 'export no deep clone');


/* ---------- 12. 空账号不保存（问题 5）---------- */
const editorSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AccountsEditor.tsx'), 'utf8');
const serBody = (editorSrc2.match(/export function serializeAccounts[\s\S]*?\n}/) || [''])[0];
check('serializeAccounts 不过滤（编辑时）', !/rows\.filter/.test(serBody), 'still filtering');
check('有 dropEmptyAccounts（保存时清理）', /export function dropEmptyAccounts/.test(editorSrc2), 'no dropEmptyAccounts');
check('序列化保证有默认账号', /if \(!hasDefault\) out\[0\]/.test(editorSrc2), 'no default guarantee');

// 纯函数验证：空账号被过滤
const emptyRows = [{ label: '', account: '', password: '', role: [], isDefault: true, note: '' }];
// 编辑时：空行必须保留（否则「添加账号」点了没反应）
check('编辑时空行保留（能加进去）', serializeAccounts(emptyRows) !== '', serializeAccounts(emptyRows));
check('编辑时空行能反解', parseAccounts(serializeAccounts(emptyRows)).length === 1, parseAccounts(serializeAccounts(emptyRows)));

const filledRows = [{ label: '', account: 'admin', password: '', role: [], isDefault: false, note: '' }];
check('填了账号就保留', serializeAccounts(filledRows) !== '', serializeAccounts(filledRows));
check('保留时自动设默认', parseAccounts(serializeAccounts(filledRows))[0].isDefault === true, parseAccounts(serializeAccounts(filledRows)));

const roleOnly = [{ label: '', account: '', password: '', role: ['admin'], isDefault: false, note: '' }];
check('只填角色也保留', serializeAccounts(roleOnly) !== '', serializeAccounts(roleOnly));

/* ---------- 13. 添加/删除账号有提示（问题 3）---------- */
check('addRow 有 toast 提示', /toast\('已添加一个账号/.test(editorSrc2), 'no add toast');
check('removeRow 有 toast 提示', /toast\('已删除该账号/.test(editorSrc2), 'no remove toast');

/* ---------- 14. 表单重开强制重置（问题 4）---------- */
const pageSrc3 = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CollectionPage.tsx'), 'utf8');
check('RecordForm 有 key 强制重挂载', /key=\{.*formSeq/.test(pageSrc3), 'no key');
check('有 formSeq 状态', /const \[formSeq, setFormSeq\]/.test(pageSrc3), 'no formSeq');
check('打开表单时 formSeq +1', /setFormSeq\(\(n\) => n \+ 1\)/.test(pageSrc3), 'no increment');

/* ---------- 15. 导入导出同步调整（问题 2）---------- */
const storeSrc3 = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
check('导出用 applySecretPath 清空嵌套密码', /applySecretPath\(data, key, \(\) => ''\)/.test(storeSrc3), 'export not fixed');
check('导入用 serialize 加密', /JSON\.stringify\(serialize\(item\.collection/.test(storeSrc3), 'import not encrypting');


/* ---------- 16. dropEmptyAccounts（保存时清理）---------- */
check('有 dropEmptyAccounts 导出', /export function dropEmptyAccounts/.test(editorSrc2), 'no export');

// 从源码提取 dropEmptyAccounts 测试
const pure2 = editorSrc2
  .slice(0, editorSrc2.indexOf('export default function AccountsEditor'))
  .replace(/^import .*$/gm, '')
  .replace(/export function/g, 'function')
  .replace(/function RoleTags[\s\S]*?\n}\n/, '');
const out2 = esbuild.transformSync(pure2 + '\nmodule.exports = { parseAccounts, serializeAccounts, dropEmptyAccounts };', {
  loader: 'tsx',
  format: 'cjs'
});
const mod2 = { exports: {} };
new Function('module', 'exports', 'require', out2.code)(mod2, mod2.exports, require);
const { dropEmptyAccounts } = mod2.exports;

check('dropEmptyAccounts：全空返回空串', dropEmptyAccounts(JSON.stringify([{ label: '', account: '', password: '', role: [], isDefault: true, note: '' }])) === '', 'not empty');
check('dropEmptyAccounts：有账号保留', dropEmptyAccounts(JSON.stringify([{ label: '', account: 'admin', password: '', role: [], isDefault: true, note: '' }])) !== '', 'dropped');
check('dropEmptyAccounts：只填备注保留', dropEmptyAccounts(JSON.stringify([{ label: '', account: '', password: '', role: [], isDefault: false, note: '备注' }])) !== '', 'dropped');
check('dropEmptyAccounts：只填角色保留', dropEmptyAccounts(JSON.stringify([{ label: '', account: '', password: '', role: ['admin'], isDefault: false, note: '' }])) !== '', 'dropped');
check('dropEmptyAccounts：混合时只留非空', parseAccounts(dropEmptyAccounts(JSON.stringify([
  { label: '', account: '', password: '', role: [], isDefault: true, note: '' },
  { label: '管理员', account: 'admin', password: 'p', role: [], isDefault: false, note: '' }
]))).length === 1, 'wrong count');

/* ---------- 17. 保存时调用 dropEmptyAccounts ---------- */
const formSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RecordForm.tsx'), 'utf8');
check('RecordForm 保存时清理空账号', /dropEmptyAccounts\(String\(payload\[f\.key\]\)\)/.test(formSrc), 'not called');
check('RecordForm 用 payload 保存', /data: payload/.test(formSrc), 'not using payload');


/* ---------- 18. 搜索排除密码（问题 1）---------- */
const storeSrc4 = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
check('有 searchableDataExpr', /function searchableDataExpr/.test(storeSrc4), 'no helper');
check('搜索用 searchableDataExpr', /searchableDataExpr\(collection\)/.test(storeSrc4), 'not used');
check('用 json_set 置空密码', /json_set\(data/.test(storeSrc4), 'no json_set');
check('嵌套数组字段整体排除', /split\('\[\]'\)\[0\]/.test(storeSrc4), 'no nested handling');

/* ---------- 19. openUrl 自动补协议（问题 2）---------- */
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('openUrl 自动补 https', /u = 'https:\/\/' \+ u/.test(mainSrc), 'no auto protocol');
check('openUrl 仍限制 http/https', /if \(!\/\^https\?:/.test(mainSrc), 'no protocol guard');
check('openUrl 去掉多余斜杠', mainSrc.indexOf("replace(/^\\/+/") >= 0, 'no slash trim');

/* ---------- 20. 备注/标签双模式（问题 3）---------- */
const editorSrc3 = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AccountsEditor.tsx'), 'utf8');
check('AccountRow 有 tags 字段', /tags: string\[\]/.test(editorSrc3), 'no tags field');
check('parseAccounts 解析 tags', /tags: Array\.isArray\(x\.tags\)/.test(editorSrc3), 'not parsed');
check('备注填了则标签禁用', /disabled=\{r\.tags\.length > 0\}/.test(editorSrc3), 'note not disabled');
check('标签选了则备注禁用', /disabled=\{String\(r\.note \|\| ''\)\.trim\(\)\.length > 0\}/.test(editorSrc3), 'tags not disabled');
check('标签用 mode=tags（可自定义）', /mode="tags"/.test(editorSrc3), 'no tags mode');
check('表头是「备注 / 标签」', /备注 \/ 标签/.test(editorSrc3), 'no header');
check('dropEmptyAccounts 把 tags 算非空', /Array\.isArray\(r\.tags\) && r\.tags\.length/.test(editorSrc3), 'tags not counted');


/* ---------- 21. 前端搜索也排除密码（关键：之前漏了）---------- */
const pageSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CollectionPage.tsx'), 'utf8');
check('前端有 searchableText 函数', /function searchableText/.test(pageSrc4), 'no searchableText');
check('前端搜索用 searchableText', /searchableText\(r\.data/.test(pageSrc4), 'not used');
check('前端不再直接 JSON.stringify(data)', !/JSON\.stringify\(r\.data \|\| \{\}\)/.test(pageSrc4), 'still stringify');
check('searchableText 排除 password', /ik === 'password'/.test(pageSrc4), 'no password exclusion');
check('searchableText 排除顶层 password', /k === 'password'/.test(pageSrc4), 'no top-level exclusion');

/* ---------- 22. 后端搜索排除密码 ---------- */
check('后端用 json_set 置空', /json_set\(data/.test(storeSrc4), 'no json_set');
check('后端排除嵌套数组字段', /split\('\[\]'\)\[0\]/.test(storeSrc4), 'no nested exclusion');

const failed = results.filter((r) => !r.ok);
console.log('===== 账号合并测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
