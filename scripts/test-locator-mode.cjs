'use strict';
/**
 * 页面元素「定位方式」（css / xpath / role / label / ... / testid）的单元测试。
 *
 * 覆盖四块：
 *   1. shared/locatorModes.js：9 种定位方式 × 2 门目标语言（Java / Python）的代码生成、
 *      转义、role 的「角色:名称」拆解、空值兜底；
 *   2. PageElementsEditor：parse / serialize 带 mode 的往返、老数据（无 mode）当 css、
 *      css 不写进 JSON、下拉顺序（css 第一、testid 最后）、XPath 提示；
 *   3. Playwright 两个模板（Java / Python）真的按 mode 生成；
 *   4. 前端表格的实时预览行（聚焦 / 有值才显示），源码守卫。
 *
 * 纯 unit 档：不读任何本机真实资产，不设环境变量也能跑。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const EDITOR = path.join(ROOT, 'src', 'components', 'PageElementsEditor.tsx');
const CODEGEN_PAGE = path.join(ROOT, 'src', 'pages', 'CodegenPage.tsx');

const lm = require('../shared/locatorModes.js');
const cg = require('../shared/codegen.js');

/* ============================================================
 * 0. 载入 TSX（esbuild → CJS），只要能取到纯函数，不需要真渲染
 * ============================================================ */

function loadTsxModule(file, extraStubs) {
  const src = fs.readFileSync(file, 'utf8');
  const { code } = esbuild.transformSync(src, {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
    target: 'node18',
    charset: 'utf8'
  });
  const passthrough = () => ({});
  const stubs = Object.assign(
    {
      react: () => ({ useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) }),
      'react/jsx-runtime': () => ({ jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }),
      antd: () => new Proxy({}, { get: () => () => null }),
      '@ant-design/icons': () => new Proxy({}, { get: () => () => null }),
      '../../shared/locatorModes': () => lm,
      /**
       * v0.54：PageElementsEditor 多了实时校验入口（api.sniff* + SniffPanel）。
       * 本套件只验定位方式的解析与代码预览，桩给空的就行；
       * 不补这两行会直接抛「测试没有为这个依赖准备桩」。
       */
      '../api': () => ({ __esModule: true, default: { sniffStatus: async () => ({ ok: true, running: false }), sniffStart: async () => ({ ok: false }), sniffHighlight: async () => ({ ok: false }), sniffReopen: async () => ({ ok: false }), sniffStop: async () => ({ ok: true }) } }),
      './SniffPanel': () => ({ __esModule: true, default: () => null, describeResult: () => ({ lines: [], tone: 'muted' }), phaseLabel: () => '', browserLabel: () => '' }),
      // v0.54.1：编辑器多了「codegen 录制」入口（用不到解析器，给最小桩）
      '../utils/playwrightSnippet': () => ({ __esModule: true, parsePlaywrightSnippet: () => ({ rows: [], skipped: 0, duplicates: 0 }), toIdentifier: () => 'el1' })
    },
    extraStubs || {}
  );
  const mod = { exports: {} };
  const requireStub = (id) => {
    if (!stubs[id]) throw new Error('测试没有为这个依赖准备桩：' + id);
    return stubs[id]();
  };
  new Function('require', 'module', 'exports', code)(requireStub, mod, mod.exports);
  return mod.exports || passthrough();
}

const editor = loadTsxModule(EDITOR);
const { parseElements, serializeElements, LOCATOR_MODE_OPTIONS, LOCATOR_MODE_PLACEHOLDER, normalizeMode, looksLikeXPath } = editor;

/* ============================================================
 * 1. 下拉顺序：CSS 第一，TestId 最后（产品硬要求）
 * ============================================================ */

