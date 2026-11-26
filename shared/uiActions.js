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
    /**
     * v0.63：数量类断言补一个「比较」版本。
     *
     * 为什么必须有：Playwright 自带的数量断言只有 `to_have_count(n)`（**等于**），
     * 「列表至少有 3 条」「错误提示不超过 1 个」这种写法以前只能手写循环。
     * 这里用「先取 count() 再比较 + 抛出带实际值的断言错误」，不引第三方断言库，
     * 也不写等价的 hasCount（那只能表达等于）。
     */
    id: 'assert-count-op',
    category: 'assert',
    name: '断言数量（比较）',
    desc: '元素数量大于 / 小于 / 不等于预期（= 请用上面的「断言数量」）',
    params: [
      EL,
      {
        key: 'op',
        type: 'select',
        required: true,
        default: '>',
        label: '比较',
        options: [
          { value: '>', label: '大于 >' },
          { value: '>=', label: '大于等于 >=' },
          { value: '<', label: '小于 <' },
          { value: '<=', label: '小于等于 <=' },
          { value: '!=', label: '不等于 !=' }
        ]
      },
      { key: 'count', type: 'number', required: true, default: 1, label: '数量', placeholder: '3' }
    ],
    java: [
      'int actualCount = %el%.count();',
      'if (!(actualCount %op% %count%)) {',
      '    throw new AssertionError("数量断言失败：期望 %op% %count%，实际 " + actualCount);',
      '}'
    ].join('\n'),
    python: [
      '_cnt = %el%.count()',
      "assert _cnt %op% %count%, f'数量断言失败：期望 %op% %count%，实际 {_cnt}'"
    ].join('\n')
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
  },
  {
    id: 'wait-hidden',
    category: 'wait',
    name: '等待隐藏',
    desc: '等元素消失（等 loading 遮罩 / toast 消失）',
    params: [EL],
    java: '%el%.waitFor(new Locator.WaitForOptions().setState(WaitForSelectorState.HIDDEN));',
    python: '%el%.wait_for(state="hidden")'
  },

  /* ---------------- 表单（v0.59 新增） ---------------- */
  {
    id: 'select-option',
    category: 'form',
    name: '下拉选择',
    desc: '在 select 里按可见文本选一项',
    params: [
      EL,
      { key: 'value', type: 'text', required: true, label: '选项文本', placeholder: '启用' }
    ],
    java: '%el%.selectOption("%value%");',
    python: '%el%.select_option("%value%")'
  },
  {
    id: 'upload',
    category: 'form',
    name: '上传文件',
    desc: '给 file input 选一个本地文件（路径按运行目录写）',
    params: [
      EL,
      { key: 'path', type: 'text', required: true, label: '文件路径', placeholder: 'target/test-data/a.xlsx' }
    ],
    // 用全限定名 java.nio.file.Paths，免得生成器还要多管一个 import
    java: '%el%.setInputFiles(java.nio.file.Paths.get("%path%"));',
    python: '%el%.set_input_files("%path%")'
  },
  {
    id: 'clear-input',
    category: 'form',
    name: '清空输入框',
    desc: '把输入框清空（不改其它状态）',
    params: [EL],
    java: '%el%.clear();',
    python: '%el%.clear()'
  },
  {
    id: 'uncheck',
    category: 'form',
    name: '取消勾选',
    desc: '取消勾选 checkbox / radio（未勾选时无副作用）',
    params: [EL],
    java: '%el%.uncheck();',
    python: '%el%.uncheck()'
  },

  /* ---------------- 断言（v0.59 补充） ---------------- */
  {
    id: 'assert-enabled',
    category: 'assert',
    name: '断言可用',
    desc: '元素处于可交互状态（没被 disable）',
    params: [EL],
    java: 'assertThat(%el%).isEnabled();',
    python: 'expect(%el%).to_be_enabled()'
  },
  {
    id: 'assert-disabled',
    category: 'assert',
    name: '断言禁用',
    desc: '元素处于禁用状态（灰掉的按钮）',
    params: [EL],
    java: 'assertThat(%el%).isDisabled();',
    python: 'expect(%el%).to_be_disabled()'
  },
  {
    id: 'assert-url',
    category: 'assert',
    name: '断言地址',
    desc: '当前 URL 匹配（支持 * 通配）',
    params: [{ key: 'url', type: 'text', required: true, label: 'URL', placeholder: '**/home' }],
    java: 'assertThat(page).hasURL("%url%");',
    python: 'expect(self.page).to_have_url("%url%")'
  },
  {
    id: 'assert-value',
    category: 'assert',
    name: '断言输入值',
    desc: '输入框里的当前值等于预期',
    params: [
      EL,
      { key: 'value', type: 'text', required: true, label: '值', placeholder: 'admin' }
    ],
    java: 'assertThat(%el%).hasValue("%value%");',
    python: 'expect(%el%).to_have_value("%value%")'
  },

  /* ---------------- 工具（v0.59 新增：常被手写的那几段） ---------------- */
  {
    id: 'reload',
    category: 'tool',
    name: '刷新页面',
    desc: '重新加载当前页面',
    params: [],
    java: 'page.reload();',
    python: 'self.page.reload()'
  },
  {
    id: 'refresh-interval',
    category: 'tool',
    name: '定时刷新',
    desc: '按固定间隔刷新 N 次（等异步任务出结果时最常用）',
    params: [
      { key: 'count', type: 'number', required: true, default: 3, label: '刷新次数', placeholder: '3' },
      { key: 'ms', type: 'number', required: true, default: 2000, label: '间隔(ms)', placeholder: '2000' }
    ],
    java: [
      'for (int i = 0; i < %count%; i++) {',
      '    page.waitForTimeout(%ms%);',
      '    page.reload();',
      '}'
    ].join('\n'),
    python: ['for _ in range(%count%):', '    self.page.wait_for_timeout(%ms%)', '    self.page.reload()'].join('\n')
  },
  {
    id: 'screenshot',
    category: 'tool',
    name: '截图',
    desc: '把当前页面存成图片（相对运行目录）',
    params: [
      { key: 'path', type: 'text', required: true, label: '保存路径', placeholder: 'target/screenshots/login.png' }
    ],
    java: 'page.screenshot(new Page.ScreenshotOptions().setPath(java.nio.file.Paths.get("%path%")));',
    python: 'self.page.screenshot(path="%path%")'
  },
  {
    id: 'pause',
    category: 'tool',
    name: '调试暂停',
    desc: '在此处打开 Playwright Inspector，单步看现场（调试完记得删掉）',
    params: [],
    java: 'page.pause();',
    python: 'self.page.pause()'
  },
  {
    id: 'scroll-to',
    category: 'tool',
    name: '滚动到元素',
    desc: '把元素滚进可视区域（长列表里点下面的按钮前用）',
    params: [EL],
    java: '%el%.scrollIntoViewIfNeeded();',
    python: '%el%.scroll_into_view_if_needed()'
  },
  {
    id: 'clear-cookies',
    category: 'tool',
    name: '清空 Cookie',
    desc: '清掉当前上下文的 cookie / 本地存储里的登录态',
    params: [],
    java: 'context.clearCookies();',
    python: 'self.context.clear_cookies()'
  },
  {
    id: 'close-context',
    category: 'tool',
    name: '退出并清空浏览器',
    desc: '清 cookie 后关闭上下文（相当于「退出登录并关窗口」）',
    params: [],
    java: ['context.clearCookies();', 'context.close();'].join('\n'),
    python: ['self.context.clear_cookies()', 'self.context.close()'].join('\n')
  }
];

