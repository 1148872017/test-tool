'use strict';
/**
 * 代码项目扫描：识别 Maven / Python 项目 + 测试框架。
 *
 * 只读索引，不写回（和 jmx / knowledge 一致）。
 *
 * 识别规则：
 *   - pom.xml 里有 rest-assured → REST Assured
 *   - pom.xml 里有 playwright   → Playwright
 *   - pom.xml 里有 testng       → TestNG
 *   - pom.xml 里有 junit        → JUnit
 *   - pom.xml 里有 allure       → Allure
 *   - requirements.txt / pyproject.toml → Python
 *   - package.json 里有 playwright → Playwright (Node)
 */

const fs = require('fs');
const path = require('path');

/** 跳过这些目录 */
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'dist', '.git', '.idea', 'venv', '__pycache__', '.venv']);

/** 测试框架识别规则（pom.xml 里的 artifactId 关键词） */
const MAVEN_FRAMEWORKS = [
  { key: 'rest-assured', label: 'REST Assured', color: 'blue' },
  { key: 'playwright', label: 'Playwright', color: 'purple' },
  { key: 'testng', label: 'TestNG', color: 'green' },
  { key: 'junit', label: 'JUnit', color: 'cyan' },
  { key: 'allure', label: 'Allure', color: 'orange' },
  { key: 'selenium', label: 'Selenium', color: 'gold' },
  { key: 'jmeter', label: 'JMeter', color: 'magenta' }
];

/** 读文件，失败返回空串 */
function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

/** 判断目录是不是测试项目，返回项目信息或 null */
function inspectProject(dir) {
  const name = path.basename(dir);
  const pom = path.join(dir, 'pom.xml');
  const req = path.join(dir, 'requirements.txt');
  const pyproj = path.join(dir, 'pyproject.toml');
  const pkg = path.join(dir, 'package.json');

  // ---- Maven 项目 ----
  if (fs.existsSync(pom)) {
    const xml = readSafe(pom);
    const frameworks = [];
    for (const f of MAVEN_FRAMEWORKS) {
      if (xml.toLowerCase().includes(f.key)) frameworks.push(f);
    }
    // 没有测试框架的 Maven 项目也收（可能是工具项目）
    return {
      name,
      dir,
      type: 'maven',
      frameworks,
      // 有测试框架才算「测试项目」
      isTest: frameworks.length > 0,
      // 测试类目录
      testDir: fs.existsSync(path.join(dir, 'src', 'test')) ? path.join(dir, 'src', 'test') : ''
    };
  }

  // ---- Python 项目 ----
  if (fs.existsSync(req) || fs.existsSync(pyproj)) {
    const text = readSafe(req) + readSafe(pyproj);
    const frameworks = [];
    if (/pytest/i.test(text)) frameworks.push({ key: 'pytest', label: 'pytest', color: 'green' });
    if (/playwright/i.test(text)) frameworks.push({ key: 'playwright', label: 'Playwright', color: 'purple' });
    if (/requests/i.test(text)) frameworks.push({ key: 'requests', label: 'requests', color: 'blue' });
    if (/allure/i.test(text)) frameworks.push({ key: 'allure', label: 'Allure', color: 'orange' });
    return {
      name,
      dir,
      type: 'python',
      frameworks,
      isTest: frameworks.length > 0,
      testDir: ''
    };
  }

  // ---- Node 项目 ----
  if (fs.existsSync(pkg)) {
    const text = readSafe(pkg);
    const frameworks = [];
    if (/playwright/i.test(text)) frameworks.push({ key: 'playwright', label: 'Playwright', color: 'purple' });
    if (/jest|vitest|mocha/i.test(text)) frameworks.push({ key: 'jest', label: 'Jest/Vitest', color: 'green' });
    return {
      name,
      dir,
      type: 'node',
      frameworks,
      isTest: frameworks.length > 0,
      testDir: ''
    };
  }

  return null;
}

/**
 * 扫描项目根目录。
 * @param {string} root 项目根目录
 * @returns {{ok: boolean, root: string, projects: any[], message?: string}}
 */