// v0.66：新增第 10 种 raw（原生表达式），专门放「UI 表达不了的复杂定位器」
check('shared 里登记了 10 种定位方式（v0.66 加了 raw）', lm.LOCATOR_MODES.length === 10, lm.LOCATOR_MODES);
check('下拉第 1 个是 css', lm.LOCATOR_MODES[0] === 'css', lm.LOCATOR_MODES[0]);
check('raw 排在最后（它是逃生口，不该抢常规方式的注意力）', lm.LOCATOR_MODES[lm.LOCATOR_MODES.length - 1] === 'raw', lm.LOCATOR_MODES);
check(
  '下拉顺序与产品要求完全一致',
  lm.LOCATOR_MODES.join(',') === 'css,xpath,role,label,placeholder,text,alttext,title,testid,raw',
  lm.LOCATOR_MODES.join(',')
);
check('testid 排在 title 之后（不是靠前）', lm.LOCATOR_MODES.indexOf('testid') > lm.LOCATOR_MODES.indexOf('title'), lm.LOCATOR_MODES);
check('编辑器下拉选项与 shared 顺序一致', LOCATOR_MODE_OPTIONS.map((o) => o.value).join(',') === lm.LOCATOR_MODES.join(','), LOCATOR_MODE_OPTIONS);
check('下拉选项都带中文显示名', LOCATOR_MODE_OPTIONS.every((o) => o.label && o.label !== o.value), LOCATOR_MODE_OPTIONS);
check('显示名：CSS 选择器 / TestId（data-testid）', LOCATOR_MODE_OPTIONS[0].label === 'CSS 选择器' && LOCATOR_MODE_OPTIONS[8].label === 'TestId（data-testid）', LOCATOR_MODE_OPTIONS.map((o) => o.label));
check('10 种定位方式都有 placeholder', lm.LOCATOR_MODES.every((m) => !!LOCATOR_MODE_PLACEHOLDER[m]), LOCATOR_MODE_PLACEHOLDER);
/**
 * v0.66：css 的 placeholder 现在带一个「过滤后缀」示范 ——
 * 只写 #username 或 .btn-primary 的话，用户永远不知道 |has-text 这条路。
 */
check(
  'css 的 placeholder 带过滤后缀示范（|has-text）',
  /^#username/.test(LOCATOR_MODE_PLACEHOLDER.css) && LOCATOR_MODE_PLACEHOLDER.css.indexOf('|has-text=') >= 0,
  LOCATOR_MODE_PLACEHOLDER.css
);
check(
  'role 的 placeholder 提了 |exact（精确匹配是最常踩的坑）',
  LOCATOR_MODE_PLACEHOLDER.role.indexOf('|exact') >= 0,
  LOCATOR_MODE_PLACEHOLDER.role
);
check('xpath 的 placeholder 是 //div[@id="x"]（不带 xpath=）', LOCATOR_MODE_PLACEHOLDER.xpath === '//div[@id="x"]', LOCATOR_MODE_PLACEHOLDER.xpath);
check('xpath 的 placeholder 不诱导用户手写 xpath= 前缀', !/^xpath=/.test(LOCATOR_MODE_PLACEHOLDER.xpath), LOCATOR_MODE_PLACEHOLDER.xpath);
check('role 的 placeholder 提示「角色:可访问名称」', /角色[:：]/.test(LOCATOR_MODE_PLACEHOLDER.role) && LOCATOR_MODE_PLACEHOLDER.role.indexOf(':') > 0, LOCATOR_MODE_PLACEHOLDER.role);
check('testid 的 placeholder 是 submit', LOCATOR_MODE_PLACEHOLDER.testid === 'submit', LOCATOR_MODE_PLACEHOLDER.testid);

/* ============================================================
 * 2. 9 种定位方式 × Java 生成结果
 * ============================================================ */

const JAVA = 'java';
const PY = 'python';

check('css → page.locator("#x")', lm.previewLocatorCode('css', '#x', JAVA) === 'page.locator("#x")', lm.previewLocatorCode('css', '#x', JAVA));
check('xpath → page.locator("xpath=//div")（自动补前缀）', lm.previewLocatorCode('xpath', '//div', JAVA) === 'page.locator("xpath=//div")', lm.previewLocatorCode('xpath', '//div', JAVA));
check(
  'role 带名称 → getByRole(AriaRole.BUTTON, ...setName("登录"))',
  lm.previewLocatorCode('role', 'button:登录', JAVA) === 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"))',
  lm.previewLocatorCode('role', 'button:登录', JAVA)
);
check('role 不带名称 → getByRole(AriaRole.BUTTON)', lm.previewLocatorCode('role', 'button', JAVA) === 'page.getByRole(AriaRole.BUTTON)', lm.previewLocatorCode('role', 'button', JAVA));
check('label → getByLabel("用户名")', lm.previewLocatorCode('label', '用户名', JAVA) === 'page.getByLabel("用户名")', lm.previewLocatorCode('label', '用户名', JAVA));
check('placeholder → getByPlaceholder("请输入密码")', lm.previewLocatorCode('placeholder', '请输入密码', JAVA) === 'page.getByPlaceholder("请输入密码")', lm.previewLocatorCode('placeholder', '请输入密码', JAVA));
check('text → getByText("提交")', lm.previewLocatorCode('text', '提交', JAVA) === 'page.getByText("提交")', lm.previewLocatorCode('text', '提交', JAVA));
check('alttext → getByAltText("logo")', lm.previewLocatorCode('alttext', 'logo', JAVA) === 'page.getByAltText("logo")', lm.previewLocatorCode('alttext', 'logo', JAVA));
check('title → getByTitle("提示")', lm.previewLocatorCode('title', '提示', JAVA) === 'page.getByTitle("提示")', lm.previewLocatorCode('title', '提示', JAVA));
check('testid → getByTestId("submit")', lm.previewLocatorCode('testid', 'submit', JAVA) === 'page.getByTestId("submit")', lm.previewLocatorCode('testid', 'submit', JAVA));

