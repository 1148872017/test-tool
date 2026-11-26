'use strict';
/**
 * 页面元素编辑 + 代码生成联动 的单元测试。
 *
 * 重点防两类事故：
 *   1. Bug A（会真丢数据）：编辑已有页面记录 → elements 异步加载 → 组件没回填 →
 *      一保存就把 elements 写成空串。这里不只测 parse/serialize，还**真跑组件**：
 *      用 esbuild 把 TSX 转成 CJS，再套一个极小的 hooks 运行时（不需要 React / DOM），
 *      驱动「挂载 → 外部值到达 → 输入 → 父组件回写 → 保存」整条路径。
 *   2. Bug B：代码生成页从「页面元素」载入带不出元素；
 *      以及预览文件名不完整（中文页面名被 camel 吃成「页」→ `页Page.java`）。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const cg = require('../shared/codegen.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
const skip = (name) => results.push({ name, ok: true, extra: '', skipped: true });

const ROOT = path.join(__dirname, '..');
/** codegen 片段解析器的真模块（懒加载，editor 的 require 桩里回填） */
let snippetMod = null;
const EDITOR = path.join(ROOT, 'src', 'components', 'PageElementsEditor.tsx');
const SNIFF_PANEL = path.join(ROOT, 'src', 'components', 'SniffPanel.tsx');
const CODEGEN_PAGE = path.join(ROOT, 'src', 'pages', 'CodegenPage.tsx');

/* ============================================================
 * 0.0 实时校验的 api 桩（记下每次调用的入参）
 *
 * v0.56 有三个真机 bug 要靠这些入参验：
 *   bugC 每次启动都要带浏览器选择；bugD 连点只能发一次 start。
 * ============================================================ */
const sniffCalls = { start: [], highlight: [], reopen: [], stop: 0 };
const sniffOk = (p) =>
  Object.assign(
    {
      ok: true,
      running: true,
      browser: 'chrome',
      browserChosen: 'auto',
      url: String((p && p.url) || ''),
      name: String((p && p.name) || ''),
      mode: String((p && p.mode) || 'css'),
      selector: String((p && p.selector) || ''),
      found: 1,
      total: 1,
      visible: true,
      inIframe: false,
      reason: '',
      message: ''
    },
    {}
  );
const sniffApi = {
  sniffStart: async (p) => {
    sniffCalls.start.push(p);
    return sniffOk(p);
  },
  sniffHighlight: async (p) => {
    sniffCalls.highlight.push(p);
    return sniffOk(p);
  },
  sniffReopen: async (p) => {
    sniffCalls.reopen.push(p);
    return sniffOk(Object.assign({}, p && typeof p === 'object' ? p : { url: p }));
  },
  sniffStatus: async () => ({ ok: true, running: true }),
  sniffStop: async () => {
    sniffCalls.stop += 1;
    return { ok: true, running: false, message: '浏览器已关闭' };
  }
};

/* ============================================================
 * 0. 迷你 hooks 运行时：让组件函数可以真的被调用
 * ============================================================ */

const hookSlots = [];
let hookIndex = 0;
let pendingEffects = [];
let dirty = false;
let componentFn = null;

function depsChanged(prev, deps) {
  if (!prev || !('deps' in prev)) return true; // 第一次
  if (!deps || !prev.deps) return true; // 没写依赖数组 → 每次渲染都跑
  if (prev.deps.length !== deps.length) return true;
  for (let i = 0; i < deps.length; i++) {
    if (!Object.is(prev.deps[i], deps[i])) return true;
  }
  return false;
}

const hooks = {
  useState(init) {
    const i = hookIndex++;
    if (!(i in hookSlots)) {
      hookSlots[i] = { value: typeof init === 'function' ? init() : init };
    }
    const slot = hookSlots[i];
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
    if (!(i in hookSlots)) hookSlots[i] = { current: init };
    return hookSlots[i];
  },
  useEffect(fn, deps) {
    const i = hookIndex++;
    pendingEffects.push({ i, fn, deps });
  },
  useMemo(fn, deps) {
    const i = hookIndex++;
    const prev = hookSlots[i];
    if (prev && !depsChanged(prev, deps)) return prev.value;
    const value = fn();
    hookSlots[i] = { deps, value };
    return value;
  }
};
hooks.default = hooks;
hooks.__esModule = true;

function flushEffects() {
  for (const e of pendingEffects) {
    const prev = hookSlots[e.i];
    if (!depsChanged(prev, e.deps)) continue;
    if (prev && typeof prev.cleanup === 'function') prev.cleanup();
    const cleanup = e.fn();
    hookSlots[e.i] = { deps: e.deps, cleanup };
  }
}

/** 渲染树（含 setState 触发的重渲染），返回最终树 */
function runRenderLoop(props) {
  let tree;
  let guard = 0;
  for (;;) {
    dirty = false;
    hookIndex = 0;
    pendingEffects = [];
    tree = componentFn(props);
    flushEffects();
    guard += 1;
    if (!dirty || guard > 30) break;
  }
  return tree;
}

/* ============================================================
 * 1. 虚拟节点 + antd 假组件
 * ============================================================ */

