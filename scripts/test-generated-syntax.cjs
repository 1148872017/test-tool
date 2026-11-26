'use strict';
/**
 * 生成产物的「可编译性」回归套件（v0.65）。
 *
 * ============================================================
 * 为什么要有这一套
 * ============================================================
 * v0.60 我给积木加了「保存到文件」，README 写着「带 import 的完整文本，落盘即可编译」。
 * 实际交出去的是：
 *     com.microsoft.playwright.Page        ← 裸全限定名，没有 import 关键字
 *     @Test                                ← 孤立方法，没有 class 包裹
 * 用户把它粘进 IDEA，compile 直接红。**这是「声称能编译但根本不能」的谎**，
 * 而此前所有套件都在比字符串有没有某段文本 —— 没人真的编译过。
 *
 * 所以这一套不比对文本，直接调用真实编译器：
 *   Java   → javac（只把「语法类」错误当失败；缺 playwright/restassured/lombok
 *           这类**用户项目依赖**不算产物问题）
 *   Python → python -m py_compile（纯语法，不需要依赖）
 *
 * 覆盖：7 个 codegen 目标 + UI 积木 + 接口积木（两门语言、两种产物形态）。
 *
 * 找不到 javac / python 时**显式跳过并说明**（不静默通过）——
 * 这台机器上它们存在，但换台机器不该因此变红或变绿。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const codegen = require(path.join(ROOT, 'shared', 'codegen.js'));
const uiGen = require(path.join(ROOT, 'shared', 'uiStepGen.js'));
const apiGen = require(path.join(ROOT, 'shared', 'apiFlowGen.js'));

/* ---------------- 找编译器 ---------------- */

function findJavaHome() {
  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'javac.exe') : '',
    'D:\\Java\\jdk-17\\bin\\javac.exe'
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return '';
}

function findPython() {
  const candidates = ['D:\\python\\python.exe', process.platform === 'win32' ? 'python.exe' : 'python'];
  for (const c of candidates) {
    if (c.indexOf(path.sep) >= 0) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (!r.error && r.status === 0) return c;
  }
  return '';
}

const JAVAC = findJavaHome();
const PYTHON = findPython();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-gensyntax-'));

/* ---------------- Java 语法检查 ---------------- */

/** 去掉注释和字符串，避免注释里的 { } 干扰括号配对 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '"') { mode = 'str'; i += 1; continue; }
      if (c === "'") { mode = 'chr'; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i += 1; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; } else i += 1; continue; }
    if (mode === 'str') { if (c === '\\') { i += 2; continue; } if (c === '"') mode = 'code'; i += 1; continue; }
    if (mode === 'chr') { if (c === '\\') { i += 2; continue; } if (c === "'") mode = 'code'; i += 1; continue; }
  }
  return out;
}

/**
 * Java 产物的「文件级」结构检查 —— 这三条是这次踩坑的核心，必须独立断言，
 * 因为缺依赖时 javac 会先报 import 错误，掩盖掉「其实连 class 都没有」。
 */
function javaFileShape(src) {
  const clean = stripCommentsAndStrings(src);
  return {
    hasTypeDecl: /(^|\n)\s*(public\s+)?(abstract\s+)?(final\s+)?(class|interface|enum)\s+[\w$]/.test(clean),
    // 裸全限定名清单：首行像 a.b.C 且全文没有 import 关键字
    bareImportList:
      /(^|\n)\s*[a-z][\w$]*(\.[\w$]+)+\s*$/m.test(clean) && !/(^|\n)\s*import\s/.test(clean),
    // 裸的 static xxx（少了 import 关键字）
    rawStaticImport: /(^|\n)\s*static\s+[a-z][\w$]*\./.test(clean),
    bracesBalanced: (clean.match(/\{/g) || []).length === (clean.match(/\}/g) || []).length,
    hasPackageFirst: /^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\n|\s*\n)*(\s*package\s+[\w.]+\s*;)/.test(src)
  };
}