/* ============================================================
 * 3. 9 种定位方式 × Python 生成结果（下划线 API，别抄 Java 的驼峰）
 * ============================================================ */

check('Python css → self.page.locator("#x")', lm.previewLocatorCode('css', '#x', PY) === 'self.page.locator("#x")', lm.previewLocatorCode('css', '#x', PY));
check('Python xpath → self.page.locator("xpath=//div")', lm.previewLocatorCode('xpath', '//div', PY) === 'self.page.locator("xpath=//div")', lm.previewLocatorCode('xpath', '//div', PY));
check('Python role → get_by_role("button", name="登录")', lm.previewLocatorCode('role', 'button:登录', PY) === 'self.page.get_by_role("button", name="登录")', lm.previewLocatorCode('role', 'button:登录', PY));
check('Python role 不带名称 → get_by_role("button")', lm.previewLocatorCode('role', 'button', PY) === 'self.page.get_by_role("button")', lm.previewLocatorCode('role', 'button', PY));
check('Python label → get_by_label("用户名")', lm.previewLocatorCode('label', '用户名', PY) === 'self.page.get_by_label("用户名")', lm.previewLocatorCode('label', '用户名', PY));
check('Python placeholder → get_by_placeholder("请输入密码")', lm.previewLocatorCode('placeholder', '请输入密码', PY) === 'self.page.get_by_placeholder("请输入密码")', lm.previewLocatorCode('placeholder', '请输入密码', PY));
check('Python text → get_by_text("提交")', lm.previewLocatorCode('text', '提交', PY) === 'self.page.get_by_text("提交")', lm.previewLocatorCode('text', '提交', PY));
check('Python alttext → get_by_alt_text("logo")', lm.previewLocatorCode('alttext', 'logo', PY) === 'self.page.get_by_alt_text("logo")', lm.previewLocatorCode('alttext', 'logo', PY));
check('Python title → get_by_title("提示")', lm.previewLocatorCode('title', '提示', PY) === 'self.page.get_by_title("提示")', lm.previewLocatorCode('title', '提示', PY));
check('Python testid → get_by_test_id("submit")', lm.previewLocatorCode('testid', 'submit', PY) === 'self.page.get_by_test_id("submit")', lm.previewLocatorCode('testid', 'submit', PY));
check('Python 不生成 Java 的驼峰调用', !/getBy/.test(lm.previewLocatorCode('label', 'x', PY)), lm.previewLocatorCode('label', 'x', PY));
check('Java 不生成 Python 的下划线调用', !/get_by_/.test(lm.previewLocatorCode('label', 'x', JAVA)), lm.previewLocatorCode('label', 'x', JAVA));

/* ============================================================
 * 4. role 的「角色:名称」拆解（按第一个冒号切）
 * ============================================================ */

const roleJava = (s) => lm.previewLocatorCode('role', s, JAVA);
const rolePy = (s) => lm.previewLocatorCode('role', s, PY);

