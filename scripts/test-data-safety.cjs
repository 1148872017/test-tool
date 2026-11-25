/*
 * 数据安全回归（P0-1 / P0-2 / P1-3）
 *
 * 这一套守的是「用户数据不能悄悄没」的三条线：
 *
 *   P0-1 解密失败静默覆盖密码
 *        security.decrypt 原来解不开就返回 ''，store 把它当「用户清空了密码」写回，
 *        跨机器导库 / 换 Windows 账户后，随便编辑一次记录密文就永久没了。
 *        契约：hydrate 把解不开的字段从 data 移除 + 记录上标 __secretUnreadable（不落库）；
 *              save 收到 undefined/null 沿用原密文；收到 '' 只有「解不开」时才沿用。
 *
 *   P0-2 restoreFrom 半迁移污染
 *        原来是「先 db = next 再 migrate」，迁移一失败，后面任何一次 schedulePersist
 *        都会把半迁移的外来库写成 data.db。契约：候选库上跑完再切库，失败原库不动。
 *
 *   P1-3 init 不做 integrity_check
 *        主库坏了直接崩/读出烂数据。契约：integrity_check 不过就隔离坏库、
 *        回落最新可用备份，并且**调用方拿得到**「用了备份」这件事。
 *
 * 说明：为了让「本机解不开的密文」可复现，safeStorage 的桩把解密失败
 * 定义成「解密后的明文以 ALIEN: 开头」（模拟别的机器 DPAPI 加的密）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmpRoot = path.join(os.tmpdir(), 'tt-data-safety-' + Date.now());
fs.mkdirSync(tmpRoot, { recursive: true });

/* ------------------------------------------------------------------ *
 * 0. 桩：electron.safeStorage（DPAPI）
 * ------------------------------------------------------------------ */
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (b) => {
          const text = b.toString('utf8');
          const plain = text.startsWith('enc:') ? text.slice(4) : text;
          // 模拟「这段密文是别的机器 / 别的 Windows 账户加的」
          if (plain.startsWith('ALIEN:')) throw new Error('DPAPI 解不开（换机器了）');
          return plain;
        }
      }
    };
  }
  return origLoad.apply(this, arguments);
};

/** 造一段「本机解不开」的密文（磁盘上长的就是 enc: 开头） */
function alienCipher(plain) {
  return 'enc:' + Buffer.from('enc:' + plain, 'utf8').toString('base64');
}

/* ------------------------------------------------------------------ *
 * 1. 测试用集合：顶层 secret 字段（今天 SECRET_KEYS 只有 sites 的嵌套路径，
 *    但 RecordForm 的 type:'secret' 分支和契约都按顶层写，这里补一个来验它）
 * ------------------------------------------------------------------ */
const collections = require(path.join(proj, 'shared', 'collections.js'));
const vaultConf = {
  key: 'vault',
  name: '测试保险箱',
  group: '资产',
  titleField: 'name',
  listFields: [],
  actions: [],
  fields: [
    { key: 'name', label: '名称', type: 'text' },
    { key: 'password', label: '密码', type: 'secret' }
  ]
};
collections.COLLECTIONS.push(vaultConf);
collections.COLLECTION_MAP.vault = vaultConf;
collections.SECRET_KEYS.vault = ['password'];

const security = require(path.join(proj, 'electron', 'security.js'));
const migrations = require(path.join(proj, 'electron', 'migrations.js'));
const store = require(path.join(proj, 'electron', 'store.js'));
const REAL_VERSION = migrations.SCHEMA_VERSION;

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 2. sql.js 小工具：造/读 .db 文件
 * ------------------------------------------------------------------ */
let SQL = null;
async function loadSql() {
  if (SQL) return SQL;
  const initSqlJs = require(path.join(proj, 'node_modules', 'sql.js'));
  SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve(path.join(proj, 'node_modules', 'sql.js'))), f)
  });
  return SQL;
}

const RECORD_COLS = [
  'id',
  'collection',
  'title',
  'data',
  'tags',
  'favorite',
  'created_at',
  'updated_at',
  'deleted_at'
];

