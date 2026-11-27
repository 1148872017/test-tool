'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { encrypt, decrypt, decryptResult } = require('./security');
const { COLLECTION_MAP, SECRET_KEYS, OPTION_SETS } = require('../shared/collections');
const { apiKey, diffApi: apiDiff, MAX_SKIP_DETAIL } = require('./openapi');
const migrations = require('./migrations');

let SQL = null;
let db = null;
let dbPath = '';
let backupDir = '';
let saveTimer = null;
let lastMigration = null;
/**
 * 写盘闸门（restoreFrom 用）。
 *
 * 恢复外来库时，迁移是在「候选库」上跑的。迁移内部会 persist()，
 * 那一写就会把半迁移的外来库盖到 data.db 上 —— 这正是 P0-2 的现场。
 * 所以候选库阶段把写盘整个关掉，只有确定成功、切完库才打开。
 */
let persistMuted = false;

/**
 * 回收站保留天数：软删除的记录超过这么多天自动清掉。
 * 界面上的「N 天后自动清除」也用这个数，改这里就够了。
 */
const TRASH_RETENTION_DAYS = 30;

/**
 * 备份保留份数（默认 10）。
 *
 * **两处备份共用这一个数**（v0.52.1 收口）：
 *   1. backups/ 下的每日备份（data-YYYY-MM-DD-...）；
 *   2. jmx 写回时同目录生成的 <文件>.bak-<时间戳>（由 ipc-jmx 把这个值传过去）。
 *
 * 为什么收成一个：以前两个模块各写死一个 10，用户改不了，而且「都是备份保留」
 * 却要记两个地方。现在设置页改一个数、全局生效。
 *
 * **不参与这个数的备份**（是安全副本，不是轮转）：
 *   data-before-v{from}-*（迁移前）、data-before-restore-*（恢复前）。
 *   这两种一份都不能自动删，出事了要靠它们救。
 */
const DEFAULT_BACKUP_KEEP = 10;
const BACKUP_KEEP_MIN = 1;
const BACKUP_KEEP_MAX = 100;
let backupKeep = DEFAULT_BACKUP_KEEP;

/** 把任意输入收成 1..100 的整数；非法值回默认（不让脏配置导致「一份都不留」） */
function clampBackupKeep(value) {
  const n = Math.floor(Number(value));
  if (!isFinite(n) || n <= 0) return DEFAULT_BACKUP_KEEP;
  return Math.max(BACKUP_KEEP_MIN, Math.min(BACKUP_KEEP_MAX, n));
}

/** 设置备份保留份数（main.js 启动与 settings:set 各调一次） */
function setBackupKeep(value) {
  backupKeep = clampBackupKeep(value);
  return backupKeep;
}

function getBackupKeep() {
  return backupKeep;
}

/**
 * records 的 deleted_at 是「软删除时间戳」，0 = 未删除。
 *
 * 为什么用时间戳而不是 0/1：回收站要显示「删除于」和「N 天后自动清除」，
 * 时间戳一次就够，不用再加一列。
 *
 * 注意：老数据库的 records 表没有这一列，
 * `CREATE TABLE IF NOT EXISTS` 不会补列，所以真正的补列在 migrations v6，
 * 这里只是新库的初始结构。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * 不传 params 时走 db.run(sql) 的直通路径，才能一次执行多条语句（建表 + 建索引）。
 * sql.js 的 run(sql, params) 会退化成 prepare 只跑第一条。
 */
function run(sql, params) {
  if (params === undefined) db.run(sql);
  else db.run(sql, params);
}

function getMeta(key, fallback = null) {
  const rows = all('SELECT v FROM meta WHERE k = ?', [key]);
  if (!rows.length) return fallback;
  try {
    return JSON.parse(rows[0].v);
  } catch (e) {
    return rows[0].v;
  }
}

function setMeta(key, value) {
  run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [key, JSON.stringify(value)]);
}

function persist() {
  if (!db || !dbPath) return;
  if (persistMuted) return;
  const bytes = Buffer.from(db.export());
  const tmp = dbPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dbPath);
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      persist();
    } catch (e) {
      console.error('[store] persist failed', e);
    }
  }, 400);
}

/**
 * 兜底保证回收站字段与索引存在。
 *
 * 迁移 v6 已经做了同样的事，这里再兜一层是因为还有别的入口会换库：
 * restoreFrom 换上来的 .db、clearLocalData 重建的空库。
 * 全部幂等：列在就跳过，索引用 IF NOT EXISTS。
 */
function ensureTrashSchema() {
  try {
    const cols = all('PRAGMA table_info(records)').map((c) => String(c.name));
    if (cols.length && cols.indexOf('deleted_at') < 0) {
      run('ALTER TABLE records ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0');
    }
    db.run(migrations.TRASH_DDL);
  } catch (e) {
    console.error('[store] 回收站字段初始化失败', e);
  }
}

/**
 * 打开主库（P1-3）。
 *
 * 原来的问题是：只做了一次 `new SQL.Database(bytes)`，坏文件不会在这里报错
 * （sql.js 是懒解析，真正读的时候才炸），异常一路冒到 whenReady 的 catch，
 * 用户看到的就是「启动失败」——没有任何回落，数据只能靠手动拷备份。
 * 现在：先做 integrity_check + 关键列校验，不合格就隔离坏文件、
 * 回落最新可用备份，并且**把「用了备份」这件事告诉调用方**（返回值里的 recovered / integrity）。
 *
 * @returns {{integrity: {ok: boolean, messages: string[]}, recoveredFrom: string, quarantined: string}}
 */
function openMainDb(existed) {
  const integrity = { ok: true, messages: [] };
  if (!existed) {
    db = new SQL.Database();
    return { integrity, recoveredFrom: '', quarantined: '' };
  }

  let opened = null;
  try {
    opened = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    const check = checkIntegrity(opened);
    if (check.ok) {
      // 结构也要过一遍：能打开但缺关键列同样用不了
      validateDbHandle(opened);
      db = opened;
      return { integrity: check, recoveredFrom: '', quarantined: '' };
    }
    integrity.ok = false;
    integrity.messages = check.messages;
    opened.close();
    opened = null;
  } catch (e) {
    integrity.ok = false;
    integrity.messages = integrity.messages.length ? integrity.messages : [String((e && e.message) || e)];
    if (opened) {
      try {
        opened.close();
      } catch (e2) {
        /* 关不掉也不影响后面的回落 */
      }
    }
  }

  // 坏库先挪进 backups/ 留证据，再回落（不挪的话 persist 会把它覆盖掉）
  const quarantined = quarantineCorruptDb();
  const why = integrity.messages.join('; ') || '完整性检查没通过';
  const fallback = usableBackup();
  if (!fallback) {
    throw errWithCode(
      'DB_CORRUPT_NO_BACKUP',
      '主数据库已损坏（' + why + '），备份目录里也没有可用备份。原文件：' + dbPath
    );
  }
  db = fallback.handle;
  console.error('[store] 主库不可用，已回落到备份', fallback.file, why);
  return { integrity, recoveredFrom: fallback.file, quarantined };
}

async function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'data.db');
  backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file)
  });

  const existed = fs.existsSync(dbPath);
  const opened = openMainDb(existed);
  db.run(SCHEMA);
  // 关联表：新库直接建好；老库由迁移 v3 建（同一条 DDL，幂等）
  db.run(migrations.LINK_DDL);

  // 老数据库先升级结构，再写回磁盘
  if (existed) {
    lastMigration = migrate();
  } else {
    setMeta('schemaVersion', migrations.SCHEMA_VERSION);
  }
  // 迁移之后才补回收站字段（老库这时才有 deleted_at 列）
  ensureTrashSchema();
  persist();

  /**
   * 返回给装配层（main.js）的启动信息：
   *   migration   从哪个版本升到哪个版本、跑了哪些脚本、迁移前备份在哪
   *   integrity   integrity_check 的结果
   *   recovered   true = 主库坏了，这一轮跑的是备份（界面上要告诉用户）
   */
  const common = {
    dbPath,
    backupDir,
    migration: lastMigration,
    integrity: opened.integrity,
    recovered: !!opened.recoveredFrom,
    recoveredFrom: opened.recoveredFrom,
    quarantined: opened.quarantined
  };

  const today = new Date().toISOString().slice(0, 10);
  if (getMeta('lastBackup') !== today) {
    const file = backup();
    setMeta('lastBackup', today);
    persist();
    return Object.assign(common, { backupFile: file });
  }
  return Object.assign(common, { backupFile: '' });
}

