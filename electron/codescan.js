'use strict';
/**
 * 代码扫描：覆盖矩阵 + 代码体检（硬编码 / 脆弱定位 / 断言质量）。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **规则表在 scan-rules.js**：本文件只负责「遍历文件 + 读内容 + 组装结果」，
 *    具体什么算问题由规则表决定（可单独单测，不依赖 fs/electron）。
 *
 * 2. **覆盖矩阵：URL 模糊匹配**
 *    代码里 `.get("/api/v1/user")` 和接口记录的 `/api/v1/user` 对比。
 *    去掉域名、协议、查询参数后比对。
 *
 * 3. **注释里的代码不算问题 / 文档不按代码体检**：这两条都在 scan-rules 里实现，
 *    本文件不再自己判断（否则两处规则会漂移）。
 *
 * 4. **对外签名保持不变**：buildCoverage / scanHardcoded / scanAssertionQuality
 *    的老调用方式（含测试）继续可用；ruleIds 只是新增的可选参数。
 */

const fs = require('fs');
const path = require('path');

const {
  RULES,
  MAX_HITS_PER_RULE,
  DOC_FILE_RE,
  ruleOf,
  normalizeRuleIds,
  matchRules
} = require('./scan-rules');

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

/**
 * 只扫这些扩展名。
 *
 * `.md` / `.txt` 进范围是**为了扫文档里的内网地址 / 令牌**（sec-* 规则），
 * 不是把 README 当测试代码体检（ui-* / assert-* / cov-* 会被 scan-rules 的
 * CODE_ONLY_RULE_RE 挡掉）。覆盖矩阵也会主动跳过文档，避免示例路径被当成「已覆盖」证据。
 */
const SCAN_EXTS = new Set([
  '.java',
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.groovy',
  '.kt',
  '.cs',
  '.md',
  '.txt'
]);

/** 单文件大小上限（超过跳过，避免扫大文件） */
const MAX_FILE_SIZE = 1024 * 1024;

/** 单次体检最多带出多少条问题（超出必须告诉用户被截断了，不能静默） */
const MAX_ISSUES = 500;

/** 最多遍历多少个文件 */
const MAX_FILES = 3000;

/** 形如文件名的路径不算接口路径（/index.html、/app.js） */
const LOOKS_LIKE_FILE_RE = /\.[a-z]{2,4}$/i;

/* ============================================================
 * 文件遍历
 * ============================================================ */

/**
 * 递归收集要扫的文件。
 *
 * @param {string} root
 * @param {number} [maxFiles]
 * @param {{truncatedFiles?: boolean, skippedSize?: number}} [stats] 顺带回传遍历统计
 * @returns {string[]}
 */
function collectFiles(root, maxFiles = MAX_FILES, stats = null) {
  const out = [];
  const st = stats || null;
  const markTruncated = () => {
    if (st) st.truncatedFiles = true;
  };
  const walk = (dir, depth) => {
    if (out.length >= maxFiles) {
      markTruncated();
      return;
    }
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) {
        markTruncated();
        return;
      }
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
        if (fs.statSync(full).size > MAX_FILE_SIZE) {
          if (st) st.skippedSize = (st.skippedSize || 0) + 1;
          continue;
        }
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
 * 某个包（这里只有 coverage）下本次启用的规则 id。
 * @param {string[]} [ruleIds]
 */
function coverageRuleIds(ruleIds) {
  const wanted = normalizeRuleIds(ruleIds);
  return RULES.filter((r) => r.pack === 'coverage' && (!wanted || wanted.has(r.id))).map((r) => r.id);
}

/**
 * 收集代码里的字符串常量定义（给 `.post(LOGIN_PATH)` 这种写法反查用）。
 * @param {string} text
 * @returns {Map<string, string>}
 */
function collectStringConsts(text) {
  const consts = new Map();
  const re = /(?:static\s+final\s+String|final\s+String|const\s+|let\s+|var\s+|String\s+)?\b([A-Z_][A-Z0-9_]*)\s*[:=]\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) consts.set(m[1], m[2]);
  return consts;
}

