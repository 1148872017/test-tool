'use strict';
/**
 * 积木式动作拼装：动作库 + 步骤生成器 + 前端积木区。
 *
 * 这个套件不只做「源码里有没有这个词」的守卫：
 *   1. 动作库是纯数据，逐条校验模板占位符和参数定义对得上（能抓 `%text%` 写成 `%txt%` 的拼写错误）；
 *   2. 生成器**真跑**：把同一组步骤分别按 none / generated / existing 生成 Java / Python，
 *      逐字比对产物，并验证定位器确实复用了 shared/locatorModes.js（不是又写了一套）；
 *   3. 前端用 esbuild 把 TSX 转成 CJS + 一个极小的 hooks 运行时**真渲染**：
 *      切生成目标 → 积木区只在该目标下出现 → 点积木 → 填参数 → 加步骤 → 结果 textarea 出代码。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const CODEGEN = path.join(ROOT, 'src', 'pages', 'CodegenPage.tsx');
const BRICKS = path.join(ROOT, 'src', 'components', 'ui-bricks', 'BricksPanel.tsx');

const {
  UI_ACTIONS,
  UI_ACTION_CATEGORIES,
  UI_PARAM_TYPES,
  actionById,
  actionsByCategory
} = require('../shared/uiActions.js');
const gen = require('../shared/uiStepGen.js');

/* ============================================================
 * 一、动作库
 * ============================================================ */

check('动作库至少 13 个动作', UI_ACTIONS.length >= 13, UI_ACTIONS.length);
check(
  '每个动作都有 id/category/name/params/java/python',
  UI_ACTIONS.every(
    (a) =>
      a &&
      typeof a.id === 'string' &&
      a.id &&
      typeof a.category === 'string' &&
      typeof a.name === 'string' &&
      Array.isArray(a.params) &&
      typeof a.java === 'string' &&
      typeof a.python === 'string'
  ),
  UI_ACTIONS.filter((a) => !(a.id && a.category && a.name && a.params && a.java && a.python)).map((a) => a.id)
);
check(
  '动作 id 唯一',
  new Set(UI_ACTIONS.map((a) => a.id)).size === UI_ACTIONS.length,
  UI_ACTIONS.map((a) => a.id)
);
check(
  '每个动作的分类都在 UI_ACTION_CATEGORIES 里',
  UI_ACTIONS.every((a) => UI_ACTION_CATEGORIES.some((c) => c.key === a.category)),
  UI_ACTIONS.filter((a) => !UI_ACTION_CATEGORIES.some((c) => c.key === a.category)).map((a) => a.id)
);
check(
  // v0.59 顺序：导航打头（流程得先开页面），工具垫尾（它们是补充手法，不是业务动作）
  '分类顺序是 导航/断言/鼠标/键盘/表单/等待/工具',
  UI_ACTION_CATEGORIES.map((c) => c.key).join(',') === 'nav,assert,mouse,keyboard,form,wait,tool',
  UI_ACTION_CATEGORIES.map((c) => c.key)
);
check(
  '每个分类至少有一个动作',
  UI_ACTION_CATEGORIES.every((c) => UI_ACTIONS.some((a) => a.category === c.key)),
  UI_ACTION_CATEGORIES.map((c) => c.key)
);
check(
  '参数 type 只能是 element/text/number/boolean/select',
  UI_ACTIONS.every((a) => (a.params || []).every((p) => UI_PARAM_TYPES.indexOf(p.type) >= 0)),
  UI_ACTIONS.flatMap((a) =>
    (a.params || []).filter((p) => UI_PARAM_TYPES.indexOf(p.type) < 0).map((p) => a.id + '.' + p.key + ':' + p.type)
  )
);
check(
  '两门语言模板风格不同（Java 语句带分号或块尾 }，Python 不带分号）',
  UI_ACTIONS.every(
    (a) => /[;}]\s*$/.test(a.java.trim()) && !a.python.trim().endsWith(';')
  ),
  UI_ACTIONS.filter((a) => !/[;}]\s*$/.test(a.java.trim()) || a.python.trim().endsWith(';')).map((a) => a.id)
);

/** 逐条动作校验模板里的 %key% 都在 params 里定义过（拼写错误在这里现形） */
for (const a of UI_ACTIONS) {
  const defined = new Set((a.params || []).map((p) => p.key));
  const used = [];
  const src = String(a.java) + ' ' + String(a.python);
  const re = /%([A-Za-z0-9_]+)%/g;
  let m;
  while ((m = re.exec(src))) used.push(m[1]);
  const missing = used.filter((k) => !defined.has(k));
  check(`模板占位符都有参数定义：${a.name}`, missing.length === 0, missing);
}

check(
  '有参数的动作要真用上参数；无参数动作（刷新 / 暂停 / 清 cookie）不许留占位符',
  UI_ACTIONS.every((a) => {
    const hasParams = (a.params || []).length > 0;
    const hasPh = /%[A-Za-z0-9_]+%/.test(a.java) || /%[A-Za-z0-9_]+%/.test(a.python);
    return hasParams === hasPh;
  }),
  UI_ACTIONS.filter((a) => {
    const hasParams = (a.params || []).length > 0;
    const hasPh = /%[A-Za-z0-9_]+%/.test(a.java) || /%[A-Za-z0-9_]+%/.test(a.python);
    return hasParams !== hasPh;
  }).map((a) => a.id)
);