function backupWithName(prefix) {
  try {
    if (!fs.existsSync(dbPath)) return '';
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const target = path.join(backupDir, `${prefix}-${stamp}.db`);
    fs.copyFileSync(dbPath, target);
    return target;
  } catch (e) {
    console.error('[store] backup failed', e);
    return '';
  }
}

/** 只清理每日备份（data-YYYY-...），迁移前备份 data-before-vX-... 不动 */
function pruneBackups() {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => /^data-\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith('.db'))
      .sort();
    // 保留份数来自设置（backupKeep，默认 10），jmx 写回备份用同一个数
    while (files.length > backupKeep) {
      const old = files.shift();
      fs.unlinkSync(path.join(backupDir, old));
    }
  } catch (e) {
    console.error('[store] prune failed', e);
  }
}

function backup() {
  const file = backupWithName('data');
  pruneBackups();
  return file;
}

/**
 * 清除备份：只删 backups/ 下的 .db（含 .db.tmp），不碰 data.db 本身。
 * 返回删掉几个、释放多少字节，界面拿去回报。
 */
function clearBackups() {
  const out = { removed: 0, bytes: 0, kept: 0 };
  let files = [];
  try {
    files = fs.readdirSync(backupDir);
  } catch (e) {
    return out;
  }
  for (const f of files) {
    if (!/\.db(\.tmp)?$/.test(f)) {
      out.kept++;
      continue;
    }
    const p = path.join(backupDir, f);
    try {
      out.bytes += fs.statSync(p).size;
      fs.unlinkSync(p);
      out.removed++;
    } catch (e) {
      console.error('[store] clear backups failed', f, e);
    }
  }
  return out;
}

/**
 * 清除本地数据：删掉 data.db 并重建空库。
 *
 * 先停掉 400ms 防抖计时器 —— 否则操作后内存里的旧数据会被又写回磁盘，
 * 界面上就是「清空了又自己回来」，这是这块最容易出的事故。
 * 备份目录不动（它是另一个选项的目标）。
 */
function clearLocalData() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const removed = [];
  for (const p of [dbPath, dbPath + '.tmp']) {
    try {
      if (p && fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(path.basename(p));
      }
    } catch (e) {
      console.error('[store] clear data failed', p, e);
    }
  }
  db = new SQL.Database();
  db.run(SCHEMA);
  db.run(migrations.LINK_DDL);
  setMeta('schemaVersion', migrations.SCHEMA_VERSION);
  ensureTrashSchema();
  persist();
  lastMigration = null;
  return { removed, dbPath, backupDir };
}

/** 迁移脚本可用的读写工具 */
function makeMigrationApi() {
  const read = (rows) =>
    rows.map((row) => {
      const rec = hydrate(row);
      rec.raw = row;
      return rec;
    });
  return {
    records: (collection) => read(all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at', [collection])),
    allRecords: () => read(all('SELECT * FROM records ORDER BY collection, updated_at')),
    write(rec) {
      const conf = COLLECTION_MAP[rec.collection] || {};
      const data = rec.data || {};
      const title = String(data[conf.titleField] || '').trim() || rec.title || '(未命名)';
      const tags = Array.isArray(rec.tags) ? rec.tags.join(',') : String(rec.tags || '');
      /**
       * 走 serializeSafely（不是 serialize）：迁移读到的 data 里，
       * 「本机解不开」的密码字段已经被 hydrate 移除了，直接 serialize
       * 会把原密文一起抹掉（P0-1 在迁移路径上的同一个坑）。
       */
      const rawExisting = rec.raw ? parseRawData(rec.raw.data) : null;
      run('UPDATE records SET title = ?, data = ?, tags = ?, favorite = ? WHERE id = ?', [
        title,
        JSON.stringify(serializeSafely(rec.collection, data, rawExisting)),
        tags,
        rec.favorite ? 1 : 0,
        rec.id
      ]);
    },
    renameCollection(from, to) {
      run('UPDATE records SET collection = ? WHERE collection = ?', [to, from]);
    },
    sql: (stmt, params) => run(stmt, params),
    query: (stmt, params = []) => all(stmt, params),
    getMeta,
    setMeta,
    /**
     * 序列化（= 按 SECRET_KEYS 加密密码字段）。
     *
     * 为什么迁移脚本需要它：
     *   api.write() 只能 UPDATE（要有 id），而迁移里有时候要**新建**记录
     *   （比如 v5 的「未归类账号」站点），只能手写 INSERT。
     *   手写 INSERT 时最容易犯的错就是直接 JSON.stringify(data) ——
     *   那会把密码明文写进 data.db（v5 当初就是这么漏的）。
     *   把 store 自己的 serialize 暴露出去，迁移里不可能再漏。
     */
    serialize: (collection, data) => serialize(collection, data),
    /** 解密（迁移里要判断「磁盘上这条到底是不是明文」时用） */
    deserialize: (collection, data) => deserialize(collection, data)
  };
}

/**
 * 把老版本数据结构升级到当前版本。
 * 只加字段/加集合时版本号不变，这里什么都不做。
 *
 * @param {{backup?: boolean}} [opts] backup:false 时不做「迁移前备份」。
 *   restoreFrom 用 false：那一份备份是**当前库**的，对外来库没有意义；
 *   恢复本身已经留了 data-before-restore。
 */
function migrate(opts) {
  const doBackup = !opts || opts.backup !== false;
  const from = Number(getMeta('schemaVersion', 1)) || 1;
  const target = migrations.SCHEMA_VERSION;
  const result = { from, to: from, ran: [], backupFile: '' };
  if (from >= target) return result;

  const pending = migrations.MIGRATIONS.filter((m) => m.to > from).sort((a, b) => a.to - b.to);
  if (!pending.length) {
    // 版本号涨了但没有需要改数据的脚本（比如只是加了字段）
    setMeta('schemaVersion', target);
    result.to = target;
    return result;
  }

  // 迁移前先单独备份一份，出问题可以直接拿回来
  if (doBackup) result.backupFile = backupWithName(`data-before-v${from}`);
  const api = makeMigrationApi();
  for (const m of pending) {
    try {
      m.run(api);
    } catch (e) {
      console.error('[store] migration to v' + m.to + ' failed', e);
      throw e;
    }
    setMeta('schemaVersion', m.to);
    persist();
    result.ran.push(m.to);
    result.to = m.to;
  }
  console.log('[store] migrated', from, '->', result.to, result.ran);
  return result;
}

function schemaVersion() {
  return Number(getMeta('schemaVersion', 0)) || 0;
}

function listBackups() {
  try {
    return fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .sort()
      .reverse()
      .map((f) => {
        const p = path.join(backupDir, f);
        const st = fs.statSync(p);
        return { name: f, size: st.size, mtime: st.mtimeMs };
      });
  } catch (e) {
    return [];
  }
}

/**
 * 按路径读写嵌套字段。
 *
 * 支持两种路径：
 *   'password'            → 顶层字段
 *   'accounts[].password' → 数组里每个元素的 password
 *
 * 为什么要这个：sites 的账号存在 `accounts` 数组里，
 * 密码是嵌套字段，原来的「只处理顶层 key」逻辑加密不到它 → 明文入库。
 */
function applySecretPath(obj, path, fn) {
  if (!obj || typeof obj !== 'object') return;

  // 数组路径：accounts[].password
  const arrMatch = /^(\w+)\[\]\.(\w+)$/.exec(path);
  if (arrMatch) {
    const [, arrKey, subKey] = arrMatch;
    const arr = obj[arrKey];
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === 'object' && item[subKey] !== undefined) {
        item[subKey] = fn(item[subKey]);
      }
    }
    return;
  }

  // 顶层字段
  if (obj[path] !== undefined) obj[path] = fn(obj[path]);
}

function serialize(collection, data) {
  // 深拷贝，避免改到调用方的对象（数组里的元素也要拷）
  const out = JSON.parse(JSON.stringify(data || {}));
  const secrets = SECRET_KEYS[collection] || [];
  for (const key of secrets) applySecretPath(out, key, encrypt);
  return out;
}

function deserialize(collection, data) {
  const out = JSON.parse(JSON.stringify(data || {}));
  const secrets = SECRET_KEYS[collection] || [];
  for (const key of secrets) applySecretPath(out, key, decrypt);
  return out;
}

