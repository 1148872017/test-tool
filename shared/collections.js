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

/** 接口模块 / 目录：默认留空，由用户在设置里维护；表单里手输的新模块会自动收进来 */
const MODULE_OPTIONS = [];

/** 页面所属项目：默认留空，同上 */
const PROJECT_OPTIONS = [];

/**
 * 可配置选项集（设置页能增删改）。
 * value 就是存进记录里的值：环境的 value 一旦被记录引用就别改（改的是 label）。
 *
 * kind:
 *   env  —— 选项是 { value, label, color } 对象
 *   text —— 选项就是一个字符串（值即显示名）
 */
const OPTION_SETS = {
  env: { key: 'env', name: '环境', kind: 'env', defaults: ENV_OPTIONS },
  role: { key: 'role', name: '角色 / 权限', kind: 'text', defaults: ROLE_OPTIONS },
  tags: { key: 'tags', name: '标签', kind: 'text', defaults: TAG_OPTIONS },
  module: { key: 'module', name: '接口模块', kind: 'text', defaults: MODULE_OPTIONS },
  project: { key: 'project', name: '页面项目', kind: 'text', defaults: PROJECT_OPTIONS }
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
    group: '资产',
    icon: 'GlobalOutlined',
    desc: '测试环境地址与登录信息，点开即用',
    titleField: 'name',
    titlePlaceholder: '如：资产管理系统-管理后台',
    listFields: ['env', 'accounts'],
    filterField: 'env',
    noFavorite: true,
    openField: 'url',
    actions: ['open'],
    /**
     * 能力描述（纯数据，主进程不读）。
     * 页面只读这里，不再按 key 写 if/else —— 加第 6 个集合时只改本文件。
     */
    capabilities: {
      open: 'url',
      copyKinds: ['accounts'],
      sync: null,
      showRunLog: false,
      favorite: false,
      headerActions: ['importData', 'importTemplate', 'exportData', 'refresh'],
      titleWidthPct: 32
    },
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
    group: '资产',
    icon: 'ConsoleSqlOutlined',
    desc: '常用查询与变更语句，变量替换后复制',
    titleField: 'name',
    titlePlaceholder: '如：按订单号查退款流水',
    listFields: ['db'],
    actions: ['sql'],
    capabilities: {
      open: null,
      copyKinds: ['sql'],
      sync: null,
      showRunLog: false,
      favorite: true,
      headerActions: ['importData', 'importTemplate', 'exportData', 'refresh'],
      titleWidthPct: 50
    },
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
    group: '资产',
    icon: 'ApiOutlined',
    desc: '常用接口，一键复制成 cURL；可从 Apifox 导出文件同步',
    titleField: 'name',
    titlePlaceholder: '如：创建退款单',
    listFields: ['method', 'url'],
    actions: ['curl'],
    sync: 'openapi',
    capabilities: {
      open: null,
      copyKinds: ['curl', 'text'],
      sync: 'openapi',
      showRunLog: true,
      favorite: true,
      // impact = 「上次同步变更」入口，只有真的读到变更才显示
      headerActions: ['importCurl', 'syncOpenApi', 'importData', 'importTemplate', 'exportData', 'refresh', 'impact'],
      titleWidthPct: 50
    },
    fields: [
      { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：创建退款单' },
      { key: 'method', label: '方法', type: 'select', options: METHOD_OPTIONS, default: 'POST' },
      { key: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://test.example.com/api/refund' },
      // 模块 / 目录：Apifox 同步会写，用户也可以自己选或直接输入新名字（选项集 module）
      {
        key: 'module',
        label: '模块 / 目录',
        type: 'selectOrCreate',
        optionsKey: 'module',
        placeholder: '选一个模块，或直接输入新模块名'
      },
      // ---- 以下为同步镜像字段：详情里只读展示，编辑表单里不出现（formHidden） ----
      // 每个 formHidden 都写明原因（formHiddenReason）：没有原因的 formHidden 会被
      // scripts/test-module-field.cjs 的「详情/表单一致性」检查拦下来 —— 用户报的 bug 正是这个
      { key: 'summary', label: '接口描述', type: 'textarea', formHidden: true, formHiddenReason: '同步镜像：Apifox 自动写入，表单里不给改' },
      { key: 'params', label: '参数摘要', type: 'code', rows: 4, formHidden: true, formHiddenReason: '同步镜像：Apifox 自动写入，表单里不给改' },
      // 参数的结构化快照：只给「变更 diff」用，界面上不出现
      { key: 'paramSpec', label: '参数快照', type: 'code', formHidden: true, hideInDetail: true },
      { key: 'paramTable', label: '参数', type: 'code', formHidden: true, formHiddenReason: '同步镜像：Apifox 自动写入，表单里不给改' },
      { key: 'reqSchema', label: '请求 Schema', type: 'code', rows: 8, formHidden: true, formHiddenReason: '同步镜像：Apifox 自动写入，表单里不给改' },
      { key: 'respSchema', label: '响应 Schema', type: 'code', rows: 8, formHidden: true, formHiddenReason: '同步镜像：Apifox 自动写入，表单里不给改' },
      { key: 'respExample', label: '响应示例', type: 'code', rows: 8, formHidden: true, formHiddenReason: '同步镜像：Apifox 自动写入，表单里不给改' },
      { key: 'completeness', label: '完整度', type: 'select', options: COMPLETENESS_OPTIONS, formHidden: true, formHiddenReason: '按导入内容自动判定，表单里不给改' },
      { key: 'source', label: '来源', type: 'select', options: SOURCE_OPTIONS, default: 'manual', formHidden: true, formHiddenReason: '导入 / 同步时自动标记，表单里不给改' },
      { key: 'syncedAt', label: '同步于', type: 'datetime', formHidden: true, formHiddenReason: '同步时自动记录时间，表单里不给改' },
      // 上次同步的变更（只有真变过才有这行，空了整行不显示）
      { key: 'lastChange', label: '上次同步变更', type: 'change', formHidden: true, hideEmpty: true, formHiddenReason: '同步时自动生成的 diff，表单里不给改' },
      // ---- 以下是你自己的，同步永不覆盖 ----
      { key: 'myNote', label: '我的备注', type: 'textarea', placeholder: '能不能测、坑在哪、要哪个账号 —— 这些 Apifox 里没有' },
      { key: 'headers', label: 'Headers', type: 'code', rows: 5, placeholder: 'Content-Type: application/json\nAuthorization: Bearer {{token}}' },
      { key: 'body', label: 'Body', type: 'code', rows: 8, placeholder: '{"orderNo": "{{orderNo}}"}' },
      // body 的媒体类型（和 Apifox 的 Body 页签一致）
      { key: 'bodyType', label: 'Body 类型', type: 'select', options: BODY_TYPE_OPTIONS, formHidden: true, formHiddenReason: '导入 / 同步时自动判定，表单里不给改' },
      { key: 'note', label: '其他备注', type: 'textarea', placeholder: '前置条件、返回字段…' }
    ]
  },
  {
    key: 'runs',
    name: '测试执行',
    group: '资产',
    icon: 'ThunderboltOutlined',
    desc: '接口测试 / 压测跑一次记一笔：结果、指标、结论，报告留在 Apifox',
    titleField: 'name',
    titlePlaceholder: '如：下单链路 10 并发 1 分钟',
    listFields: ['apiRef', 'kind', 'result', 'ranAt'],
    filterField: 'kind',
    noFavorite: true,
    capabilities: {
      open: null,
      copyKinds: ['text'],
      sync: null,
      showRunLog: false,
      favorite: false,
      headerActions: ['importReport', 'importData', 'importTemplate', 'exportData', 'refresh'],
      titleWidthPct: 50,
      /**
       * 「关联报告」锚点（v0.46.1）。
       *
       * 有值 = 这条执行能在「报告分析」页重新打开那份报告：
       *   Allure 报告 → 归档时写 reportDir（allure:archive）
       *   jtl 压测报告 → 导入时也写 reportDir，但目录里是 JMeter 的报告，
       *                  报告分析页解析不了 → 用 when 限定只给接口测试挂入口
       * 存的是**字段名**而不是布尔值：页面拿它去 data 里取值，不认识集合 key。
       */
      linkedReport: { field: 'reportDir', when: { field: 'kind', equals: 'api' } }
    },
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
      // 报告目录：接口测试（Allure 归档）和压测（jtl 导入）都会写，是「关联报告」的锚点。
      // 不再用 onlyFor 限成压测专用 —— 否则接口测试那条执行永远看不到自己的报告目录。
      {
        key: 'reportDir',
        label: '报告目录',
        type: 'text',
        formHidden: true,
        // 没归档过的执行不显示这一行（否则每条都挂一条空行）
        hideEmpty: true,
        formHiddenReason: '导入压测报告 / 归档 Allure 报告时自动写入，表单里不给改'
      },
      // 压测指标汇总（详情页渲染成表格，字段本身不单独展示）
      { key: 'perfMetrics', label: '压测指标', type: 'metrics', onlyFor: { kind: 'perf' }, formHidden: true, hideEmpty: true, formHiddenReason: '详情页渲染成指标表格，表单里不给改' },
      { key: 'conclusion', label: '结论', type: 'textarea', placeholder: '达标没达标、瓶颈在哪、要不要跟进' }
    ]
  }
  // 测试笔记已改成 md 只读索引（见 electron/notes.js + src/pages/NotesPage.tsx），
  // 不再作为数据库集合存在。旧的 notes 记录如果出现在备份 JSON 里，导入时会被跳过。
,
  /**
   * 页面元素（Playwright Page Object 生成用）。
   *
   * 规划要求「在平台里可视化维护页面元素名称和定位器，一键生成 POM」。
   * 元素存在 elements 字段（JSON 数组：[{name, selector, desc}]）。
   */
  {
    key: 'pages',
    name: '页面元素',
    group: '资产',
    icon: 'LayoutOutlined',
    desc: 'Playwright 页面元素定位器，一键生成 Page Object',
    titleField: 'name',
    titlePlaceholder: '如：登录页',
    listFields: ['url', 'project'],
    noFavorite: true,
    capabilities: {
      open: null,
      copyKinds: ['text'],
      sync: null,
      showRunLog: false,
      favorite: false,
      headerActions: ['importData', 'importTemplate', 'exportData', 'refresh'],
      titleWidthPct: 50
    },
    fields: [
      {
        key: 'name',
        label: '页面名',
        type: 'text',
        required: true,
        placeholder: '如：登录页'
      },
      {
        key: 'url',
        label: '页面路径',
        type: 'text',
        required: true,
        placeholder: '/login'
      },
      {
        key: 'project',
        label: '所属项目',
        type: 'selectOrCreate',
        optionsKey: 'project',
        placeholder: '选一个项目，或直接输入新项目名（可留空）'
      },
      {
        key: 'elements',
        label: '元素定位器',
        type: 'elements',
        placeholder: '每个元素一行：名称 + 定位器 + 说明'
      },
      {
        key: 'note',
        label: '备注',
        type: 'textarea',
        placeholder: '可选'
      }
    ]
  },
  /**
   * 流程模板（积木区保存的流程）。
   *
   * 用户原话：「积木库功能缺保存按钮」—— 拼好的步骤只能当场复制走，关掉就没了。
   * 这里存的是**结构化步骤 + POM 配置**，读写都在积木区
   * （src/components/ui-bricks/BricksPanel.tsx），集合页只负责列出来给人看：
   *   steps 是 JSON 字符串 [{actionId, params, elementMode, elementSelector}]，
   *   载入时按当前页面元素重新生成定位器，所以元素改了流程不会跟着烂。
   *
   * 表单里只留「流程名 / 备注」：其余字段是积木区自动写的快照，手改会把
   * 步骤和 POM 配置写乱。每个 formHidden 都写明 formHiddenReason，
   * 否则 scripts/test-module-field.cjs 的「详情/表单一致性」检查会红
   * （详情看得见、表单里没有，正是 v0.46 修的那个 bug）。
   * 注意：真正让表单不渲染的是 `formHidden`（RecordForm 按它过滤），
   * `hideInForm` 只是「这个字段归 UI 管、不该手填」的声明，两个都要写。
   */
  {
    key: 'flows',
    name: '流程模板',
    group: '资产',
    // 图标沿用 src/icons.tsx 已有的映射（ProfileOutlined = 一页流程卡片），不新增图标资源
    icon: 'ProfileOutlined',
    desc: '把积木拼好的步骤存下来，下次直接载入',
    titleField: 'name',
    titlePlaceholder: '如：登录页流程-1125',
    listFields: ['pageName'],
    noFavorite: true,
    capabilities: {
      open: null,
      copyKinds: ['text'],
      sync: null,
      showRunLog: false,
      favorite: false,
      // 导入 / 导出 / 刷新都有；流程模板没有外部同步源
      headerActions: ['importData', 'importTemplate', 'exportData', 'refresh'],
      titleWidthPct: 50
    },
    fields: [
      { key: 'name', label: '流程名', type: 'text', required: true, placeholder: '如：登录页流程-1125' },
      /**
       * 流程类型：ui（页面动作积木）/ api（接口流程积木）。
       *
       * 两种积木共用 flows 集合，靠这个字段把「载入流程」下拉分成两拨 ——
       * UI 积木只列 ui、接口积木只列 api。**老记录没有这个字段，一律当 ui**
       * （v0.49 之前只有 UI 积木，兜底规则见 apiBrickHelpers.flowKindOf 和 CodegenPage.flowIsApiKind）。
       */
      {
        key: 'kind',
        label: '流程类型',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '由积木区自动写入（ui/api）'
      },
      {
        key: 'baseUrl',
        label: 'BaseUrl',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '接口流程由积木区自动写入，生成时拼在 path 前'
      },
      {
        key: 'testName',
        label: '测试方法名',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '接口流程由积木区自动写入，留空按 test_flow 兜底'
      },
      {
        key: 'pageId',
        label: '关联页面',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '由积木区自动写入，选页面元素即可'
      },
      {
        key: 'pageName',
        label: '页面',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '同上，只读快照'
      },
      {
        key: 'steps',
        label: '步骤',
        type: 'textarea',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '结构化数据，由积木区管理'
      },
      {
        key: 'pomMode',
        label: 'POM 模式',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '由积木区管理'
      },
      {
        key: 'pomClass',
        label: 'POM 类名',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '由积木区管理'
      },
      {
        key: 'pomVar',
        label: 'POM 变量名',
        type: 'text',
        hideInForm: true,
        formHidden: true,
        formHiddenReason: '由积木区管理'
      },
      { key: 'note', label: '备注', type: 'textarea', placeholder: '这个流程测什么、前置条件…（选填）' }
    ]
  }
];

