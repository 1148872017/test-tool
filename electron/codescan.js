'use strict';
/**
 * 代码扫描：覆盖矩阵 + 硬编码检查。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **正则扫描，不做 AST**
 *    目标是「找出可疑代码」，不是「精确解析」。正则够用且快。
 *
 * 2. **覆盖矩阵：URL 模糊匹配**
 *    代码里 `.get("/api/v1/user")` 和接口记录的 `/api/v1/user` 对比。
 *    去掉域名、协议、查询参数后比对。
 *
 * 3. **硬编码检查：分级**
 *    high   = 密码/Token 明文
 *    medium = 硬编码 URL、sleep()
 *    low    = 脆弱定位器
 */

const fs = require('fs');
const path = require('path');

/** 跳过这些目录 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'build',
  'dist',
  'out',
  '.idea',
  '.vscode',
  '__pycache__',
  'venv',
  '.venv',
  'allure-results',
  'test-results'
]);

/** 只扫这些扩展名 */
const SCAN_EXTS = new Set(['.java', '.py', '.js', '.ts', '.groovy', '.kt', '.cs']);

/** 单文件大小上限（超过跳过，避免扫大文件） */
const MAX_FILE_SIZE = 1024 * 1024;

/* ============================================================
 * 文件遍历
 * ============================================================ */

/**
 * 递归收集要扫的文件。
 * @param {string} root
 * @param {number} [maxFiles]
 * @returns {string[]}
 */
function collectFiles(root, maxFiles = 3000) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= maxFiles) return;
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith('.')) continue;
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (!SCAN_EXTS.has(ext)) continue;
      try {
        if (fs.statSync(full).size > MAX_FILE_SIZE) continue;
      } catch (e) {
        continue;
      }
      out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/** 读文件（失败返回空串） */
function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

/* ============================================================
 * 覆盖矩阵
 * ============================================================ */

/**
 * 从代码里提取请求路径。
 *
 * 匹配：
 *   .get("/api/v1/user")
 *   .post("/api/v1/user")
 *   requests.get("http://x/api/v1/user")
 *   page.goto("/login")
 *   RestAssured.given().get("/path")
 *
 * @param {string} code
 * @returns {string[]} 路径列表
 */