/**
 * 遍历某条 secret 路径上的**每一个叶子**，把容器和键名一起交给 fn。
 *
 * 为什么不复用 applySecretPath：要让「这个值解不开」的那一个叶子被**单独删掉**
 * （同一条记录里别的账号密码是好的，不能跟着清），applySecretPath 只给值不给容器。
 */
function eachSecretLeaf(obj, secretPath, fn) {
  if (!obj || typeof obj !== 'object') return;
  const arrMatch = /^(\w+)\[\]\.(\w+)$/.exec(secretPath);
  if (arrMatch) {
    const arr = obj[arrMatch[1]];
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === 'object' && item[arrMatch[2]] !== undefined) fn(item, arrMatch[2]);
    }
    return;
  }
  if (obj[secretPath] !== undefined) fn(obj, secretPath);
}

/**
 * 解密，并把「本机解不开」的叶子从 data 里移除（P0-1）。
 *
 * 和 deserialize 的区别（两个都留着，别合并）：
 *   deserialize          —— 尽力解密，解不开就是 ''（迁移脚本 api.deserialize 还在用）
 *   deserializeTracked   —— 解不开的叶子**删掉**并报出路径，hydrate 用这个
 *
 * 为什么不能只返回 ''：hydrate 的 data 会被表单原样提交回来，
 * 空串一旦写回就是「把密文抹成空」，这就是 P0-1。
 *
 * @returns {{data: object, unreadable: string[]}} unreadable = 解不开的 secret 路径
 */
function deserializeTracked(collection, data) {
  const out = JSON.parse(JSON.stringify(data || {}));
  const secrets = SECRET_KEYS[collection] || [];
  const unreadable = [];
  for (const path of secrets) {
    eachSecretLeaf(out, path, (holder, key) => {
      const res = decryptResult(holder[key]);
      if (res.ok) {
        holder[key] = res.value;
        return;
      }
      delete holder[key];
      if (unreadable.indexOf(path) < 0) unreadable.push(path);
    });
  }
  return { data: out, unreadable };
}

