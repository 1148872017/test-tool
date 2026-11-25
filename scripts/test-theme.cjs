'use strict';
/**
 * 主题色跟随测试：切主题后 antd 组件必须跟着变色。
 *
 * 背景：themeConfig 曾经是静态常量（colorPrimary 写死 #6c5ce7），
 * 切主题只改了 CSS 变量 --primary，于是
 *   自己写的 .nav-item.active 变了，antd 的 Button / Select / DatePicker /
 *   Table 选中行依旧是紫色。
 * 这道测试盯的就是「token 是从主题色算出来的，不是写死的」，
 * 并且真的把 theme.ts 编译执行一遍（不是对源码做正则猜测）。
 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/**
 * 去掉注释后再做「不许出现」类判断。
 *
 * 说明性注释里会写「这里原本写死 #6c5ce7」「ConfigProvider 已下沉到 App」，
 * 那是解释不是代码；断言盯代码，别被注释误伤。
 */
const codeOnly = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

const { THEMES, DEFAULT_THEME, getTheme } = require('../shared/themes.js');
const DEFAULT_SKIN = getTheme(DEFAULT_THEME);

/* ============================================================
 * 0. 把 src/theme.ts 编成 CJS 后真跑一遍
 *
 * 为什么不直接正则：颜色可能是 mix/拼出来的，
 * 只有真执行 buildThemeConfig 才能确认 token.colorPrimary 等于传进来的主色。
 * ============================================================ */
function loadThemeModule() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(root, 'src', 'theme.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  });
  const code = out.outputFiles[0].text;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require);
  return mod.exports;
}

let themeMod = null;
let loadError = '';
try {
  themeMod = loadThemeModule();
} catch (e) {
  loadError = (e && e.message) || String(e);
}

check('theme.ts 能编译并加载', !!themeMod, loadError);
if (!themeMod) {
  report();
  process.exit(1);
}

const { buildThemeConfig, themeConfig } = themeMod;

/* ---------- 1. 导出形状 ---------- */
check('导出 buildThemeConfig 函数', typeof buildThemeConfig === 'function', typeof buildThemeConfig);
check('保留 themeConfig 常量导出（老引用不报错）', !!themeConfig && !!themeConfig.token, Object.keys(themeConfig || {}));
check(
  'themeConfig 默认色 = shared/themes 的默认主题',
  themeConfig.token.colorPrimary === DEFAULT_SKIN.primary &&
    themeConfig.token.colorLink === DEFAULT_SKIN.primaryText,
  { colorPrimary: themeConfig.token.colorPrimary, colorLink: themeConfig.token.colorLink }
);

/* ---------- 2. 单参调用：colorPrimary 必须原样是入参 ---------- */
const one = buildThemeConfig('#123456');
check('buildThemeConfig(primary) 的 colorPrimary 等于入参', one.token.colorPrimary === '#123456', one.token.colorPrimary);
check('colorInfo 跟 colorPrimary 一致', one.token.colorInfo === '#123456', one.token.colorInfo);
check('不传 primaryText 时 colorLink 退化成主色', one.token.colorLink === '#123456', one.token.colorLink);

/* ---------- 3. 五个主题逐个过 ---------- */
for (const t of THEMES) {
  const cfg = buildThemeConfig(t.primary, t.primaryText);
  check(`${t.key} token.colorPrimary = ${t.primary}`, cfg.token.colorPrimary === t.primary, cfg.token.colorPrimary);
  check(`${t.key} token.colorLink = ${t.primaryText}`, cfg.token.colorLink === t.primaryText, cfg.token.colorLink);
  check(`${t.key} colorLinkHover = 填充色`, cfg.token.colorLinkHover === t.primary, cfg.token.colorLinkHover);
}

const primaries = THEMES.map((t) => buildThemeConfig(t.primary, t.primaryText).token.colorPrimary);
check('5 个主题的 colorPrimary 各不相同', new Set(primaries).size === THEMES.length, primaries);

