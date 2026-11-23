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
check('RoleTags 用 ROLE_OPTIONS 映射', /ROLE_OPTIONS\.find/.test(tsx), 'no role mapping');
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

const failed = results.filter((r) => !r.ok);
console.log('===== 账号合并测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