function parseRawData(raw) {
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

/** 读磁盘上的原始 data（密文形态），保存时用来「沿用原密文」 */
function rawDataById(id) {
  if (!id) return null;
  const rows = all('SELECT data FROM records WHERE id = ?', [id]);
  return rows.length ? parseRawData(rows[0].data) : null;
}

/** 前端/详情页可能把 __secretUnreadable 之类的内部标记带回来，一律不落库 */
function stripInternalKeys(data) {
  const out = {};
  for (const key of Object.keys(data || {})) {
    if (key.slice(0, 2) === '__') continue;
    out[key] = data[key];
  }
  return out;
}

/**
 * 在「原库数组」里找和 incoming 项对应的那一条，用来取回原始密文。
 *
 * 为什么不能只按索引：表单会丢掉空行 / 迁移会 unshift 一条默认账号，
 * 索引一错位，密码就会被安到别的账号上（或者干脆丢掉）。
 * 顺序：唯一 id → 唯一锚点（账号名等） → 按位置兜底。
 */
function matchRawItem(item, rawArr, index) {
  if (!Array.isArray(rawArr) || !item || typeof item !== 'object') return null;
  const findUnique = (key, strict) => {
    const want = item[key];
    if (want === undefined || want === null) return null;
    const w = strict ? String(want) : String(want).trim();
    if (!w) return null;
    const hits = rawArr.filter((r) => {
      if (!r || typeof r !== 'object') return false;
      const have = strict ? (r[key] === undefined || r[key] === null ? '' : String(r[key])) : String(r[key] || '').trim();
      return have === w;
    });
    return hits.length === 1 ? hits[0] : null;
  };
  for (const key of ['id', 'uid', 'key']) {
    const hit = findUnique(key, true);
    if (hit) return hit;
  }
  for (const key of ['account', 'user', 'username', 'name', 'label']) {
    const hit = findUnique(key, false);
    if (hit) return hit;
  }
  return rawArr[index] || null;
}

/** 某个值是不是「本机解不开的密文」（空值不算） */
function isUnreadableSecret(value) {
  if (value === undefined || value === null || value === '') return false;
  return decryptResult(value).ok === false;
}

/**
 * 把「快照（已加密的新值）」和「磁盘原文」合并成最终写库的 data（P0-1 的核心）。
 *
 * 契约（**改之前先问用户**）：
 *   - 传 undefined / null → 沿用磁盘原始密文（前端没带这个键）
 *   - 传 ''               → 只有该字段「本机解不开」时才沿用原密文；能解开就允许清空
 *   - 传新值              → 用新值重新加密（serialize 已经做完了）
 *
 * 只在「编辑已有记录」时有意义：新记录没有原密文可沿用。
 */
function mergeSecretPath(out, incoming, raw, secretPath) {
  const arrMatch = /^(\w+)\[\]\.(\w+)$/.exec(secretPath);

  if (!arrMatch) {
    const rawVal = raw ? raw[secretPath] : undefined;
    if (rawVal === undefined || rawVal === null || rawVal === '') return;
    const hasIn = incoming && Object.prototype.hasOwnProperty.call(incoming, secretPath);
    const inVal = hasIn ? incoming[secretPath] : undefined;
    if (!hasIn || inVal === undefined || inVal === null) {
      out[secretPath] = rawVal;
      return;
    }
    if (String(inVal) === '' && isUnreadableSecret(rawVal)) out[secretPath] = rawVal;
    return;
  }

  const [, arrKey, subKey] = arrMatch;
  const inArr = incoming ? incoming[arrKey] : null;
  const rawArr = raw ? raw[arrKey] : null;
  const outArr = out[arrKey];
  if (!Array.isArray(inArr) || !Array.isArray(rawArr) || !Array.isArray(outArr)) return;

  for (let i = 0; i < inArr.length; i++) {
    const item = inArr[i];
    const outItem = outArr[i];
    if (!item || typeof item !== 'object' || !outItem || typeof outItem !== 'object') continue;
    const rawItem = matchRawItem(item, rawArr, i);
    if (!rawItem || typeof rawItem !== 'object') continue;
    const rawVal = rawItem[subKey];
    if (rawVal === undefined || rawVal === null || rawVal === '') continue;
    const hasIn = Object.prototype.hasOwnProperty.call(item, subKey);
    const inVal = hasIn ? item[subKey] : undefined;
    if (!hasIn || inVal === undefined || inVal === null) {
      outItem[subKey] = rawVal;
      continue;
    }
    if (String(inVal) === '' && isUnreadableSecret(rawVal)) outItem[subKey] = rawVal;
  }
}

/**
 * 生成「可以安全写库」的 data：先按 SECRET_KEYS 加密，再按上面的契约合并原密文。
 *
 * save() 和迁移 Api.write() 都必须走这里 —— 直接 serialize 会丢掉解不开的密文。
 */
function serializeSafely(collection, incoming, rawExisting) {
  const out = serialize(collection, incoming);
  const secrets = SECRET_KEYS[collection] || [];
  if (!secrets.length) return out;
  const raw = rawExisting || null;
  if (!raw) return out;
  for (const path of secrets) mergeSecretPath(out, incoming, raw, path);
  return out;
}

function hydrate(row) {
  let data = {};
  try {
    data = JSON.parse(row.data || '{}');
  } catch (e) {
    data = {};
  }
  /**
   * 解不开的密码字段**从 data 里移除**，并在记录上标 __secretUnreadable（不落库）。
   *
   * 为什么不返回空串：data 会被表单提交回来，空串写回 = 密文被永久抹掉（P0-1）。
   * 前端拿到这个标记后：输入框提示「本机无法解密，留空保持不变」，提交时不带该键。
   */
  const dec = deserializeTracked(row.collection, data);
  const rec = {
    id: row.id,
    collection: row.collection,
    title: row.title,
    data: dec.data,
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    favorite: !!row.favorite,
    // 0 = 未删除；非 0 = 移入回收站的时间戳（老库由迁移 v6 补成 0）
    deleted_at: Number(row.deleted_at) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (dec.unreadable.length) rec.__secretUnreadable = dec.unreadable;
  return rec;
}


/**
 * 生成「可搜索的 data 表达式」：把密码字段的值替换成占位符。
 *
 * 用 SQLite 的 json_set 把密码字段置空，再转回文本匹配。
 * 这样搜 "enc:" / "raw:" / 明文密码都搜不到。
 *
 * 注意：嵌套路径（accounts[].password）没法用 json_set 简单处理，
 * 所以对 sites 额外把整个 accounts 字段排除（账号名还能搜，密码搜不到）。
 */
function searchableDataExpr(collection) {
  const secrets = SECRET_KEYS[collection] || [];
  if (!secrets.length) return 'data';

  // 顶层密码字段：用 json_set 置空
  const topLevel = secrets.filter((k) => !k.includes('[]'));
  // 嵌套路径（accounts[].password）：整个数组字段排除
  const nestedArrays = secrets
    .filter((k) => k.includes('[]'))
    .map((k) => k.split('[]')[0]);

  let expr = 'data';
  const sets = [];
  for (const k of topLevel) sets.push(`'$.${k}', ''`);
  for (const k of nestedArrays) sets.push(`'$.${k}', ''`);
  if (sets.length) {
    expr = `json_set(data, ${sets.join(', ')})`;
  }
  return expr;
}

/**
 * 列表。
 *
 * **默认只返回未删除的**（deleted_at = 0）—— 这条不能反过来，
 * 否则所有现有页面（列表 / 统计 / 导出 / 详情）都会被回收站里的记录污染。
 * 需要连回收站一起看的场景显式传 `{ includeDeleted: true }`。
 */
function list(collection, opts = {}) {
  const { keyword = '', tag = '', favorite = false, includeDeleted = false } = opts;
  const where = ['collection = ?'];
  const params = [collection];
  if (!includeDeleted) where.push('deleted_at = 0');
  if (keyword) {
    // 搜索范围：标题 + 标签 + data（**排除密码字段**）
    //
    // 为什么排除：data 是整段 JSON，密码也在里面。
    // 虽然密码是 enc: 密文（搜明文搜不到），但：
    //   1. 搜 "enc:" 能列出所有有密码的记录（信息泄露）
    //   2. 万一某条是 raw: 前缀（未加密），明文密码会被搜出来
    // 所以搜索时把密码字段的值替换成占位符再匹配。
    where.push('(title LIKE ? OR tags LIKE ? OR ' + searchableDataExpr(collection) + ' LIKE ?)');
    const like = `%${keyword}%`;
    params.push(like, like, like);
  }
  if (tag) {
    where.push('tags LIKE ?');
    params.push(`%${tag}%`);
  }
  if (favorite) where.push('favorite = 1');
  const rows = all(
    `SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY favorite DESC, updated_at DESC LIMIT 5000`,
    params
  );
  return rows.map(hydrate);
}

/** 单条读取。默认看不到回收站里的，includeDeleted 才给。 */
function get(id, opts = {}) {
  const includeDeleted = !!(opts && opts.includeDeleted);
  const rows = all(
    'SELECT * FROM records WHERE id = ?' + (includeDeleted ? '' : ' AND deleted_at = 0'),
    [id]
  );
  return rows.length ? hydrate(rows[0]) : null;
}

/**
 * 保存时保留 schema 里已经不存在的字段。
 * 这样「新版删了某个字段」或「老数据里有新版不认识的字段」时，
 * 编辑保存一次也不会把老数据悄悄抹掉。
 */
function keepUnknownFields(collection, incoming, existingData) {
  const conf = COLLECTION_MAP[collection];
  const known = new Set(((conf && conf.fields) || []).map((f) => f.key));
  const out = Object.assign({}, incoming || {});
  for (const key of Object.keys(existingData || {})) {
    if (!known.has(key) && out[key] === undefined) out[key] = existingData[key];
  }
  return out;
}

function save(input) {
  const { id, collection, tags = [], favorite = false } = input || {};
  // 内部标记（__secretUnreadable 等）只在内存里用，绝不落库
  const data = stripInternalKeys(input && input.data);
  const conf = COLLECTION_MAP[collection];
  if (!conf) throw new Error('未知集合: ' + collection);
  const now = Date.now();

  let recordId = id;
  /**
   * 查重时**连回收站一起查**：否则回收站里那条的 id 会被当成新记录，
   * INSERT 撞主键直接抛错（importAll 把带 id 的回收站记录导回来时就会踩到）。
   * 顺手把 deleted_at 归零：能保存 = 它又活了。
   */
  const existing = recordId ? get(recordId, { includeDeleted: true }) : null;
  const finalData = existing ? keepUnknownFields(collection, data, existing.data) : data;

  const title = String(finalData[conf.titleField] || '').trim() || '(未命名)';
  /**
   * P0-1：写库前按「原密文沿用」契约合并（见 serializeSafely 的注释）。
   * 解不开的密码字段在 hydrate 时已被移除，如果这里直接 serialize，
   * 空值会被重新加密成 ''，磁盘上的密文就永久没了。
   */
  const rawExisting = existing ? rawDataById(recordId) : null;
  const payload = JSON.stringify(serializeSafely(collection, finalData, rawExisting));
  const tagStr = Array.isArray(tags) ? tags.join(',') : String(tags || '');
  if (Array.isArray(tags) && tags.length) mergeTags(tags);

  if (recordId && existing) {
    run('UPDATE records SET title = ?, data = ?, tags = ?, favorite = ?, updated_at = ?, deleted_at = 0 WHERE id = ?', [
      title,
      payload,
      tagStr,
      favorite ? 1 : 0,
      now,
      recordId
    ]);
  } else {
    recordId = 'r_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    run(
      'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [recordId, collection, title, payload, tagStr, favorite ? 1 : 0, now, now]
    );
  }
  schedulePersist();
  return get(recordId);
}

/**
 * 删除 = 移入回收站（软删除），不再真的 DELETE。
 *
 * 为什么不再顺手清关联：接口记录只是进回收站，用例↔接口的关联留着，
 * 恢复时才能一起回来。已经进回收站的接口，它的关联靠 links 里的
 * join（r.deleted_at = 0）过滤掉，界面上看不到，等于「已经没了」。
 */
function remove(id) {
  const rows = all('SELECT id, deleted_at FROM records WHERE id = ?', [id]);
  if (!rows.length) return false;
  if (!Number(rows[0].deleted_at)) {
    run('UPDATE records SET deleted_at = ? WHERE id = ?', [Date.now(), id]);
  }
  schedulePersist();
  return true;
}

/** 彻底删除（回收站里的「彻底删除」）：真的 DELETE，关联也一起清掉 */
function purge(id) {
  const rows = all('SELECT collection FROM records WHERE id = ?', [id]);
  if (!rows.length) return false;
  run('DELETE FROM records WHERE id = ?', [id]);
  if (rows[0].collection === 'apis') run('DELETE FROM case_api_links WHERE api_id = ?', [id]);
  schedulePersist();
  return true;
}

/** 从回收站恢复：deleted_at 归零 */
function restore(id) {
  run('UPDATE records SET deleted_at = 0 WHERE id = ? AND deleted_at > 0', [id]);
  const n = Number(db.getRowsModified()) || 0;
  if (n) schedulePersist();
  return n > 0;
}

/** 回收站列表：按删除时间倒序（最近删的在最上面） */
function listTrash() {
  return all('SELECT * FROM records WHERE deleted_at > 0 ORDER BY deleted_at DESC').map(hydrate);
}

/** 回收站条数（侧栏角标用） */
function countTrash() {
  const rows = all('SELECT COUNT(*) AS n FROM records WHERE deleted_at > 0');
  return rows.length ? Number(rows[0].n) || 0 : 0;
}

/** 清空回收站（二次确认在界面侧） */
function clearTrash() {
  const ids = all("SELECT id FROM records WHERE deleted_at > 0 AND collection = 'apis'").map((r) => String(r.id));
  run('DELETE FROM records WHERE deleted_at > 0');
  const removed = Number(db.getRowsModified()) || 0;
  for (const id of ids) run('DELETE FROM case_api_links WHERE api_id = ?', [id]);
  if (removed) schedulePersist();
  return { removed };
}

/**
 * 清理回收站里超过 N 天的记录。
 *
 * days 不传/非法时用 TRASH_RETENTION_DAYS（30 天）。
 * 启动时跑一次（ipc-records 的 register 里），界面上不需要按钮。
 */
function purgeExpired(days) {
  const d = Number(days);
  const keep = Number.isFinite(d) && d > 0 ? d : TRASH_RETENTION_DAYS;
  const cutoff = Date.now() - keep * 86400000;
  const ids = all("SELECT id FROM records WHERE deleted_at > 0 AND deleted_at <= ? AND collection = 'apis'", [cutoff]).map(
    (r) => String(r.id)
  );
  run('DELETE FROM records WHERE deleted_at > 0 AND deleted_at <= ?', [cutoff]);
  const removed = Number(db.getRowsModified()) || 0;
  for (const id of ids) run('DELETE FROM case_api_links WHERE api_id = ?', [id]);
  if (removed) schedulePersist();
  return { removed, days: keep };
}

/** 统计。默认不含回收站，includeDeleted 才一起数（导出/整库口径用） */
function counts(opts = {}) {
  const includeDeleted = !!(opts && opts.includeDeleted);
  const rows = all(
    'SELECT collection, COUNT(*) AS n FROM records' + (includeDeleted ? '' : ' WHERE deleted_at = 0') + ' GROUP BY collection'
  );
  const out = {};
  for (const r of rows) out[r.collection] = r.n;
  return out;
}

/* ------------------------------------------------------------------ *
 * 接口只读镜像（OpenAPI → apis 集合）
 *
 * 幂等 upsert，唯一键 method + url。
 * 只覆盖「OpenAPI 来的」字段；myNote / tags / favorite / headers / body / note
 * 是你自己的东西，同步一律不碰 —— 这条是整个模块的底线。
 * ------------------------------------------------------------------ */

/** 同步会覆盖的字段（syncedAt / lastChange 单独处理，不参与「有没有变」的比对） */
/**
 * 同步时从 openapi 记录里取哪些字段。
 *
 * 注意：这是白名单，新增字段必须加进来，否则同步时会被静默丢弃。
 * （v0.27.1/0.27.2 的 body/headers/paramTable/respExample 就是因为漏了这里，
 *   解析对了但存不进去，详情页一直显示「—」。）
 */
const API_SYNCED_KEYS = [
  'name',
  'method',
  'url',
  // module **不在此列**：它是用户资产（v0.46.0 起可在表单里手选/手建），
  // 同步时不覆盖。首次导入仍会写入（见下面 USER_OWNED_FILL_KEYS）。
  'summary',
  'params',
  'paramSpec',
  'paramTable',
  'reqSchema',
  'respSchema',
  'respExample',
  'headers',
  'body',
  'bodyType',
  'completeness',
  'source'
];

/**
 * 「同步时只填空值」的字段（用户资产类）。
 *
 * 为什么单独列一份：
 *   module（接口模块）从 v0.46.0 起可以在表单里手选/手建，是**用户的分类**，
 *   不属于 openapi 的接口定义。如果跟着同步覆盖，用户改完一同步就白改。
 *   但首次导入时又该有值（从 Apifox 的 tags 来），所以：
 *     - 新增记录：有就填
 *     - 已有记录：**只在原值为空时**才填，非空一律保留用户的
 */
const USER_OWNED_FILL_KEYS = ['module'];

/** 最近一次同步里「有实质变更」的接口（附关联用例），供界面重新打开影响面清单 */
function lastSyncChanges() {
  const v = getMeta('lastSyncChanges');
  return v && typeof v === 'object' ? v : null;
}

function apiIndex() {
  const map = new Map();
  for (const row of all("SELECT * FROM records WHERE collection = 'apis' AND deleted_at = 0")) {
    const rec = hydrate(row);
    const key = apiKey(rec.data.method, rec.data.url);
    if (key && !map.has(key)) map.set(key, rec);
  }
  return map;
}

function syncApis(input) {
  const items = Array.isArray(input && input.items) ? input.items : [];
  /**
   * 解析层去重掉的条目（openapi.parseOpenApi 的 stats.dupList / dup）。
   *
   * 为什么由调用方传进来：去重发生在解析层，走到这里那些条目已经不在 items 里了，
   * 本函数自己重算不出来。dupList 已被解析层截断到 8 条，dup 才是准确总数。
   */
  const dupList = Array.isArray(input && input.dupList) ? input.dupList : [];
  const dupTotal = Math.max(Number((input && input.dupCount) || 0) || 0, dupList.length);
  const now = Date.now();
  const stats = { total: items.length, added: 0, updated: 0, skipped: 0, unchanged: 0, invalid: 0, dupInBatch: 0, missingDesc: 0 };
  /**
   * 「没写进库的条目」明细：接口名 + method/url + 原因，最多 MAX_SKIP_DETAIL 条。
   *
   * 为什么加：结果卡片原来只报「跳过 2 / 缺描述 5」这样的数字，用户看到「跳过 2」
   * 完全不知道跳过了哪两条、为什么跳过，只能去库里一条条猜。
   * 这和信息不透明是同一类毛病（v0.69 在 playwright 录制那边修过：把「忽略 N 行」
   * 改成列出每一行的原文 + 原因）。
   *
   * 为什么限条数：一次同步几百个接口时全塞进弹窗等于刷屏，
   * 超出部分只留总数（skippedListTotal），界面显示「还有 N 条」。
   */
  const skippedList = [];
  let skippedListTotal = 0;
  /** 记一条明细：总数照加，明细只留前 MAX_SKIP_DETAIL 条 */
  const putSkipped = (entry) => {
    skippedListTotal++;
    if (skippedList.length < MAX_SKIP_DETAIL) skippedList.push(entry);
  };
  // 解析层的重复：总数单独记（dupList 可能少于此数），明细按剩余名额补
  skippedListTotal += dupTotal;
  for (const d of dupList) {
    if (skippedList.length >= MAX_SKIP_DETAIL) break;
    const o = d && typeof d === 'object' ? d : {};
    skippedList.push({
      name: String(o.name || ''),
      method: String(o.method || ''),
      url: String(o.url || ''),
      kind: 'dup',
      reason: String(o.reason || '同一个文件里重复定义（同方法同地址）')
    });
  }
  const byKey = apiIndex();
  const seen = new Set();
  const changedList = [];

  run('BEGIN');
  try {
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        stats.invalid++;
        putSkipped({ name: '', method: '', url: '', kind: 'invalid', reason: '这一条不是接口对象，读不出方法/地址' });
        continue;
      }
      const key = apiKey(item.method, item.url);
      if (!key) {
        stats.invalid++;
        const m = String(item.method || '').trim();
        const u = String(item.url || '').trim();
        putSkipped({
          name: String(item.name || ''),
          method: m,
          url: u,
          kind: 'invalid',
          reason: !m && !u ? 'method 和 url 都是空的，算不出唯一键' : !m ? 'method 是空的，算不出唯一键' : 'url 是空的，算不出唯一键'
        });
        continue;
      }
      // 同一批里重复：解析层已经去过一次，这里兜底（调用方可能直接塞原始数组）
      if (seen.has(key)) {
        stats.dupInBatch++;
        stats.skipped++;
        putSkipped({
          name: String(item.name || ''),
          method: String(item.method || ''),
          url: String(item.url || ''),
          kind: 'dupInBatch',
          reason: '这一批里又出现了一次（同方法同地址），只写了一条'
        });
        continue;
      }
      seen.add(key);

      const hit = byKey.get(key);
      if (!hit) {
        const data = {};
        for (const k of API_SYNCED_KEYS) if (item[k] !== undefined) data[k] = item[k];
        // 用户资产类字段：新增时照常填（首次导入要有值）
        for (const k of USER_OWNED_FILL_KEYS) if (item[k] !== undefined) data[k] = item[k];
        data.source = 'openapi';
        data.syncedAt = now;
        data.lastChange = '';
        save({ collection: 'apis', data, tags: [], favorite: false });
        stats.added++;
        continue;
      }

      let changed = false;
      for (const k of API_SYNCED_KEYS) {
        if (item[k] === undefined) continue;
        const before = hit.data[k] === undefined || hit.data[k] === null ? '' : String(hit.data[k]);
        const after = item[k] === null ? '' : String(item[k]);
        if (before !== after) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        stats.skipped++;
        stats.unchanged++;
        // 没变化也记明细：用户的「跳过 2」十有八九就是这种，不列出来还是会问「跳过了谁」
        putSkipped({
          name: String(item.name || ''),
          method: String(item.method || ''),
          url: String(item.url || ''),
          kind: 'unchanged',
          reason: '库里已有这条且内容一致，没有要更新的字段'
        });
        continue;
      }

      const next = Object.assign({}, hit.data, { syncedAt: now, source: 'openapi' });
      for (const k of API_SYNCED_KEYS) if (item[k] !== undefined) next[k] = item[k];
      // 用户资产类字段：**只在原值为空时**才填，非空保留用户手改的
      for (const k of USER_OWNED_FILL_KEYS) {
        const cur = hit.data[k];
        const empty = cur === undefined || cur === null || String(cur).trim() === '';
        if (empty && item[k] !== undefined) next[k] = item[k];
      }
      // 变更 diff：只挑「会让已写用例失效」的结构变化，描述文案改了不算
      const changes = apiDiff(hit.data, next);
      next.lastChange = changes.length ? JSON.stringify({ at: now, changes }) : '';
      save({ id: hit.id, collection: 'apis', data: next, tags: hit.tags, favorite: hit.favorite });
      stats.updated++;
      if (changes.length) {
        changedList.push({ apiId: hit.id, name: next.name || '', method: next.method || '', url: next.url || '', changes });
      }
    }
    run('COMMIT');
  } catch (e) {
    run('ROLLBACK');
    throw e;
  }

  // 影响面：每个变更接口挂着的用例（关联表查询必须在 COMMIT 之后）
  let affected = 0;
  const seenCases = new Set();
  for (const c of changedList) {
    c.cases = links.forApi(c.apiId).map((l) => ({ filePath: l.file_path, caseTitle: l.case_title }));
    for (const k of c.cases) seenCases.add(k.filePath + '\u0001' + k.caseTitle);
  }
  affected = seenCases.size;

  setMeta('lastSyncChanges', changedList.length ? { at: now, changed: changedList, affectedCases: affected } : '');

  schedulePersist();
  stats.missingDesc = items.filter((i) => i && i.completeness === 'missing-desc' && apiKey(i.method, i.url)).length;
  stats.changed = changedList.length;
  stats.affectedCases = affected;
  stats.changedList = changedList;
  // 明细在后（结论在前）；skippedListTotal 是截断前的总数，界面用它显示「还有 N 条」
  stats.skippedList = skippedList;
  stats.skippedListTotal = skippedListTotal;
  stats.at = now;
  return stats;
}