/* ---------- 4. 组件级 token 也必须跟着算（列表 / 下拉 / 按钮 / 输入框） ---------- */
const configs = THEMES.map((t) => ({ t, cfg: buildThemeConfig(t.primary, t.primaryText) }));
const purple = configs.find((c) => c.t.key === DEFAULT_THEME).cfg;

for (const { t, cfg } of configs) {
  // 列表 hover 行底色：上一版写死 #f8f7ff（紫）
  check(`${t.key} 表格 hover 行底色不是写死紫`, cfg.components.Table.rowHoverBg !== '#f8f7ff', cfg.components.Table.rowHoverBg);
  check(
    `${t.key} 表格 hover 行底色是合法 hex`,
    /^#[0-9a-f]{6}$/i.test(cfg.components.Table.rowHoverBg),
    cfg.components.Table.rowHoverBg
  );
  // 下拉选中项底色：上一版写死 #f1eeff（紫）
  check(
    `${t.key} 下拉选中项底色不是写死紫`,
    cfg.components.Select.optionSelectedBg !== '#f1eeff',
    cfg.components.Select.optionSelectedBg
  );
  // 主按钮投影 / 输入框聚焦光晕：必须带当前主题色的 rgb
  const rgb = [
    parseInt(t.primary.slice(1, 3), 16),
    parseInt(t.primary.slice(3, 5), 16),
    parseInt(t.primary.slice(5, 7), 16)
  ].join(', ');
  check(`${t.key} 主按钮投影用当前主题色`, cfg.components.Button.primaryShadow.includes(rgb), cfg.components.Button.primaryShadow);
  check(`${t.key} 输入框聚焦光晕用当前主题色`, cfg.components.Input.activeShadow.includes(rgb), cfg.components.Input.activeShadow);
}

// 只有「每个主题都不同」才说明它真的跟主题走，而不是跟紫色走
const hoverBgs = configs.map((c) => c.cfg.components.Table.rowHoverBg);
check('5 个主题的表格 hover 行底色各不相同', new Set(hoverBgs).size === THEMES.length, hoverBgs);
const optionBgs = configs.map((c) => c.cfg.components.Select.optionSelectedBg);
check('5 个主题的下拉选中底色各不相同', new Set(optionBgs).size === THEMES.length, optionBgs);
check(
  '非紫主题的表格 hover 行底色 ≠ 紫主题的',
  configs.filter((c) => c.t.key !== DEFAULT_THEME).every((c) => c.cfg.components.Table.rowHoverBg !== purple.components.Table.rowHoverBg),
  hoverBgs
);
check(
  '非紫主题的下拉选中底色 ≠ 紫主题的',
  configs
    .filter((c) => c.t.key !== DEFAULT_THEME)
    .every((c) => c.cfg.components.Select.optionSelectedBg !== purple.components.Select.optionSelectedBg),
  optionBgs
);

