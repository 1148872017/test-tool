import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const started = Date.now();

/**
 * 双入口构建。
 *
 *   默认        src/index.tsx          → dist/app.js                 正式包（零 mock 代码）
 *   --preview   src/index.preview.tsx  → dist/preview/preview.js     浏览器预览（内存假数据）
 *
 * 为什么必须是双入口，而不是给 esbuild 加个 --define 开关：
 *   esbuild 对「带顶层副作用的模块」不做摇树。只要 `import './mockApi'` 这条边还在，
 *   mockApi 整块就会被打进 dist/app.js —— 实测 3.62MB 的包里带着种子账号密码
 *   Admin@123 和 installMockIfNeeded。只有从入口层面把这条边断开，
 *   才能做到构建期确定性隔离，而不是靠运行时判断。
 */
const previewMode = process.argv.includes('--preview');

const outdir = path.join(root, 'dist');
const previewDir = path.join(outdir, 'preview');
const entry = path.join(root, 'src', previewMode ? 'index.preview.tsx' : 'index.tsx');
const outfile = previewMode ? path.join(previewDir, 'preview.js') : path.join(outdir, 'app.js');

if (!existsSync(entry)) {
  console.error('[build] 找不到入口：' + entry);
  process.exit(1);
}
mkdirSync(path.dirname(outfile), { recursive: true });

const exe = path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
if (!existsSync(exe)) {
  console.error('[build] 找不到 esbuild.exe，请先 npm install');
  process.exit(1);
}

const args = [
  entry,
  '--bundle',
  `--outfile=${outfile}`,
  '--platform=browser',
  '--target=chrome120',
  '--format=iife',
  '--jsx=automatic',
  '--charset=utf8',
  '--loader:.ts=ts',
  '--loader:.tsx=tsx',
  '--define:process.env.NODE_ENV="production"',
  '--log-level=warning'
];

const result = spawnSync(exe, args, { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('[build] esbuild 失败，exit=' + result.status);
  process.exit(result.status || 1);
}

const htmlSrc = path.join(root, 'src', 'index.html');
const cssSrc = path.join(root, 'src', 'styles.css');

if (previewMode) {
  // 预览页从正式 index.html 派生，只换脚本，保证骨架屏 / DOM 结构两边一致
  const html = readFileSync(htmlSrc, 'utf8');
  const previewHtml = html.replace(/src="\.\/app\.js"/, 'src="./preview.js"');
  if (previewHtml === html) {
    console.error('[build] index.html 里没找到 src="./app.js"，预览页脚本没替换成功');
    process.exit(1);
  }
  writeFileSync(path.join(previewDir, 'preview.html'), previewHtml, 'utf8');
  // 预览页是独立目录，样式表也是相对路径，得跟着放一份
  copyFileSync(cssSrc, path.join(previewDir, 'styles.css'));
  console.log(`[build] preview ok in ${Date.now() - started}ms -> dist/preview/ (${formatSize(outfile)})`);
} else {
  copyFileSync(htmlSrc, path.join(outdir, 'index.html'));
  copyFileSync(cssSrc, path.join(outdir, 'styles.css'));
  console.log(`[build] renderer ok in ${Date.now() - started}ms -> dist/ (${formatSize(outfile)})`);
}

/** 体积打印：MB 保留两位，便于和改动前对比 */
function formatSize(file) {
  const bytes = statSync(file).size;
  return (bytes / 1048576).toFixed(2) + ' MB / ' + bytes + ' 字节';
}