/* ------------------------------------------------------------------ *
 * 用例 ↔ 接口关联
 *
 * 关联既不属于用例内容（md 只读，且用例先于接口存在），也不属于接口记录，
 * 它是两份资产之间的映射，所以单独一张表，改路径只改一条。
 * 软键：file_path + case_title 回找用例；找不到就显示「已失效」，不报错。
 * ------------------------------------------------------------------ */

function linkHydrate(row) {
  return {
    id: Number(row.id),
    file_path: String(row.file_path || ''),
    case_title: String(row.case_title || ''),
    case_index:
      row.case_index === null || row.case_index === undefined || row.case_index === '' ? null : Number(row.case_index),
    api_id: String(row.api_id || ''),
    source: String(row.source || 'manual'),
    created_at: Number(row.created_at || 0)
  };
}

function linkIndexOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 用例 ↔ 接口关联。
 *
 * 关联表本身也有软删除的坑：接口记录进了回收站，指向它的关联不该再冒出来。
 * 所以下面几个查询都 join 一次 records 并卡 deleted_at = 0 ——
 * 记录一移入回收站，关联自然「看不见」；恢复回来就又能看见。
 * （真正 DELETE 关联只发生在 purge / clearTrash / purgeExpired 里。）
 */
const links = {
  /** 某个接口记录下挂了哪些用例 */
  forApi(apiId) {
    if (!apiId) return [];
    return all(
      'SELECT l.* FROM case_api_links l JOIN records r ON r.id = l.api_id AND r.deleted_at = 0 WHERE l.api_id = ? ORDER BY l.created_at, l.id',
      [String(apiId)]
    ).map(linkHydrate);
  },

  /** 某条用例（文件 + 标题）挂了哪些接口 */
  forCase(filePath, caseTitle) {
    const file = String(filePath || '').trim();
    const title = String(caseTitle || '').trim();
    if (!file || !title) return [];
    return all(
      'SELECT l.* FROM case_api_links l JOIN records r ON r.id = l.api_id AND r.deleted_at = 0 WHERE l.file_path = ? AND l.case_title = ? ORDER BY l.created_at, l.id',
      [file, title]
    ).map(linkHydrate);
  },

  /** api_id → 关联条数，列表页角标/详情页数字用 */
  counts() {
    const out = {};
    for (const r of all(
      'SELECT l.api_id AS api_id, COUNT(*) AS n FROM case_api_links l JOIN records r ON r.id = l.api_id AND r.deleted_at = 0 GROUP BY l.api_id'
    )) {
      out[r.api_id] = Number(r.n);
    }
    return out;
  },

  /**
   * 整组替换（弹窗点保存）。
   * 传空数组 = 全部取消关联，不报错 —— 没关联是合法状态。
   */
  save(input) {
    const { apiId, targets } = input || {};
    if (!apiId) throw new Error('缺少接口 id');

    const clean = [];
    const wanted = new Set();
    for (const t of Array.isArray(targets) ? targets : []) {
      if (!t) continue;
      const filePath = String(t.filePath || '').trim();
      const caseTitle = String(t.caseTitle || '').trim();
      if (!filePath || !caseTitle) continue;
      const key = filePath + '\u0001' + caseTitle;
      if (wanted.has(key)) continue;
      wanted.add(key);
      clean.push({ filePath, caseTitle, caseIndex: linkIndexOf(t.caseIndex) });
    }

    const before = new Set(links.forApi(apiId).map((r) => r.file_path + '\u0001' + r.case_title));
    const now = Date.now();
    run('BEGIN');
    try {
      run('DELETE FROM case_api_links WHERE api_id = ?', [String(apiId)]);
      for (const c of clean) {
        run(
          'INSERT OR IGNORE INTO case_api_links (file_path, case_title, case_index, api_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [c.filePath, c.caseTitle, c.caseIndex, String(apiId), 'manual', now]
        );
      }
      run('COMMIT');
    } catch (e) {
      run('ROLLBACK');
      throw e;
    }
    schedulePersist();

    let added = 0;
    for (const k of wanted) if (!before.has(k)) added++;
    let removed = 0;
    for (const k of before) if (!wanted.has(k)) removed++;
    return { apiId: String(apiId), count: wanted.size, added, removed };
  },

  /** 单条加关联（幂等） */
  add(input) {
    const { apiId, filePath, caseTitle, caseIndex } = input || {};
    const file = String(filePath || '').trim();
    const title = String(caseTitle || '').trim();
    if (!apiId || !file || !title) throw new Error('关联缺少参数');
    run(
      'INSERT OR IGNORE INTO case_api_links (file_path, case_title, case_index, api_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [file, title, linkIndexOf(caseIndex), String(apiId), 'manual', Date.now()]
    );
    schedulePersist();
    return { ok: true };
  },

  remove(id) {
    run('DELETE FROM case_api_links WHERE id = ?', [Number(id)]);
    const n = Number(db.getRowsModified()) || 0;
    if (n) schedulePersist();
    return { removed: n };
  },

  /** 清掉指向「已经不存在的接口记录」的关联（删记录时已顺手清过，这是兜底色） */
  prune() {
    run("DELETE FROM case_api_links WHERE api_id NOT IN (SELECT id FROM records WHERE collection = 'apis')");
    const n = Number(db.getRowsModified()) || 0;
    if (n) schedulePersist();
    return { removed: n };
  }
};