const jsx = (type, props, key) => ({ type, props: props || {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };

/** antd 假组件：只当节点占位，记下 props 供断言用 */
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
const antdProxy = makeProxy();
const iconsProxy = makeProxy();

/** 遍历虚拟节点 */
function collect(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  const ch = node.props ? node.props.children : undefined;
  if (ch !== undefined) collect(ch, out);
  return out;
}

/** 表格数据行（header 的 tr 第一个格子是 th，排除掉） */
function rowsOf(tree) {
  return collect(tree, []).filter(
    (n) => n.type === 'tr' && Array.isArray(n.props.children) && n.props.children[0] && n.props.children[0].type === 'td'
  );
}

/** 一个 td 里的输入框节点（定位值那一格还可能跟着提示行 / 预览行，得跳过去） */
function inputOf(td) {
  const nodes = collect(td ? td.props.children : null, []);
  return (
    nodes.find((n) => n && n.props && typeof n.props.value === 'string' && 'placeholder' in n.props) || {
      props: {}
    }
  );
}

/** 一行的 4 个格子（名称 / 定位方式 Select / 定位值 / 说明） */
function cellsOf(row) {
  const tds = row.props.children;
  return [inputOf(tds[0]), tds[1].props.children, inputOf(tds[2]), inputOf(tds[3])];
}

/** [[名称, 定位方式, 定位值, 说明], ...] */
function valuesOf(tree) {
  return rowsOf(tree).map((r) => cellsOf(r).map((c) => c.props.value));
}

/** 虚拟节点是 antd 假组件时取它的名字 */
const compName = (n) => (n && typeof n.type === 'function' && n.type.__name) || '';

/** 节点里的纯文本（递归拼叶子字符串，用来找按钮文案） */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.props ? node.props.children : '');
  return '';
}

/** 树里的实时校验面板（桩组件把 props 原样留在节点上） */
function findSniffPanel(tree) {
  return collect(tree, []).find((n) => n.props && typeof n.props.onRestart === 'function' && 'browserNotice' in n.props) || null;
}

/* ============================================================
 * 2. 载入 TSX 模块（esbuild 转 CJS + 依赖替换）
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
  const stubs = Object.assign(
    {
      react: () => hooks,
      'react/jsx-runtime': () => jsxRuntime,
      antd: () => antdProxy,
      '@ant-design/icons': () => iconsProxy,
      '../../shared/locatorModes': () => require('../shared/locatorModes.js'),
      // 实时校验的两个依赖：
      //   ../api        —— 记入参的桩（bugC/bugD 的断言全靠它）
      //   ./SniffPanel  —— 面板只做展示，桩成占位组件并把 props 原样留在树上
      '../api': () => ({ __esModule: true, default: sniffApi }),
      /**
       * codegen 片段解析器：**用真模块**（纯函数、无依赖），顺便在这里做它的断言。
       * 懒加载避免 loadTsxModule 自己在定义前被调用。
       */
      '../utils/playwrightSnippet': () => {
        if (!snippetMod) snippetMod = loadTsxModule(path.join(ROOT, 'src', 'utils', 'playwrightSnippet.ts'));
        return snippetMod;
      },
      './SniffPanel': () => ({
        __esModule: true,
        default: (props) => ({ __comp: 'SniffPanel', props: props || {} }),
        describeResult: () => ({ lines: [], tone: 'muted' }),
        phaseLabel: () => '',
        browserLabel: () => ''
      })
    },
    extraStubs || {}
  );
  const mod = { exports: {} };
  const requireStub = (id) => {
    if (!stubs[id]) throw new Error('测试没有为这个依赖准备桩：' + id);
    return stubs[id]();
  };
  new Function('require', 'module', 'exports', code)(requireStub, mod, mod.exports);
  return mod.exports;
}

const editor = loadTsxModule(EDITOR);

/**
 * 去掉注释再做源码守卫。
 * 注释里会写到「旧实现是 useMemo(..., [])」「以前写的是 parseElementsShared」，
 * 不剥掉会把自己的说明文字当成违规代码。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Editor 模块必须导出这几个纯函数（测试与页面都靠它们） */
check('模块导出 parseElements', typeof editor.parseElements === 'function', Object.keys(editor));
check('模块导出 serializeElements', typeof editor.serializeElements === 'function');
check('模块导出 dropEmptyElements', typeof editor.dropEmptyElements === 'function');
check('模块导出 initialRows', typeof editor.initialRows === 'function');
check('模块导出 shouldAdoptIncoming', typeof editor.shouldAdoptIncoming === 'function');
check('模块默认导出组件', typeof editor.default === 'function');

const { parseElements, serializeElements, dropEmptyElements, initialRows, shouldAdoptIncoming } = editor;

/* ============================================================
 * 3. parseElements
 * ============================================================ */

const VALUE4 = JSON.stringify([
  { name: 'usernameInput', selector: '#username', desc: '用户名输入框' },
  { name: 'passwordInput', selector: '#password', desc: '密码输入框' },
  { name: 'submitBtn', selector: 'button[type=submit]', desc: '登录按钮' },
  { name: 'rememberBox', selector: '[data-testid=remember]', desc: '记住我' }
]);

{
  const p = parseElements(VALUE4);
  check('JSON 数组解析出 4 个元素', p.length === 4, p.length);
  check('JSON 元素字段完整', p[1].name === 'passwordInput' && p[1].selector === '#password' && p[1].desc === '密码输入框', p[1]);
  check('JSON 里缺的字段补空串', parseElements('[{"name":"a"}]')[0].selector === '', parseElements('[{"name":"a"}]')[0]);
  check('JSON 元素里的非对象被过滤', parseElements('[1,"x",null,{"name":"a"}]').length === 1, parseElements('[1,"x",null,{"name":"a"}]'));

  const text = parseElements('usernameInput = #username\nsubmitBtn = button[type=submit]');
  check('旧文本格式解析出 2 个元素', text.length === 2, text);
  check('旧文本 selector 取等号右边', text[1].selector === 'button[type=submit]', text[1]);
  check('旧文本跳过没有等号的行', parseElements('usernameInput = #u\n这一行没有等号').length === 1, 'no skip');
  check('旧文本跳过名字为空的等号行', parseElements('= #nobody\nb = #b').length === 1, parseElements('= #nobody\nb = #b'));
  check('旧文本 desc 补空串', parseElements('a = #a')[0].desc === '', parseElements('a = #a')[0]);

  check('空串解析为空数组', parseElements('').length === 0);
  check('null 解析为空数组', parseElements(null).length === 0);
  check('undefined 解析为空数组', parseElements(undefined).length === 0);
  check('纯空白解析为空数组', parseElements('   \n\t  ').length === 0);
  check('坏 JSON 不抛异常', (() => {
    try {
      return parseElements('[{"name":').length === 0;
    } catch (e) {
      return false;
    }
  })());
  check('字段首尾空格被去掉', parseElements('[{"name":"  a  ","selector":"  #a  "}]')[0].name === 'a');
}