/** 分类顺序（UI 按这个排序） */
const UI_ACTION_CATEGORIES = [
  { key: 'nav', label: '导航' },
  { key: 'assert', label: '断言' },
  { key: 'mouse', label: '鼠标' },
  { key: 'keyboard', label: '键盘' },
  { key: 'form', label: '表单' },
  { key: 'wait', label: '等待' },
  // 工具放最后：它们不是「操作业务」，而是常被手写的那几段（刷新 / 截图 / 清现场）
  { key: 'tool', label: '工具' }
];

/** 参数允许的类型（前端按这个渲染控件，生成器按这个决定怎么转义） */
const UI_PARAM_TYPES = ['element', 'text', 'number', 'boolean', 'select'];

/**
 * 每一步代码**前面那行注释**的文案（v0.61）。
 *
 * 为什么要它：积木拼出来的方法体，隔两天自己都看不懂「这行 waitForTimeout(3000) 是在等什么」。
 * 有了注释就是 `// 3. 固定等待：3000 ms` + 代码，回头一眼能对上当时点的哪个积木。
 *
 * 模板里同样是 `%参数名%`，由 summaryOf 用参数值替换；没写模板的动作退回动作名。
 */
const UI_SUMMARY_TEMPLATES = {
  /* 导航 */
  goto: '打开地址 %url%',

  /* 断言 */
  'assert-visible': '断言可见：%el%',
  'assert-hidden': '断言隐藏：%el%',
  'assert-text': '断言文本：%el% 等于「%text%」',
  'assert-contains-text': '断言包含文本：%el% 含「%text%」',
  'assert-count': '断言数量：%el% 共 %count% 个',
  'assert-count-op': '断言数量：%el% %op% %count% 个',
  'assert-attr': '断言属性：%el% 的 %name% 等于「%value%」',
  'assert-title': '断言页面标题等于「%title%」',
  'assert-enabled': '断言可用：%el%',
  'assert-disabled': '断言禁用：%el%',
  'assert-url': '断言地址匹配 %url%',
  'assert-value': '断言输入值：%el% 等于「%value%」',

  /* 鼠标 */
  click: '点击 %el%',
  dblclick: '双击 %el%',
  hover: '悬停在 %el%',
  check: '勾选 %el%',

  /* 键盘 */
  fill: '在 %el% 输入「%text%」',
  press: '按键 %key%',

  /* 表单 */
  'select-option': '下拉选择 %el% = 「%value%」',
  upload: '给 %el% 选文件 %path%',
  'clear-input': '清空输入框 %el%',
  uncheck: '取消勾选 %el%',

  /* 等待 */
  'wait-visible': '等到 %el% 可见',
  'wait-hidden': '等到 %el% 消失',
  'wait-url': '等待地址变成 %url%',
  'wait-timeout': '固定等待：%ms% ms',

  /* 工具 */
  reload: '刷新页面',
  'refresh-interval': '定时刷新：每 %ms% ms 一次，共 %count% 次',
  screenshot: '截图存到 %path%',
  pause: '调试暂停（会打开 Inspector）',
  'scroll-to': '滚动到 %el%',
  'clear-cookies': '清空 Cookie',
  'close-context': '退出并清空浏览器（清 Cookie + 关上下文）'
};

