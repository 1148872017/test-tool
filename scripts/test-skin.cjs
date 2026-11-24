/* 皮肤设置：主题色 + 背景图 + 透明度 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 主题定义 ---------- */
const { THEMES, THEME_MAP, DEFAULT_THEME, getTheme } = require('../shared/themes.js');

check('有 7 种主题', THEMES.length === 7, THEMES.length);
check('默认是紫色', DEFAULT_THEME === 'purple', DEFAULT_THEME);
check('有 purple', !!THEME_MAP.purple, Object.keys(THEME_MAP));
check('有 blue', !!THEME_MAP.blue, Object.keys(THEME_MAP));
check('有 cyan', !!THEME_MAP.cyan, Object.keys(THEME_MAP));
check('有 green', !!THEME_MAP.green, Object.keys(THEME_MAP));
check('有 orange', !!THEME_MAP.orange, Object.keys(THEME_MAP));
check('有 red', !!THEME_MAP.red, Object.keys(THEME_MAP));
check('有 gray', !!THEME_MAP.gray, Object.keys(THEME_MAP));

// 每个主题必须有三个颜色
for (const t of THEMES) {
  check(`${t.key} 有 primary/primaryDeep/primarySoft`, !!(t.primary && t.primaryDeep && t.primarySoft), t);
  check(`${t.key} 颜色是 hex`, /^#[0-9a-f]{6}$/i.test(t.primary), t.primary);
}

// getTheme 兜底
check('getTheme 未知返回默认', getTheme('nonexistent').key === 'purple', getTheme('nonexistent').key);
check('getTheme 正常返回', getTheme('blue').primary === '#2f80ed', getTheme('blue').primary);

/* ---------- 2. settings 字段 ---------- */
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('DEFAULT_SETTINGS 有 themeColor', /themeColor: 'purple'/.test(mainSrc), 'no themeColor');
check('DEFAULT_SETTINGS 有 bgImage', /bgImage: ''/.test(mainSrc), 'no bgImage');
check('DEFAULT_SETTINGS 有 bgOpacity', /bgOpacity: 85/.test(mainSrc), 'no bgOpacity');
check('publicSettings 暴露 themeColor', /themeColor: settings\.themeColor/.test(mainSrc), 'not exposed');
check('publicSettings 暴露 bgImage', /bgImage: settings\.bgImage/.test(mainSrc), 'not exposed');
check('publicSettings 暴露 bgOpacity', /bgOpacity: settings\.bgOpacity/.test(mainSrc), 'not exposed');
check('allowed 含 themeColor', /'themeColor'/.test(mainSrc), 'not allowed');
check('allowed 含 bgImage', /'bgImage'/.test(mainSrc), 'not allowed');
check('allowed 含 bgOpacity', /'bgOpacity'/.test(mainSrc), 'not allowed');

/* ---------- 3. 皮肤 IPC ---------- */
check('有 skin:pickImage', /ipcMain\.handle\('skin:pickImage'/.test(mainSrc), 'no pickImage');
check('有 skin:clearImage', /ipcMain\.handle\('skin:clearImage'/.test(mainSrc), 'no clearImage');
check('有 skin:getImage', /ipcMain\.handle\('skin:getImage'/.test(mainSrc), 'no getImage');
check('图片大小限制 20MB', /20 \* 1024 \* 1024/.test(mainSrc), 'no size limit');
check('背景图存 skin 目录', /skinDir/.test(mainSrc), 'no skinDir');
check('getImage 返回 data URL', /data:\$\{mime\};base64/.test(mainSrc), 'no data url');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 skinPickImage', /skinPickImage:/.test(preloadSrc), 'no pick');
check('preload 有 skinClearImage', /skinClearImage:/.test(preloadSrc), 'no clear');
check('preload 有 skinGetImage', /skinGetImage:/.test(preloadSrc), 'no get');

/* ---------- 4. 前端组件 ---------- */
const skinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SkinCard.tsx'), 'utf8');
check('SkinCard 有主题色选择', /THEMES\.map/.test(skinSrc), 'no themes');
check('SkinCard 有背景图预览', /skin-bg-preview/.test(skinSrc), 'no preview');
check('SkinCard 有透明度滑块', /Slider/.test(skinSrc), 'no slider');
check('SkinCard 透明度 0-100', /min=\{0\}/.test(skinSrc) && /max=\{100\}/.test(skinSrc), 'wrong range');

/* ---------- 5. 全局应用 ---------- */
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
check('App 有 useSkin', /function useSkin/.test(appSrc), 'no useSkin');
check('App 注入 --primary', /setProperty\('--primary'/.test(appSrc), 'no primary');
check('App 注入 --primary-deep', /setProperty\('--primary-deep'/.test(appSrc), 'no deep');
check('App 注入 --primary-soft', /setProperty\('--primary-soft'/.test(appSrc), 'no soft');
check('App 注入 --panel-alpha', /setProperty\('--panel-alpha'/.test(appSrc), 'no alpha');
check('App 设置背景图', /backgroundImage/.test(appSrc), 'no bg');
check('App 加 has-bg class', /has-bg/.test(appSrc), 'no class');
check('App 调用 useSkin', /useSkin\(boot/.test(appSrc), 'not called');

/* ---------- 6. CSS ---------- */
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
check('CSS 有 body.has-bg', /body\.has-bg/.test(css), 'no has-bg');
check('CSS 有 backdrop-filter', /backdrop-filter/.test(css), 'no blur');
check('CSS 用 --panel-alpha', /--panel-alpha/.test(css), 'no alpha var');
check('CSS 有 skin-swatch', /\.skin-swatch/.test(css), 'no swatch');
check('CSS 有 skin-bg-preview', /\.skin-bg-preview/.test(css), 'no preview');

/* ---------- 7. 设置页接入 ---------- */
const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
check('设置页接入 SkinCard', /<SkinCard/.test(settingsSrc), 'not used');
check('有 sec-skin 锚点', /id="sec-skin"/.test(settingsSrc), 'no anchor');
check('导航有「皮肤」', /label: '皮肤'/.test(settingsSrc), 'no nav item');

const failed = results.filter((r) => !r.ok);
console.log('===== 皮肤设置测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
