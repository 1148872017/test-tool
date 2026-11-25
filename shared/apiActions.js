'use strict';
/**
 * 接口动作库（积木）—— 纯数据，零依赖。
 *
 * ============================================================
 * 和 shared/uiActions.js 的关系
 * ============================================================
 * 同一个套路：动作只写「数据 + 模板」，生成器（shared/apiFlowGen.js）负责把
 * `%参数名%` 换成真实值。加一个接口动作 = 往数组里加一条，生成器不用改。
 * 但原子完全不同：UI 的原子是「元素」（element），接口的原子是
 * 「响应变量」（Response）+ 「接口快照」（method/path/headers/body）。
 *
 * ============================================================
 * 模板约定（和 UI 动作库**有一处不同，必须记住**）
 * ============================================================
 *   1. `%参数名%` 会被替换；行尾分号：Java 有，Python 没有。
 *   2. 字符串参数的**引号由生成器负责，模板里不写引号**。
 *      原因：文本参数里可以嵌 `${变量}`，生成器得按语言拼成
 *      `"Bearer " + token`（Java）/ `f'Bearer {token}'`（Python）。
 *      如果模板写死 `"%path%"`，参数一旦变成拼接表达式就会生成
 *      `"" + orderId + ""` 这种半截代码 —— 引号归模板、内容归生成器，
 *      职责就没法在「带变量」的情况下划清。
 *      所以：`%path%` 展开后本身就是一个完整的字符串表达式（`"$.data.id"` / `f'...'`）。
 *   3. 多行模板照原样写，生成器会给每一行加同一层缩进，
 *      模板自身的缩进（如 Python 的 `if` 块）会保留。
 *   4. 参数 key 的语义约定（生成器据此判断读变量还是写变量）：
 *        `from`  → 读：**前面步骤已产生**的变量名
 *        `as` / `name` → 写：本步新定义的变量名
 *   5. `call`（调用接口）的模板只是占位：真正代码由生成器按**接口快照**展开
 *      （method/path/headers/body 都在步骤的 params 里，见 apiFlowGen.js）。
 *      `%apiName%` 是快照字段（接口名），不是表单参数，所以登记在 API_PSEUDO_PARAMS。
 */

const API_ACTIONS = [
  /* ---------------- 请求（流程必须从这里开始） ---------------- */
  {
    id: 'call',
    category: 'request',
    name: '调用接口',
    desc: '按接口快照发一次请求，响应存进变量，后面用它提取 / 断言',
    params: [
      { key: 'apiId', type: 'apiRecord', required: true, label: '接口' },
      {
        key: 'as',
        type: 'ident',
        required: true,
        label: '响应存为变量',
        default: 'resp1',
        placeholder: 'resp1（后续用它提取/断言）'
      }
    ],
    // 下面的模板在生成时会被「接口快照」展开（见 apiFlowGen.js）
    java: '/*调用 %apiName%*/',
    python: '/*调用 %apiName%*/'
  },

  /* ---------------- 提取 ---------------- */
  {
    id: 'extract-json',
    category: 'extract',
    name: '提取变量（JSONPath）',
    desc: '从响应里按 JSONPath 取一个值，存成变量给后面用',
    params: [
      { key: 'from', type: 'ident', required: true, label: '从哪个响应', placeholder: 'loginResp' },
      { key: 'path', type: 'text', required: true, label: 'JSONPath', default: '$.data.id' },
      { key: 'as', type: 'ident', required: true, label: '存为变量', default: 'myVar' }
    ],
    java: 'String %as% = %from%.jsonPath().getString(%path%);',
    python: '%as% = _dig(%from%.json(), %path%)'
  },
  {
    id: 'extract-regex',
    category: 'extract',
    name: '提取变量（正则）',
    desc: '响应体不是 JSON（或字段藏在字符串里）时，用正则抓第 1 个分组',
    params: [
      { key: 'from', type: 'ident', required: true, label: '从哪个响应' },
      { key: 'expr', type: 'text', required: true, label: '正则', placeholder: 'token":"([^"]+)' },
      { key: 'as', type: 'ident', required: true, label: '存为变量' }
    ],
    java: [
      'Matcher %as%Matcher = Pattern.compile(%expr%).matcher(%from%.asString());',
      'if (!%as%Matcher.find()) {',
      '    throw new IllegalStateException("正则没匹配到：" + %expr%);',
      '}',
      'String %as% = %as%Matcher.group(1);'
    ].join('\n'),
    python: [
      '_m = re.search(%expr%, %from%.text)',
      'if _m is None:',
      '    raise AssertionError("正则没匹配到：" + %expr%)',
      '%as% = _m.group(1)'
    ].join('\n')
  },

  /* ---------------- 断言 ---------------- */
  {
    id: 'assert-status',
    category: 'assert',
    name: '断言状态码',
    desc: 'HTTP 状态码等于预期值',
    params: [
      { key: 'from', type: 'ident', required: true, label: '响应变量' },
      { key: 'code', type: 'number', required: true, default: 200, label: '期望状态码' }
    ],
    java: '%from%.then().statusCode(%code%);',
    python: 'assert %from%.status_code == %code%'
  },
  {
    id: 'assert-json',
    category: 'assert',
    name: '断言 JSON 字段',
    desc: '按 JSONPath 取字段，值和预期相等',
    params: [
      { key: 'from', type: 'ident', required: true, label: '响应变量' },
      { key: 'path', type: 'text', required: true, label: 'JSONPath', default: '$.code' },
      // literal：期望值要按「字面量」生成（0 → 0，ok → "ok"），不能一律加引号
      { key: 'value', type: 'text', required: true, label: '期望值', default: '0', literal: true }
    ],
    java: '%from%.then().body(%path%, equalTo(%value%));',
    python: 'assert _dig(%from%.json(), %path%) == %value%'
  },
  {
    id: 'assert-time',
    category: 'assert',
    name: '断言响应时间',
    desc: '响应耗时小于上限（毫秒）',
    params: [
      { key: 'from', type: 'ident', required: true, label: '响应变量' },
      { key: 'ms', type: 'number', required: true, default: 2000, label: '上限(ms)' }
    ],
    java: '%from%.then().time(lessThan(%ms%L));',
    python: 'assert %from%.elapsed.total_seconds() * 1000 < %ms%'
  },

  /* ---------------- 变量 ---------------- */
  {
    id: 'set-var',
    category: 'var',
    name: '设置变量',
    desc: '写一个固定值（可引用前面的变量，如 Bearer ${token}）',
    params: [
      { key: 'name', type: 'ident', required: true, label: '变量名', default: 'myVar' },
      {
        key: 'value',
        type: 'text',
        required: true,
        label: '值',
        placeholder: '固定值或 ${其他变量}'
      }
    ],
    java: 'String %name% = %value%;',
    python: '%name% = %value%'
  }
];

