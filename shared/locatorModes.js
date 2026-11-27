'use strict';
/**
 * 页面元素的「定位方式」+ 定位代码生成 —— 纯函数，零依赖。
 *
 * ============================================================
 * 为什么单独一个文件，而不直接塞进 shared/codegen.js
 * ============================================================
 * codegen.js 顶部 require('ejs')，而渲染进程（src/**）也要用这里的预览函数：
 * 把 ejs 带进浏览器包会连带 fs / path 这些 Node 内置模块，esbuild 直接报错。
 * 所以生成逻辑放这里，codegen.js 反过来 require 本文件，
 * **两边共用同一套代码**（不写两遍，测试也只测一份）。
 *
 * ============================================================
 * 定位方式顺序（产品明确要求，别随手调）
 * ============================================================
 *   css 打头（老记录没有 mode 字段，一律当 css）
 *   语义化定位居中（Playwright 1.27+ 官方推荐，抗 DOM 结构变化）
 *   testId 收尾 —— 实战里前端页面写 data-testid 的太少
 */

/** 9 种定位方式，顺序即前端下拉顺序 */
const LOCATOR_MODES = [
  'css',
  'xpath',
  'role',
  'label',
  'placeholder',
  'text',
  'alttext',
  'title',
  'testid',
  'raw'
];

/**
 * 「原生表达式」模式（v0.66）。
 *
 * 为什么要有：`getByRole` 有 9 个 options，再加 `.filter/.nth/.and/.or`、
 * frameLocator… 这些永远不可能全做进 UI 的下拉里。
 * 给一个逃生口：填什么就生成什么，平台不解释、不校验。
 *
 * ⚠️ 它**不跨语言**：Java 写 `getByRole(AriaRole.BUTTON, ...)`，
 * Python 写 `get_by_role("button", ...)`，两者不能互转。切语言时要自己改。
 */
const RAW_MODE = 'raw';

/**
 * 过滤后缀白名单（v0.66）。
 *
 * 编码就写在 selector 字符串里，用 `|` 分隔：
 *   button:登录|exact               精确匹配
 *   button:提交|disabled            禁用状态
 *   checkbox|checked
 *   .studyList a|has-text=面向对象   再过滤一层
 *   link:面向对象|nth=1              取第 2 个（0 基）
 *   .row|first
 *
 * 为什么用字符串后缀而不是加字段：
 *   selector 本来就是自由文本，加后缀**不改数据结构**、老数据（无 `|`）行为完全不变，
 *   而过滤条件本质是「这一个定位值的修饰」，不是独立维度。
 *
 * ⚠️ `|` 在 CSS 里是合法字符（如 `[class|="col"]`、命名空间 `a|b`），
 * 所以解析是**从右往左 + 白名单**：只有右边那段能认成已知后缀才拆，
 * 否则原样保留。实测 `div[class|="col"]` 不会被误拆。
 */
const REFINE_KEYS = new Set([
  'exact',
  'disabled',
  'checked',
  'description',
  'nth',
  'first',
  'last',
  'has-text',
  'has-not-text'
]);

/**
 * 语义化定位方式 → Playwright 方法名。
 *
 * 两门语言的 API 风格不同，不能共用一个名字：
 *   Java   page.getByLabel("用户名")        —— 驼峰
 *   Python self.page.get_by_label("用户名") —— 下划线
 */
const SEMANTIC_METHOD = {
  label: { java: 'getByLabel', python: 'get_by_label' },
  placeholder: { java: 'getByPlaceholder', python: 'get_by_placeholder' },
  text: { java: 'getByText', python: 'get_by_text' },
  alttext: { java: 'getByAltText', python: 'get_by_alt_text' },
  title: { java: 'getByTitle', python: 'get_by_title' },
  testid: { java: 'getByTestId', python: 'get_by_test_id' }
};

/**
 * Playwright Java 的 AriaRole 枚举常量名。
 * Java 的 getByRole 只收 AriaRole，不收字符串，所以 role 得映射成枚举；
 * 认不出来的角色退回 AriaRole.valueOf("XXX")，保证生成的代码至少能编译。
 */
