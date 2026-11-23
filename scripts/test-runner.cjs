/* 代码调试：运行器配置 + 项目扫描 + 环境探测 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 运行器配置 ---------- */
const { RUNNERS, listRunners } = require('../shared/runners.js');

check('有 4 个运行器', Object.keys(RUNNERS).length === 4, Object.keys(RUNNERS));
check('有 groovy 运行器', !!RUNNERS.groovy, 'no groovy');
check('有 python 运行器', !!RUNNERS.python, 'no python');
check('有 pytest 运行器', !!RUNNERS.pytest, 'no pytest');
check('有 maven 运行器', !!RUNNERS.maven, 'no maven');

// 每个运行器必须有 build 函数
for (const [k, r] of Object.entries(RUNNERS)) {
  check(`${k} 有 build 函数`, typeof r.build === 'function', typeof r.build);
  check(`${k} 有 label`, !!r.label, r.label);
  check(`${k} 声明了 needs`, Array.isArray(r.needs), r.needs);
}

// listRunners 给前端用
const list = listRunners();
check('listRunners 返回 4 项', list.length === 4, list.length);
check('listRunners 不含 build 函数', list.every((r) => !r.build), 'leaked build');

/* ---------- 2. build 函数行为 ---------- */
// groovy：缺 java 要报错
const g1 = RUNNERS.groovy.build({ java: '', jmeter: '' });
check('groovy 缺 java 报错', !!g1.error, g1);

// groovy：正常构造
const g2 = RUNNERS.groovy.build({ java: 'java.exe', jmeter: 'D:/jmeter', file: 'x.groovy' });
check('groovy 构造 cmd', g2.cmd === 'java.exe', g2.cmd);
check('groovy 用 GroovyMain', g2.args.includes('groovy.ui.GroovyMain'), g2.args);
check('groovy 带 -cp', g2.args.includes('-cp'), g2.args);

// python：缺 python 报错
const p1 = RUNNERS.python.build({ python: '' });
check('python 缺 python 报错', !!p1.error, p1);

// python：正常
const p2 = RUNNERS.python.build({ python: 'python.exe', file: 'x.py' });
check('python 构造 cmd', p2.cmd === 'python.exe', p2.cmd);
check('python 带 -X utf8', p2.args.includes('-X') && p2.args.includes('utf8'), p2.args);

// pytest：带 -m pytest
const pt = RUNNERS.pytest.build({ python: 'python.exe', file: 'x.py' });
check('pytest 带 -m pytest', pt.args.includes('-m') && pt.args.includes('pytest'), pt.args);
check('pytest 带 -v', pt.args.includes('-v'), pt.args);

// maven：缺 mvn 报错
const m1 = RUNNERS.maven.build({ mvn: '', projectDir: 'x' });
check('maven 缺 mvn 报错', !!m1.error, m1);

// maven：缺 projectDir 报错
const m2 = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: '' });
check('maven 缺 projectDir 报错', !!m2.error, m2);

// maven：正常（带测试类）
const m3 = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj', testClass: 'LoginTest' });
check('maven 构造 cmd', m3.cmd === 'mvn.cmd', m3.cmd);
check('maven 带 test', m3.args.includes('test'), m3.args);
check('maven 带 -Dtest', m3.args.includes('-Dtest=LoginTest'), m3.args);
check('maven cwd 是项目目录', m3.cwd === 'D:/proj', m3.cwd);

// maven：不带测试类（跑全部）
const m4 = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj' });
check('maven 不带测试类时不加 -Dtest', !m4.args.some((a) => a.startsWith('-Dtest=')), m4.args);

/* ---------- 3. 项目扫描 ---------- */
const projects = require('../electron/projects.js');

// 用临时目录造项目
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-test-'));

// Maven + REST Assured
const p1dir = path.join(tmp, 'api-test');
fs.mkdirSync(path.join(p1dir, 'src', 'test', 'java', 'com', 'x'), { recursive: true });
fs.writeFileSync(
  path.join(p1dir, 'pom.xml'),
  '<project><dependency><artifactId>rest-assured</artifactId></dependency><dependency><artifactId>testng</artifactId></dependency></project>',
  'utf8'
);
fs.writeFileSync(path.join(p1dir, 'src', 'test', 'java', 'com', 'x', 'LoginTest.java'), 'class LoginTest {}', 'utf8');