/** 分类顺序（前端按这个排序，别随手调：请求永远第一） */
const API_ACTION_CATEGORIES = [
  { key: 'request', label: '请求' },
  { key: 'extract', label: '提取' },
  { key: 'assert', label: '断言' },
  { key: 'var', label: '变量' }
];

/**
 * 参数类型（前端按这个渲染控件，生成器按这个决定怎么转义）：
 *   apiRecord → 从 apis 集合选接口（选中后把 method/path/headers/body 存成快照）
 *   ident     → 标识符（变量名），按 Java / Python 的标识符规则校验
 *   text      → 任意文本，可嵌 ${变量}
 *   number    → 数字
 */
const API_PARAM_TYPES = ['apiRecord', 'ident', 'text', 'number'];

/**
 * 模板里能出现、但不是表单参数的占位符。
 *
 * `apiName` 来自接口快照（选接口时存下的名字），不是让用户填的，
 * 所以不能登记成 params —— 但模板里用得到，单测校验占位符时要认得它。
 */
const API_PSEUDO_PARAMS = ['apiName'];

/**
 * 是不是合法的变量名。
 *
 * 比 Java 的标识符规则更严一点：不允许 `$`。
 * 因为变量是靠 `${name}` 引用的，名字里带 `$` 就没法写回来了；
 * 而且这套变量同时要在 Python 里用，取两边的交集（字母/下划线开头 + 字母数字下划线）。
 */
function isIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name === undefined || name === null ? '' : name).trim());
}

/** 按 id 取动作；取不到返回 null（生成器遇到脏数据时只警告不抛） */
function actionById(id) {
  const key = String(id === undefined || id === null ? '' : id);
  for (const a of API_ACTIONS) {
    if (a.id === key) return a;
  }
  return null;
}

/** 按分类分组（顺序跟随 API_ACTION_CATEGORIES，空分类不返回） */
function actionsByCategory() {
  return API_ACTION_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    actions: API_ACTIONS.filter((a) => a.category === c.key)
  })).filter((g) => g.actions.length > 0);
}

module.exports = {
  API_ACTIONS,
  API_ACTION_CATEGORIES,
  API_PARAM_TYPES,
  API_PSEUDO_PARAMS,
  isIdentifier,
  actionById,
  actionsByCategory
};