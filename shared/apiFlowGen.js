'use strict';
/**
 * 接口积木步骤 → 接口测试方法体（Java / Python）。
 *
 * ============================================================
 * 为什么和 shared/codegen.js 分开
 * ============================================================
 * codegen.js 顶部 require('ejs')，渲染进程（src/**）一 import 就把 ejs / fs 打进浏览器包。
 * 这个生成器只做字符串拼装，依赖只有零依赖的 apiActions.js，
 * 所以 ApiBricksPanel 能直接调用 —— 预览、测试、真实生成用的是同一份逻辑，不会各写一遍。
 *
 * ============================================================
 * 三个容易踩的点（都在下面代码里标了）
 * ============================================================
 * 1. `${name}` 必须换成**变量表达式**，不是字符串插值：
 *      Java   "Bearer ${token}" → "Bearer " + token
 *      Python "Bearer ${token}" → f'Bearer {token}'
 *    所以文本参数由生成器整体负责（含引号），模板不写引号（见 apiActions.js 的约定）。
 * 2. 只能引用**前面步骤已定义**的变量，否则宁可生成一句警告也不假装能跑。
 * 3. 接口快照（method/path/headers/body）在**选接口的那一刻**就抄进步骤里，
 *    生成时不再回查 apis 集合 —— 接口记录后来被改 / 被删，已存的流程照样生成得出来。
 *
 * @returns {{ code: string, imports: string[], warnings: string[], variables: Array<{name:string,fromStep:number,type:string}> }}
 */

const { actionById, isIdentifier } = require('./apiActions.js');

/** 方法体缩进：4 个空格，和 uiStepGen 生成的 Java 方法 / Python 模块保持一致 */
const INDENT = '    ';
/**
 * RestAssured 链式调用的相对缩进。
 * 渲染出来的每一行最后都会再加一层 INDENT（方法体缩进），所以这里只补 2 层，
 * 合计 12 空格 —— 和任务书里的样例对齐（given() 在 4，.header/.body 在 12）。
 */
const CHAIN = INDENT + INDENT;

/** 空 from 的兜底变量名：至少生成的是合法表达式，用户看警告去补 */
const FALLBACK_FROM = 'resp1';

/* ============================================================
 * 转义（引号由生成器负责，这里只管内容）
 * ============================================================ */

function escapeJava(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function escapePy(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** f-string 里字面的 { } 必须翻倍，否则会被当成占位符 */
function escapePyF(s) {
  return escapePy(s).replace(/\{/g, '{{').replace(/\}/g, '}}');
}

/* ============================================================
 * 变量引用：${name} 的拆解 / 解析
 * ============================================================ */

/**
 * 接口记录里的 header / body 习惯写 `{{token}}`（mustache），积木统一用 `${token}`。
 * 这里顺手兼容一下，用户从接口记录抄过来的文本不用手改。
 */
function normalizeRefs(text) {
  return String(text === undefined || text === null ? '' : text).replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    '${$1}'
  );
}

/** 把一段文本拆成「字面量 / 变量引用」交替的片段 */
function splitVars(text) {
  const src = normalizeRefs(text);
  const out = [];
  const re = /\$\{([^}]*)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ lit: src.slice(last, m.index) });
    out.push({ ref: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ lit: src.slice(last) });
  return out;
}

/** 只警告一次（同一个问题在 3 个步骤里出现不必刷屏） */
function warnOnce(ctx, msg) {
  if (ctx.warned.has(msg)) return;
  ctx.warned.add(msg);
  ctx.warnings.push(msg);
}

/**
 * 解析一个变量引用。
 * @returns {string|null} 能用的变量名；不合法 / 未定义返回 null（调用方降级成字面量）
 */
