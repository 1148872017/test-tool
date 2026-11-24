'use strict';
/**
 * 依赖冲突检查（简化版）。
 *
 * 规划要求：「解析本地的 pom.xml 或 requirements.txt，识别冲突版本或未使用的冗余依赖」。
 *
 * 这里做**能可靠做到的三件事**：
 *   1. 同一 groupId:artifactId 出现多次（重复声明）
 *   2. 同一包声明了不同版本（直接冲突）
 *   3. version 里还有未替换的占位符（如 ${xxx.version} 没定义）
 *
 * **不做**：传递依赖分析。
 *   那要解析完整依赖树（含 parent、dependencyManagement、profiles、可选依赖），
 *   还得联网查 Maven Central —— 成本远超收益，IDE 的 mvn dependency:tree 更准。
 */

const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

/** 递归找文件（限深度，跳过 node_modules 等） */
function findFiles(root, name, maxDepth = 6) {
  const out = [];
  const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', 'out', '.idea', 'venv', '__pycache__']);

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (ent.name === name) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** 取元素的直接子元素文本 */
function childText(el, tag) {
  if (!el || !el.childNodes) return '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeType === 1 && c.tagName === tag) {
      return String(c.textContent || '').trim();
    }
  }
  return '';
}

/** 取所有指定 tag 的后代元素 */
function allByTag(doc, tag) {
  const out = [];
  const walk = (node) => {
    if (!node || !node.childNodes) return;
    for (let i = 0; i < node.childNodes.length; i++) {
      const c = node.childNodes[i];
      if (c.nodeType !== 1) continue;
      if (c.tagName === tag) out.push(c);
      walk(c);
    }
  };
  walk(doc);
  return out;
}

/**
 * 解析 pom.xml 的依赖。
 * @param {string} file
 * @returns {{file: string, deps: any[], properties: Record<string,string>}}
 */
function parsePom(file) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} }
  }).parseFromString(text, 'text/xml');

  // 收集 <properties> 里的键值（用于判断 version 是不是占位符）
  const properties = {};
  for (const propsEl of allByTag(doc, 'properties')) {
    for (let i = 0; i < propsEl.childNodes.length; i++) {
      const c = propsEl.childNodes[i];
      if (c.nodeType !== 1) continue;
      properties[c.tagName] = String(c.textContent || '').trim();
    }
  }

  const deps = [];
  for (const depEl of allByTag(doc, 'dependency')) {
    const groupId = childText(depEl, 'groupId');
    const artifactId = childText(depEl, 'artifactId');
    const version = childText(depEl, 'version');
    const scope = childText(depEl, 'scope');
    // dependencyManagement 里的也收（它们是"版本声明"，同样要查冲突）
    if (!groupId && !artifactId) continue;
    deps.push({ groupId, artifactId, version, scope, file });
  }

  return { file, deps, properties };
}

/**
 * 解析 requirements.txt 的依赖。
 * @param {string} file
 */
function parseRequirements(file) {
  const text = fs.readFileSync(file, 'utf8');
  const deps = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // 去掉行内注释
    const body = line.split('#')[0].trim();
    if (!body) continue;

    // pkg==1.0 / pkg>=1.0 / pkg~=1.0 / pkg
    const m = /^([A-Za-z0-9_.\-[\]]+)\s*(==|>=|<=|~=|!=|>|<)?\s*([^\s;]*)?/.exec(body);
    if (!m) continue;
    deps.push({
      name: m[1],
      op: m[2] || '',
      version: m[3] || '',
      file
    });
  }

  return deps;
}

/**
 * 检查依赖冲突。
 *
 * @param {string} root 项目根目录
 * @returns {{ok: boolean, poms: number, reqs: number, issues: any[], summary: any, message?: string}}
 */