function scanProjects(root) {
  const base = String(root || '').trim();
  if (!base) return { ok: false, root: '', projects: [], message: '没配项目目录' };
  if (!fs.existsSync(base)) return { ok: false, root: base, projects: [], message: '目录不存在' };

  const projects = [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (e) {
    return { ok: false, root: base, projects: [], message: '读目录失败：' + (e && e.message) };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;
    const info = inspectProject(path.join(base, ent.name));
    if (info) projects.push(info);
  }

  // 测试项目排前面
  projects.sort((a, b) => {
    if (a.isTest !== b.isTest) return a.isTest ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { ok: true, root: base, projects };
}

/**
 * 列出某个 Maven 项目的测试类（从 src/test 下找 *Test.java / *Tests.java）。
 * @param {string} projectDir
 * @returns {string[]} 类名列表（不含包名）
 */
function listTestClasses(projectDir) {
  const testRoot = path.join(projectDir, 'src', 'test', 'java');
  if (!fs.existsSync(testRoot)) return [];

  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.java$/i.test(ent.name)) continue;
      // 只收 *Test.java / *Tests.java / Test*.java
      if (!/(Test|Tests)\.java$/i.test(ent.name) && !/^Test.*\.java$/i.test(ent.name)) continue;
      out.push(ent.name.replace(/\.java$/i, ''));
    }
  };
  walk(testRoot);
  return out.sort();
}

/* ==================================================================== *
 * 在项目中定位测试类（报告分析页「失败用例 → 定位源码」用）
 *
 * 和 listTestClasses 的区别：
 *   listTestClasses 只回**类名**（代码调试页的「测试类」下拉只要名字，Maven 的
 *   -Dtest=类名 也只认名字）；而定位源码要的是**文件路径**，还要认包名 ——
 *   Allure 的 testClass 标签是 FQCN（com.x.LoginTest），不认包名就对不上。
 *   两个函数各管一处，listTestClasses 的返回形状不能动（有测试和页面在用）。
 * ==================================================================== */

/** 单个工程最多看多少个文件（防止用户把根目录配到盘符上，一次点击扫到天荒地老） */
const WALK_LIMIT = 4000;

/** 递归走文件；st.n 到上限就停（调用方据此告诉用户「可能不全」，不假装扫全了） */
function walkFiles(dir, onFile, st) {
  const state = st || { n: 0 };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return state;
  }
  for (const ent of entries) {
    if (state.n >= WALK_LIMIT) return state;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.indexOf('.') === 0) continue;
      walkFiles(full, onFile, state);
      continue;
    }
    state.n += 1;
    onFile(full);
  }
  return state;
}

/** 从 Java 源文件头部取 package 名（只读前 4KB：包声明一定在最前面） */
function readJavaPackage(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      head = buf.slice(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return '';
  }
  const m = /^[ \t]*package[ \t]+([\w.]+)[ \t]*;/m.exec(head);
  return m ? m[1] : '';
}

/** Java 测试类命名约定（和 listTestClasses 保持一致） */
function isJavaTestFile(name) {
  return /\.java$/i.test(name) && (/(Test|Tests)\.java$/i.test(name) || /^Test.*\.java$/i.test(name));
}

/** pytest 命名约定 */
function isPyTestFile(name) {
  return /\.py$/i.test(name) && (/^test_.*\.py$/i.test(name) || /_test\.py$/i.test(name));
}

/**
 * 列出工程里的测试类文件（带路径 / 包名 / 语言）。
 *
 * @param {string} projectDir 工程目录
 * @param {{n: number}} [state] 可选的遍历计数器（调用方拿它判断有没有扫到上限）
 * @returns {{className: string, fqcn: string, package: string, lang: string, file: string}[]}
 */
