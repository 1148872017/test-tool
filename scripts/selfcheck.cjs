/**
 * 提交前自检：把「踩过的坑」变成可执行检查。
 *
 * 名字说明：叫 selfcheck 而不是 preflight —— 因为 scripts/lib/preflight.cjs 已经存在
 * （那个是「env 档的环境变量前置检查」），两个 preflight 会让人分不清（坑 #103 通道撞名的同类问题）。
 *
 * 为什么需要这个：
 *   144 条踩坑笔记里，「怎么防」大多是「要注意 xxx」的文字提醒，
 *   下一轮对话就忘（坑 #18 自己都这么写）。这个脚本把能自动化的那部分做成硬检查。
 *
 * 用法：
 *   node scripts/selfcheck.cjs              # 全部检查
 *   node scripts/selfcheck.cjs --fix-hint   # 错误时给修复提示
 *   node scripts/selfcheck.cjs --json       # 机器可读
 *
 * 检查项（每条对应一个踩过的坑）：
 *   1. 类型与未定义标识符 → #115 调了从未定义也没导入的函数（esbuild 不查，运行时才炸）
 *   2. 前端越界           → #121 shared/ 带 Node 依赖，前端一 import 就构建失败
 *   3. 脚本语法           → #8  临时脚本写坏（含中文/引号的 node -e 教训）
 *   4. 硬编码本机路径     → #14 测试写死绝对路径，换机器就红
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function add(level, check, file, line, message, hint) {
  results.push({ level, check, file, line, message, hint });
}

/* ============================================================
 * 1. 类型检查（用真正的 tsc，不用自制扫描器）
 *
 * 为什么不用正则扫「未定义调用」：
 *   试过，误报率 90%+（async ( / 类方法 / props 解构 全被当调用）。
 *   假警报比没有检查更糟 —— 人会学会忽略它。
 *
 * 只报「关键错误码」，其余（类型推断/环境缺失）忽略：
 *   因为项目本来就不做类型检查（esbuild 转译），
 *   我们只要它能抓住「代码根本跑不起来」的那类问题。
 * ============================================================ */
const CRITICAL_CODES = {
  1003: '语法错误',
  1005: '语法错误（缺分号/括号）',
  1109: '表达式预期',
  1160: '未闭合的模板字符串',
  2300: '重复声明同一个标识符',
  2304: '找不到这个名字（没导入/拼错）',
  2440: '重复的 import',
  2451: '重复定义',
  2552: '调用时缺参数',
  2554: '参数个数不对',
  2555: '参数个数不对',
  2732: '找不到模块'
};

function checkTypes() {
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tscBin)) {
    add('warn', '类型检查', 'tsconfig.preflight.json', 0, '没装 typescript，跳过类型检查',
      'npm install -D typescript');
    return;
  }

  let out = '';
  try {
    out = execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.preflight.json', '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }

  const lines = out.split('\n');
  for (const l of lines) {
    const m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/.exec(l.trim());
    if (!m) continue;
    const code = parseInt(m[4].replace('TS', ''), 10);
    if (!CRITICAL_CODES[code]) continue;
    add('error', '类型检查', m[1], +m[2], '[' + m[4] + ' ' + CRITICAL_CODES[code] + '] ' + m[5],
      '这类错误意味着代码跑不起来。对应坑 #115（esbuild 不查未定义标识符）');
  }
}

/* ============================================================
 * 2. 前端越界（#121）
 *
 * src/ 里 import 的 shared/ 模块，不能 require Node 内置或 Node-only 包。
 * 这条 tsc 查不出来（它是运行时/打包时的约束）。
 * ============================================================ */
const NODE_ONLY = ['fs', 'path', 'os', 'child_process', 'crypto', 'http', 'https', 'net', 'ejs', 'electron'];

function findFrontendImports() {
  const files = [];
  function walk(dir) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) {
        if (/node_modules|dist/.test(e.name)) continue;
        walk(rel);
      } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        files.push(rel);
      }
    }
  }
  walk('src');

  const graph = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /from\s+['"]([^'"]*shared[^'"]*)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const hit = /shared\/([\w.-]+)/.exec(m[1]);
      if (!hit) continue;
      const key = 'shared/' + hit[1];
      if (!graph.has(key)) graph.set(key, new Set());
      graph.get(key).add(f);
    }
  }

  for (const [mod, users] of graph) {
    const p = path.join(ROOT, mod);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    const bad = new Set();
    while ((m = reqRe.exec(src))) {
      const dep = m[1].replace(/^node:/, '');
      if (NODE_ONLY.includes(dep)) bad.add(dep);
    }
    for (const dep of bad) {
      add('error', '前端越界', mod, 0,
        '含 Node 依赖「' + dep + '」，但被前端 import：' + [...users].slice(0, 3).join(', '),
        '拆成零依赖模块，或只让主进程 require。对应坑 #121');
    }
  }
}

/* ============================================================
 * 3. 脚本语法（#8）
 * ============================================================ */