/**
 * 工具分组：按「测试工作流」排序。
 *
 *   写代码前  → 代码生成（骨架）
 *   写代码时  → 代码调试（跑起来看输出）
 *   写完后    → 代码体检（覆盖 + 硬编码）
 *   跑完后    → 报告分析（失败聚类 + Flaky）
 *   日常辅助  → 测试数据 / JSON 转化 / 工具箱
 */
const TOOLS = [
  // ---- 自动化工作流 ----
  { key: 'codegen', name: '代码生成', icon: 'FileAddOutlined', desc: '接口 / JSON / 页面元素 → Java/Python 骨架', group: '自动化' },
  { key: 'runner', name: '代码调试', icon: 'BugOutlined', desc: 'Groovy / Python / pytest / Maven 跑代码看输出', group: '自动化' },
  { key: 'codescan', name: '代码体检', icon: 'SafetyOutlined', desc: '接口覆盖矩阵 + 硬编码 / 脆弱定位扫描', group: '自动化' },
  { key: 'scriptgen', name: '脚本生成', icon: 'ThunderboltOutlined', desc: 'JMeter .jmx + MySQL/SQLite 快照清理 SQL', group: '自动化' },
  { key: 'report', name: '报告分析', icon: 'BarChartOutlined', desc: 'Allure 失败聚类 + Flaky 追踪', group: '自动化' },
  // ---- 日常辅助 ----
  { key: 'data', name: '测试数据', icon: 'ExperimentOutlined', desc: '手机号 / 身份证 / 银行卡 / 地址…', group: '辅助' },
  { key: 'json', name: 'JSON 工具', icon: 'CodeOutlined', desc: '格式化 / 压缩 / 转义 / 校验', group: '辅助' },
  { key: 'toolbox', name: '工具箱', icon: 'ToolOutlined', desc: 'Base64 / 时间戳 / 哈希 / UUID', group: '辅助' }
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
  MODULE_OPTIONS,
  PROJECT_OPTIONS,
  OPTION_SETS,
  METHOD_OPTIONS,
  COMPLETENESS_OPTIONS,
  SOURCE_OPTIONS,
  BODY_TYPE_OPTIONS,
  RUN_KIND_OPTIONS,
  RUN_RESULT_OPTIONS
};