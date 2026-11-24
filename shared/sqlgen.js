'use strict';
/**
 * MySQL 测试数据快照 / 清理 SQL 生成器。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **只生成 SQL，绝不执行**
 *    平台不连数据库、不存数据库密码。
 *    用户复制 SQL 到自己的客户端执行。
 *
 * 2. **三种操作**
 *    - 快照：把表复制到备份表（`bak_表名_时间戳`）
 *    - 清理：DELETE（带条件）或 TRUNCATE
 *    - 还原：从备份表恢复
 *
 * 3. **安全检查**
 *    - TRUNCATE 不能带 WHERE → 必须显式确认「全表清空」
 *    - 生产库加醒目警告
 *    - 生成的 SQL 带注释说明每一步在做什么
 */

/** 校验表名合法性（防注入） */
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

/**
 * 生成快照 SQL。
 *
 * 两种方式：
 *   - CREATE TABLE ... AS SELECT（建备份表，数据留在库里）
 *   - mysqldump 命令（导出到文件）
 *
 * @param {object} opts
 *   - database  库名
 *   - tables    表名数组
 *   - mode      'table'（建备份表）/ 'dump'（mysqldump 命令）
 * @returns {{ok: boolean, sql?: string, message?: string}}
 */
function genSnapshot(opts = {}) {
  const db = safeIdent(opts.database);
  const rawList = Array.isArray(opts.tables) ? opts.tables : [];
  const tables = rawList.map((t) => safeIdent(t)).filter(Boolean);
  const mode = String(opts.mode || 'table');

  if (!db) return { ok: false, message: '库名不合法（只能是字母/数字/下划线）' };
  if (!rawList.length) return { ok: false, message: '至少填一张表' };
  if (!tables.length) return { ok: false, message: '表名不合法（只能是字母/数字/下划线，且不能以数字开头）' };

  const ts = stamp();
  const L = [];

  if (mode === 'dump') {
    // mysqldump 命令
    L.push('# MySQL 测试库快照（mysqldump 导出）');
    L.push(`# 生成时间：${new Date().toLocaleString('zh-CN')}`);
    L.push(`# 用法：在命令行执行下面的命令，会生成 ${db}_${ts}.sql 文件`);
    L.push('');
    L.push(`mysqldump -u root -p --single-transaction --routines --triggers \\`);
    L.push(`  ${db} ${tables.join(' ')} \\`);
    L.push(`  > ${db}_${ts}.sql`);
    L.push('');
    L.push('# 恢复：');
    L.push(`# mysql -u root -p ${db} < ${db}_${ts}.sql`);
    return { ok: true, sql: L.join('\n') };
  }

  // CREATE TABLE ... AS SELECT
  L.push('-- MySQL 测试库快照（建备份表）');
  L.push(`-- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push(`-- 备份表命名：bak_原表名_${ts}`);
  L.push('-- 恢复时用下方的「还原」SQL');
  L.push('');
  L.push(`USE \`${db}\`;`);
  L.push('');

  for (const t of tables) {
    const bak = `bak_${t}_${ts}`;
    L.push(`-- 快照：${t} → ${bak}`);
    L.push(`CREATE TABLE \`${bak}\` LIKE \`${t}\`;`);
    L.push(`INSERT INTO \`${bak}\` SELECT * FROM \`${t}\`;`);
    L.push('');
  }

  L.push('-- 验证快照行数：');
  for (const t of tables) {
    const bak = `bak_${t}_${ts}`;
    L.push(`-- SELECT '${t}' AS tbl, (SELECT COUNT(*) FROM \`${t}\`) AS src, (SELECT COUNT(*) FROM \`${bak}\`) AS bak;`);
  }

  return { ok: true, sql: L.join('\n') };
}

/**
 * 生成清理 SQL。
 *
 * @param {object} opts
 *   - database   库名
 *   - tables    [{name, mode: 'truncate'|'delete'|'drop', where: '条件'}]
 *   - confirm   全表清空必须传 true
 * @returns {{ok: boolean, sql?: string, message?: string, warning?: string}}
 */
