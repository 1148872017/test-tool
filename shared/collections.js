'use strict';

/**
 * 集合定义 —— 主进程与渲染进程共用（唯一事实源）。
 * 新增一个集合 = 在这里加一段 JSON，UI 全自动适配。
 */

const ENV_OPTIONS = [
  { value: 'test', label: '测试', color: 'green' },
  { value: 'staging', label: '预发', color: 'gold' },
  { value: 'prod', label: '生产', color: 'red' },
  { value: 'other', label: '其他', color: 'default' }
];

/** 角色 / 权限：默认留空，靠历史数据和用户自己攒（迁移会把老数据里的文本收进来） */
const ROLE_OPTIONS = [];

/** 标签：默认留空，新增记录时手输的标签会自动加入这里 */
const TAG_OPTIONS = [];

/**
 * 可配置选项集（设置页能增删改）。
 * value 就是存进记录里的值：环境的 value 一旦被记录引用就别改（改的是 label）。
 */
const OPTION_SETS = {
  env: { key: 'env', name: '环境', kind: 'env', defaults: ENV_OPTIONS },
  role: { key: 'role', name: '角色 / 权限', kind: 'text', defaults: ROLE_OPTIONS },
  tags: { key: 'tags', name: '标签', kind: 'text', defaults: TAG_OPTIONS }
};

const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((v) => ({
  value: v,
  label: v,
  color: v === 'GET' ? 'green' : v === 'DELETE' ? 'red' : v === 'POST' ? 'blue' : 'purple'
}));

/** 接口完整度：只做灰字提示，不用红色警告（没描述是常态，不是事故） */
const COMPLETENESS_OPTIONS = [
  { value: 'ok', label: '信息齐', color: 'green' },
  { value: 'missing-desc', label: '缺描述', color: 'default' },
  { value: 'missing-example', label: '缺示例', color: 'default' }
];

const SOURCE_OPTIONS = [
  { value: 'manual', label: '手录', color: 'default' },
  { value: 'openapi', label: 'Apifox', color: 'blue' }
];

/**
 * Body 的媒体类型（和 Apifox 的 Body 页签一致）。
 * 只用于展示「这个接口的 body 是什么格式」，不参与解析。
 */
const BODY_TYPE_OPTIONS = [
  { value: 'none', label: 'none', color: 'default' },
  { value: 'form-data', label: 'form-data', color: 'purple' },
  { value: 'x-www-form-urlencoded', label: 'x-www-form-urlencoded', color: 'blue' },
  { value: 'json', label: 'JSON', color: 'cyan' },
  { value: 'xml', label: 'XML', color: 'orange' },
  { value: 'text', label: 'Text', color: 'default' },
  { value: 'binary', label: 'Binary', color: 'default' },
  { value: 'graphql', label: 'GraphQL', color: 'magenta' },
  { value: 'msgpack', label: 'msgpack', color: 'default' }
];

/** 测试执行：一次跑批 = 一条记录（接口测试 / 压测） */
const RUN_KIND_OPTIONS = [
  { value: 'api', label: '接口测试', color: 'blue' },
  { value: 'perf', label: '压测', color: 'purple' }
];

/** 结果用「正常 / 异常」而不是「通过 / 失败」：压测说「达标」更自然，两边都能用同一套词 */
const RUN_RESULT_OPTIONS = [
  { value: 'ok', label: '正常', color: 'green' },
  { value: 'bad', label: '异常', color: 'red' },
  { value: 'unknown', label: '未判定', color: 'default' }
];