check('role: button:登录 → 角色 button / 名称 登录', lm.splitRoleSelector('button:登录').role === 'button' && lm.splitRoleSelector('button:登录').name === '登录', lm.splitRoleSelector('button:登录'));
check('role: 只有角色时 name 为空串', lm.splitRoleSelector('button').name === '' && lm.splitRoleSelector('button').role === 'button', lm.splitRoleSelector('button'));
check(
  'role: button:登录:备注 按第一个冒号切，名称里保留冒号',
  lm.splitRoleSelector('button:登录:备注').role === 'button' && lm.splitRoleSelector('button:登录:备注').name === '登录:备注',
  lm.splitRoleSelector('button:登录:备注')
);
check('role 第 3 段冒号内容进 setName（Java）', roleJava('button:登录:备注') === 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录:备注"))', roleJava('button:登录:备注'));
check('role 多段冒号（Python）', rolePy('button:登录:备注') === 'self.page.get_by_role("button", name="登录:备注")', rolePy('button:登录:备注'));
check('role 冒号两边空格被去掉', lm.splitRoleSelector('  button : 登录 ').role === 'button' && lm.splitRoleSelector('  button : 登录 ').name === '登录', lm.splitRoleSelector('  button : 登录 '));
check('role 认得的角色映射成枚举常量（menuitemcheckbox）', roleJava('menuitemcheckbox:全选').indexOf('AriaRole.MENUITEMCHECKBOX') >= 0, roleJava('menuitemcheckbox:全选'));
check('role 认不出的角色用 valueOf，保证能编译', roleJava('mystery-role:x').indexOf('AriaRole.valueOf("MYSTERYROLE")') >= 0, roleJava('mystery-role:x'));
check('role 只有名称（角色为空）退回普通 locator，不生成非法调用', roleJava(':登录') === 'page.locator(":登录")', roleJava(':登录'));

/* ============================================================
 * 5. 转义
 * ============================================================ */

check('单引号在双引号字符串里原样保留（不生成 \\\'）', lm.previewLocatorCode('text', "O'Brien", JAVA) === 'page.getByText("O\'Brien")', lm.previewLocatorCode('text', "O'Brien", JAVA));
check('单引号不会被转义坏', lm.previewLocatorCode('text', "O'Brien", JAVA).indexOf('\\\'') < 0, lm.previewLocatorCode('text', "O'Brien", JAVA));
check('双引号转义成 \\"', lm.previewLocatorCode('label', 'a"b', JAVA) === 'page.getByLabel("a\\"b")', lm.previewLocatorCode('label', 'a"b', JAVA));
check('反斜杠转义成 \\\\', lm.previewLocatorCode('label', 'a\\b', JAVA) === 'page.getByLabel("a\\\\b")', lm.previewLocatorCode('label', 'a\\b', JAVA));
check('xpath 里的双引号也被转义（Java 能编译）', lm.previewLocatorCode('xpath', '//div[@id="x"]', JAVA) === 'page.locator("xpath=//div[@id=\\"x\\"]")', lm.previewLocatorCode('xpath', '//div[@id="x"]', JAVA));
check('role 名称里的双引号被转义', lm.previewLocatorCode('role', 'button:点"我"', JAVA) === 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("点\\"我\\""))', lm.previewLocatorCode('role', 'button:点"我"', JAVA));
check('换行被转义（不会把生成的文件串行）', lm.previewLocatorCode('css', '#a\n#b', JAVA) === 'page.locator("#a\\n#b")', lm.previewLocatorCode('css', '#a\n#b', JAVA));
check('parseRoleSelector 不受转义影响（原值拆解）', lm.splitRoleSelector('button:a"b').name === 'a"b', lm.splitRoleSelector('button:a"b'));

/* ============================================================
 * 6. 空值 / 非法值兜底
 * ============================================================ */

check('定位值为空 → 空串（UI 自己显示「等待输入」）', lm.previewLocatorCode('css', '', JAVA) === '', lm.previewLocatorCode('css', '', JAVA));
check('定位值只有空格 → 空串', lm.previewLocatorCode('label', '   ', JAVA) === '', lm.previewLocatorCode('label', '   ', JAVA));
check('selector 是 null → 空串', lm.previewLocatorCode('css', null, JAVA) === '', lm.previewLocatorCode('css', null, JAVA));
check('selector 是 undefined → 空串', lm.previewLocatorCode('css', undefined, JAVA) === '', lm.previewLocatorCode('css', undefined, JAVA));
check('认不出的 mode 当 css', lm.previewLocatorCode('weird-mode', '#x', JAVA) === 'page.locator("#x")', lm.previewLocatorCode('weird-mode', '#x', JAVA));
check('mode 为空 → 当 css', lm.previewLocatorCode(undefined, '#x', JAVA) === 'page.locator("#x")', lm.previewLocatorCode(undefined, '#x', JAVA));
check('mode 大小写不敏感', lm.previewLocatorCode('Role', 'button:登录', JAVA) === roleJava('button:登录'), lm.previewLocatorCode('Role', 'button:登录', JAVA));
check('lang 认不出（拼错）时按 Java 出', lm.previewLocatorCode('label', 'x', 'ruby') === 'page.getByLabel("x")', lm.previewLocatorCode('label', 'x', 'ruby'));
check('normalizeLocatorMode 兜底 css', lm.normalizeLocatorMode('garbage') === 'css' && lm.normalizeLocatorMode(null) === 'css' && lm.normalizeLocatorMode('CSS') === 'css');

/* ============================================================
 * 7. parse / serialize：mode 往返、老数据、JSON 里写不写 mode
 * ============================================================ */

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

const SAMPLE = [
  { name: 'usernameInput', mode: 'css', selector: '#username', desc: '用户名输入框' },
  { name: 'xpathBox', mode: 'xpath', selector: '//div[@id="x"]', desc: 'XPath 元素' },
  { name: 'loginBtn', mode: 'role', selector: 'button:登录', desc: '登录按钮' },
  { name: 'userLabel', mode: 'label', selector: '用户名', desc: '表单标签' },
  { name: 'pwdInput', mode: 'placeholder', selector: '请输入密码', desc: '占位文字' },
  { name: 'submitText', mode: 'text', selector: '提交', desc: '可见文本' },
  { name: 'logoImg', mode: 'alttext', selector: 'logo', desc: '图片描述' },
  { name: 'tipIcon', mode: 'title', selector: '提示', desc: 'title 属性' },
  { name: 'submitBtn', mode: 'testid', selector: 'submit', desc: '测试 id' }
];

const roundTrip = parseElements(serializeElements(SAMPLE));
check('往返（9 种 mode）深等于原数据', deepEqual(roundTrip, SAMPLE), roundTrip);
check('往返后 mode 不丢', roundTrip.map((x) => x.mode).join(',') === SAMPLE.map((x) => x.mode).join(','), roundTrip.map((x) => x.mode));
check('往返后定位值不丢', roundTrip.map((x) => x.selector).join('|') === SAMPLE.map((x) => x.selector).join('|'), roundTrip.map((x) => x.selector));
check('往返是幂等的', serializeElements(parseElements(serializeElements(SAMPLE))) === serializeElements(SAMPLE), serializeElements(SAMPLE));

// 老数据：没有 mode → 一律 css，不推断
const LEGACY = '[{"name":"usernameInput","selector":"#username","desc":"用户名输入框"},{"name":"oldXpath","selector":"//div[@id=\\"x\\"]","desc":"老记录里的 XPath 写法"}]';
const legacyParsed = parseElements(LEGACY);
check('老数据（无 mode）解析成 2 个元素', legacyParsed.length === 2, legacyParsed);
check('老数据缺的 mode 补 css', legacyParsed.every((x) => x.mode === 'css'), legacyParsed.map((x) => x.mode));
check('老数据以 // 开头也不自动改成 xpath（用户明确要求不做推断）', legacyParsed[1].mode === 'css', legacyParsed[1]);
check('老数据 serialize 不写 mode 字段', serializeElements(legacyParsed).indexOf('"mode"') < 0, serializeElements(legacyParsed));
check('老数据 serialize 保持老格式（name/selector/desc）', serializeElements(legacyParsed) === '[{"name":"usernameInput","selector":"#username","desc":"用户名输入框"},{"name":"oldXpath","selector":"//div[@id=\\"x\\"]","desc":"老记录里的 XPath 写法"}]', serializeElements(legacyParsed));

// 非 css 的 mode 才写进 JSON
const withModes = JSON.parse(serializeElements(SAMPLE));
check('非 css 的 mode 写进 JSON', withModes[1].mode === 'xpath' && withModes[2].mode === 'role' && withModes[8].mode === 'testid', withModes.map((x) => x.mode));
check('css 那一行不写 mode 字段', !('mode' in withModes[0]), withModes[0]);
check('JSON 里 mode 出现在 selector 之前（可读）', serializeElements(SAMPLE).indexOf('"mode":"xpath"') < serializeElements(SAMPLE).indexOf('"selector":"//div'), serializeElements(SAMPLE).slice(0, 120));
check('脏 mode 当 css 且不落盘', serializeElements([{ name: 'a', mode: 'BAD', selector: '#a', desc: '' }]) === '[{"name":"a","selector":"#a","desc":""}]', serializeElements([{ name: 'a', mode: 'BAD', selector: '#a', desc: '' }]));
check('全空行仍回空串', serializeElements([{ name: '', mode: 'testid', selector: 'x', desc: '' }]) === '', serializeElements([{ name: '', mode: 'testid', selector: 'x', desc: '' }]));
check('旧文本格式解析出 css', parseElements('a = #a')[0].mode === 'css', parseElements('a = #a')[0]);
check('normalizeMode 对脏值给 css', normalizeMode('WHATEVER') === 'css' && normalizeMode('testid') === 'testid', normalizeMode('WHATEVER'));

/* ============================================================
 * 8. Playwright 两个模板真的按 mode 生成
 * ============================================================ */

const PAGE = { name: 'login', url: '/login', elements: SAMPLE };
const javaPom = cg.generate('playwright-java', { page: PAGE });
const pyPom = cg.generate('playwright-python', { page: PAGE });

check('Java POM 生成成功', javaPom.ok === true, javaPom.message);
check('Python POM 生成成功', pyPom.ok === true, pyPom.message);
check('Java 生成 9 个 Locator 方法', (javaPom.code.match(/public Locator /g) || []).length === 9, (javaPom.code.match(/public Locator /g) || []).length);
check('Java css 用 locator', /return page\.locator\("#username"\);/.test(javaPom.code), 'no css locator');
check('Java xpath 自动补 xpath= 前缀', /return page\.locator\("xpath=\/\/div\[@id=\\"x\\"\]"\);/.test(javaPom.code), 'xpath prefix');
check('Java role 用 getByRole + AriaRole', /return page\.getByRole\(AriaRole\.BUTTON, new Page\.GetByRoleOptions\(\)\.setName\("登录"\)\);/.test(javaPom.code), 'role');
check('Java label 用 getByLabel', /return page\.getByLabel\("用户名"\);/.test(javaPom.code), 'label');
check('Java placeholder 用 getByPlaceholder', /return page\.getByPlaceholder\("请输入密码"\);/.test(javaPom.code), 'placeholder');
check('Java text 用 getByText', /return page\.getByText\("提交"\);/.test(javaPom.code), 'text');
check('Java alttext 用 getByAltText', /return page\.getByAltText\("logo"\);/.test(javaPom.code), 'alttext');
check('Java title 用 getByTitle', /return page\.getByTitle\("提示"\);/.test(javaPom.code), 'title');
check('Java testid 用 getByTestId', /return page\.getByTestId\("submit"\);/.test(javaPom.code), 'testid');
check('Java 用到 role 时 import AriaRole', /import com\.microsoft\.playwright\.options\.AriaRole;/.test(javaPom.code), 'no AriaRole import');
check('Java 注释里标出定位方式', /定位方式：role/.test(javaPom.code), 'no mode comment');

const javaPomNoRole = cg.generate('playwright-java', {
  page: { name: 'login', url: '/login', elements: [{ name: 'btn', mode: 'testid', selector: 'submit', desc: '' }] }
});
check('Java 没用 role 就不 import AriaRole', !/AriaRole/.test(javaPomNoRole.code), 'unused AriaRole import');

check('Python 生成 9 个定位属性', (pyPom.code.match(/-> Locator:/g) || []).length === 9, (pyPom.code.match(/-> Locator:/g) || []).length);
check('Python css 用 self.page.locator', /return self\.page\.locator\("#username"\)/.test(pyPom.code), 'no css locator');
check('Python xpath 自动补前缀', /return self\.page\.locator\("xpath=\/\/div\[@id=\\"x\\"\]"\)/.test(pyPom.code), 'xpath');
check('Python role 用 get_by_role(name=)', /return self\.page\.get_by_role\("button", name="登录"\)/.test(pyPom.code), 'role');
check('Python label / placeholder / text / alttext / title / testid 全按 mode 出', [
    /get_by_label\("用户名"\)/,
    /get_by_placeholder\("请输入密码"\)/,
    /get_by_text\("提交"\)/,
    /get_by_alt_text\("logo"\)/,
    /get_by_title\("提示"\)/,
    /get_by_test_id\("submit"\)/
  ].every((re) => re.test(pyPom.code)), 'python methods');
check('Python 里没有 Java 风格 getByRole', !/getByRole/.test(pyPom.code), 'camelCase leaked into python');
check('模板里不再硬编码 page.locator("<%= el.selector %>")', !/page\.locator\("<%= el\.selector %>"\)/.test(fs.readFileSync(path.join(ROOT, 'shared', 'codegen.js'), 'utf8')), 'template still hardcodes locator');

/* ============================================================
 * 9. XPath 提示（只提示，不自动改）
 * ============================================================ */

check('looksLikeXPath: /html/body → true', looksLikeXPath('/html/body') === true, looksLikeXPath('/html/body'));
check('looksLikeXPath: //div[@id="x"] → true', looksLikeXPath('//div[@id="x"]') === true, looksLikeXPath('//div[@id="x"]'));
check('looksLikeXPath: #username → false', looksLikeXPath('#username') === false, looksLikeXPath('#username'));
check('looksLikeXPath: .btn-primary → false', looksLikeXPath('.btn-primary') === false, looksLikeXPath('.btn-primary'));
check('looksLikeXPath: [data-x="/a"] → false（不是开头）', looksLikeXPath('[data-x="/a"]') === false, looksLikeXPath('[data-x="/a"]'));
check('looksLikeXPath: 空值 / null → false', looksLikeXPath('') === false && looksLikeXPath(null) === false && looksLikeXPath(undefined) === false);
check('looksLikeXPath: 前导空格不影响判断', looksLikeXPath('   //div') === true, looksLikeXPath('   //div'));
check('mode 是 css 时的 XPath 提示条件成立', normalizeMode(undefined) === 'css' && looksLikeXPath('//div'), 'hint cond');
check('mode 不是 css 时不该提示（条件里有 mode === css）', (() => {
  const src = fs.readFileSync(EDITOR, 'utf8');
  return /mode === 'css' && looksLikeXPath\(r\.selector\)/.test(src);
})());

/* ============================================================
 * 10. 前端：表格新列 + 实时预览行（源码守卫）
 * ============================================================ */

const editorSrc = fs.readFileSync(EDITOR, 'utf8');
const codegenSrc = fs.readFileSync(CODEGEN_PAGE, 'utf8');

/**
 * v0.54：加了「校验」列之后，定位方式列宽度从 130 收到 112。
 * 断言不该绑死某个像素值（那不是产品约束），改成「这一列存在 + 顺序正确」——
 * 顺序那条由下面一句负责，这里只认列头本身。
 */
check('PageElementsEditor 有「定位方式」列', /<th[^>]*>定位方式<\/th>/.test(editorSrc), 'no mode column');
check('PageElementsEditor 的定位方式列在名称和定位值之间', editorSrc.indexOf('>名称</th>') < editorSrc.indexOf('>定位方式</th>') && editorSrc.indexOf('>定位方式</th>') < editorSrc.indexOf('>定位值</th>'), 'column order');
check('PageElementsEditor 用下拉渲染定位方式', /<Select[\s\S]{0,200}options=\{LOCATOR_MODE_OPTIONS\}/.test(editorSrc), 'no Select');
check('PageElementsEditor 的定位值 placeholder 跟着 mode 变', /placeholder=\{LOCATOR_MODE_PLACEHOLDER\[mode\]\}/.test(editorSrc), 'static placeholder');
check('PageElementsEditor 预览复用 shared 的生成函数', /previewLocatorCode\(mode, r\.selector, 'java'\)/.test(editorSrc), 'duplicated preview logic');
check('PageElementsEditor 定位值输入框有 onFocus / onBlur', /onFocus=\{\(\) => setFocusRow\(i\)\}/.test(editorSrc) && /onBlur=\{\(\) => setFocusRow\(-1\)\}/.test(editorSrc), 'no focus handlers');

/**
 * v0.67：生成的代码预览从「常驻一行灰字」改成 **hover 提示**。
 * 起因：4 个元素就把表格撑高一倍，每行下面都挂一句 → page.getByRole(...)，很不规整。
 * 现在守三件事：预览在 Tooltip 里、定位值输入框被 Tooltip 包住、不再有常驻的预览 div。
 */
check(
  'PageElementsEditor 预览进了 hover 提示（Tooltip 里带生成代码）',
  /<Tooltip[\s\S]{0,700}preview \|\| '（等待输入定位值）'/.test(editorSrc),
  'preview not in tooltip'
);
/**
 * 用「位置顺序」判断，别用 `[\s\S]{0,N}` 卡距离 ——
 * Tooltip 的 title 块很长，N 稍微小一点就误报（第一次就写成 900 踩到了）。
 */
const wrappedBy = (src, open, inner, close) => {
  const a = src.indexOf(open);
  if (a < 0) return false;
  const b = src.indexOf(inner, a);
  if (b < 0) return false;
  const c = src.indexOf(close, b);
  return c > b;
};
check(
  'PageElementsEditor 定位值输入框被 Tooltip 包住',
  wrappedBy(editorSrc, '<Tooltip', 'value={r.selector}', '</Tooltip>'),
  'input not wrapped'
);
check(
  'PageElementsEditor 不再有常驻预览行（pe-el-preview 已移除）',
  !/className="pe-el-preview/.test(editorSrc),
  'preview div still there'
);
check(
  'PageElementsEditor 过滤后缀提示也收进 hover（表格只留 XPath 真警告）',
  !/REFINE_HINT_STYLE/.test(editorSrc) && /LOCATOR_MODE_HELP\[mode\]/.test(editorSrc),
  'refine hint still inline'
);
check('PageElementsEditor 空值时提示「（等待输入定位值）」', /'（等待输入定位值）'/.test(editorSrc), 'no waiting text');
check('PageElementsEditor 有橙色 XPath 提示文案', /⚠ 看起来像 XPath，建议把定位方式改成 XPath/.test(editorSrc), 'no xpath hint');
check('PageElementsEditor 的 XPath 提示是橙色', /const XPATH_HINT_STYLE[\s\S]{0,200}color: '#d46b08'/.test(editorSrc) && /className="pe-el-xpath-hint" style=\{XPATH_HINT_STYLE\}/.test(editorSrc), 'hint color');

check('CodegenPage 元素表格也有定位方式下拉', /<Select[\s\S]{0,220}options=\{LOCATOR_MODE_OPTIONS\}/.test(codegenSrc) && /定位方式<\/th>/.test(codegenSrc), 'no mode select in codegen page');
check('CodegenPage 定位值 placeholder 也按 mode 变', /placeholder=\{LOCATOR_MODE_PLACEHOLDER\[mode\]\}/.test(codegenSrc), 'static placeholder');
check('CodegenPage 预览按当前生成目标语言出', /previewLocatorCode\(mode, el\.selector, previewLang\)/.test(codegenSrc) && /current\.lang === 'python' \? 'python' : 'java'/.test(codegenSrc), 'no lang aware preview');
check(
  'CodegenPage 预览也进了 hover 提示（和「页面元素」页一致）',
  /<Tooltip[\s\S]{0,700}preview \|\| '（等待输入定位值）'/.test(codegenSrc) &&
    wrappedBy(codegenSrc, '<Tooltip', 'value={el.selector}', '</Tooltip>') &&
    !/className="pe-el-preview/.test(codegenSrc),
  'codegen preview not in tooltip'
);
check('CodegenPage 元素表格可横滑（多一列不把「说明」挤扁）', /className="codegen-el-scroll" style=\{\{ overflowX: 'auto' \}\}/.test(codegenSrc) && /className="jmx-table codegen-el-table" style=\{\{ minWidth: 560 \}\}/.test(codegenSrc), 'no scroll wrapper');
check('CodegenPage 保留「载入页面时无条件覆盖元素」的修复', /setElements\(els\.length \? els : \[\{ name: '', selector: '', desc: '' \}\]\)/.test(codegenSrc), 'regression: conditional set');

/* ============================================================
 * 11. 一份生成逻辑、两处消费（模板 / 预览不能各写一遍）
 * ============================================================ */

check('codegen.js 转出 previewLocatorCode（后端也能直接调）', typeof cg.previewLocatorCode === 'function', typeof cg.previewLocatorCode);
check('codegen 转出的就是 shared/locatorModes 的同一个函数', cg.previewLocatorCode === lm.previewLocatorCode, 'two implementations');
check('codegen 转出 LOCATOR_MODES / normalizeLocatorMode / splitRoleSelector', Array.isArray(cg.LOCATOR_MODES) && typeof cg.normalizeLocatorMode === 'function' && typeof cg.splitRoleSelector === 'function', 'missing re-export');
check('POM 模板用 el.locator（不再自己拼 locator）', /return <%= el\.locator %>;/.test(fs.readFileSync(path.join(ROOT, 'shared', 'codegen.js'), 'utf8')), 'template still builds locator itself');
check('Java POM 里没有 Python 风格下划线调用', !/get_by_/.test(javaPom.code), 'python syntax leaked into java');
check('页面元素编辑器把 mode 一起 commit', /setRow\(i, 'mode', v\)/.test(editorSrc), 'mode not committed');

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log('===== 页面元素定位方式（getByXXX）测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);