/* ------------------------------------------------------------------ *
 * 可配置选项（环境 / 角色·权限 / 标签）
 *
 * 存在 meta 表里（opt.env / opt.role / opt.tags），设置页能增删改。
 * 标签是「用着用着长出来」的：保存记录时手输的新标签自动并进来。
 * ------------------------------------------------------------------ */

function getOptions() {
  const out = {};
  for (const key of Object.keys(OPTION_SETS)) {
    const saved = getMeta('opt.' + key, null);
    out[key] = Array.isArray(saved) ? saved : (OPTION_SETS[key].defaults || []).slice();
  }
  return out;
}

function sanitizeOptions(key, items) {
  const def = OPTION_SETS[key];
  if (!def) throw new Error('未知选项集: ' + key);
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (def.kind === 'env') {
      const rawValue = it && typeof it === 'object' ? (it.value !== undefined ? it.value : it.label) : it;
      const value = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim();
      const label = String((it && it.label) || value).trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({ value, label: label || value, color: String((it && it.color) || 'default') });
    } else {
      const raw = it && typeof it === 'object' ? (it.label !== undefined ? it.label : it.value) : it;
      const s = String(raw === undefined || raw === null ? '' : raw).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function saveOptions(key, items) {
  const clean = sanitizeOptions(key, items);
  setMeta('opt.' + key, clean);
  schedulePersist();
  return getOptions();
}

/** 保存记录时把新标签收进配置（上限 300，别让一张表无限长） */
function mergeTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return;
  const cur = getOptions().tags;
  const seen = new Set(cur);
  const next = cur.slice();
  let changed = false;
  for (const t of list) {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) continue;
    if (next.length >= 300) break;
    seen.add(s);
    next.push(s);
    changed = true;
  }
  if (changed) setMeta('opt.tags', next);
}

