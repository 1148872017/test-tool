/* 数据结构升级测试：造一个 v1 老库，跑真实迁移（v2 回填环境、v3 建关联表、v4/v5 账号合并、v6 加回收站字段），
   再注入一条「改名」迁移，验证升级 / 备份 / 未知字段保留。
   注意：注入的版本号必须比真实 SCHEMA_VERSION 大，否则会跟真实迁移撞号。
   这里用 REAL_VERSION + 1 现算，以后 SCHEMA_VERSION 再涨也不用回来改数字。 */
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
  /**
   * 没有归属站点的账号（带密码）：
   *   v5 会为它新建一个「未归类账号」站点 —— 那条 INSERT 当初直接
   *   JSON.stringify(data)，把密码明文写进了 data.db（v0.43.0 修的 High）。
   *   这条记录专门用来验证「迁移新建站点也必须加密」。
   */
  legacy.run(
    'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'r_legacy_orphan',
      'accounts',
      '无站点账号',
      JSON.stringify({ name: '无站点账号', role: '读写', account: 'orphan_user', password: 'PlainOrphan123' }),
      '',
      0,
      Date.now() - 86400000,
      Date.now() - 86400000
    ]
  );
  legacy.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', '1']);
  fs.writeFileSync(path.join(tmp, 'data.db'), Buffer.from(legacy.export()));
  legacy.close();

  // --- 2. 真实迁移（v2~v6）之外，再注入一条「把 account 改名 username」的迁移 ---
  const migrations = require(path.join(proj, 'electron', 'migrations'));
  const REAL_VERSION = migrations.SCHEMA_VERSION;
  check('真实迁移里有 v2（环境回填）', migrations.MIGRATIONS.some((m) => m.to === 2), migrations.MIGRATIONS.map((m) => m.to));
  check('真实迁移里有 v6（回收站字段）', migrations.MIGRATIONS.some((m) => m.to === 6), migrations.MIGRATIONS.map((m) => m.to));
  check('真实迁移里有 v7（回扫明文密码）', migrations.MIGRATIONS.some((m) => m.to === 7), migrations.MIGRATIONS.map((m) => m.to));
  check('SCHEMA_VERSION 已经是 7', migrations.SCHEMA_VERSION === 7, migrations.SCHEMA_VERSION);
  migrations.MIGRATIONS.push({
    to: REAL_VERSION + 1,
    note: 'account → username（测试注入）',
    run(api) {
      for (const rec of api.records('sites')) {
        // 排在 v5 之后：v5 已经把账号搬进 accounts 数组、把 account 清空了，
        // 所以这里取「第一个账号」当用户名 —— 这条迁移的重点是验证
        // 「注入的迁移能按版本顺序跑 + 它写的新字段算未知字段」，不纠结取值。
        const first = (rec.data.accounts || [])[0] || {};
        if (rec.data.username === undefined || rec.data.username === '') {
          rec.data.username = rec.data.account || first.account || '';
        }
        delete rec.data.account;
        api.write(rec);
      }
    }
  });
  migrations.SCHEMA_VERSION = REAL_VERSION + 1;

  const store = require(path.join(proj, 'electron', 'store'));
  const info = await store.init(tmp);

  // --- 3. 断言 ---
  check('版本号升到 ' + (REAL_VERSION + 1), store.schemaVersion() === REAL_VERSION + 1, store.schemaVersion());
  check('迁移前自动备份了一份', !!info.migration && /data-before-v1-/.test(info.migration.backupFile || ''), info.migration);
  check('备份文件确实存在', !!(info.migration && fs.existsSync(info.migration.backupFile)));

  const rec = store.get('r_legacy1');
  // v5 会把 account/password 清空（留空字符串，不删 key），所以这里判「空」而不是 undefined
  check(
    '字段已改名 account→username',
    rec && rec.data.username === 'old_admin' && !rec.data.account,
    rec && rec.data
  );
  check('未知字段被保留', rec && rec.data.legacyExtra === '要保住的字段', rec && rec.data);
  check('标题没被改坏', rec && rec.title === '老站A', rec && rec.title);
  check('标签没丢', rec && rec.tags[0] === '老标签', rec && rec.tags);
  // v6：老库没有 deleted_at，迁移补成 0（= 未删除）
  check('v6 给老记录补上 deleted_at=0', rec && rec.deleted_at === 0, rec && rec.deleted_at);
  check('v6 之后老记录还在正常列表里', store.list('sites').some((r) => r.id === 'r_legacy1'), store.list('sites').map((r) => r.id));
  check('v6 之后回收站是空的', store.countTrash() === 0, store.countTrash());

  // v5：accounts 集合已删，账号合并进 sites.accounts
  const acc = store.get('r_legacy_acc');
  check('v5 删掉了 accounts 集合的记录', acc === null, acc && acc.id);

  const site = store.get('r_legacy1');
  const siteAccounts = (site && site.data && site.data.accounts) || [];
  check('v5 把账号合并进 sites.accounts', Array.isArray(siteAccounts) && siteAccounts.length > 0, siteAccounts);
  check(
    'v5 迁移的账号保留了角色',
    siteAccounts.some((a) => Array.isArray(a.role) && a.role.indexOf('只读') >= 0),
    siteAccounts.map((a) => a.role)
  );
  check('v5 保证有默认账号', siteAccounts.some((a) => a.isDefault === true), siteAccounts.map((a) => a.isDefault));

  /* ---------- v5 新建「未归类账号」站点时也必须加密（v0.43.0）---------- */
  const orphanSite = store.list('sites').find((s) => s.title === '未归类账号');
  check('v5 为无站点账号建了「未归类账号」站点', !!orphanSite, store.list('sites').map((s) => s.title));
  const orphanAcc = ((orphanSite && orphanSite.data && orphanSite.data.accounts) || [])[0] || {};
  check('未归类账号的密码能正常解密出来', orphanAcc.password === 'PlainOrphan123', orphanAcc.password);
  {
    // 直接看磁盘上的字节：明文密码绝不能出现在 data.db 里
    const rawDb = fs.readFileSync(path.join(tmp, 'data.db'));
    check('未归类账号的密码在库里不是明文', rawDb.indexOf(Buffer.from('PlainOrphan123')) === -1, 'found plaintext');
    check('未归类账号的密码在库里有密文前缀', rawDb.indexOf(Buffer.from('enc:')) >= 0);
  }

  check('v4 把 env 从字符串变成数组', Array.isArray(rec.data.env) && rec.data.env[0] === 'test', rec.data.env);
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
  check('新库版本号即当前版本', store2.schemaVersion() === migrations.SCHEMA_VERSION, store2.schemaVersion());
  const freshRec = store2.save({ collection: 'sites', data: { name: '新库站点' }, tags: [] });
  check('新库直接带回收站字段（deleted_at=0）', freshRec && freshRec.deleted_at === 0, freshRec && freshRec.deleted_at);
  check('新库不产生迁移备份', !fs.existsSync(path.join(freshDir, 'backups')) || fs.readdirSync(path.join(freshDir, 'backups')).every((f) => !/data-before-/.test(f)));

  /* ============================================================
   * v7：老库里的明文密码要被重新加密（且幂等）
   *
   * 造一个 v6 的库，里面有一条 sites 记录，accounts[].password 是明文
   * （模拟 v5 当年绕过 serialize 写进去的那批数据）。
   * ============================================================ */
  {
    const v6dir = path.join(tmp, 'v6');
    fs.mkdirSync(v6dir, { recursive: true });
    const legacy2 = new SQL.Database();
    legacy2.run(SCHEMA);
    legacy2.run('ALTER TABLE records ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0');
    legacy2.run(
      'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'r_v6_plain',
        'sites',
        '老明文站',
        JSON.stringify({
          name: '老明文站',
          accounts: [{ label: '默认账号', account: 'u1', password: 'OldPlainPwd', role: [], isDefault: true }]
        }),
        '',
        0,
        Date.now(),
        Date.now(),
        0
      ]
    );
    legacy2.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', '6']);
    fs.writeFileSync(path.join(v6dir, 'data.db'), Buffer.from(legacy2.export()));
    legacy2.close();

    const storeV7 = require(path.join(proj, 'electron', 'store'));
    const infoV7 = await storeV7.init(v6dir);
    // 注意：本测试前面把 SCHEMA_VERSION 顶到了 REAL_VERSION+1（并注入了一条改名迁移），
    // 所以这里期望的是「升到注入后的版本」，不是字面的 7。
    check('v6 库升到最新版本（含注入的那条）', storeV7.schemaVersion() === REAL_VERSION + 1, storeV7.schemaVersion());
    check('v7 真的执行了', !!(infoV7.migration && infoV7.migration.ran.indexOf(7) >= 0), infoV7.migration);

    const recV7 = storeV7.get('r_v6_plain');
    check('v7 之后密码仍能正常解密', recV7.data.accounts[0].password === 'OldPlainPwd', recV7.data.accounts[0].password);
    {
      const rawA = fs.readFileSync(path.join(v6dir, 'data.db'));
      check('v7 之后库里没有明文密码', rawA.indexOf(Buffer.from('OldPlainPwd')) === -1, 'plaintext remains');
      check('v7 之后密码带上了密文前缀', rawA.indexOf(Buffer.from('enc:')) >= 0);
    }

    // 幂等：把版本号退回 6，再打开一次 → v7 会重跑，但不该改坏数据/报错
    storeV7.setMeta('schemaVersion', 6);
    storeV7.persist();
    storeV7.close();
    const infoAgain = await storeV7.init(v6dir);
    check('v7 可以重跑（幂等不报错）', !!(infoAgain.migration && infoAgain.migration.ran.indexOf(7) >= 0), infoAgain.migration);
    const recAgain = storeV7.get('r_v6_plain');
    check('重跑 v7 后密码还是原值', recAgain.data.accounts[0].password === 'OldPlainPwd', recAgain.data.accounts[0].password);
    {
      const rawB = fs.readFileSync(path.join(v6dir, 'data.db'));
      check('重跑 v7 后仍然没有明文', rawB.indexOf(Buffer.from('OldPlainPwd')) === -1, 'plaintext remains');
    }

    // 纯函数自检：什么样的值算「明文」
    check(
      'v7 判定：无前缀=明文，enc:/raw: 不算',
      migrations.isPlainSecretValue('abc') === true &&
        migrations.isPlainSecretValue('enc:xxx') === false &&
        migrations.isPlainSecretValue('raw:eHl6') === false &&
        migrations.isPlainSecretValue('') === false &&
        migrations.isPlainSecretValue(undefined) === false,
      'plain judge wrong'
    );
    check(
      'v7 能定位 accounts[].password 里的明文',
      migrations.plainSecretPaths({ accounts: [{ password: 'p' }, { password: 'enc:x' }] }, ['accounts[].password']).length === 1,
      migrations.plainSecretPaths({ accounts: [{ password: 'p' }] }, ['accounts[].password'])
    );

    storeV7.close();
  }

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