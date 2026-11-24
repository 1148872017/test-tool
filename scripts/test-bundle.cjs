/*
 * 生产包「不含 mock」护栏测试。
 *
 * 背景（P0）：
 *   src/api.ts 曾经在模块加载时无条件调 installMockIfNeeded()，
 *   没有 window.api 就打印一行 console 然后切成内存库。
 *   后果是 preload 一旦失效（asar 漏文件 / 沙箱策略变化），
 *   生产环境不报错、静默降级为假数据 —— 用户把真实账号密码录进去，重启全没。
 *
 * 这道护栏盯三件事：
 *   1. 正式包 dist/app.js 里一个 mock 符号都不许有；
 *   2. 预览包 dist/preview/preview.js 里 mock 必须还在（别把预览弄坏）；
 *   3. package.json 的 build.files 必须排除 dist/preview/**（否则预览包被打进安装包，等于白干）。
 *
 * 产物不存在时先自动构建一次：这样 `npm test` 在干净工作区也能跑，
 * 而不会因为「文件不在，跳过检查」变成一条永远绿的假护栏。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 0. 准备产物
 * ============================================================ */
const appPath = path.join(ROOT, 'dist', 'app.js');
const previewJsPath = path.join(ROOT, 'dist', 'preview', 'preview.js');
const previewHtmlPath = path.join(ROOT, 'dist', 'preview', 'preview.html');

/** 产物缺失时构建一次（打印出来，不做隐形动作） */
function ensureArtifact(file, args) {
  if (fs.existsSync(file)) return true;
  console.log('[准备] 产物不存在，先构建一次：' + path.relative(ROOT, file));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), ...args], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  return r.status === 0 && fs.existsSync(file);
}

const appOk = ensureArtifact(appPath, []);
check('dist/app.js 存在（正式产物）', appOk, 'build 失败或产物缺失');
const previewOk = ensureArtifact(previewJsPath, ['--preview']);
check('dist/preview/preview.js 存在（预览产物）', previewOk, 'build --preview 失败或产物缺失');

if (!appOk || !previewOk) {
  // 产物都拿不到，后面的内容断言没有意义，直接报失败
  report();
  process.exit(1);
}

const appSrc = fs.readFileSync(appPath, 'utf8');
const previewSrc = fs.readFileSync(previewJsPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const buildSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'api.ts'), 'utf8');

/* ============================================================
 * 1. 正式包：一个 mock 符号都不许有
 * ============================================================ */
/** 命中即视为泄漏的哨兵（都是 mockApi 独有的字符串） */
const LEAK_NEEDLES = [
  'installMockIfNeeded',
  'Admin@123',
  '[mock]',
  '未检测到 Electron API，使用内存数据预览'
];

const leaks = LEAK_NEEDLES.filter((n) => appSrc.includes(n));
check('正式包不含 installMockIfNeeded', !appSrc.includes('installMockIfNeeded'), 'mock 入口被打进生产包');
check('正式包不含种子密码 Admin@123', !appSrc.includes('Admin@123'), 'mock 种子账号泄漏');
check('正式包不含 mock 日志前缀 [mock]', !appSrc.includes('[mock]'), 'mock 代码被打进生产包');
check('正式包不含 mock 提示语', !appSrc.includes('未检测到 Electron API，使用内存数据预览'), 'mock 代码被打进生产包');
check('正式包 mock 哨兵命中数 = 0', leaks.length === 0, leaks);

/* 根因守卫：api.ts 不能再 import mockApi（这条边一存在，摇树就废了） */
check(
  'src/api.ts 不 import mockApi',
  !/from\s+['"]\.\/mockApi['"]/.test(apiSrc) && !/installMockIfNeeded\s*\(/.test(apiSrc),
  '入口副作用还在，mock 会重新进包'
);
check('src/api.ts 从 platform/api 透传', /from\s+['"]\.\/platform\/api['"]/.test(apiSrc), 'api 入口没切到 platform/api');

/* 正式页不能被预览页覆盖 */
const indexHtml = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8');
check('dist/index.html 仍指向 ./app.js', /src="\.\/app\.js"/.test(indexHtml), '正式页脚本引用不对');
check('dist/index.html 不指向 preview.js', !/preview\.js/.test(indexHtml), '正式页被预览产物污染');

/* ============================================================
 * 2. 预览包：mock 必须还在（别把预览弄坏）
 * ============================================================ */
check('预览包含 installMockIfNeeded', previewSrc.includes('installMockIfNeeded'), '预览入口没装 mock');
check('预览包含种子数据（Admin@123）', previewSrc.includes('Admin@123'), '预览数据缺失');
check('预览包和正式包确实不同', previewSrc !== appSrc, '两个产物内容相同');

const previewHtml = fs.readFileSync(previewHtmlPath, 'utf8');
check('preview.html 指向 ./preview.js', /src="\.\/preview\.js"/.test(previewHtml), '预览页脚本引用不对');
check('preview.html 不引用 ./app.js', !/src="\.\/app\.js"/.test(previewHtml), '预览页还在加载正式脚本');

/* ============================================================
 * 3. 打包配置：预览产物不能进安装包
 * ============================================================ */
const files = (pkg.build && pkg.build.files) || [];
check('build.files 含 "!dist/preview/**"', files.includes('!dist/preview/**'), files.join(', '));

/*
 * electron-builder 的 files 按顺序匹配，排除必须排在包含之后；
 * 顺序反了 "!dist/preview/**" 会被后面的 "dist/**\/*" 再包含回来。
 */
const includeIdx = files.indexOf('dist/**/*');
const excludeIdx = files.indexOf('!dist/preview/**');
check('排除规则排在 dist/**/* 之后', excludeIdx > includeIdx && includeIdx >= 0, { includeIdx, excludeIdx });

/* 双入口构建脚本本身要还在 */
check('build.mjs 有 preview 入口', /index\.preview\.tsx/.test(buildSrc), 'preview 入口丢失');
check('build.mjs 产出 preview.js', /preview\.js/.test(buildSrc), 'preview 产物名丢失');

/* ============================================================
 * 4. 反向验证：护栏本身能抓住泄漏样本
 * ============================================================ */
{
  const bad = "function installMockIfNeeded(){console.log('[mock] 未检测到 Electron API，使用内存数据预览')}var p='Admin@123';";
  const hitBad = LEAK_NEEDLES.filter((n) => bad.includes(n));
  check('能抓住泄漏的坏样本', hitBad.length === LEAK_NEEDLES.length, hitBad);

  const good = 'function mount(){createRoot(document.getElementById("root"))}';
  const hitGood = LEAK_NEEDLES.filter((n) => good.includes(n));
  check('正常包不误报', hitGood.length === 0, hitGood);
}

report();
process.exit(results.filter((r) => !r.ok).length ? 1 : 0);

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log('===== 生产包 mock 隔离护栏 =====');
  console.log('app.js 体积:', fs.existsSync(appPath) ? fs.statSync(appPath).size + ' 字节' : '(缺失)');
  console.log('preview.js 体积:', fs.existsSync(previewJsPath) ? fs.statSync(previewJsPath).size + ' 字节' : '(缺失)');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
}
