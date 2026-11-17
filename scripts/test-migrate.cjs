/* 数据结构升级测试：造一个 v1 老库，跑真实迁移（v2 回填环境、v3 建关联表），再注入一条 v4 重命名迁移，
   验证升级 / 备份 / 未知字段保留。
   注意：注入的版本号必须比真实 SCHEMA_VERSION 大，否则会跟真实迁移撞号。 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), 'tt-migrate-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

// --- stub electron（store -> security 需要 safeStorage） ---
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
      }
    };
  }
  return origLoad.apply(this, arguments);
};

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

(async () => {
  // --- 1. 造一个「旧版」数据库：schemaVersion=1，字段还是 account，另带一个未知字段 ---
  const initSqlJs = require(path.join(proj, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve(path.join(proj, 'node_modules', 'sql.js'))), f) });
  const legacy = new SQL.Database();
  legacy.run(SCHEMA);
  legacy.run(
    'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'r_legacy1',
      'sites',
      '老站A',
      JSON.stringify({ name: '老站A', env: 'test', account: 'old_admin', url: 'https://old.test.local', legacyExtra: '要保住的字段' }),
      '老标签',
      1,
      Date.now() - 86400000,
      Date.now() - 86400000
    ]
  );
  // 老账号：没有 env 字段，只关联了站点 —— v2 迁移应该按站点把环境回填成 test
  legacy.run(
    'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'r_legacy_acc',
      'accounts',
      '老账号',
      JSON.stringify({ name: '老账号', role: '只读', account: 'legacy_user', site: 'r_legacy1' }),
      '',
      0,
      Date.now() - 86400000,
      Date.now() - 86400000
    ]
  );
  legacy.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', '1']);
  fs.writeFileSync(path.join(tmp, 'data.db'), Buffer.from(legacy.export()));
  legacy.close();

  // --- 2. 真实迁移（v2 环境回填 + v3 建关联表）之外，再注入一条 v4 把 account 改名 username ---
  const migrations = require(path.join(proj, 'electron', 'migrations'));
  check('真实迁移里有 v2（环境回填）', migrations.MIGRATIONS.some((m) => m.to === 2), migrations.MIGRATIONS.map((m) => m.to));
  migrations.MIGRATIONS.push({
    to: 4,
    note: 'account → username',
    run(api) {
      for (const rec of api.records('sites')) {
        if (rec.data.username === undefined) rec.data.username = rec.data.account || '';
        delete rec.data.account;
        api.write(rec);
      }
    }
  });
  migrations.SCHEMA_VERSION = 4;

  const store = require(path.join(proj, 'electron', 'store'));
  const info = await store.init(tmp);

  // --- 3. 断言 ---
  check('版本号升到 4', store.schemaVersion() === 4, store.schemaVersion());
  check('迁移前自动备份了一份', !!info.migration && /data-before-v1-/.test(info.migration.backupFile || ''), info.migration);
  check('备份文件确实存在', !!(info.migration && fs.existsSync(info.migration.backupFile)));

  const rec = store.get('r_legacy1');
  check('字段已改名 account→username', rec && rec.data.username === 'old_admin' && rec.data.account === undefined, rec && rec.data);
  check('未知字段被保留', rec && rec.data.legacyExtra === '要保住的字段', rec && rec.data);
  check('标题没被改坏', rec && rec.title === '老站A', rec && rec.title);
  check('标签没丢', rec && rec.tags[0] === '老标签', rec && rec.tags);

  const acc = store.get('r_legacy_acc');
  check('老账号按所属站点回填了环境', acc && Array.isArray(acc.data.env) && acc.data.env[0] === 'test', acc && acc.data);
  check('v4 把 env 从字符串变成数组', Array.isArray(rec.data.env) && rec.data.env[0] === 'test', rec.data.env);
  check('v4 把角色从字符串变成数组', Array.isArray(acc.data.role) && acc.data.role[0] === '只读', acc.data.role);
  const optsAfter = store.getOptions();
  check('v4 把历史环境值收进选项配置', optsAfter.env.some((o) => o.value === 'test'), optsAfter.env);
  check('v4 把历史角色收进选项配置', optsAfter.role.indexOf('只读') >= 0, optsAfter.role);
  check('v4 把历史标签收进选项配置', optsAfter.tags.indexOf('老标签') >= 0, optsAfter.tags);

  // 编辑保存时，只提交 schema 里的字段，未知字段也要活着
  store.save({ id: 'r_legacy1', collection: 'sites', data: { name: '老站A-改', url: 'https://old.test.local' }, tags: ['老标签'], favorite: true });
  const rec2 = store.get('r_legacy1');
  check('编辑后未知字段仍在', rec2.data.legacyExtra === '要保住的字段' && rec2.data.username === 'old_admin', rec2.data);
  check('编辑后新值生效', rec2.title === '老站A-改', rec2.title);

  // 迁移前备份不会被每日备份的「只留 10 份」清掉
  const beforeName = path.basename(info.migration.backupFile);
  for (let i = 0; i < 12; i++) store.backup();
  const stillThere = fs.existsSync(path.join(tmp, 'backups', beforeName));
  check('迁移前备份不会被轮转删除', stillThere, beforeName);
  const daily = fs.readdirSync(path.join(tmp, 'backups')).filter((f) => /^data-\d{4}-/.test(f));
  check('每日备份只保留 10 份', daily.length <= 10, daily.length);

  // 全新库直接就是当前版本，不跑迁移
  const freshDir = path.join(tmp, 'fresh');
  const store2 = require(path.join(proj, 'electron', 'store'));
  await store2.init(freshDir);
  check('新库版本号即当前版本', store2.schemaVersion() === 4, store2.schemaVersion());
  check('新库不产生迁移备份', !fs.existsSync(path.join(freshDir, 'backups')) || fs.readdirSync(path.join(freshDir, 'backups')).every((f) => !/data-before-/.test(f)));

  store.close();
  store2.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 数据结构升级测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});