/* ---------- 5. 源码层：不许再把紫色写死在 token 里 ---------- */
const themeSrc = codeOnly(read('src', 'theme.ts'));
check('theme.ts 里没有 #6c5ce7', !/#6c5ce7/i.test(themeSrc), (themeSrc.match(/#6c5ce7/gi) || []).length);
check('theme.ts 里没有 #5443d6', !/#5443d6/i.test(themeSrc), (themeSrc.match(/#5443d6/gi) || []).length);
check('theme.ts 里没有 #efecff', !/#efecff/i.test(themeSrc), (themeSrc.match(/#efecff/gi) || []).length);
check('colorPrimary 取自参数而不是字面量', /colorPrimary:\s*primary\b/.test(themeSrc), 'colorPrimary 还是常量');
check('默认主题色取自 shared/themes', /from\s+['"]\.\.\/shared\/themes['"]/.test(themeSrc), '没复用主题定义');

/* ---------- 6. 接线：ConfigProvider 的 theme 必须是现算的 ---------- */
const mainSrc = codeOnly(read('src', 'main.tsx'));
const appSrc = codeOnly(read('src', 'App.tsx'));

check('main.tsx 不再 import 静态 themeConfig', !/themeConfig/.test(mainSrc), 'main.tsx 还引用 themeConfig');
check('main.tsx 里没有 ConfigProvider（下沉到 App）', !/ConfigProvider/.test(mainSrc), 'ConfigProvider 还在入口');
check('App.tsx 用 buildThemeConfig 现算主题', /buildThemeConfig\(/.test(appSrc), '没调用 buildThemeConfig');
check('App.tsx 用 useMemo 缓存主题', /useMemo\(\s*\(\)\s*=>\s*buildThemeConfig|useMemo\([\s\S]{0,80}buildThemeConfig/.test(appSrc), '没有 useMemo');
check(
  'App.tsx 的 ConfigProvider 用的是 antdTheme 变量',
  /<ConfigProvider[^>]*theme=\{antdTheme\}/.test(appSrc),
  'theme 不是 antdTheme'
);
check('App.tsx 仍然只有 useSkin 注入 CSS 变量', /function useSkin/.test(appSrc) && /setProperty\('--primary'/.test(appSrc));
check(
  'App.tsx 把同一份颜色同时给 CSS 变量和 token',
  /buildThemeConfig\(skin\.primary,\s*skin\.primaryText\)/.test(appSrc),
  '两边取色不一致'
);

/* ---------- 7. styles.css：五类组件的覆盖里不许再硬编码紫色 ---------- */
const css = read('src', 'styles.css');
const cssCode = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

/** 抽出所有选择器块：[{ sel, body }]（本文件没有嵌套规则，够用） */
function blocks(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}
const RULES = blocks(cssCode);
const PURPLE = /#6c5ce7|#5443d6|#efecff|#f1eeff|#f8f7ff|rgba\(\s*108,\s*92,\s*231/gi;

/** 某类选择器里凡设置颜色都必须是 var(--primary...)，不许写死紫 */
function purpleIn(selRe) {
  return RULES.filter((r) => selRe.test(r.sel) && PURPLE.test(r.body)).map((r) => r.sel);
}

check('白底按钮（.ant-btn）覆盖里没有硬编码紫', purpleIn(/\.ant-btn/).length === 0, purpleIn(/\.ant-btn/));
check('下拉框（.ant-select）覆盖里没有硬编码紫', purpleIn(/\.ant-select/).length === 0, purpleIn(/\.ant-select/));
check('日期选择框（.ant-picker）覆盖里没有硬编码紫', purpleIn(/\.ant-picker/).length === 0, purpleIn(/\.ant-picker/));
check(
  '列表记录底色（.ant-table 行）覆盖里没有硬编码紫',
  purpleIn(/\.ant-table/).length === 0,
  purpleIn(/\.ant-table/)
);

/* 主题色变量自身：只允许在 :root 定义各一次，别处不许重复写死 */
for (const hex of ['#6c5ce7', '#5443d6', '#efecff']) {
  const n = (cssCode.match(new RegExp(hex, 'gi')) || []).length;
  check(`styles.css 里 ${hex} 只在 :root 出现一次`, n === 1, n);
}
check('有 --primary-line（主题色派生边框）', /--primary-line:/.test(cssCode), 'no --primary-line');
check('有 --primary-glow（主题色光晕）', /--primary-glow:/.test(cssCode), 'no --primary-glow');
check('派生色用 color-mix 跟着 --primary 走', /--primary-line:\s*color-mix\([^)]*var\(--primary\)/.test(cssCode), '派生色没跟 --primary');

/* ---------- 8. 侧栏「设置」按钮：选中态用变量而不是写死紫 ---------- */
const sidebarSrc = codeOnly(read('src', 'components', 'Sidebar.tsx'));
check(
  '侧栏设置按钮选中态用 var(--primary-soft)/var(--primary-text)',
  /var\(--primary-soft\)/.test(sidebarSrc) && /var\(--primary-text\)/.test(sidebarSrc),
  'still hardcoded'
);
check('侧栏设置按钮不再写死 #efecff/#5443d6', !/#efecff|#5443d6/i.test(sidebarSrc), 'hardcoded remains');

report();
process.exit(results.filter((r) => !r.ok).length ? 1 : 0);

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log('===== 主题色跟随测试（token 必须跟着主题走） =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
}