/* ============================================================
 * 4. serializeElements / 往返
 * ============================================================ */

{
  check('过滤掉名称为空的行', serializeElements([{ name: 'a', selector: '#a', desc: '' }, { name: '   ', selector: '#b', desc: '' }]) === '[{"name":"a","selector":"#a","desc":""}]', serializeElements([{ name: 'a', selector: '#a', desc: '' }, { name: '   ', selector: '#b', desc: '' }]));
  check('全是空行时回空串', serializeElements([{ name: '', selector: '', desc: '' }]) === '');
  check('空数组回空串', serializeElements([]) === '');
  check('序列化去首尾空格', serializeElements([{ name: ' a ', selector: ' #a ', desc: ' 说明 ' }]) === '[{"name":"a","selector":"#a","desc":"说明"}]', serializeElements([{ name: ' a ', selector: ' #a ', desc: ' 说明 ' }]));
  check('名称有值、定位器为空也保留', parseElements(serializeElements([{ name: 'a', selector: '', desc: '' }]))[0].name === 'a');
  check('输出是合法 JSON 数组', Array.isArray(JSON.parse(serializeElements(parseElements(VALUE4)))));

  // 防数据丢失核心：往返后必须一模一样
  const roundTrip = parseElements(serializeElements(parseElements(VALUE4)));
  check('往返深等于原数据', JSON.stringify(roundTrip) === JSON.stringify(parseElements(VALUE4)), roundTrip);
  check('往返元素个数不变', roundTrip.length === 4, roundTrip.length);
  check('往返定位器不丢', roundTrip.map((x) => x.selector).join('|') === parseElements(VALUE4).map((x) => x.selector).join('|'), roundTrip);
  check('中文 desc 往返不丢', parseElements(serializeElements([{ name: 'a', selector: '#a', desc: '用户名输入框' }]))[0].desc === '用户名输入框');
  check('序列化两次结果一致（幂等）', serializeElements(parseElements(serializeElements(parseElements(VALUE4)))) === serializeElements(parseElements(VALUE4)));
  check('dropEmptyElements 保留有值行', parseElements(dropEmptyElements(VALUE4)).length === 4);
  check('dropEmptyElements 丢掉空行', dropEmptyElements(JSON.stringify([{ name: 'a', selector: '#a' }, { name: '', selector: '' }])) === '[{"name":"a","selector":"#a","desc":""}]', dropEmptyElements(JSON.stringify([{ name: 'a', selector: '#a' }, { name: '', selector: '' }])));
}

/* ============================================================
 * 5. initialRows / shouldAdoptIncoming
 * ============================================================ */

{
  check('initialRows：4 个元素给 4 行', initialRows(VALUE4).length === 4, initialRows(VALUE4).length);
  check('initialRows：空串兜底 1 行', initialRows('').length === 1 && initialRows('')[0].name === '');
  check('initialRows：null 兜底 1 行', initialRows(null).length === 1);
  check('initialRows：空 JSON 数组兜底 1 行', initialRows('[]').length === 1, initialRows('[]').length);
  check('initialRows：旧文本格式也能回填', initialRows('a = #a\nb = #b').length === 2, initialRows('a = #a\nb = #b').length);
  check('initialRows：返回的是新数组（不会被外部改到）', initialRows(VALUE4) !== initialRows(VALUE4));

  check('回声识别：外部值 ≠ 自己发的 → 回填', shouldAdoptIncoming(VALUE4, '') === true);
  check('回声识别：外部值 = 自己发的 → 不回填', shouldAdoptIncoming(VALUE4, VALUE4) === false);
  check('回声识别：null 与空串等价', shouldAdoptIncoming(null, '') === false);
  check('回声识别：undefined 与空串等价', shouldAdoptIncoming(undefined, '') === false);
}

/* ============================================================
 * 6. 真跑组件：Bug A 场景
 * ============================================================ */

/** 挂载组件（模拟 RecordForm 打开时 value 还是空串） */
function mount(initialValue) {
  hookSlots.length = 0;
  hookIndex = 0;
  pendingEffects = [];
  dirty = false;
  componentFn = editor.default;

  const h = { emitted: [], tree: null };
  h.props = {
    value: initialValue,
    onChange: (s) => {
      h.emitted.push(s);
      // 父组件是受控的：拿到 onChange 的值后原样传回来（回声）
      h.props = Object.assign({}, h.props, { value: s });
    }
  };
  h.render = (patch) => {
    if (patch) h.props = Object.assign({}, h.props, patch);
    h.tree = runRenderLoop(h.props);
    return h.tree;
  };
  h.render();
  return h;
}