function javacSyntax(src) {
  if (!JAVAC) return { skipped: true };
  const dir = fs.mkdtempSync(path.join(tmp, 'j-'));
  // javac 要求 public class 的文件名 = 类名
  const clsM = /(?:^|\n)\s*public\s+(?:abstract\s+|final\s+)?(?:class|interface|enum)\s+([\w$]+)/.exec(src);
  const name = (clsM ? clsM[1] : 'Snippet') + '.java';
  const file = path.join(dir, name);
  fs.writeFileSync(file, src, 'utf8');
  const r = spawnSync(
    JAVAC,
    ['-J-Duser.language=en', '-J-Duser.country=US', '-encoding', 'UTF-8', '-proc:none', '-d', path.join(dir, 'out'), file],
    { encoding: 'utf8', timeout: 60000, windowsHide: true }
  );
  const out = String(r.stderr || '') + String(r.stdout || '');
  if (r.status === 0) return { ok: true };
  // 只把「语法类」算失败；缺依赖算通过（那是用户项目自己的 jar）
  const syntax =
    /(';'|'\)'|'\}'|'\]')\s*expected|illegal start|reached end of file|not a statement|class, interface, or enum expected|invalid method declaration|unclosed string/;
  const dep = /package [\w.]+ does not exist|cannot find symbol|cannot access/;
  if (syntax.test(out)) return { ok: false, out: out.slice(0, 500) };
  if (dep.test(out)) return { ok: true, depMissing: true };
  return { ok: false, out: out.slice(0, 500) };
}

function pySyntax(src) {
  if (!PYTHON) return { skipped: true };
  const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
  const file = path.join(dir, 'x.py');
  fs.writeFileSync(file, src, 'utf8');
  const r = spawnSync(PYTHON, ['-m', 'py_compile', file], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status === 0) return { ok: true };
  return { ok: false, out: (String(r.stderr || '') + String(r.stdout || '')).slice(0, 500) };
}

/** 检查一个「完整文件」产物 */
function checkJavaFile(label, src) {
  if (!String(src || '').trim()) return check(label + '：产物非空', false, '空产物');
  const shape = javaFileShape(src);
  check(label + '：有 class/interface 声明', shape.hasTypeDecl, src.slice(0, 200));
  check(label + '：import 带关键字（不是裸全限定名清单）', !shape.bareImportList && !shape.rawStaticImport, src.slice(0, 200));
  check(label + '：括号配对', shape.bracesBalanced, 'braces');
  const r = javacSyntax(src);
  if (r.skipped) {
    results.push({ name: label + '：javac 语法编译', ok: true, extra: '', skipped: true, note: '本机没有 javac，跳过' });
    return;
  }
  check(label + '：javac 语法通过' + (r.depMissing ? '（缺依赖包，属正常）' : ''), r.ok, r.out || '');
}

/* ---------------- 样本数据 ---------------- */

const API_SAMPLE = {
  name: '创建订单',
  method: 'POST',
  url: '/api/order',
  module: '订单',
  bodyType: 'json',
  body: JSON.stringify({ sku: 'A1', qty: 2 }),
  paramTable: JSON.stringify([{ name: 'traceId', in: 'header', type: 'string', example: 'abc' }])
};
const PAGE_SAMPLE = {
  name: '登录页',
  url: '/login',
  elements: [
    { name: 'usernameInput', mode: 'css', selector: '#username', desc: '用户名' },
    { name: 'submitBtn', mode: 'css', selector: 'button[type=submit]', desc: '提交' }
  ]
};
const JSON_SAMPLE = JSON.stringify({ code: 0, data: { id: 1, name: 'x' } });

/* ============================================================
 * 一、7 个 codegen 目标
 * ============================================================ */