/**
 * 造一个 .db 文件。
 * @param {string} file 目标路径
 * @param {{version:number, records?:object[], withDeletedAt?:boolean, withMeta?:boolean, withLink?:boolean, recordColumns?:string[]}} opts
 */
function seedDb(file, opts) {
  const o = opts || {};
  const cols = o.recordColumns || RECORD_COLS;
  const db = new SQL.Database();
  const colDefs = {
    id: 'TEXT PRIMARY KEY',
    collection: 'TEXT NOT NULL',
    title: "TEXT NOT NULL DEFAULT ''",
    data: "TEXT NOT NULL DEFAULT '{}'",
    tags: "TEXT NOT NULL DEFAULT ''",
    favorite: 'INTEGER NOT NULL DEFAULT 0',
    created_at: 'INTEGER NOT NULL',
    updated_at: 'INTEGER NOT NULL',
    deleted_at: 'INTEGER NOT NULL DEFAULT 0'
  };
  db.run('CREATE TABLE records (' + cols.map((c) => `${c} ${colDefs[c] || 'TEXT'}`).join(', ') + ');');
  if (o.withMeta !== false) db.run('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
  if (o.withLink) {
    db.run(
      'CREATE TABLE case_api_links (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, case_title TEXT NOT NULL, case_index INTEGER, api_id TEXT NOT NULL, source TEXT, created_at INTEGER);'
    );
  }
  if (o.withMeta !== false) {
    db.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', JSON.stringify(o.version || REAL_VERSION)]);
  }
  for (const r of o.records || []) {
    const ts = r.updated_at || Date.now();
    const useCols = cols.filter((c) => c !== 'deleted_at' || cols.indexOf('deleted_at') >= 0);
    const values = useCols.map((c) => {
      if (c === 'id') return r.id;
      if (c === 'collection') return r.collection;
      if (c === 'title') return r.title || '(未命名)';
      if (c === 'data') return JSON.stringify(r.data || {});
      if (c === 'tags') return Array.isArray(r.tags) ? r.tags.join(',') : r.tags || '';
      if (c === 'favorite') return r.favorite ? 1 : 0;
      if (c === 'created_at') return r.created_at || ts;
      if (c === 'updated_at') return ts;
      if (c === 'deleted_at') return r.deleted_at || 0;
      return '';
    });
    db.run(`INSERT INTO records (${useCols.join(', ')}) VALUES (${useCols.map(() => '?').join(', ')})`, values);
  }
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
  return file;
}

/** 以「外来库」的方式读一个 .db（不动 store 的内存库） */
function readDbFile(file) {
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));
  try {
    const recs = [];
    const stmt = db.prepare('SELECT id, collection, data, deleted_at FROM records');
    while (stmt.step()) recs.push(stmt.getAsObject());
    stmt.free();
    let meta = {};
    try {
      const st = db.prepare('SELECT k, v FROM meta');
      while (st.step()) {
        const row = st.getAsObject();
        meta[String(row.k)] = row.v;
      }
      st.free();
    } catch (e) {
      meta = {};
    }
    let cols = [];
    try {
      const res = db.exec('PRAGMA table_info(records)');
      if (res && res.length) {
        const i = res[0].columns.indexOf('name');
        cols = res[0].values.map((v) => String(v[i]));
      }
    } catch (e) {
      cols = [];
    }
    return { records: recs, meta, cols, raw: Buffer.from(fs.readFileSync(file)).toString('latin1') };
  } finally {
    db.close();
  }
}

/* ================================================================== *
 * 1. security.decryptResult：失败必须能被看见
 * ================================================================== */