{
  /* 6.1 首帧 value 就有值（新增记录 / 预填） */
  const h = mount(VALUE4);
  const v = valuesOf(h.tree);
  check('首帧有值时表格就是 4 行', v.length === 4, v.length);
  check('首帧定位值列有值', (v[0] || [])[2] === '#username' && (v[2] || [])[2] === 'button[type=submit]', v);

  /* 6.2 空值挂载 → 一行空行可填 */
  const h2 = mount('');
  check('空值挂载时兜底 1 行', valuesOf(h2.tree).length === 1, valuesOf(h2.tree));
  {
    const blankRowValues = valuesOf(h2.tree)[0] || [];
    check('兜底行三个输入格子都是空串', blankRowValues[0] === '' && blankRowValues[2] === '' && blankRowValues[3] === '', blankRowValues);
    check('兜底行的定位方式是 css', blankRowValues[1] === 'css', blankRowValues);
  }

  /* 6.3 Bug A 主场景：elements 异步到达（挂载时还是空串） */
  const h3 = mount('');
  const tree3 = h3.render({ value: VALUE4 }); // 父组件数据加载完成
  const v3 = valuesOf(tree3);
  check('外部值到达后回填成 4 行（Bug A 主场景）', v3.length === 4, v3.length);
  check('回填后定位值列不再是空（Bug A 主场景）', (v3[0] || [])[2] === '#username' && (v3[3] || [])[2] === '[data-testid=remember]', v3);

  /* 6.4 在编辑状态下改名称 → 父组件回写不能把输入冲掉 */
  const firstRow = rowsOf(tree3)[0];
  if (firstRow) cellsOf(firstRow)[0].props.onChange({ target: { value: '用户名输入框-改' } });
  const tree4 = h3.render(); // 父组件收到 onChange，受控回写同一个值
  const v4 = valuesOf(tree4);
  check('编辑后父组件回写不冲掉输入', (v4[0] || [])[0] === '用户名输入框-改', v4[0]);
  check('编辑后行数不变', v4.length === 4, v4.length);
  check('编辑后其它行的定位值没丢', (v4[1] || [])[2] === '#password' && (v4[2] || [])[2] === 'button[type=submit]', v4);
  check('onChange 发出的是完整 JSON', parseElements(h3.emitted[h3.emitted.length - 1] || '').length === 4, h3.emitted[h3.emitted.length - 1]);

  /* 6.5 保存（RecordForm 会调 dropEmptyElements）：不能变成空串 */
  const saved = dropEmptyElements(h3.props.value);
  check('保存时 elements 不会被清空（防丢数据）', saved !== '' && parseElements(saved).length === 4, saved);
  check('保存后 4 个定位器都在', parseElements(saved).map((x) => x.selector).join('|') === parseElements(VALUE4).map((x) => x.selector).join('|'), saved);

  /* 6.6 逐行删除：删到最后一行为 1 行空行，序列化回空串 */
  let tree5 = h3.tree;
  for (let i = 0; i < 4; i++) {
    const rs = rowsOf(tree5);
    const lastRow = rs[rs.length - 1];
    if (!lastRow) break;
    const lastTds = lastRow.props.children;
    lastTds[lastTds.length - 1].props.children.props.onClick(); // 删除按钮（最后一格）
    tree5 = h3.render();
  }
  const v5 = valuesOf(tree5);
  check('删完所有行后仍保留 1 行可填', v5.length === 1, v5.length);
  check('删完所有行后序列化为空串', h3.emitted[h3.emitted.length - 1] === '', h3.emitted[h3.emitted.length - 1]);

  /* 6.7 回归对照：旧实现（空依赖 + 只初始化一次）在同一场景下确实会丢数据 */
  function legacyRowsAtMount(valueAtMount) {
    // 旧代码：useMemo(() => parseElements(value), []) + useState(initial.length ? initial : [空行])
    const initialOnce = parseElements(valueAtMount);
    return initialOnce.length ? initialOnce : [{ name: '', selector: '', desc: '' }];
  }
  const legacyRows = legacyRowsAtMount(''); // 挂载时 elements 还没加载
  check('旧实现会把 elements 写成空串（回归对照）', serializeElements(legacyRows) === '', serializeElements(legacyRows));
  check('新实现同场景不丢数据（修复生效）', serializeElements(initialRows('')).length === 0 && parseElements(saved).length === 4);
}

/* ============================================================
 * 7. 源码守卫：修复点不能被改回去
 * ============================================================ */

{
  const src = stripComments(fs.readFileSync(EDITOR, 'utf8'));
  check('不再用空依赖 useMemo 只取一次初值', !/useMemo\(\s*\(\)\s*=>\s*parseElements\(value\)\s*,\s*\[\]\s*\)/.test(src), 'still useMemo([])');
  check('useState 用惰性初始化', /useState<PageElement\[\]>\(\(\)\s*=>\s*initialRows\(value\)\)/.test(src), 'not lazy');
  check('commit 里记录 lastEmitted', /lastEmitted\.current\s*=\s*s/.test(src), 'no lastEmitted');
  check('useEffect 依赖 value 且识别回声', /shouldAdoptIncoming\(incoming,\s*lastEmitted\.current\)/.test(src) && /\},\s*\[value\]\);/.test(src), 'no resync effect');
}

/* ============================================================
 * 8. Bug B：从「页面元素」载入 + 预览文件名
 * ============================================================ */

{
  const mockSrc = fs.readFileSync(path.join(ROOT, 'src', 'mockApi.ts'), 'utf8');
  const rawEls = [...mockSrc.matchAll(/elements:\s*'([^']*)'/g)].map((m) => m[1]).find((s) => s.includes('usernameInput')) || '';
  const parsed = parseElements(rawEls);
  check('mock 里页面记录的 elements 本身能解析（3 个元素）', parsed.length === 3, parsed);

  const codegenSrc = stripComments(fs.readFileSync(CODEGEN_PAGE, 'utf8'));
  check('CodegenPage 从 PageElementsEditor 导入 parseElements', /import\s*\{[^}]*\bparseElements\b[^}]*\}\s*from\s*'\.\.\/components\/PageElementsEditor'/.test(codegenSrc), 'no import');
  check('CodegenPage 里不再有未定义的 parseElementsShared', !/parseElementsShared/.test(codegenSrc), 'still undefined ref');
  check('载入页面时无条件覆盖元素（不会留着上个页面的）', /setElements\(els\.length \? els : \[\{ name: '', selector: '', desc: '' \}\]\)/.test(codegenSrc), 'conditional set');

  // 中文页面名（mock 里的「登录页」）+ 从记录载入的元素 → 生成 POM
  const pom = cg.generate('playwright-java', { page: { name: '登录页', url: '/login', elements: parsed } });
  check('中文页面名仍生成 LoginPage 类', /public class LoginPage \{/.test(pom.code), pom.code.split('\n').slice(0, 12).join(' / '));
  check('3 个定位器都生成到代码里', (pom.code.match(/public Locator /g) || []).length === 3, (pom.code.match(/public Locator /g) || []).length);
  check('定位器内容带出来了', /page\.locator\("#username"\)/.test(pom.code) && /page\.locator\("button\[type=submit\]"\)/.test(pom.code), 'selector missing');
  check('预览文件名完整：LoginPage.java（不再是 页Page.java）', pom.filename === 'LoginPage.java', pom.filename);
  check('Python 预览文件名：login_page.py', cg.generate('playwright-python', { page: { name: '登录页', url: '/login', elements: parsed } }).filename === 'login_page.py', cg.generate('playwright-python', { page: { name: '登录页', url: '/login', elements: parsed } }).filename);
  check('文件名不再只剩一个汉字', !/^页/.test(pom.filename) && !/PagePage/.test(pom.filename), pom.filename);
  check('页面名为空时也有可用文件名（MyPage.java）', cg.generate('playwright-java', { page: { name: '', url: '/' } }).filename === 'MyPage.java', cg.generate('playwright-java', { page: { name: '', url: '/' } }).filename);
  check('页面名为空但 URL 有内容时从 URL 取名', cg.generate('playwright-java', { page: { name: '用户管理', url: '/user-center/order' } }).filename === 'OrderPage.java', cg.generate('playwright-java', { page: { name: '用户管理', url: '/user-center/order' } }).filename);
  check('类名输入框传 LoginPage 不会变成 LoginPagePage', cg.generate('playwright-java', { page: { name: '登录页', url: '/login' }, className: 'LoginPage' }).filename === 'LoginPage.java');
  check('接口类文件名保持原样（PetApiTest.java）', cg.generate('java-restassured', { api: { name: 'x', method: 'GET', url: '/pet' } }).filename === 'PetApiTest.java');
}