function listTestClassFiles(projectDir, state) {
  const dir = String(projectDir || '').trim();
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const st = state || { n: 0 };

  const hasPom = fs.existsSync(path.join(dir, 'pom.xml'));

  // ---- Java：只扫 Maven 约定的 src/test/java ----
  const javaRoot = path.join(dir, 'src', 'test', 'java');
  if (hasPom && fs.existsSync(javaRoot)) {
    walkFiles(javaRoot, (full) => {
      const name = path.basename(full);
      if (!isJavaTestFile(name)) return;
      const pkg = readJavaPackage(full);
      const className = name.replace(/\.java$/i, '');
      out.push({
        className,
        fqcn: pkg ? pkg + '.' + className : className,
        package: pkg,
        lang: 'java',
        file: full
      });
    }, st);
  }

  // ---- Python：没有 pom.xml 的工程里找 test_*.py ----
  if (!hasPom) {
    walkFiles(dir, (full) => {
      const name = path.basename(full);
      if (!isPyTestFile(name)) return;
      const rel = path.relative(dir, full).split(path.sep).join('/');
      const className = name.replace(/\.py$/i, '');
      out.push({
        className,
        fqcn: rel.replace(/\.py$/i, '').split('/').join('.'),
        package: rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')).split('/').join('.') : '',
        lang: 'python',
        file: full
      });
    }, st);
  }

  // 同一个文件只留一次（walkFiles 不会重复，这里是给以后改动兜底）
  const seen = new Set();
  return out
    .filter((f) => {
      const key = f.file.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.className.localeCompare(b.className));
}

/** Allure 的 testClass 归一化：去空白、去 .py、反斜杠转点 */
function normalizeTestClass(v) {
  return String(v || '')
    .trim()
    .replace(/\.py$/i, '')
    .replace(/[\\/]+/g, '.')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

/** 这个测试类文件是不是要找的那个（FQCN 或简单类名都认） */
function matchTestClassFile(f, want) {
  const target = String(want || '').toLowerCase();
  if (!target) return false;
  const cls = String(f.className || '').toLowerCase();
  const fq = String(f.fqcn || '').toLowerCase();
  if (!cls) return false;
  if (fq === target || cls === target) return true;
  // Allure 给的是 FQCN，用户也可能只有简单类名；两个方向都放行
  if (target.slice(-(cls.length + 1)) === '.' + cls) return true;
  if (fq && fq.slice(-(target.length + 1)) === '.' + target) return true;
  return false;
}

/**
 * 在项目根目录下找某个测试类的源文件。
 *
 * @param {string} root 项目根目录（设置里的「代码项目目录」）
 * @param {string} testClass Allure 的 testClass 标签（FQCN / 简单类名 / 文件名）
 * @returns {{ok: boolean, code?: string, message?: string, root?: string, testClass?: string,
 *            scanned?: string[], truncated?: string[], matches?: any[]}}
 */
function locateTestClass(root, testClass) {
  const want = normalizeTestClass(testClass);
  if (!want) {
    return { ok: false, code: 'NO_TEST_CLASS', message: '缺少测试类名', matches: [], scanned: [] };
  }
  const scan = scanProjects(root);
  if (!scan.ok) {
    return {
      ok: false,
      code: 'ROOT_NOT_FOUND',
      message: scan.message || '项目目录不可用',
      root: scan.root,
      matches: [],
      scanned: []
    };
  }

  // 用户可能把「代码项目目录」直接配到某个工程根（而不是它的上一级）：
  // scanProjects 只列子目录，这时要把它自己也算进来，否则一个都扫不到。
  const list = scan.projects.slice();
  const self = inspectProject(scan.root);
  if (self && !list.some((p) => p.dir === self.dir)) list.push(self);

  const matches = [];
  const scanned = [];
  const truncated = [];
  for (const p of list) {
    // 没有测试框架的工程不扫：扫了也是空，还慢
    if (!p.isTest) continue;
    const st = { n: 0 };
    const files = listTestClassFiles(p.dir, st);
    scanned.push(p.dir);
    if (st.n >= WALK_LIMIT) truncated.push(p.dir);
    for (const f of files) {
      if (matchTestClassFile(f, want)) matches.push(f);
    }
  }

  // FQCN 完全一致的排前面（同名类分在不同包时，先给最像的那个）
  const lower = want.toLowerCase();
  matches.sort((a, b) => {
    const ea = String(a.fqcn || '').toLowerCase() === lower ? 0 : 1;
    const eb = String(b.fqcn || '').toLowerCase() === lower ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return a.file.localeCompare(b.file);
  });

  return {
    ok: true,
    root: scan.root,
    testClass: want,
    scanned,
    truncated,
    matches
  };
}

module.exports = {
  scanProjects,
  listTestClasses,
  listTestClassFiles,
  locateTestClass,
  inspectProject,
  MAVEN_FRAMEWORKS
};
