'use strict';
/**
 * 导入模板 —— 一个集合的字段定义 → 一条「字段齐全」的示例记录 JSON。
 *
 * 为什么要有：
 *   「导入备份」只认我们自己导出的 JSON，用户手里没有样本时根本不知道
 *   该写 records[].data 还是直接摊平，字段名是什么、账号是不是 JSON 字符串。
 *   与其写文档，不如给一条**能直接导入**的示例：照着改值就行。
 *
 * 纯函数：不读文件、不碰 electron，前端预览与单测都能直接用。
 */

const { COLLECTIONS, COLLECTION_MAP, OPTION_SETS } = require('./collections');

/**
 * 模板里所有时间都用同一个固定值。
 *
 * 为什么不用 new Date()：模板是「格式说明」，每次点都该长得一模一样
 * （方便对比、方便进测试断言）；用当前时间还会让用户误以为是真实数据。
 */
const TEMPLATE_TIME = '2026-01-01T00:00:00.000Z';
const TEMPLATE_MS = Date.parse(TEMPLATE_TIME);

/** 示例记录的固定 id：同一个模板反复导入只更新那一条，不会翻倍 */
const TEMPLATE_ID = 'template-example-0001';

/**
 * 纯展示用的虚拟字段（不落库）。
 *   metrics：压测指标是运行时由 concurrency/tps/... 现算出来的横向表格，
 *            存进 data 反而会被详情页忽略，所以模板里不出现。
 */
const VIRTUAL_FIELD_TYPES = ['metrics'];

/** 一条示例记录可用的标签（导入后能直接看到） */
const TEMPLATE_TAGS = ['示例'];

/**
 * 按键名给的示例值 —— 比按类型兜底「说得通」，用户一眼能懂该填什么。
 * 值都会被深拷贝，调用方随便改不影响这里。
 */
const SAMPLE_BY_KEY = {
  /* ---- 通用 ---- */
  name: '示例记录（可改成你自己的）',
  note: '示例备注：入口路径、坑点、注意事项',
  myNote: '示例：能不能测、坑在哪、要哪个账号',
  conclusion: '示例结论：达标 / 不达标，瓶颈在哪，要不要跟进',

  /* ---- 网站管理 ---- */
  url: 'https://test.example.com/admin',
  env: ['test'],
  // 账号列表按真实存储格式给：JSON **字符串**（不是数组）
  accounts: JSON.stringify([
    {
      label: '管理员',
      account: 'example_admin',
      password: '示例密码-请改成真实密码',
      role: ['admin'],
      isDefault: true,
      note: '示例账号，可删',
      tags: []
    },
    {
      label: '普通用户',
      account: 'example_user',
      password: '',
      role: [],
      isDefault: false,
      note: '',
      tags: ['只读']
    }
  ]),

  /* ---- SQL 片段 ---- */
  db: 'test_order',
  sql: "SELECT * FROM t_order WHERE order_no = '{{orderNo}}' LIMIT 10;",
  vars: JSON.stringify([{ name: 'orderNo', value: 'SO20260101001', desc: '订单号' }]),

  /* ---- 接口记录 ---- */
  method: 'POST',
  module: '示例模块',
  summary: '示例接口描述：这个接口干什么用',
  params: 'orderNo：订单号（必填）',
  paramSpec: '{}',
  paramTable: JSON.stringify([
    { name: 'orderNo', in: 'query', type: 'string', required: true, example: 'SO20260101001', desc: '订单号' }
  ]),
  reqSchema: '{\n  "type": "object",\n  "properties": {}\n}',
  respSchema: '{\n  "type": "object",\n  "properties": {}\n}',
  respExample: '{\n  "code": 0,\n  "msg": "success",\n  "data": {}\n}',
  completeness: 'ok',
  source: 'manual',
  bodyType: 'json',
  headers: 'Content-Type: application/json',
  body: '{\n  "orderNo": "SO20260101001"\n}',
  lastChange: '',

  /* ---- 测试执行 ---- */
  kind: 'api',
  result: 'ok',
  scene: '示例测试场景',
  report: 'https://example.com/report/example',
  apiRef: '',
  passCount: 10,
  failCount: 0,
  concurrency: 10,
  duration: '30s',
  tps: 128.5,
  p90: 90,
  p95: 120,
  p99: 260,
  errRate: 0,
  samples: 3000,
  reportDir: '',

  /* ---- 页面元素 ---- */
  project: '示例项目',
  // 页面元素同样是 JSON **字符串**
  elements: JSON.stringify([
    { name: 'usernameInput', selector: '#username', desc: '用户名输入框' },
    { name: 'submitBtn', selector: '[data-testid=submit]', desc: '提交按钮' }
  ])
};

/**
 * 按字段类型兜底（键名没覆盖到的字段走这里）。
 * 值类型要和真实表单存下来的一致：多选=数组、日期时间=毫秒数、结构化字段=JSON 字符串。
 */