// Maven + Playwright
const p2dir = path.join(tmp, 'ui-test');
fs.mkdirSync(p2dir, { recursive: true });
fs.writeFileSync(path.join(p2dir, 'pom.xml'), '<project><artifactId>playwright</artifactId></project>', 'utf8');

// Python + pytest
const p3dir = path.join(tmp, 'py-test');
fs.mkdirSync(p3dir, { recursive: true });
fs.writeFileSync(path.join(p3dir, 'requirements.txt'), 'pytest>=7\nplaywright>=1.40\n', 'utf8');

// 非测试项目
const p4dir = path.join(tmp, 'tool');
fs.mkdirSync(p4dir, { recursive: true });
fs.writeFileSync(path.join(p4dir, 'requirements.txt'), 'openpyxl\n', 'utf8');

const scan = projects.scanProjects(tmp);
check('扫描成功', scan.ok === true, scan);
check('扫到 4 个项目', scan.projects.length === 4, scan.projects.length);

const byName = (n) => scan.projects.find((p) => p.name === n);

const api = byName('api-test');
check('识别 REST Assured', api && api.frameworks.some((f) => f.key === 'rest-assured'), api && api.frameworks);
check('识别 TestNG', api && api.frameworks.some((f) => f.key === 'testng'), api && api.frameworks);
check('api-test 是测试项目', api && api.isTest === true, api && api.isTest);

const ui = byName('ui-test');
check('识别 Playwright', ui && ui.frameworks.some((f) => f.key === 'playwright'), ui && ui.frameworks);

const py = byName('py-test');
check('识别 pytest', py && py.frameworks.some((f) => f.key === 'pytest'), py && py.frameworks);
check('识别 Python Playwright', py && py.frameworks.some((f) => f.key === 'playwright'), py && py.frameworks);

const tool = byName('tool');
check('非测试项目 isTest=false', tool && tool.isTest === false, tool && tool.isTest);

// 测试项目排前面
check('测试项目排前面', scan.projects[0].isTest === true, scan.projects.map((p) => p.isTest));

// 测试类列表
const classes = projects.listTestClasses(p1dir);
check('列出测试类', classes.includes('LoginTest'), classes);

// 边界
check('空目录返回 ok:false', projects.scanProjects('').ok === false);
check('不存在目录返回 ok:false', projects.scanProjects('D:/nonexistent-xyz').ok === false);

fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- 4. 环境探测 ---------- */
const runner = require('../electron/runner.js');
const env = runner.detectAll();
check('detectAll 返回 4 个字段', ['java', 'python', 'mvn', 'jmeter'].every((k) => k in env), Object.keys(env));
check('detect 找不到返回空串', runner.detect('nonexistent-xyz-abc') === '', runner.detect('nonexistent-xyz-abc'));

