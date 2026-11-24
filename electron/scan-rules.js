'use strict';
/**
 * scan-rules.js —— 代码体检的规则表 + 匹配引擎。
 *
 * ============================================================
 * 设计约束
 * ============================================================
 * 1. **纯函数**：本文件不 require fs / electron，输入是「文件全文 + 路径」，
 *    输出是命中列表。所有规则都能脱离运行环境单测（scripts/test-rules.cjs）。
 *
 * 2. **只做正则，不做 AST**：目标是「找出可疑代码」，不是精确解析。
 *    误报/漏报的控制靠 `requires`（必须同时满足）和 `negative`（命中就跳过）
 *    两个前置条件，而不是语法分析。所以 UI 上必须写清楚「这是启发式检查」。
 *
 * 3. **注释里的代码不算问题**：`// Thread.sleep(3000)` 是说明不是缺陷。
 *    先把注释抹掉（带引号状态，`"https://a"` 里的 `//` 不能被截断），
 *    再拿「只剩代码的那一行」去匹配；但 snippet 取**原文那行**。
 *
 * 4. **snippet 只取命中行原文并截 200 字符**：扫的是用户私有代码，
 *    不能把整段带出去（也不落日志）。
 *
 * 5. **文档不按代码体检**：`ui-*` / `assert-*` / `cov-*` 不扫 .md/.txt
 *    （README 里写「div > div > div 很脆」是说明文字，报了用户会觉得工具在胡说），
 *    但 `sec-*` 必须扫（文档里出现真内网地址/口令才是要抓的）。
 */

const path = require('path');

/** 单条规则在一个文件里最多记几条（避免一个坏文件刷满整页） */
const MAX_HITS_PER_RULE = 3;

/** snippet 最大长度：只给命中行，且截断 */
const SNIPPET_MAX = 200;

/**
 * **只体检代码、不体检文档**的规则族。
 * 文档进扫描范围是为了 `sec-*`（文档里的内网地址/令牌），不是为了把 README 当测试代码。
 */
const CODE_ONLY_RULE_RE = /^(?:ui|assert|cov)-/;

/** 文档扩展名 */
const DOC_FILE_RE = /\.(?:md|txt)$/i;

/**
 * `#` 是注释起始的语言。
 * `.md` **不在此列**：`# 标题` 不是注释，标题里出现内网地址同样要报。
 */
const HASH_COMMENT_EXTS = /\.(?:py|pyw|sh|bash|zsh|rb|pl|yml|yaml|properties|conf|ini|txt|cfg)$/i;

/** 严重程度排序（高 → 低） */
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** 合法取值（规则表自检用） */
const SEVERITIES = ['high', 'medium', 'low'];
const PACKS = ['audit', 'coverage'];
const CATEGORIES = ['ui', 'secret', 'assert', 'coverage'];

/* ============================================================
 * 规则表
 *
 * id 一经发布不得改：UI 勾选、历史统计、白名单都按 id 记。
 * legacy 是老版本里对外出现过的 key（v0.41.2 的 issue.rule），
 * 只用于向后兼容输出，不参与任何过滤逻辑。
 * ============================================================ */

