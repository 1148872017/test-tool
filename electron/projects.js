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

module.exports = { scanProjects, listTestClasses, inspectProject, MAVEN_FRAMEWORKS };
