'use strict';
/**
 * MySQL / SQLite 测试数据快照 / 清理 / 还原 SQL 生成器。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **只生成 SQL，绝不执行**
 *    平台不连数据库、不存数据库密码。
 *    用户复制 SQL 到自己的客户端执行。
 *
 * 2. **支持两种方言**
 *    mysql  / sqlite
 *
 * 3. **两种库的 SQL 差异（这是本文件的核心）**
 *
 *    | 操作        | MySQL                          | SQLite                          |
 *    |-------------|--------------------------------|---------------------------------|
 *    | 建备份表    | CREATE TABLE bak LIKE src      | CREATE TABLE bak AS SELECT ...  |
 *    | 清空表      | TRUNCATE TABLE x               | DELETE FROM x（无 TRUNCATE）     |
 *    | 重置自增    | ALTER TABLE x AUTO_INCREMENT=1 | DELETE FROM sqlite_sequence ... |
 *    | 外键开关    | SET FOREIGN_KEY_CHECKS = 0     | PRAGMA foreign_keys = OFF       |
 *    | 标识符      | `name`                         | "name"                          |
 *    | 库名切换    | USE db                         | 无（一个文件一个库）             |
 *    | 导出        | mysqldump ...                  | sqlite3 db ".backup out.db"     |
 *    | 空间回收    | 无                             | VACUUM                          |
 *
 * 4. **安全检查**
 *    - TRUNCATE / DROP / 无条件 DELETE → 必须显式确认
 *    - 表名/库名只允许标识符字符（防注入）
 */

/* ============================================================
 * 方言差异表
 * ============================================================ */

const DIALECTS = {
  mysql: {
    label: 'MySQL',
    /** 引用标识符 */
    quote: (n) => '`' + n + '`',
    /** 是否支持 TRUNCATE */
    hasTruncate: true,
    /** 是否有 USE db */
    hasUse: true,
    /** 外键开关语句 */
    fkOff: 'SET FOREIGN_KEY_CHECKS = 0;',
    fkOn: 'SET FOREIGN_KEY_CHECKS = 1;',
    /** 有没有 sqlite_sequence（自增管理表） */
    hasSequence: false,
    /** 空间回收语句（空 = 不需要） */
    vacuum: ''
  },
  sqlite: {
    label: 'SQLite',
    quote: (n) => '"' + n + '"',
    hasTruncate: false,
    hasUse: false,
    fkOff: 'PRAGMA foreign_keys = OFF;',
    fkOn: 'PRAGMA foreign_keys = ON;',
    hasSequence: true,
    vacuum: 'VACUUM;'
  }
};

/** 取方言（未知返回 mysql） */
function getDialect(key) {
  return DIALECTS[key] || DIALECTS.mysql;
}

/* ============================================================
 * 工具
 * ============================================================ */

/** 校验标识符（防注入） */
function safeIdent(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s)) return '';
  return s;
}