/**
 * v0.59：多行模板（循环 / 连续两句）必须逐行缩进 ——
 * 只缩第一行的话，后面的语句会掉到方法体外面，生成出来的代码根本跑不了。
 */
{
  const r = gen.generateSteps({
    steps: [
      { actionId: 'goto', params: { url: '/login' } },
      { actionId: 'refresh-interval', params: { count: 3, ms: 2000 } },
      { actionId: 'close-context', params: {} }
    ],
    lang: 'java',
    pomMode: 'none',
    pageName: '登录页'
  });
  const bodyLines = r.code.split('\n').filter((l) => l.trim());
  check(
    '多行积木在 Java 里逐行缩进（循环体 / 连续语句都在方法内）',
    bodyLines.some((l) => l === '    for (int i = 0; i < 3; i++) {') &&
      bodyLines.some((l) => l === '        page.reload();') &&
      bodyLines.some((l) => l === '    context.close();') &&
      bodyLines[bodyLines.length - 1] === '}',
    r.code
  );

  const p = gen.generateSteps({
    steps: [
      { actionId: 'goto', params: { url: '/login' } },
      { actionId: 'refresh-interval', params: { count: 2, ms: 500 } },
      { actionId: 'close-context', params: {} }
    ],
    lang: 'python',
    pomMode: 'none',
    pageName: '登录页'
  });
  const pyLines = p.code.split('\n');
  check(
    '多行积木在 Python 里逐行缩进（for 体内 8 空格，语句 4 空格）',
    pyLines.indexOf('    for _ in range(2):') >= 0 &&
      pyLines.indexOf('        self.page.reload()') >= 0 &&
      pyLines.indexOf('    self.context.close()') >= 0,
    p.code
  );
}

check(
  'v0.59 新增的分类都在（表单 / 工具）',
  UI_ACTION_CATEGORIES.some((c) => c.key === 'form') && UI_ACTION_CATEGORIES.some((c) => c.key === 'tool'),
  UI_ACTION_CATEGORIES.map((c) => c.key)
);
check(
  'v0.59 的工具类积木齐了（刷新 / 定时刷新 / 截图 / 调试暂停 / 滚动 / 清 cookie / 退出并清空）',
  ['reload', 'refresh-interval', 'screenshot', 'pause', 'scroll-to', 'clear-cookies', 'close-context'].every(
    (id) => actionById(id)
  ),
  ['reload', 'refresh-interval', 'screenshot', 'pause', 'scroll-to', 'clear-cookies', 'close-context'].filter(
    (id) => !actionById(id)
  )
);
check('actionById 能按 id 取到动作', actionById('click') && actionById('click').name === '点击', actionById('click'));
check('actionById 对未知 id 返回 null', actionById('not-exist') === null, actionById('not-exist'));
check(
  'actionsByCategory 覆盖全部动作且没有空分组',
  actionsByCategory().reduce((n, g) => n + g.actions.length, 0) === UI_ACTIONS.length &&
    actionsByCategory().every((g) => g.actions.length > 0),
  actionsByCategory().map((g) => g.key + ':' + g.actions.length)
);

/* ============================================================
 * 二、生成器：none 模式复用 locatorModes
 * ============================================================ */

const LOGIN_STEPS = [
  { actionId: 'goto', params: { url: '/login' } },
  { actionId: 'fill', params: { el: 'usernameInput', text: 'admin' }, elementMode: 'css', elementSelector: '#username' },
  { actionId: 'fill', params: { el: 'passwordInput', text: '123' }, elementMode: 'css', elementSelector: '#password' },
  {
    actionId: 'click',
    params: { el: 'submitBtn' },
    elementMode: 'css',
    elementSelector: 'button[type=submit]'
  },
  { actionId: 'assert-visible', params: { el: 'errorTip' }, elementMode: 'css', elementSelector: '.error-tip' }
];

const javaNone = gen.generateSteps({ steps: LOGIN_STEPS, lang: 'java', pomMode: 'none', pageName: 'login' });

const EXPECT_JAVA_NONE = [
  '@Test',
  'public void testLogin() {',
  '    page.navigate("/login");',
  '    page.locator("#username").fill("admin");',
  '    page.locator("#password").fill("123");',
  '    page.locator("button[type=submit]").click();',
  '    assertThat(page.locator(".error-tip")).isVisible();',
  '}'
].join('\n');

check('pomMode=none + css 元素 → 完整 Java 方法体逐字正确', javaNone.code === EXPECT_JAVA_NONE, javaNone.code);
check(
  'none 模式的定位器来自 locatorModes（page.locator("#username")）',
  javaNone.code.includes('page.locator("#username").fill("admin");'),
  javaNone.code
);
check('none 模式没有凭空造出 POM 变量', !/loginPage\./.test(javaNone.code), javaNone.code);

const roleJava = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/login' } },
    { actionId: 'click', params: { el: 'loginBtn' }, elementMode: 'role', elementSelector: 'button:登录' }
  ]
});
check(
  'none + role 元素 → page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"))',
  roleJava.code.includes(
    'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录")).click();'
  ),
  roleJava.code
);
check('用了 role 定位就补 AriaRole import', roleJava.imports.includes('com.microsoft.playwright.options.AriaRole'), roleJava.imports);

const rolePython = gen.generateSteps({
  lang: 'python',
  pomMode: 'none',
  steps: [{ actionId: 'click', params: { el: 'loginBtn' }, elementMode: 'role', elementSelector: 'button:登录' }]
});
check(
  'Python 的 role 定位是 get_by_role（下划线风格）',
  rolePython.code.includes('self.page.get_by_role("button", name="登录").click()'),
  rolePython.code
);

/* ============================================================
 * 三、生成器：POM 模式
 * ============================================================ */

const javaGen = gen.generateSteps({
  steps: LOGIN_STEPS,
  lang: 'java',
  pomMode: 'generated',
  pageName: 'login'
});
check(
  'generated → LoginPage loginPage = new LoginPage(page);',
  javaGen.code.includes('LoginPage loginPage = new LoginPage(page);'),
  javaGen.code
);
check(
  'generated → 元素换成 loginPage.usernameInput()',
  javaGen.code.includes('loginPage.usernameInput().fill("admin");'),
  javaGen.code
);
check('generated → 不再出现 page.locator("#username")', !javaGen.code.includes('page.locator("#username")'), javaGen.code);