function extractPaths(code) {
  const out = new Set();
  const text = String(code || '');

  // 先收集常量定义：NAME = "/path" / NAME: "/path"
  // 因为很多项目把路径抽成常量，然后 .post(LOGIN_PATH)
  const consts = new Map();
  const reConst = /(?:static\s+final\s+String|final\s+String|const\s+|let\s+|var\s+|String\s+)?\b([A-Z_][A-Z0-9_]*)\s*[:=]\s*["']([^"']+)["']/g;
  let cm;
  while ((cm = reConst.exec(text))) {
    consts.set(cm[1], cm[2]);
  }

  // .get("/path") / .post('/path') / .put / .delete / .patch
  const reMethod = /\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/gi;
  let m;
  while ((m = reMethod.exec(text))) {
    const p = normalizePath(m[2]);
    if (p) out.add(p);
  }

  // requests.get("http://x/path") / requests.post(...)
  const reReq = /requests\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi;
  while ((m = reReq.exec(text))) {
    const p = normalizePath(m[2]);
    if (p) out.add(p);
  }

  // page.goto("/path") / page.navigate("/path")
  const reNav = /\.(goto|navigate)\s*\(\s*["']([^"']+)["']/gi;
  while ((m = reNav.exec(text))) {
    const p = normalizePath(m[2]);
    if (p) out.add(p);
  }

  // .get(CONST_NAME) / .post(CONST_NAME) —— 用常量名反查
  const reConstUse = /\.(get|post|put|delete|patch|head|options)\s*\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g;
  while ((m = reConstUse.exec(text))) {
    const val = consts.get(m[2]);
    if (val) {
      const p = normalizePath(val);
      if (p) out.add(p);
    }
  }

  // requests.get(CONST_NAME)
  const reReqConst = /requests\.(get|post|put|delete|patch)\s*\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g;
  while ((m = reReqConst.exec(text))) {
    const val = consts.get(m[2]);
    if (val) {
      const p = normalizePath(val);
      if (p) out.add(p);
    }
  }

  // 兜底：所有形如 "/api/xxx" 的字符串字面量（可能是路径常量）
  const reLiteral = /["'](\/[a-zA-Z0-9_\-\/{}.]+)["']/g;
  while ((m = reLiteral.exec(text))) {
    const p = normalizePath(m[1]);
    // 过滤掉太像文件路径的（有扩展名）
    if (p && !/\.[a-z]{2,4}$/i.test(p)) out.add(p);
  }

  return Array.from(out);
}

/**
 * 归一化路径：去掉协议/域名/查询参数/末尾斜杠。
 * @param {string} raw
 */
function normalizePath(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 去掉协议+域名
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  // 去掉查询参数
  s = s.split('?')[0];
  // 去掉末尾斜杠
  s = s.replace(/\/+$/, '');
  // 必须以 / 开头
  if (!s.startsWith('/')) s = '/' + s;
  // 太短的不要（"/" 或 "/a"）
  if (s.length < 3) return '';
  return s;
}

/**
 * 路径模糊匹配：代码里的路径 vs 接口记录的路径。
 *
 * 规则：
 *   - 完全相同 → 命中
 *   - 代码路径是接口路径的后缀 → 命中（代码可能只写 /v1/user）
 *   - 接口路径含 {xxx} 占位符 → 把占位符换成通配再比
 *
 * @param {string} codePath
 * @param {string} apiPath
 */
function pathMatches(codePath, apiPath) {
  const a = normalizePath(codePath);
  const b = normalizePath(apiPath);
  if (!a || !b) return false;
  if (a === b) return true;

  // 接口路径的 {xxx} → 通配
  const bPattern = b.replace(/\{[^}]+\}/g, '[^/]+');
  try {
    const re = new RegExp('^' + bPattern + '$');
    if (re.test(a)) return true;
  } catch (e) {
    /* ignore */
  }

  // 代码路径是接口路径的后缀（代码可能省略了前缀）
  if (b.endsWith(a) && a.length >= 4) return true;
  if (a.endsWith(b) && b.length >= 4) return true;

  return false;
}

/**
 * 覆盖矩阵：接口清单 vs 代码里的路径。
 *
 * @param {any[]} apis 接口记录（data 里有 method/url）
 * @param {string} root 代码根目录
 * @returns {{
 *   ok: boolean,
 *   total: number,
 *   covered: number,
 *   uncovered: any[],
 *   coveredList: any[],
 *   codePaths: {path: string, file: string, line: number}[],
 *   message?: string
 * }}
 */
function buildCoverage(apis, root) {
  const base = String(root || '').trim();
  if (!base || !fs.existsSync(base)) {
    return { ok: false, total: 0, covered: 0, uncovered: [], coveredList: [], codePaths: [], message: '代码目录不存在' };
  }

  const files = collectFiles(base);
  const codePaths = [];

  for (const file of files) {
    const code = readSafe(file);
    if (!code) continue;
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const found = extractPaths(lines[i]);
      for (const p of found) {
        codePaths.push({ path: p, file, line: i + 1 });
      }
    }
  }

  const coveredList = [];
  const uncovered = [];

  for (const api of apis || []) {
    const d = api.data || {};
    const apiPath = normalizePath(d.url || '');
    if (!apiPath) continue;

    const hits = codePaths.filter((cp) => pathMatches(cp.path, apiPath));
    const item = {
      id: api.id,
      name: api.title || d.name || '',
      method: d.method || '',
      url: d.url || '',
      module: d.module || '',
      hits: hits.length,
      files: Array.from(new Set(hits.map((h) => h.file))).slice(0, 5)
    };

    if (hits.length) coveredList.push(item);
    else uncovered.push(item);
  }

  const total = coveredList.length + uncovered.length;
  return {
    ok: true,
    total,
    covered: coveredList.length,
    uncovered,
    coveredList,
    codePaths,
    scannedFiles: files.length
  };
}