for (const t of codegen.listTargets()) {
  let input = {};
  if (t.kind === 'api') input = { api: API_SAMPLE };
  else if (t.kind === 'page') input = { page: PAGE_SAMPLE };
  else if (t.kind === 'model') input = { json: JSON_SAMPLE };
  else if (t.kind === 'base') input = {};

  const r = codegen.generate(t.key, input);
  check('codegen/' + t.key + '：能生成', r.ok, r.message);
  if (!r.ok) continue;

  if (t.lang === 'java') checkJavaFile('codegen/' + t.key, r.code);
  else {
    const py = pySyntax(r.code);
    if (py.skipped) results.push({ name: 'codegen/' + t.key + '：py_compile', ok: true, extra: '', skipped: true, note: '本机没有 python，跳过' });
    else check('codegen/' + t.key + '：py_compile 通过', py.ok, py.out || '');
  }
}

/* 多接口路径 */
{
  const r = codegen.generate('java-restassured', {
    apis: [API_SAMPLE, { name: '查订单', method: 'GET', url: '/api/order/1', module: '订单' }]
  });
  check('codegen/java-restassured(多接口)：能生成', r.ok, r.message);
  if (r.ok) checkJavaFile('codegen/java-restassured(多接口)', r.code);
}

/* ============================================================
 * 二、UI 积木（code 片段 + fileCode 完整文件）
 * ============================================================ */

const UI_STEPS = [
  { actionId: 'goto', params: { url: 'https://how2j.cn/frontroute' } },
  { actionId: 'click', params: { el: 'start_1' }, elementMode: 'role', elementSelector: 'button:点击选择学习路线' },
  { actionId: 'fill', params: { el: 'usernameInput', text: 'admin' }, elementMode: 'css', elementSelector: '#username' },
  { actionId: 'assert-visible', params: { el: 'start_1' }, elementMode: 'role', elementSelector: 'button:点击选择学习路线' },
  { actionId: 'wait-timeout', params: { ms: 3000 } },
  { actionId: 'refresh-interval', params: { count: 2, ms: 500 } }
];
const UI_ELEMENTS = [
  { name: 'start_1', mode: 'role', selector: 'button:点击选择学习路线' },
  { name: 'usernameInput', mode: 'css', selector: '#username' }
];

for (const lang of ['java', 'python']) {
  const r = uiGen.generateSteps({
    steps: UI_STEPS,
    lang,
    pomMode: 'none',
    pageName: 'how2j',
    elements: UI_ELEMENTS,
    packageName: lang === 'java' ? 'com.test.test' : ''
  });

  check('ui-brick/' + lang + '：有 fileCode（复制/保存要交完整文件）', typeof r.fileCode === 'string' && r.fileCode.length > 0, 'no fileCode');
  check('ui-brick/' + lang + '：fileCode 带类名 ' + r.testClassName, r.fileCode.indexOf(r.testClassName) >= 0, r.testClassName);

  if (lang === 'java') {
    checkJavaFile('ui-brick/java', r.fileCode);
    check('ui-brick/java：写了 package（传了包名时）', /^package com\.test\.test;/.test(r.fileCode), r.fileCode.slice(0, 80));
    check('ui-brick/java：类名是 *Test 结尾（TestNG 惯例）', /Test$/.test(r.testClassName), r.testClassName);
  } else {
    const py = pySyntax(r.fileCode);
    if (py.skipped) results.push({ name: 'ui-brick/python：py_compile', ok: true, extra: '', skipped: true });
    else check('ui-brick/python：py_compile 通过', py.ok, py.out || '');
    // pytest 默认只收集 Test* 开头的类 —— 叫 How2jTest 的话一个用例都不会跑
    check('ui-brick/python：类名以 Test 开头（否则 pytest 不收集）', /^Test[A-Za-z]/.test(r.testClassName), r.testClassName);
    check('ui-brick/python：不写 package（Python 没这个概念）', !/^package /m.test(r.fileCode), 'has package');
  }
}

/* ============================================================
 * 三、接口积木
 * ============================================================ */