/* ============================================================
 * 9. 优化项：生成类型下拉分组（真跑 groupTargets）
 * ============================================================ */

{
  const codegenModule = loadTsxModule(CODEGEN_PAGE, {
    '../api': () => ({ __esModule: true, default: {} }),
    '../msg': () => ({ __esModule: true, toast: () => {} }),
    '../components/PageElementsEditor': () => editor
  });
  check('CodegenPage 导出 groupTargets', typeof codegenModule.groupTargets === 'function', Object.keys(codegenModule));

  const groups = codegenModule.groupTargets(cg.listTargets());
  check('按语言分成 2 组', groups.length === 2, groups.map((g) => g.label));
  check('Java 组排第一', groups[0].label === 'Java', groups[0].label);
  check('Python 组排第二', groups[1].label === 'Python', groups[1].label);
  check('Java 组有 3 个目标', groups[0].options.length === 3, groups[0].options);
  check('Python 组有 3 个目标', groups[1].options.length === 3, groups[1].options);
  check('分组不丢 target（6 个 key 全在）', groups.reduce((n, g) => n + g.options.length, 0) === 6 && groups.flatMap((g) => g.options.map((o) => o.value)).sort().join(',') === cg.listTargets().map((t) => t.key).sort().join(','), groups);
  check('分组项 label 沿用后端文案', groups[0].options.some((o) => o.label === 'Java · REST Assured'), groups[0].options.map((o) => o.label));
  check('分组里 value 就是 backend target key', groups[1].options.some((o) => o.value === 'playwright-python'), groups[1].options);

  const src = stripComments(fs.readFileSync(CODEGEN_PAGE, 'utf8'));
  check('下拉改用分组 options', /options=\{targetOptions\}/.test(src), 'not grouped');
  check('接口记录下拉有 placeholder 提示', src.includes('选一个接口记录（会用它生成测试类）'), 'no placeholder');
  check('类名输入框有 allowClear', /value=\{className\}[\s\S]{0,200}allowClear/.test(src), 'no allowClear');
}

/* ============================================================
 * 10. 优化项：Playwright 页面元素区域
 * ============================================================ */