/** 时间戳后缀（用于备份表名） */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 生成注释头 */
function header(title, d, extra) {
  const L = [];
  L.push(`-- ${title}（${d.label}）`);
  L.push(`-- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  if (extra) for (const line of extra) L.push(`-- ${line}`);
  L.push('');
  return L;
}

/* ============================================================
 * 快照
 * ============================================================ */

/**
 * 生成快照 SQL。
 *
 * @param {object} opts
 *   - dialect  'mysql' | 'sqlite'
 *   - database 库名（sqlite 下用于注释，SQL 里不需要）
 *   - tables   表名数组
 *   - mode     'table'（建备份表）/ 'dump'（命令行导出）
 * @returns {{ok: boolean, sql?: string, message?: string}}
 */
function genSnapshot(opts = {}) {
  const d = getDialect(opts.dialect);
  const db = safeIdent(opts.database);
  const rawList = Array.isArray(opts.tables) ? opts.tables : [];
  const tables = rawList.map((t) => safeIdent(t)).filter(Boolean);
  const mode = String(opts.mode || 'table');

  if (!rawList.length) return { ok: false, message: '至少填一张表' };
  if (!tables.length) return { ok: false, message: '表名不合法（只能是字母/数字/下划线，且不能以数字开头）' };
  // MySQL 需要库名；SQLite 一个文件就是库，库名只用于注释
  if (d.hasUse && !db) return { ok: false, message: '库名不合法（只能是字母/数字/下划线）' };

  const ts = stamp();
  const q = d.quote;

  /* ---------- 方式一：命令行导出 ---------- */
  if (mode === 'dump') {
    const L = header('测试库快照（命令行导出）', d);

    if (d.label === 'MySQL') {
      L.push(`# 导出：会生成 ${db}_${ts}.sql 文件`);
      L.push('');
      L.push('mysqldump -u root -p --single-transaction --routines --triggers \\');
      L.push(`  ${db} ${tables.join(' ')} \\`);
      L.push(`  > ${db}_${ts}.sql`);
      L.push('');
      L.push('# 恢复：');
      L.push(`# mysql -u root -p ${db} < ${db}_${ts}.sql`);
    } else {
      const dbFile = db ? `${db}.db` : 'test.db';
      L.push(`# 导出：把整个库文件备份一份（SQLite 就是单文件）`);
      L.push('');
      L.push('# 方式 1：直接用 sqlite3 的 .backup（推荐，热备份安全）');
      L.push(`sqlite3 ${dbFile} ".backup '${dbFile.replace(/\.db$/, '')}_${ts}.db'"`);
      L.push('');
      L.push('# 方式 2：导出成 SQL 文本（可跨版本迁移）');
      L.push(`sqlite3 ${dbFile} ".dump" > ${dbFile.replace(/\.db$/, '')}_${ts}.sql`);
      L.push('');
      L.push('# 恢复（SQL 文本）：');
      L.push(`# sqlite3 ${dbFile} < ${dbFile.replace(/\.db$/, '')}_${ts}.sql`);
      L.push('');
      L.push('# 恢复（库文件）：直接替换文件，或');
      L.push(`# sqlite3 ${dbFile} ".restore '${dbFile.replace(/\.db$/, '')}_${ts}.db'"`);
    }
    return { ok: true, sql: L.join('\n') };
  }

  /* ---------- 方式二：建备份表 ---------- */
  const L = header('测试库快照（建备份表）', d, [
    `备份表命名：bak_原表名_${ts}`,
    '恢复时用「还原」生成的 SQL'
  ]);

  if (d.hasUse) {
    L.push(`USE ${q(db)};`);
    L.push('');
  }

  for (const t of tables) {
    const bak = `bak_${t}_${ts}`;
    L.push(`-- 快照：${t} → ${bak}`);

    if (d.label === 'MySQL') {
      // MySQL 有 CREATE TABLE ... LIKE，能完整复制结构（含索引/约束）
      L.push(`CREATE TABLE ${q(bak)} LIKE ${q(t)};`);
      L.push(`INSERT INTO ${q(bak)} SELECT * FROM ${q(t)};`);
    } else {
      // SQLite 没有 LIKE，用 AS SELECT（复制数据 + 基本结构，但丢索引/约束）
      L.push(`CREATE TABLE ${q(bak)} AS SELECT * FROM ${q(t)};`);
    }
    L.push('');
  }

  if (d.label === 'SQLite') {
    L.push('-- 注意：SQLite 的 CREATE TABLE AS SELECT 只复制数据，不复制索引 / 主键 / 自增设置');
    L.push('--       如果要完整结构，用「mysqldump 命令」那种方式导出整个库文件');
    L.push('');
  }

  L.push('-- 验证快照行数：');
  for (const t of tables) {
    const bak = `bak_${t}_${ts}`;
    L.push(`-- SELECT '${t}' AS tbl, (SELECT COUNT(*) FROM ${q(t)}) AS src, (SELECT COUNT(*) FROM ${q(bak)}) AS bak;`);
  }

  return { ok: true, sql: L.join('\n') };
}

/* ============================================================
 * 清理
 * ============================================================ */

/**
 * 生成清理 SQL。
 *
 * @param {object} opts
 *   - dialect  'mysql' | 'sqlite'
 *   - database 库名
 *   - tables   [{name, mode: 'truncate'|'delete'|'drop', where: '条件'}]
 *   - confirm  危险操作必须传 true
 * @returns {{ok: boolean, sql?: string, message?: string, warning?: string}}
 */
