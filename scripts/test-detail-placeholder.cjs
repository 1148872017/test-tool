'use strict';
/**
 * 「页面元素-记录详情」元素定位器表格 + 「代码生成」接口下拉 placeholder 的单元测试。
 *
 * 覆盖两大块：
 *   1. RecordDetail 的 elements 字段：只读 3 列表格（名称 / 定位值 / 说明）、
 *      定位值等宽字体、空值「-」、空元素「无」、mode 标签（Role / TestId …）、
 *      表格上方的「复制」按钮（复制可粘贴的纯文本，不是 markdown 表格）。
 *      这里不只做源码正则：用 esbuild + 迷你 hooks 运行时**真渲染**组件，检查虚拟节点树。
 *   2. CodegenPage 的每一个 Select 都有 placeholder；接口记录下拉的 placeholder
 *      在 antd v5 里真能显示（value="" 会把它吞掉，这是用户反馈的根因）。
 *
 * 纯 unit 档：只读仓库源码 + 在 node 里渲染，不碰任何本机真实资产，不设环境变量也能跑。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const DETAIL = path.join(ROOT, 'src', 'components', 'RecordDetail.tsx');
const CODEGEN = path.join(ROOT, 'src', 'pages', 'CodegenPage.tsx');
const UTILS = path.join(ROOT, 'src', 'utils.ts');

/** 去掉注释再做源码守卫：注释里会写到旧写法（String(raw) / placeholder 说明），别把自己的说明文字当违规代码 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/* ============================================================
 * 0. 迷你 hooks 运行时（让组件函数真的能被调用，不需要 React / DOM）
 * ============================================================ */

const hookSlots = [];
let hookIndex = 0;
let pendingEffects = [];
let dirty = false;
let componentFn = null;

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
    if (!(i in hookSlots)) hookSlots[i] = { value: typeof init === 'function' ? init() : init };
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
    pendingEffects.push({ i: hookIndex++, fn, deps });
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
    hookSlots[e.i] = { deps: e.deps, cleanup: e.fn() };
  }
}

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
 * 1. 虚拟节点 + 依赖桩
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
const antdProxy = makeProxy();
const iconsProxy = makeProxy();

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

/** 节点里的纯文本（递归拼叶子字符串） */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.props ? node.props.children : '');
  return '';
}

function loadTsxModule(file, stubs) {
  const src = fs.readFileSync(file, 'utf8');
  const { code } = esbuild.transformSync(src, {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
    target: 'node18',
    charset: 'utf8'
  });
  const mod = { exports: {} };
  const requireStub = (id) => {
    if (!stubs[id]) throw new Error('测试没有为这个依赖准备桩：' + id);
    return stubs[id]();
  };
  new Function('require', 'module', 'exports', code)(requireStub, mod, mod.exports);
  return mod.exports;
}

/** PageElementsEditor：要它真的 parseElements / normalizeMode，不自己再写一份解析 */
const editor = loadTsxModule(path.join(ROOT, 'src', 'components', 'PageElementsEditor.tsx'), {
  react: () => hooks,
  'react/jsx-runtime': () => jsxRuntime,
  antd: () => antdProxy,
  '@ant-design/icons': () => iconsProxy,
  '../../shared/locatorModes': () => require('../shared/locatorModes.js')
});

