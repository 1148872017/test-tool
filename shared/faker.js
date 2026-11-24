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
/** 车牌省份简称（只取常见的 10 个，够覆盖测试用例） */
const PLATE_PROVINCES = ['京', '沪', '粤', '浙', '苏', '川', '鄂', '湘', '鲁', '豫'];
/** 车牌发牌机关字母：去掉 I / O，避免和 1 / 0 看混 */
const PLATE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

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
 * v0.42.0 新增：边界值 / 车牌号 / MAC 地址
 * ============================================================ */

/**
 * 边界值池（**有序**，不随机）。
 *
 * 为什么固定而不是随机：边界值是用来「一条一条怼接口」的，
 * 必须可预期——第 n 条永远是池子里第 n 个，跑出来的用例顺序稳定。
 *
 * 覆盖：空串 / 空白 / 0 / 负数 / 9 位 / int32 上下边界 / 浮点边界 /
 *       超长串 / 中英混排 / emoji / 全角 / 字面量 null、undefined / 单条 SQL 边界。
 */
const BOUNDARY_VALUES = [
  '', // 空串
  ' ', // 单个空格
  '0',
  '-1',
  '999999999',
  '2147483647', // int32 最大值
  '2147483648', // int32 最大值 +1，溢出边界
  '1e308', // 浮点边界（接近 Number.MAX_VALUE）
  'a'.repeat(1000), // 超长字符串
  '测试Test123', // 中英混排
  '😀😀😀', // emoji（4 字节字符）
  'ＡＢＣ１２３', // 全角字符
  'null', // 字面量字符串
  'undefined', // 字面量字符串
  "' OR '1'='1" // 单条经典 SQL 边界（不放整段注入载荷）
];

/**
 * 取边界值（按索引循环）。
 *
 * @param {number} index 第几条（从 0 开始），缺省 0
 */
function genBoundary(index = 0) {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return BOUNDARY_VALUES[i % BOUNDARY_VALUES.length];
}

/**
 * 车牌号（国内格式）。
 *
 * 普通：省份简称 + 字母 + 5 位数字（京A12345）
 * 新能源：省份简称 + 字母 + D/F + 5 位数字（沪AD12345）
 */
function genPlate() {
  const head = pick(PLATE_PROVINCES) + pick(PLATE_LETTERS);
  // 新能源和普通各占一半，保证两种格式都能造出来
  return Math.random() < 0.5 ? head + pick(['D', 'F']) + digits(5) : head + digits(5);
}

/** MAC 地址：6 组大写十六进制，冒号分隔（AA:BB:CC:DD:EE:FF） */
function genMac() {
  const groups = [];
  for (let i = 0; i < 6; i++) {
    groups.push(
      Math.floor(Math.random() * 256)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')
    );
  }
  return groups.join(':');
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
  { value: 'order', label: '订单号', fn: genOrderNo },
  { value: 'boundary', label: '边界值', fn: genBoundary },
  { value: 'plate', label: '车牌号', fn: genPlate },
  { value: 'mac', label: 'MAC 地址', fn: genMac }
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
 * @param {number} index  第几条（从 0 开始）。
 *                        只有「边界值」这种有序类型会用到；其他类型忽略，
 *                        所以老代码 t.fn() 不传也不会坏。
 */
function genOne(type, opts = {}, index = 0) {
  const t = TYPE_MAP[type] || TYPES[0];
  if (t.value === 'date') return genDate(opts.from, opts.to);
  return t.fn(index);
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
        // 传行号：边界值这种有序类型要按行推进，不能每行都从第 0 个开始
        return r.fn(i);
      })
    );
  }
  return out;
}

/**
 * 生成单类型多行（转成 CSV 用的二维数组）。
 *
 * 注意：必须把行号透传给 genOne，否则 boundary 每行都会取到第 0 个值。
 *
 * @param {string} type
 * @param {number} count
 * @param {object} opts
 * @returns {string[][]} [[v1],[v2],...]
 */
function genColumn(type, count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i++) out.push([genOne(type, opts, i)]);
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
  BOUNDARY_VALUES,
  PLATE_PROVINCES,
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
  genOrderNo,
  genBoundary,
  genPlate,
  genMac
};