const API_STEPS = [
  { actionId: 'call', params: { name: 'loginResp', method: 'POST', path: '/api/login' } },
  { actionId: 'extract-json', params: { from: 'loginResp', path: '$.data.token', as: 'token' } },
  { actionId: 'assert-status', params: { from: 'loginResp', code: 200 } }
];

for (const lang of ['java', 'python']) {
  const r = apiGen.generateApiFlow({
    steps: API_STEPS,
    lang,
    baseUrl: 'https://api.test',
    testName: 'testOrderFlow',
    packageName: lang === 'java' ? 'com.test.api' : ''
  });

  check('api-brick/' + lang + '：有 fileCode', typeof r.fileCode === 'string' && r.fileCode.length > 0, 'no fileCode');

  if (lang === 'java') {
    checkJavaFile('api-brick/java', r.fileCode);
    check('api-brick/java：class 名由方法名推出（OrderFlowTest）', r.testClassName === 'OrderFlowTest', r.testClassName);
  } else {
    const py = pySyntax(r.fileCode);
    if (py.skipped) results.push({ name: 'api-brick/python：py_compile', ok: true, extra: '', skipped: true });
    else check('api-brick/python：py_compile 通过', py.ok, py.out || '');
    // Python 接口积木是模块级函数（无 self），包 class 会变成错方法
    check('api-brick/python：不包 class（模块级函数，无 self）', !/^class /m.test(r.fileCode), r.fileCode.slice(0, 120));
  }
}

/* ============================================================
 * 四、产物格式细节（这几条最容易被「改一处忘一处」弄坏）
 * ============================================================ */

{
  const one = uiGen.generateSteps({
    steps: [{ actionId: 'goto', params: { url: 'https://x.cn' } }],
    lang: 'java',
    pomMode: 'none',
    pageName: 'demo',
    packageName: 'com.a.b'
  });
  const lines = one.fileCode.split('\n');
  check('格式：package 在第一行', lines[0] === 'package com.a.b;', lines[0]);
  check('格式：package 后有空行', lines[1] === '', JSON.stringify(lines.slice(0, 3)));
  // import 块的位置随「有没有 package / 有几条 import」变化，所以动态找最后一条 import
  const lastImport = lines.reduce((acc, l, i) => (l.indexOf('import ') === 0 ? i : acc), -1);
  check('格式：import 存在', lastImport > 0, JSON.stringify(lines.slice(0, 6)));
  check('格式：import 之后、class 之前有空行', lines[lastImport + 1] === '', JSON.stringify(lines.slice(0, 6)));
  check(
    '格式：class 紧跟空行之后',
    lines[lastImport + 2].indexOf('public class ') === 0,
    JSON.stringify(lines.slice(0, 6))
  );
  check('格式：方法体缩进 4 空格', /\n {4}@Test/.test(one.fileCode), one.fileCode.slice(0, 200));
  check('格式：类闭合', /\n}\n$/.test(one.fileCode), JSON.stringify(one.fileCode.slice(-20)));
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  /* ignore */
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('');
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  const mark = r.ok ? (r.skipped ? '  SKIP' : '  PASS') : '  FAIL';
  console.log(mark + '  ' + r.name + (r.extra ? '  -> ' + r.extra : ''));
}
const skipped = results.filter((r) => r.skipped).length;
console.log('');
console.log(
  results.length - failed.length + '/' + results.length +
    ' passed' + (skipped ? '（其中 ' + skipped + ' 项因本机缺 javac/python 跳过）' : '') +
    (failed.length ? '，' + failed.length + ' 项失败' : '')
);
if (!JAVAC) console.log('注意：没找到 javac，Java 产物的语法编译检查被跳过（结构检查仍然执行）');
if (!PYTHON) console.log('注意：没找到 python，Python 产物的 py_compile 检查被跳过');
process.exit(failed.length ? 1 : 0);
