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

module.exports = {
  LOCATOR_MODES,
  RAW_MODE,
  REFINE_KEYS,
  SEMANTIC_METHOD,
  ARIA_ROLES,
  normalizeLocatorMode,
  splitRoleSelector,
  escapeDoubleQuoted,
  ariaRoleExpr,
  parseRefine,
  parseOneRefine,
  previewLocatorCode
};