const ARIA_ROLES = new Set(
  (
    'alert alertdialog application article banner blockquote button caption cell checkbox code ' +
    'columnheader combobox complementary contentinfo definition deletion dialog directory document ' +
    'emphasis feed figure form generic grid gridcell group heading img insertion link list listbox ' +
    'listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio ' +
    'navigation none note option paragraph presentation progressbar radio radiogroup region row ' +
    'rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong ' +
    'subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar ' +
    'tooltip tree treegrid treeitem'
  )
    .split(' ')
    // 枚举常量名是全大写（AriaRole.BUTTON）
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean)
);

/**
 * 定位方式兜底。
 *
 * 不做「/ 开头就当 xpath」这种推断（用户明确要求）：老记录没有 mode，一律当 css。
 * 认不出的脏值也当 css，绝不让生成器抛异常。
 */
function normalizeLocatorMode(mode) {
  const v = String(mode === undefined || mode === null ? '' : mode)
    .trim()
    .toLowerCase();
  return LOCATOR_MODES.indexOf(v) >= 0 ? v : 'css';
}

/**
 * 拆 role 的「角色:可访问名称」。
 *
 * 按**第一个冒号**切 —— 名称里自己可能还有冒号（如 button:登录:备注）。
 *   button:登录 → { role: 'button', name: '登录' }
 *   button      → { role: 'button', name: '' }
 */