const noopComp = () => null;
const detail = loadTsxModule(DETAIL, {
  react: () => hooks,
  'react/jsx-runtime': () => jsxRuntime,
  antd: () => antdProxy,
  '@ant-design/icons': () => iconsProxy,
  marked: () => ({ __esModule: true, marked: { setOptions: () => {}, parse: (s) => String(s) }, default: { setOptions: () => {}, parse: (s) => String(s) } }),
  dompurify: () => ({ sanitize: (s) => s }),
  '../api': () => ({
    __esModule: true,
    default: {
      copy: async () => {},
      openUrl: async () => {},
      settings: async () => ({}),
      records: async () => [],
      linksForApi: async () => [],
      removeRecord: async () => {},
      linkRemove: async () => {}
    }
  }),
  '../msg': () => ({ __esModule: true, toast: () => {} }),
  '../utils': () => ({
    __esModule: true,
    fmtTime: () => '2026-01-01 00:00',
    recordToText: () => '',
    buildCurl: () => ''
  }),
  './JsonTableToggle': () => ({ __esModule: true, default: noopComp }),
  './VarsEditor': () => ({ __esModule: true, default: noopComp }),
  './MetricsTable': () => ({ __esModule: true, default: noopComp }),
  './ScenePicker': () => ({ __esModule: true, default: noopComp }),
  './AccountsEditor': () => ({ __esModule: true, default: noopComp }),
  './VarFillModal': () => ({ __esModule: true, default: noopComp }),
  './CaseLinkModal': () => ({ __esModule: true, default: noopComp }),
  /*
   * RecordDetail 现在自带一层错误边界（一条脏数据不该顶掉整页）和 failed 空状态。
   * 桩：错误边界直接透传 children —— 本套件要断言的是「正常渲染出来的结构」，
   * 真实边界在没有异常时也确实只返回 children。
   */
  './feedback/ErrorBoundary': () => ({ __esModule: true, default: (props) => (props ? props.children : null) }),
  './states/StateEmpty': () => ({ __esModule: true, default: noopComp }),
  /* 执行类型标签改从 shared/collections 的 RUN_KIND_OPTIONS 取（加了 ui 之后不能再二分），
     直接要真模块 —— 标签文案变了这条断言才跟着变。 */
  '../../shared/collections': () => require('../shared/collections.js'),
  '../caseIndex': () => ({ __esModule: true, caseKey: () => '', knownCaseKeys: () => new Set(), loadCaseIndex: async () => [] }),
  '../../shared/runs': () => ({ __esModule: true, matchOnlyFor: () => true, recentForApi: () => [], resultTone: () => '', runLine: () => '' }),
  '../options': () => ({
    __esModule: true,
    asArray: (v) => (Array.isArray(v) ? v : []),
    fieldOptions: () => [],
    getOptionsSync: () => ({}),
    loadOptions: async () => ({})
  }),
  './PageElementsEditor': () => editor
});

/* ============================================================
 * 2. 纯函数：elementsToText / elementModeTag / elementLocatorText
 * ============================================================ */

const { elementsToText, elementModeTag, elementLocatorText } = detail;

const ELEMENTS = [
  { name: 'usernameInput', selector: '#username', desc: '用户名输入框' },
  { name: 'passwordInput', selector: '#password', desc: '密码输入框' },
  { name: 'submitBtn', selector: 'button[type=submit]', desc: '登录按钮' }
];
const ELEMENTS_JSON = JSON.stringify(ELEMENTS);

check('模块导出 elementsToText', typeof elementsToText === 'function', typeof elementsToText);
check('模块导出 elementModeTag', typeof elementModeTag === 'function', typeof elementModeTag);

check('elementsToText：3 个元素出 4 行（含表头）', elementsToText(ELEMENTS_JSON).split('\n').length === 4, elementsToText(ELEMENTS_JSON));
check('elementsToText：表头是 名称/定位值/说明（制表符分隔，不是 markdown）', elementsToText(ELEMENTS_JSON).split('\n')[0] === '名称\t定位值\t说明', elementsToText(ELEMENTS_JSON).split('\n')[0]);
check('elementsToText：单行是 name<TAB>selector<TAB>desc', elementsToText(ELEMENTS_JSON).split('\n')[1] === 'usernameInput\t#username\t用户名输入框', elementsToText(ELEMENTS_JSON).split('\n')[1]);
check('elementsToText：不是 markdown 表格（不含 |）', !elementsToText(ELEMENTS_JSON).includes('|'), elementsToText(ELEMENTS_JSON));
check('elementsToText：空 name / desc 补「-」', elementsToText('[{"name":"a","selector":"#a"}]').split('\n')[1] === 'a\t#a\t-', elementsToText('[{"name":"a","selector":"#a"}]').split('\n')[1]);
check('elementsToText：空数组回空串', elementsToText('[]') === '' && elementsToText('') === '', [elementsToText('[]'), elementsToText('')]);
check('elementsToText：老的多行文本格式也认（parseElements 复用）', elementsToText('a = #a\nb = #b').split('\n').length === 3, elementsToText('a = #a\nb = #b'));

check('mode=role 复制成 [Role] button:登录', elementsToText(JSON.stringify([{ name: 'loginBtn', mode: 'role', selector: 'button:登录', desc: '登录按钮' }])).split('\n')[1] === 'loginBtn\t[Role] button:登录\t登录按钮', elementsToText(JSON.stringify([{ name: 'loginBtn', mode: 'role', selector: 'button:登录', desc: '登录按钮' }])).split('\n')[1]);
check('mode=testid 复制成 [TestId] submit', elementLocatorText({ name: 'x', mode: 'testid', selector: 'submit', desc: '' }) === '[TestId] submit', elementLocatorText({ name: 'x', mode: 'testid', selector: 'submit', desc: '' }));
check('mode=css / 缺 mode 不带标签', elementLocatorText({ name: 'x', mode: 'css', selector: '#x', desc: '' }) === '#x' && elementLocatorText({ name: 'x', selector: '#x', desc: '' }) === '#x', elementLocatorText({ name: 'x', selector: '#x', desc: '' }));
check('elementModeTag：css / 缺省 → 空串', elementModeTag('css') === '' && elementModeTag(undefined) === '', [elementModeTag('css'), elementModeTag(undefined)]);
check('elementModeTag：大小写不敏感', elementModeTag('Role') === 'Role', elementModeTag('Role'));
check('elementModeTag：脏值兜底成 css（不显示标签）', elementModeTag('garbage') === '', elementModeTag('garbage'));
check('定位值为空时仍给「-」（不会留空）', elementLocatorText({ name: 'x', mode: 'role', selector: '', desc: '' }) === '[Role] -', elementLocatorText({ name: 'x', mode: 'role', selector: '', desc: '' }));