{
  const src = stripComments(fs.readFileSync(CODEGEN_PAGE, 'utf8'));
  check('页面下拉支持搜索', /placeholder=\{pages\.length \? '选一个已保存的页面'[\s\S]{0,200}showSearch[\s\S]{0,120}optionFilterProp="label"/.test(src), 'no showSearch');
  check('选中后显示「已载入」Tag', /pageHint/.test(src) && /已载入：/.test(src) && /<Tag color="blue">\{pageHint\}<\/Tag>/.test(src), 'no tag');
  check('载入提示带元素个数', /（\$\{els\.length\} 个元素）/.test(src), 'no count');
  check('页面名输入框有文字标签', /addonBefore="页面名"/.test(src), 'no addonBefore 页面名');
  check('路径输入框有文字标签', /addonBefore="路径"/.test(src), 'no addonBefore 路径');
  check('两个输入框缩到 200 / 180', /addonBefore="页面名"[\s\S]{0,160}width: 200/.test(src) && /addonBefore="路径"[\s\S]{0,160}width: 180/.test(src), 'width');
  check('清空页面下拉时不把 undefined 当 id 查', /if \(!v\) \{[\s\S]{0,120}setPageId\(''\)/.test(src), 'no clear guard');
  check('生成时过滤掉没有名字的元素行', /filledElements/.test(src), 'no filter');
}

/* ---------- codegen 片段解析（v0.54.1） ---------- */
{
  const py = [
    'page.goto("https://www.runoob.com")',
    'page.get_by_role("button", name="登 录").click()',
    'page.get_by_test_id("submit").click()',
    'page.get_by_label("用户名").fill("admin")',
    'page.get_by_placeholder("请输入密码").fill("123")',
    'page.locator("#loginBtn").click()',
    "page.locator(\"//div[@id='x']\").click()",
    'page.get_by_text("提交").click()',
    'page.wait_for_timeout(1000)'
  ].join('\n');
  const js = [
    "await page.goto('https://www.runoob.com');",
    "await page.getByRole('button', { name: '登录' }).click();",
    "await page.getByTestId('submit').click();",
    "await page.locator('#loginBtn').click();"
  ].join('\n');

  const r1 = snippetMod.parsePlaywrightSnippet(py);
  check('codegen(Python)：认出 7 条定位器', r1.rows.length === 7, r1.rows.length);
  check('codegen(Python)：goto / wait 这类动作被忽略', r1.skipped === 2, r1.skipped);
  check('codegen(Python)：role 存成「角色:可访问名」', r1.rows.some((x) => x.mode === 'role' && x.selector === 'button:登 录'), r1.rows.map((x) => x.selector));
  check('codegen(Python)：testid / label / placeholder 都认', ['testid', 'label', 'placeholder'].every((m) => r1.rows.some((x) => x.mode === m)), r1.rows.map((x) => x.mode));
  check('codegen(Python)：// 开头识别成 xpath', r1.rows.some((x) => x.mode === 'xpath' && x.selector.indexOf('//div') === 0));
  check('codegen(Python)：#id 识别成 css', r1.rows.some((x) => x.mode === 'css' && x.selector === '#loginBtn'));
  check('codegen(Python)：产出的 name 都是合法标识符', r1.rows.every((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)), r1.rows.map((x) => x.name));

  const r2 = snippetMod.parsePlaywrightSnippet(js);
  check('codegen(JS)：认出 3 条定位器（goto 忽略）', r2.rows.length === 3, r2.rows.length);
  check('codegen(JS)：getByRole 的 { name } 也能取出来', r2.rows.some((x) => x.mode === 'role' && x.selector === 'button:登录'));

  /**
   * Java 是 v0.55 新加的支持：codegen --target java 的产物是
   *   page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"))
   *   page.getByTestId("submit") / page.locator("#loginBtn")
   * 断言行（assertThat(...)）里也会出现定位器，同样要认出来。
   */
  const java = [
    'page.navigate("https://www.runoob.com");',
    'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录")).click();',
    'page.getByTestId("submit").click();',
    'page.locator("#loginBtn").click();',
    'assertThat(page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))).isVisible();',
    'assertThat(page.getByLabel("用户名")).hasValue("admin");'
  ].join('\n');
  const r3 = snippetMod.parsePlaywrightSnippet(java);
  check('codegen(Java)：认出 5 条定位器（navigate 被忽略）', r3.rows.length === 5, r3.rows.length);
  check('codegen(Java)：navigate 不计入定位器', r3.skipped === 1, r3.skipped);
  check(
    'codegen(Java)：AriaRole.BUTTON + setName 拼成「button:登录」',
    r3.rows.some((x) => x.mode === 'role' && x.selector === 'button:登录'),
    r3.rows.map((x) => x.mode + '|' + x.selector)
  );
  check(
    'codegen(Java)：断言行里的 getByRole 也能认出来',
    r3.rows.some((x) => x.mode === 'role' && x.selector === 'button:提交'),
    r3.rows.map((x) => x.selector)
  );
  check(
    'codegen(Java)：getByTestId / locator(#id) / getByLabel 都认',
    ['testid', 'css', 'label'].every((m) => r3.rows.some((x) => x.mode === m)),
    r3.rows.map((x) => x.mode)
  );
  check('codegen(Java)：产出的 name 也是合法标识符', r3.rows.every((x) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)), r3.rows.map((x) => x.name));

  const dup = snippetMod.parsePlaywrightSnippet(py + '\n' + 'page.get_by_test_id("submit").click()');
  check('codegen：同一定位器重复粘贴会被去重', dup.duplicates === 1 && dup.rows.length === 7, [dup.duplicates, dup.rows.length]);

  const empty = snippetMod.parsePlaywrightSnippet('page.goto("https://x.com")\npage.keyboard.press("Enter")');
  check('codegen：一段没有任何定位器时返回空且不抛错', empty.rows.length === 0 && empty.skipped === 2, empty);

  check('codegen：中文描述兜底成 elN（可当变量名）', snippetMod.toIdentifier('登录', 3) === 'el3', snippetMod.toIdentifier('登录', 3));
  check('codegen：英文短语转驼峰', snippetMod.toIdentifier('login button', 1) === 'loginButton', snippetMod.toIdentifier('login button', 1));
}

/* ============================================================
 * 12. v0.56 bugC / bugD：浏览器选择 + 连点保护 + 面板任何阶段都能「结束校验」
 * ============================================================ */

/** 真 SniffPanel（纯展示、无 hooks）：直接当函数调用，断言它渲染出来的按钮/下拉 */
const panelMod = loadTsxModule(SNIFF_PANEL);

function basePanelProps(patch) {
  return Object.assign(
    {
      phase: 'idle',
      busy: false,
      resp: null,
      error: '',
      sequential: false,
      index: 0,
      total: 0,
      currentName: 'submitBtn',
      currentModeLabel: 'CSS 选择器',
      currentSelector: 'button[type=submit]',
      skipped: [],
      url: 'http://127.0.0.1:8080/login',
      browser: 'auto',
      browserNotice: '',
      onClose: () => {},
      onHighlight: () => {},
      onReopen: () => {},
      onStopBrowser: () => {},
      onNext: () => {},
      onRepeat: () => {},
      onSkip: () => {},
      onStopSeq: () => {},
      onRestart: () => {},
      onBrowserChange: () => {}
    },
    patch || {}
  );
}
const renderPanel = (patch) => panelMod.default(basePanelProps(patch));
const panelNodes = (tree) => collect(tree, []);
const stopButtons = (tree) => panelNodes(tree).filter((n) => compName(n) === 'Button' && textOf(n).trim() === '结束校验');
const restartButtons = (tree) => panelNodes(tree).filter((n) => compName(n) === 'Button' && textOf(n).trim() === '重新开始');
const findBrowserSelect = (tree) => panelNodes(tree).find((n) => n.props && n.props['aria-label'] === '校验用哪个浏览器') || null;

{
  /* 12.1 bugA：任何阶段都有「结束校验」 */
  const phases = ['idle', 'starting', 'ready', 'ended'];
  for (const phase of phases) {
    const tree = renderPanel({ phase, busy: phase === 'starting' });
    check('bugA：phase=' + phase + ' 时面板里有「结束校验」', stopButtons(tree).length === 1, stopButtons(tree).length);
  }

  const errTree = renderPanel({ phase: 'idle', error: '没找到浏览器：请先安装 Microsoft Edge' });
  check('bugA：出错状态下也有「结束校验」（浏览器可能还在后台跑）', stopButtons(errTree).length === 1, stopButtons(errTree).length);
  check('bugA：出错状态把后端 message 原文照抄出来', textOf(errTree).includes('没找到浏览器：请先安装 Microsoft Edge'), textOf(errTree).slice(0, 120));
  check('bugA：未启动时「结束校验」是可点的（真点下去会先 sniffStop 再收面板）', stopButtons(errTree)[0].props.disabled !== true, stopButtons(errTree)[0].props.disabled);
  check('bugA：「结束校验」是 danger 按钮（别和普通操作混在一起）', stopButtons(errTree)[0].props.danger === true, stopButtons(errTree)[0].props.danger);

  /**
   * v0.59：这句提示原来 24 个字，面板一窄就折成两行、把「结束校验」顶歪。
   * 现在压到 13 个字并且 nowrap + 省略号 —— 这里同时守住「短」和「不换行」。
   */
  {
    const HINT = '进度不写台账，关掉即结束';
    // 父容器聚合文本也等于这句，所以再用「带 nowrap 样式」把真正的叶子挑出来
    const hintNodes = panelNodes(renderPanel({ phase: 'ready' })).filter(
      (n) => textOf(n).trim() === HINT && n.props && n.props.style && n.props.style.whiteSpace === 'nowrap'
    );
    check('结束校验旁的提示精简成一句（≤ 14 字）', hintNodes.length === 1 && HINT.length <= 14, hintNodes.map(textOf));
    check(
      '这句提示强制单行（nowrap + 省略号），不会把按钮挤歪',
      hintNodes.length === 1 &&
        hintNodes[0].props.style &&
        hintNodes[0].props.style.whiteSpace === 'nowrap' &&
        hintNodes[0].props.style.textOverflow === 'ellipsis',
      hintNodes.length ? hintNodes[0].props.style : null
    );
    check(
      '完整说法留在 title 里（不换行也不丢信息）',
      hintNodes.length === 1 && /写进台账/.test(String((hintNodes[0].props.title || ''))),
      hintNodes.length ? hintNodes[0].props.title : null
    );
  }

  check('「重新开始」只在未启动 / 已结束时出现', restartButtons(renderPanel({ phase: 'idle' })).length === 1 && restartButtons(renderPanel({ phase: 'ended' })).length === 1 && restartButtons(renderPanel({ phase: 'ready' })).length === 0 && restartButtons(renderPanel({ phase: 'starting' })).length === 0, [restartButtons(renderPanel({ phase: 'ready' })).length, restartButtons(renderPanel({ phase: 'starting' })).length]);
  check('启动中不给「重新开始」（避免看起来又点了一次）', restartButtons(renderPanel({ phase: 'starting', busy: true })).length === 0);
  check('启动中「结束校验」先禁用（正在拉进程，硬关容易留半截会话）', stopButtons(renderPanel({ phase: 'starting', busy: true }))[0].props.disabled === true);
  check('已就绪时「重新高亮 / 重新打开页面」还在', panelNodes(renderPanel({ phase: 'ready' })).some((n) => compName(n) === 'Button' && textOf(n).trim() === '重新高亮') && panelNodes(renderPanel({ phase: 'ready' })).some((n) => compName(n) === 'Button' && textOf(n).trim() === '重新打开页面'));

  /* 12.2 bugD：等回包时按钮 loading（点了有反馈，也不会被连点） */
  check('启动中「重新开始」是 loading（点了立刻有反馈）', restartButtons(renderPanel({ phase: 'idle', busy: true }))[0].props.loading === true);
}

{
  /* 12.3 bugC：浏览器下拉 */
  const select = findBrowserSelect(renderPanel({}));
  check('bugC：面板上有「校验用哪个浏览器」下拉', !!select, panelNodes(renderPanel({})).filter((n) => compName(n) === 'Select').length);
  check('bugC：下拉默认值 auto（跟随系统）', select && select.props.value === 'auto', select && select.props.value);
  check('bugC：下拉 3 个选项：跟随系统 / Edge / Chrome', !!select && (select.props.options || []).map((o) => o.value).join(',') === 'auto,edge,chrome', select && select.props.options);
  check('bugC：选项文案是「跟随系统 / Edge / Chrome」', !!select && (select.props.options || []).map((o) => o.label).join(',') === '跟随系统,Edge,Chrome', select && select.props.options);
  check('bugC：受控值永远不是空串（空串会吞 placeholder 且等于没选）', !!select && (select.props.options || []).every((o) => !!o.value) && (select.props.value || '') !== '', select && select.props.value);

  let picked = '';
  const withHandler = renderPanel({ onBrowserChange: (b) => (picked = b) });
  findBrowserSelect(withHandler).props.onChange('chrome');
  check('bugC：切换把选择交回调用方（由它写 localStorage）', picked === 'chrome', picked);

  /* 12.4 bugC：回显实际用的浏览器（browser + browserChosen） */
  const autoTree = renderPanel({ phase: 'ready', resp: { ok: true, running: true, browser: 'chrome', browserChosen: 'auto' } });
  check('bugC：auto 时回显「Chrome（跟随系统）」', textOf(autoTree).includes('Chrome（跟随系统）'), textOf(autoTree).slice(0, 80));
  const chromeTree = renderPanel({ phase: 'ready', resp: { ok: true, running: true, browser: 'chrome', browserChosen: 'chrome' } });
  check('bugC：强制 chrome 时只显示 Chrome（不写跟随系统）', chromeTree && textOf(chromeTree).includes('Chrome') && !textOf(chromeTree).includes('（跟随系统）'), textOf(chromeTree).slice(0, 80));
  check('bugC：会话结束后不再挂浏览器标签（窗口已经没了，别撒谎）', !textOf(renderPanel({ phase: 'ended', resp: { ok: true, running: false, browser: 'chrome', browserChosen: 'chrome' } })).includes('Chrome'));
  check('bugC：切换后的提示「已切换，重新点校验生效」会显示', textOf(renderPanel({ phase: 'ready', browserNotice: '已切换，重新点校验生效', resp: { ok: true, running: true, browser: 'chrome', browserChosen: 'auto' } })).includes('已切换，重新点校验生效'));
}

{
  /* 12.5 bugC：浏览器选择的存储（key 固定，脏值兜底 auto） */
  check('bugC：localStorage key 是 test-tool.sniff.browser', editor.SNIFF_BROWSER_KEY === 'test-tool.sniff.browser', editor.SNIFF_BROWSER_KEY);
  check('bugC：没存过时默认 auto（跟随系统）', editor.readSniffBrowser() === 'auto', editor.readSniffBrowser());

  const store = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    }
  };
  try {
    editor.writeSniffBrowser('chrome');
    check('bugC：选择写进 localStorage 的那个 key', store.has('test-tool.sniff.browser') && store.get('test-tool.sniff.browser') === 'chrome', [...store.entries()]);
    check('bugC：写进去能读回来', editor.readSniffBrowser() === 'chrome', editor.readSniffBrowser());

    editor.writeSniffBrowser('edge');
    check('bugC：改成 Edge 也能读回来', editor.readSniffBrowser() === 'edge', editor.readSniffBrowser());

    store.set('test-tool.sniff.browser', 'garbage');
    check('bugC：脏值兜底 auto（不会把浏览器启动参数写坏）', editor.readSniffBrowser() === 'auto', editor.readSniffBrowser());
  } finally {
    delete global.window;
  }
}