function splitRoleSelector(selector) {
  const s = String(selector === undefined || selector === null ? '' : selector);
  const i = s.indexOf(':');
  if (i < 0) return { role: s.trim(), name: '' };
  return { role: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
}

/**
 * 转义成 Java / Python 双引号字符串的内容。
 *
 * 两门语言的双引号字符串转义规则在本项目用到的范围内一致：
 * 反斜杠和双引号都要转义，换行/制表符也顺手转掉（否则生成的文件会串行）。
 */
function escapeDoubleQuoted(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** role 字符串 → Java 的 AriaRole 表达式 */
function ariaRoleExpr(role) {
  const up = String(role === undefined || role === null ? '' : role)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
  if (!up) return '';
  return ARIA_ROLES.has(up) ? 'AriaRole.' + up : 'AriaRole.valueOf("' + up + '")';
}

/* ============================================================
 * 过滤后缀（v0.66）
 * ============================================================ */

/** 认一个后缀片段；认不出返回 null（解析就此打住，左边的当主体） */
function parseOneRefine(token) {
  const t = String(token === undefined || token === null ? '' : token).trim();
  if (!t) return null;
  const eq = t.indexOf('=');
  const rawKey = (eq < 0 ? t : t.slice(0, eq)).trim().toLowerCase();
  const value = eq < 0 ? '' : t.slice(eq + 1).trim();
  if (!REFINE_KEYS.has(rawKey)) return null;

  // 布尔类：只写 `disabled` 等于 true；`disabled=false` 才算 false
  if (rawKey === 'exact' || rawKey === 'disabled' || rawKey === 'checked') {
    return { key: rawKey, value: value.toLowerCase() === 'false' ? false : true };
  }
  if (rawKey === 'first' || rawKey === 'last') return { key: rawKey, value: true };
  if (rawKey === 'nth') {
    const n = parseInt(value, 10);
    if (!isFinite(n)) return null;
    return { key: 'nth', value: n };
  }
  // 带文本的：必须有值，否则 `description=` 这种空壳不如不认
  if (!value) return null;
  return { key: rawKey, value };
}

/**
 * 把 selector 拆成「主体 + 过滤后缀」。
 * @returns {{base: string, refine: Array<{key: string, value: any}>}}
 */
function parseRefine(selector) {
  const s = String(selector === undefined || selector === null ? '' : selector).trim();
  if (!s) return { base: '', refine: [] };
  const tokens = s.split('|');
  if (tokens.length < 2) return { base: s, refine: [] };

  const refine = [];
  while (tokens.length > 1) {
    const parsed = parseOneRefine(tokens[tokens.length - 1]);
    if (!parsed) break; // 从右往左，第一个认不出的就停
    refine.unshift(parsed);
    tokens.pop();
  }
  const base = tokens.join('|').trim();
  // 整个字符串都像后缀（用户可能真想写这个字面量）→ 不拆
  if (!base) return { base: s, refine: [] };
  return { base, refine };
}

/** 语义定位里带 exact 的 Java Options 类名（testid / css / xpath 不支持 exact） */
const EXACT_OPTIONS_CLASS = {
  label: 'Page.GetByLabelOptions',
  placeholder: 'Page.GetByPlaceholderOptions',
  text: 'Page.GetByTextOptions',
  alttext: 'Page.GetByAltTextOptions',
  title: 'Page.GetByTitleOptions'
};

/** 布尔字面量：Java true/false，Python True/False */
function boolLit(v, language) {
  return language === 'python' ? (v ? 'True' : 'False') : v ? 'true' : 'false';
}

/**
 * 按后缀追加「链式调用」。
 *
 * 顺序固定为 filter → first/last → nth：
 *   `.filter(has_text=x).nth(1)` 是「先缩小集合再取第 2 个」；
 *   反过来 `.nth(1).filter(...)` 是「取第 2 个、再看它满不满足」，语义完全不同。
 */
function appendChain(code, refine, language) {
  const q = (v) => '"' + escapeDoubleQuoted(v) + '"';
  let out = code;

  // 1) filter：has-text / has-not-text
  for (const r of refine) {
    if (r.key !== 'has-text' && r.key !== 'has-not-text') continue;
    if (language === 'python') {
      const kw = r.key === 'has-text' ? 'has_text' : 'has_not_text';
      out += '.filter(' + kw + '=' + q(r.value) + ')';
    } else {
      const setter = r.key === 'has-text' ? 'setHasText' : 'setHasNotText';
      out += '.filter(new Locator.FilterOptions().' + setter + '(' + q(r.value) + '))';
    }
  }

  // 2) first / last（Python 是属性，Java 是方法）
  for (const r of refine) {
    if (r.key === 'first') out += language === 'python' ? '.first' : '.first()';
    else if (r.key === 'last') out += language === 'python' ? '.last' : '.last()';
  }

  // 3) nth
  for (const r of refine) {
    if (r.key === 'nth') out += '.nth(' + r.value + ')';
  }

  return out;
}

/**
 * 生成一行定位代码（表格里的实时预览、以及 POM 模板，都用这一个函数）。
 *
 * v0.66：支持「过滤后缀」和「原生表达式」模式，见文件头注释。
 *
 * @param {string} mode 定位方式（css / xpath / role / label / ... / raw）
 * @param {string} selector 用户填的定位值（可带 | 后缀）
 * @param {'java'|'python'} [lang] 目标语言，缺省 java
 * @returns {string} 定位代码；定位值为空时返回空串（由 UI 决定显示「等待输入」）
 */
function previewLocatorCode(mode, selector, lang) {
  const language = lang === 'python' ? 'python' : 'java';
  const page = language === 'python' ? 'self.page' : 'page';
  const m = normalizeLocatorMode(mode);
  const raw = String(selector === undefined || selector === null ? '' : selector).trim();
  if (!raw) return '';

  const q = (v) => '"' + escapeDoubleQuoted(v) + '"';

  /* ---------- 原生表达式：原样送出，只做最小容错 ---------- */
  if (m === RAW_MODE) {
    // 已经带 page. / self.page. 就不动
    if (/^(page|self\.page|this\.page)\s*\./.test(raw)) return raw;
    // 看起来像方法调用（getByRole(...) / locator(...)）→ 补页面对象前缀
    if (/^[A-Za-z_$][\w$]*\s*\(/.test(raw)) return page + '.' + raw;
    // 其它（用户写了个裸字符串？）原样返回，生成出来编译不过也让他自己看到
    return raw;
  }

  const { base, refine } = parseRefine(raw);
  if (!base) return '';

  const has = (k) => refine.find((r) => r.key === k);

  /* ---------- 基础定位 ---------- */
  let code;

  if (m === 'css') {
    code = page + '.locator(' + q(base) + ')';
  } else if (m === 'xpath') {
    // 用户只填 //div[@id="x"]，xpath= 前缀由生成器补（别让人手写引擎前缀）
    code = page + '.locator("xpath=' + escapeDoubleQuoted(base) + '")';
  } else if (m === 'role') {
    const { role, name } = splitRoleSelector(base);
    if (!role) {
      // 角色为空（只写了「:名称」）→ 退回普通 locator，不生成非法调用
      code = page + '.locator(' + q(base) + ')';
    } else {
      const exact = has('exact');
      const disabled = has('disabled');
      const checked = has('checked');
      const description = has('description');

      if (language === 'python') {
        const kws = [];
        if (name) kws.push('name=' + q(name));
        if (exact) kws.push('exact=' + boolLit(exact.value, language));
        if (disabled) kws.push('disabled=' + boolLit(disabled.value, language));
        if (checked) kws.push('checked=' + boolLit(checked.value, language));
        if (description) kws.push('description=' + q(description.value));
        code = page + '.get_by_role(' + [q(role)].concat(kws).join(', ') + ')';
      } else {
        const sets = [];
        if (name) sets.push('setName(' + q(name) + ')');
        if (exact) sets.push('setExact(' + boolLit(exact.value, language) + ')');
        if (disabled) sets.push('setDisabled(' + boolLit(disabled.value, language) + ')');
        if (checked) sets.push('setChecked(' + boolLit(checked.value, language) + ')');
        if (description) sets.push('setDescription(' + q(description.value) + ')');
        const optExpr = sets.length
          ? ', new Page.GetByRoleOptions()' + sets.map((x) => '.' + x).join('')
          : '';
        code = page + '.getByRole(' + ariaRoleExpr(role) + optExpr + ')';
      }
    }
  } else {
    // 其余语义定位（label / placeholder / text / alttext / title / testid）
    const method = SEMANTIC_METHOD[m][language];
    const exact = has('exact');
    const optClass = EXACT_OPTIONS_CLASS[m];
    if (exact && optClass) {
      // exact 只有 Java 需要显式 Options；Python 就是关键字参数
      code =
        language === 'python'
          ? page + '.' + method + '(' + q(base) + ', exact=' + boolLit(exact.value, language) + ')'
          : page + '.' + method + '(' + q(base) + ', new ' + optClass + '().setExact(' + boolLit(exact.value, language) + '))';
    } else {
      // testid 不支持 exact；其它情况（含用户对 testid 写了 exact）忽略后缀
      code = page + '.' + method + '(' + q(base) + ')';
    }
  }

  return appendChain(code, refine, language);
}

/**
 * Playwright 的 CSS **扩展伪类**（浏览器原生 querySelectorAll 不认识）。
 *
 * 为什么需要这份清单（v0.70.2，用户实测报错）：
 *   定位值填 `label.backwordButton.btn.btn-default.active:visible` 点实时校验 →
 *   `':visible' is not a valid selector`。
 *
 * 这是**同一类问题的第二种表现**：
 *   · v0.66 的 `|has-text=` 是平台自己的后缀（v0.70.1 已修）
 *   · 而 `:visible` / `:has-text()` / `:text-is()` 是 **Playwright 自己的扩展语法**
 *     —— 在 Playwright 里合法（生成的代码没问题），但浏览器的 querySelectorAll 不认识。
 *
 * ⚠ 曾经（v0.66 的 README）我还专门写过「:has-text 不能拿去 DevTools 验证」，
 * 却没意识到**平台自己的实时校验就是拿浏览器跑的** —— 文档警告了限制，
 * 却没发现自家功能也踩在这个限制上。
 *
 * 下面这份清单把扩展伪类翻译成「基础查询 + JS 过滤」，让实时校验能工作。
 * 顺序很重要：`text-is` / `text-matches` 必须排在 `text` 前面判断（虽然正则本身要求紧跟左括号，不会互相吃掉）。
 */
const PW_PSEUDO_KINDS = [
  { kind: 'visible', re: /:visible\b/g },
  { kind: 'textEquals', re: /:text-is\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*?))\s*\)/g },
  { kind: 'textMatches', re: /:text-matches\(\s*(?:'([^']*)'|"([^"]*)"|([^),]*?))\s*(?:,\s*['"]?([a-z]*?)['"]?)?\s*\)/g },
  { kind: 'textContains', re: /:has-text\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*?))\s*\)/g },
  { kind: 'textContains', re: /:text\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*?))\s*\)/g },
  { kind: 'nthMatch', re: /:nth-match\(\s*(\d+)\s*,\s*([^)]*?)\s*\)/g }
];

