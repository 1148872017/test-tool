/**
 * 测 `scripts/selfcheck.cjs`（提交前自检工具）本身。
 *
 * 重点不是「脚本能跑」，而是「它真的能抓到问题」——
 * 否则又是一个「看起来能用」的东西（坑 #89 说的就是这类）。
 *
 * 性能说明：tsc 单次约 15 秒，所以**所有类型探针合并成一次 tsc 调用**
 * （把 3 个坏文件同时写进去，一次抓 3 类错），否则这个自测光 tsc 就要 60 秒。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  → ' + String(detail).slice(0, 200) : ''));
  }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('=== preflight 工具自测 ===');

/* ---------- 1. 结构（不跑 tsc，纯静态）---------- */
const src = read('scripts/selfcheck.cjs');

check('preflight.cjs 存在且可读', src.length > 3000, src.length + ' 字符');
check(
  '有 4 类检查',
  ['checkTypes', 'findFrontendImports', 'checkScriptSyntax', 'checkHardcodedPaths'].every((f) =>
    src.includes('function ' + f)
  )
);
check(
  '关键错误码表含「找不到名字」和「重复声明」',
  /2304:\s*'找不到这个名字/.test(src) && /2300:\s*'重复声明/.test(src)
);
check(
  '前端越界检查的 Node 依赖清单含 fs/path/ejs',
  /NODE_ONLY\s*=\s*\[[^\]]*'fs'/.test(src) && /'path'/.test(src) && /'ejs'/.test(src)
);
check('硬编码检查只报「用户自己的工作区路径」', /isUserPath/.test(src) && /AI_Workspace/.test(src));
check('注释里写明了「假警报比没有检查更糟」', /假警报比没有检查更糟/.test(src));
check('扫 _scratch 用的是上两级（不是 Project/_scratch）', /path\.resolve\(ROOT, '\.\.', '\.\.', '_scratch'\)/.test(src));

/* ---------- 2. 当前仓库跑一遍，应该全绿 ---------- */
let cleanOut = '';
let cleanCode = 0;
try {
  cleanOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts/selfcheck.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe'
  });
} catch (e) {
  cleanOut = String(e.stdout || '') + String(e.stderr || '');
  cleanCode = e.status || 1;
}
check('当前仓库跑 preflight 无错误（退出码 0）', cleanCode === 0, 'exit=' + cleanCode);
check('输出里有「全部通过」', /全部通过/.test(cleanOut), cleanOut.slice(-160));

/* ---------- 3. 关键：故意造问题，一次 tsc 验证 3 类错 ---------- */
const probes = [
  path.join(ROOT, 'src', '__pf_probe_undef__.tsx'),
  path.join(ROOT, 'src', '__pf_probe_dup__.tsx')
];
let tscOut = '';
try {
  // 3.1 未定义标识符（坑 #115）
  fs.writeFileSync(
    probes[0],
    `export function Probe() {\n  return someFunctionThatDoesNotExist(1);\n}\n`,
    'utf8'
  );
  // 3.2 重复 import（v0.49 真踩到：ReloadOutlined 从 antd 和 icons 各导一次）
  fs.writeFileSync(
    probes[1],
    `import { Foo } from 'antd';\nimport { Foo } from '@ant-design/icons';\nexport const X = Foo;\n`,
    'utf8'
  );

  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.preflight.json', '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    tscOut = '(没有报错)';
  } catch (e) {
    tscOut = String(e.stdout || '') + String(e.stderr || '');
  }
} finally {
  for (const p of probes) if (fs.existsSync(p)) fs.unlinkSync(p);
}

check(
  '故意写未定义函数调用 → tsc 抓到（TS2304，对应坑 #115）',
  /TS2304/.test(tscOut) && /someFunctionThatDoesNotExist/.test(tscOut),
  tscOut.split('\n').filter((l) => /TS2304/.test(l))[0]
);
check(
  '故意写重复 import → tsc 抓到（TS2300/TS2440，v0.49 真踩到）',
  /TS2300/.test(tscOut) || /TS2440/.test(tscOut),
  tscOut.split('\n').filter((l) => /TS2300|TS2440/.test(l))[0]
);

/* ---------- 4. 前端越界（跑一次 preflight，快，不涉及 tsc 重跑）---------- */
const sharedProbe = path.join(ROOT, 'shared', '__pf_probe_mod__.js');
const srcProbe = path.join(ROOT, 'src', '__pf_probe_import__.tsx');
let crossOut = '';
try {
  fs.writeFileSync(sharedProbe, `const ejs = require('ejs');\nmodule.exports = { x: 1 };\n`, 'utf8');
  fs.writeFileSync(
    srcProbe,
    `import { x } from '../../shared/__pf_probe_mod__.js';\nexport const y = x;\n`,
    'utf8'
  );
  try {
    crossOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts/selfcheck.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (e) {
    crossOut = String(e.stdout || '') + String(e.stderr || '');
  }
} finally {
  if (fs.existsSync(sharedProbe)) fs.unlinkSync(sharedProbe);
  if (fs.existsSync(srcProbe)) fs.unlinkSync(srcProbe);
}
check(
  '故意让前端 import 带 ejs 的 shared 模块 → 报「前端越界」（坑 #121）',
  /前端越界/.test(crossOut) && /ejs/.test(crossOut),
  crossOut.split('\n').find((l) => /前端越界/.test(l))
);

/* ---------- 5. 脚本语法（坑 #8）---------- */
const scratchDir = path.resolve(ROOT, '..', '..', '_scratch', '2026-11-25');
const badScript = path.join(scratchDir, '__pf_probe_bad__.cjs');
let synOut = '';
try {
  if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(badScript, `const x = 'unclosed\nconsole.log(x);\n`, 'utf8');
  try {
    synOut = execFileSync(process.execPath, [path.join(ROOT, 'scripts/selfcheck.cjs'), '--no-types'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (e) {
    synOut = String(e.stdout || '') + String(e.stderr || '');
  }
} finally {
  if (fs.existsSync(badScript)) fs.unlinkSync(badScript);
}
check('故意写坏临时脚本 → 报「脚本语法」（坑 #8）', /脚本语法/.test(synOut), synOut.split('\n').find((l) => /脚本语法/.test(l)));

/* ---------- 6. 收尾干净 ---------- */
check('探针文件已清理', probes.every((p) => !fs.existsSync(p)) && !fs.existsSync(sharedProbe) && !fs.existsSync(srcProbe) && !fs.existsSync(badScript));

let afterCode = 0;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/selfcheck.cjs'), '--no-types'], { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  afterCode = e.status || 1;
}
check('探针清理后 preflight 重新全绿', afterCode === 0, 'exit=' + afterCode);

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);