function genCleanup(opts = {}) {
  const db = safeIdent(opts.database);
  const rawTables = Array.isArray(opts.tables) ? opts.tables : [];
  const confirm = !!opts.confirm;

  if (!db) return { ok: false, message: '库名不合法' };
  if (!rawTables.length) return { ok: false, message: '至少选一张表' };

  const items = [];
  for (const t of rawTables) {
    const name = safeIdent(t.name);
    if (!name) continue;
    const mode = ['truncate', 'delete', 'drop'].includes(t.mode) ? t.mode : 'delete';
    items.push({ name, mode, where: String(t.where || '').trim() });
  }
  if (!items.length) return { ok: false, message: '没有合法的表名' };

  // 安全检查：TRUNCATE / DROP 会清空整表，必须确认
  const needConfirm = items.filter((it) => it.mode === 'truncate' || it.mode === 'drop');
  if (needConfirm.length && !confirm) {
    return {
      ok: false,
      message: `${needConfirm.map((i) => i.name).join('、')} 会被整表清空，请确认`
    };
  }

  // DELETE 必须带 WHERE（否则等同于清空）
  const noWhere = items.filter((it) => it.mode === 'delete' && !it.where);
  if (noWhere.length && !confirm) {
    return {
      ok: false,
      message: `${noWhere.map((i) => i.name).join('、')} 的 DELETE 没有条件（会清空整表），请填条件或确认`
    };
  }

  const L = [];
  L.push('-- MySQL 测试数据清理');
  L.push(`-- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('-- ⚠️ 执行前请确认：这是测试库，不是生产库！');
  L.push('');
  L.push(`USE \`${db}\`;`);
  L.push('');
  L.push('-- 关闭外键检查（清理有外键关联的表时需要）');
  L.push('SET FOREIGN_KEY_CHECKS = 0;');
  L.push('');

  for (const it of items) {
    if (it.mode === 'truncate') {
      L.push(`-- 清空：${it.name}（TRUNCATE，不可回滚）`);
      L.push(`TRUNCATE TABLE \`${it.name}\`;`);
    } else if (it.mode === 'drop') {
      L.push(`-- 删除表：${it.name}（DROP，表结构也没了）`);
      L.push(`DROP TABLE IF EXISTS \`${it.name}\`;`);
    } else {
      if (it.where) {
        L.push(`-- 清理：${it.name} WHERE ${it.where}`);
        L.push(`DELETE FROM \`${it.name}\` WHERE ${it.where};`);
      } else {
        L.push(`-- 清空：${it.name}（无条件 DELETE，全表清空）`);
        L.push(`DELETE FROM \`${it.name}\`;`);
      }
    }
    L.push('');
  }

  L.push('-- 恢复外键检查');
  L.push('SET FOREIGN_KEY_CHECKS = 1;');
  L.push('');
  L.push('-- 建议：清理完统计一下，确认结果符合预期');
  for (const it of items) {
    L.push(`-- SELECT COUNT(*) AS \`${it.name}\` FROM \`${it.name}\`;`);
  }

  return {
    ok: true,
    sql: L.join('\n'),
    warning: '生成的 SQL 需要你自己复制到 MySQL 客户端执行，平台不连数据库。'
  };
}

/**
 * 生成还原 SQL。
 *
 * @param {object} opts
 *   - database   库名
 *   - pairs      [{table: '原表', backup: '备份表', mode: 'insert'|'replace'|'truncate-insert'}]
 * @returns {{ok: boolean, sql?: string, message?: string}}
 */
function genRestore(opts = {}) {
  const db = safeIdent(opts.database);
  const rawPairs = Array.isArray(opts.pairs) ? opts.pairs : [];

  if (!db) return { ok: false, message: '库名不合法' };
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

  const L = [];
  L.push('-- MySQL 测试数据还原');
  L.push(`-- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('-- ⚠️ INSERT 模式会在原数据上追加（可能主键冲突）');
  L.push('--    REPLACE 模式会覆盖同主键的行');
  L.push('--    TRUNCATE-INSERT 模式会先清空原表再灌回去（最彻底）');
  L.push('');
  L.push(`USE \`${db}\`;`);
  L.push('');
  L.push('SET FOREIGN_KEY_CHECKS = 0;');
  L.push('');

  for (const p of pairs) {
    if (p.mode === 'truncate-insert') {
      L.push(`-- 还原：${p.backup} → ${p.table}（先清空再灌）`);
      L.push(`TRUNCATE TABLE \`${p.table}\`;`);
      L.push(`INSERT INTO \`${p.table}\` SELECT * FROM \`${p.backup}\`;`);
    } else if (p.mode === 'replace') {
      L.push(`-- 还原：${p.backup} → ${p.table}（REPLACE，同主键覆盖）`);
      L.push(`REPLACE INTO \`${p.table}\` SELECT * FROM \`${p.backup}\`;`);
    } else {
      L.push(`-- 还原：${p.backup} → ${p.table}（INSERT，追加）`);
      L.push(`INSERT INTO \`${p.table}\` SELECT * FROM \`${p.backup}\`;`);
    }
    L.push('');
  }

  L.push('SET FOREIGN_KEY_CHECKS = 1;');
  return { ok: true, sql: L.join('\n') };
}

/**
 * 列出备份表（从表名列表里筛 `bak_` 开头的）。
 * @param {string[]} tables
 */
function listBackupTables(tables) {
  return (Array.isArray(tables) ? tables : [])
    .filter((t) => /^bak_[A-Za-z_][A-Za-z0-9_$]*_\d{8}_\d{6}$/.test(String(t)))
    .map((t) => {
      // bak_原表名_20260101_120000 → 原表名 / 时间
      const m = /^bak_(.+)_(\d{8})_(\d{6})$/.exec(t);
      return {
        backup: t,
        table: m ? m[1] : '',
        stamp: m ? `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)} ${m[3].slice(0, 2)}:${m[3].slice(2, 4)}:${m[3].slice(4, 6)}` : ''
      };
    });
}

module.exports = { genSnapshot, genCleanup, genRestore, listBackupTables, safeIdent, stamp };