/* ------------------------------------------------------------------ *
 * 整库文件（.db）：导出 / 校验 / 恢复
 *
 * 备份目录里的 .db 和自己导出的 .db 是同一种东西 —— 整份 SQLite。
 * 恢复 = 覆盖当前库，所以必须先给当前库留一份安全备份。
 * ------------------------------------------------------------------ */

/** 带 code 的错误：IPC 层只回 message，我们自己看 code 判断是哪一步挂的 */
function errWithCode(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

/** records 表必须有的列（deleted_at 由迁移 v6 补，不在必填集合里） */
const REQUIRED_RECORD_COLUMNS = [
  'id',
  'collection',
  'title',
  'data',
  'tags',
  'favorite',
  'created_at',
  'updated_at'
];

/** case_api_links 存在时它也必须有的列 */
const REQUIRED_LINK_COLUMNS = ['file_path', 'case_title', 'api_id'];

function tableNamesOf(handle) {
  const tables = handle.exec("SELECT name FROM sqlite_master WHERE type='table'") || [];
  return tables.length ? tables[0].values.map((r) => String(r[0])) : [];
}

function columnsOf(handle, table) {
  const res = handle.exec(`PRAGMA table_info(${table})`) || [];
  if (!res.length) return [];
  const nameIdx = res[0].columns.indexOf('name');
  return res[0].values.map((r) => String(r[nameIdx >= 0 ? nameIdx : 1]));
}

/**
 * `PRAGMA integrity_check`（P1-3）。
 *
 * 为什么不用 try/catch 打开来判定：SQLite 对坏文件经常是「能打开、读得出来、
 * 内容已经错了」，只有 integrity_check 会在结构层面报出来。
 */
function checkIntegrity(handle) {
  try {
    const res = handle.exec('PRAGMA integrity_check') || [];
    const msgs = res.length ? res[0].values.map((r) => String(r[0])) : [];
    const ok = msgs.length === 1 && msgs[0].toLowerCase() === 'ok';
    return { ok, messages: ok ? [] : msgs.length ? msgs : ['integrity_check 没有返回结果'] };
  } catch (e) {
    return { ok: false, messages: [String((e && e.message) || e)] };
  }
}

/**
 * 关键列集合校验（P0-2）。
 *
 * 只判断「能不能打开」是不够的：把 records 表结构完全不同的 .db 恢复进来，
 * 打开、迁移都不会报错，之后每条记录都读不出来 —— 这才是最难查的那种坏。
 * 所以恢复前就要确认：records / meta 在、关键列齐、links 表结构对。
 *
 * @returns {{version: number, recordCount: number}}
 */
function validateDbHandle(handle) {
  const names = tableNamesOf(handle);
  if (names.indexOf('records') < 0) {
    throw errWithCode('DB_NOT_WORKBENCH', '这个文件里没有 records 表，不像是本工具的备份');
  }
  if (names.indexOf('meta') < 0) {
    throw errWithCode('DB_SCHEMA_INVALID', '这个文件里没有 meta 表（缺少结构版本信息），不像是本工具的备份');
  }

  const cols = columnsOf(handle, 'records');
  const missing = REQUIRED_RECORD_COLUMNS.filter((c) => cols.indexOf(c) < 0);
  if (missing.length) {
    throw errWithCode(
      'DB_SCHEMA_INVALID',
      'records 表缺少关键列（' + missing.join('、') + '），这个文件不是本工具的数据或已损坏'
    );
  }

  if (names.indexOf('case_api_links') >= 0) {
    const linkCols = columnsOf(handle, 'case_api_links');
    const linkMissing = REQUIRED_LINK_COLUMNS.filter((c) => linkCols.indexOf(c) < 0);
    if (linkMissing.length) {
      throw errWithCode(
        'DB_SCHEMA_INVALID',
        'case_api_links 表缺少关键列（' + linkMissing.join('、') + '），这个文件不是本工具的数据或已损坏'
      );
    }
  }

  let version = 0;
  try {
    const v = handle.exec("SELECT v FROM meta WHERE k = 'schemaVersion'");
    if (v && v.length && v[0].values.length) version = Number(JSON.parse(v[0].values[0][0])) || 0;
  } catch (e) {
    version = 0;
  }
  let recordCount = 0;
  try {
    const c = handle.exec('SELECT COUNT(*) FROM records');
    if (c && c.length) recordCount = Number(c[0].values[0][0]) || 0;
  } catch (e) {
    recordCount = 0;
  }
  return { version, recordCount };
}

/** 备份目录里的 .db，按修改时间倒序（最新的在前） */
function backupFilesByMtime() {
  try {
    return fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const p = path.join(backupDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch (e) {
          mtime = 0;
        }
        return { name: f, path: p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    return [];
  }
}

/**
 * 找「最新一个真能用」的备份：integrity_check + 关键列都要过。
 * 只是文件最新不代表能用（可能正好是坏的那份），所以逐个开。
 */
function usableBackup() {
  for (const item of backupFilesByMtime()) {
    let handle = null;
    try {
      handle = new SQL.Database(new Uint8Array(fs.readFileSync(item.path)));
      if (!checkIntegrity(handle).ok) {
        handle.close();
        continue;
      }
      validateDbHandle(handle);
      return { file: item.path, handle };
    } catch (e) {
      if (handle) {
        try {
          handle.close();
        } catch (e2) {
          /* ignore */
        }
      }
    }
  }
  return null;
}

/** 把坏掉的 data.db 挪进 backups/（留证据，同时让主库路径能重新写） */
function quarantineCorruptDb() {
  try {
    if (!fs.existsSync(dbPath)) return '';
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const target = path.join(backupDir, `data-corrupt-${stamp}.db`);
    fs.renameSync(dbPath, target);
    return target;
  } catch (e) {
    console.error('[store] 隔离坏库失败', e);
    return '';
  }
}

/**
 * 校验一个 .db：能打开、结构对（关键列齐）、读出记录数与结构版本。
 * 错误都带 code：DB_NOT_FOUND / DB_UNREADABLE / DB_NOT_WORKBENCH / DB_SCHEMA_INVALID
 */
function inspectDbFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) throw errWithCode('DB_NOT_FOUND', '文件不存在');
  const bytes = fs.readFileSync(filePath);
  let probe = null;
  try {
    probe = new SQL.Database(new Uint8Array(bytes));
  } catch (e) {
    throw errWithCode('DB_UNREADABLE', '不是可用的数据库文件（可能已损坏或不是 .db）', e);
  }
  try {
    let meta;
    try {
      meta = validateDbHandle(probe);
    } catch (e) {
      // validateDbHandle 自己抛的错误带 code（结构不对）；其余是「压根不是 sqlite」
      if (e && e.code) throw e;
      throw errWithCode('DB_UNREADABLE', '不是可用的数据库文件（可能已损坏或不是 .db）', e);
    }
    return { bytes, version: meta.version, recordCount: meta.recordCount, size: bytes.length };
  } finally {
    if (probe) probe.close();
  }
}

/** 把当前库复制到任意位置（导出整库） */
function exportDbTo(target) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persist();
  fs.copyFileSync(dbPath, target);
  return { file: target, bytes: fs.statSync(target).size };
}

/**
 * 用 .db 覆盖当前库。
 *
 * 顺序（P0-2，改之前先看这段）：
 *   1. 校验文件（能打开 + integrity_check + 关键列）
 *   2. 当前库落盘 + 留 data-before-restore 安全备份
 *   3. 在**局部候选库**上跑完 SCHEMA / LINK_DDL / migrate / ensureTrashSchema
 *      —— 这一步期间 persist 被关掉（persistMuted），data.db 一个字节都不动
 *   4. 全部成功才切 db 并写盘；任何一步失败：close(next)、原库继续用、抛带 code 的错误
 *
 * 原来的写法是「先 db = next 再迁移」，迁移一失败，后面任何一次
 * schedulePersist（400ms 防抖）都会把半迁移的外来库写成 data.db —— 原库就没了。
 */
