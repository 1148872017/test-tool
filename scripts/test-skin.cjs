/* 皮肤收口：只剩主题色 5 选 1（背景图/蒙版/透明度/文字深浅全部下线） */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/* ============================================================
 * 0. WCAG 对比度：真算，不写死数字
 * ============================================================ */
const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (hex) => {
  const s = String(hex).replace('#', '');
  const n = parseInt(s, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** 对比度（1:1 ~ 21:1） */
const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};
const AA = 4.5;
const WHITE = '#ffffff';
const fmt = (r) => r.toFixed(2) + ':1';

/**
 * 去掉注释后再做「不许出现」的判断。
 *
 * 为什么要去注释：删功能时留下的说明注释里会写「背景蒙版 / --panel-alpha 已下线」，
 * 那是解释，不是引用。断言应该盯代码，别被注释误伤；反过来，
 * 注释里写什么都不影响「代码里确实没有」这个结论。
 */
const codeOnly = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');

/* ---------- 1. 主题定义：5 种，砍掉 cyan / orange ---------- */
const { THEMES, THEME_MAP, DEFAULT_THEME, getTheme } = require('../shared/themes.js');

check('主题只有 5 种', THEMES.length === 5, THEMES.map((t) => t.key));
check('主题键不重复', new Set(THEMES.map((t) => t.key)).size === THEMES.length, THEMES.map((t) => t.key));
check('已下线 cyan', !THEMES.some((t) => t.key === 'cyan'), THEMES.map((t) => t.key));
check('已下线 orange', !THEMES.some((t) => t.key === 'orange'), THEMES.map((t) => t.key));
check('THEME_MAP 里也没有 cyan 实体', !THEME_MAP.cyan, Object.keys(THEME_MAP));
check('THEME_MAP 里也没有 orange 实体', !THEME_MAP.orange, Object.keys(THEME_MAP));
check('默认仍是紫色', DEFAULT_THEME === 'purple', DEFAULT_THEME);

// 每个主题必须有三档颜色
for (const t of THEMES) {
  check(`${t.key} 有 primary/primaryText/soft`, !!(t.primary && t.primaryText && t.soft), {
    primary: t.primary,
    primaryText: t.primaryText,
    soft: t.soft
  });
  check(`${t.key} 三个颜色都是 hex`, [t.primary, t.primaryText, t.soft].every((c) => /^#[0-9a-f]{6}$/i.test(c)), t);
}

/* ---------- 2. 对比度守卫（这条是真算的） ---------- */
for (const t of THEMES) {
  const fill = contrast(t.primary, WHITE);
  check(`${t.key} primary 配白字 ≥4.5（实际 ${fmt(fill)}）`, fill >= AA, fmt(fill));

  const text = contrast(t.primaryText, WHITE);
  check(`${t.key} primaryText 压白底 ≥4.5（实际 ${fmt(text)}）`, text >= AA, fmt(text));

  // primaryText 必须比 primary 深一档，否则「文字色」和「填充色」分不出层级
  check(`${t.key} primaryText 深于 primary`, luminance(t.primaryText) < luminance(t.primary), {
    primary: t.primary,
    primaryText: t.primaryText
  });
}

/* ---------- 3. 老 key 迁移：按色相就近，不许掉回紫色 ---------- */
check('cyan 迁移到 blue', getTheme('cyan').key === 'blue', getTheme('cyan').key);
check('orange 迁移到 red', getTheme('orange').key === 'red', getTheme('orange').key);
check('迁移没掉回默认紫', getTheme('cyan').key !== DEFAULT_THEME && getTheme('orange').key !== DEFAULT_THEME, {
  cyan: getTheme('cyan').key,
  orange: getTheme('orange').key
});
check('未知 key 仍兜底默认', getTheme('nonexistent').key === DEFAULT_THEME, getTheme('nonexistent').key);
check('getTheme 正常返回', getTheme('blue').primary === THEME_MAP.blue.primary, getTheme('blue').primary);

/* ---------- 4. CSS 文字色 token ---------- */
const css = read('src', 'styles.css');
/** 去掉注释的 CSS，用于「不许出现」类断言 */
const cssCode = codeOnly(css);

/** 从 :root 里抠一个颜色 token，抠不到返回 null */
const cssToken = (name) => {
  const m = css.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'));
  return m ? m[1] : null;
};
const bg = cssToken('bg');
const lineSoft = cssToken('line-soft');
const muted = cssToken('muted');
const text3 = cssToken('text-3');

check('有 --muted token', !!muted, muted);
check('有 --text-3 token', !!text3, text3);
check('有 --bg / --line-soft（对比度要用）', !!bg && !!lineSoft, { bg, lineSoft });

if (muted && text3 && bg && lineSoft) {
  check(`--muted 压白底 ≥4.5（实际 ${fmt(contrast(muted, WHITE))}）`, contrast(muted, WHITE) >= AA, muted);
  check(`--muted 压 --bg ≥4.5（实际 ${fmt(contrast(muted, bg))}）`, contrast(muted, bg) >= AA, muted);
  check(`--text-3 压白底 ≥4.5（实际 ${fmt(contrast(text3, WHITE))}）`, contrast(text3, WHITE) >= AA, text3);
  check(`--text-3 压 --bg ≥4.5（实际 ${fmt(contrast(text3, bg))}）`, contrast(text3, bg) >= AA, text3);
  check(`--text-3 压 --line-soft ≥4.5（实际 ${fmt(contrast(text3, lineSoft))}）`, contrast(text3, lineSoft) >= AA, text3);
  // 两档必须拉开差距，否则「次级 / 第三级」没有层级
  check('--text-3 比 --muted 浅（保留层级）', luminance(text3) > luminance(muted), { muted, text3 });
}

/* ---------- 5. 全站文本字号/文字色守卫 ---------- */
/** 递归收集 src 下的 tsx / ts */
const walk = (dir, out) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(ent.name)) out.push(full);
  }
  return out;
};
const codeFiles = walk(path.join(root, 'src'), []).concat([path.join(root, 'src', 'styles.css')]);
const scan = (re) => {
  const hits = [];
  for (const f of codeFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const n = (src.match(re) || []).length;
    if (n) hits.push(path.relative(root, f) + ' ×' + n);
  }
  return hits;
};