/* ============================================================
 * 3. 真渲染 RecordDetail：表格结构 / 空态 / 标签 / 复制按钮
 * ============================================================ */

const CONF = {
  key: 'pages',
  name: '页面元素',
  titleField: 'name',
  fields: [
    { key: 'name', label: '页面名', type: 'text' },
    { key: 'url', label: '页面路径', type: 'text' },
    { key: 'elements', label: '元素定位器', type: 'elements' }
  ]
};

function makeRecord(elementsValue) {
  return {
    id: 'p1',
    title: '登录页',
    favorite: 0,
    tags: [],
    updated_at: 1700000000000,
    data: { name: '登录页', url: '/login', elements: elementsValue }
  };
}

function mountDetail(record) {
  hookSlots.length = 0;
  hookIndex = 0;
  pendingEffects = [];
  dirty = false;
  componentFn = detail.default;
  const props = { record, conf: CONF, linkMap: {}, onClose: () => {}, onEdit: () => {}, onDeleted: () => {} };
  const tree = runRenderLoop(props);
  return { tree, nodes: collect(tree, []) };
}

/** 虚拟节点是组件（antd 假组件）时取它的名字 */
const compName = (n) => (n && typeof n.type === 'function' && n.type.__name) || '';

const mounted = mountDetail(makeRecord(ELEMENTS_JSON));
const allNodes = mounted.nodes;
const table = allNodes.find((n) => n.type === 'table');

check('详情里 elements 渲染成了 table（不再是 JSON 字符串）', !!table, allNodes.filter((n) => n.type === 'table').length);
check('表格是只读的（没有任何输入框 / 编辑控件）', !!table && !collect(table, []).some((n) => n.type === 'input' || n.type === 'textarea' || compName(n) === 'Input'), 'found input in table');

{
  const ths = table ? collect(table, []).filter((n) => n.type === 'th').map(textOf) : [];
  check('表格 3 列：名称 / 定位值 / 说明', ths.join('|') === '名称|定位值|说明', ths);
}

{
  const dataRows = table
    ? collect(table, [])
        .filter((n) => n.type === 'tr')
        .filter((tr) => Array.isArray(tr.props.children) && tr.props.children[0] && tr.props.children[0].type === 'td')
    : [];
  check('3 个元素渲染 3 行数据', dataRows.length === 3, dataRows.length);
  const cells = dataRows.map((tr) => tr.props.children);
  check('第一行：名称 / 定位值 / 说明都对上号', textOf(cells[0][0]) === 'usernameInput' && textOf(cells[0][1]) === '#username' && textOf(cells[0][2]) === '用户名输入框', cells[0].map(textOf));
  check('第三行定位值是 button[type=submit]', textOf(cells[2][1]) === 'button[type=submit]', textOf(cells[2][1]));
  check('定位值单元格用等宽字体（className 含 mono）', /mono/.test(String(cells[0][1].props.className || '')), cells[0][1].props.className);
  check('css 定位值不加 mode 标签', !collect(cells[0][1], []).some((n) => compName(n) === 'Tag'), 'unexpected Tag');
}

