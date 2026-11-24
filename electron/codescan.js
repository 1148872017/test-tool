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

  /**
   * 后缀匹配（代码可能省略了公共前缀）。
   *
   * 但要防误判：
   *   页面清单是 '/login'，代码里有 '/api/login'（接口请求），
   *   如果直接 endsWith，'/login' 会被判成"已覆盖"——这是错的，
   *   页面归页面、接口归接口，不能混。
   *
   * 所以要求「短的那个路径」至少有两段（即至少 2 个斜杠），
   *   '/v1/user'  → 2 个斜杠 → 可以后缀匹配（接口场景）
   *   '/login'    → 1 个斜杠 → 不匹配（避免页面被接口误覆盖）
   */
  const segCount = (p) => (String(p).match(/\//g) || []).length;

  if (b.endsWith(a) && segCount(a) >= 2) return true;
  if (a.endsWith(b) && segCount(b) >= 2) return true;

  return false;
}

/**
 * 覆盖矩阵：接口清单 vs 代码里的路径。
 *
 * @param {any[]} items  接口记录或页面记录
 *   - 接口：data 里有 method / url / module
 *   - 页面：data 里有 url / name / project
 * @param {string} root  代码根目录
 * @param {string} kind  'api'（接口）| 'page'（页面）
 * @returns {{
 *   ok: boolean,
 *   kind: string,
 *   total: number,
 *   covered: number,
 *   uncovered: any[],
 *   coveredList: any[],
 *   codePaths: {path: string, file: string, line: number}[],
 *   message?: string
 * }}
 */
function buildCoverage(items, root, kind = 'api') {
  const k = kind === 'page' ? 'page' : 'api';
  const base = String(root || '').trim();
  if (!base || !fs.existsSync(base)) {
    return { ok: false, kind: k, total: 0, covered: 0, uncovered: [], coveredList: [], codePaths: [], message: '代码目录不存在' };
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

  for (const it of items || []) {
    const d = it.data || {};
    const target = normalizePath(d.url || d.path || '');
    if (!target) continue;

    const hits = codePaths.filter((cp) => pathMatches(cp.path, target));
    const entry = {
      id: it.id,
      name: it.title || d.name || '',
      method: k === 'api' ? String(d.method || '') : '',
      url: d.url || d.path || '',
      module: d.module || d.project || '',
      hits: hits.length,
      files: Array.from(new Set(hits.map((h) => h.file))).slice(0, 5)
    };

    if (hits.length) coveredList.push(entry);
    else uncovered.push(entry);
  }

  const total = coveredList.length + uncovered.length;
  return {
    ok: true,
    kind: k,
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
 * 断言质量检查规则。
 *
 * 规划要求：「检查断言质量：是不是只有 assert response.status_code == 200，
 *            而没有对业务 Body 进行校验」
 *
 * 思路：一个测试测试方法里，如果只有状态码断言、没有 body/字段断言 → 报「弱断言」。
 *       这是启发式检查（正则 + 平衡扫描），不是 AST 分析。
 */

/** 状态码类断言（弱） */
const STATUS_ONLY_PATTERNS = [
  // Java REST Assured
  /\.statusCode\s*\(\s*\d{3}\s*\)/g,
  // Python requests
  /assert\s+\w+\.status_code\s*==\s*\d{3}/g,
  // Java assertEquals(status, 200)
  /assertEquals\s*\(\s*\w*[Ss]tatus\w*\s*,\s*\d{3}/g,
  // Playwright：只检查 response.ok()
  /assert\s+\w+\.ok\b/g
];

/** Body / 字段类断言（强） */
const BODY_PATTERNS = [
  /\.body\s*\(/g,                              // REST Assured .body("...", ...)
  /\.jsonPath\s*\(/g,                          // jsonPath 断言
  /\.(?:get|post|put|delete)\w*\([^)]*\)\s*\.\s*json\s*\(/g, // resp.json()
  /\bresp(?:onse)?\.json\(\)/gi,               // response.json()
  /assertR?[Ee]quals?\s*\(\s*\w+\.(?:json|body)/g,
  /\.(?:hasSize|containsString|equalTo|notNullValue)\s*\(/g, // Hamcrest
  /expect\s*\([^)]*\)\s*\.\s*to(?:Be|Have|Contain)/g,       // Playwright expect
  /assert\s+\w+\[\s*["']/g,                     // assert body["code"]
  /assert\s+\w+\.(?:data|code|msg|result)\b/g,   // assert resp.data == ...
  /\.json\(\)\s*\[/g,                          // resp.json()["code"]
  /assert\s+.*\.json\(\)/g,                      // 任何 assert 里调用 json()
  /\bjsonPath\s*\(/g,                            // jsonPath("$.code")
  /\bgetBody\s*\(\s*\)\s*\./g                   // Java getBody().xxx
];

/** 是否是测试方法（启发式） */
function looksLikeTest(block) {
  return /@Test|def\s+test_|def\s+test[A-Z]|it\s*\(|public\s+void\s+test/i.test(block);
}

/**
 * 扫描断言质量。
 *
 * 只在「测试方法」范围内统计，避免误报工具代码。
 *
 * @param {string} code
 * @param {string} file
 * @returns {any[]} 问题列表
 */
function scanAssertionQuality(code, file) {
  const issues = [];
  const text = String(code || '');
  if (!looksLikeTest(text)) return issues;

  // 按方法块粗切：找 @Test / def test_ / public void test 开头的段
  //
  // 两种语言结束块的判定方式不同：
  //   Java / JS / Groovy → 大括号深度归零
  //   Python           → 缩进归零（没有大括号，用深度判断会提前截断）
  const isPython = /\.py$/i.test(String(file || '')) || (/^\s*def\s+test/m.test(text) && !/[{}]/.test(text));
  const blocks = [];
  const lines = text.split('\n');
  let cur = null;
  let depth = 0;
  let baseIndent = 0;

  const startRe = /@Test\b|def\s+test_|def\s+test[A-Z]|public\s+void\s+test/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isStart = startRe.test(line);

    if (isStart && !cur) {
      cur = { start: i, lines: [] };
      depth = 0;
      baseIndent = line.search(/\S/);
    }

    if (!cur) continue;
    cur.lines.push(line);

    if (isPython) {
      // Python：遇到下一行是「非空且缩进 <= 基准」→ 块结束（但至少收 2 行）
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      const nextIsCode = next !== null && next.trim() !== '';
      const nextIndent = nextIsCode ? next.search(/\S/) : -1;
      const ended = !nextIsCode || nextIndent <= baseIndent;
      if (ended && cur.lines.length >= 2) {
        blocks.push(cur);
        cur = null;
      }
    } else {
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      const nextIsStart = i + 1 < lines.length && startRe.test(lines[i + 1]);
      if ((depth <= 0 && cur.lines.length > 2) || nextIsStart) {
        blocks.push(cur);
        cur = null;
      }
    }
  }  if (cur) blocks.push(cur);

  for (const blk of blocks) {
    const body = blk.lines.join('\n');

    let hasStatus = false;
    for (const re of STATUS_ONLY_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(body)) {
        hasStatus = true;
        break;
      }
    }
    if (!hasStatus) continue;

    let hasBody = false;
    for (const re of BODY_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(body)) {
        hasBody = true;
        break;
      }
    }
    if (hasBody) continue;

    // 找方法名，便于定位
    const nameLine = blk.lines.find((l) => /void\s+(\w+)\s*\(|def\s+(test\w+)/i.test(l)) || '';
    const m = /void\s+(\w+)\s*\(|def\s+(test\w+)/i.exec(nameLine);
    const methodName = m ? m[1] || m[2] : '（未知方法）';

    issues.push({
      rule: 'weak-assertion',
      label: '断言过弱',
      severity: 'medium',
      hint: '只校验了状态码，没有校验业务 Body / 关键字段 —— 接口返回 200 但业务失败时抓不到',
      file,
      line: blk.start + 1,
      snippet: methodName + '() 只有状态码断言',
      methodName
    });
  }

  return issues;
}

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
function scanHardcoded(root, opts = {}) {
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

  // 断言质量检查（单独一轮，按方法块扫）
  const enableAssertion = opts.enableAssertion !== false;
  if (enableAssertion) {
    for (const file of files) {
      const code = readSafe(file);
      if (!code) continue;
      issues.push(...scanAssertionQuality(code, file));
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
  scanAssertionQuality,
  extractPaths,
  normalizePath,
  pathMatches,
  buildCoverage,
  scanHardcoded,
  RULES
};