/* ---------- 5. IPC 已注册 ---------- */
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('有 runner:list', /ipcMain\.handle\('runner:list'/.test(mainSrc), 'no runner:list');
check('有 runner:run', /ipcMain\.handle\('runner:run'/.test(mainSrc), 'no runner:run');
check('有 runner:cancel', /ipcMain\.handle\('runner:cancel'/.test(mainSrc), 'no runner:cancel');
check('有 projects:scan', /ipcMain\.handle\('projects:scan'/.test(mainSrc), 'no projects:scan');
check('有 projects:testClasses', /ipcMain\.handle\('projects:testClasses'/.test(mainSrc), 'no projects:testClasses');

/* ---------- 6. preload 已暴露 ---------- */
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 runnerRun', /runnerRun:/.test(preloadSrc), 'no runnerRun');
check('preload 有 onRunnerOutput', /onRunnerOutput:/.test(preloadSrc), 'no onRunnerOutput');
check('preload 有 projectsScan', /projectsScan:/.test(preloadSrc), 'no projectsScan');

/* ---------- 7. 前端组件 ---------- */
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodeRunnerPage.tsx'), 'utf8');
check('组件订阅输出', /onRunnerOutput/.test(pageSrc), 'no subscribe');
check('组件有运行按钮', /doRun/.test(pageSrc), 'no run');
check('组件有取消按钮', /doCancel/.test(pageSrc), 'no cancel');
check('组件支持 Ctrl+Enter', /ctrlKey.*Enter/.test(pageSrc), 'no shortcut');
check('组件有输出面板', /runner-output/.test(pageSrc), 'no output panel');
check('Maven 模式不显示编辑器', /!isMaven \?/.test(pageSrc), 'maven shows editor');

/* ---------- 8. 侧边栏入口 ---------- */
const collections = require('../shared/collections.js');
check('TOOLS 有代码调试', collections.TOOLS.some((t) => t.key === 'runner'), collections.TOOLS.map((t) => t.key));
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
check('App 有 runner 路由', /route\.key === 'runner'/.test(appSrc), 'no route');
const iconsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'icons.tsx'), 'utf8');
check('BugOutlined 已注册', /BugOutlined/.test(iconsSrc), 'no icon');


/* ---------- 9. JDK 版本匹配（Maven 用 JAVA_HOME 不是 PATH）---------- */
const jdks = runner.listJdks();
check('listJdks 返回数组', Array.isArray(jdks), typeof jdks);
check('listJdks 按版本降序', jdks.length < 2 || jdks[0].version >= jdks[1].version, jdks.map((j) => j.version));

// readJavaVersion 从 pom.xml 读
const os2 = require('os');
const tmp2 = fs.mkdtempSync(path.join(os2.tmpdir(), 'jdk-test-'));
const projDir = path.join(tmp2, 'p');
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, 'pom.xml'), '<project><properties><java.version>17</java.version></properties></project>', 'utf8');
check('readJavaVersion 读到 17', runner.readJavaVersion(projDir) === 17, runner.readJavaVersion(projDir));

// 读不到返回 0
fs.writeFileSync(path.join(projDir, 'pom.xml'), '<project></project>', 'utf8');
check('readJavaVersion 读不到返回 0', runner.readJavaVersion(projDir) === 0, runner.readJavaVersion(projDir));

// detectJavaHome 按版本选
const home17 = runner.detectJavaHome(17);
check('detectJavaHome(17) 返回路径', typeof home17 === 'string', typeof home17);
if (home17) {
  check('detectJavaHome(17) 路径存在', fs.existsSync(path.join(home17, 'bin', 'java.exe')), home17);
}

fs.rmSync(tmp2, { recursive: true, force: true });

/* ---------- 10. main.js 传 JAVA_HOME ---------- */
check('main.js 按项目读 Java 版本', /runner\.readJavaVersion\(projectDir\)/.test(mainSrc), 'no readJavaVersion');
check('main.js 传 JAVA_HOME 给子进程', /env: env\.javaHome \? \{ JAVA_HOME: env\.javaHome \}/.test(mainSrc), 'no JAVA_HOME pass');

/* ---------- 11. Maven 镜像已配（阿里云）---------- */
const mvnSettings = 'D:/apache-maven-3.9.12/conf/settings.xml';
if (fs.existsSync(mvnSettings)) {
  const xml = fs.readFileSync(mvnSettings, 'utf8');
  // 阿里云镜像必须在 <mirrors> 里且没被注释
  const mirrorsBlock = (xml.match(/<mirrors>[\s\S]*?<\/mirrors>/) || [''])[0];
  const active = mirrorsBlock
    .split('\n')
    .filter((l) => !/^\s*<!--/.test(l))
    .join('\n');
  check('Maven 配了阿里云镜像', /aliyun/.test(active), 'no aliyun mirror');
}


/* ---------- 12. 多版本探测（Python / Playwright 浏览器）---------- */
const pythons = runner.listPythons();
check('listPythons 返回数组', Array.isArray(pythons), typeof pythons);
if (pythons.length) {
  check('Python 有 version 字段', 'version' in pythons[0], Object.keys(pythons[0]));
  check('Python 有 path 字段', !!pythons[0].path, pythons[0]);
}

const pw = runner.detectPlaywrightBrowsers();
check('detectPlaywrightBrowsers 返回对象', typeof pw === 'object', typeof pw);
check('有 found/dir/browsers/totalSize', ['found', 'dir', 'browsers', 'totalSize'].every((k) => k in pw), Object.keys(pw));
check('dir 是绝对路径', pw.dir.includes(':') || pw.dir.startsWith('/'), pw.dir);
if (pw.found) {
  check('browsers 是数组', Array.isArray(pw.browsers), typeof pw.browsers);
  check('totalSize > 0', pw.totalSize > 0, pw.totalSize);
}

/* ---------- 13. 设置项：手动指定环境路径 ---------- */
const mainSrc2 = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('DEFAULT_SETTINGS 有 javaHome', /javaHome: ''/.test(mainSrc2), 'no javaHome');
check('DEFAULT_SETTINGS 有 pythonPath', /pythonPath: ''/.test(mainSrc2), 'no pythonPath');
check('DEFAULT_SETTINGS 有 mvnPath', /mvnPath: ''/.test(mainSrc2), 'no mvnPath');
check('publicSettings 暴露 javaHome', /javaHome: settings\.javaHome/.test(mainSrc2), 'not exposed');
check('手动指定优先于自动探测', /if \(settings\.javaHome\) \{/.test(mainSrc2), 'manual not prioritized');

/* ---------- 14. IPC：环境状态 + 打开浏览器目录 ---------- */
check('runner:list 返回 jdks', /jdks: runner\.listJdks\(\)/.test(mainSrc2), 'no jdks');
check('runner:list 返回 pythons', /pythons: runner\.listPythons\(\)/.test(mainSrc2), 'no pythons');
check('runner:list 返回 manual', /manual: \{/.test(mainSrc2), 'no manual');
check('有 runner:openBrowserDir', /ipcMain\.handle\('runner:openBrowserDir'/.test(mainSrc2), 'no openBrowserDir');

/* ---------- 15. 前端：EnvCard + 侧边导航 + 引导弹窗 + 提示条 ---------- */
const envCardSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'EnvCard.tsx'), 'utf8');
check('EnvCard 存在', envCardSrc.length > 0, 'empty');
check('EnvCard 显示「只检测不下载」', /只检测，不下载、不安装/.test(envCardSrc), 'no disclaimer');
check('EnvCard 有 JDK 下拉', /JDK \$\{j\.version\}/.test(envCardSrc), 'no jdk select');
check('EnvCard 有 Python 下拉', /Python \$\{p\.version/.test(envCardSrc), 'no python select');
check('EnvCard 有 Playwright 浏览器状态', /Playwright 浏览器/.test(envCardSrc), 'no playwright');
check('EnvCard 有「打开目录」', /runnerOpenBrowserDir/.test(envCardSrc), 'no open dir');

const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
check('设置页接入 EnvCard', /<EnvCard/.test(settingsSrc), 'not used');
check('设置页有侧边导航', /settings-nav/.test(settingsSrc), 'no nav');
check('导航有 8+ 项', (settingsSrc.match(/id: 'sec-/g) || []).length >= 8, (settingsSrc.match(/id: 'sec-/g) || []).length);
check('卡片有锚点 id', /id="sec-env"/.test(settingsSrc), 'no anchor');

const pageSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodeRunnerPage.tsx'), 'utf8');
check('代码调试页有首次引导弹窗', /guideOpen/.test(pageSrc2), 'no guide');
check('引导用 localStorage 记一次', /runner-guide-seen/.test(pageSrc2), 'no localStorage');
check('有环境提示条', /env-tip/.test(pageSrc2), 'no tip');
check('提示条 30s 倒计时', /TIP_DURATION = 30000/.test(pageSrc2), 'no duration');
check('提示条有绿色进度条', /env-tip-bar/.test(pageSrc2), 'no bar');
check('提示条可手动关闭', /closeTip/.test(pageSrc2), 'no close');
check('缺环境时不运行', /if \(missingEnv\.length\) \{/.test(pageSrc2), 'runs anyway');

/* ---------- 16. 卸载页：不删环境说明 ---------- */
const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
check('卸载页说明不删环境', /不会删除：已安装的 JDK/.test(nsh), 'no note');

const failed = results.filter((r) => !r.ok);
console.log('===== 代码调试测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