{
  // 语义化定位：定位值列前面要有小标签
  const withMode = JSON.stringify([
    { name: 'loginBtn', mode: 'role', selector: 'button:登录', desc: '登录按钮' },
    { name: 'submitBtn', mode: 'testid', selector: 'submit', desc: '提交' },
    { name: 'grid', mode: 'xpath', selector: '//div[@id="x"]', desc: '表格' }
  ]);
  const m = mountDetail(makeRecord(withMode));
  const t = m.nodes.find((n) => n.type === 'table');
  const dataRows = collect(t, [])
    .filter((n) => n.type === 'tr')
    .filter((tr) => Array.isArray(tr.props.children) && tr.props.children[0].type === 'td');
  const tagsOf = (tr) => collect(tr.props.children[1], []).filter((n) => compName(n) === 'Tag').map(textOf);
  check('mode=role 的定位值前面有 [Role] 标签', tagsOf(dataRows[0]).join('') === 'Role', tagsOf(dataRows[0]));
  check('mode=testid 的标签是 TestId', tagsOf(dataRows[1]).join('') === 'TestId', tagsOf(dataRows[1]));
  check('mode=xpath 也有标签（非 css 一律标）', tagsOf(dataRows[2]).join('') === 'XPath', tagsOf(dataRows[2]));
  check('标签和定位值在同一格且定位值仍完整', textOf(dataRows[0].props.children[1]) === 'Rolebutton:登录', textOf(dataRows[0].props.children[1]));
}

{
  const m = mountDetail(makeRecord(ELEMENTS_JSON));
  const texts = m.nodes.map(textOf);
  check('表格上方有数量标题「元素定位器（3 个）」', texts.some((s) => s.includes('元素定位器') && s.includes('（3 个）')), texts.filter((s) => s.includes('元素定位器')));
  const copyBtns = m.nodes.filter((n) => compName(n) === 'Button' && textOf(n).trim() === '复制');
  check('表格上方保留了「复制」按钮', copyBtns.length >= 2, copyBtns.length);
  const elCopyBtn = copyBtns.find((n) => /elementsToText/.test(String(n.props.onClick || '')));
  check('元素表格的复制按钮复制可粘贴文本（elementsToText）', !!elCopyBtn, copyBtns.map((n) => String(n.props.onClick || '')));
}

{
  const m = mountDetail(makeRecord(''));
  const texts = m.nodes.map(textOf);
  check('元素为空时显示「无」', texts.some((s) => s.trim() === '无'), texts.filter((s) => s.includes('无')));
  check('元素为空时不渲染空表格', !m.nodes.some((n) => n.type === 'table'), m.nodes.filter((n) => n.type === 'table').length);
  check('元素为空时不显示数量标题', !texts.some((s) => s.includes('（0 个）')), texts.filter((s) => s.includes('个')));
}

{
  const m = mountDetail(makeRecord('[{"name":"a","selector":"#a","desc":""}]'));
  const texts = m.nodes.map(textOf);
  check('说明为空时补「-」', texts.some((s) => s === '-'), texts);
}

/* ============================================================
 * 4. 源码守卫：实现方式不被改回去
 * ============================================================ */

const detailSrc = stripComments(fs.readFileSync(DETAIL, 'utf8'));