/**
 * 把一步的「人话摘要」算出来（给代码注释用）。
 *
 * 参数缺了就留空（生成器那边已经报过 warning，这里不重复喊）；
 * 没配模板的动作（以后新加的）退回 action.name，不会出现空注释。
 */
function summaryOf(action, params) {
  if (!action) return '';
  const p = params || {};
  const tpl = String(action.summary || '');
  if (!tpl) return String(action.name || '');
  let text = tpl;
  for (const def of action.params || []) {
    const raw = p[def.key];
    const missing = raw === undefined || raw === null || String(raw).trim() === '';
    const val = missing ? (def.default === undefined ? '' : def.default) : raw;
    text = text.split('%' + def.key + '%').join(String(val));
  }
  return text;
}

/**
 * 毫秒 → 「X 秒」的灰字提示文案（v0.61）。
 *
 * 用户点「固定等待」，输入框里写 3000 得自己脑补「这是 3 秒」；
 * 输入框右边显示 `= 3 秒` 就不用算了。不是毫秒类参数就返回空串（调用方据此不渲染）。
 */
function msHint(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return '';
  const sec = n / 1000;
  // 3 → "3 秒"，2.5 → "2.5 秒"，0.25 → "0.25 秒"；最多两位小数，去掉末尾 0
  const text = String(Math.round(sec * 100) / 100);
  return '= ' + text + ' 秒';
}

// 把模板挂到动作对象上（动作库保持「纯数据」，摘要不单独维护一份 id 表）
for (const a of UI_ACTIONS) {
  if (UI_SUMMARY_TEMPLATES[a.id]) a.summary = UI_SUMMARY_TEMPLATES[a.id];
}

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
  UI_SUMMARY_TEMPLATES,
  summaryOf,
  msHint,
  actionById,
  actionsByCategory
};