function genCleanup(opts = {}) {
  const d = getDialect(opts.dialect);
  const db = safeIdent(opts.database);
  const rawTables = Array.isArray(opts.tables) ? opts.tables : [];
  const confirm = !!opts.confirm;

  if (d.hasUse && !db) return { ok: false, message: '库名不合法' };
  if (!rawTables.length) return { ok: false, message: '至少填一张表' };

  const items = [];
  for (const t of rawTables) {
    const name = safeIdent(t.name);
    if (!name) continue;
    const mode = ['truncate', 'delete', 'drop'].includes(t.mode) ? t.mode : 'delete';
    items.push({ name, mode, where: String(t.where || '').trim() });
  }
  if (!items.length) return { ok: false, message: '没有合法的表名' };

  // 安全检查：清空整表必须确认
  const needConfirm = items.filter((it) => it.mode === 'truncate' || it.mode === 'drop');
  if (needConfirm.length && !confirm) {
    return { ok: false, message: `${needConfirm.map((i) => i.name).join('、')} 会被整表清空，请确认` };
  }
  const noWhere = items.filter((it) => it.mode === 'delete' && !it.where);
  if (noWhere.length && !confirm) {
    return { ok: false, message: `${noWhere.map((i) => i.name).join('、')} 的 DELETE 没有条件（会清空整表），请填条件或确认` };
  }

  const q = d.quote;
  const L = header('测试数据清理', d, ['⚠️ 执行前请确认：这是测试库，不是生产库！']);

  if (d.hasUse) {
    L.push(`USE ${q(db)};`);
    L.push('');
  }

  L.push(`-- 关闭外键检查（清理有外键关联的表时需要）`);
  L.push(d.fkOff);
  L.push('');

  let needVacuum = false;

  for (const it of items) {
    if (it.mode === 'drop') {
      L.push(`-- 删除表：${it.name}（DROP，表结构也没了）`);
      L.push(`DROP TABLE IF EXISTS ${q(it.name)};`);
      L.push('');
      continue;
    }

    if (it.mode === 'truncate') {
      if (d.hasTruncate) {
        L.push(`-- 清空：${it.name}（TRUNCATE，不可回滚）`);
        L.push(`TRUNCATE TABLE ${q(it.name)};`);
        L.push('');
      } else {
        // SQLite 没有 TRUNCATE：DELETE + 重置自增
        L.push(`-- 清空：${it.name}（SQLite 无 TRUNCATE，用 DELETE + 重置自增）`);
        L.push(`DELETE FROM ${q(it.name)};`);
        L.push(`DELETE FROM sqlite_sequence WHERE name = '${it.name}';`);
        L.push('');
        needVacuum = true;
      }
      continue;
    }

    // delete
    if (it.where) {
      L.push(`-- 清理：${it.name} WHERE ${it.where}`);
      L.push(`DELETE FROM ${q(it.name)} WHERE ${it.where};`);
    } else {
      L.push(`-- 清空：${it.name}（无条件 DELETE，全表清空）`);
      L.push(`DELETE FROM ${q(it.name)};`);
      if (d.hasSequence) {
        L.push(`-- 重置自增（让新数据从 1 开始）`);
        L.push(`DELETE FROM sqlite_sequence WHERE name = '${it.name}';`);
      }
    }
    L.push('');
    needVacuum = true;
  }

  L.push('-- 恢复外键检查');
  L.push(d.fkOn);

  if (d.vacuum && needVacuum) {
    L.push('');
    L.push('-- 回收空间（DELETE 后文件不会自动变小，VACUUM 才真正释放）');
    L.push(d.vacuum);
  }

  L.push('');
  L.push('-- 建议：清理完统计一下，确认结果符合预期');
  for (const it of items) {
    if (it.mode === 'drop') continue;
    L.push(`-- SELECT COUNT(*) AS ${q(it.name)} FROM ${q(it.name)};`);
  }

  return {
    ok: true,
    sql: L.join('\n'),
    warning: '生成的 SQL 需要你自己复制到数据库客户端执行，平台不连数据库。'
  };
}

/* ============================================================
 * 还原
 * ============================================================ */