function restoreFrom(filePath) {
  const info = inspectDbFile(filePath);
  if (info.version > migrations.SCHEMA_VERSION) {
    throw errWithCode(
      'DB_VERSION_TOO_NEW',
      `这个备份的结构是 v${info.version}，当前程序只支持到 v${migrations.SCHEMA_VERSION}，请先升级程序再恢复`
    );
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persist();

  // 先做安全备份：恢复错了还能退回来
  const safety = backupWithName('data-before-restore');

  let next = null;
  try {
    next = new SQL.Database(new Uint8Array(info.bytes));
  } catch (e) {
    throw errWithCode('DB_UNREADABLE', '这个 .db 打不开（可能已损坏）：' + ((e && e.message) || e), e);
  }

  const prevDb = db;
  let migrated = null;
  try {
    const check = checkIntegrity(next);
    if (!check.ok) {
      throw errWithCode('DB_CORRUPT', '备份文件没通过完整性检查：' + check.messages.join('; '));
    }

    // 候选库阶段：db 临时指向 next（迁移脚本读写它），但写盘闸门关死
    db = next;
    persistMuted = true;
    try {
      next.run(SCHEMA);
      next.run(migrations.LINK_DDL);
      migrated = migrate({ backup: false });
      ensureTrashSchema();
      // 迁移之后再校验一次：迁移把结构改坏也要在这里拦住
      validateDbHandle(next);
    } finally {
      persistMuted = false;
      db = prevDb;
    }
  } catch (e) {
    try {
      next.close();
    } catch (e2) {
      /* 关不掉也不影响「原库没动」这个结论 */
    }
    db = prevDb;
    persistMuted = false;
    if (e && e.code) throw e;
    throw errWithCode('RESTORE_FAILED', '恢复失败（当前数据库没有被改动）：' + ((e && e.message) || e), e);
  }

  // 到这里候选库已经完全可用，才真正切库
  try {
    prevDb.close();
  } catch (e) {
    /* 关旧库失败不影响新库接管 */
  }
  db = next;
  lastMigration = migrated;

  try {
    persist();
  } catch (e) {
    throw errWithCode(
      'RESTORE_PERSIST_FAILED',
      '备份已经装上但写盘失败：' + ((e && e.message) || e) + '；恢复前的数据在 ' + safety,
      e
    );
  }

  return {
    backupFile: safety,
    fromVersion: info.version,
    recordCount: info.recordCount,
    migration: lastMigration,
    integrity: checkIntegrity(db),
    counts: counts()
  };
}

function exportAll(includeSecrets, collection) {
  // 回收站里的不导出：导出的是「还在的东西」，恢复用的整库备份另走 .db
  const where = collection ? ' WHERE collection = ? AND deleted_at = 0' : ' WHERE deleted_at = 0';
  const rows = all(`SELECT * FROM records${where} ORDER BY collection, updated_at DESC`, collection ? [collection] : []).map(
    hydrate
  );
  const records = rows.map((r) => {
    // 深拷贝，避免改到缓存里的对象
    const data = JSON.parse(JSON.stringify(r.data || {}));
    if (!includeSecrets) {
      // 用 applySecretPath 清空，支持嵌套路径（accounts[].password）
      for (const key of SECRET_KEYS[r.collection] || []) applySecretPath(data, key, () => '');
    }
    return {
      id: r.id,
      collection: r.collection,
      title: r.title,
      data,
      tags: r.tags,
      favorite: r.favorite,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });

  const payload = { version: 2, exportedAt: new Date().toISOString(), includeSecrets: !!includeSecrets, records };
  // 整库导出才带关联和选项配置：按集合导出时带这些没意义，导回去还会串
  if (!collection) {
    payload.options = getOptions();
    payload.links = all('SELECT * FROM case_api_links ORDER BY id').map(linkHydrate);
  }
  return payload;
}

function importAll(payload, only) {
  const list = Array.isArray(payload) ? payload : payload && payload.records;
  if (!Array.isArray(list)) throw new Error('文件格式不对：缺少 records 数组');
  let ok = 0;
  let skip = 0;
  let keptIds = 0;
  let updated = 0;

  for (const item of list) {
    if (!item || !COLLECTION_MAP[item.collection]) {
      skip++;
      continue;
    }
    if (only && item.collection !== only) {
      skip++;
      continue;
    }

    // 带 id 且本地没有这条 → 保留原 id。
    // 用例↔接口关联是按 api 记录 id 挂的，换机器后 id 变了关联就全断了。
    // 查重连回收站一起查：回收站里同 id 的走「更新」分支，顺带复活，
    // 否则会走 INSERT 撞主键。
    const existing = item.id ? get(String(item.id), { includeDeleted: true }) : null;
    if (existing && existing.collection === item.collection) {
      // 同一个 id 已存在 → 原地更新，重复导入同一份文件不会翻倍
      save({ id: String(item.id), collection: item.collection, data: item.data || {}, tags: item.tags || [], favorite: !!item.favorite });
      updated++;
    } else if (item.id && !existing) {
      const conf = COLLECTION_MAP[item.collection];
      const data = item.data || {};
      const title = String(data[conf.titleField] || item.title || '').trim() || '(未命名)';
      const tags = Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags || '');
      run(
        'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          String(item.id),
          item.collection,
          title,
          JSON.stringify(serialize(item.collection, data)),
          tags,
          item.favorite ? 1 : 0,
          Number(item.created_at) || Date.now(),
          Number(item.updated_at) || Date.now()
        ]
      );
      keptIds++;
    } else {
      save({ collection: item.collection, data: item.data || {}, tags: item.tags || [], favorite: !!item.favorite });
    }
    ok++;
  }

  // 关联：id 保住了就能直接挂回去；重复的忽略
  let linksOk = 0;
  if (!only && payload && Array.isArray(payload.links)) {
    for (const l of payload.links) {
      if (!l || !l.api_id || !l.file_path || !l.case_title) continue;
      if (!get(String(l.api_id))) continue; // 接口记录没导进来，挂上去也是悬空
      run(
        'INSERT OR IGNORE INTO case_api_links (file_path, case_title, case_index, api_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          String(l.file_path),
          String(l.case_title),
          linkIndexOf(l.case_index),
          String(l.api_id),
          String(l.source || 'manual'),
          Number(l.created_at) || Date.now()
        ]
      );
      if (Number(db.getRowsModified()) > 0) linksOk++;
    }
  }

  // 选项配置：并集合并，不覆盖你本机已经调过的显示名
  if (!only && payload && payload.options) {
    const cur = getOptions();
    const merged = {};
    for (const key of Object.keys(OPTION_SETS)) {
      const incoming = sanitizeOptions(key, (payload.options || {})[key] || []);
      if (key === 'env') {
        const seen = new Set((cur.env || []).map((o) => o.value));
        const out = (cur.env || []).slice();
        for (const it of incoming) {
          if (!seen.has(it.value)) {
            seen.add(it.value);
            out.push(it);
          }
        }
        merged.env = out;
      } else {
        merged[key] = Array.from(new Set((cur[key] || []).concat(incoming)));
      }
    }
    for (const key of Object.keys(merged)) setMeta('opt.' + key, merged[key]);
  }

  if (ok) schedulePersist();
  return { imported: ok, skipped: skip, keptIds, updated, links: linksOk };
}

function close() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    persist();
  } catch (e) {
    console.error('[store] final persist failed', e);
  }
}

module.exports = {
  init,
  list,
  get,
  save,
  remove,
  purge,
  restore,
  listTrash,
  countTrash,
  clearTrash,
  purgeExpired,
  TRASH_RETENTION_DAYS,
  DEFAULT_BACKUP_KEEP,
  BACKUP_KEEP_MIN,
  BACKUP_KEEP_MAX,
  setBackupKeep,
  getBackupKeep,
  clampBackupKeep,
  counts,
  links,
  syncApis,
  lastSyncChanges,
  backup,
  listBackups,
  clearBackups,
  clearLocalData,
  getOptions,
  saveOptions,
  exportDbTo,
  inspectDbFile,
  restoreFrom,
  exportAll,
  importAll,
  getMeta,
  setMeta,
  schemaVersion,
  close,
  persist,
  get dbPath() {
    return dbPath;
  },
  get backupDir() {
    return backupDir;
  }
};