function resolveRef(ctx, rawName, stepNo) {
  const name = String(rawName === undefined || rawName === null ? '' : rawName).trim();
  if (!name) return null;
  if (ctx.bound.has(name)) return name;
  if (!isIdentifier(name)) {
    warnOnce(ctx, '第 ' + stepNo + ' 步引用了非法变量名「' + name + '」，已按普通文本处理');
    return null;
  }
  if (!ctx.vars.has(name)) {
    warnOnce(ctx, '第 ' + stepNo + ' 步引用了未定义的变量 ' + name + '（前面没有哪一步产生它）');
    return null;
  }
  return name;
}

/** 定义（或覆盖）一个变量，累进变量表 */
function defineVar(ctx, rawName, type, detail) {
  const name = String(rawName === undefined || rawName === null ? '' : rawName).trim();
  if (!name) return null;
  if (!isIdentifier(name)) {
    warnOnce(
      ctx,
      '变量名「' + name + '」不是合法的标识符（' + (ctx.lang === 'python' ? 'Python' : 'Java') + ' 里会报错）'
    );
  }
  const prev = ctx.vars.get(name);
  if (prev) {
    warnOnce(ctx, '变量名「' + name + '」在第 ' + prev.fromStep + ' 步已经定义过，第 ' + ctx.stepNo + ' 步会覆盖它');
    prev.fromStep = ctx.stepNo;
    prev.type = type || prev.type;
    prev.detail = detail || prev.detail;
    return name;
  }
  const rec = { name, fromStep: ctx.stepNo, type: type || 'string', detail: detail || '' };
  ctx.vars.set(name, rec);
  ctx.varList.push(rec);
  return name;
}

/* ============================================================
 * 字符串表达式
 * ============================================================ */

/** 相邻字面量合并；变量片段原样保留 */
function pushLit(segs, lit) {
  const text = String(lit === undefined || lit === null ? '' : lit);
  if (!text) return;
  const last = segs[segs.length - 1];
  if (last && last.expr === undefined) last.lit += text;
  else segs.push({ lit: text });
}

/** 文本 → 片段（变量已解析，解析不了的降级成字面量 `${name}`） */
function toSegs(text, ctx) {
  const segs = [];
  for (const p of splitVars(text)) {
    if (p.ref === undefined) {
      pushLit(segs, p.lit);
      continue;
    }
    const name = resolveRef(ctx, p.ref, ctx.stepNo);
    if (name) segs.push({ expr: name });
    else pushLit(segs, '${' + p.ref + '}');
  }
  return segs;
}

/** Java 字符串表达式：无变量 → "..."；有变量 → "Bearer " + token */
function javaStringExpr(text, ctx) {
  const segs = toSegs(text, ctx);
  if (!segs.length) return '""';
  if (segs.every((s) => s.expr === undefined)) {
    return '"' + escapeJava(segs.map((s) => s.lit).join('')) + '"';
  }
  const pieces = segs
    .filter((s) => s.expr !== undefined || s.lit !== '')
    .map((s) => (s.expr !== undefined ? s.expr : '"' + escapeJava(s.lit) + '"'));
  return pieces.length ? pieces.join(' + ') : '""';
}

/** Python 字符串表达式：无变量 → '...'；有变量 → f'Bearer {token}' */
function pyStringExpr(text, ctx) {
  const segs = toSegs(text, ctx);
  if (!segs.length) return "''";
  // 整段就是一个变量时直接给变量名（f'{x}' 多余，还会把数字变成字符串）
  if (segs.length === 1 && segs[0].expr !== undefined) return segs[0].expr;
  if (segs.every((s) => s.expr === undefined)) {
    return "'" + escapePy(segs.map((s) => s.lit).join('')) + "'";
  }
  const inner = segs
    .filter((s) => s.expr !== undefined || s.lit !== '')
    .map((s) => (s.expr !== undefined ? '{' + s.expr + '}' : escapePyF(s.lit)))
    .join('');
  return "f'" + inner + "'";
}

/* ============================================================
 * 字面量（断言期望值 / JSON body）
 * ============================================================ */