/* v0.48.0 回归：UI 顶部「类名」输入框在 generated 模式下必须生效。
   初版这里无条件从页面名推，导致用户改了类名不生效（被这组断言抓出来）。 */
{
  const explicit = gen.generateSteps({
    steps: [{ actionId: 'click', params: { el: 'submitBtn' }, elementName: 'submitBtn' }],
    lang: 'java',
    pomMode: 'generated',
    pomClass: 'CustomPage',
    pomVar: 'custom'
  });
  check(
    'generated + 显式类名 → 用用户填的类名（不能覆盖成 MyPage）',
    explicit.code.includes('CustomPage custom = new CustomPage(page);'),
    explicit.code
  );
  check(
    'generated + 显式类名 → 不再出现 MyPage 兜底',
    !explicit.code.includes('MyPage'),
    explicit.code
  );
  const derived = gen.generateSteps({
    steps: [{ actionId: 'click', params: { el: 'submitBtn' }, elementName: 'submitBtn' }],
    lang: 'java',
    pomMode: 'generated',
    pageName: '登录页',
    pageUrl: '/login'
  });
  check(
    'generated + 不传类名 → 仍能从页面推（LoginPage）',
    derived.code.includes('LoginPage loginPage = new LoginPage(page);'),
    derived.code
  );
}
check(
  'generated → 断言也走 POM 方法（loginPage.errorTip()）',
  javaGen.code.includes('assertThat(loginPage.errorTip()).isVisible();'),
  javaGen.code
);

const javaExisting = gen.generateSteps({
  steps: LOGIN_STEPS,
  lang: 'java',
  pomMode: 'existing',
  pomClass: 'MyLoginPage'
});
check(
  'existing + 自定义类名 → MyLoginPage myLoginPage = new MyLoginPage(page);',
  javaExisting.code.includes('MyLoginPage myLoginPage = new MyLoginPage(page);'),
  javaExisting.code
);
check(
  'existing → 元素方法用用户填的类实例',
  javaExisting.code.includes('myLoginPage.usernameInput().fill("admin");'),
  javaExisting.code
);

const javaExistingVar = gen.generateSteps({
  steps: [LOGIN_STEPS[0], { actionId: 'click', params: { el: 'submitBtn' } }],
  lang: 'java',
  pomMode: 'existing',
  pomClass: 'MyLoginPage',
  pomVar: 'page2'
});
check(
  'existing 支持显式指定变量名',
  javaExistingVar.code.includes('MyLoginPage page2 = new MyLoginPage(page);') &&
    javaExistingVar.code.includes('page2.submitBtn().click();'),
  javaExistingVar.code
);

const pyGen = gen.generateSteps({
  steps: LOGIN_STEPS,
  lang: 'python',
  pomMode: 'generated',
  pageName: 'login'
});
check(
  'Python POM → login_page = LoginPage(self.page)',
  pyGen.code.includes('login_page = LoginPage(self.page)'),
  pyGen.code
);
check(
  'Python POM 方法名用下划线（usernameInput → username_input）',
  pyGen.code.includes('login_page.username_input().fill("admin")'),
  pyGen.code
);
check(
  'Python POM 的 errorTip → error_tip',
  pyGen.code.includes('expect(login_page.error_tip()).to_be_visible()'),
  pyGen.code
);
check('Python 方法定义是 def test_login(self):', pyGen.code.startsWith('def test_login(self):'), pyGen.code);

check(
  'POM 类名从页面名推（login → LoginPage）',
  gen.pomClassNameFromPage('login', '/login') === 'LoginPage',
  gen.pomClassNameFromPage('login', '/login')
);
check(
  'POM 类名遇中文页面名顺延到 URL（登录页 + /login → LoginPage）',
  gen.pomClassNameFromPage('登录页', '/login') === 'LoginPage',
  gen.pomClassNameFromPage('登录页', '/login')
);
check(
  '方法名可由类名推（LoginFlowTest → testLoginFlow / test_login_flow）',
  gen.testMethodName({ className: 'LoginFlowTest' }, 'java') === 'testLoginFlow' &&
    gen.testMethodName({ className: 'LoginFlowTest' }, 'python') === 'test_login_flow',
  [gen.testMethodName({ className: 'LoginFlowTest' }, 'java'), gen.testMethodName({ className: 'LoginFlowTest' }, 'python')]
);
check(
  '类名输入框优先于页面名（和 POM 类文件取名一致：MyLogin → MyLoginPage）',
  gen.pomClassNameFromPage('login', '/login', 'MyLogin') === 'MyLoginPage',
  gen.pomClassNameFromPage('login', '/login', 'MyLogin')
);
const javaClassOverride = gen.generateSteps({
  steps: [LOGIN_STEPS[0], { actionId: 'click', params: { el: 'submitBtn' } }],
  lang: 'java',
  pomMode: 'generated',
  pageName: 'login',
  pageUrl: '/login',
  className: 'MyLogin'
});
check(
  'generated + 类名输入框 → 用同一个类名（不会文件叫 MyLoginPage、代码写 LoginPage）',
  javaClassOverride.code.includes('MyLoginPage myLoginPage = new MyLoginPage(page);') &&
    javaClassOverride.code.includes('myLoginPage.submitBtn().click();'),
  javaClassOverride.code
);

/* ============================================================
 * 四、生成器：import / 转义 / 边界
 * ============================================================ */

check(
  'imports 去重且排序',
  javaNone.imports.join('|') === javaNone.imports.slice().sort().join('|') &&
    new Set(javaNone.imports).size === javaNone.imports.length,
  javaNone.imports
);
check(
  '有 assert 才有 assertThat（按需）',
  javaNone.imports.includes('static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat'),
  javaNone.imports
);
const noAssert = gen.generateSteps({
  steps: [{ actionId: 'goto', params: { url: '/' } }],
  lang: 'java',
  pomMode: 'none'
});
check(
  '没有断言就不 import assertThat',
  !noAssert.imports.some((i) => i.indexOf('assertThat') >= 0),
  noAssert.imports
);
const pressSteps = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/' } },
    { actionId: 'press', params: { key: 'Enter' } }
  ]
});
check(
  'press 动作带 Keyboard import',
  pressSteps.imports.includes('com.microsoft.playwright.Keyboard'),
  pressSteps.imports
);
const waitSteps = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/' } },
    { actionId: 'wait-visible', params: { el: 'tip' }, elementMode: 'css', elementSelector: '.tip' }
  ]
});
check(
  'wait-visible 带 WaitForSelectorState / Locator import',
  waitSteps.imports.includes('com.microsoft.playwright.options.WaitForSelectorState') &&
    waitSteps.imports.includes('com.microsoft.playwright.Locator'),
  waitSteps.imports
);
check(
  'wait-visible 的 Java 代码真的用了 WaitForSelectorState',
  waitSteps.code.includes('new Locator.WaitForOptions().setState(WaitForSelectorState.VISIBLE)'),
  waitSteps.code
);
const pyAssert = gen.generateSteps({
  lang: 'python',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/' } },
    { actionId: 'assert-visible', params: { el: 'tip' }, elementMode: 'css', elementSelector: '.tip' }
  ]
});
check(
  'Python 断言 import expect',
  pyAssert.imports.includes('from playwright.sync_api import expect'),
  pyAssert.imports
);