/* 守卫 5：全站不含 11.5px（12px 是底线） */
check('全站没有 11.5px 字号', scan(/11\.5px/g).length === 0, scan(/11\.5px/g));
/* 守卫：过淡的硬编码文字色不再出现 */
check('全站没有 #9aa1b4（2.58:1）', scan(/#9aa1b4/gi).length === 0, scan(/#9aa1b4/gi));
check('全站没有 #7b8296（3.84:1）', scan(/#7b8296/gi).length === 0, scan(/#7b8296/gi));

/* ---------- 6. CSS：背景图那套结构必须清干净 ---------- */
/* 守卫 1：没有毛玻璃 */
check('styles.css 不含 backdrop-filter', !/backdrop-filter/.test(cssCode), 'still has blur');
/* 守卫 2：没有背景图开关类 */
check('styles.css 不含 body.has-bg', !/body\.has-bg/.test(cssCode), 'still has has-bg');
check('styles.css 不含背景蒙版层', !/has-bg::before/.test(cssCode), 'still has overlay layer');
check('styles.css 不含 --panel-alpha', !/--panel-alpha/.test(cssCode), 'still has panel alpha');
check('styles.css 不含 --bg-overlay', !/--bg-overlay/.test(cssCode), 'still has overlay var');
check('styles.css 不含 --skin-text-shadow', !/--skin-text-shadow/.test(cssCode), 'still has text shadow var');
check('styles.css 不含半透明面板', !/rgba\(var\(--panel-rgb/.test(cssCode), 'still translucent panel');
/* 只留下主题色相关的那几个选择器 */
check('CSS 保留 .skin-swatch', /\.skin-swatch/.test(cssCode), 'no swatch');
check('CSS 保留 .skin-themes', /\.skin-themes/.test(cssCode), 'no themes row');
check('CSS 删掉 .skin-bg-preview', !/\.skin-bg-preview/.test(cssCode), 'preview css remains');
check('CSS 删掉 .skin-bg-empty', !/\.skin-bg-empty/.test(cssCode), 'empty css remains');
check('CSS 删掉 .skin-opacity', !/\.skin-opacity/.test(cssCode), 'opacity css remains');
/* 主题色变量跟着 5 色收口 */
check('CSS 有 --primary-text（文字档）', /--primary-text:/.test(cssCode), 'no primary-text');
check('CSS 没有 --primary-deep（旧命名）', !/--primary-deep/.test(cssCode), 'old var remains');

/* ---------- 7. SkinCard：只剩主题色 ---------- */
const skinSrc = read('src', 'components', 'SkinCard.tsx');
/** 去掉注释的组件源码，用于「不许出现」类断言 */
const skinCode = codeOnly(skinSrc);
check('SkinCard 有主题色选择', /THEMES\.map/.test(skinCode), 'no themes');
check('SkinCard 用 t.primary 上色', /t\.primary/.test(skinCode), 'no primary color');
/* 老配置存 cyan/orange 时，高亮要落在迁移后的 blue/red 上，否则一个勾都不亮 */
check('SkinCard 用 getTheme 反查生效主题', /getTheme\(/.test(skinCode), 'no getTheme');
check('SkinCard 不再读背景图', !/skinGetImage|skinPickImage|skinClearImage/.test(skinCode), 'still reads image');
check('SkinCard 没有透明度滑块', !/Slider/.test(skinCode) && !/min=\{0\}/.test(skinCode) && !/max=\{100\}/.test(skinCode), 'slider remains');
check('SkinCard 没有拖动草稿状态', !/opacityDraft|overlayDraft/.test(skinCode), 'draft remains');
check('SkinCard 没有保存 bgOpacity/bgOverlay', !/bgOpacity|bgOverlay/.test(skinCode), 'still saves bg settings');
check('SkinCard 没有文字深浅三档', !/bgTextMode|文字颜色|Segmented/.test(skinCode), 'text mode remains');
check('SkinCard 没有背景蒙版控件', !/背景蒙版|previewOverlay|蒙版/.test(skinCode), 'overlay control remains');
check('SkinCard 没有背景图预览块', !/skin-bg|PictureOutlined/.test(skinCode), 'bg block remains');

/* ---------- 8. App：useSkin 只注入主题色 ---------- */
const appSrc = read('src', 'App.tsx');
/** 去掉注释的 App 源码，用于「不许出现」类断言 */
const appCode = codeOnly(appSrc);
check('App 有 useSkin', /function useSkin/.test(appCode), 'no useSkin');
check('App 注入 --primary', /setProperty\('--primary'/.test(appCode), 'no primary');
check('App 注入 --primary-text', /setProperty\('--primary-text'/.test(appCode), 'no primary-text');
check('App 注入 --primary-soft', /setProperty\('--primary-soft'/.test(appCode), 'no soft');
check('App 不再注入 --panel-alpha', !/--panel-alpha/.test(appCode), 'panel alpha remains');
check('App 不再注入 --bg-overlay', !/--bg-overlay/.test(appCode), 'overlay var remains');
check('App 不再注入文字阴影', !/--skin-text-shadow/.test(appCode), 'shadow remains');
check('App 不再设置背景图', !/backgroundImage/.test(appCode), 'still sets bg image');
check('App 不再加 has-bg class', !/has-bg/.test(appCode), 'still adds class');
check('App 不再读 bgOpacity/bgOverlay/bgTextMode', !/bgOpacity|bgOverlay|bgTextMode/.test(appCode), 'bg settings remain');
check('App 不再有文字加深逻辑', !/needDeep/.test(appCode), 'needDeep remains');
check('App 调用 useSkin', /useSkin\(boot/.test(appCode), 'not called');

/* ---------- 9. 设置层：主题色这一个字段不能跟着误删 ---------- */
const mainSrc = require('./_electron-src.cjs').readElectronSource();
check('DEFAULT_SETTINGS 有 themeColor', /themeColor: 'purple'/.test(mainSrc), 'no themeColor');
check('publicSettings 暴露 themeColor', /themeColor: settings\.themeColor/.test(mainSrc), 'not exposed');
check('allowed 含 themeColor', /'themeColor'/.test(mainSrc), 'not allowed');

/* ---------- 10. 设置页接入 ---------- */
const settingsSrc = read('src', 'pages', 'SettingsPage.tsx');
check('设置页接入 SkinCard', /<SkinCard/.test(settingsSrc), 'not used');
check('有 sec-skin 锚点', /id="sec-skin"/.test(settingsSrc), 'no anchor');
check('导航有「外观」', /label: '外观'/.test(settingsSrc), 'no nav item');

const failed = results.filter((r) => !r.ok);
console.log('===== 皮肤收口测试（主题色 5 选 1） =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);