/** 数字参数：不是数字就退回默认值，并提示（不抛异常） */
function formatNumber(raw, fallback, ctx, label) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const n = Number(text);
  if (text !== '' && !Number.isFinite(n)) {
    warnOnce(ctx, '第 ' + ctx.stepNo + ' 步的「' + (label || '数字参数') + '」不是有效数字，已用 ' + fallback);
    return String(fallback);
  }
  return String(Number.isFinite(n) ? n : fallback);
}

/** 断言期望值：能当数字 / 布尔 / null 就裸写，否则加引号（0 → 0，ok → "ok"） */
function javaLiteralFromText(raw, ctx) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (/\$\{/.test(text)) return javaStringExpr(text, ctx);
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase();
  if (/^null$/i.test(text)) return 'null';
  if (/^".*"$/.test(text)) return text;
  return '"' + escapeJava(text) + '"';
}

function pyLiteralFromText(raw, ctx) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (/\$\{/.test(text)) return pyStringExpr(text, ctx);
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text;
  if (/^true$/i.test(text)) return 'True';
  if (/^false$/i.test(text)) return 'False';
  if (/^null$/i.test(text)) return 'None';
  if (/^"[^"]*"$/.test(text)) return "'" + escapePy(text.slice(1, -1)) + "'";
  if (/^'[^']*'$/.test(text)) return text;
  return "'" + escapePy(text) + "'";
}

/** JS 值 → Python 字面量（JSON body 转 dict 用；字符串里的 ${var} 照样变变量） */
function pyValue(v, ctx) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return pyStringExpr(v, ctx);
  if (Array.isArray(v)) return '[' + v.map((x) => pyValue(x, ctx)).join(', ') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return '{' + keys.map((k) => pyStringExpr(k, ctx) + ': ' + pyValue(v[k], ctx)).join(', ') + '}';
  }
  return pyStringExpr(String(v), ctx);
}

/* ============================================================
 * 接口快照展开
 * ============================================================ */

/** headers 既接受 [{k,v}]，也接受接口记录里的多行字符串 `K: V` */
function normalizeHeaders(raw) {
  const pick = (h, keys) => {
    for (const k of keys) {
      if (h && h[k] !== undefined && h[k] !== null) return String(h[k]);
    }
    return '';
  };
  if (Array.isArray(raw)) {
    return raw
      .map((h) => ({ k: pick(h, ['k', 'name', 'key']).trim(), v: pick(h, ['v', 'value']) }))
      .filter((h) => h.k);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(':');
        return i < 0 ? { k: l, v: '' } : { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() };
      })
      .filter((h) => h.k);
  }
  return [];
}