/* ---- 转义 ---- */
const tricky = 'a"b\\c\nd';
const escaped = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/login' } },
    { actionId: 'fill', params: { el: 'q' }, elementMode: 'css', elementSelector: '#q' }
  ]
});
check('无特殊字符时生成正常（对照组）', escaped.code.includes('page.locator("#q")'), escaped.code);

const quoteSteps = [
  { actionId: 'goto', params: { url: '/login' } },
  {
    actionId: 'fill',
    params: { el: 'name', text: tricky },
    elementMode: 'css',
    elementSelector: '#name'
  }
];
const quoted = gen.generateSteps({ lang: 'java', pomMode: 'none', steps: quoteSteps });
check(
  'Java 引号 / 反斜杠 / 换行被正确转义',
  quoted.code.includes('page.locator("#name").fill("a\\"b\\\\c\\nd");'),
  quoted.code
);
const quotedPy = gen.generateSteps({ lang: 'python', pomMode: 'none', steps: quoteSteps });
check(
  'Python 同样转义（不能把字符串写断行）',
  quotedPy.code.includes('self.page.locator("#name").fill("a\\"b\\\\c\\nd")'),
  quotedPy.code
);

/* ---- 边界 ---- */
const empty = gen.generateSteps({ steps: [], lang: 'java', pomMode: 'none' });
check('空步骤 → 空代码', empty.code === '', empty.code);
check('空步骤 → 有提示', empty.warnings.some((w) => w.indexOf('还没有选任何步骤') >= 0), empty.warnings);

const noGoto = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [{ actionId: 'click', params: { el: 'btn' }, elementMode: 'css', elementSelector: '#b' }]
});
check(
  '没有 goto → 提示先导航',
  noGoto.warnings.some((w) => w.indexOf('打开地址') >= 0),
  noGoto.warnings
);
const gotoLate = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'click', params: { el: 'btn' }, elementMode: 'css', elementSelector: '#b' },
    { actionId: 'goto', params: { url: '/' } }
  ]
});
check(
  'goto 不在第一步 → 单独提示',
  gotoLate.warnings.some((w) => w.indexOf('不在第一步') >= 0),
  gotoLate.warnings
);
const unknownAction = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [{ actionId: 'goto', params: { url: '/' } }, { actionId: 'no-such', params: {} }]
});
check(
  '未知动作被跳过并提示',
  unknownAction.warnings.some((w) => w.indexOf('不认识的动作') >= 0) && unknownAction.code.indexOf('no-such') < 0,
  unknownAction.warnings
);
const missingParam = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [{ actionId: 'goto', params: {} }]
});
check(
  '必填参数缺失 → 提示（代码仍是合法语句）',
  missingParam.warnings.some((w) => w.indexOf('缺少') >= 0) && missingParam.code.includes('page.navigate("");'),
  [missingParam.warnings, missingParam.code]
);
const badPom = gen.generateSteps({
  lang: 'java',
  pomMode: 'whatever',
  steps: [{ actionId: 'goto', params: { url: '/' } }]
});
check(
  '非法 POM 模式 → 归一成 none 并提示',
  badPom.warnings.some((w) => w.indexOf('POM 模式') >= 0) && badPom.code.indexOf('= new') < 0,
  badPom.warnings
);
const badName = gen.generateSteps({
  lang: 'java',
  pomMode: 'generated',
  pageName: 'login',
  steps: [{ actionId: 'click', params: { el: '提交按钮' } }]
});
check(
  'POM 模式下元素名不是合法标识符 → 提示',
  badName.warnings.some((w) => w.indexOf('不是合法标识符') >= 0),
  badName.warnings
);
const noSelector = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/' } },
    { actionId: 'click', params: { el: 'btn' } }
  ]
});
check(
  'none 模式元素没有定位值 → 提示并兜底成合法表达式',
  noSelector.warnings.some((w) => w.indexOf('没有定位方式') >= 0) && noSelector.code.includes('page.locator("TODO").click();'),
  [noSelector.warnings, noSelector.code]
);
check(
  '生成器不会把未替换的 %key% 留在代码里',
  UI_ACTIONS.every((a) => {
    const r = gen.generateSteps({
      lang: 'java',
      pomMode: 'none',
      steps: [{ actionId: a.id, params: {} }]
    });
    return !/%[A-Za-z0-9_]+%/.test(r.code);
  }),
  'has leftover placeholder'
);

/* ---- 细节 ---- */
const countSteps = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/' } },
    { actionId: 'assert-count', params: { el: 'row' }, elementMode: 'css', elementSelector: '.row' }
  ]
});
check('number 参数默认值 1 生效（hasCount(1)）', countSteps.code.includes('assertThat(page.locator(".row")).hasCount(1);'), countSteps.code);
const countThree = gen.generateSteps({
  lang: 'java',
  pomMode: 'none',
  steps: [
    { actionId: 'goto', params: { url: '/' } },
    { actionId: 'assert-count', params: { el: 'row', count: 3 }, elementMode: 'css', elementSelector: '.row' }
  ]
});
check('number 参数按用户填的 3 生效', countThree.code.includes('hasCount(3);'), countThree.code);
check('Java 方法体行首缩进 4 空格', javaNone.code.split('\n').slice(2, -1).every((l) => l.indexOf('    ') === 0), javaNone.code);
check('Java 代码从 @Test 开始、以 } 收尾', javaNone.code.startsWith('@Test') && javaNone.code.endsWith('}'), javaNone.code);
check('Python 代码不以 } 收尾', !pyGen.code.trimEnd().endsWith('}'), pyGen.code.split('\n').slice(-1)[0]);
check(
  '同一动作重复出现会生成两行（不合并）',
  (javaNone.code.match(/page\.locator\("#username"\)/g) || []).length === 1 &&
    gen.generateSteps({ lang: 'java', pomMode: 'none', steps: [LOGIN_STEPS[1], LOGIN_STEPS[1]] }).code.split('\n')
      .filter((l) => l.indexOf('fill("admin")') >= 0).length === 2,
  'dedupe!'
);
const warnOnce = gen.generateSteps({
  lang: 'java',
  pomMode: 'generated',
  pageName: 'login',
  steps: [
    { actionId: 'click', params: { el: '提交' } },
    { actionId: 'click', params: { el: '提交' } }
  ]
});
check(
  '同一问题只警告一次（不刷屏）',
  warnOnce.warnings.filter((w) => w.indexOf('不是合法标识符') >= 0).length === 1,
  warnOnce.warnings
);