function checkScriptSyntax() {
  const files = [];
  const scriptsDir = path.join(ROOT, 'scripts');
  for (const f of fs.readdirSync(scriptsDir)) {
    if (/\.(cjs|mjs)$/.test(f)) files.push(path.join(scriptsDir, f));
  }

  // 最近 1 天的 _scratch 脚本（临时脚本最容易写坏）
  // 为什么只扫 1 天：翻旧账没意义（两天前的坏脚本早就是废弃产物），
  // 而且一上来报一堆历史错误会让人直接忽略这个工具 —— 假警报比没有检查更糟。
  // 注意层级：ROOT 是 Project/test-tool，_scratch 在工作区根（再上两级）
  const scratch = path.resolve(ROOT, '..', '..', '_scratch');
  if (fs.existsSync(scratch)) {
    const cutoff = Date.now() - 1 * 864e5;
    for (const d of fs.readdirSync(scratch)) {
      const abs = path.join(scratch, d);
      if (!fs.statSync(abs).isDirectory()) continue;
      for (const f of fs.readdirSync(abs)) {
        if (!/\.(cjs|mjs)$/.test(f)) continue;
        const fp = path.join(abs, f);
        if (fs.statSync(fp).mtimeMs < cutoff) continue;
        files.push(fp);
      }
    }
  }

  let bad = 0;
  for (const abs of files) {
    try {
      execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    } catch (e) {
      const msg = String(e.stderr || e.message)
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 3)
        .join(' ');
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      add('error', '脚本语法', rel, 0, msg.slice(0, 180),
        '这是「写完没跑一遍」的典型。对应坑 #8：临时脚本一律写成 .cjs 文件，别用 node -e');
      bad++;
    }
  }
  return { checked: files.length, bad };
}

/* ============================================================
 * 4. 硬编码本机路径（#14）
 *
 * 只报「这个路径在你机器上真的存在」的情况。
 * 为什么要这样：测试里故意用了大量假路径（D:/nonexistent-xyz、D:\不存在的目录、
 * C:\Windows\System32\cmd.exe 用于注入测试），全报的话 51 条警告里 48 条是误报。
 * 假警报比没有检查更糟 —— 人会学会忽略它。
 * ============================================================ */
function checkHardcodedPaths() {
  const abs = path.join(ROOT, 'scripts');
  for (const f of fs.readdirSync(abs)) {
    if (!/^test-.*\.cjs$/.test(f)) continue;
    const src = fs.readFileSync(path.join(abs, f), 'utf8');
    src.split('\n').forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
      const m = /['"`]([A-Za-z]:[\\/][^'"`\n]{3,})['"`]/.exec(l);
      if (!m) return;
      const p = m[1];
      // 只报「用户自己的工作区/个人目录」——系统路径和工具路径是测试夹具，故意的
      const isUserPath = /^[A-Za-z]:[\\/](AI_Workspace|Users[\\/](?!Public|Default))/.test(p);
      if (!isUserPath) return;
      let exists = false;
      try {
        exists = fs.existsSync(p);
      } catch (e) {
        exists = false;
      }
      if (!exists) return;
      add('warn', '硬编码路径', 'scripts/' + f, i + 1, '写死了本机真实路径：' + p.slice(0, 70),
        '改成环境变量或 path.resolve(__dirname, "..")。对应坑 #14');
    });
  }
}

/* ============================================================
 * 主流程
 * ============================================================ */
function main() {
  const json = process.argv.includes('--json');
  const showHint = process.argv.includes('--fix-hint');
  // --no-types 跳过 tsc（约 15 秒）。只给「自测其他检查项」用，正常提交别加。
  const skipTypes = process.argv.includes('--no-types');

  if (!skipTypes) checkTypes();
  findFrontendImports();
  const syn = checkScriptSyntax();
  checkHardcodedPaths();

  const errs = results.filter((r) => r.level === 'error');
  const warns = results.filter((r) => r.level === 'warn');

  if (json) {
    console.log(JSON.stringify({ errors: errs, warnings: warns }, null, 2));
  } else {
    console.log('=== 提交前自检 ===');
    console.log('  脚本 ' + syn.checked + ' 个 / 检查项 4 类');
    console.log('');

    if (!results.length) {
      console.log('  ✓ 全部通过');
    } else {
      for (const r of results) {
        console.log('  ' + (r.level === 'error' ? '✗' : '⚠') + ' [' + r.check + '] ' + r.file + (r.line ? ':' + r.line : ''));
        console.log('     ' + r.message);
        if (showHint && r.hint) console.log('     → ' + r.hint);
      }
    }

    console.log('');
    console.log('  错误 ' + errs.length + ' / 警告 ' + warns.length);
    if (!results.length) {
      console.log('');
      console.log('  说明：类型检查只报「代码跑不起来」的那类（未定义名字/重复声明/参数个数），');
      console.log('        类型推断和环境缺失的报错被忽略——项目本来就不做严格类型检查。');
    }
  }

  if (errs.length) process.exit(1);
}

main();