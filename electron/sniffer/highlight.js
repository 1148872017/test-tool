'use strict';
/**
 * highlight.js —— 「用系统浏览器实时高亮定位器」的注入脚本生成器。
 *
 * ============================================================
 * 这个文件为什么是纯函数
 * ============================================================
 * 生成器本身跑在主进程，但**产出的代码跑在用户的浏览器页面里**。
 * 两边混在一起就没法单测：所以这里只做「拼字符串 + 解析结果」，不碰 fs / child_process /
 * electron，也不联网。scripts/test-sniff-highlight.cjs 直接 require 本文件就能测。
 *
 * 主进程那边（browser-session.js）负责：起浏览器 → 连 CDP → 把这坨脚本丢进页面 → 读回事实。
 *
 * ============================================================
 * 注入脚本的职责（只有四件，别加戏）
 * ============================================================
 *   1. 按 mode + selector 找元素（9 种定位方式，与 shared/locatorModes.js 同源）；
 *   2. 滚动到可见（scrollIntoView center）；
 *   3. 画一个高亮框：position:fixed + pointer-events:none + 最大 z-index；
 *      元素可见 = 红色实线框；元素存在但不可见 = 红色虚线框；
 *   4. 常驻 MutationObserver（+ scroll/resize 重定位）：路由变化、列表重渲染、
 *      懒加载之后自动重建，不需要主进程反复下发；
 *      并把**事实**写进 window.__ttSniff，供主进程读取。
 *
 * ============================================================
 * 硬规矩：只产出事实，不判对错
 * ============================================================
 * 平台上「这条元素对不对」由人判断。这里只报：
 *   found      匹配到几个
 *   total      上报上下文里的匹配总数（正常情况下 = found）
 *   visible    第一个是否可见
 *   inIframe   是不是在 iframe 里
 *   reason     '' / 'not-found' / 'in-iframe' / 'shadow-dom'
 *   label      元素名（可访问名优先，退化到文本/tag）
 *
 * iframe 内 / shadow DOM 内的元素**不画框**（跨文档画不了，硬画会画错位置），只报 reason。
 */

const {
  LOCATOR_MODES,
  normalizeLocatorMode,
  splitRoleSelector,
  parseRefine,
  parsePwSelector
} = require('../../shared/locatorModes');

/** 高亮框的 DOM id（重新注入时靠它清场，测试也认这个常量） */
const BOX_ID = 'tt-sniff-box';

/** window.__ttSniff 里我们认识的字段（parseSniffState 按这个收口） */
const SNIFF_REASONS = ['', 'not-found', 'in-iframe', 'shadow-dom'];

/**
 * 把一个值变成**安全的 JS 字面量**（可以原样拼进注入脚本）。
 *
 * 为什么不自己写转义：
 *   JSON.stringify 已经把引号、反斜杠、\n、\r、\t、控制字符处理干净了；
 *   自己拿正则替换一遍反而容易漏。
 * 额外再压掉四个字符：
 *   < > &        —— 免得这段脚本被塞进 <script> 时提前闭合标签；
 *   U+2028/2029  —— 在旧引擎里是行终止符，会让字面量断开。
 *
 * @param {*} value
 * @returns {string} JS 字面量源码
 */