/* ============================================================
 * 五、前端：三栏积木区（真渲染）
 * ============================================================ */

const jsx = (type, props, key) => ({ type, props: props || {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };

function makeComp(name) {
  const C = (props) => ({ __comp: name, props: props || {} });
  C.__name = name;
  return C;
}
function makeProxy() {
  const cache = new Map();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (!cache.has(prop)) cache.set(prop, makeComp(prop));
        return cache.get(prop);
      }
    }
  );
}

/** 迷你 hooks 运行时（和 scripts/test-elements.cjs 同一套路，不需要 React / DOM） */
function createRuntime() {
  const slots = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let dirty = false;
  const toasts = [];

  function depsChanged(prev, deps) {
    if (!prev || !('deps' in prev)) return true;
    if (!deps || !prev.deps) return true;
    if (prev.deps.length !== deps.length) return true;
    for (let i = 0; i < deps.length; i++) {
      if (!Object.is(prev.deps[i], deps[i])) return true;
    }
    return false;
  }

  const hooks = {
    useState(init) {
      const i = hookIndex++;
      if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? init() : init };
      const slot = slots[i];
      if (!slot.set) {
        slot.set = (next) => {
          const v = typeof next === 'function' ? next(slot.value) : next;
          if (Object.is(v, slot.value)) return;
          slot.value = v;
          dirty = true;
        };
      }
      return [slot.value, slot.set];
    },
    useRef(init) {
      const i = hookIndex++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useEffect(fn, deps) {
      const i = hookIndex++;
      pendingEffects.push({ i, fn, deps });
    },
    useMemo(fn, deps) {
      const i = hookIndex++;
      const prev = slots[i];
      if (prev && !depsChanged(prev, deps)) return prev.value;
      const value = fn();
      slots[i] = { deps, value };
      return value;
    }
  };
  hooks.default = hooks;
  hooks.__esModule = true;

  /** 渲染循环（含 setState 触发的重渲染），返回最终虚拟树 */
  function render(component, props) {
    let tree;
    let guard = 0;
    for (;;) {
      dirty = false;
      hookIndex = 0;
      pendingEffects = [];
      tree = component(props);
      for (const e of pendingEffects) {
        const prev = slots[e.i];
        if (!depsChanged(prev, e.deps)) continue;
        if (prev && typeof prev.cleanup === 'function') prev.cleanup();
        const cleanup = e.fn();
        slots[e.i] = { deps: e.deps, cleanup };
      }
      guard += 1;
      if (!dirty || guard > 40) break;
    }
    return tree;
  }

  const antd = makeProxy();
  const icons = makeProxy();
  const moduleCache = new Map();

  /** 载入 TSX/TS 模块：本地相对模块递归加载，shared/*.js 直接用 Node require */
  function load(file, overrides) {
    const abs = path.resolve(file);
    if (moduleCache.has(abs)) return moduleCache.get(abs);
    const src = fs.readFileSync(abs, 'utf8');
    const { code } = esbuild.transformSync(src, {
      loader: /\.tsx$/.test(abs) ? 'tsx' : 'ts',
      format: 'cjs',
      jsx: 'automatic',
      target: 'node18',
      charset: 'utf8',
      sourcefile: abs
    });
    const mod = { exports: {} };
    moduleCache.set(abs, mod.exports);
    const requireStub = (id) => {
      if (overrides && overrides[id]) return overrides[id]();
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === 'antd') return antd;
      if (id === '@ant-design/icons') return icons;
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(abs), id);
        const hit =
          ['.tsx', '.ts', '.js', '.json']
            .map((ext) => base + ext)
            .filter((p) => fs.existsSync(p))[0] ||
          (fs.existsSync(base) ? base : null);
        if (!hit) throw new Error('测试找不到模块：' + id + '（来自 ' + abs + '）');
        const rel = path.relative(ROOT, hit).replace(/\\/g, '/');
        if (rel.indexOf('shared/') === 0) return require(hit);
        return load(hit);
      }
      throw new Error('测试没有为这个依赖准备桩：' + id);
    };
    new Function('require', 'module', 'exports', code)(requireStub, mod, mod.exports);
    moduleCache.set(abs, mod.exports);
    return mod.exports;
  }

  return { render, load, antd, icons, toasts, hooks };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function collect(node, out) {
  const acc = out || [];
  if (node === null || node === undefined || typeof node === 'boolean') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  acc.push(node);
  if (node.props) collect(node.props.children, acc);
  return acc;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
}

const hasText = (tree, s) => collect(tree).some((n) => textOf(n).indexOf(s) >= 0);
const nodesOf = (tree, type) => collect(tree).filter((n) => n.type === type);