const SAMPLE_BY_TYPE = {
  text: '示例值',
  url: 'https://test.example.com/api/example',
  textarea: '示例备注（可删）',
  code: '{}',
  number: 1,
  select: '',
  multiselect: [],
  datetime: TEMPLATE_MS,
  date: '2026-01-01',
  link: '',
  accounts: '[]',
  vars: '[]',
  elements: '[]',
  metrics: '',
  change: ''
};

/** 深拷贝（示例值里有数组/对象，直接返回会被调用方改坏） */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/** 集合配置：既接受 key，也接受 conf 对象 */
function resolveConf(conf) {
  if (typeof conf === 'string') return COLLECTION_MAP[conf] || null;
  if (conf && typeof conf === 'object' && conf.key && Array.isArray(conf.fields)) return conf;
  return null;
}

/** 选项型字段的第一个可选值（让 select/multiselect 的示例是「合法值」而不是瞎编） */
function firstOptionValue(field) {
  const f = field || {};
  if (f.optionsKey) {
    const set = OPTION_SETS[f.optionsKey];
    const list = (set && set.defaults) || [];
    return list.length ? list[0].value : '';
  }
  if (Array.isArray(f.options) && f.options.length) return f.options[0].value;
  return '';
}

/**
 * 单个字段的示例值。
 * @param {object} field COLLECTIONS 里的字段定义
 * @returns {*} 可直接 JSON 序列化的值
 */
function sampleValue(field) {
  const f = field || {};
  const type = f.type || 'text';

  // 键名有专用示例 → 优先（比字段默认值更适合当「说明」，
  // 比如 runs.result 默认是「未判定」，模板里给「正常」更好懂）
  if (Object.prototype.hasOwnProperty.call(SAMPLE_BY_KEY, f.key)) {
    return clone(SAMPLE_BY_KEY[f.key]);
  }
  // 没有专用示例时用字段默认值（和「新增记录」时表单初值一致）
  if (f.default !== undefined && f.default !== null && f.default !== '') {
    return clone(f.default);
  }
  // 选项型：取第一个合法值，避免模板里出现导入后下拉框不认识的值
  if (type === 'select') return firstOptionValue(f);
  if (type === 'multiselect') {
    const v = firstOptionValue(f);
    return v ? [v] : [];
  }
  if (Object.prototype.hasOwnProperty.call(SAMPLE_BY_TYPE, type)) {
    return clone(SAMPLE_BY_TYPE[type]);
  }
  return '';
}

/**
 * 生成一条示例记录（对象形态，方便前端做预览）。
 * @param {object|string} conf 集合定义或集合 key
 * @returns {object} 真实导出格式里的单条记录
 */
function buildTemplateRecord(conf) {
  const c = resolveConf(conf);
  if (!c) throw new Error('不认识的集合：' + String(conf));

  const data = {};
  for (const f of c.fields) {
    if (VIRTUAL_FIELD_TYPES.indexOf(f.type) >= 0) continue;
    data[f.key] = sampleValue(f);
  }

  const title = String(data[c.titleField] === undefined ? '' : data[c.titleField]).trim() || '示例记录（可改成你自己的）';

  return {
    id: TEMPLATE_ID,
    collection: c.key,
    title,
    data,
    tags: TEMPLATE_TAGS.slice(),
    favorite: false,
    created_at: TEMPLATE_MS,
    updated_at: TEMPLATE_MS
  };
}

/**
 * 生成完整的导入模板 JSON 文本。
 *
 * 外层结构必须和「导出」一模一样（version / exportedAt / includeSecrets / records），
 * 否则用户拿着模板点「导入备份」会被判成格式不对——模板的意义就是这个。
 *
 * @param {object|string} conf 集合定义或集合 key
 * @param {{at?:string}} [opts] at：覆盖 exportedAt（默认固定值，保证可复现）
 * @returns {string} 格式化好的 JSON 文本（2 空格缩进，可直接看）
 */
function buildTemplate(conf, opts) {
  const c = resolveConf(conf);
  if (!c) throw new Error('不认识的集合：' + String(conf));
  const payload = {
    version: 2,
    exportedAt: (opts && opts.at) || TEMPLATE_TIME,
    includeSecrets: false,
    records: [buildTemplateRecord(c)]
  };
  return JSON.stringify(payload, null, 2);
}

/** 保存框里的默认文件名：带集合名，不会和真实备份混淆 */
function templateFileName(conf) {
  const c = resolveConf(conf);
  const name = c ? c.name : '数据';
  return '测试工作台-导入模板-' + name + '.json';
}

module.exports = {
  TEMPLATE_TIME,
  TEMPLATE_MS,
  TEMPLATE_ID,
  TEMPLATE_TAGS,
  VIRTUAL_FIELD_TYPES,
  SAMPLE_BY_KEY,
  SAMPLE_BY_TYPE,
  resolveConf,
  sampleValue,
  buildTemplateRecord,
  buildTemplate,
  templateFileName,
  COLLECTIONS
};