function checkDeps(root) {
  const base = String(root || '').trim();
  if (!base || !fs.existsSync(base)) {
    return { ok: false, poms: 0, reqs: 0, issues: [], summary: { total: 0 }, message: '目录不存在' };
  }

  const pomFiles = findFiles(base, 'pom.xml');
  const reqFiles = findFiles(base, 'requirements.txt').concat(findFiles(base, 'requirements-dev.txt'));

  if (!pomFiles.length && !reqFiles.length) {
    return {
      ok: true,
      poms: 0,
      reqs: 0,
      issues: [],
      summary: { total: 0 },
      message: '这个目录下没有 pom.xml 或 requirements.txt'
    };
  }

  const issues = [];

  /* ---------- Maven ---------- */
  for (const pom of pomFiles) {
    let parsed;
    try {
      parsed = parsePom(pom);
    } catch (e) {
      issues.push({
        kind: 'parse-error',
        severity: 'low',
        title: 'pom.xml 解析失败',
        detail: String(e && e.message),
        file: pom
      });
      continue;
    }

    // 按 groupId:artifactId 分组
    const byKey = new Map();
    for (const d of parsed.deps) {
      if (!d.artifactId) continue;
      const key = (d.groupId || '') + ':' + d.artifactId;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(d);
    }

    for (const [key, list] of byKey) {
      const rel = path.relative(base, pom).replace(/\\/g, '/');

      // 1) 重复声明
      if (list.length > 1) {
        issues.push({
          kind: 'maven-duplicate',
          severity: 'medium',
          title: '依赖声明了多次',
          detail: `${key} 在同一个 pom 里出现 ${list.length} 次`,
          file: rel
        });
      }

      // 2) 版本冲突
      const versions = [...new Set(list.map((d) => d.version).filter(Boolean))];
      if (versions.length > 1) {
        issues.push({
          kind: 'maven-version-conflict',
          severity: 'high',
          title: '同一依赖声明了不同版本',
          detail: `${key} → ${versions.join(' / ')}`,
          file: rel
        });
      }

      // 3) 占位符没定义
      for (const d of list) {
        const vm = /^\$\{([^}]+)\}$/.exec(d.version || '');
        if (vm && !parsed.properties[vm[1]]) {
          issues.push({
            kind: 'maven-unresolved-property',
            severity: 'medium',
            title: '版本占位符没定义',
            detail: `${key} 的 version 是 \${${vm[1]}}，但 <properties> 里没有这个键`,
            file: rel
          });
        }
      }
    }
  }

  /* ---------- Python ---------- */
  const pyByKey = new Map();
  for (const req of reqFiles) {
    let deps;
    try {
      deps = parseRequirements(req);
    } catch (e) {
      continue;
    }
    for (const d of deps) {
      const name = d.name.toLowerCase();
      if (!pyByKey.has(name)) pyByKey.set(name, []);
      pyByKey.get(name).push(Object.assign({}, d, { file: req }));
    }
  }

  for (const [name, list] of pyByKey) {
    const rel0 = path.relative(base, list[0].file).replace(/\\/g, '/');

    // 1) 同一文件里重复
    const byFile = new Map();
    for (const d of list) {
      const f = path.relative(base, d.file).replace(/\\/g, '/');
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(d);
    }
    for (const [f, ls] of byFile) {
      if (ls.length > 1) {
        issues.push({
          kind: 'pip-duplicate',
          severity: 'medium',
          title: '同一个 requirements 里包重复',
          detail: `${name} 出现 ${ls.length} 次`,
          file: f
        });
      }
    }

    // 2) 精确版本冲突（==）
    const pinned = [...new Set(list.filter((d) => d.op === '==' && d.version).map((d) => d.version))];
    if (pinned.length > 1) {
      issues.push({
        kind: 'pip-version-conflict',
        severity: 'high',
        title: '同一个包锁了不同版本',
        detail: `${name} → ${pinned.join(' / ')}`,
        file: rel0
      });
    }
  }

  const summary = { high: 0, medium: 0, low: 0, total: issues.length };
  for (const it of issues) summary[it.severity] = (summary[it.severity] || 0) + 1;

  return { ok: true, poms: pomFiles.length, reqs: reqFiles.length, issues, summary };
}

module.exports = { checkDeps, parsePom, parseRequirements };