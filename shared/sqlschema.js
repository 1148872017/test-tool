'use strict';
/**
 * 解析 SQL 的 CREATE TABLE 语句，提取字段信息。
 *
 * 用途：规划要求「数据模型实体生成（JSON/**DB** → POJO/DataClass）」。
 * 不直连数据库（那是「不碰用户环境」的原则），改成让用户**粘贴建表语句**。
 *
 * 支持：
 *   - MySQL：`id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '主键'
 *   - SQLite：id INTEGER PRIMARY KEY AUTOINCREMENT
 *   - 通用：跳过 PRIMARY KEY / UNIQUE / INDEX / KEY / CONSTRAINT / FOREIGN 行
 */

/** SQL 类型 → Java 类型 */
const JAVA_TYPES = [
  { re: /^(tinyint|smallint|mediumint|int|integer|serial)\b/i, java: 'Integer' },
  { re: /^(bigint)\b/i, java: 'Long' },
  { re: /^(decimal|numeric)\b/i, java: 'java.math.BigDecimal' },
  { re: /^(float)\b/i, java: 'Float' },
  { re: /^(double|real)\b/i, java: 'Double' },
  { re: /^(bit|bool|boolean)\b/i, java: 'Boolean' },
  { re: /^(date)\b/i, java: 'java.time.LocalDate' },
  { re: /^(datetime|timestamp)\b/i, java: 'java.time.LocalDateTime' },
  { re: /^(time)\b/i, java: 'java.time.LocalTime' },
  { re: /^(json|jsonb)\b/i, java: 'Object' },
  { re: /^(blob|binary|varbinary|longblob|mediumblob)\b/i, java: 'byte[]' },
  { re: /^(text|tinytext|mediumtext|longtext|clob)\b/i, java: 'String' }
];

/** SQL 类型 → Python 类型 */
const PY_TYPES = [
  { re: /^(tinyint|smallint|mediumint|int|integer|serial)\b/i, py: 'Optional[int]' },
  { re: /^(bigint)\b/i, py: 'Optional[int]' },
  { re: /^(decimal|numeric|float|double|real)\b/i, py: 'Optional[float]' },
  { re: /^(bit|bool|boolean)\b/i, py: 'Optional[bool]' },
  { re: /^(date|datetime|timestamp|time)\b/i, py: 'Optional[str]' },
  { re: /^(json|jsonb)\b/i, py: 'Optional[Any]' },
  { re: /^(blob|binary|varbinary|longblob|mediumblob)\b/i, py: 'Optional[bytes]' },
  { re: /^(text|tinytext|mediumtext|longtext|clob)\b/i, py: 'Optional[str]' }
];

/** 这些行不是字段定义 */
const SKIP_RE = /^\s*(primary\s+key|unique|key|index|constraint|foreign\s+key|check|fulltext|spatial)\b/i;

/** 下划线转驼峰 */
function toCamel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** MySQL 反引号 / 双引号 / 方括号 去掉 */
function cleanIdent(s) {
  return String(s || '')
    .replace(/^[`"[]/, '')
    .replace(/[`"\]]$/, '')
    .trim();
}

/**
 * 按顶层逗号切分（括号里的逗号不算）。
 * 比如 `decimal(10,2)` 里的逗号不能切。
 */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  let quote = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inStr) {
      cur += ch;
      if (ch === quote && body[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = true;
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 提取 CREATE TABLE 的括号体 */
function extractBody(sql) {
  const text = String(sql || '');
  const m = /create\s+table[^(]*\(/i.exec(text);
  if (!m) return '';
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  let inStr = false;
  let quote = '';

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === quote && text[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return text.slice(start);
}

/** 取表名 */
function extractTableName(sql) {
  const m = /create\s+table\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.]+)/i.exec(String(sql || ''));
  if (!m) return '';
  const raw = m[1].split('.').pop();
  return cleanIdent(raw);
}

/**
 * 解析一条字段定义。
 * @returns {{name: string, sqlType: string, javaType: string, pyType: string, comment: string, nullable: boolean} | null}
 */
function parseColumn(line) {
  if (!line || SKIP_RE.test(line)) return null;

  // 字段名（可能是 `id` / "id" / [id] / id）
  const m = /^\s*([`"[]?[A-Za-z_][\w$]*[`"\]]?)\s+([A-Za-z]+(?:\s*\([^)]*\))?(?:\s+unsigned)?)/.exec(line);
  if (!m) return null;

  const name = cleanIdent(m[1]);
  if (!name) return null;
  const sqlType = m[2].trim();

  // Java 类型
  let javaType = 'String';
  for (const t of JAVA_TYPES) {
    if (t.re.test(sqlType)) {
      javaType = t.java;
      break;
    }
  }

  // Python 类型
  let pyType = 'Optional[str]';
  for (const t of PY_TYPES) {
    if (t.re.test(sqlType)) {
      pyType = t.py;
      break;
    }
  }

  // 注释：COMMENT 'xxx'
  let comment = '';
  const cm = /comment\s+'([^']*)'/i.exec(line);
  if (cm) comment = cm[1];

  // 可空性
  const nullable = !/not\s+null/i.test(line) && !/primary\s+key/i.test(line);

  return { name, sqlType, javaType, pyType, comment, nullable, camel: toCamel(name) };
}

/**
 * 主入口：解析 CREATE TABLE。
 *
 * @param {string} sql
 * @returns {{ok: boolean, table?: string, columns?: any[], message?: string}}
 */
function parseCreateTable(sql) {
  const text = String(sql || '').trim();
  if (!text) return { ok: false, message: '没填建表语句' };
  if (!/create\s+table/i.test(text)) {
    return { ok: false, message: '没找到 CREATE TABLE（把建表语句整段粘进来）' };
  }

  const body = extractBody(text);
  if (!body) return { ok: false, message: '括号里没内容' };

  const parts = splitTopLevel(body);
  const columns = [];
  for (const p of parts) {
    const col = parseColumn(p);
    if (col) columns.push(col);
  }

  if (!columns.length) {
    return { ok: false, message: '没解析出字段（检查是不是 CREATE TABLE 语法）' };
  }

  return { ok: true, table: extractTableName(text), columns };
}

module.exports = { parseCreateTable, parseColumn, extractTableName, toCamel, cleanIdent };