/* ---------- 5.1 CodegenPage：积木区只在 Playwright POM 目标下出现 ---------- */
(async () => {
  const rt = createRuntime();
  const pageEditorStub = {
    parseElements: () => [],
    LOCATOR_MODE_OPTIONS: [],
    LOCATOR_MODE_PLACEHOLDER: {},
    normalizeMode: (m) => (m ? m : 'css'),
    looksLikeXPath: () => false
  };
  const apiStub = {
    codegenTargets: async () => ({ targets: require('../shared/codegen.js').listTargets() }),
    records: async () => [],
    copy: async () => true
  };

  const pageMod = rt.load(CODEGEN, {
    '../api': () => ({ __esModule: true, default: apiStub }),
    '../msg': () => ({ __esModule: true, toast: (m) => rt.toasts.push(m) }),
    '../components/PageElementsEditor': () => pageEditorStub
  });
  const bricksMod = rt.load(BRICKS);
  const BricksPanel = bricksMod.default;

  const srcOfPage = fs.readFileSync(CODEGEN, 'utf8');
  check('CodegenPage 里有积木区（引用 ui-bricks/BricksPanel）', /ui-bricks\/BricksPanel/.test(srcOfPage), 'no bricks import');
  check(
    'CodegenPage 用生成目标做闸门（只认 playwright- 开头的页面目标）',
    /kind === 'page' && String\(targetKey\)\.indexOf\('playwright-'\) === 0/.test(srcOfPage),
    'no gate'
  );

  // 初始状态：java-restassured（接口目标）→ 不该有积木区
  let tree = rt.render(pageMod.default, {});
  check('接口目标下不渲染积木区', collect(tree).every((n) => n.type !== BricksPanel), 'bricks leaked');

  // 等初始化 effect 把生成目标拉回来
  await tick();
  await tick();
  tree = rt.render(pageMod.default, {});

  const targetSelect = collect(tree).find(
    (n) => n.props && Array.isArray(n.props.options) && n.props.options.every((o) => o && Array.isArray(o.options))
  );
  check('生成目标下拉按语言分组（3 + 3）', targetSelect && targetSelect.props.options.length === 2, targetSelect && targetSelect.props.options && targetSelect.props.options.length);

  // 切到 Playwright Java
  targetSelect.props.onChange('playwright-java');
  tree = rt.render(pageMod.default, {});
  const bricksNode = collect(tree).find((n) => n.type === BricksPanel);
  check('Playwright POM 目标下渲染积木区', !!bricksNode, 'no bricks panel');
  check(
    '积木区拿到的是页面元素与语言（props 正确透传）',
    !!bricksNode && Array.isArray(bricksNode.props.pages) && bricksNode.props.lang === 'java',
    bricksNode && { lang: bricksNode.props.lang, pages: bricksNode.props.pages.length }
  );
  check(
    'Playwright 目标下有「动作拼装 / 页面对象类」视图切换',
    collect(tree).some(
      (n) =>
        n.type === rt.antd.Segmented &&
        Array.isArray(n.props.options) &&
        n.props.options.some((o) => o.label === '动作拼装（积木）') &&
        n.props.options.some((o) => o.label === '页面对象类')
    ),
    'no view switch'
  );

  const viewSwitch = collect(tree).find((n) => n.type === rt.antd.Segmented && n.props.value === 'bricks');
  check('视图切换默认停在动作拼装', !!viewSwitch, 'no segmented');
  if (viewSwitch) viewSwitch.props.onChange('pom');
  tree = rt.render(pageMod.default, {});
  check(
    '切到「页面对象类」后积木区让位给原来的两栏',
    collect(tree).every((n) => n.type !== BricksPanel) &&
      collect(tree).some((n) => n.props && n.props.className === 'codegen-body'),
    'still bricks'
  );

  // 切回接口目标 → 积木区彻底隐藏
  collect(rt.render(pageMod.default, {})).find(
    (n) => n.props && Array.isArray(n.props.options) && n.props.options.every((o) => o && Array.isArray(o.options))
  );
  const targetSelect2 = collect(rt.render(pageMod.default, {})).find(
    (n) => n.props && Array.isArray(n.props.options) && n.props.options.every((o) => o && Array.isArray(o.options))
  );
  targetSelect2.props.onChange('java-restassured');
  tree = rt.render(pageMod.default, {});
  check('切回接口目标后积木区不再出现', collect(tree).every((n) => n.type !== BricksPanel), 'bricks leaked back');

  /* ---------- 5.2 BricksPanel：三栏 + 交互 ---------- */
  const rt2 = createRuntime();
  const bp = rt2.load(BRICKS).default;
  const PAGES = [
    { id: 'p1', data: { name: '登录页', url: '/login' } },
    { id: 'p2', data: { name: '首页', url: '/home' } }
  ];
  const ELEMENTS = [
    { name: 'usernameInput', mode: 'css', selector: '#username', desc: '用户名' },
    { name: 'submitBtn', mode: 'role', selector: 'button:登录', desc: '登录按钮' }
  ];
  const props = {
    pages: PAGES,
    pageId: 'p1',
    onSelectPage: () => {},
    pageName: '登录页',
    pageUrl: '/login',
    elements: ELEMENTS,
    lang: 'java',
    onCopy: (t) => (props.copied = t)
  };

  let panel = rt2.render(bp, props);
  check('三栏齐了（积木库 / 已选步骤 / 生成结果）', hasText(panel, '积木库') && hasText(panel, '已选步骤') && hasText(panel, '生成结果'), 'missing column');

  const pageSelect = collect(panel).find(
    (n) => n.type === rt2.antd.Select && n.props.options && n.props.options.some((o) => String(o.label).indexOf('登录页') >= 0)
  );
  check('页面下拉从 pages 集合读（2 个页面）', !!pageSelect && pageSelect.props.options.length === 2, pageSelect && pageSelect.props.options);
  check('页面下拉 placeholder 提示选页面', !!pageSelect && /选一个页面/.test(pageSelect.props.placeholder), pageSelect && pageSelect.props.placeholder);

  const resultArea = collect(panel).find((n) => n.type === 'textarea');
  check('生成结果是可编辑 textarea', !!resultArea && typeof resultArea.props.onChange === 'function', resultArea && resultArea.type);
  check('空步骤时结果区提示先加一步', hasText(panel, '还没有选任何步骤'), 'no empty hint');

  const pomRadio = collect(panel).find((n) => n.type === rt2.antd.Radio.Group);
  check(
    'POM 三种模式的选择控件（none / generated / existing）',
    !!pomRadio && pomRadio.props.options.map((o) => o.value).join(',') === 'none,generated,existing',
    pomRadio && pomRadio.props.options
  );

  const brickButtons = nodesOf(panel, rt2.antd.Button).filter(
    (n) => n.props.icon && n.props.icon.type === rt2.icons.PlusOutlined
  );
  check('积木库里每个动作一个按钮', brickButtons.length === UI_ACTIONS.length, [brickButtons.length, UI_ACTIONS.length]);
  check('积木库按分类分组显示', hasText(panel, '导航') && hasText(panel, '断言') && hasText(panel, '鼠标') && hasText(panel, '键盘') && hasText(panel, '等待'), 'no categories');

  /* ---- 点「打开地址」→ 填 URL → 加一步 ---- */
  const openBrick = nodesOf(panel, rt2.antd.Button).find((n) => textOf(n) === '打开地址');
  check('点得到「打开地址」积木', !!openBrick, 'no goto brick');
  openBrick.props.onClick();
  panel = rt2.render(bp, props);

  const modalNode = collect(panel).find((n) => n.props && n.props.action && n.props.action.id === 'goto');
  check('点积木弹出参数面板', !!modalNode, 'no modal');
  const modalTree = modalNode.type(modalNode.props);
  const modalComp = nodesOf(modalTree, rt2.antd.Modal)[0];
  check(
    '参数面板标题带动作名',
    !!modalComp && String(modalComp.props.title).indexOf('添加积木：打开地址') >= 0,
    modalComp && modalComp.props.title
  );
  const urlInput = collect(modalTree).find((n) => n.type === rt2.antd.Input && n.props.placeholder === '/login 或完整地址');
  check('参数面板按 params 生成输入框', !!urlInput, 'no url input');
  check('参数面板里的确定按钮文案是「加这一步」', nodesOf(modalTree, rt2.antd.Modal).some((n) => n.props.okText === '加这一步'), 'no okText');
  urlInput.props.onChange({ target: { value: '/login' } });
  panel = rt2.render(bp, props);
  const modalNode2 = collect(panel).find((n) => n.props && n.props.action && n.props.action.id === 'goto');
  check('填完参数后草稿保留', modalNode2.props.params.url === '/login', modalNode2.props.params);
  modalNode2.props.onOk();
  panel = rt2.render(bp, props);

  const codeArea = collect(panel).find((n) => n.type === 'textarea');
  check(
    '加完步骤后结果区实时出代码',
    codeArea.props.value === ['@Test', 'public void testLogin() {', '    page.navigate("/login");', '}'].join('\n'),
    codeArea.props.value
  );
  check('需要的 import 单独列出来（Page）', hasText(panel, 'com.microsoft.playwright.Page'), 'no imports block');
  check('步骤列表里出现这一步', hasText(panel, '打开地址 · URL=/login'), 'no step row');

  /* ---- 元素步骤 + POM 生成的联动 ---- */
  pomRadio.props.onChange({ target: { value: 'generated' } });
  panel = rt2.render(bp, props);
  const codeGenMode = collect(panel).find((n) => n.type === 'textarea');
  check(
    'generated 模式：POM 实例行出现在方法体里',
    codeGenMode.props.value.indexOf('LoginPage loginPage = new LoginPage(page);') >= 0,
    codeGenMode.props.value
  );
  check('generated 模式显示自动类名', hasText(panel, '自动类名：LoginPage'), 'no auto class tag');

  const clickBrick = nodesOf(panel, rt2.antd.Button).find((n) => textOf(n) === '点击');
  clickBrick.props.onClick();
  panel = rt2.render(bp, props);
  const clickModal = collect(panel).find((n) => n.props && n.props.action && n.props.action.id === 'click');
  const clickModalTree = clickModal.type(clickModal.props);
  const elSelect = collect(clickModalTree).find((n) => n.type === rt2.antd.Select);
  check(
    '元素下拉只列当前页面的元素（2 个，带 mode 标签）',
    !!elSelect && elSelect.props.options.length === 2 && /css/.test(elSelect.props.options[0].label),
    elSelect && elSelect.props.options
  );
  elSelect.props.onChange('usernameInput');
  panel = rt2.render(bp, props);
  const clickModal2 = collect(panel).find((n) => n.props && n.props.action && n.props.action.id === 'click');
  check('选元素后记下定位方式', clickModal2.props.params.el === 'usernameInput', clickModal2.props.params);
  clickModal2.props.onOk();
  panel = rt2.render(bp, props);
  const codeWithPom = collect(panel).find((n) => n.type === 'textarea');
  check(
    'POM 模式下元素步骤生成 loginPage.usernameInput()',
    codeWithPom.props.value.indexOf('loginPage.usernameInput().click();') >= 0,
    codeWithPom.props.value
  );

  /* ---- existing 模式：类名输入框联动 ---- */
  pomRadio.props.onChange({ target: { value: 'existing' } });
  panel = rt2.render(bp, props);
  const classInput = nodesOf(panel, rt2.antd.Input).find((n) => /已有页面对象类名/.test(n.props.placeholder || ''));
  check('existing 模式显示类名输入框', !!classInput, 'no class input');
  classInput.props.onChange({ target: { value: 'MyLoginPage' } });
  panel = rt2.render(bp, props);
  const codeExisting = collect(panel).find((n) => n.type === 'textarea');
  check(
    'existing 模式用用户填的类名',
    codeExisting.props.value.indexOf('MyLoginPage myLoginPage = new MyLoginPage(page);') >= 0,
    codeExisting.props.value
  );

  /* ---- none 模式：定位器内联 ---- */
  pomRadio.props.onChange({ target: { value: 'none' } });
  panel = rt2.render(bp, props);
  const codeNone = collect(panel).find((n) => n.type === 'textarea');
  check(
    '切回 none 模式后元素定位器内联（复用 locatorModes）',
    codeNone.props.value.indexOf('page.locator("#username").click();') >= 0,
    codeNone.props.value
  );

  /* ---- 上下移 / 删除 ---- */
  const upButtons = nodesOf(panel, rt2.antd.Button).filter(
    (n) => n.props.icon && n.props.icon.type === rt2.icons.ArrowUpOutlined && !n.props.disabled
  );
  check('第二步的「上移」按钮可用', upButtons.length === 1, upButtons.length);
  upButtons[0].props.onClick({ stopPropagation: () => {} });
  panel = rt2.render(bp, props);
  const moved = collect(panel).find((n) => n.type === 'textarea').props.value;
  check(
    '上移真的换了顺序（点击排到导航前面）',
    moved.indexOf('click();') < moved.indexOf('navigate('),
    moved
  );
  check('顺序变了会提示「打开地址」不在第一步', hasText(panel, '不在第一步'), 'no order warning');

  const delButtons = nodesOf(panel, rt2.antd.Button).filter((n) => n.props.icon && n.props.icon.type === rt2.icons.DeleteOutlined);
  check('每步都有删除按钮', delButtons.length === 2, delButtons.length);
  delButtons[0].props.onClick({ stopPropagation: () => {} });
  panel = rt2.render(bp, props);
  check(
    '删除后只剩一步',
    nodesOf(panel, rt2.antd.Button).filter((n) => n.props.icon && n.props.icon.type === rt2.icons.DeleteOutlined).length === 1,
    'delete failed'
  );

  /* ---- 复制 ---- */
  const copyBtn = nodesOf(panel, rt2.antd.Button).find((n) => n.props.icon && n.props.icon.type === rt2.icons.CopyOutlined);
  copyBtn.props.onClick();
  check(
    '复制把 import + 方法体一起给出去',
    typeof props.copied === 'string' && props.copied.indexOf('com.microsoft.playwright.Page') >= 0 && props.copied.indexOf('@Test') >= 0,
    props.copied
  );

  /* ---- 没选页面时元素下拉的提示 ---- */
  const rt3 = createRuntime();
  const bp3 = rt3.load(BRICKS).default;
  const props3 = { pages: [], pageId: '', onSelectPage: () => {}, pageName: '', pageUrl: '', elements: [], lang: 'python', onCopy: () => {} };
  let panel3 = rt3.render(bp3, props3);
  const clickBrick3 = nodesOf(panel3, rt3.antd.Button).find((n) => textOf(n) === '点击');
  clickBrick3.props.onClick();
  panel3 = rt3.render(bp3, props3);
  const modal3 = collect(panel3).find((n) => n.props && n.props.action && n.props.action.id === 'click');
  const modal3Tree = modal3.type(modal3.props);
  check('没选页面时参数面板提示「先在上面选页面」', hasText(modal3Tree, '先在上面选页面'), 'no hint');
  const elSelect3 = collect(modal3Tree).find((n) => n.type === rt3.antd.Select);
  check('没选页面时元素下拉被禁用', !!elSelect3 && elSelect3.props.disabled === true, elSelect3 && elSelect3.props.disabled);
  check('Python 目标下自动类名同理（空页面 → MyPage）', gen.pomClassNameFromPage('', '') === 'MyPage', gen.pomClassNameFromPage('', ''));

  /* ---- 类名输入框联动：自动类名跟着工具条上的类名走 ---- */
  const rt4 = createRuntime();
  const bp4 = rt4.load(BRICKS).default;
  const props4 = {
    pages: PAGES,
    pageId: 'p1',
    onSelectPage: () => {},
    pageName: 'login',
    pageUrl: '/login',
    className: 'MyLogin',
    elements: ELEMENTS,
    lang: 'java',
    onCopy: () => {}
  };
  let panel4 = rt4.render(bp4, props4);
  const radio4 = collect(panel4).find((n) => n.type === rt4.antd.Radio.Group);
  radio4.props.onChange({ target: { value: 'generated' } });
  panel4 = rt4.render(bp4, props4);
  check('积木区显示的自动类名跟工具条「类名」一致', hasText(panel4, '自动类名：MyLoginPage'), 'wrong auto class');

  /* ---------- 5.3 真实 React + antd 渲染（防 antd 用法写错） ---------- */
  function createRealLoader() {
    const cache = new Map();
    function load(file) {
      const abs = path.resolve(file);
      if (cache.has(abs)) return cache.get(abs);
      const src = fs.readFileSync(abs, 'utf8');
      const { code } = esbuild.transformSync(src, {
        loader: /\.tsx$/.test(abs) ? 'tsx' : 'ts',
        format: 'cjs',
        jsx: 'automatic',
        target: 'node18',
        charset: 'utf8',
        sourcefile: abs
      });
      const mod = { exports: {} };
      cache.set(abs, mod.exports);
      const req = (id) => {
        if (id === 'react') return require('react');
        if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
        if (id === 'antd') return require('antd');
        if (id === '@ant-design/icons') return require('@ant-design/icons');
        if (id.startsWith('.')) {
          const base = path.resolve(path.dirname(abs), id);
          const hit =
            ['.tsx', '.ts', '.js'].map((e) => base + e).filter((p) => fs.existsSync(p))[0] ||
            (fs.existsSync(base) ? base : null);
          if (!hit) throw new Error('测试找不到模块：' + id + '（来自 ' + abs + '）');
          const rel = path.relative(ROOT, hit).replace(/\\/g, '/');
          if (rel.indexOf('shared/') === 0) return require(hit);
          return load(hit);
        }
        throw new Error('测试没有为这个依赖准备桩：' + id);
      };
      new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
      cache.set(abs, mod.exports);
      return mod.exports;
    }
    return load;
  }

  const RealBricks = createRealLoader()(BRICKS).default;
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  let realHtml = '';
  let realErr = '';
  try {
    realHtml = renderToStaticMarkup(
      React.createElement(RealBricks, {
        pages: PAGES,
        pageId: 'p1',
        onSelectPage: () => {},
        pageName: '登录页',
        pageUrl: '/login',
        elements: ELEMENTS,
        lang: 'java',
        onCopy: () => {}
      })
    );
  } catch (e) {
    realErr = e && e.message;
  }
  check('真实 React + antd 能把积木区渲染出来', !realErr && realHtml.length > 1000, realErr || String(realHtml.length));
  check('真实渲染结果里有可编辑 textarea', /<textarea/.test(realHtml), realHtml.slice(0, 200));
  check(
    '真实渲染结果里有积木库和 POM 三种模式',
    realHtml.indexOf('积木库') >= 0 && realHtml.indexOf('用本页生成的') >= 0 && realHtml.indexOf('用已有类') >= 0,
    'missing text'
  );

  /* ============================================================
   * 汇总
   * ============================================================ */
  const failed = results.filter((r) => !r.ok);
  console.log('===== 积木式动作拼装测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();