{
  /* 12.6 bugC + bugD：编辑器真实连点 → 只发一次 start，且带上 browser */
  hookSlots.length = 0;
  hookIndex = 0;
  pendingEffects = [];
  dirty = false;
  componentFn = editor.default;
  const props = {
    value: VALUE4,
    onChange: () => {},
    pageUrl: 'http://127.0.0.1:8080/login'
  };
  let tree = runRenderLoop(props);
  const seqBtn = collect(tree, []).find((n) => compName(n) === 'Button' && textOf(n).includes('按顺序校验'));
  check('编辑器上有「按顺序校验」按钮', !!seqBtn, collect(tree, []).filter((n) => compName(n) === 'Button').map(textOf));

  sniffCalls.start.length = 0;
  seqBtn.props.onClick();
  seqBtn.props.onClick(); // 连点第二下
  check('bugD：连点只发一次 sniff:start（不会起两个浏览器会话）', sniffCalls.start.length === 1, sniffCalls.start.length);
  check('bugC：启动入参带 browser=auto', sniffCalls.start[0] && sniffCalls.start[0].browser === 'auto', sniffCalls.start[0]);
  check('bugC/D：入参仍带 url / 目标（没被新字段冲掉）', sniffCalls.start[0] && sniffCalls.start[0].url === 'http://127.0.0.1:8080/login' && sniffCalls.start[0].name === 'usernameInput' && sniffCalls.start[0].selector === '#username', sniffCalls.start[0]);

  tree = runRenderLoop(props);
  let panel = findSniffPanel(tree);
  check('面板被拉起来并进入顺序模式（sequential=true）', !!panel && panel.props.sequential === true, panel && panel.props.sequential);
  check('面板拿到浏览器受控值（auto）', !!panel && panel.props.browser === 'auto', panel && panel.props.browser);

  panel.props.onBrowserChange('edge');
  tree = runRenderLoop(props);
  panel = findSniffPanel(tree);
  check('切换浏览器后面板受控值变成 edge（并已写入 localStorage 逻辑）', !!panel && panel.props.browser === 'edge', panel && panel.props.browser);
  check('会话存在时给「已切换，重新点校验生效」', !!panel && panel.props.browserNotice === '已切换，重新点校验生效', panel && panel.props.browserNotice);
  check('切换浏览器不会额外发 start（下一次启动才生效）', sniffCalls.start.length === 1, sniffCalls.start.length);
}

