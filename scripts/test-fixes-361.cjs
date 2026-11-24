/* v0.36.1 修复的 5 个 bug */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const mainSrc = require('./_electron-src.cjs').readElectronSource();
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
const skinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SkinCard.tsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const nsisSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
const jmxgenSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'jmxgen.js'), 'utf8');
const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ScriptGenPage.tsx'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');

/* ============================================================
 * #1 安装提示：说清楚「可能在托盘里」
 * ============================================================ */
check('安装提示提到托盘', /托盘/.test(nsisSrc), 'no tray hint');
check('安装提示说会自动关', /点「确定」我会自动关闭它/.test(nsisSrc), 'no auto-close hint');
check('进程检测仍用 find 退出码', /find \/I/.test(nsisSrc), 'no find');
check('进程检测用 StrCmp \$R2', /StrCmp \$R2 "0"/.test(nsisSrc), 'no strcmp');
check('托盘菜单有退出', /label: '退出'/.test(mainSrc), 'no quit menu');

// #1：默认保持 tray（用户要求保留托盘功能），只是把提示说清楚
check('默认 closeAction 是 tray', /closeAction: 'tray',/.test(mainSrc), 'changed default');
check('读取逻辑 quit 优先判断', /closeAction === 'quit' \? 'quit' : 'tray'/.test(mainSrc), 'wrong fallback');
check('设置里还能选两种行为', /value: 'tray'/.test(settingsSrc) && /value: 'quit'/.test(settingsSrc), 'options missing');
check('安装提示说清是正常行为', /这是正常行为，不是没关掉/.test(nsisSrc), 'no clarification');
check('安装提示给出误报出口', /误报/.test(nsisSrc), 'no false-positive exit');
check('设置页显示逻辑同步', /closeAction === 'quit' \? 'quit' : 'tray'/.test(settingsSrc), 'ui not synced');
check('设置页说明提到后台进程', /会在后台留进程/.test(settingsSrc), 'no hint');
check('mock 默认也是 tray', /closeAction: 'tray'/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'mockApi.ts'), 'utf8')
), 'mock not synced');

/* ============================================================
 * #2 透明度滑块：松手才保存
 * ============================================================ */
check('SkinCard 有 draft 状态', /opacityDraft/.test(skinSrc), 'no draft');
check('Slider 用 onChangeComplete', /onChangeComplete/.test(skinSrc), 'no onChangeComplete');
check('onChange 只做预览（不保存）', /previewOpacity/.test(skinSrc), 'no preview fn');
check('提交时才 saveSettings', /commitOpacity/.test(skinSrc), 'no commit fn');
check('显示值用 draft 优先', /shownOpacity/.test(skinSrc), 'no shownOpacity');

/* ============================================================
 * #3 低透明度文字清晰度
 * ============================================================ */
check('alpha 下限提高到 0.62', /0\.62 \+/.test(appSrc), 'alpha min not raised');
check('不再用 0.35 下限', !/0\.35 \+/.test(appSrc), 'still 0.35');
check('注入文字阴影变量', /--skin-text-shadow/.test(appSrc), 'no shadow var');
check('有文字加深逻辑', /needDeep/.test(appSrc), 'no deep logic');
check('CSS 用了 text-shadow 变量', /--skin-text-shadow/.test(cssSrc), 'css no shadow');
check('侧栏标题单独加强', /nav-group-label/.test(cssSrc), 'no nav label css');
check('有 bgTextMode 设置项', /bgTextMode/.test(mainSrc), 'no bgTextMode');
check('SkinCard 有文字颜色选择', /文字颜色/.test(skinSrc), 'no text color ui');

/* ============================================================
 * #4 jmx 版本跟设置走
 * ============================================================ */
check('jmxgen 接受 jmeterVersion', /opts\.jmeterVersion/.test(jmxgenSrc), 'no param');
check('jmxgen 不再硬编码 5.6.3', !/jmeter="5\.6\.3"/.test(jmxgenSrc), 'still hardcoded');
check('jmxgen 用变量写版本', /esc\(jmeterVersion\)/.test(jmxgenSrc), 'no var');
check('IPC 从 settings 读版本', /jmeterVersionOf\(settings\.jmeterPath\)/.test(mainSrc), 'no read');
check('preview 返回版本', /jmeterVersion: jmeterVersion \|\| '5\.6\.3'/.test(mainSrc), 'not returned');
check('前端显示版本', /jmeterVersion/.test(scriptSrc), 'ui not showing');

/* ============================================================
 * #5 Allure 目录设置
 * ============================================================ */
check('settings 有 allureDir', /allureDir: ''/.test(mainSrc), 'no default');
check('publicSettings 暴露 allureDir', /allureDir: settings\.allureDir/.test(mainSrc), 'not exposed');
check('allowed 含 allureDir', /'allureDir'/.test(mainSrc), 'not allowed');
check('allure:scan 优先用 allureDir', /settings\.allureDir \|\| settings\.projectDir/.test(mainSrc), 'not used');
check('设置页有 Allure 目录 UI', /Allure 报告目录/.test(settingsSrc), 'no ui');
check('设置页能选 Allure 目录', /doPickAllureDir/.test(settingsSrc), 'no picker');

/* ============================================================
 * 回归：确认原有功能没坏
 * ============================================================ */
const { generateJmx } = require('../shared/jmxgen.js');
const { parseJmx } = require('../electron/jmx.js');

// 默认版本
const g1 = generateJmx({
  apis: [{ data: { name: 'T', method: 'GET', url: 'http://x.com/a', headers: '', body: '', bodyType: 'none' } }],
  name: 'T'
});
const p1 = parseJmx(g1.xml, 't.jmx');
check('默认版本 5.6.3', p1.jmeterVersion === '5.6.3', p1.jmeterVersion);

// 指定版本
const g2 = generateJmx({
  apis: [{ data: { name: 'T', method: 'GET', url: 'http://x.com/a', headers: '', body: '', bodyType: 'none' } }],
  name: 'T',
  jmeterVersion: '5.4.3'
});
const p2 = parseJmx(g2.xml, 't.jmx');
check('指定版本生效', p2.jmeterVersion === '5.4.3', p2.jmeterVersion);
check('指定版本后仍可解析', p2.parseError === '', p2.parseError);
check('指定版本后结构正确', p2.threadGroups.length === 1 && p2.samplers.length === 1, {
  tg: p2.threadGroups.length,
  s: p2.samplers.length
});

// 空版本兜底
const g3 = generateJmx({
  apis: [{ data: { name: 'T', method: 'GET', url: 'http://x.com/a', headers: '', body: '', bodyType: 'none' } }],
  name: 'T',
  jmeterVersion: ''
});
check('空版本兜底 5.6.3', parseJmx(g3.xml, 't.jmx').jmeterVersion === '5.6.3', 'not fallback');

/* ============================================================
 * mock 字段白名单（老坑 #58 的翻版）
 * ============================================================ */
const mockSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'mockApi.ts'), 'utf8');
check('mock 有 bgTextMode', /bgTextMode/.test(mockSrc), 'mock missing');
check('mock 有 allureDir', /allureDir/.test(mockSrc), 'mock missing');
check('mock boot 白名单含 bgTextMode', /bgTextMode: settings\.bgTextMode/.test(mockSrc), 'not in whitelist');
check('mock boot 白名单含 allureDir', /allureDir: settings\.allureDir/.test(mockSrc), 'not in whitelist');
check('mock jmxgenPreview 返回版本', /jmeterVersion: '5\.6\.3'/.test(mockSrc), 'mock no version');

const failed = results.filter((r) => !r.ok);
console.log('===== v0.36.1 修复测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);