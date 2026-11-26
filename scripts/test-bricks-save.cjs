'use strict';
/**
 * 积木区两处改进的回归套件（v0.49）：
 *
 *   任务 1【Bug】「N 个元素」的 hover 提示：每行一个元素，格式 `名称 · 定位方式`
 *   任务 2【优化】积木保存为流程模板（flows 集合）+ 载入流程
 *                + 「用本页生成的」产物去哪（POM 类生成状态提示）
 *
 * 做法和 test-ui-bricks.cjs 一样：不启动 Electron、不连数据库，
 *   1. 纯函数（定位方式短名 / tooltip 行 / 流程记录读写）**真跑**，逐字比对；
 *   2. TSX 用 esbuild 转 CJS + 一个迷你 hooks 运行时**真渲染**，
 *      点按钮 / 选下拉 / 提交弹窗都走真实交互路径；
 *   3. 最后用真实 React + antd 渲染一遍（SSR），防 antd 用法写错。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const BRICKS = path.join(ROOT, 'src', 'components', 'ui-bricks', 'BricksPanel.tsx');
const ACTION_MODAL = path.join(ROOT, 'src', 'components', 'ui-bricks', 'ActionParamModal.tsx');
const SAVE_MODAL = path.join(ROOT, 'src', 'components', 'ui-bricks', 'SaveFlowModal.tsx');
const ELEMENT_TIP = path.join(ROOT, 'src', 'components', 'ui-bricks', 'ElementCountTip.tsx');
const HELPERS = path.join(ROOT, 'src', 'components', 'ui-bricks', 'brickHelpers.ts');
const CODEGEN = path.join(ROOT, 'src', 'pages', 'CodegenPage.tsx');
const ICONS = path.join(ROOT, 'src', 'icons.tsx');
const MOCK = path.join(ROOT, 'src', 'mockApi.ts');

const { LOCATOR_MODES } = require('../shared/locatorModes.js');
const { COLLECTIONS, COLLECTION_MAP } = require('../shared/collections.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================================================
 * 迷你渲染运行时（同 scripts/test-ui-bricks.cjs 的套路，不依赖 React 包）
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

function createRuntime() {
  const slots = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let dirty = false;

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

  function load(file) {
    const abs = path.resolve(file);
    if (moduleCache.has(abs)) return moduleCache.get(abs);
    const src = read(abs);
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
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === 'antd') return antd;
      if (id === '@ant-design/icons') return icons;
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(abs), id);
        const hit =
          ['.tsx', '.ts', '.js', '.json'].map((e) => base + e).filter((p) => fs.existsSync(p))[0] ||
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

  return { render, load, antd, icons, hooks };
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

/** v0.62：生成结果默认是 CodeBlock（高亮 + 行号），点「编辑」才是 textarea。
 *  两种都读得到，测试不用关心当前是哪种形态。 */
