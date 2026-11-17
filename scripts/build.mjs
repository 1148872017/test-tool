import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'dist');
mkdirSync(outdir, { recursive: true });

const started = Date.now();

const exe = path.join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
if (!existsSync(exe)) {
  console.error('[build] 找不到 esbuild.exe，请先 npm install');
  process.exit(1);
}

const args = [
  path.join(root, 'src', 'index.tsx'),
  '--bundle',
  `--outfile=${path.join(outdir, 'app.js')}`,
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

copyFileSync(path.join(root, 'src', 'index.html'), path.join(outdir, 'index.html'));
copyFileSync(path.join(root, 'src', 'styles.css'), path.join(outdir, 'styles.css'));

console.log(`[build] renderer ok in ${Date.now() - started}ms -> dist/`);