const COLLECTIONS = [
  {
    key: 'sites',
    name: '网站管理',
    group: '密码库',
    icon: 'GlobalOutlined',
    desc: '测试环境地址与登录信息，点开即用',
    titleField: 'name',
    titlePlaceholder: '如：资产管理系统-管理后台',
    listFields: ['env', 'accounts'],
    filterField: 'env',
    noFavorite: true,
    openField: 'url',
    actions: ['open'],
    fields: [
      { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：资产管理系统-管理后台' },
      { key: 'url', label: '地址', type: 'url', placeholder: 'https://test.example.com/admin' },
      { key: 'env', label: '环境', type: 'multiselect', optionsKey: 'env', default: ['test'] },
      // 账号列表：一个站点可以有多个账号（管理员 / 普通用户 / 只读…）
      // 密码是嵌套字段，靠 secretPaths 声明加密
      {
        key: 'accounts',
        label: '账号列表',
        type: 'accounts',
        secretPaths: ['accounts[].password'],
        placeholder: '一个站点可以有多个账号'
      },
      { key: 'note', label: '备注', type: 'textarea', placeholder: '入口路径、注意事项…' }
    ]
  },
  {
    key: 'sqls',
    name: 'SQL 片段',
    group: '记录',
    icon: 'ConsoleSqlOutlined',
    desc: '常用查询与变更语句，变量替换后复制',
    titleField: 'name',
    titlePlaceholder: '如：按订单号查退款流水',
    listFields: ['db'],
    actions: ['sql'],
    fields: [
      { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：按订单号查退款流水' },
      { key: 'db', label: '库 / 环境', type: 'text', placeholder: '如：test_order' },
      { key: 'sql', label: 'SQL', type: 'code', required: true, rows: 10, placeholder: 'select * from t_refund where order_no = {{orderNo}}' },
      { key: 'vars', label: '变量说明', type: 'vars', placeholder: '在 SQL 里写 {{orderNo}}，这里填说明' },
      { key: 'note', label: '备注', type: 'textarea', placeholder: '索引、坑点…' }
    ]
  },
  {
    key: 'apis',
    name: '接口记录',
    group: '记录',
    icon: 'ApiOutlined',
    desc: '常用接口，一键复制成 cURL；可从 Apifox 导出文件同步',
    titleField: 'name',
    titlePlaceholder: '如：创建退款单',
    listFields: ['method', 'url'],
    actions: ['curl'],
    sync: 'openapi',
    fields: [
      { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：创建退款单' },
      { key: 'method', label: '方法', type: 'select', options: METHOD_OPTIONS, default: 'POST' },
      { key: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://test.example.com/api/refund' },
      // ---- 以下为同步镜像字段：详情里只读展示，编辑表单里不出现（formHidden） ----
      { key: 'module', label: '模块 / 目录', type: 'text', formHidden: true },
      { key: 'summary', label: '接口描述', type: 'textarea', formHidden: true },
      { key: 'params', label: '参数摘要', type: 'code', rows: 4, formHidden: true },
      // 参数的结构化快照：只给「变更 diff」用，界面上不出现
      { key: 'paramSpec', label: '参数快照', type: 'code', formHidden: true, hideInDetail: true },
      { key: 'paramTable', label: '参数', type: 'code', formHidden: true },
      { key: 'reqSchema', label: '请求 Schema', type: 'code', rows: 8, formHidden: true },
      { key: 'respSchema', label: '响应 Schema', type: 'code', rows: 8, formHidden: true },
      { key: 'respExample', label: '响应示例', type: 'code', rows: 8, formHidden: true },
      { key: 'completeness', label: '完整度', type: 'select', options: COMPLETENESS_OPTIONS, formHidden: true },
      { key: 'source', label: '来源', type: 'select', options: SOURCE_OPTIONS, default: 'manual', formHidden: true },
      { key: 'syncedAt', label: '同步于', type: 'datetime', formHidden: true },
      // 上次同步的变更（只有真变过才有这行，空了整行不显示）
      { key: 'lastChange', label: '上次同步变更', type: 'change', formHidden: true, hideEmpty: true },
      // ---- 以下是你自己的，同步永不覆盖 ----
      { key: 'myNote', label: '我的备注', type: 'textarea', placeholder: '能不能测、坑在哪、要哪个账号 —— 这些 Apifox 里没有' },
      { key: 'headers', label: 'Headers', type: 'code', rows: 5, placeholder: 'Content-Type: application/json\nAuthorization: Bearer {{token}}' },
      { key: 'body', label: 'Body', type: 'code', rows: 8, placeholder: '{"orderNo": "{{orderNo}}"}' },
      // body 的媒体类型（和 Apifox 的 Body 页签一致）
      { key: 'bodyType', label: 'Body 类型', type: 'select', options: BODY_TYPE_OPTIONS, formHidden: true },
      { key: 'note', label: '其他备注', type: 'textarea', placeholder: '前置条件、返回字段…' }
    ]
  },
  {
    key: 'runs',
    name: '测试执行',
    group: '记录',
    icon: 'ThunderboltOutlined',
    desc: '接口测试 / 压测跑一次记一笔：结果、指标、结论，报告留在 Apifox',
    titleField: 'name',
    titlePlaceholder: '如：下单链路 10 并发 1 分钟',
    listFields: ['apiRef', 'kind', 'result', 'ranAt'],
    filterField: 'kind',
    noFavorite: true,
    fields: [
      { key: 'name', label: '标题', type: 'text', required: true, placeholder: '如：下单链路 10 并发 1 分钟' },
      {
        key: 'kind',
        label: '类型',
        type: 'select',
        options: RUN_KIND_OPTIONS,
        default: 'api',
        // 选哪一类，下面的字段就跟哪一类走
        hint: '接口测试只填通过/失败数；压测填并发、时长和耗时'
      },
      { key: 'result', label: '结果', type: 'select', options: RUN_RESULT_OPTIONS, default: 'unknown' },
      { key: 'ranAt', label: '执行时间', type: 'datetime' },
      { key: 'apiRef', label: '关联接口', type: 'link', linkTo: 'apis', placeholder: '从「接口记录」里选，接口详情里就能看到这次执行' },
      { key: 'env', label: '环境', type: 'select', options: ENV_OPTIONS, optionsKey: 'env', default: 'test' },
      { key: 'scene', label: '场景 / 脚本', type: 'scene', placeholder: 'Apifox 测试场景名，或从下拉选已导入的 jmx' },
      { key: 'report', label: '报告链接', type: 'url', placeholder: 'Apifox 跑完的报告地址（选填）' },
      // ---- 接口测试 ----
      { key: 'passCount', label: '通过', type: 'number', onlyFor: { kind: 'api' }, hideInDetail: true, placeholder: '通过多少条' },
      { key: 'failCount', label: '失败', type: 'number', onlyFor: { kind: 'api' }, hideInDetail: true, placeholder: '挂了哪些，写结论里' },
      // ---- 压测 ----
      { key: 'concurrency', label: '并发', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '虚拟用户数' },
      { key: 'duration', label: '时长', type: 'text', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '如：60s / 5m' },
      { key: 'tps', label: 'TPS / 吞吐', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '每秒请求数' },
      { key: 'p90', label: 'P90 (ms)', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '90% 请求的响应时间' },
      { key: 'p95', label: 'P95 (ms)', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '95% 请求的响应时间' },
      { key: 'p99', label: 'P99 (ms)', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '99% 请求的响应时间' },
      { key: 'errRate', label: '错误率 (%)', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '如：0.2' },
      { key: 'samples', label: '样本数', type: 'number', onlyFor: { kind: 'perf' }, hideInDetail: true, placeholder: '总请求数（导入报告自动填）' },
      { key: 'reportDir', label: '报告目录', type: 'text', onlyFor: { kind: 'perf' }, formHidden: true },
      // 压测指标汇总（详情页渲染成表格，字段本身不单独展示）
      { key: 'perfMetrics', label: '压测指标', type: 'metrics', onlyFor: { kind: 'perf' }, formHidden: true, hideEmpty: true },
      { key: 'conclusion', label: '结论', type: 'textarea', placeholder: '达标没达标、瓶颈在哪、要不要跟进' }
    ]
  }
  // 测试笔记已改成 md 只读索引（见 electron/notes.js + src/pages/NotesPage.tsx），
  // 不再作为数据库集合存在。旧的 notes 记录如果出现在备份 JSON 里，导入时会被跳过。
];

const TOOLS = [
  { key: 'json', name: 'JSON 转化', icon: 'CodeOutlined', desc: '格式化 / 压缩 / 转义 / 校验' },
  { key: 'data', name: '测试数据', icon: 'ExperimentOutlined', desc: '手机号 / 身份证 / 银行卡 / 地址…' },
  { key: 'toolbox', name: '工具箱', icon: 'ToolOutlined', desc: 'Base64 / 时间戳 / 哈希 / UUID' }
];

const COLLECTION_MAP = COLLECTIONS.reduce((acc, c) => {
  acc[c.key] = c;
  return acc;
}, {});

/**
 * 需要加密的字段。
 *
 * 支持两种形式：
 *   - 顶层字段：`type: 'secret'` → 自动收集
 *   - **嵌套路径**：字段上写 `secretPaths: ['accounts[].password']`
 *     （数组里的密码，`type` 不是 secret，靠这个显式声明）
 */
const SECRET_KEYS = COLLECTIONS.reduce((acc, c) => {
  const keys = c.fields.filter((f) => f.type === 'secret').map((f) => f.key);
  // 收集嵌套路径
  for (const f of c.fields) {
    if (Array.isArray(f.secretPaths)) keys.push(...f.secretPaths);
  }
  if (keys.length) acc[c.key] = keys;
  return acc;
}, {});

module.exports = {
  COLLECTIONS,
  COLLECTION_MAP,
  SECRET_KEYS,
  TOOLS,
  ENV_OPTIONS,
  ROLE_OPTIONS,
  TAG_OPTIONS,
  OPTION_SETS,
  METHOD_OPTIONS,
  COMPLETENESS_OPTIONS,
  SOURCE_OPTIONS,
  BODY_TYPE_OPTIONS,
  RUN_KIND_OPTIONS,
  RUN_RESULT_OPTIONS
};