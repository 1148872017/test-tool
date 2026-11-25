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
  'testid'
];

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

/**
 * 生成一行定位代码（表格里的实时预览、以及 POM 模板，都用这一个函数）。
 *
 * @param {string} mode 定位方式（css / xpath / role / label / ...）
 * @param {string} selector 用户填的定位值
 * @param {'java'|'python'} [lang] 目标语言，缺省 java
 * @returns {string} 定位代码；定位值为空时返回空串（由 UI 决定显示「等待输入」）
 */
function previewLocatorCode(mode, selector, lang) {
  const language = lang === 'python' ? 'python' : 'java';
  const page = language === 'python' ? 'self.page' : 'page';
  const m = normalizeLocatorMode(mode);
  const s = String(selector === undefined || selector === null ? '' : selector).trim();
  if (!s) return '';

  const q = (v) => '"' + escapeDoubleQuoted(v) + '"';

  if (m === 'css') return page + '.locator(' + q(s) + ')';
  // 用户只填 //div[@id="x"]，xpath= 前缀由生成器补（别让人手写引擎前缀）
  if (m === 'xpath') return page + '.locator("xpath=' + escapeDoubleQuoted(s) + '")';

  if (m === 'role') {
    const { role, name } = splitRoleSelector(s);
    // 角色为空（只写了「:名称」）→ 退回普通 locator，不生成非法调用
    if (!role) return page + '.locator(' + q(s) + ')';
    if (language === 'python') {
      return page + '.get_by_role(' + q(role) + (name ? ', name=' + q(name) : '') + ')';
    }
    return (
      page +
      '.getByRole(' +
      ariaRoleExpr(role) +
      (name ? ', new Page.GetByRoleOptions().setName(' + q(name) + ')' : '') +
      ')'
    );
  }

  return page + '.' + SEMANTIC_METHOD[m][language] + '(' + q(s) + ')';
}

module.exports = {
  LOCATOR_MODES,
  SEMANTIC_METHOD,
  ARIA_ROLES,
  normalizeLocatorMode,
  splitRoleSelector,
  escapeDoubleQuoted,
  ariaRoleExpr,
  previewLocatorCode
};