(async () => {
  await loadSql();

  {
    const okPlain = security.decryptResult('enc:' + Buffer.from('enc:hello', 'utf8').toString('base64'));
    check('decryptResult：正常密文 ok=true 且拿到明文', okPlain.ok === true && okPlain.value === 'hello', okPlain);
    const broken = security.decryptResult(alienCipher('ALIEN:secret'));
    check('decryptResult：解不开时 ok=false（不是空串成功）', broken.ok === false, broken);
    check('decryptResult：解不开时带 reason', !!broken.reason, broken);
    check('decrypt 兼容旧用法：解不开仍返回空串', security.decrypt(alienCipher('ALIEN:secret')) === '');
    check('decryptResult：空值算成功', security.decryptResult('').ok === true && security.decryptResult(null).ok === true);
    check('decryptResult：没有前缀的明文原样返回（老数据）', security.decryptResult('plaintext').value === 'plaintext');
  }

  /* ================================================================== *
   * 2. P0-1：hydrate / save 契约（sites 嵌套密码 + 顶层 secret 字段）
   * ================================================================== */
  {
    const dir = path.join(tmpRoot, 'p01');
    fs.mkdirSync(dir, { recursive: true });
    seedDb(path.join(dir, 'data.db'), {
      version: REAL_VERSION,
      records: [
        {
          id: 'r_site',
          collection: 'sites',
          title: '换过机器的站点',
          data: {
            name: '换过机器的站点',
            env: ['test'],
            accounts: [
              { label: '管理员', account: 'admin', password: alienCipher('ALIEN:P-admin'), role: [], isDefault: true },
              { label: '普通', account: 'user', password: 'enc:' + Buffer.from('enc:readable-pwd', 'utf8').toString('base64'), role: [], isDefault: false }
            ]
          }
        },
        {
          id: 'r_vault',
          collection: 'vault',
          title: '保险箱',
          data: { name: '保险箱', password: alienCipher('ALIEN:P-vault') }
        }
      ]
    });

    const info = await store.init(dir);
    check('init：健康库 integrity.ok=true', !!info.integrity && info.integrity.ok === true, info.integrity);
    check('init：健康库 recovered=false', info.recovered === false, info);
    check('init：返回 migration 信息（调用方拿得到）', !!info.migration && info.migration.to >= 1, info.migration);
    check('init：返回 dbPath / backupDir', info.dbPath === store.dbPath && info.backupDir === store.backupDir, info);

    /* ---- hydrate：解不开的字段从 data 移除并打标记 ---- */
    const site = store.get('r_site');
    const acc0 = (site.data.accounts || [])[0] || {};
    const acc1 = (site.data.accounts || [])[1] || {};
    check('hydrate：解不开的账号密码被移除（不是空串）', !('password' in acc0), acc0);
    check('hydrate：同一条里能解开的密码照常给明文', acc1.password === 'readable-pwd', acc1);
    check('hydrate：账号其它字段还在', acc0.account === 'admin' && acc0.label === '管理员', acc0);
    check(
      'hydrate：记录上有 __secretUnreadable 且是路径',
      Array.isArray(site.__secretUnreadable) && site.__secretUnreadable.indexOf('accounts[].password') >= 0,
      site.__secretUnreadable
    );
    check('hydrate：能解开的记录没有这个标记', store.get('r_site') && !site.__secretUnreadable.includes('nope'));

    const vault = store.get('r_vault');
    check('hydrate：顶层 secret 字段解不开时被移除', !('password' in vault.data), vault.data);
    check(
      'hydrate：顶层 secret 标记成字段名',
      Array.isArray(vault.__secretUnreadable) && vault.__secretUnreadable.indexOf('password') >= 0,
      vault.__secretUnreadable
    );

    const rawAfterInit = readDbFile(path.join(dir, 'data.db'));
    check('hydrate：__secretUnreadable 不落库', rawAfterInit.raw.indexOf('__secretUnreadable') < 0);
    check(
      'hydrate：磁盘上的原密文还在（没被 hydrate 改掉）',
      rawAfterInit.raw.indexOf(alienCipher('ALIEN:P-admin')) >= 0,
      rawAfterInit.raw.indexOf('enc:')
    );

    /* ---- save：传 ''（解不开）→ 沿用原密文 ---- */
    store.save({
      id: 'r_site',
      collection: 'sites',
      data: {
        name: '换过机器的站点',
        env: ['test'],
        accounts: [
          { label: '管理员', account: 'admin', password: '', role: [], isDefault: true },
          { label: '普通', account: 'user', password: '', role: [], isDefault: false }
        ]
      },
      tags: []
    });
    store.persist();
    const afterEmpty = readDbFile(path.join(dir, 'data.db'));
    const recAfterEmpty = afterEmpty.records.find((r) => r.id === 'r_site');
    const dataAfterEmpty = JSON.parse(recAfterEmpty.data);
    check(
      'save：解不开的密码传空串 → 沿用磁盘原密文',
      dataAfterEmpty.accounts[0].password === alienCipher('ALIEN:P-admin'),
      dataAfterEmpty.accounts[0].password
    );
    check(
      'save：能解开的密码传空串 → 允许清空（用户真的删了）',
      dataAfterEmpty.accounts[1].password === '',
      dataAfterEmpty.accounts[1].password
    );
    check('save：账号名/角色没被波及', dataAfterEmpty.accounts[0].account === 'admin', dataAfterEmpty.accounts[0]);
    check(
      'save：磁盘上没有出现「enc: 加密空串」这种把密文抹掉的写法',
      dataAfterEmpty.accounts[0].password !== '' && dataAfterEmpty.accounts[0].password.indexOf('enc:') === 0
    );

    /* ---- save：整条不带这个键（undefined）→ 沿用 ---- */
    store.save({
      id: 'r_site',
      collection: 'sites',
      data: {
        name: '换过机器的站点',
        env: ['test'],
        accounts: [{ label: '管理员', account: 'admin', role: [], isDefault: true }]
      },
      tags: []
    });
    store.persist();
    const dataNoKey = JSON.parse(readDbFile(path.join(dir, 'data.db')).records.find((r) => r.id === 'r_site').data);
    check(
      'save：账号里根本没有 password 键 → 沿用原密文',
      dataNoKey.accounts[0].password === alienCipher('ALIEN:P-admin'),
      dataNoKey.accounts[0].password
    );

    /* ---- save：用户输入新值 → 覆盖（并且真的加密） ---- */
    store.save({
      id: 'r_site',
      collection: 'sites',
      data: {
        name: '换过机器的站点',
        env: ['test'],
        accounts: [{ label: '管理员', account: 'admin', password: 'brand-new-pwd', role: [], isDefault: true }]
      },
      tags: []
    });
    store.persist();
    const dbAfterNew = readDbFile(path.join(dir, 'data.db'));
    const dataNew = JSON.parse(dbAfterNew.records.find((r) => r.id === 'r_site').data);
    check(
      'save：用户输入新密码 → 用新值（不再是原密文）',
      dataNew.accounts[0].password !== alienCipher('ALIEN:P-admin'),
      dataNew.accounts[0].password
    );
    check('save：新密码解出来就是用户输入的', store.get('r_site').data.accounts[0].password === 'brand-new-pwd');
    check('save：新密码在磁盘上是密文', dbAfterNew.raw.indexOf('brand-new-pwd') < 0 && dbAfterNew.raw.indexOf('enc:') >= 0);

    /* ---- save：前端把 __secretUnreadable 带回来也不能落库 ---- */
    store.save({
      id: 'r_site',
      collection: 'sites',
      data: {
        name: '换过机器的站点',
        env: ['test'],
        accounts: [{ label: '管理员', account: 'admin', password: '', role: [], isDefault: true }],
        __secretUnreadable: ['accounts[].password']
      },
      tags: []
    });
    store.persist();
    check('save：内部标记 __secretUnreadable 不会被写进库', readDbFile(path.join(dir, 'data.db')).raw.indexOf('__secretUnreadable') < 0);

    /* ---- 顶层 secret 字段：同一套契约 ---- */
    store.save({ id: 'r_vault', collection: 'vault', data: { name: '保险箱', password: '' }, tags: [] });
    store.persist();
    check(
      'save（顶层 secret）：解不开 + 空串 → 沿用原密文',
      JSON.parse(readDbFile(path.join(dir, 'data.db')).records.find((r) => r.id === 'r_vault').data).password ===
        alienCipher('ALIEN:P-vault')
    );

    store.save({ id: 'r_vault', collection: 'vault', data: { name: '保险箱' }, tags: [] });
    store.persist();
    check(
      'save（顶层 secret）：键都不带 → 沿用原密文',
      JSON.parse(readDbFile(path.join(dir, 'data.db')).records.find((r) => r.id === 'r_vault').data).password ===
        alienCipher('ALIEN:P-vault')
    );

    store.save({ id: 'r_vault', collection: 'vault', data: { name: '保险箱', password: 'vault-new' }, tags: [] });
    store.persist();
    check('save（顶层 secret）：新值覆盖并加密', store.get('r_vault').data.password === 'vault-new');

    // 新记录（没有原密文可沿用）：空串就是空串，不能报错
    const freshRec = store.save({ collection: 'vault', data: { name: '新保险箱', password: '' }, tags: [] });
    check('save（新记录）：空密码正常保存为空串', freshRec && freshRec.data.password === '');

    // 迁移 Api.write 也走同一条安全路径（v7 会用 write 重加密）
    check(
      '代码结构：save 走 serializeSafely（不是裸 serialize）',
      /const payload = JSON\.stringify\(serializeSafely\(/.test(
        fs.readFileSync(path.join(proj, 'electron', 'store.js'), 'utf8')
      )
    );

    store.close();
  }

  /* ================================================================== *
   * 3. P0-2：restoreFrom 失败不留痕 + inspectDbFile 关键列校验
   * ================================================================== */
  {
    const dir = path.join(tmpRoot, 'p02');
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, 'data.db');

    // 当前库：一条 keep-A
    seedDb(dbFile, {
      version: REAL_VERSION,
      records: [{ id: 'keep-A', collection: 'sqls', title: '本机记录', data: { name: '本机记录', sql: 'select 1' } }]
    });
    await store.init(dir);
    check('restore 前置：本机库读得到', !!store.get('keep-A'));

    /* ---- 3.1 inspectDbFile：关键列集合校验 ---- */
    const noDataCol = path.join(tmpRoot, 'no-data-col.db');
    seedDb(noDataCol, { version: REAL_VERSION, recordColumns: ['id', 'collection', 'title'], records: [] });
    let e1 = null;
    try {
      store.inspectDbFile(noDataCol);
    } catch (err) {
      e1 = err;
    }
    check('inspect：records 缺关键列 → 抛错且带 code', !!e1 && e1.code === 'DB_SCHEMA_INVALID', e1 && e1.message);
    check('inspect：错误文案点名缺了哪一列', !!e1 && /data|tags|favorite/.test(e1.message), e1 && e1.message);

    const noMeta = path.join(tmpRoot, 'no-meta.db');
    seedDb(noMeta, { version: REAL_VERSION, withMeta: false, records: [] });
    let e2 = null;
    try {
      store.inspectDbFile(noMeta);
    } catch (err) {
      e2 = err;
    }
    check('inspect：没有 meta 表 → DB_SCHEMA_INVALID', !!e2 && e2.code === 'DB_SCHEMA_INVALID', e2 && e2.message);

    const notDb = path.join(tmpRoot, 'not-a-db.db');
    fs.writeFileSync(notDb, 'not a database', 'utf8');
    let e3 = null;
    try {
      store.inspectDbFile(notDb);
    } catch (err) {
      e3 = err;
    }
    check('inspect：不是数据库 → DB_UNREADABLE', !!e3 && e3.code === 'DB_UNREADABLE', e3 && e3.message);

    /* ---- 3.2 迁移中途失败：原库一个字节都不能动 ---- */
    const foreign = path.join(tmpRoot, 'foreign-v6.db');
    seedDb(foreign, {
      version: 6,
      recordColumns: RECORD_COLS.filter((c) => c !== 'deleted_at'),
      records: [{ id: 'foreign-1', collection: 'sqls', title: '外来记录', data: { name: '外来记录', sql: 'select 2' } }]
    });

    migrations.MIGRATIONS.push({
      to: REAL_VERSION + 1,
      note: '测试注入：故意失败',
      run() {
        throw new Error('故意让迁移失败');
      }
    });
    migrations.SCHEMA_VERSION = REAL_VERSION + 1;

    let e4 = null;
    try {
      store.restoreFrom(foreign);
    } catch (err) {
      e4 = err;
    }
    check('restore：迁移失败要抛错，不能静默成功', !!e4, e4 && e4.message);
    check('restore：抛出的错误带 code', !!e4 && e4.code === 'RESTORE_FAILED', e4 && e4.code);

    // 失败后：内存库还是原库
    check('restore 失败后：内存库还是原来的（keep-A 在）', !!store.get('keep-A') && !store.get('foreign-1'));

    // 失败后：磁盘上的 data.db 没被半迁移的外来库覆盖
    const diskAfterFail = readDbFile(dbFile);
    check(
      'restore 失败后：data.db 里没有外来记录',
      !diskAfterFail.records.some((r) => r.id === 'foreign-1'),
      diskAfterFail.records.map((r) => r.id)
    );
    check('restore 失败后：data.db 里本机记录还在', diskAfterFail.records.some((r) => r.id === 'keep-A'));
    check(
      'restore 失败后：schemaVersion 没被改成半迁移的结果',
      !!diskAfterFail.meta.schemaVersion && Number(JSON.parse(diskAfterFail.meta.schemaVersion)) === REAL_VERSION,
      diskAfterFail.meta
    );

    // 最容易出事的这一步：等 400ms 防抖过去，看有没有「迟到的写盘」把原库盖掉
    store.save({ collection: 'sqls', data: { name: '失败后继续用', sql: 'select 3' }, tags: [] });
    await sleep(600);
    const diskLater = readDbFile(dbFile);
    check(
      'restore 失败后：再保存一次也写回原库（没有半迁移库混进来）',
      diskLater.records.some((r) => r.id === 'keep-A') &&
        !diskLater.records.some((r) => r.id === 'foreign-1') &&
        diskLater.records.some((r) => r.collection === 'sqls'),
      diskLater.records.map((r) => r.id)
    );

    // 安全备份还在（恢复前那份）
    const backupsNow = fs.readdirSync(path.join(dir, 'backups')).filter((f) => /^data-before-restore-/.test(f));
    check('restore 失败也留了 data-before-restore 安全备份', backupsNow.length >= 1, backupsNow);

    // 撤掉注入的坏迁移
    migrations.MIGRATIONS.pop();
    migrations.SCHEMA_VERSION = REAL_VERSION;

    /* ---- 3.3 版本太新：拒绝且原库不动 ---- */
    const tooNew = path.join(tmpRoot, 'too-new.db');
    seedDb(tooNew, { version: REAL_VERSION + 5, records: [] });
    let e5 = null;
    try {
      store.restoreFrom(tooNew);
    } catch (err) {
      e5 = err;
    }
    check('restore：结构版本太新 → DB_VERSION_TOO_NEW', !!e5 && e5.code === 'DB_VERSION_TOO_NEW', e5 && e5.code);
    check('restore 拒绝后：原库还在', !!store.get('keep-A'));

    /* ---- 3.4 成功路径：老库（v6，没有 deleted_at）整库换上来 ---- */
    const okRestore = store.restoreFrom(foreign);
    check('restore：合法老库能恢复', !!okRestore && okRestore.fromVersion === 6, okRestore);
    check('restore：迁移在候选库上跑完了（v7）', !!okRestore.migration && okRestore.migration.ran.indexOf(7) >= 0, okRestore.migration);
    check('restore：外来记录进来了', !!store.get('foreign-1'));
    check('restore：本机记录被替换掉了（恢复就是整库覆盖）', !store.get('keep-A'));
    check('restore：返回安全备份路径且文件存在', !!okRestore.backupFile && fs.existsSync(okRestore.backupFile));
    check('restore：恢复后 deleted_at 列补齐了', readDbFile(dbFile).cols.indexOf('deleted_at') >= 0);
    await sleep(600);
    const diskAfterOk = readDbFile(dbFile);
    check('restore 成功后：data.db 里是外来库内容', diskAfterOk.records.some((r) => r.id === 'foreign-1'));

    store.close();
  }

  /* ================================================================== *
   * 4. P1-3：init integrity_check + 回落备份
   * ================================================================== */
  {
    const dir = path.join(tmpRoot, 'p13');
    fs.mkdirSync(dir, { recursive: true });
    const info1 = await store.init(dir);
    check('init 新库：integrity.ok=true 且没回落', info1.integrity.ok === true && info1.recovered === false, info1.integrity);
    store.save({ collection: 'sqls', data: { name: '备份里应有这条', sql: 'select 9' }, tags: [] });
    store.persist();
    // 真实场景里备份是「上次启动/手动备份」的，肯定有内容；这里手动造一份
    store.backup();
    const dayBackups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => /^data-\d{4}-\d{2}-\d{2}/.test(f));
    check('init：每天自动留一份备份（回落要用）', dayBackups.length >= 1, dayBackups);
    store.close();

    // 把主库写坏，模拟「断电 / 磁盘坏了」
    fs.writeFileSync(path.join(dir, 'data.db'), Buffer.from('this-is-not-a-sqlite-file-at-all'));

    const info2 = await store.init(dir);
    check('init：主库坏了 → recovered=true（调用方拿得到）', info2.recovered === true, info2);
    check('init：报出用的是哪个备份', !!info2.recoveredFrom && fs.existsSync(info2.recoveredFrom), info2.recoveredFrom);
    check('init：坏库被隔离保留（不删证据）', !!info2.quarantined && fs.existsSync(info2.quarantined), info2.quarantined);
    check('init：integrity 结果透传（ok=false + 有原因）', info2.integrity.ok === false && info2.integrity.messages.length > 0, info2.integrity);
    const recoveredList = store.list('sqls');
    check('init：回落备份后数据读得到', recoveredList.some((r) => r.data.name === '备份里应有这条'), recoveredList.length);
    const repaired = readDbFile(path.join(dir, 'data.db'));
    check('init：主库文件已经用备份修好（不再是坏文件）', repaired.records.length >= 1, repaired.records.length);

    // 没有可用备份时：不能假装成功，要抛带 code 的错误
    const dirBroken = path.join(tmpRoot, 'p13-nobackup');
    fs.mkdirSync(path.join(dirBroken, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dirBroken, 'data.db'), Buffer.from('broken-db'));
    let e6 = null;
    try {
      await store.init(dirBroken);
    } catch (err) {
      e6 = err;
    }
    check('init：没备份可回落 → 抛 DB_CORRUPT_NO_BACKUP', !!e6 && e6.code === 'DB_CORRUPT_NO_BACKUP', e6 && e6.code);
  }

  /* ================================================================== *
   * 5. 前端配合（RecordForm）
   * ================================================================== */
  {
    const formSrc = fs.readFileSync(path.join(proj, 'src', 'components', 'RecordForm.tsx'), 'utf8');
    check('RecordForm：读 __secretUnreadable', /__secretUnreadable/.test(formSrc));
    check('RecordForm：解不开的 secret 输入框 placeholder 写明留空保持不变', /本机无法解密，留空保持不变/.test(formSrc));
    check('RecordForm：提示文案说明「输入新密码才覆盖」', /只有输入新密码才会覆盖/.test(formSrc));
    check('RecordForm：提交时把解不开的顶层 secret 键删掉', /delete payload\[path\]/.test(formSrc));
    check('RecordForm：保留原有的空账号清理（别为了修 bug 把它删了）', /dropEmptyAccounts\(String\(payload\[f\.key\]\)\)/.test(formSrc));
    check('RecordForm：数组形态的 accounts 先转 JSON 字符串再交给编辑器', /Array\.isArray\(raw\)\) init\[f\.key\] = JSON\.stringify\(raw\)/.test(formSrc));
    check('RecordForm：原先是数组的仍写回数组（不改存储形态）', /JSON\.parse\(payload\[f\.key\]\)/.test(formSrc));

    const mainSrc = fs.readFileSync(path.join(proj, 'electron', 'main.js'), 'utf8');
    check('main.js：接收 store.init 的返回值', /initInfo = await store\.init\(DATA_DIR\)/.test(mainSrc));
    check('main.js：把 migration 信息写进启动日志', /storeInitSummary\(initInfo\)/.test(mainSrc) && /info\.migration/.test(mainSrc));
    check('main.js：用了备份要告诉用户', /notifyStoreInit\(initInfo\)/.test(mainSrc) && /info\.recovered/.test(mainSrc));
  }

  /* ---- 汇总 ---- */
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 数据安全：解密不覆盖 / 恢复原子性 / 启动回落 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});