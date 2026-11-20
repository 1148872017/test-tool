'use strict';
/**
 * JSON / Headers 文本 → 表格数据
 *
 * 用途：接口记录详情页，headers 和 body 字段提供「JSON / 表格」切换。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **只显示第一层**
 *    嵌套对象显示成 `{...}`，数组显示成 `[...]`，hover 看完整值。
 *    展开所有层级会让表格变成一棵树，反而难读。
 *
 * 2. **数组每项一行**
 *    `[1,2,3]` → 参数名 `[0]` `[1]` `[2]`
 *
 * 3. **headers 是特殊格式**
 *    不是 JSON，是 `Key: Value` 每行一个，单独解析。
 *
 * 4. **超过 200 行不提供表格**
 *    大 body 渲染成表格会卡，直接让用户看 JSON。
 */

/** 表格最多渲染多少行（超过就不提供表格视图） */
const MAX_ROWS = 200;

/** 值太长时截断显示（完整值放 title） */
const MAX_VALUE_LEN = 120;

/** 判断一个值是不是「复杂类型」（对象/数组） */
function isComplex(v) {
  return v !== null && typeof v === 'object';
}

/** 把值转成表格里显示的短文本 */
function shortValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (Array.isArray(v)) return `[${v.length} 项]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{${keys.length} 个字段}` : '{}';
  }
  if (typeof v === 'string') {
    if (v === '') return '（空字符串）';
    return v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) + '…' : v;
  }
  return String(v);
}

/** 完整值（放 title，hover 显示） */
function fullValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    return String(v);
  }
}

/**
 * JSON → 表格行
 * @param {any} obj 解析后的 JSON
 * @returns {{key: string, value: string, title: string, complex: boolean}[]}
 */
function jsonToRows(obj) {
  const rows = [];
  if (obj === null || obj === undefined) return rows;

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      rows.push({
        key: `[${i}]`,
        value: shortValue(v),
        title: fullValue(v),
        complex: isComplex(v)
      });
    });
    return rows;
  }

  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      rows.push({
        key: k,
        value: shortValue(v),
        title: fullValue(v),
        complex: isComplex(v)
      });
    }
    return rows;
  }

  // 标量
  rows.push({ key: '（值）', value: shortValue(obj), title: fullValue(obj), complex: false });
  return rows;
}

/**
 * Headers 文本 → 表格行
 * 输入形如：
 *   Content-Type: application/json
 *   Authorization: Bearer xxx
 * @param {string} text
 */
function headersToRows(text) {
  const rows = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i > 0) {
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      // headers 的空值就显示空（不用 shortValue 的「（空字符串）」提示）
      rows.push({ key: k, value: v, title: v, complex: false });
    } else {
      // 没有冒号，整行当 key
      rows.push({ key: t, value: '', title: '', complex: false });
    }
  }
  return rows;
}

/**
 * 尝试把文本解析成 JSON。
 * @returns {{ok: boolean, value?: any, message?: string}}
 */
function tryParseJson(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, message: '空内容' };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, message: (e && e.message) || '不是合法 JSON' };
  }
}

/**
 * 统一入口：把字段内容转成表格数据。
 *
 * @param {string} fieldKey 字段名（headers / body / 其他）
 * @param {string} raw 字段原文
 * @returns {{
 *   canTable: boolean,
 *   rows: {key,value,title,complex}[],
 *   total: number,
 *   message?: string
 * }}
 */
function toTable(fieldKey, raw) {
  const text = String(raw || '');
  if (!text.trim()) {
    return { canTable: false, rows: [], total: 0, message: '空内容' };
  }

  // headers：按行 + 冒号解析
  if (fieldKey === 'headers') {
    const rows = headersToRows(text);
    if (!rows.length) return { canTable: false, rows: [], total: 0, message: '没有可解析的请求头' };
    return { canTable: true, rows, total: rows.length };
  }

  // body 及其他：先试 JSON
  const parsed = tryParseJson(text);
  if (!parsed.ok) {
    return { canTable: false, rows: [], total: 0, message: parsed.message };
  }
  const rows = jsonToRows(parsed.value);
  if (!rows.length) {
    return { canTable: false, rows: [], total: 0, message: '没有可展示的字段' };
  }
  if (rows.length > MAX_ROWS) {
    return {
      canTable: false,
      rows: [],
      total: rows.length,
      message: `字段太多（${rows.length} 行），请用 JSON 视图查看`
    };
  }
  return { canTable: true, rows, total: rows.length };
}

module.exports = {
  toTable,
  jsonToRows,
  headersToRows,
  tryParseJson,
  shortValue,
  fullValue,
  MAX_ROWS
};