{
  /* 12.7 源码守卫：这三条修复不能被改回去 */
  const src = stripComments(fs.readFileSync(EDITOR, 'utf8'));
  check('bugD：startAt 开头有同步闸门（sniffGate）', /if \(sniffGate\.current\) return;/.test(src) && /const sniffGate = useRef/.test(src), 'no gate');
  check('bugD：按顺序校验按钮 loading + disabled', /onClick=\{startSequence\} loading=\{sniff\.busy\} disabled=\{sniff\.busy\}/.test(src), 'toolbar button not locked');
  check('bugC：startAt 的 sniffStart 入参带 browser', /request\('sniffStart', \{[\s\S]{0,220}browser: sniffBrowser/.test(src), 'start payload without browser');
  check('bugC：重新打开页面走 reopenWithBrowser（带上浏览器选择）', /reopenWithBrowser\(request, url, sniffBrowser\)/.test(src), 'reopen without browser');
  check('bugC：切换选择写 localStorage', /writeSniffBrowser\(b\)/.test(src), 'browser choice not persisted');
  check('bugA：面板拿到 onBrowserChange（面板里才有这个下拉）', /onBrowserChange=\{changeSniffBrowser\}/.test(src), 'panel missing onBrowserChange');
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
console.log('===== 页面元素编辑 + 代码生成联动测试 =====');
for (const r of results) {
  console.log((r.skipped ? '  SKIP  ' : r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
}
console.log('\n' + (results.length - failed.length - skipped.length) + '/' + (results.length - skipped.length) + ' passed' + (skipped.length ? '，' + skipped.length + ' 项跳过' : ''));
process.exit(failed.length ? 1 : 0);