/* ============================================================
 * 硬编码检查
 * ============================================================ */

/** 检查规则 */
const RULES = [
  {
    key: 'hardcoded-password',
    label: '硬编码密码',
    severity: 'high',
    // password = "xxx" / pwd: "xxx" / passwd="xxx"
    re: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{3,}["']/gi,
    hint: '密码应放配置/环境变量，不要写死在代码里'
  },
  {
    key: 'hardcoded-token',
    label: '硬编码 Token / 密钥',
    severity: 'high',
    // token = "xxx" / apiKey: "xxx" / secret = "xxx"
    re: /(?:token|api[_-]?key|secret|access[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/gi,
    hint: 'Token/密钥应放配置/环境变量'
  },
  {
    key: 'hardcoded-url',
    label: '硬编码 URL',
    severity: 'medium',
    // "http://..." 或 "https://..."（排除注释里的示例）
    re: /["']https?:\/\/[^"'\s]{6,}["']/gi,
    hint: 'URL 应放配置，方便切换环境'
  },
  {
    key: 'sleep',
    label: '硬编码 sleep',
    severity: 'medium',
    // Thread.sleep(3000) / time.sleep(3) / page.waitForTimeout(3000)
    re: /(?:Thread\.sleep|time\.sleep|waitForTimeout)\s*\(\s*\d+/gi,
    hint: 'sleep 会让测试变慢且不稳定，应改用显式等待'
  },
  {
    key: 'absolute-xpath',
    label: '绝对 XPath',
    severity: 'low',
    // By.xpath("/html/body/div[1]/...") 或 "//div[@id='x']/div[2]/span"
    re: /["']\/html\/body\/[^"']+["']/gi,
    hint: '绝对 XPath 极易失效，建议用 data-testid 或相对定位'
  },
  {
    key: 'deep-css',
    label: '深层 CSS 选择器',
    severity: 'low',
    // "div > div > div > span" 这种超过 4 层的
    re: /["'][a-z]+(?:\s*>\s*[a-z]+){4,}["']/gi,
    hint: '深层 CSS 选择器脆弱，建议用 data-testid'
  }
];

/**
 * 扫描硬编码问题。
 *
 * @param {string} root
 * @returns {{
 *   ok: boolean,
 *   issues: any[],
 *   summary: {high: number, medium: number, low: number, total: number},
 *   scannedFiles: number,
 *   message?: string
 * }}
 */
function scanHardcoded(root) {
  const base = String(root || '').trim();
  if (!base || !fs.existsSync(base)) {
    return { ok: false, issues: [], summary: { high: 0, medium: 0, low: 0, total: 0 }, scannedFiles: 0, message: '代码目录不存在' };
  }

  const files = collectFiles(base);
  const issues = [];

  for (const file of files) {
    const code = readSafe(file);
    if (!code) continue;
    const lines = code.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 跳过注释行（简单判断）
      if (/^(\/\/|#|\*|\/\*)/.test(trimmed)) continue;
      // 跳过明显的占位符
      if (/TODO|FIXME|example\.com|localhost|127\.0\.0\.1|placeholder/i.test(trimmed)) continue;

      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (!m) continue;

        issues.push({
          rule: rule.key,
          label: rule.label,
          severity: rule.severity,
          hint: rule.hint,
          file,
          line: i + 1,
          // 脱敏：只显示前 40 字符
          snippet: trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed
        });
        break; // 一行只报一个问题
      }
    }
  }

  const summary = { high: 0, medium: 0, low: 0, total: issues.length };
  for (const it of issues) summary[it.severity]++;

  // 按严重程度排序
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  return { ok: true, issues, summary, scannedFiles: files.length };
}

module.exports = {
  collectFiles,
  extractPaths,
  normalizePath,
  pathMatches,
  buildCoverage,
  scanHardcoded,
  RULES
};