check('RecordDetail 从 PageElementsEditor 导入 parseElements（复用纯函数）', /import\s*\{[^}]*\bparseElements\b[^}]*\}\s*from\s*'\.\/PageElementsEditor'/.test(detailSrc), 'no parseElements import');
check('elements 分支用 parseElements(raw) 解析，不自己再解析一遍', /const rows = parseElements\(raw\)/.test(detailSrc), 'not using parseElements');
check('elements 走独立渲染分支（f.type === elements）', /f\.type === 'elements' \?/.test(detailSrc) || /case 'elements'/.test(detailSrc), 'no elements branch');
check('复制按钮调用 elementsToText（不是 JSON.stringify / markdown）', /copy\(elementsToText\(raw\)/.test(detailSrc), 'copy not using elementsToText');
{
  const fnAt = detailSrc.indexOf('export function elementsToText');
  // 只截这个函数体：再往后就是组件（里面有 'text' | 'json' 这种联合类型，会误伤「不含 |」的判断）
  const fnEnd = detailSrc.indexOf('type Props', fnAt);
  const fnBody = fnAt >= 0 ? detailSrc.slice(fnAt, fnEnd > 0 ? fnEnd : fnAt + 600) : '';
  check('elementsToText 用制表符拼接（可粘贴，不是 markdown）', /\.join\('\\t'\)/.test(fnBody) && !/'\s*\|\s*'/.test(fnBody), fnBody.slice(0, 200));
}
{
  // 从 renderElements 开始找「空元素」分支，别抓到 elementsToText 里同名的 if (!rows.length)
  const startAt = detailSrc.indexOf('const renderElements');
  const emptyAt = startAt >= 0 ? detailSrc.indexOf('if (!rows.length)', startAt) : -1;
  // 截到同级缩进的 if 收尾（再往后就是带 table 的正常分支）
  const emptyEnd = emptyAt >= 0 ? detailSrc.indexOf('\n    }', emptyAt) : -1;
  const emptyBody = emptyAt >= 0 ? detailSrc.slice(emptyAt, emptyEnd > 0 ? emptyEnd : emptyAt + 400) : '';
  check('空元素分支里只给「无」，没有 table', /无/.test(emptyBody) && !/<table/.test(emptyBody), emptyBody.slice(0, 240));
}
check('定位值单元格带 className="mono"', /<td className="mono"/.test(detailSrc), 'no mono cell');
check('mode 标签只在非 css 时渲染（tag ? 条件）', /const tag = elementModeTag\(el\.mode\)/.test(detailSrc) && /\{tag \?/.test(detailSrc), 'tag not conditional');

/* ============================================================
 * 5. CodegenPage：每个 Select 都有 placeholder
 * ============================================================ */

const codegenSrc = stripComments(fs.readFileSync(CODEGEN, 'utf8'));

/** 取出每个 <Select ... /> 的完整标签文本（CodegenPage 里都是自闭合） */
function selectTags(src) {
  const out = [];
  const re = /<Select(\s|$)/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    const selfClose = src.indexOf('/>', start);
    const closing = src.indexOf('</Select>', start);
    let stop;
    if (selfClose >= 0 && (closing < 0 || selfClose < closing)) stop = selfClose + 2;
    else if (closing >= 0) stop = closing + '</Select>'.length;
    else stop = src.length;
    out.push(src.slice(start, stop));
    re.lastIndex = stop;
  }
  return out;
}

const selects = selectTags(codegenSrc);
check('CodegenPage 里扫到 5 个 Select（生成目标 / 接口记录 / 文件接口 / 页面 / 定位方式）', selects.length === 5, selects.length);

const missing = selects.filter((s) => !/placeholder=/.test(s));
check('每个 Select 都有 placeholder（逐个检查，不是只查第一个）', missing.length === 0, missing.map((s) => s.split('\n')[0] + ' ...' + s.slice(-60)));

const apiSelect = selects.find((s) => s.includes('选一个接口记录')) || '';
check('接口记录下拉的 placeholder 含「接口」字样', /placeholder=\{[^}]*选一个接口记录/.test(apiSelect), apiSelect.slice(0, 200));
check('接口记录下拉的 value 用 undefined 兜底（antd 的 "" 会吞 placeholder）', /value=\{apiId \|\| undefined\}/.test(apiSelect), apiSelect.slice(0, 200));

const fileSelect = selects.find((s) => s.includes('openapiItems.map')) || '';
check('OpenAPI 文件分支的接口下拉也有 placeholder', /placeholder="[^"]*接口[^"]*"/.test(fileSelect), fileSelect.slice(0, 200));
check('文件分支的 value 也兜底成 undefined（初值 -1）', /value=\{openapiIdx >= 0 \? openapiIdx : undefined\}/.test(fileSelect), fileSelect.slice(0, 200));

const pageSelect = selects.find((s) => s.includes('pages.map')) || '';
check('页面元素下拉的 placeholder 仍在（v0.44 的不能丢）', /选一个已保存的页面/.test(pageSelect), pageSelect.slice(0, 160));

/* ============================================================
 * 6. antd 实测：value="" 会吞掉 placeholder（根因证据）
 * ============================================================ */

{
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { Select } = require('antd');
  const PH = '选一个接口记录（会用它生成测试类）';

  const htmlEmpty = renderToStaticMarkup(React.createElement(Select, { value: '', placeholder: PH, options: [] }));
  check('antd v5：受控 value="" 时 placeholder 不渲染（这就是「接口下拉缺提示」的根因）', !htmlEmpty.includes(PH), htmlEmpty.slice(0, 160));

  const htmlUndef = renderToStaticMarkup(React.createElement(Select, { value: undefined, placeholder: PH, options: [] }));
  check('antd v5：value=undefined 时 placeholder 正常渲染', htmlUndef.includes(PH), htmlUndef.slice(0, 160));

  const htmlNum = renderToStaticMarkup(React.createElement(Select, { value: -1, placeholder: PH, options: [] }));
  check('antd v5：value=-1（文件分支初值）同样吞 placeholder', !htmlNum.includes(PH), htmlNum.slice(0, 160));
}

/* ============================================================
 * 7. recordToText 的 elements 现状（不在本任务可改范围，记进 notes）
 * ============================================================ */

{
  const utilsSrc = fs.readFileSync(UTILS, 'utf8');
  check(
    'recordToText 仍未特殊处理 elements（utils.ts 不在本任务可改范围，已写进 notes 建议）',
    !/elements/.test(utilsSrc),
    utilsSrc.split('\n').filter((l) => /elements/.test(l))
  );
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log('===== 记录详情元素表格 + 代码生成 placeholder 测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);