'use strict';
/**
 * UI 动作库（积木）—— 纯数据，零依赖。
 *
 * ============================================================
 * 这一层为什么不写代码，只写「数据 + 模板」
 * ============================================================
 * 积木要同时生成 Java / Python 两门语言，如果每个动作都写成一段 if/else，
 * 加一个动作就要改生成器；数据化之后，加动作 = 往数组里加一条，
 * 生成器只管把 `%参数名%` 换成真实值（shared/uiStepGen.js）。
 *
 * 模板约定：
 *   %参数名%  → 会被替换（字符串类参数的引号写在模板里，生成器只负责转义内容）
 *   行尾分号：Java 有，Python 没有
 *   Python 里 page 是 fixture，方法体里必须写 self.page（Playwright Python 的约定）
 *
 * ============================================================
 * 分类顺序（UI 按 UI_ACTION_CATEGORIES 排序，别随手调）
 * ============================================================
 * 导航排第一：流程得先打开页面，其他动作才有意义。
 */

/** 常用的「页面元素」参数，单独抽出来避免每处都抄一遍类型字段 */
const EL = { key: 'el', type: 'element', required: true, label: '页面元素' };

const UI_ACTIONS = [
  /* ---------------- 导航（流程必须从这里开始） ---------------- */
  {
    id: 'goto',
    category: 'nav',
    name: '打开地址',
    desc: '导航到页面地址，一般放在流程第一步',
    params: [
      { key: 'url', type: 'text', required: true, label: 'URL', placeholder: '/login 或完整地址' }
    ],
    java: 'page.navigate("%url%");',
    python: 'self.page.goto("%url%")'
  },

  /* ---------------- 断言 ---------------- */
  {
    id: 'assert-visible',
    category: 'assert',
    name: '断言可见',
    desc: '元素出现在页面上',
    params: [EL],
    java: 'assertThat(%el%).isVisible();',
    python: 'expect(%el%).to_be_visible()'
  },
  {
    id: 'assert-hidden',
    category: 'assert',
    name: '断言隐藏',
    desc: '元素不可见',
    params: [EL],
    java: 'assertThat(%el%).isHidden();',
    python: 'expect(%el%).to_be_hidden()'
  },
  {
    id: 'assert-text',
    category: 'assert',
    name: '断言文本',
    desc: '元素文本完全等于预期值',
    params: [
      EL,
      { key: 'text', type: 'text', required: true, label: '文本', placeholder: '登录成功' }
    ],
    java: 'assertThat(%el%).hasText("%text%");',
    python: 'expect(%el%).to_have_text("%text%")'
  },
  {
    id: 'assert-contains-text',
    category: 'assert',
    name: '断言包含文本',
    desc: '元素文本里包含预期片段',
    params: [
      EL,
      { key: 'text', type: 'text', required: true, label: '文本', placeholder: '成功' }
    ],
    java: 'assertThat(%el%).containsText("%text%");',
    python: 'expect(%el%).to_contain_text("%text%")'
  },
  {
    id: 'assert-count',
    category: 'assert',
    name: '断言数量',
    desc: '匹配到的元素个数等于预期',
    params: [
      EL,
      { key: 'count', type: 'number', required: true, default: 1, label: '数量', placeholder: '1' }
    ],
    java: 'assertThat(%el%).hasCount(%count%);',
    python: 'expect(%el%).to_have_count(%count%)'
  },
  {
    id: 'assert-attr',
    category: 'assert',
    name: '断言属性',
    desc: '元素的某个属性等于预期值',
    params: [
      EL,
      { key: 'name', type: 'text', required: true, label: '属性名', placeholder: 'placeholder' },
      { key: 'value', type: 'text', required: true, label: '属性值', placeholder: '请输入用户名' }
    ],
    java: 'assertThat(%el%).hasAttribute("%name%", "%value%");',
    python: 'expect(%el%).to_have_attribute("%name%", "%value%")'
  },
  {
    id: 'assert-title',
    category: 'assert',
    name: '断言标题',
    desc: '页面标题等于预期值',
    params: [
      { key: 'title', type: 'text', required: true, label: '标题', placeholder: '登录 - 测试工作台' }
    ],
    java: 'assertThat(page).hasTitle("%title%");',
    python: 'expect(self.page).to_have_title("%title%")'
  },

  /* ---------------- 鼠标 ---------------- */
  {
    id: 'click',
    category: 'mouse',
    name: '点击',
    desc: '单击元素',
    params: [EL],
    java: '%el%.click();',
    python: '%el%.click()'
  },
  {
    id: 'dblclick',
    category: 'mouse',
    name: '双击',
    desc: '双击元素',
    params: [EL],
    java: '%el%.dblclick();',
    python: '%el%.dblclick()'
  },
  {
    id: 'hover',
    category: 'mouse',
    name: '悬停',
    desc: '鼠标移到元素上（触发 hover 菜单）',
    params: [EL],
    java: '%el%.hover();',
    python: '%el%.hover()'
  },
  {
    id: 'check',
    category: 'mouse',
    name: '勾选',
    desc: '勾上 checkbox / radio（已勾选时无副作用）',
    params: [EL],
    java: '%el%.check();',
    python: '%el%.check()'
  },

  /* ---------------- 键盘 ---------------- */
  {
    id: 'fill',
    category: 'keyboard',
    name: '输入文本',
    desc: '清空输入框并填入文本',
    params: [
      EL,
      { key: 'text', type: 'text', required: true, label: '文本', placeholder: 'admin' }
    ],
    java: '%el%.fill("%text%");',
    python: '%el%.fill("%text%")'
  },
  {
    id: 'press',
    category: 'keyboard',
    name: '按键',
    desc: '在当前焦点上按一个键（Enter / Tab / Escape ...）',
    params: [
      { key: 'key', type: 'text', required: true, default: 'Enter', label: '按键', placeholder: 'Enter / Tab / Escape' }
    ],
    java: 'page.keyboard().press("%key%");',
    python: 'self.page.keyboard.press("%key%")'
  },

  /* ---------------- 等待 ---------------- */
  {
    id: 'wait-visible',
    category: 'wait',
    name: '等待可见',
    desc: '等元素变为可见再继续（比固定 sleep 稳）',
    params: [EL],
    java: '%el%.waitFor(new Locator.WaitForOptions().setState(WaitForSelectorState.VISIBLE));',
    python: '%el%.wait_for(state="visible")'
  },
  {
    id: 'wait-url',
    category: 'wait',
    name: '等待地址',
    desc: '等 URL 变成预期值（跳转类流程必用）',
    params: [{ key: 'url', type: 'text', required: true, label: 'URL', placeholder: '**/home' }],
    java: 'page.waitForURL("%url%");',
    python: 'self.page.wait_for_url("%url%")'
  },
  {
    id: 'wait-timeout',
    category: 'wait',
    name: '固定等待',
    desc: '硬等若干毫秒（只有实在没有可断言条件时才用）',
    params: [{ key: 'ms', type: 'number', required: true, default: 1000, label: '毫秒', placeholder: '1000' }],
    java: 'page.waitForTimeout(%ms%);',
    python: 'self.page.wait_for_timeout(%ms%)'
  }
];

/** 分类顺序（UI 按这个排序） */
const UI_ACTION_CATEGORIES = [
  { key: 'nav', label: '导航' },
  { key: 'assert', label: '断言' },
  { key: 'mouse', label: '鼠标' },
  { key: 'keyboard', label: '键盘' },
  { key: 'wait', label: '等待' }
];

/** 参数允许的类型（前端按这个渲染控件，生成器按这个决定怎么转义） */
const UI_PARAM_TYPES = ['element', 'text', 'number', 'boolean', 'select'];

/** 按 id 取动作；取不到返回 null（生成器遇到脏数据时只警告不抛） */
function actionById(id) {
  const key = String(id === undefined || id === null ? '' : id);
  for (const a of UI_ACTIONS) {
    if (a.id === key) return a;
  }
  return null;
}

/** 按分类分组（顺序跟随 UI_ACTION_CATEGORIES，空分类不返回） */
function actionsByCategory() {
  return UI_ACTION_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    actions: UI_ACTIONS.filter((a) => a.category === c.key)
  })).filter((g) => g.actions.length > 0);
}

module.exports = {
  UI_ACTIONS,
  UI_ACTION_CATEGORIES,
  UI_PARAM_TYPES,
  actionById,
  actionsByCategory
};