function codeAreaOf(tree) {
  const nodes = collect(tree);
  const cb = nodes.find((n) => n.props && typeof n.props.code === 'string' && 'lang' in n.props);
  if (cb) return { props: { value: String(cb.props.code) } };
  const ta = nodes.find((n) => n.type === 'textarea');
  if (ta) return ta;
  return { props: { value: '' } };
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

/* ============================================================
 * 一、定位方式短名：复用 shared/locatorModes.js 的 LOCATOR_MODES
 * ============================================================ */
const rt0 = createRuntime();
const helpers = rt0.load(HELPERS);
const helpersSrc = read(HELPERS);
const tipSrc = read(ELEMENT_TIP);
const bricksSrc = read(BRICKS);
const codegenSrc = read(CODEGEN);
const saveModalSrc = read(SAVE_MODAL);

check('brickHelpers 导出 locatorModeShort', typeof helpers.locatorModeShort === 'function', Object.keys(helpers));
check('brickHelpers 导出 elementsTipLines', typeof helpers.elementsTipLines === 'function');
check('brickHelpers 导出流程模板读写函数', typeof helpers.flowRecordData === 'function' && typeof helpers.parseFlowSteps === 'function', Object.keys(helpers));

check(
  '定位方式短名复用 shared/locatorModes 的 LOCATOR_MODES（不是另抄一份）',
  /from '\.\.\/\.\.\/\.\.\/shared\/locatorModes'/.test(helpersSrc) && /\bLOCATOR_MODES\b/.test(helpersSrc),
  'locatorModes 没被复用'
);
check(
  '没有第二份定位方式清单（源码里不应再出现 css/xpath 连排）',
  !/['"]css['"]\s*,\s*['"]xpath['"]/.test(helpersSrc),
  'duplicated mode list'
);

const shorts = helpers.locatorModeShorts();
check(
  '短名覆盖 LOCATOR_MODES 全部 9 种、顺序一致',
  shorts.length === LOCATOR_MODES.length && shorts.map((s) => s.mode).join(',') === LOCATOR_MODES.join(','),
  { got: shorts.map((s) => s.mode), want: LOCATOR_MODES }
);

const EXPECT_SHORT = {
  css: 'CSS',
  xpath: 'XPath',
  role: 'Role',
  label: 'Label',
  placeholder: 'Placeholder',
  text: 'Text',
  alttext: 'AltText',
  title: 'Title',
  testid: 'TestId'
};
const badShorts = shorts.filter((s) => EXPECT_SHORT[s.mode] !== s.short);
check('9 种短名逐个正确（CSS / XPath / Role / … / TestId）', badShorts.length === 0, badShorts);
check('脏 mode 兜底成 CSS', helpers.locatorModeShort('garbage') === 'CSS', helpers.locatorModeShort('garbage'));
check('大小写不敏感（Role → Role）', helpers.locatorModeShort('Role') === 'Role', helpers.locatorModeShort('Role'));

/* ============================================================
 * 二、tooltip 内容：一行一个元素，格式 `名称 · 定位方式`
 * ============================================================ */
const FOUR = [
  { name: 'usernameInput', mode: 'css', selector: '#username', desc: '用户名' },
  { name: 'passwordInput', mode: 'css', selector: '#password', desc: '密码' },
  { name: 'submitBtn', mode: 'css', selector: 'button[type=submit]', desc: '登录按钮' },
  { name: 'errorTip', mode: 'role', selector: 'button:登录', desc: '错误提示' }
];

const fourLines = helpers.elementsTipLines(FOUR);
check('4 个元素 → 4 行（一行一个，不折行拼接）', fourLines.length === 4, fourLines);
check(
  '每行格式是「名称 · 定位方式」',
  fourLines[0] === 'usernameInput · CSS' &&
    fourLines[1] === 'passwordInput · CSS' &&
    fourLines[2] === 'submitBtn · CSS' &&
    fourLines[3] === 'errorTip · Role',
  fourLines
);
check('没用中文长名（不是「CSS 选择器」）', !fourLines.join('').includes('选择器'), fourLines);

const MANY = Array.from({ length: 16 }, (_, i) => ({ name: 'el' + i, mode: i % 2 ? 'testid' : 'css' }));
const manyLines = helpers.elementsTipLines(MANY);
check('16 个元素时最多列 15 个', manyLines.length === 16 && manyLines[14] === 'el14 · CSS', manyLines);
check('超过 15 个时最后一行是「…还有 N 个」', manyLines[15] === '…还有 1 个', manyLines[15]);

const exactly15 = Array.from({ length: 15 }, (_, i) => ({ name: 'e' + i, mode: 'css' }));
const lines15 = helpers.elementsTipLines(exactly15);
check('正好 15 个时不折叠', lines15.length === 15 && !lines15.some((l) => l.indexOf('…还有') === 0), lines15);

check(
  '没填名字的空行不占 tooltip 行',
  helpers.elementsTipLines([{ name: '   ', selector: '#x' }, { name: 'a', mode: 'testid' }]).join('|') === 'a · TestId',
  helpers.elementsTipLines([{ name: '   ', selector: '#x' }, { name: 'a', mode: 'testid' }])
);
check('没有元素时 tooltip 内容为空（调用方据此不包 Tooltip）', helpers.elementsTipLines([]).length === 0, helpers.elementsTipLines([]));

/* ============================================================
 * 三、tooltip 的渲染：title 传 React 节点 + pre-line，没元素不包 Tooltip
 * ============================================================ */
check('ElementCountTip 用 antd Tooltip 包 children', /<Tooltip[\s\S]{0,200}title=\{title\}/.test(tipSrc), 'no Tooltip');
check('tooltip 容器写了 white-space: pre-line', /whiteSpace: 'pre-line'/.test(tipSrc), 'no pre-line');
check('title 是一个元素一个 div（不是一整串字符串）', /lines\.map\([\s\S]{0,160}<div/.test(tipSrc), 'not per-line div');
check('没有元素时直接返回 children（不显示空提示框）', /if \(!lines\.length\) return/.test(tipSrc), 'empty tip not guarded');

{
  const rt = createRuntime();
  const ElementCountTip = rt.load(ELEMENT_TIP).default;
  const child = { type: 'span', props: { children: '4 个元素' } };
  const tree = ElementCountTip({ elements: FOUR, children: child });
  check('ElementCountTip 有元素时渲染 Tooltip', tree && tree.type === rt.antd.Tooltip, tree && tree.type);
  const title = tree && tree.props.title;
  check('tooltip 每行是独立 div（4 行）', !!title && Array.isArray(title.props.children) && title.props.children.length === 4, title && title.props.children && title.props.children.length);
  check(
    'tooltip 文字就是「名称 · 定位方式」四行',
    textOf(title).indexOf('usernameInput · CSS') === 0 && textOf(title).indexOf('errorTip · Role') > 0,
    textOf(title)
  );
  const bare = ElementCountTip({ elements: [], children: child });
  check('ElementCountTip 没元素时不包 Tooltip', bare && bare.type !== rt.antd.Tooltip, bare && bare.type);
}

/* ============================================================
 * 四、flows 集合定义
 * ============================================================ */
const flowsConf = COLLECTION_MAP.flows;
check('COLLECTIONS 里有 flows 集合', !!flowsConf, COLLECTIONS.map((c) => c.key));
check('flows 的 titleField 是 name', flowsConf && flowsConf.titleField === 'name', flowsConf && flowsConf.titleField);
check('flows 名称是「流程模板」、分组「资产」（侧栏自动注入）', flowsConf && flowsConf.name === '流程模板' && flowsConf.group === '资产', flowsConf && { name: flowsConf.name, group: flowsConf.group });

const flowFieldKeys = (flowsConf.fields || []).map((f) => f.key);
check(
  'flows 字段齐全（name/pageId/pageName/steps/pomMode/pomClass/pomVar/note）',
  ['name', 'pageId', 'pageName', 'steps', 'pomMode', 'pomClass', 'pomVar', 'note'].every((k) => flowFieldKeys.indexOf(k) >= 0),
  flowFieldKeys
);
check('flows.name 必填', flowsConf.fields.some((f) => f.key === 'name' && f.required === true), flowsConf.fields[0]);

const hiddenNoReason = (flowsConf.fields || [])
  .filter((f) => f.formHidden && !String(f.formHiddenReason || '').trim())
  .map((f) => f.key);
check('flows 里每个 formHidden 字段都写了 formHiddenReason', hiddenNoReason.length === 0, hiddenNoReason);
check(
  '自动写入的 6 个字段都不出现在表单里（hideInForm + formHidden）',
  ['pageId', 'pageName', 'steps', 'pomMode', 'pomClass', 'pomVar'].every((k) =>
    flowsConf.fields.some((f) => f.key === k && f.hideInForm && f.formHidden)
  ),
  flowsConf.fields.filter((f) => f.hideInForm).map((f) => f.key)
);
check('备注 note 仍可在表单里手填（没被藏掉）', flowsConf.fields.some((f) => f.key === 'note' && !f.formHidden), flowsConf.fields.filter((f) => f.formHidden).map((f) => f.key));

const iconSrc = read(ICONS);
check(
  'flows 的图标在 src/icons.tsx 的映射表里（侧栏能显示出图标）',
  new RegExp('\\b' + flowsConf.icon + '\\b').test(iconSrc),
  flowsConf.icon
);
check(
  'flows 带 capabilities.headerActions（导入/导出按钮的数据源）',
  !!flowsConf.capabilities && (flowsConf.capabilities.headerActions || []).indexOf('importData') >= 0,
  flowsConf.capabilities
);
check(
  'flows 模板能生成合法 JSON（导入模板功能不崩）',
  (() => {
    try {
      const t = require('../shared/importTemplate.js').buildTemplate(flowsConf);
      return !!JSON.parse(t).records[0];
    } catch (e) {
      return false;
    }
  })(),
  'template failed'
);

/* ============================================================
 * 五、渲染 BricksPanel：元素 tooltip（页面已选 / 未选）
 * ============================================================ */
const PAGES = [
  { id: 'pg1', data: { name: '登录页', url: '/login' } },
  { id: 'pg2', data: { name: '首页', url: '/home' } }
];

const FLOW_STEPS = [
  { actionId: 'goto', params: { url: '/login' } },
  { actionId: 'fill', params: { el: 'usernameInput', text: 'admin' }, elementMode: 'css', elementSelector: '#username' },
  { actionId: 'click', params: { el: 'submitBtn' }, elementMode: 'css', elementSelector: 'button[type=submit]' }
];

const FLOW_REC = {
  id: 'fl1',
  collection: 'flows',
  title: '登录页流程-1125',
  data: {
    name: '登录页流程-1125',
    pageId: 'pg1',
    pageName: '登录页',
    steps: JSON.stringify(FLOW_STEPS),
    pomMode: 'generated',
    pomClass: 'LoginPage',
    pomVar: 'loginPage',
    note: '演示数据'
  }
};

function baseProps(extra) {
  return Object.assign(
    {
      pages: PAGES,
      pageId: 'pg1',
      onSelectPage: () => {},
      pageName: '登录页',
      pageUrl: '/login',
      elements: FOUR,
      lang: 'java',
      onCopy: () => {},
      flows: [FLOW_REC],
      onSaveFlow: () => true,
      onNotify: () => {},
      pomReady: false,
      onGoGeneratePom: () => {},
      onStateChange: () => {}
    },
    extra || {}
  );
}

{
  const rt = createRuntime();
  const Panel = rt.load(BRICKS).default;
  const ElementCountTip = rt.load(ELEMENT_TIP).default;
  const panel = rt.render(Panel, baseProps());

  const countTag = collect(panel).find((n) => n.type === rt.antd.Tag && textOf(n) === '4 个元素');
  check('积木区显示「4 个元素」Tag', !!countTag, nodesOf(panel, rt.antd.Tag).map(textOf));

  // ElementCountTip 是子组件节点：迷你运行时不会替我们展开，手动调用拿它的渲染结果
  const tipNode = collect(panel).find((n) => n.type === ElementCountTip);
  check('「4 个元素」Tag 外面包了 hover 提示组件（ElementCountTip）', !!tipNode, 'no tip wrapper');
  check(
    'hover 提示挂的就是「4 个元素」这个 Tag',
    !!tipNode && textOf(tipNode.props.children) === '4 个元素',
    tipNode && textOf(tipNode.props.children)
  );

  const tipTree = tipNode ? tipNode.type(tipNode.props) : null;
  const tooltip = tipTree ? nodesOf(tipTree, rt.antd.Tooltip)[0] : null;
  check('有元素时渲染成 antd Tooltip', !!tooltip, 'no Tooltip');
  const title = tooltip && tooltip.props.title;
  check(
    'tooltip 每行一个 div（4 个元素 → 4 行，不靠 \\n 换行）',
    !!title && Array.isArray(title.props.children) && title.props.children.length === 4,
    title && title.props.children && title.props.children.length
  );
  check('tooltip 容器写了 white-space: pre-line', !!title && title.props.style && title.props.style.whiteSpace === 'pre-line', title && title.props.style);
  check(
    'tooltip 文字就是「名称 · 定位方式」，第一个和最后一个都对',
    textOf(title).indexOf('usernameInput · CSS') === 0 && textOf(title).indexOf('errorTip · Role') > 0,
    textOf(title)
  );
}

{
  const rt = createRuntime();
  const Panel = rt.load(BRICKS).default;
  const ElementCountTip = rt.load(ELEMENT_TIP).default;
  const panel = rt.render(Panel, baseProps({ pageId: '', elements: [] }));
  check('没选页面时不显示元素 tooltip', collect(panel).every((n) => n.type !== ElementCountTip), 'tip leaked');
  check('没选页面时仍提示先选页面', hasText(panel, '先选页面'), 'no hint');
}

/* ============================================================
 * 六、保存为流程
 * ============================================================ */
const SAVE_BOOT = {
  steps: [
    { key: 's1', actionId: 'goto', params: { url: '/login' } },
    { key: 's2', actionId: 'click', params: { el: 'submitBtn' }, elementMode: 'css', elementSelector: 'button[type=submit]' }
  ],
  pomMode: 'generated',
  pomClass: '',
  pomVar: ''
};

/* ============================================================
 * 六、保存为流程
 * ============================================================ */
check('defaultFlowName 用「页面名 + 月日」（登录页流程-1125）', helpers.defaultFlowName('登录页', new Date(2026, 10, 25)) === '登录页流程-1125', helpers.defaultFlowName('登录页', new Date(2026, 10, 25)));
check('defaultFlowName 页面名为空时兜底「未命名页面」', /^未命名页面流程-/.test(helpers.defaultFlowName('', new Date(2026, 0, 2))), helpers.defaultFlowName(''));

/* 保存是 async（等调用方写库），用 async IIFE 跑；前面的同步断言结果照常累计 */
(async () => {
  const rt = createRuntime();
  const Panel = rt.load(BRICKS).default;
  const SaveFlowModal = rt.load(SAVE_MODAL).default;
  const calls = { saved: null, notify: [] };
  const props = baseProps({
    initialState: SAVE_BOOT,
    onSaveFlow: (d) => {
      calls.saved = d;
      return true;
    },
    onNotify: (m, l) => calls.notify.push([m, l])
  });

  let panel = rt.render(Panel, props);
  const saveBtn = nodesOf(panel, rt.antd.Button).find((n) => textOf(n) === '保存为流程');
  check('工具条上有「保存为流程」按钮', !!saveBtn, nodesOf(panel, rt.antd.Button).map(textOf));
  check('有步骤时「保存为流程」可点', !!saveBtn && saveBtn.props.disabled === false, saveBtn && saveBtn.props.disabled);

  saveBtn.props.onClick();
  panel = rt.render(Panel, props);
  const modalNode = collect(panel).find((n) => n.type === SaveFlowModal);
  check('点「保存为流程」弹出保存弹窗', !!modalNode, 'no save modal');

  const modalTree = modalNode.type(modalNode.props);
  const modal = nodesOf(modalTree, rt.antd.Modal)[0];
  check(
    '弹窗标题是「保存为流程」、确定按钮是「保存」',
    !!modal && modal.props.title === '保存为流程' && modal.props.okText === '保存',
    modal && { title: modal.props.title, ok: modal.props.okText }
  );
  const nameInput = nodesOf(modalTree, rt.antd.Input)[0];
  check(
    '弹窗里有流程名输入框（默认「登录页流程-MMDD」）',
    !!nameInput && /^登录页流程-\d{4}$/.test(String(nameInput.props.value)),
    nameInput && nameInput.props.value
  );
  const noteArea = nodesOf(modalTree, rt.antd.Input.TextArea)[0];
  check(
    '弹窗里有一行备注（选填）',
    !!noteArea && /选填/.test(String(noteArea.props.placeholder)),
    noteArea && noteArea.props.placeholder
  );

  modal.props.onOk();
  await tick();
  await tick();
  panel = rt.render(Panel, props);

  check('保存时把记录交给调用方（写 flows）', !!calls.saved, calls.saved);
  check(
    '写进去的字段齐全（name/pageId/pageName/steps/pomMode/pomClass/pomVar/note）',
    !!calls.saved &&
      /^登录页流程-\d{4}$/.test(calls.saved.name) &&
      calls.saved.pageId === 'pg1' &&
      calls.saved.pageName === '登录页' &&
      calls.saved.pomMode === 'generated' &&
      calls.saved.pomClass === 'LoginPage' &&
      calls.saved.note === '' &&
      typeof calls.saved.steps === 'string',
    calls.saved
  );
  let parsed = [];
  try {
    parsed = JSON.parse(calls.saved.steps);
  } catch (e) {
    parsed = [];
  }
  check('steps 存的是 JSON 字符串，解析回来还是 2 步', parsed.length === 2 && parsed[0].actionId === 'goto' && parsed[1].actionId === 'click', parsed);
  check('steps 里不存前端列表 key（载入时重新发号）', parsed.every((s) => !('key' in s)), parsed);
  check(
    '保存成功提示「已保存，去侧栏「流程模板」查看」',
    calls.notify.some(([m, l]) => m === '已保存，去侧栏「流程模板」查看' && l === 'success'),
    calls.notify
  );
  check('保存成功后弹窗关闭', collect(panel).every((n) => n.type !== SaveFlowModal), 'modal still open');
  check('保存后工具条上留一行「已保存流程「…」」', hasText(panel, '已保存流程「登录页流程-'), 'no hint');

  /* ---------- 没步骤时不能保存 ---------- */
  const rt2 = createRuntime();
  const Panel2 = rt2.load(BRICKS).default;
  const emptyPanel = rt2.render(Panel2, baseProps({ initialState: { steps: [], pomMode: 'none', pomClass: '', pomVar: '' } }));
  const saveBtn2 = nodesOf(emptyPanel, rt2.antd.Button).find((n) => textOf(n) === '保存为流程');
  check('没有步骤时「保存为流程」是禁用的', !!saveBtn2 && saveBtn2.props.disabled === true, saveBtn2 && saveBtn2.props.disabled);

  /* ---------- 保存失败：弹窗不关，给错误 ---------- */
  const rt3 = createRuntime();
  const Panel3 = rt3.load(BRICKS).default;
  const SaveFlowModal3 = rt3.load(SAVE_MODAL).default;
  const props3 = baseProps({ initialState: SAVE_BOOT, onSaveFlow: () => false });
  let panel3 = rt3.render(Panel3, props3);
  nodesOf(panel3, rt3.antd.Button)
    .find((n) => textOf(n) === '保存为流程')
    .props.onClick();
  panel3 = rt3.render(Panel3, props3);
  const m3 = collect(panel3).find((n) => n.type === SaveFlowModal3);
  nodesOf(m3.type(m3.props), rt3.antd.Modal)[0].props.onOk();
  await tick();
  panel3 = rt3.render(Panel3, props3);
  const m3b = collect(panel3).find((n) => n.type === SaveFlowModal3);
  check('保存失败时弹窗不关（还能改名字重试）', !!m3b, 'modal closed');
  check(
    '保存失败时弹窗里给出错误文案',
    !!m3b && hasText(m3b.type(m3b.props), '没存上'),
    m3b && textOf(m3b.type(m3b.props))
  );

  /* ---------- 清空流程名时不允许保存 ---------- */
  {
    const rt4 = createRuntime();
    const Panel4 = rt4.load(BRICKS).default;
    const SaveFlowModal4 = rt4.load(SAVE_MODAL).default;
    const written = [];
    const props4 = baseProps({ initialState: SAVE_BOOT, onSaveFlow: (d) => (written.push(d), true) });
    let panel4 = rt4.render(Panel4, props4);
    nodesOf(panel4, rt4.antd.Button)
      .find((n) => textOf(n) === '保存为流程')
      .props.onClick();
    panel4 = rt4.render(Panel4, props4);
    const m4 = collect(panel4).find((n) => n.type === SaveFlowModal4);
    const tree4 = m4.type(m4.props);
    nodesOf(tree4, rt4.antd.Input)[0].props.onChange({ target: { value: '   ' } });
    panel4 = rt4.render(Panel4, props4);
    const m4b = collect(panel4).find((n) => n.type === SaveFlowModal4);
    nodesOf(m4b.type(m4b.props), rt4.antd.Modal)[0].props.onOk();
    await tick();
    check('流程名为空时拒绝保存（不写脏记录）', written.length === 0, written);
  }

  /* ============================================================
   * 七、载入流程
   * ============================================================ */
  {
    const rt5 = createRuntime();
    const Panel5 = rt5.load(BRICKS).default;
    const calls5 = { page: null, notify: [] };
    const props5 = baseProps({
      // 一开始没选页面：载入流程应该把关联页面自动补上（pageId 不填就是「未选中」）
      pageId: '',
      onSelectPage: (id) => {
        calls5.page = id;
      },
      onNotify: (m, l) => calls5.notify.push([m, l])
    });
    let panel5 = rt5.render(Panel5, props5);

    const loadSelect = nodesOf(panel5, rt5.antd.Select).find((n) => /载入流程/.test(String(n.props.placeholder || '')));
    check('工具条上有「载入流程」下拉', !!loadSelect, nodesOf(panel5, rt5.antd.Select).map((n) => n.props.placeholder));
    check(
      '下拉列出 flows 集合的记录（名字 + 页面）',
      !!loadSelect && loadSelect.props.options.length === 1 && loadSelect.props.options[0].value === 'fl1' && /登录页流程-1125 · 登录页/.test(loadSelect.props.options[0].label),
      loadSelect && loadSelect.props.options
    );

    loadSelect.props.onChange('fl1');
    panel5 = rt5.render(Panel5, props5);

    const codeArea5 = codeAreaOf(panel5);
    check(
      '载入后恢复步骤（方法体出现 navigate / fill / click）',
      codeArea5.props.value.indexOf('page.navigate("/login");') >= 0 && codeArea5.props.value.indexOf('usernameInput().fill("admin")') >= 0,
      codeArea5.props.value
    );
    check('载入后恢复 POM 配置（generated → LoginPage loginPage = new LoginPage(page)）', codeArea5.props.value.indexOf('LoginPage loginPage = new LoginPage(page);') >= 0, codeArea5.props.value);
    check('载入后 POM 单选回填为「用本页生成的」', (() => {
      const radio = collect(panel5).find((n) => n.type === rt5.antd.Radio.Group);
      return radio.props.value === 'generated';
    })(), 'pom mode not restored');
    check('载入后自动选中所关联页面', calls5.page === 'pg1', calls5.page);
    check('载入提示写了几步', hasText(panel5, '已载入「登录页流程-1125」：3 步'), 'no load hint');
    check('载入成功也弹 toast', calls5.notify.some(([m]) => m.indexOf('已载入流程「登录页流程-1125」') >= 0), calls5.notify);
  }

  /* ---------- 关联页面已删除 ---------- */
  {
    const rt6 = createRuntime();
    const Panel6 = rt6.load(BRICKS).default;
    const calls6 = { page: null, notify: [] };
    const props6 = baseProps({
      pages: [{ id: 'pg2', data: { name: '首页', url: '/home' } }],
      onSelectPage: (id) => {
        calls6.page = id;
      },
      onNotify: (m, l) => calls6.notify.push([m, l])
    });
    let panel6 = rt6.render(Panel6, props6);
    nodesOf(panel6, rt6.antd.Select)
      .find((n) => /载入流程/.test(String(n.props.placeholder || '')))
      .props.onChange('fl1');
    panel6 = rt6.render(Panel6, props6);

    check('关联页面不在时提示「关联页面已删除，元素需要重选」', hasText(panel6, '关联页面已删除，元素需要重选'), 'no deleted-page hint');
    check('关联页面不在时不乱改页面选择', calls6.page === null, calls6.page);
    check(
      '关联页面不在时步骤仍然恢复（定位快照还在）',
      codeAreaOf(panel6).props.value.indexOf('page.navigate("/login");') >= 0,
      'steps lost'
    );
    check('同时弹 warning toast', calls6.notify.some(([m, l]) => m === '关联页面已删除，元素需要重选' && l === 'warning'), calls6.notify);
  }

  /* ---------- v0.63：从「流程模板」跳过来时自动载入（openFlowId） ---------- */
  {
    const rtH = createRuntime();
    const PanelH = rtH.load(BRICKS).default;
    const propsH = baseProps({ flows: [FLOW_REC], openFlowId: 'fl1' });
    const panelH = rtH.render(PanelH, propsH);
    check(
      '带 openFlowId 时挂载即载入那条流程（不用自己去下拉里找）',
      codeAreaOf(panelH).props.value.indexOf('page.navigate("/login");') >= 0,
      codeAreaOf(panelH).props.value
    );
    check('自动载入后步骤数对得上（已选步骤 3）', hasText(panelH, '已选步骤（3）'), String(textOf(panelH)).slice(-160));
    check('自动载入也恢复了 POM 配置（generated）', codeAreaOf(panelH).props.value.indexOf('LoginPage loginPage = new LoginPage(page);') >= 0, codeAreaOf(panelH).props.value);

    // 不传 openFlowId 时不该自己载入任何东西（从菜单正常进来必须还是空面板）
    const rtH2 = createRuntime();
    const PanelH2 = rtH2.load(BRICKS).default;
    const panelH2 = rtH2.render(PanelH2, baseProps({ flows: [FLOW_REC] }));
    check('不传 openFlowId 时面板是空的（不会误载入）', hasText(panelH2, '已选步骤（0）'), 'auto loaded unexpectedly');
  }

  /* ---------- 坏 steps（手改过 / 老数据）不能把面板搞崩 ---------- */
  {
    const rt7 = createRuntime();
    const Panel7 = rt7.load(BRICKS).default;
    const bad = { id: 'bad', collection: 'flows', title: '坏流程', data: { name: '坏流程', pageId: 'pg1', pageName: '登录页', steps: '{not json', pomMode: 'weird' } };
    const props7 = baseProps({ flows: [bad] });
    let panel7 = rt7.render(Panel7, props7);
    nodesOf(panel7, rt7.antd.Select)
      .find((n) => /载入流程/.test(String(n.props.placeholder || '')))
      .props.onChange('bad');
    panel7 = rt7.render(Panel7, props7);
    check('steps 是坏 JSON 时不崩、提示这条流程没步骤', hasText(panel7, '没有能用的步骤'), 'not handled');
    check('脏 pomMode 兜底成「不使用」（单选回到 none）', (() => {
      const radio = collect(panel7).find((n) => n.type === rt7.antd.Radio.Group);
      return radio.props.value === 'none';
    })(), 'pom mode not sanitized');
    check('parseFlowSteps 对坏 JSON 返回空数组', helpers.parseFlowSteps('{not json').length === 0, helpers.parseFlowSteps('{not json'));
    check(
      'parseFlowSteps 跳过已删除的动作（不认识就丢，不抛异常）',
      helpers.parseFlowSteps(JSON.stringify([{ actionId: 'not-exist-action' }, { actionId: 'goto', params: { url: '/' } }])).length === 1,
      helpers.parseFlowSteps(JSON.stringify([{ actionId: 'not-exist-action' }, { actionId: 'goto' }]))
    );
  }

  /* ============================================================
   * 八、「用本页生成的」：产物去哪 + 顺序说明
   * ============================================================ */
  {
    const rt8 = createRuntime();
    const Panel8 = rt8.load(BRICKS).default;
    const calls8 = { pom: 0 };
    let props8 = baseProps({ pomReady: false, onGoGeneratePom: () => (calls8.pom += 1) });
    let panel8 = rt8.render(Panel8, props8);

    const radio8 = collect(panel8).find((n) => n.type === rt8.antd.Radio.Group);
    radio8.props.onChange({ target: { value: 'generated' } });
    panel8 = rt8.render(Panel8, props8);

    check('选中「用本页生成的」时出现状态提示', hasText(panel8, '还没生成'), 'no pom status');
    check('未生成时是 ⚠ 且写明类名', hasText(panel8, '⚠ 类名 LoginPage 还没生成'), 'wrong status text');
    const goBtn = nodesOf(panel8, rt8.antd.Button).find((n) => textOf(n) === '去生成页面对象类 →');
    check('未生成时有「去生成页面对象类」入口', !!goBtn, nodesOf(panel8, rt8.antd.Button).map(textOf));
    check('提示里写清了顺序（① 先生成 POM 类 → ② 再回来拼方法体）', hasText(panel8, '① 先在「页面对象类」生成 POM 类') && hasText(panel8, '② 再回来用积木拼方法体'), 'no order hint');
    goBtn.props.onClick();
    check('点「去生成页面对象类」会回调到页面（切视图 + 触发生成）', calls8.pom === 1, calls8.pom);

    // 生成过之后（pomReady = true）→ 变成 ✅ 并给「先看页面对象类」
    props8 = Object.assign({}, props8, { pomReady: true });
    panel8 = rt8.render(Panel8, props8);
    check('本会话生成过之后变成 ✅', hasText(panel8, '✅ 类名 LoginPage 已生成过'), 'no ok status');
    check('生成过之后入口变成「先看页面对象类 →」', nodesOf(panel8, rt8.antd.Button).some((n) => textOf(n) === '先看页面对象类 →'), 'no view link');
    check('生成过之后不再显示「去生成页面对象类」', !nodesOf(panel8, rt8.antd.Button).some((n) => textOf(n) === '去生成页面对象类 →'), 'still asking to generate');

    // 选「不使用」时不出现这段提示（不干扰）
    const radio8b = collect(panel8).find((n) => n.type === rt8.antd.Radio.Group);
    radio8b.props.onChange({ target: { value: 'none' } });
    panel8 = rt8.render(Panel8, props8);
    check('POM 选「不使用」时不显示产物提示', !hasText(panel8, '① 先在「页面对象类」生成 POM 类'), 'noise');
  }

  /* ============================================================
   * 九、CodegenPage 接线：写库 / 记 POM 状态 / 切视图 / 状态保留
   * ============================================================ */
  check('CodegenPage 把流程记录写进 flows 集合', /collection: 'flows'/.test(codegenSrc) && /api\.saveRecord\(/.test(codegenSrc), 'no saveRecord');
  check('CodegenPage 启动时读 flows 集合', /api\.records\('flows'\)/.test(codegenSrc), 'no flows load');
  check('CodegenPage 生成 POM 后记住「这个页面已生成」', /setPomReadyKeys/.test(codegenSrc) && /if \(kind === 'page'\)/.test(codegenSrc), 'pom state not tracked');
  check('CodegenPage 的「去生成」会切到页面对象类并触发生成', /setPageView\('pom'\)/.test(codegenSrc) && /void doPreview\(\)/.test(codegenSrc), 'no go-pom handler');
  check(
    'CodegenPage 把 flows / 保存回调 / POM 状态传给积木区',
    /flows=\{flows\}/.test(codegenSrc) &&
      /onSaveFlow=\{doSaveFlow\}/.test(codegenSrc) &&
      /onGoGeneratePom=\{doGoPom\}/.test(codegenSrc) &&
      /pomReady=\{/.test(codegenSrc),
    'props not wired'
  );
  check(
    'CodegenPage 用 ref 兜住积木区状态（切视图回来步骤不丢）',
    /bricksStateRef/.test(codegenSrc) && /initialState=\{bricksStateRef\.current\}/.test(codegenSrc),
    'no state persistence'
  );
  check('CodegenPage 的「已载入」Tag 也加了元素 tooltip', /ElementCountTipLazy/.test(codegenSrc) && /<ElementCountTipLazy elements=\{elements\}>/.test(codegenSrc), 'page hint tip missing');
  check('载入提示「已载入：X（N 个元素）」格式没变', /已载入：\$\{d\.name \|\| '未命名页面'\}（\$\{els\.length\} 个元素）/.test(codegenSrc), 'hint format changed');

  const mockSrc = read(MOCK);
  check('预览 mock 里有 flows 示例（浏览器预览能点「载入流程」）', /flows:\s*\[/.test(mockSrc) && mockSrc.indexOf('登录页流程-1125') >= 0, 'no mock flows');

  /* ============================================================
   * 十、真实 React + antd 渲染（防 antd 用法写错）
   * ============================================================ */
  function createRealLoader() {
    const cache = new Map();
    function load(file) {
      const abs = path.resolve(file);
      if (cache.has(abs)) return cache.get(abs);
      const src = read(abs);
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

  let realHtml = '';
  let realErr = '';
  try {
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const RealBricks = createRealLoader()(BRICKS).default;
    realHtml = renderToStaticMarkup(
      React.createElement(RealBricks, {
        pages: PAGES,
        pageId: 'pg1',
        onSelectPage: () => {},
        pageName: '登录页',
        pageUrl: '/login',
        elements: FOUR,
        lang: 'java',
        onCopy: () => {},
        flows: [FLOW_REC],
        onSaveFlow: () => true,
        onNotify: () => {},
        pomReady: true,
        onGoGeneratePom: () => {},
        initialState: { steps: SAVE_BOOT.steps, pomMode: 'generated', pomClass: '', pomVar: '' },
        onStateChange: () => {}
      })
    );
  } catch (e) {
    realErr = (e && e.message) || String(e);
  }
  check('真实 React + antd 能渲染积木区（含 flows 下拉 / POM 提示）', !realErr && realHtml.length > 1000, realErr || realHtml.length);
  check(
    '真实渲染结果里有「保存为流程」「载入流程」「已生成过」',
    realHtml.indexOf('保存为流程') >= 0 && realHtml.indexOf('载入流程') >= 0 && realHtml.indexOf('已生成过') >= 0,
    'missing text'
  );

  /* ============================================================
   * 汇总
   * ============================================================ */
  const failed = results.filter((r) => !r.ok);
  console.log('===== 积木保存 + 元素 hover 提示测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();