/**
 * 生成还原 SQL。
 *
 * @param {object} opts
 *   - dialect  'mysql' | 'sqlite'
 *   - database 库名
 *   - pairs    [{table, backup, mode: 'insert'|'replace'|'truncate-insert'}]
 * @returns {{ok: boolean, sql?: string, message?: string}}
 */
function genRestore(opts = {}) {
  const d = getDialect(opts.dialect);
  const db = safeIdent(opts.database);
  const rawPairs = Array.isArray(opts.pairs) ? opts.pairs : [];

  if (d.hasUse && !db) return { ok: false, message: '库名不合法' };
  if (!rawPairs.length) return { ok: false, message: '至少给一组「原表 / 备份表」' };

  const pairs = [];
  for (const p of rawPairs) {
    const table = safeIdent(p.table);
    const backup = safeIdent(p.backup);
    if (!table || !backup) continue;
    const mode = ['insert', 'replace', 'truncate-insert'].includes(p.mode) ? p.mode : 'replace';
    pairs.push({ table, backup, mode });
  }
  if (!pairs.length) return { ok: false, message: '没有合法的表名对' };

  const q = d.quote;
  const L = header('测试数据还原', d, [
    'INSERT 模式会在原数据上追加（可能主键冲突）',
    'REPLACE 模式会覆盖同主键的行（SQLite 需要表有主键/唯一索引）',
    '先清空再灌 模式最彻底'
  ]);

  if (d.hasUse) {
    L.push(`USE ${q(db)};`);
    L.push('');
  }

  L.push(d.fkOff);
  L.push('');

  let needVacuum = false;

  for (const p of pairs) {
    if (p.mode === 'truncate-insert') {
      L.push(`-- 还原：${p.backup} → ${p.table}（先清空再灌）`);
      if (d.hasTruncate) {
        L.push(`TRUNCATE TABLE ${q(p.table)};`);
      } else {
        L.push(`DELETE FROM ${q(p.table)};`);
        needVacuum = true;
      }
      L.push(`INSERT INTO ${q(p.table)} SELECT * FROM ${q(p.backup)};`);
    } else if (p.mode === 'replace') {
      L.push(`-- 还原：${p.backup} → ${p.table}（REPLACE，同主键覆盖）`);
      if (d.label === 'SQLite') {
        L.push(`INSERT OR REPLACE INTO ${q(p.table)} SELECT * FROM ${q(p.backup)};`);
      } else {
        L.push(`REPLACE INTO ${q(p.table)} SELECT * FROM ${q(p.backup)};`);
      }
    } else {
      L.push(`-- 还原：${p.backup} → ${p.table}（INSERT，追加）`);
      L.push(`INSERT INTO ${q(p.table)} SELECT * FROM ${q(p.backup)};`);
    }
    L.push('');
  }

  L.push(d.fkOn);

  if (d.vacuum && needVacuum) {
    L.push('');
    L.push('-- 回收空间');
    L.push(d.vacuum);
  }

  return { ok: true, sql: L.join('\n') };
}

/* ============================================================
 * 备份表识别
 * ============================================================ */

/**
 * 从表名列表里筛出备份表（`bak_原表_YYYYMMDD_HHmmss`）。
 * @param {string[]} tables
 */
function listBackupTables(tables) {
  return (Array.isArray(tables) ? tables : [])
    .filter((t) => /^bak_[A-Za-z_][A-Za-z0-9_$]*_\d{8}_\d{6}$/.test(String(t)))
    .map((t) => {
      const m = /^bak_(.+)_(\d{8})_(\d{6})$/.exec(t);
      return {
        backup: t,
        table: m ? m[1] : '',
        stamp: m ? `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)} ${m[3].slice(0, 2)}:${m[3].slice(2, 4)}:${m[3].slice(4, 6)}` : ''
      };
    });
}

/** 支持的方言列表（给前端下拉） */
function listDialects() {
  return Object.entries(DIALECTS).map(([key, v]) => ({ key, label: v.label }));
}

module.exports = {
  genSnapshot,
  genCleanup,
  genRestore,
  listBackupTables,
  listDialects,
  safeIdent,
  stamp,
  getDialect,
  DIALECTS
};