/**
 * 从代码里提取请求路径。
 *
 * 走规则表的 coverage 包（5 条）：
 *   Spring 映射 / .get("/x") 链式调用 / requests.get / .url("/x") / 路径字面量
 * 另外做一步**常量名反查**（不是规则，是取数后处理）：
 *   `private static final String LOGIN_PATH = "/api/login";` + `.post(LOGIN_PATH)`
 *
 * @param {string} code
 * @param {string[]} [ruleIds] 只跑这些 coverage 规则
 * @param {string} [filePath] 用来判断文档扩展名（cov-* 不扫文档）
 * @returns {string[]} 归一化后的路径列表
 */
function extractPaths(code, ruleIds, filePath) {
  const text = String(code || '');
  const ids = coverageRuleIds(ruleIds);
  if (!ids.length) return [];

  const out = new Set();
  // 覆盖取数不设「每规则每文件 3 条」的上限：要的是这个文件里出现了哪些路径
  const res = matchRules(text, String(filePath || ''), ids, { maxHits: 0 });
  for (const h of res.hits) {
    if (!h.path) continue;
    if (h.ruleId === 'cov-path-literal' && LOOKS_LIKE_FILE_RE.test(h.path)) continue;
    const p = normalizePath(h.path);
    if (p) out.add(p);
  }

  const consts = collectStringConsts(text);

  // .post(LOGIN_PATH) —— 链式调用传常量
  if (ids.includes('cov-restassured')) {
    const re = /\.(get|post|put|delete|patch|head|options)\s*\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g;
    let m;
    while ((m = re.exec(text))) {
      const val = consts.get(m[2]);
      if (!val) continue;
      const p = normalizePath(val);
      if (p) out.add(p);
    }
  }

  // requests.post(LOGIN_PATH)
  if (ids.includes('cov-python-requests')) {
    const re = /\brequests\.(get|post|put|delete|patch)\s*\(\s*([A-Z_][A-Z0-9_]*)\s*[,)]/g;
    let m;
    while ((m = re.exec(text))) {
      const val = consts.get(m[2]);
      if (!val) continue;
      const p = normalizePath(val);
      if (p) out.add(p);
    }
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
 * @param {{ruleIds?: string[]}} [opts] 只跑部分 coverage 取数规则
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
function buildCoverage(items, root, kind = 'api', opts = {}) {
  const k = kind === 'page' ? 'page' : 'api';
  const base = String(root || '').trim();
  if (!base || !fs.existsSync(base)) {
    return { ok: false, kind: k, total: 0, covered: 0, uncovered: [], coveredList: [], codePaths: [], message: '代码目录不存在' };
  }

  const ids = coverageRuleIds(opts && opts.ruleIds);
  if (!ids.length) {
    return { ok: false, kind: k, total: 0, covered: 0, uncovered: [], coveredList: [], codePaths: [], message: '没有启用任何取数规则' };
  }

  /**
   * 文档不参与覆盖取数：README 里的示例路径被当成「已覆盖」证据比漏报更危险
   * （用户会以为测过了）。所以这里先按扩展名挡掉 .md/.txt。
   */
  const files = collectFiles(base).filter((f) => !DOC_FILE_RE.test(f));
  const codePaths = [];

  for (const file of files) {
    const code = readSafe(file);
    if (!code) continue;
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const found = extractPaths(lines[i], ids, file);
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
    scannedFiles: files.length,
    ruleIds: ids
  };
}

/* ============================================================
 * 代码体检（硬编码 / 脆弱定位 / 断言质量）
 * ============================================================ */

/**
 * 把规则命中转成对外的 issue 形状。
 *
 * `rule` 保留老版本 key（v0.41.2 的 issue.rule，历史统计/白名单按它记过），
 * `ruleId` 是新规则表 id。两者都带出来，老代码不用改。
 *
 * @param {any} hit matchRules 的命中
 * @param {string} file
 */
function hitToIssue(hit, file) {
  const rule = ruleOf(hit.ruleId);
  const issue = {
    rule: (rule && rule.legacy) || hit.ruleId,
    ruleId: hit.ruleId,
    label: hit.title,
    severity: hit.severity,
    hint: rule ? rule.desc : '',
    file,
    line: hit.line,
    snippet: hit.snippet
  };
  if (hit.methodName) issue.methodName = hit.methodName;
  return issue;
}

/**
 * 扫描断言质量（只在一个文件内判定，给老调用方与单测用）。
 *
 * 只看 assert-* 规则：方法级规则按「测试方法块」判定，行级规则（只判真假）按行判定。
 *
 * @param {string} code
 * @param {string} file
 * @returns {any[]} 问题列表
 */
function scanAssertionQuality(code, file) {
  const text = String(code || '');
  if (!text) return [];
  const ids = RULES.filter((r) => r.pack === 'audit' && r.category === 'assert').map((r) => r.id);
  const res = matchRules(text, String(file || ''), ids);
  return res.hits.map((h) => hitToIssue(h, file));
}

/**
 * 代码体检：跑 audit 包的规则。
 *
 * @param {string} root
 * @param {{ruleIds?: string[], enableAssertion?: boolean}} [opts]
 * @returns {{
 *   ok: boolean,
 *   issues: any[],
 *   summary: {high: number, medium: number, low: number, total: number},
 *   scannedFiles: number,
 *   suppressed: number,
 *   truncated: boolean,
 *   truncatedReason: string,
 *   rulesRun: string[],
 *   message?: string
 * }}
 */
function scanHardcoded(root, opts = {}) {
  const base = String(root || '').trim();
  const blank = {
    ok: false,
    issues: [],
    summary: { high: 0, medium: 0, low: 0, total: 0 },
    scannedFiles: 0,
    suppressed: 0,
    truncated: false,
    truncatedReason: '',
    rulesRun: []
  };
  if (!base || !fs.existsSync(base)) return Object.assign({}, blank, { message: '代码目录不存在' });

  const enableAssertion = opts.enableAssertion !== false;
  const wanted = normalizeRuleIds(opts.ruleIds);
  const ruleIds = RULES.filter(
    (r) => r.pack === 'audit' && (!wanted || wanted.has(r.id)) && (enableAssertion || r.category !== 'assert')
  ).map((r) => r.id);

  if (!ruleIds.length) {
    return Object.assign({}, blank, { ok: true, message: '没有启用任何规则' });
  }

  const stats = { truncatedFiles: false, skippedSize: 0 };
  const files = collectFiles(base, MAX_FILES, stats);
  const issues = [];
  let suppressed = 0;
  let overflow = false;

  for (const file of files) {
    const code = readSafe(file);
    if (!code) continue;
    const res = matchRules(code, file, ruleIds);
    suppressed += res.suppressed;
    for (const h of res.hits) {
      if (issues.length >= MAX_ISSUES) {
        overflow = true;
        break;
      }
      issues.push(hitToIssue(h, file));
    }
  }

  const summary = { high: 0, medium: 0, low: 0, total: issues.length };
  for (const it of issues) summary[it.severity] += 1;

  // 按严重程度排序（高 → 低），同级按文件/行号稳定排列
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      String(a.file).localeCompare(String(b.file)) ||
      a.line - b.line
  );

  /**
   * 截断原因必须说清楚：用户看到「问题数偏少」时要知道为什么，
   * 否则会以为工具只扫了这么点（这也是「不能静默丢弃」的一部分）。
   */
  const reasons = [];
  if (stats.truncatedFiles) reasons.push(`文件数达到上限 ${MAX_FILES} 个`);
  if (stats.skippedSize) reasons.push(`${stats.skippedSize} 个文件超过 1MB 被跳过`);
  if (suppressed) reasons.push(`同一规则在同一文件最多记 ${MAX_HITS_PER_RULE} 条，另有 ${suppressed} 条未列出`);
  if (overflow) reasons.push(`问题总数达到上限 ${MAX_ISSUES} 条`);

  return {
    ok: true,
    issues,
    summary,
    scannedFiles: files.length,
    suppressed,
    truncated: reasons.length > 0,
    truncatedReason: reasons.join('；'),
    rulesRun: ruleIds
  };
}

module.exports = {
  collectFiles,
  scanAssertionQuality,
  extractPaths,
  normalizePath,
  pathMatches,
  buildCoverage,
  scanHardcoded,
  RULES,
  MAX_FILES,
  MAX_ISSUES,
  MAX_FILE_SIZE,
  MAX_HITS_PER_RULE,
  SCAN_EXTS,
  SKIP_DIRS
};