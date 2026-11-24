'use strict';
/**
 * 测试数据生成器（前后端共用）。
 *
 * ============================================================
 * 为什么抽到 shared
 * ============================================================
 * 需求（v0.41.0）：生成数量巨大时不要全量展示，直接导出成文件。
 * "生成"变成两处逻辑：
 *   前端 DataTool（小数量，内存里展示）
 *   Node 侧（大数量，直接流式写文件）
 * 两边必须生成**同一套数据**，所以抽成纯函数放 shared。
 *
 * 所有函数都不依赖 DOM / fs / Electron，纯计算。
 */

/* ============================================================
 * 随机工具
 * ============================================================ */

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'.split('');
const GIVEN = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '霞', '平', '刚', '桂英', '建国', '文', '辉', '雪', '鹏'];
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州'];
const ROADS = ['中山路', '人民路', '解放路', '建设路', '长江路', '黄河路', '科技大道', '高新路'];
const COMPANY_PRE = ['华', '中', '恒', '远', '天', '创', '诚', '汇', '鑫', '博'];
const COMPANY_MID = ['联', '信', '达', '泰', '通', '科', '网', '盛'];
const COMPANY_SUF = ['科技有限公司', '网络技术有限公司', '信息技术有限公司', '电子商务有限公司'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

/* ============================================================
 * 各种类型
 * ============================================================ */

function genName() {
  return pick(SURNAMES) + pick(GIVEN);
}

function genPhone() {
  return '1' + pick('3456789'.split('')) + digits(9);
}

function genEmail() {
  const pool = ['test', 'qa', 'dev', 'auto', 'demo', 'case'];
  return `${pick(pool)}${digits(4)}@${pick(['example.com', 'test.com', 'mail.com', 'corp.cn'])}`;
}

function genIdCard() {
  const area = pick(['110101', '310101', '440305', '330106', '510107', '420106']);
  const year = 1970 + Math.floor(Math.random() * 35);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  const body = area + year + month + day + digits(3);
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = body.split('').reduce((acc, ch, i) => acc + Number(ch) * weights[i], 0);
  const check = '10X98765432'[sum % 11];
  return body + check;
}

function luhnCheckDigit(partial) {
  let sum = 0;
  let double = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = Number(partial[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

function genBankCard() {
  const prefix = pick(['622202', '622848', '621700', '622588', '621226']);
  const body = prefix + digits(12);
  return body + luhnCheckDigit(body);
}

function genAddress() {
  return pick(CITIES) + '市' + pick(ROADS) + (1 + Math.floor(Math.random() * 200)) + '号';
}

function genCompany() {
  return pick(COMPANY_PRE) + pick(COMPANY_MID) + pick(COMPANY_SUF);
}

function genUuid() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else s += hex[Math.floor(Math.random() * 16)];
  }
  return s;
}

/**
 * 日期生成（支持指定范围）。
 *
 * @param {string} from 起始日期 YYYY-MM-DD（含）
 * @param {string} to   结束日期 YYYY-MM-DD（含）
 */
function genDate(from, to) {
  const startMs = from ? new Date(from + 'T00:00:00').getTime() : new Date(2020, 0, 1).getTime();
  const endMs = to ? new Date(to + 'T23:59:59').getTime() : Date.now();
  // 范围非法（或者反了）时退回默认，避免生成 Invalid Date
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    const s0 = new Date(2020, 0, 1).getTime();
    const e0 = Date.now();
    return new Date(s0 + Math.random() * (e0 - s0)).toISOString().slice(0, 10);
  }
  return new Date(startMs + Math.random() * (endMs - startMs)).toISOString().slice(0, 10);
}

function genAmount() {
  return (Math.random() * 9999 + 0.01).toFixed(2);
}

function genOrderNo() {
  return 'SO' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + digits(6);
}

/* ============================================================
 * 类型清单（前后端共用）
 * ============================================================ */

const TYPES = [
  { value: 'name', label: '中文姓名', fn: genName },
  { value: 'phone', label: '手机号', fn: genPhone },
  { value: 'email', label: '邮箱', fn: genEmail },
  { value: 'idcard', label: '身份证号', fn: genIdCard },
  { value: 'bank', label: '银行卡号', fn: genBankCard },
  { value: 'address', label: '地址', fn: genAddress },
  { value: 'company', label: '公司名', fn: genCompany },
  { value: 'uuid', label: 'UUID', fn: genUuid },
  { value: 'date', label: '日期', fn: genDate },
  { value: 'amount', label: '金额', fn: genAmount },
  { value: 'order', label: '订单号', fn: genOrderNo }
];

const TYPE_MAP = TYPES.reduce((acc, t) => {
  acc[t.value] = t;
  return acc;
}, {});

/**
 * 生成一条数据。
 *
 * @param {string} type   类型 key
 * @param {object} opts   { from, to }（date 类型用）
 */
function genOne(type, opts = {}) {
  const t = TYPE_MAP[type] || TYPES[0];
  if (t.value === 'date') return genDate(opts.from, opts.to);
  return t.fn();
}

/**
 * 生成多行多列（多字段组合）。
 *
 * @param {Array<{name, type, fixed}>} fields 字段定义
 * @param {number} count 行数
 * @param {object} opts { from, to }
 * @returns {string[][]} 每行一个数组
 */
function genRows(fields, count, opts = {}) {
  const valid = (fields || []).filter((f) => f && String(f.name || '').trim());
  if (!valid.length) return [];

  const resolved = valid.map((f) => {
    const t = TYPE_MAP[f.type] || TYPES[0];
    return {
      fixed: f.fixed,
      isDate: t.value === 'date',
      fn: t.fn
    };
  });

  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      resolved.map((r) => {
        if (r.fixed) return r.fixed;
        if (r.isDate) return genDate(opts.from, opts.to);
        return r.fn();
      })
    );
  }
  return out;
}

/**
 * 生成单类型多行（转成 CSV 用的二维数组）。
 *
 * @param {string} type
 * @param {number} count
 * @param {object} opts
 * @returns {string[][]} [[v1],[v2],...]
 */
function genColumn(type, count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i++) out.push([genOne(type, opts)]);
  return out;
}

/* ============================================================
 * CSV / JSON 序列化
 * ============================================================ */

/** CSV 转义：有逗号/引号/换行就包起来 */
function csvCell(v) {
  const t = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/**
 * 二维数组 → CSV 文本（带 BOM，Excel 打开中文不乱码）。
 *
 * @param {string[]} headers 表头
 * @param {string[][]} rows
 */
function toCsv(headers, rows) {
  const lines = [];
  if (headers && headers.length) lines.push(headers.map(csvCell).join(','));
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n');
}

/** 二维数组 → JSON 文本（对象数组，key 用表头） */
function toJson(headers, rows) {
  const objs = rows.map((r) => {
    const o = {};
    (headers || []).forEach((h, i) => {
      o[h] = r[i] === undefined ? '' : r[i];
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

module.exports = {
  TYPES,
  TYPE_MAP,
  genOne,
  genRows,
  genColumn,
  toCsv,
  toJson,
  csvCell,
  genName,
  genPhone,
  genEmail,
  genIdCard,
  genBankCard,
  genAddress,
  genCompany,
  genUuid,
  genDate,
  genAmount,
  genOrderNo
};