function tryJson(text) {
  const s = String(text === undefined || text === null ? '' : text).trim();
  if (!s || /^[{"']/.test(s) === false) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * 「调用接口」：按快照展开成一整段请求。
 *
 * Java 用 RestAssured 链式写法，Python 用 requests。
 * baseUrl 的落法两边不同（各有各的规矩）：
 *   Java   → given().baseUri("http://localhost:8080")，path 仍写相对路径
 *   Python → 代码顶部一行 BASE = 'http://localhost:8080'，请求写 f'{BASE}/api/login'
 */
function renderCall(step, ctx) {
  const p = (step && step.params) || {};
  const method = String(p.method || '').trim().toUpperCase() || 'GET';
  const rawPath = String(p.path || p.url || '').trim();
  const apiName = String(p.apiName || '').trim() || method + ' ' + rawPath;

  let comment = '调用接口：' + apiName;
  if (rawPath) comment += ' (' + method + ' ' + rawPath + ')';

  let asName = String(p.as === undefined || p.as === null ? '' : p.as).trim();
  if (!asName) {
    asName = 'resp' + ctx.stepNo;
    warnOnce(ctx, '第 ' + ctx.stepNo + ' 步「调用接口」没有填「响应存为变量」，已用 ' + asName);
  }
  defineVar(ctx, asName, 'response', method + ' ' + rawPath);

  if (!rawPath) {
    warnOnce(ctx, '第 ' + ctx.stepNo + ' 步「调用接口」缺少接口快照（method/path 为空），生成的请求没有地址');
  }

  const headers = normalizeHeaders(p.headers);
  const bodyText = String(p.body === undefined || p.body === null ? '' : p.body);
  const jsonBody = /^[\[{]/.test(bodyText.trim());
  const ctIdx = headers.findIndex((h) => h.k.toLowerCase() === 'content-type');
  const ctJson = ctIdx >= 0 && /json/i.test(headers[ctIdx].v);
  if (ctJson) headers.splice(ctIdx, 1);
  const useJsonCt = ctJson || jsonBody;

  if (ctx.lang === 'python') {
    const urlText = ctx.baseUrl ? '${BASE}' + rawPath : rawPath;
    const kwargs = [];
    if (headers.length) {
      const pairs = headers.map((h) => pyStringExpr(h.k, ctx) + ': ' + pyStringExpr(h.v, ctx));
      kwargs.push({ key: 'headers', expr: '{' + pairs.join(', ') + '}' });
    }
    if (bodyText) {
      const parsed = jsonBody ? tryJson(bodyText) : { ok: false };
      if (parsed.ok) {
        kwargs.push({ key: 'json', expr: pyValue(parsed.value, ctx) });
      } else {
        if (jsonBody) {
          warnOnce(ctx, '第 ' + ctx.stepNo + ' 步的 body 看起来是 JSON 但解析不了，Python 版本按字符串发送（data=...）');
        }
        kwargs.push({ key: 'data', expr: pyStringExpr(bodyText, ctx) });
      }
    }
    const call = 'requests.' + method.toLowerCase() + '(';
    const lines = [];
    if (!kwargs.length) {
      lines.push(asName + ' = ' + call + pyStringExpr(urlText, ctx) + ')');
    } else {
      lines.push(asName + ' = ' + call);
      lines.push(INDENT + pyStringExpr(urlText, ctx) + ',');
      kwargs.forEach((kw, i) => {
        lines.push(INDENT + kw.key + '=' + kw.expr + (i < kwargs.length - 1 ? ',' : ''));
      });
      lines.push(')');
    }
    return { comment, lines: lines.map((l) => INDENT + l) };
  }

  const lines = [];
  lines.push('Response ' + asName + ' = given()');
  if (ctx.baseUrl) lines.push(CHAIN + '.baseUri(' + javaStringExpr(ctx.baseUrl, ctx) + ')');
  if (useJsonCt) {
    ctx.usesContentType = true;
    lines.push(CHAIN + '.contentType(ContentType.JSON)');
  }
  for (const h of headers) {
    lines.push(CHAIN + '.header(' + javaStringExpr(h.k, ctx) + ', ' + javaStringExpr(h.v, ctx) + ')');
  }
  if (bodyText) {
    ctx.usesContentType = ctx.usesContentType || jsonBody;
    lines.push(CHAIN + '.body(' + javaStringExpr(bodyText, ctx) + ')');
  }
  lines.push('.when()');
  lines.push(CHAIN + '.' + method.toLowerCase() + '(' + javaStringExpr(rawPath, ctx) + ')');
  lines.push('.then()');
  lines.push(CHAIN + '.extract().response();');
  return { comment, lines: lines.map((l) => INDENT + l) };
}

/* ============================================================
 * 通用动作：模板替换
 * ============================================================ */

/** 一步的注释文字（Java `//`、Python `#`，前缀由调用方加） */
function stepComment(action, params) {
  const p = params || {};
  if (action.id === 'extract-json') return '提取变量：' + String(p.path || '') + ' → ' + String(p.as || '');
  if (action.id === 'extract-regex') return '提取变量（正则）→ ' + String(p.as || '');
  if (action.id === 'assert-status') return '断言状态码 ' + String(p.code === undefined ? '' : p.code);
  if (action.id === 'assert-json') return '断言 JSON：' + String(p.path || '') + ' == ' + String(p.value || '');
  if (action.id === 'assert-time') {
    return '断言响应时间 < ' + String(p.ms === undefined ? '' : p.ms) + 'ms';
  }
  if (action.id === 'set-var') return '设置变量 ' + String(p.name || '');
  return action.name;
}

/** 按 params 定义渲染模板（多行模板保留自身缩进，统一再加一层 INDENT） */
function renderTemplateAction(action, step, ctx) {
  const params = (step && step.params) || {};
  const tpl = String(action[ctx.lang] || '');
  const comment = stepComment(action, params);
  if (!tpl) return { comment, lines: [] };

  let text = tpl;
  for (const p of action.params || []) {
    const raw = params[p.key];
    const missing = raw === undefined || raw === null || String(raw).trim() === '';
    if (missing && p.required) {
      warnOnce(ctx, '动作「' + action.name + '」缺少「' + (p.label || p.key) + '」（第 ' + ctx.stepNo + ' 步）');
    }
    const value = missing ? (p.default === undefined ? '' : p.default) : raw;

    let repl;
    if (p.type === 'ident') {
      const name = String(value === undefined || value === null ? '' : value).trim();
      if (p.key === 'from') {
        repl = String(resolveRef(ctx, name || FALLBACK_FROM, ctx.stepNo) || name || FALLBACK_FROM);
      } else {
        if (name) defineVar(ctx, name, 'value', action.name);
        repl = name || 'tempVar';
      }
    } else if (p.type === 'number') {
      repl = formatNumber(value, p.default === undefined ? 0 : p.default, ctx, p.label || p.key);
    } else if (p.literal) {
      repl = ctx.lang === 'python' ? pyLiteralFromText(value, ctx) : javaLiteralFromText(value, ctx);
    } else {
      repl = ctx.lang === 'python' ? pyStringExpr(value, ctx) : javaStringExpr(value, ctx);
    }
    text = text.split('%' + p.key + '%').join(repl);
  }

  const left = text.match(/%[A-Za-z0-9_]+%/g);
  if (left) {
    warnOnce(ctx, '动作「' + action.name + '」的模板里有未定义的占位符：' + left.join('、'));
  }

  const lines = text.split('\n').map((l) => (l.trim() === '' ? '' : INDENT + l));
  return { comment, lines };
}

/* ============================================================
 * 命名工具
 * ============================================================ */

function snake(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * 测试类名（v0.65）：testOrderFlow → OrderFlowTest。
 *
 * 和 methodName 分开：方法名是 testOrderFlow，类名是 OrderFlowTest。
 * 用 camel/pascal 的直觉规则：去掉 test / test_ 前缀，再 PascalCase + Test。
 */
function flowClassName(input) {
  const explicit = String((input && input.testName) || '').trim() || 'testFlow';
  let base = explicit.replace(/^test_?/i, '');
  if (!base) base = 'Flow';
  const pascal = base
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return (pascal || 'Flow') + 'Test';
}

/**
 * 把「方法 + import 清单」包成真正能编译的文件（v0.65）。
 *
 * 和 uiStepGen.wrapAsFile 是同一个问题的同一套修法 ——
 * 接口积木以前也只交出去 `imports.join('\n') + '\n\n' + code`，
 * imports 是裸全限定名、code 是孤立方法，粘进 IDE 编译不过。
 *
 * ⚠️ **两门语言的处理不同，别统一**：
 *   · Java：TestNG 要求 @Test 在类里 → 补 package + import + class 包裹；
 *   · Python：这边的产物是**模块级函数**（`def test_xxx():` 且没有 self，
 *     用的是 requests 而不是 self.page）。pytest 直接收集顶层 test_ 函数即可，
 *     包进 class 反而变成「缺 self 参数」的错方法。
 */
function wrapAsFlowFile(o) {
  const lang = (o && o.lang) === 'python' ? 'python' : 'java';
  const code = String((o && o.code) || '');
  if (!code.trim()) return '';
  const imports = Array.isArray(o.imports) ? o.imports.filter(Boolean) : [];
  const className = String((o && o.className) || 'FlowTest');
  const pkg = String((o && o.packageName) || '').trim();

  if (lang === 'java') {
    const importLines = imports.map((i) => 'import ' + i + ';');
    const head = [];
    if (pkg) head.push('package ' + pkg + ';', '');
    if (importLines.length) head.push.apply(head, importLines.concat(['']));
    const body = code
      .split('\n')
      .map((l) => (l.trim() === '' ? '' : '    ' + l))
      .join('\n');
    // head 已以空串结尾，再补一个换行才是「import 块 + 空行 + class」
    return head.join('\n') + '\npublic class ' + className + ' {\n\n' + body + '\n}\n';
  }

  // Python：implicitly 模块级函数 —— 只补 imports，**不包 class**
  const head = imports.length ? imports.join('\n') + '\n\n' : '';
  return head + code + '\n';
}

/** 测试方法名：显式 testName 优先；Python 一律 test_ 开头 + 下划线 */
function methodName(input, lang) {
  const explicit = String((input && input.testName) || '').trim();
  const base = explicit || 'testFlow';
  if (lang === 'python') {
    const s = snake(base) || 'test_flow';
    return s.indexOf('test') === 0 ? s : 'test_' + s;
  }
  return isIdentifier(base) ? base : 'testFlow';
}

/* ============================================================
 * Python 辅助函数（assert-json / extract-json 共用）
 * ============================================================ */

const DIG_HELPER = [
  '',
  'def _dig(data, path):',
  '    """按 JSONPath 简写取值：$.a.b[0].c（不支持过滤/通配，断言够用）"""',
  '    cur = data',
  '    for part in str(path).replace("$", "").strip(".").split("."):',
  '        if not part:',
  '            continue',
  '        name, _, idx = part.partition("[")',
  '        if name:',
  '            cur = cur[name]',
  '        if idx:',
  '            cur = cur[int(idx.rstrip("]"))]',
  '    return cur'
].join('\n');

/* ============================================================
 * 生成入口
 * ============================================================ */

/**
 * @param {object} o
 *   steps    [{ actionId, params }]（call 的 params 里带接口快照）
 *   lang     'java' | 'python'
 *   baseUrl  可选，生成时拼在 path 前
 *   testName 可选，测试方法名
 * @returns {{ code: string, imports: string[], warnings: string[], variables: Array<{name:string,fromStep:number,type:string}> }}
 */
function generateApiFlow(o) {
  const input = o || {};
  const warnings = [];
  const lang = input.lang === 'python' ? 'python' : 'java';
  const rawSteps = Array.isArray(input.steps) ? input.steps.filter(Boolean) : [];

  if (!rawSteps.length) {
    return {
      code: '',
      imports: [],
      warnings: ['还没有选任何步骤：先点左边的积木加一步'],
      variables: []
    };
  }

  const ctx = {
    lang,
    baseUrl: String(input.baseUrl || '').trim(),
    warnings,
    warned: new Set(),
    /** 变量名 → {name, fromStep, type} */
    vars: new Map(),
    /** 定义顺序（同名覆盖时不动位置，只更新记录） */
    varList: [],
    /** 不是「流程变量」但代码里可用（BASE 这类由生成器自己定义的常量） */
    bound: new Set(),
    usesContentType: false,
    usesDig: false,
    /** 当前第几步（1 开始），算进注释和警告 */
    stepNo: 0
  };
  if (lang === 'python' && ctx.baseUrl) ctx.bound.add('BASE');

  const body = [];
  const usedIds = [];
  let hasCall = false;

  const pushBlank = () => {
    if (body.length && body[body.length - 1] !== '') body.push('');
  };

  for (const step of rawSteps) {
    ctx.stepNo += 1;
    const action = actionById(step && step.actionId);
    if (!action) {
      warnOnce(ctx, '不认识的动作「' + String((step && step.actionId) || '') + '」，已跳过');
      continue;
    }
    usedIds.push(action.id);
    if (action.id === 'call') hasCall = true;
    if (action.id === 'extract-json' || action.id === 'assert-json') ctx.usesDig = true;

    const rendered = action.id === 'call' ? renderCall(step, ctx) : renderTemplateAction(action, step, ctx);

    pushBlank();
    // 注释前缀：Java 用 //，Python 用 #
    body.push(INDENT + (lang === 'python' ? '# ' : '// ') + ctx.stepNo + '. ' + rendered.comment);
    for (const line of rendered.lines) body.push(line);
  }

  if (!hasCall) {
    warnOnce(ctx, '流程里没有「调用接口」，生成的代码不会发请求');
  }

  /* ---------- 拼方法 ---------- */
  const lines = [];
  const method = methodName(input, lang);

  if (lang === 'python') {
    if (ctx.baseUrl) {
      lines.push("BASE = '" + escapePy(ctx.baseUrl) + "'");
      lines.push('');
    }
    lines.push('def ' + method + '():');
  } else {
    lines.push('@Test');
    lines.push('public void ' + method + '() {');
  }
  lines.push.apply(lines, body);
  if (lang === 'java') lines.push('}');
  if (lang === 'python' && ctx.usesDig) lines.push(DIG_HELPER);

  /* ---------- import ---------- */
  const has = (id) => usedIds.indexOf(id) >= 0;
  const imports = [];
  if (lang === 'java') {
    // 这两条是「总是」：没有 Response 变量和 given() 什么都写不出来
    imports.push('io.restassured.response.Response');
    imports.push('static io.restassured.RestAssured.given');
    if (has('assert-json')) imports.push('static org.hamcrest.Matchers.equalTo');
    if (has('assert-header')) imports.push('static org.hamcrest.Matchers.equalTo');
    // v0.59：断言响应体包含某段文本（错误信息 / traceId）
    if (has('assert-body-contains')) imports.push('static org.hamcrest.Matchers.containsString');
    if (has('assert-time')) imports.push('static org.hamcrest.Matchers.lessThan');
    if (ctx.usesContentType) imports.push('io.restassured.http.ContentType');
    if (has('extract-regex')) imports.push('java.util.regex.*');
  } else {
    imports.push('import requests');
    if (has('extract-regex')) imports.push('import re');
  }

  const finalImports = Array.from(new Set(imports)).sort();

  /**
   * v0.65：同时给出完整文件（package + import + class 包裹）。
   * code 保持原样（很多测试逐字比对），复制 / 保存到文件用 fileCode。
   */
  const clsName = flowClassName(input);
  const fileCode = wrapAsFlowFile({
    code: lines.join('\n'),
    imports: finalImports,
    className: clsName,
    packageName: input.packageName,
    lang
  });

  return {
    code: lines.join('\n'),
    /** 完整可编译文件；空步骤时为 '' */
    fileCode,
    /** 推导出来的测试类名 */
    testClassName: clsName,
    imports: finalImports,
    warnings,
    variables: ctx.varList.map((v) => ({ name: v.name, fromStep: v.fromStep, type: v.type }))
  };
}

module.exports = {
  generateApiFlow,
  flowClassName,
  wrapAsFlowFile,
  // 拆出来给单测 / 前端复用（不重复实现一遍转义和引用解析）
  splitVars,
  normalizeRefs,
  escapeJava,
  escapePy,
  isIdentifier,
  methodName
};