/**
 * 把选择器里的 Playwright 扩展伪类拆出来。
 *
 * @param {string} selector 用户填的定位值（可能是 `label.a.b:visible` 这种）
 * @returns {{base: string, filters: Array<{kind: string, value?: string, flags?: string, index?: number}>}}
 *   base    —— 能让浏览器 querySelectorAll 直接跑的纯 CSS
 *   filters —— 需要在结果上做的过滤（顺序即书写顺序）
 *
 * ⚠ 限制（写在注释里免得以后误解）：
 *   · 只支持**扩展伪类**，不支持 `>>` 链式里的其它引擎（text= / role= 等）；
 *   · 伪类出现在**中间**时（`div:has-text("x") > span`）只能近似：
 *     先查 `div > span` 再按文本过滤 —— 语义不完全等价，但至少不报错。
 *     末尾的情况（最常见，如 `xxx:visible`）是精确的。
 */
function parsePwSelector(selector) {
  let s = String(selector === undefined || selector === null ? '' : selector);
  const filters = [];

  for (const item of PW_PSEUDO_KINDS) {
    s = s.replace(item.re, function () {
      const args = Array.prototype.slice.call(arguments);
      // 最后两个参数是 offset / 原串，去掉
      const groups = args.slice(1, -2);
      if (item.kind === 'visible') {
        filters.push({ kind: 'visible' });
      } else if (item.kind === 'nthMatch') {
        const idx = Number(groups[0]);
        const sel = String(groups[1] || '').trim();
        filters.push({ kind: 'nthMatch', index: isFinite(idx) ? idx : 1, value: sel });
      } else if (item.kind === 'textMatches') {
        const pattern = groups[0] || groups[1] || groups[2] || '';
        const flags = groups[3] || '';
        filters.push({ kind: 'textMatches', value: String(pattern), flags: String(flags) });
      } else {
        const v = groups[0] || groups[1] || groups[2] || '';
        filters.push({ kind: item.kind, value: String(v) });
      }
      return '';
    });
  }

  /**
   * 处理 `>>` 链式里的纯位置段（v0.70.2）。
   *
   * Playwright 的 `>>` 是链式分隔符，其中 `nth=N` 表示「取第 N 个」：
   *   `.row >> nth=1`
   * 这也是浏览器不认识的语法（第三种同类表现）。
   *
   * 其余段（`.a >> .b`）按**后代选择器**拼成 `.a .b` —— 语义近似
   * （Playwright 是「在 .a 内部找 .b」，后代选择器正好是这个意思）。
   * `>> text=xxx` / `>> role=xxx` 这类其它引擎**不支持**，
   * 会原样留在 base 里，浏览器报错后由 IPC 层给出「平台不支持」的准确说法。
   */
  const parts = s.split('>>').map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const kept = [];
    const posFilters = [];
    for (const p of parts) {
      const mNth = /^nth\s*=\s*(-?\d+)$/.exec(p);
      if (mNth) posFilters.push(Number(mNth[1]));
      else kept.push(p);
    }
    // 有位置段就从原选择器里去掉它们
    const hadPos = posFilters.length > 0;
    if (hadPos) {
      s = kept.join(' ');
      for (const n of posFilters) filters.push({ kind: 'nthPos', index: n });
    } else if (kept.length > 1) {
      // 没有位置段：多段都是选择器 → 后代选择器近似
      s = kept.join(' ');
    }
  }

  return { base: s.trim(), filters };
}

module.exports = {
  LOCATOR_MODES,
  RAW_MODE,
  REFINE_KEYS,
  SEMANTIC_METHOD,
  ARIA_ROLES,
  PW_PSEUDO_KINDS,
  normalizeLocatorMode,
  splitRoleSelector,
  escapeDoubleQuoted,
  ariaRoleExpr,
  parseRefine,
  parseOneRefine,
  parsePwSelector,
  previewLocatorCode
};