function jsLiteral(value) {
  let json;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch (e) {
    json = 'null';
  }
  if (json === undefined) json = 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 生成「在当前页面里找元素」的表达式。
 *
 * 表达式里的 __ttScope 由注入脚本提供（默认 document；查 shadow DOM / iframe 时换成
 * 对应的 document/ShadowRoot），所以同一个定位表达式能复用到所有上下文。
 *
 * 9 种定位方式与 Playwright 的语义对齐（先精确匹配，没有再退回「包含」，
 * 见注入脚本里的 byAttr / pick）：
 *   css          → querySelectorAll
 *   xpath        → document.evaluate + ORDERED_NODE_SNAPSHOT_TYPE
 *   role         → role + 可访问名（"button:登录" 按第一个冒号切）
 *   label        → <label> 关联 / aria-label / aria-labelledby
 *   placeholder  → [placeholder]
 *   text         → 文本节点所在元素
 *   alttext      → [alt]
 *   title        → [title]
 *   testid       → [data-testid]
 *
 * ============================================================
 * v0.71：过滤后缀（|exact / |has-text= / |nth= …）必须在这里处理
 * ============================================================
 * 起因（用户实测报错）：
 *   定位值填 `.studyList a|has-text=面向对象` 点实时校验，浏览器报
 *   `'.studyList a|has-text=面向对象' is not a valid selector`。
 *
 * 根因：v0.66 加 `|` 后缀时只改了**代码生成器**（locatorModes 的 previewLocatorCode），
 * 忘了实时校验这条链路 —— 后缀被原样塞进 querySelectorAll。
 * 「生成器」和「高亮器」两边的单元测试都是绿的，但它们之间的契约没人测。
 *
 * 修法分两层，缺一不可：
 *   1. **剥掉后缀**再查（否则浏览器直接报错）；
 *   2. **后缀要真的参与过滤** —— 只剥不滤的话，`.studyList a` 会命中 28 个、
 *      框住第一个（HelloWorld），而代码里定位的是「面向对象」那个。
 *      框错元素比报错更误导人。
 *
 * @param {string} mode 定位方式
 * @param {string} selector 用户填的定位值（可带 | 后缀）
 * @returns {string} JS 表达式源码（不含分号）
 */
function locatorExpr(mode, selector) {
  const m = normalizeLocatorMode(mode);
  const raw = String(selector === undefined || selector === null ? '' : selector);

  /**
   * v0.66：原生表达式（raw）**没法在这里定位**。
   * 它存的是一整段 Playwright 代码（`page.getByRole(AriaRole.BUTTON, ...)`），
   * 而这里只能产出「页面里能直接跑的 DOM 查询」。
   *
   * 返回空数组字面量（而不是悄悄退回 testid 去查 data-testid —— 那会报一句
   * 莫名其妙的「没找到」）。正常路径上 IPC 层会先拦住并给明确说法，
   * 这里是第二道防御，保证万一绕过也只会「命中 0 个」而不会跑错东西。
   */
  if (m === 'raw') return '[]';

  // v0.71：先把 | 后缀和主体拆开，DOM 查询只能用主体
  const { base, refine } = parseRefine(raw);
  const s = base;
  const has = (k) => refine.find((r) => r.key === k);

  // v0.70.2：Playwright 的 CSS 扩展伪类（:visible / :has-text() / :text-is() …）
  // 浏览器原生 querySelectorAll 不认识它们，必须拆成「基础查询 + JS 过滤」。
  // 这是 v0.70.1 那个 | 后缀问题的「同类第二种表现」：一个是平台私有后缀，
  // 一个是 Playwright 私有语法 —— 都会撞在「浏览器只认标准 CSS」这道墙上。
  const pw = m === 'css' ? parsePwSelector(s) : { base: s, filters: [] };

  /* ---------- 第一层：基础查询 ---------- */
  let expr;
  if (m === 'css') expr = '__ttFind.css(__ttScope, ' + jsLiteral(pw.base) + ')';
  else if (m === 'xpath') expr = '__ttFind.xpath(__ttScope, ' + jsLiteral(s) + ')';
  else if (m === 'role') {
    const { role, name } = splitRoleSelector(s);
    expr = '__ttFind.role(__ttScope, ' + jsLiteral(role) + ', ' + jsLiteral(name) + ')';
  } else if (m === 'label') expr = '__ttFind.label(__ttScope, ' + jsLiteral(s) + ')';
  else if (m === 'text') expr = '__ttFind.text(__ttScope, ' + jsLiteral(s) + ')';
  else if (m === 'placeholder') expr = '__ttFind.byAttr(__ttScope, ' + jsLiteral('placeholder') + ', ' + jsLiteral(s) + ')';
  else if (m === 'title') expr = '__ttFind.byAttr(__ttScope, ' + jsLiteral('title') + ', ' + jsLiteral(s) + ')';
  else if (m === 'alttext') expr = '__ttFind.byAttr(__ttScope, ' + jsLiteral('alt') + ', ' + jsLiteral(s) + ')';
  else expr = '__ttFind.byAttr(__ttScope, ' + jsLiteral('data-testid') + ', ' + jsLiteral(s) + ')';

  /* ---------- 第二层：按后缀过滤（顺序与代码生成的 appendChain 一致） ---------- */
  const exact = has('exact');
  if (exact && m === 'role') {
    // byRole 的 name 默认是「包含」，|exact 要收成精确
    const nm = splitRoleSelector(s).name;
    if (nm) expr = '__ttFind.exactName(' + expr + ', ' + jsLiteral(nm) + ')';
  }
  const desc = has('description');
  if (desc) expr = '__ttFind.description(' + expr + ', ' + jsLiteral(desc.value) + ')';

  /* ---------- 第二层之前的「扩展伪类」过滤（按书写顺序，最内层先做） ---------- */
  for (const f of pw.filters) {
    if (f.kind === 'visible') expr = '__ttFind.visible(' + expr + ')';
    else if (f.kind === 'textContains') expr = '__ttFind.textContains(' + expr + ', ' + jsLiteral(f.value) + ')';
    else if (f.kind === 'textEquals') expr = '__ttFind.textEquals(' + expr + ', ' + jsLiteral(f.value) + ')';
    else if (f.kind === 'textMatches') expr = '__ttFind.textMatches(' + expr + ', ' + jsLiteral(f.value) + ', ' + jsLiteral(f.flags || '') + ')';
    else if (f.kind === 'nthMatch') {
      // :nth-match(2, sel) —— 先按 sel 缩小，再取第 n 个（n 是 1 基）
      if (f.value) expr = '__ttFind.css(__ttScope, ' + jsLiteral(f.value) + ')';
      expr = '__ttFind.nth(' + expr + ', ' + (Number(f.index) - 1) + ')';
    } else if (f.kind === 'nthPos') {
      // >> nth=N（Playwright 的 0 基坐标，支持负数）
      expr = '__ttFind.nth(' + expr + ', ' + Number(f.index) + ')';
    }
  }

  for (const r of refine) {
    if (r.key === 'checked' || r.key === 'disabled') {
      expr = '__ttFind.flag(' + expr + ', ' + jsLiteral(r.key) + ', ' + (r.value ? 'true' : 'false') + ')';
    }
  }

  const ht = has('has-text');
  if (ht) expr = '__ttFind.hasText(' + expr + ', ' + jsLiteral(ht.value) + ')';
  const hnt = has('has-not-text');
  if (hnt) expr = '__ttFind.hasNotText(' + expr + ', ' + jsLiteral(hnt.value) + ')';

  if (has('first')) expr = '__ttFind.first(' + expr + ')';
  if (has('last')) expr = '__ttFind.last(' + expr + ')';
  const nth = has('nth');
  if (nth) expr = '__ttFind.nth(' + expr + ', ' + Number(nth.value) + ')';

  return expr;
}

/**
 * 注入脚本的运行时（跑在页面里）。
 *
 * 写法约定（改这段之前先读）：
 *   - 用 String.raw，正则里的 \s \d 不用写成 \\s（否则生成出去的脚本会坏）；
 *   - **不许出现 ${ 和反引号**（String.raw 里 `${}` 照样会插值，反引号会提前收尾）；
 *   - 只用浏览器 API（document / MutationObserver / getComputedStyle ...），
 *     一旦 require 了 Node 模块，这段字符串就进不了页面；
 *   - __TT_SPEC__ / __TT_LOCATOR__ 是两个占位符，各出现一次，由 buildHighlightScript 替换。
 */
const RUNTIME = String.raw`(function () {
  'use strict';
  var SPEC = __TT_SPEC__;
  var DOC = document;
  var BOX_ID = 'tt-sniff-box';
  var VERSION = 1;
  var MAX_NODES = 20000;
  var currentEl = null;
  var lastSig = '';
  /** 本文件的观察器/监听清理函数（重新注入时靠它摘掉旧的） */
  var localStop = null;

  function toArr(list) {
    var out = [];
    if (!list) return out;
    if (typeof list.length === 'number') {
      for (var i = 0; i < list.length; i++) out.push(list[i]);
      return out;
    }
    var n = Number(list.snapshotLength) || 0;
    for (var j = 0; j < n; j++) out.push(list.snapshotItem(j));
    return out;
  }

  function docOf(scope) {
    if (!scope) return DOC;
    if (scope.nodeType === 9) return scope;
    return scope.ownerDocument || DOC;
  }

  function norm(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function attr(el, name) {
    try {
      if (!el || !el.getAttribute) return '';
      var v = el.getAttribute(name);
      return v === null || v === undefined ? '' : String(v);
    } catch (e) {
      return '';
    }
  }

  function unique(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (out.indexOf(list[i]) < 0) out.push(list[i]);
    }
    return out;
  }

  function viewOf(el) {
    try {
      var d = el && el.ownerDocument;
      return (d && d.defaultView) || window;
    } catch (e) {
      return window;
    }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    if (!(rect.width > 0 && rect.height > 0)) return false;
    var view = viewOf(el);
    var cs = null;
    try {
      cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    } catch (e2) {
      cs = null;
    }
    if (cs) {
      if (cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (Number(cs.opacity) === 0) return false;
    }
    return true;
  }

  function textOf(el) {
    if (!el) return '';
    try {
      return norm(el.textContent);
    } catch (e) {
      return '';
    }
  }

  function ariaLabelledBy(el) {
    var ids = attr(el, 'aria-labelledby');
    if (!ids) return '';
    var d = docOf(el);
    var parts = [];
    var list = ids.split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var target = d.getElementById ? d.getElementById(list[i]) : null;
      if (target) parts.push(textOf(target));
    }
    return norm(parts.join(' '));
  }

  function labelsText(el) {
    if (!el || !el.labels || !el.labels.length) return '';
    var parts = [];
    for (var i = 0; i < el.labels.length; i++) parts.push(textOf(el.labels[i]));
    return norm(parts.join(' '));
  }

  // 可访问名（role 定位用）：aria -> label -> 文本 -> title -> alt
  function accName(el) {
    if (!el) return '';
    var by = ariaLabelledBy(el);
    if (by) return by;
    var aria = norm(attr(el, 'aria-label'));
    if (aria) return aria;
    var lb = labelsText(el);
    if (lb) return lb;
    var ph = norm(attr(el, 'placeholder'));
    if (ph) return ph;
    var txt = textOf(el);
    if (txt) return txt;
    var title = norm(attr(el, 'title'));
    if (title) return title;
    var alt = norm(attr(el, 'alt'));
    return alt;
  }

  // 平台上给人看的元素名：跟 accName 一致，但最后退到 tagName
  function labelOf(el) {
    var name = accName(el);
    if (name) return name.slice(0, SPEC.labelMax);
    var tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
    return tag;
  }

  function implicitRole(el) {
    var tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
    var type = norm(attr(el, 'type')).toLowerCase();
    if (tag === 'a') return attr(el, 'href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file') return 'button';
      return 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'option') return 'option';
    if (tag === 'progress') return 'progressbar';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return 'generic';
  }

  function roleOf(el) {
    var explicit = norm(attr(el, 'role')).split(/\s+/)[0];
    return explicit ? explicit.toLowerCase() : implicitRole(el);
  }

  function css(scope, selector) {
    if (!scope || !scope.querySelectorAll) return [];
    return toArr(scope.querySelectorAll(String(selector)));
  }

  function byXpath(scope, expr) {
    var d = docOf(scope);
    if (!d || !d.evaluate) return [];
    var res = d.evaluate(String(expr), scope, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
    var out = [];
    var n = Number(res.snapshotLength) || 0;
    for (var i = 0; i < n; i++) {
      var node = res.snapshotItem(i);
      if (node && node.nodeType === 1) out.push(node);
    }
    return out;
  }

  // 属性定位（placeholder / title / alt / data-testid 共用）：
  // 先精确匹配，一个都没有才退回「包含」（对齐 Playwright 默认的宽松匹配）
  function byAttr(scope, name, value) {
    var all = css(scope, '[' + name + ']');
    var want = norm(value);
    if (!want) return all;
    var wantLower = want.toLowerCase();
    var exact = [];
    var fuzzy = [];
    for (var i = 0; i < all.length && i < MAX_NODES; i++) {
      var v = norm(attr(all[i], name));
      if (v === want) exact.push(all[i]);
      else if (v.toLowerCase().indexOf(wantLower) >= 0) fuzzy.push(all[i]);
    }
    return exact.length ? exact : fuzzy;
  }

  function byLabel(scope, value) {
    var want = norm(value);
    var wantLower = want.toLowerCase();
    var out = [];
    var labels = css(scope, 'label');
    for (var i = 0; i < labels.length && i < MAX_NODES; i++) {
      var lt = textOf(labels[i]).toLowerCase();
      if (!want || lt === wantLower || lt.indexOf(wantLower) >= 0) {
        var ctl = labels[i].control || (labels[i].querySelector ? labels[i].querySelector('input,select,textarea,button') : null);
        if (ctl) out.push(ctl);
      }
    }
    // 没有 <label> 关联的（aria-label / aria-labelledby / placeholder）也认
    var controls = css(scope, 'input,select,textarea,button,[aria-label],[aria-labelledby]');
    for (var j = 0; j < controls.length && j < MAX_NODES; j++) {
      if (!want) { out.push(controls[j]); continue; }
      var nm = accName(controls[j]).toLowerCase();
      if (nm === wantLower || nm.indexOf(wantLower) >= 0) out.push(controls[j]);
    }
    return unique(out);
  }

  function byText(scope, value) {
    var want = norm(value);
    var wantLower = want.toLowerCase();
    var d = docOf(scope);
    var exact = [];
    var fuzzy = [];
    if (!d.createTreeWalker) return [];
    var walker = d.createTreeWalker(scope, 4 /* SHOW_TEXT */, null);
    var node = walker.nextNode();
    var guard = 0;
    while (node && guard < MAX_NODES) {
      guard++;
      var t = norm(node.nodeValue);
      var el = node.parentElement;
      if (t && el) {
        if (!want) exact.push(el);
        else if (t === want) exact.push(el);
        else if (t.toLowerCase().indexOf(wantLower) >= 0) fuzzy.push(el);
      }
      node = walker.nextNode();
    }
    return unique(exact.length ? exact : fuzzy);
  }

  function byRole(scope, role, name) {
    var wantRole = norm(role).toLowerCase();
    var wantName = norm(name);
    var wantLower = wantName.toLowerCase();
    var out = [];
    if (!wantRole) return out;
    var all = css(scope, '*');
    for (var i = 0; i < all.length && i < MAX_NODES; i++) {
      if (roleOf(all[i]) !== wantRole) continue;
      if (!wantName) { out.push(all[i]); continue; }
      var nm = norm(accName(all[i])).toLowerCase();
      if (nm === wantLower || nm.indexOf(wantLower) >= 0) out.push(all[i]);
    }
    return out;
  }

  /* ============================================================
   * v0.71：过滤后缀在页面里的等价实现
   *
   * 这些函数让「实时校验框住的元素」和「生成的 Playwright 代码定位的元素」
   * 是同一个。只剥离后缀不做过滤的话，.studyList a|has-text=面向对象
   * 会命中 28 个、框住第一个 —— 框错比报错更误导人。
   *
   * 语义对齐 Playwright：
   *   hasText     包含匹配、忽略大小写
   *   nth         0 基，支持负数（-1 = 最后一个）
   *   exactName   可访问名精确相等（byRole 默认是包含）
   *
   * ⚠ 本段在 String.raw 里，注释中不能用反引号（会提前收尾模板）。
   * ============================================================ */

  function keepNth(hits, n) {
    if (!hits || !hits.length) return [];
    var i = Number(n);
    if (isNaN(i)) return hits;
    if (i < 0) i = hits.length + i;
    return i >= 0 && i < hits.length ? [hits[i]] : [];
  }

  function keepFirst(hits) {
    return hits && hits.length ? [hits[0]] : [];
  }

  function keepLast(hits) {
    return hits && hits.length ? [hits[hits.length - 1]] : [];
  }

  /** 归一化后的文本（小写 + 压空白），和 Playwright 的 hasText 口径一致 */
  function flatText(el) {
    if (!el) return '';
    return norm(el.textContent || '').toLowerCase();
  }

  function keepHasText(hits, want) {
    var w = norm(want).toLowerCase();
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      if (flatText(hits[i]).indexOf(w) >= 0) out.push(hits[i]);
    }
    return out;
  }

  function keepHasNotText(hits, want) {
    var w = norm(want).toLowerCase();
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      if (flatText(hits[i]).indexOf(w) < 0) out.push(hits[i]);
    }
    return out;
  }

  function keepExactName(hits, want) {
    var w = norm(want).toLowerCase();
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      if (norm(accName(hits[i])).toLowerCase() === w) out.push(hits[i]);
    }
    return out;
  }

  function keepDescription(hits, want) {
    var w = norm(want).toLowerCase();
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      var el = hits[i];
      var d = norm(el.getAttribute ? el.getAttribute('aria-description') || el.getAttribute('aria-describedby') || '' : '').toLowerCase();
      if (d.indexOf(w) >= 0) out.push(el);
    }
    return out;
  }

  /** |checked / |disabled：原生属性 + aria-* 兜底 */
  function keepFlag(hits, flag, want) {
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      var el = hits[i];
      var on = false;
      if (flag === 'checked') {
        on =
          !!el.checked ||
          (el.getAttribute && el.getAttribute('aria-checked') === 'true') ||
          (el.getAttribute && el.getAttribute('aria-selected') === 'true');
      } else if (flag === 'disabled') {
        on = !!el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true');
      }
      if (on === !!want) out.push(el);
    }
    return out;
  }

  /* ============================================================
   * v0.70.2：Playwright 扩展伪类的等价实现
   *
   * :visible 的语义按 Playwright 文档：**有非空 bounding box 且 visibility 不是 hidden**
   *   （display:none 会让盒子为 0，自然被排除；Playwright 不把 opacity:0 当不可见）
   * :has-text / :text        包含匹配
   * :text-is                 完全相等
   * :text-matches            正则匹配
   * :nth-match(n, sel)       在 sel 的结果里取第 n 个（1 基，由调用侧换算成 0 基）
   * ============================================================ */

  function keepVisible(hits) {
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      var el = hits[i];
      if (!el || !el.getBoundingClientRect) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      var doc = el.ownerDocument || DOC;
      var view = doc.defaultView;
      var st = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
      if (st && st.visibility === 'hidden') continue;
      out.push(el);
    }
    return out;
  }

  function keepTextContains(hits, want) {
    var w = norm(want).toLowerCase();
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      if (flatText(hits[i]).indexOf(w) >= 0) out.push(hits[i]);
    }
    return out;
  }

  function keepTextEquals(hits, want) {
    var w = norm(want);
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      if (norm(hits[i].textContent || '') === w) out.push(hits[i]);
    }
    return out;
  }

  function keepTextMatches(hits, pattern, flags) {
    var re;
    try {
      re = new RegExp(String(pattern), String(flags || ''));
    } catch (e) {
      return hits; // 用户正则写坏了就不过滤，别整条定位废掉
    }
    var out = [];
    for (var i = 0; i < (hits ? hits.length : 0); i++) {
      if (re.test(norm(hits[i].textContent || ''))) out.push(hits[i]);
    }
    return out;
  }

  var __ttFind = {
    css: css,
    xpath: byXpath,
    byAttr: byAttr,
    label: byLabel,
    text: byText,
    role: byRole,
    nth: keepNth,
    first: keepFirst,
    last: keepLast,
    hasText: keepHasText,
    hasNotText: keepHasNotText,
    exactName: keepExactName,
    description: keepDescription,
    flag: keepFlag,
    visible: keepVisible,
    textContains: keepTextContains,
    textEquals: keepTextEquals,
    textMatches: keepTextMatches
  };

  /** 定位表达式（由生成器填入，引用 __ttScope） */
  function find(scope) {
    var __ttScope = scope || DOC;
    return toArr(__TT_LOCATOR__);
  }

  /** shadow DOM：递归进 shadowRoot 找（深度 4 层封顶，防止怪页面把主线程拖死） */
  function searchShadow(scope, depth) {
    if (depth > 4) return [];
    var all = css(scope, '*');
    var roots = [];
    for (var i = 0; i < all.length && i < MAX_NODES; i++) {
      if (all[i].shadowRoot) roots.push(all[i].shadowRoot);
    }
    for (var j = 0; j < roots.length; j++) {
      var hit = [];
      try {
        hit = find(roots[j]);
      } catch (e) {
        hit = [];
      }
      if (hit.length) return hit;
      var deeper = searchShadow(roots[j], depth + 1);
      if (deeper.length) return deeper;
    }
    return [];
  }

  /** iframe：只查同源 iframe（跨源读不了，也不该读） */
  function searchIframes() {
    var frames = css(DOC, 'iframe,frame');
    for (var i = 0; i < frames.length && i < 50; i++) {
      var inner = null;
      try {
        inner = frames[i].contentDocument;
      } catch (e) {
        inner = null;
      }
      if (!inner) continue;
      var hit = [];
      try {
        hit = find(inner);
      } catch (e2) {
        hit = [];
      }
      if (!hit.length) hit = searchShadow(inner, 0);
      if (hit.length) return hit;
    }
    return [];
  }

  function clearBox() {
    var box = DOC.getElementById ? DOC.getElementById(BOX_ID) : null;
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  function reveal(el) {
    if (!el || !el.scrollIntoView) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    } catch (e) {
      try {
        el.scrollIntoView();
      } catch (e2) {
        /* 页面自己接管了滚动，放弃滚动即可，高亮照画 */
      }
    }
  }

  function paint(el, st) {
    clearBox();
    if (!el || !el.getBoundingClientRect) return;
    var host = DOC.body || DOC.documentElement;
    if (!host) return;
    var rect = el.getBoundingClientRect();
    var box = DOC.createElement('div');
    box.id = BOX_ID;
    box.setAttribute('data-tt-sniff', '1');
    var s = box.style;
    s.position = 'fixed';
    s.left = Math.round(rect.left) + 'px';
    s.top = Math.round(rect.top) + 'px';
    s.width = Math.max(0, Math.round(rect.width)) + 'px';
    s.height = Math.max(0, Math.round(rect.height)) + 'px';
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    s.boxSizing = 'border-box';
    s.borderRadius = '2px';
    s.margin = '0';
    s.padding = '0';
    s.background = 'rgba(255, 59, 48, 0.08)';
    // 看得见 → 红色实线；找得到但看不见 → 红色虚线（这正是「存在但没露出来」的样子）
    s.border = st.visible ? '2px solid #ff3b30' : '2px dashed #ff3b30';
    host.appendChild(box);
  }

  function reposition() {
    if (!currentEl) return;
    var box = DOC.getElementById ? DOC.getElementById(BOX_ID) : null;
    if (!box) return;
    var rect;
    try {
      rect = currentEl.getBoundingClientRect();
    } catch (e) {
      return;
    }
    if (!(rect.width > 0 && rect.height > 0)) return;
    box.style.left = Math.round(rect.left) + 'px';
    box.style.top = Math.round(rect.top) + 'px';
    box.style.width = Math.round(rect.width) + 'px';
    box.style.height = Math.round(rect.height) + 'px';
  }

  function freshState() {
    return {
      mode: SPEC.mode,
      selector: SPEC.selector,
      name: SPEC.name,
      found: 0,
      total: 0,
      visible: false,
      inIframe: false,
      reason: 'not-found',
      label: '',
      invalid: false,
      error: '',
      href: '',
      at: 0,
      version: VERSION
    };
  }

  /**
   * 重新算一遍事实 + 重建高亮框。
   * 主文档 → shadow DOM → iframe 依次找；只有主文档里的元素才画框。
   */
  function refresh() {
    var st = freshState();
    try {
      st.href = String(location.href);
    } catch (e) {
      st.href = '';
    }
    var el = null;
    var hits = [];
    var err = '';
    try {
      hits = find(DOC);
    } catch (e2) {
      err = String((e2 && e2.message) || e2 || '');
    }
    if (err) {
      st.invalid = true;
      st.error = err.slice(0, 300);
      st.found = 0;
      st.total = 0;
      st.reason = 'not-found';
    } else if (hits.length) {
      el = hits[0];
      st.found = hits.length;
      st.total = hits.length;
      st.visible = isVisible(el);
      st.label = labelOf(el);
      st.reason = '';
    } else {
      var shadowHits = searchShadow(DOC, 0);
      if (shadowHits.length) {
        st.found = shadowHits.length;
        st.total = shadowHits.length;
        st.reason = 'shadow-dom';
        st.visible = isVisible(shadowHits[0]);
        st.label = labelOf(shadowHits[0]);
      } else {
        var frameHits = searchIframes();
        if (frameHits.length) {
          st.found = frameHits.length;
          st.total = frameHits.length;
          st.reason = 'in-iframe';
          st.inIframe = true;
          st.visible = isVisible(frameHits[0]);
          st.label = labelOf(frameHits[0]);
        } else {
          st.found = 0;
          st.total = 0;
          st.reason = 'not-found';
        }
      }
    }

    currentEl = el;
    var sig = [st.found, st.total, st.visible, st.reason, st.inIframe, st.label, st.invalid, st.error, st.href].join('|');
    var box = DOC.getElementById ? DOC.getElementById(BOX_ID) : null;
    if (sig === lastSig && box && el) {
      // 事实没变（多是自己画的框触发的 mutation）：只把框挪到位，不重建 —— 否则会自激循环
      reposition();
      window.__ttSniff = st;
      st.at = Date.now();
      return st;
    }
    lastSig = sig;
    if (el && st.visible) reveal(el);
    paint(el, st);
    st.at = Date.now();
    window.__ttSniff = st;
    return st;
  }

  function isOwnNode(node) {
    return !!(node && node.nodeType === 1 && (node.id === BOX_ID || attr(node, 'data-tt-sniff') === '1'));
  }

  /** mutation 里如果只有我们自己画的框在动，忽略它（防自激循环） */
  function onlyOwnMutation(rec) {
    var target = rec.target;
    if (target && target.nodeType === 1 && (target.id === BOX_ID || attr(target, 'data-tt-sniff') === '1')) return true;
    var nodes = toArr(rec.addedNodes).concat(toArr(rec.removedNodes));
    if (!nodes.length) return false;
    for (var i = 0; i < nodes.length; i++) {
      if (!isOwnNode(nodes[i])) return false;
    }
    return true;
  }

  function start() {
    // 先摘掉上一次注入留下的观察器/监听（同一页面反复注入不会叠成 N 份）
    try {
      if (typeof window.__ttSniffStop === 'function') window.__ttSniffStop();
    } catch (e) {
      /* 旧的没清干净也不影响新的 */
    }
    var timer = 0;
    function schedule() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = 0;
        try {
          refresh();
        } catch (e) {
          /* 页面自己抛的错不能把观察器带崩 */
        }
      }, 80);
    }
    var mo = null;
    if (window.MutationObserver && DOC.documentElement) {
      mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          if (!onlyOwnMutation(records[i])) {
            schedule();
            return;
          }
        }
      });
      mo.observe(DOC.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    function onMove() {
      reposition();
    }
    function onLoad() {
      schedule();
    }
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('load', onLoad);
    localStop = function () {
      if (mo) mo.disconnect();
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('load', onLoad);
      if (timer) clearTimeout(timer);
      clearBox();
      localStop = null;
      window.__ttSniffStop = null;
    };
    window.__ttSniffStop = function () {
      if (localStop) localStop();
    };
    return refresh();
  }

  if (!DOC.documentElement) {
    DOC.addEventListener('DOMContentLoaded', function () {
      start();
    });
    window.__ttSniff = freshState();
    return window.__ttSniff;
  }
  return start();
})()`;

/**
 * 生成完整注入脚本（一段可以被 Runtime.evaluate 直接执行的表达式）。
 *
 * @param {string} mode 定位方式（认不出按 css）
 * @param {string} selector 定位值
 * @param {{name?: string}} [options] name 只是随事实一起回传，不参与定位
 * @returns {string} 注入脚本源码；最后一个表达式的值就是 window.__ttSniff
 */
function buildHighlightScript(mode, selector, options) {
  const opt = options || {};
  const spec = {
    mode: normalizeLocatorMode(mode),
    selector: String(selector === undefined || selector === null ? '' : selector),
    name: String(opt.name === undefined || opt.name === null ? '' : opt.name).slice(0, 120),
    labelMax: 120
  };
  // 注意：replace 的第二个参数用函数，别用字符串 —— 用户的选择器里可能有 $& / $1
  return RUNTIME.replace('__TT_SPEC__', () => jsLiteral(spec)).replace('__TT_LOCATOR__', () =>
    locatorExpr(spec.mode, spec.selector)
  );
}

/**
 * 把页面里读回来的 window.__ttSniff 收口成可信的事实对象。
 *
 * 为什么要收口：那是页面里的值，可能被页面自己的脚本改坏（我们只是「客人」）。
 * 这里只认白名单字段，数字做范围收敛，reason 只认四个值。
 *
 * 不变式：found === 0 → reason 一定是 'not-found'（前端靠这个显示「没匹配到」）。
 *
 * @param {*} raw 页面返回的对象
 * @returns {{found:number,total:number,visible:boolean,inIframe:boolean,reason:string,label:string,invalid:boolean,error:string,href:string,at:number}}
 */
function parseSniffState(raw) {
  const empty = {
    found: 0,
    total: 0,
    visible: false,
    inIframe: false,
    reason: 'not-found',
    label: '',
    invalid: false,
    error: '',
    href: '',
    at: 0
  };
  if (!raw || typeof raw !== 'object') return empty;

  const count = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  };

  const found = count(raw.found);
  const total = Math.max(found, count(raw.total));
  const reasonRaw = String(raw.reason === undefined || raw.reason === null ? '' : raw.reason);
  let reason = SNIFF_REASONS.indexOf(reasonRaw) >= 0 ? reasonRaw : '';
  // 不变式：找到就一定有主文档里的框（reason 不该是 not-found）；没找到就一定是 not-found
  if (found > 0) {
    if (reason === 'not-found') reason = '';
  } else {
    reason = 'not-found';
  }

  return {
    found,
    total,
    visible: raw.visible === true,
    inIframe: raw.inIframe === true,
    reason,
    label: String(raw.label === undefined || raw.label === null ? '' : raw.label).slice(0, 200),
    invalid: raw.invalid === true,
    error: String(raw.error === undefined || raw.error === null ? '' : raw.error).slice(0, 300),
    href: String(raw.href === undefined || raw.href === null ? '' : raw.href).slice(0, 2000),
    at: count(raw.at)
  };
}

module.exports = {
  BOX_ID,
  SNIFF_REASONS,
  LOCATOR_MODES,
  jsLiteral,
  locatorExpr,
  buildHighlightScript,
  parseSniffState,
  normalizeMode: normalizeLocatorMode
};