const RULES = [
  /* ---------------- ui：UI 自动化反模式 ---------------- */
  {
    id: 'ui-hard-sleep',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '硬编码等待',
    desc: '写死 sleep / waitForTimeout：慢机器上偶发失败，快机器上白等。改成显式等待（等元素可见/可点）或轮询条件。',
    legacy: 'sleep',
    pattern: /\b(?:Thread\s*\.\s*sleep|time\s*\.\s*sleep|waitForTimeout)\s*\(\s*\d+/
  },
  {
    id: 'ui-abs-xpath',
    pack: 'audit',
    category: 'ui',
    severity: 'low',
    title: '绝对 XPath',
    desc: '以 /html/body 开头的绝对路径，页面结构一变就整条失效。改用相对定位（//）或 data-testid。',
    legacy: 'absolute-xpath',
    pattern: /["'`]\s*\/html\/body\//i
  },
  {
    id: 'ui-deep-css',
    pack: 'audit',
    category: 'ui',
    severity: 'low',
    title: '深层 CSS 选择器',
    desc: '四级以上 a > b > c > d > e 对 DOM 层级高度敏感，加一层包裹就全挂。减少层级，或给关键节点加 data-testid。',
    legacy: 'deep-css',
    pattern: /["'`][a-z]+(?:\s*>\s*[a-z]+){4,}["'`]/i
  },
  {
    id: 'ui-fragile-locator',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '按下标定位',
    desc: '用 [n] / :nth-child 按下标取元素，列表里插一个节点就会错位。改用 data-testid 或稳定的业务属性。',
    // 只有「选择器语义」的行才算：业务代码里的 arr[0]、args[2] 不是定位问题
    pattern: /\[\s*\d+\s*\]|:nth-child\s*\(/,
    requires: /\/\/|By\s*\.|find_element|selector|xpath/i,
    negative: /data-testid|data-test|data-qa/i
  },
  {
    id: 'ui-text-locator',
    pack: 'audit',
    category: 'ui',
    severity: 'low',
    title: '按界面文案定位',
    desc: 'linkText / partialLinkText / By.text / text= 依赖界面文案，改个文案或被翻译就会挂。改用 data-testid。',
    /**
     * `text=` 这种写法在普通代码里也可能是 `String text = "..."` 赋值，
     * 所以要求同一行还有定位语义（By. / find_element / selector / cy. 等）才报。
     */
    pattern: /\b(?:linkText|partialLinkText|By\s*\.\s*text|text\s*=\s*)\s*\(?\s*["'`][^"'`]+["'`]/,
    requires: /By\s*\.|find_element|selector|locator|cy\s*\.|page\s*\.|driver\s*\./i
  },

  /* ---------------- secret：硬编码敏感信息 ---------------- */
  {
    id: 'sec-hardcoded-url',
    pack: 'audit',
    category: 'secret',
    severity: 'medium',
    title: '硬编码地址',
    desc: '把环境地址写进代码，换环境要改代码、提测/上线容易打错环境。改成配置或 ${变量} 占位。',
    legacy: 'hardcoded-url',
    pattern: /["'`]https?:\/\/[^"'\s]{6,}["'`]/i,
    negative: /localhost|127\.0\.0\.1|example\.(?:com|org|net)|placeholder|TODO|FIXME/i
  },
  {
    id: 'sec-token-literal',
    pack: 'audit',
    category: 'secret',
    severity: 'high',
    title: '硬编码令牌',
    desc: 'token / secret / apiKey 直接写字符串，提交进仓库即泄露。改成从环境变量或密钥管理读取。',
    legacy: 'hardcoded-token',
    pattern: /(?:token|api[_-]?key|secret|access[_-]?key)\s*[:=]\s*["'`][^"'`]{8,}["'`]/i
  },
  {
    id: 'sec-password-literal',
    pack: 'audit',
    category: 'secret',
    severity: 'high',
    title: '硬编码口令',
    desc: 'password / passwd / pwd 写成字面量，等于把测试账号公开。改成参数化或从配置注入。',
    legacy: 'hardcoded-password',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'`][^"'`]{3,}["'`]/i
  },
  {
    id: 'sec-intranet-ip',
    pack: 'audit',
    category: 'secret',
    severity: 'medium',
    title: '内网 IP 直连',
    desc: '10./192.168./172.16-31. 网段写死在脚本里，换环境即不可用，也会泄露内网拓扑。改用域名或环境变量。',
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
    negative: /localhost|127\.0\.0\.1|0\.0\.0\.0/
  },

  /* ---------------- assert：断言质量 ---------------- */
  {
    id: 'assert-status-only',
    pack: 'audit',
    category: 'assert',
    severity: 'medium',
    title: '只断言状态码',
    desc: '只校验 HTTP 状态码，不校验响应体：接口返回 200 但业务 code=500 时抓不到。补一条业务字段断言。',
    legacy: 'weak-assertion',
    /**
     * 方法级规则：在「一个测试方法体」范围内判定。
     *   pattern → 必须出现（只断言状态码的特征）
     *   absent  → 必须不出现（有没有校验 body）
     */
    scope: 'method',
    pattern: /\.statusCode\s*\(\s*\d{3}|assertEquals\s*\(\s*\w*[Ss]tatus\w*\s*,\s*\d{3}|status(?:_code)?\s*(?:==|===)\s*\d{3}|assert\s+\w+\.ok\b/,
    absent:
      /\.body\s*\(|\.jsonPath\s*\(|jsonPath\s*\(|resp(?:onse)?\.json\(\)|\.json\(\)\s*\[|assertR?[Ee]quals?\s*\(\s*\w+\.(?:json|body)|\.(?:hasSize|containsString|equalTo|notNullValue)\s*\(|expect\s*\([^)]*\)\s*\.\s*to(?:Be|Have|Contain)|assert\s+\w+\[\s*["']|assert\s+\w+\.(?:data|code|msg|result)\b|assert\s+.*\.json\(\)|\bgetBody\s*\(\s*\)\s*\./i,
    snippet: '只有状态码断言'
  },
  {
    id: 'assert-truthy-only',
    pack: 'audit',
    category: 'assert',
    severity: 'medium',
    title: '只判真假',
    desc: 'assert xxx 只是「有值/非空」，证明不了「值对」。补上具体字段与期望值的比较。',
    /**
     * 断言表达式后面直接收尾（行尾，或只剩一个分号）才算法布尔：
     * `assert resp` 报；`assert resp == 200`、`assert x in y`、`assert x is not None` 都不报。
     *
     * 收尾**只认行尾**，不认 `,` / `)`：
     *   - `assert isinstance(x, int)` 的 `,` 会让 `assert isinstance(x` 这个前缀被误判（实跑抓到）；
     *   - `assert resp.json()["code"]` 的 `)` 同理。
     * 代价是 `assert x, "消息"` 这种写法漏报——漏报比误报好，UI 也写明了会漏报。
     */
    pattern: /\bassert\s+[\w.$\[\]"'()]+(?=\s*;?\s*$)|\.toBeTruthy\s*\(\s*\)/
  },
  {
    id: 'assert-no-assertion',
    pack: 'audit',
    category: 'assert',
    severity: 'high',
    title: '断言缺失',
    desc: '测试方法里一条断言都没有：这条用例永远「通过」，等于没测。至少断一个状态码 + 一个业务字段。',
    /**
     * 方法级规则：Java 从 @Test 到下一个 @Test，Python 从 def test_ 到下一个顶格 def。
     * 方法体内找不到任何断言/校验就算缺失。
     * `pytest.raises` / `assertRaises` / `expectThrows` 也算断言机制（抛异常也是校验），别报成缺失。
     */
    scope: 'method',
    absent:
      /\bassert\w*\s*\(|\bassert\s+\w|\bexpect\s*\(|\bstatusCode\b|\bverify\w*\s*\(|\bAssert\w*\s*\(|pytest\.raises|assertRaises|expectThrows/i,
    snippet: '没有任何断言'
  },

  /* ---------------- coverage：覆盖取数（只抽路径原文） ---------------- */
  {
    id: 'cov-spring-mapping',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: 'Spring 映射路径',
    desc: '@GetMapping/@PostMapping/@RequestMapping 上的路径原文（RequestMapping 的 method 记 ANY）。',
    coverage: true,
    pattern:
      /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["'`](?<path>\/[^"'`]*)["'`]/
  },
  {
    id: 'cov-restassured',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: '链式客户端调用',
    desc: 'RestAssured / axios 一类的 .get("/x") / .post("/x") 链式调用，HTTP method 取自调用名。',
    coverage: true,
    pattern: /\.(?<method>get|post|put|delete|patch|head|options)\s*\(\s*["'`](?<path>[^"'`]*)["'`]/i
  },
  {
    id: 'cov-python-requests',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: 'Python requests 调用',
    desc: 'requests.get/post/put/delete("…")，路径可以是绝对 URL 或相对路径。',
    coverage: true,
    pattern: /\brequests\.(?<method>get|post|put|delete|patch)\s*\(\s*[fFrRbB]*["'`](?<path>[^"'`]+)["'`]/i
  },
  {
    id: 'cov-url-literal',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: '.url("/x") 字面量',
    desc: 'HttpRequest.url("/x") 这类显式设置路径的写法；method 不在这一行，记 ANY。',
    coverage: true,
    pattern: /\.url\s*\(\s*["'`](?<path>[^"'`]+)["'`]/
  },
  {
    id: 'cov-path-literal',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: '路径字面量',
    desc: '兜底：任何形如 "/api/..."、"/login" 的字符串字面量，以及 page.goto/navigate 的路径（method 记 ANY）。',
    coverage: true,
    pattern:
      /["'`](?<path>\/[A-Za-z0-9_\-\/{}.]+)["'`]|\.(?:goto|navigate)\s*\(\s*["'`](?<nav>[^"'`]+)["'`]/i
  }
];

const PACK_LABELS = { audit: '代码体检', coverage: '接口覆盖取数' };
const CATEGORY_LABELS = {
  ui: 'UI 自动化反模式',
  secret: '硬编码敏感信息',
  assert: '断言质量',
  coverage: '覆盖取数'
};

/** `codescan:rules` 直接把它给 UI（纯静态，不触盘） */
const SCAN_PACKS = PACKS.map((id) => ({
  id,
  label: PACK_LABELS[id],
  count: RULES.filter((r) => r.pack === id).length,
  rules: RULES.filter((r) => r.pack === id).map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    title: r.title,
    desc: r.desc
  }))
}));

/** 按 id 取规则 */
const ruleOf = (id) => RULES.find((r) => r.id === id) || null;

/**
 * 某个包（或全部）的规则摘要。
 * @param {string} [pack] 'audit' | 'coverage'；缺省 = 全部
 */
function rulesOf(pack) {
  const p = String(pack == null ? '' : pack);
  return RULES.filter((r) => !p || r.pack === p).map((r) => ({
    id: r.id,
    pack: r.pack,
    category: r.category,
    categoryLabel: CATEGORY_LABELS[r.category] || r.category,
    severity: r.severity,
    title: r.title,
    desc: r.desc,
    coverage: !!r.coverage
  }));
}

/**
 * 把外部传来的 ruleIds 归一成「规则 id 集合」。
 *
 * - 缺省 / 空数组 → `null`，表示「跑全部规则」（向后兼容：不传 ruleIds 行为不变）
 * - 传了 → 返回 Set；老版本 key（legacy）会被翻译成新 id，未知 id 直接忽略
 *
 * @param {string[]|undefined|null} ruleIds
 * @returns {Set<string>|null}
 */
function normalizeRuleIds(ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return null;
  const known = new Map();
  for (const r of RULES) {
    known.set(r.id, r.id);
    if (r.legacy) known.set(r.legacy, r.id);
  }
  const out = new Set();
  for (const raw of ruleIds) {
    const hit = known.get(String(raw));
    if (hit) out.add(hit);
  }
  return out;
}

/**
 * 抹掉注释，返回与输入**行数一致**的「只剩代码」的行数组。
 *
 * 为什么不用简单 replace：字符串里的 `//`（`"https://a"`）会被误当注释，
 * 于是「硬编码地址」这条最重要的规则反而永不命中。所以带引号状态 + 块注释 / 三引号状态。
 * 另外 URL 里的 `//`（文档里没有引号）也不算注释起点。
 *
 * @param {string} text
 * @param {string} [filePath] 决定 `#` 是不是注释起始（.py/.yml/.txt 等是，.java/.js 不是）
 * @returns {string[]}
 */
function stripComments(text, filePath) {
  const src = String(text == null ? '' : text);
  const hashIsComment = HASH_COMMENT_EXTS.test(String(filePath || ''));
  const lines = src.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let triple = '';

  for (const raw of lines) {
    let code = '';
    let quote = '';
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (triple) {
        const end = raw.indexOf(triple, i);
        if (end === -1) {
          i = raw.length;
          break;
        }
        triple = '';
        i = end + 3;
        continue;
      }
      const ch = raw[i];
      if (quote) {
        code += ch;
        if (ch === '\\') {
          // 转义字符原样带过（否则 "\"" 会错判引号结束）
          if (i + 1 < raw.length) {
            code += raw[i + 1];
            i += 2;
            continue;
          }
        } else if (ch === quote) {
          quote = '';
        }
        i += 1;
        continue;
      }
      if (raw.startsWith("'''", i) || raw.startsWith('"""', i)) {
        triple = raw.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (raw.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (raw.startsWith('//', i)) {
        // 协议分隔符不是注释：文档里 `见 http://10.1.2.3/x` 不能被截断，否则内网地址永远扫不到
        if (/(?:[A-Za-z][A-Za-z0-9+.\-]*:)$/.test(raw.slice(0, i))) {
          code += '//';
          i += 2;
          continue;
        }
        break;
      }
      if (hashIsComment && ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) break;
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        code += ch;
        i += 1;
        continue;
      }
      code += ch;
      i += 1;
    }
    out.push(code);
  }
  return out;
}

/** 是否是测试文件（启发式：有 @Test / def test_ / it( ...） */
function looksLikeTest(block) {
  return /@Test\b|def\s+test_|def\s+test[A-Z]|\bit\s*\(|public\s+void\s+test/i.test(block);
}

/**
 * 切「测试方法块」。
 *
 * 两种语言结束块的判定方式不同：
 *   Java / JS / Groovy → 大括号深度归零
 *   Python             → 缩进归零（没有大括号，用深度判断会提前截断）
 *
 * 边界判定用**原文**（缩进/注释行都算代码行），断言内容用**抹掉注释后**的行。
 *
 * @param {string[]} rawLines
 * @param {string[]} codeLines 与 rawLines 等长
 * @param {string} filePath
 * @returns {{start: number, end: number, methodName: string, code: string}[]}
 */
function splitTestBlocks(rawLines, codeLines, filePath) {
  const text = rawLines.join('\n');
  if (!looksLikeTest(text)) return [];
  const isPython =
    /\.py$/i.test(String(filePath || '')) || (/^\s*def\s+test/m.test(text) && !/[{}]/.test(text));

  const blocks = [];
  const startRe = /@Test\b|def\s+test_|def\s+test[A-Z]|public\s+void\s+test/i;
  let cur = null;
  let depth = 0;
  let baseIndent = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (!cur && startRe.test(line)) {
      cur = { start: i, end: i, depth: 0 };
      depth = 0;
      baseIndent = line.search(/\S/);
    }
    if (!cur) continue;
    cur.end = i;

    if (isPython) {
      const next = i + 1 < rawLines.length ? rawLines[i + 1] : null;
      const nextIsCode = next !== null && next.trim() !== '';
      const nextIndent = nextIsCode ? next.search(/\S/) : -1;
      const ended = !nextIsCode || nextIndent <= baseIndent;
      if (ended && cur.end - cur.start + 1 >= 2) {
        blocks.push(cur);
        cur = null;
      }
    } else {
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      const nextIsStart = i + 1 < rawLines.length && startRe.test(rawLines[i + 1]);
      if ((depth <= 0 && cur.end - cur.start + 1 > 2) || nextIsStart) {
        blocks.push(cur);
        cur = null;
      }
    }
  }
  if (cur) blocks.push(cur);

  const nameRe = /void\s+(\w+)\s*\(|def\s+(test\w+)|(?:it|test)\s*\(\s*['"`]([^'"`]+)/i;
  const fallbackRe = /(\w+)\s*\([^)]*\)\s*\{/;
  const blocks2 = [];
  for (const b of blocks) {
    const code = codeLines.slice(b.start, b.end + 1).join('\n');
    const sig = codeLines.slice(b.start, Math.min(b.end + 1, b.start + 6)).join('\n');
    const m = nameRe.exec(sig) || fallbackRe.exec(sig);
    /**
     * 认不出方法签名就丢掉。
     *
     * Java 里 `@Test` 和 `public void testX()` 都能当块起点，于是「只有一行 @Test」的
     * 残块也会被切出来；它没有方法体，报「断言缺失」是纯误报（实跑抓到的）。
     */
    if (!m) continue;
    blocks2.push({
      start: b.start,
      end: b.end,
      methodName: m[1] || m[2] || m[3] || '（未知方法）',
      code
    });
  }
  return blocks2;
}

/** coverage 规则命中后的 HTTP method 归一（只做大写，不做路径归一化） */
function methodOf(groups) {
  const raw = String((groups && (groups.method || groups.anno)) || '').trim();
  if (!raw) return 'ANY';
  if (/^request$/i.test(raw)) return 'ANY';
  return raw.toUpperCase();
}

/**
 * 在**一个文件**上跑规则表。
 *
 * @param {string} text 文件全文
 * @param {string} filePath 相对/绝对路径（只用来判断注释语法和文档扩展名，不读盘）
 * @param {string[]} [ruleIds] 只跑这些规则；缺省/空数组 = 跑全部
 * @param {{maxHits?: number}} [opts] `maxHits: 0` = 不设上限（覆盖取数用）
 * @returns {{ok: true, hits: any[], suppressed: number}}
 *          `line` 为 1-based；`snippet` 只含该行原文（≤200 字符）
 */
function matchRules(text, filePath, ruleIds, opts) {
  const src = String(text == null ? '' : text);
  const fp = String(filePath == null ? '' : filePath);
  const maxHits =
    opts && Number.isFinite(opts.maxHits) ? Math.max(0, Math.floor(opts.maxHits)) : MAX_HITS_PER_RULE;
  const wanted = normalizeRuleIds(ruleIds);
  if (wanted && wanted.size === 0) return { ok: true, hits: [], suppressed: 0 };

  const codeLines = stripComments(src, fp);
  const rawLines = src.split(/\r?\n/);
  const isDoc = DOC_FILE_RE.test(fp);
  const hits = [];
  let suppressed = 0;
  let blocks = null; // 方法级规则才需要切块，懒加载

  for (const rule of RULES) {
    if (wanted && !wanted.has(rule.id)) continue;
    // 扩展名守卫：ui-* / assert-* / cov-* 只体检代码，不体检文档
    if (isDoc && CODE_ONLY_RULE_RE.test(rule.id)) continue;

    if (rule.scope === 'method') {
      if (!blocks) blocks = splitTestBlocks(rawLines, codeLines, fp);
      let n = 0;
      for (const blk of blocks) {
        if (rule.pattern && !rule.pattern.test(blk.code)) continue;
        if (rule.absent && rule.absent.test(blk.code)) continue;
        if (maxHits > 0 && n >= maxHits) {
          suppressed += 1;
          continue;
        }
        hits.push({
          ruleId: rule.id,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          line: blk.start + 1,
          snippet: `${blk.methodName}() ${rule.snippet || ''}`.trim(),
          methodName: blk.methodName
        });
        n += 1;
      }
      continue;
    }

    let n = 0;
    for (let i = 0; i < codeLines.length; i += 1) {
      const line = codeLines[i];
      if (!line.trim()) continue;
      if (rule.negative && rule.negative.test(line)) continue;
      if (rule.requires && !rule.requires.test(line)) continue;
      const m = rule.pattern.exec(line);
      if (!m) continue;
      // 超过上限的命中不能静默消失：计数并回传给调用方
      if (maxHits > 0 && n >= maxHits) {
        suppressed += 1;
        continue;
      }
      const hit = {
        ruleId: rule.id,
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        line: i + 1,
        snippet: String(rawLines[i] == null ? '' : rawLines[i]).trim().slice(0, SNIPPET_MAX)
      };
      if (rule.coverage) {
        const g = m.groups || {};
        hit.method = methodOf(g);
        hit.path = String(g.path || g.nav || m[1] || '').slice(0, SNIPPET_MAX);
      }
      hits.push(hit);
      n += 1;
    }
  }

  hits.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line
  );
  return { ok: true, hits, suppressed };
}

/**
 * root 归属校验：`target` 是否落在 `root` 之内。
 *
 * 纯字符串 + path 归一化，不碰 fs（realpath 由调用方先做）。
 * 必须按路径分隔符比较：`C:\work\proj-evil` 不能被判成 `C:\work\proj` 的子路径。
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function isInsideRoot(root, target) {
  const r = String(root == null ? '' : root).trim();
  const t = String(target == null ? '' : target).trim();
  if (!r || !t) return false;
  const norm = (p) => {
    let s = path.resolve(p);
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  const nr = norm(r);
  const nt = norm(t);
  if (nt === nr) return true;
  const prefix = nr.endsWith(path.sep) ? nr : nr + path.sep;
  return nt.startsWith(prefix);
}

module.exports = {
  RULES,
  SCAN_PACKS,
  PACKS,
  CATEGORIES,
  CATEGORY_LABELS,
  PACK_LABELS,
  SEVERITIES,
  SEVERITY_ORDER,
  MAX_HITS_PER_RULE,
  SNIPPET_MAX,
  CODE_ONLY_RULE_RE,
  DOC_FILE_RE,
  ruleOf,
  rulesOf,
  normalizeRuleIds,
  stripComments,
  splitTestBlocks,
  matchRules,
  isInsideRoot
};