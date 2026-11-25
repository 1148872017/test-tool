'use strict';
/**
 * 代码高亮（纯函数 / 零依赖 / 零 Node 依赖，前端可以直接 import）
 *
 * ============================================================
 * 为什么要自己写，而不是引一个现成库
 * ============================================================
 * 1. 这是一个**纯本地、单机**的工具，打包体积和「不联网装依赖」都是硬约束；
 * 2. 只需要 7 种语言（java / python / json / xml(jmx) / sql / bash+powershell / groovy），
 *    引一个 200 KB 的通用高亮器，99% 的词表用不上；
 * 3. 高亮结果要能直接喂给 React 渲染（[{type, text}]），不需要 HTML 字符串，
 *    也就不需要 innerHTML / 转义那一圈（少了 XSS 面）。
 *
 * ============================================================
 * 设计要点（改之前先看这三条）
 * ============================================================
 * 1. **单趟字符扫描，不用「整段当字符串匹配」的大正则。**
 *    早期想法是 /(["'])(?:\\.|(?!\1)[\s\S])*\1/ 这种整个文档扫一遍的正则，
 *    遇到未闭合引号会从第 1 个字符一路回溯到最后 —— 5 万字的 jmx 直接卡死。
 *    这里改成「一次遍历、每个 token 只切片一次」，复杂度严格 O(n)，
 *    未闭合字符串最多扫到行尾（或文档尾），不会回溯。
 *
 * 2. **状态机天然解决「串里不染色、注释里的引号不启新串」。**
 *    扫描到 // 就把整行吃到行尾，中间的 " ' 只是注释的一部分；
 *    扫描到引号就把串吃到闭合引号（含转义），中间的 public / select 只是串内容。
 *    这两点是测试重点盯的，别改成「先全文找关键字、再全文找字符串」那种反过来的顺序。
 *
 * 3. **token 只合并相邻同类**，输出里不会出现「一个字符一个 token」的爆炸结果，
 *    React 那边渲染的 span 数 ≈ 语法要素数，不是字符数。
 *
 * ============================================================
 * 对外接口
 * ============================================================
 *   highlight(code, lang)  → [{ type, text }]
 *     type ∈ keyword | string | comment | number | func | tag | attr | punct | plain
 *     lang 省略 / 'auto' / 不认识  → 用 detectLang 自动识别
 *     任何异常都退化成 [{ type:'plain', text: 原文 }]，绝不抛错
 *
 *   detectLang(code)       → 'java' | 'python' | 'json' | 'xml' | 'sql' |
 *                            'bash' | 'powershell' | 'groovy' | 'plain'
 */

/** token 类型（改这里要同步改 src/styles.css 里 .code-block-tok.is-* 的配色） */
const TOKEN_TYPES = ['keyword', 'string', 'comment', 'number', 'func', 'tag', 'attr', 'punct', 'plain'];

/** 词表：空格分隔的字符串 → Set（查找 O(1)，比数组 includes 快一档） */
function words(str) {
  const set = new Set();
  for (const w of str.split(/\s+/)) {
    if (w) set.add(w);
  }
  return set;
}

/* ============================================================
 * 词表
 *
 * 说明：
 *   - SQL / PowerShell 大小写不敏感，词表统一存小写，查的时候先 toLowerCase；
 *   - 「函数名」不靠词表，靠「标识符后面跟 (」判断，所以词表里别塞 COUNT / NOW
 *     这类既像关键字又像函数的东西 —— 塞了就永远只会显示成关键字。
 * ============================================================ */
const KW_JAVA = words(`
  abstract assert boolean break byte case catch char class const continue default do double else enum
  extends final finally float for goto if implements import instanceof int interface long native new
  package private protected public return short static strictfp super switch synchronized this throw
  throws transient try var void volatile while yield record sealed permits
  true false null
`);

const KW_PYTHON = words(`
  False None True and as assert async await break class continue def del elif else except finally for
  from global if import in is lambda nonlocal not or pass raise return try while with yield match case
  self cls
`);

/**
 * Groovy：词表兼容 python 的常见词（用户明确说过可以这么干：两者都是脚本写法），
 * 再补 groovy 自己的 def / println / it 这一批。
 */
const KW_GROOVY = words(
  'def class interface enum trait package import as assert break case catch continue default do else ' +
    'extends finally for if implements instanceof new return switch this throw throws try while ' +
    'true false null it String int long boolean double void println print ' +
    'False None True and is not or in lambda pass raise yield with from global del'
);

/** SQL：不区分大小写，全部小写存；故意不含 count/sum/ifnull 这类函数名 */
const KW_SQL = words(`
  select from where insert into values update set delete create table drop alter add column primary key
  foreign references index unique not null default and or in like between is as join left right inner
  outer cross group by order having limit offset union all distinct exists view if begin commit rollback
  transaction asc desc on using case when then else end cast
`);

const KW_BASH = words(`
  if then else elif fi for while until do done case esac function return in export local readonly declare
  echo printf cd ls cp mv rm rmdir mkdir cat grep sed awk curl wget source eval exec exit shift trap set
  unset test sudo chmod chown touch head tail sort uniq wc find xargs tee kill ps
`);

const KW_POWERSHELL = words(`
  param begin process end dynamicparam function filter return if elseif else switch foreach for while do
  until try catch finally throw break continue class enum using namespace
  get-childitem write-host get-content set-content add-content copy-item move-item remove-item
  invoke-webrequest invoke-restmethod start-process stop-process new-object test-path join-path
  split-path select-object where-object foreach-object get-process get-service get-date out-file
  true false null
`);

/** JSON 只有字面量算关键字；键名走 attr */
const KW_JSON = words('true false null');

/* ============================================================
 * 标点集合
 *
 * 标点是「扫到就吐一个 token」的最短路径，但不能乱塞：
 *   - bash 的 - 留给 --flag（attr），@ 留给 $@；
 *   - java 的 @ 留给注解（attr）；
 *   - json 只认结构符号，其它一律 plain（JSON 里没有运算符）。
 * ============================================================ */
const PUNCT_C = new Set('(){}[];,.:?!<>=+-*/%&|^~'.split(''));
const PUNCT_SQL = new Set('(),;.*=<>+-/%'.split(''));
const PUNCT_SH = new Set('|&;()<>{}[]=!*?'.split(''));
const PUNCT_JSON = new Set('{}[],:'.split(''));

/* ============================================================
 * 语言配置
 *
 * triple      —— 支持三引号（java 文本块 / python / groovy）
 * atAttr      —— @Test 这类注解算 attr
 * dollarVar   —— $HOME / ${VAR} 算 attr（bash / powershell）
 * dashFlag    —— --remote-debugging-port / -ErrorAction 算 attr
 * hashBoundary—— '#' 只有在行首或空白后才算注释（bash 的 echo a#b 是普通文本）
 * rawSingle   —— 单引号里反斜杠不转义（bash）
 * doubleQuoteEscape —— SQL 的 '' 表示一个单引号
 * jsonKeys    —— 键名（后面跟 : 的字符串）算 attr
 * ============================================================ */
const CFG = {
  java: {
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: '"\'',
    triple: true,
    atAttr: true,
    keywords: KW_JAVA,
    punct: PUNCT_C
  },
  groovy: {
    lineComment: ['//'],
    blockComment: [['/*', '*/']],
    quotes: '"\'',
    triple: true,
    atAttr: true,
    keywords: KW_GROOVY,
    punct: PUNCT_C
  },
  python: {
    lineComment: ['#'],
    quotes: '"\'',
    triple: true,
    atAttr: true,
    keywords: KW_PYTHON,
    punct: PUNCT_C
  },
  sql: {
    lineComment: ['--', '#'],
    blockComment: [['/*', '*/']],
    quotes: '\'"',
    doubleQuoteEscape: true,
    ci: true,
    keywords: KW_SQL,
    punct: PUNCT_SQL
  },
  bash: {
    lineComment: ['#'],
    hashBoundary: true,
    quotes: '"\'',
    rawSingle: true,
    dollarVar: true,
    dashFlag: true,
    keywords: KW_BASH,
    punct: PUNCT_SH
  },
  powershell: {
    lineComment: ['#'],
    // PowerShell 的块注释是 <# #>，少见但真存在；顺手支持掉，扫到就吃到 #>
    blockComment: [['<#', '#>']],
    quotes: '"\'',
    dollarVar: true,
    dashFlag: true,
    ci: true,
    keywords: KW_POWERSHELL,
    punct: PUNCT_SH
  },
  json: {
    quotes: '"',
    jsonKeys: true,
    keywords: KW_JSON,
    punct: PUNCT_JSON
  },
  xml: { xml: true },
  plain: { plain: true }
};

/** 语言别名：外面的调用方写 .jmx / ps1 / py 也要认 */
const ALIAS = {
  js: 'json',
  json5: 'json',
  jsonc: 'json',
  xml: 'xml',
  jmx: 'xml',
  html: 'xml',
  htm: 'xml',
  xsd: 'xml',
  plist: 'xml',
  svg: 'xml',
  java: 'java',
  jsp: 'java',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  hql: 'sql',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  bat: 'bash',
  cmd: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  powershell: 'powershell',
  groovy: 'groovy',
  gvy: 'groovy',
  gsh: 'groovy',
  text: 'plain',
  txt: 'plain',
  plain: 'plain',
  none: 'plain'
};

/**
 * 语言名归一化。
 * @param {any} lang
 * @returns {string} CFG 的 key，或 'auto'（不认识/没传 → 让 detectLang 说话）
 */
function normalizeLang(lang) {
  if (lang == null) return 'auto';
  const raw = String(lang).trim().toLowerCase().replace(/^\./, '');
  if (!raw || raw === 'auto' || raw === 'detect') return 'auto';
  if (ALIAS[raw]) return ALIAS[raw];
  if (CFG[raw]) return raw;
  // 不认识的语言名：交给自动识别，别硬当纯文本（否则 copy 出来的高亮突然全灰）
  return 'auto';
}

/* ============================================================
 * 字符判定
 * ============================================================ */
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isIdentStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isIdentChar(c) {
  return isIdentStart(c) || isDigit(c);
}
function isSpaceChar(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** 追加 token，相邻同类型直接并起来（减少 React 节点数） */
function addTok(out, type, text) {
  if (!text) return;
  const last = out.length ? out[out.length - 1] : null;
  if (last && last.type === type) {
    last.text += text;
    return;
  }
  out.push({ type: type, text: text });
}

/** 从 from 起找 marker，返回 marker 之后的绝对下标；找不到返回 n（不抛错） */
function endAfter(src, from, marker) {
  const idx = src.indexOf(marker, from);
  return idx < 0 ? src.length : idx + marker.length;
}

/** 跳过空白（含换行），返回第一个非空白下标 */
function skipSpace(src, from) {
  let i = from;
  const n = src.length;
  while (i < n && isSpaceChar(src.charCodeAt(i))) i++;
  return i;
}

/* ============================================================
 * 注释 / 字符串识别
 *
 * 两者都要在「普通扫描」之前判定：
 * 注释整行吃掉 → 行内的引号不会启新串；
 * 字符串吃到闭合引号 → 串内的关键字不会染色。
 * ============================================================ */
function commentAt(src, i, cfg) {
  const n = src.length;
  const lineComment = cfg.lineComment;
  if (lineComment) {
    for (let k = 0; k < lineComment.length; k += 1) {
      const mark = lineComment[k];
      if (!src.startsWith(mark, i)) continue;
      // bash：'#' 只有行首或空白后才算注释（echo a#b 里的 # 是普通字符）
      if (cfg.hashBoundary && mark === '#' && i > 0) {
        const prev = src.charCodeAt(i - 1);
        if (!isSpaceChar(prev)) continue;
      }
      let e = i + mark.length;
      while (e < n) {
        const c = src.charCodeAt(e);
        if (c === 10 || c === 13) break;
        e += 1;
      }
      return { end: e };
    }
  }
  if (cfg.blockComment) {
    for (let k = 0; k < cfg.blockComment.length; k += 1) {
      const pair = cfg.blockComment[k];
      if (!src.startsWith(pair[0], i)) continue;
      return { end: endAfter(src, i + pair[0].length, pair[1]) };
    }
  }
  return null;
}

function stringAt(src, i, cfg) {
  const n = src.length;
  const ch = src[i];
  if (!cfg.quotes || cfg.quotes.indexOf(ch) < 0) return null;

  // 三引号（python / groovy / java 文本块）：找不到闭合就吃到文档尾，不抛错
  if (cfg.triple && src.startsWith(ch + ch + ch, i)) {
    return { end: endAfter(src, i + 3, ch + ch + ch) };
  }

  // bash 单引号：反斜杠不转义
  const backslash = !(cfg.rawSingle && ch === '\'');
  let e = i + 1;
  while (e < n) {
    const c = src[e];
    if (c === '\\' && backslash) {
      e += 2;
      continue;
    }
    // 单行字符串遇到换行就收尾（未闭合也不许把后面几行全吞成字符串）
    if (c === '\n' || c === '\r') break;
    if (c === ch) {
      if (cfg.doubleQuoteEscape && src[e + 1] === ch) {
        e += 2;
        continue;
      }
      return { end: e + 1 };
    }
    e += 1;
  }
  return { end: e < n ? e : n };
}

/** 数字：0x1F / 1_000 / 1.5e-3 / 123L / 2.0d */
function readNumber(src, i) {
  const n = src.length;
  let e = i;
  const c0 = src.charCodeAt(i);
  const c1 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
  if (c0 === 48 && (c1 === 120 || c1 === 88)) {
    e = i + 2;
    while (e < n) {
      const c = src.charCodeAt(e);
      if (isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70) || c === 95) e += 1;
      else break;
    }
    return e;
  }
  while (e < n) {
    const c = src.charCodeAt(e);
    if (isDigit(c) || c === 95) e += 1;
    else break;
  }
  if (e < n && src[e] === '.') {
    e += 1;
    while (e < n && isDigit(src.charCodeAt(e))) e += 1;
  }
  if (e < n && (src[e] === 'e' || src[e] === 'E')) {
    let j = e + 1;
    if (j < n && (src[j] === '+' || src[j] === '-')) j += 1;
    if (j < n && isDigit(src.charCodeAt(j))) {
      e = j;
      while (e < n && isDigit(src.charCodeAt(e))) e += 1;
    }
  }
  // 类型后缀：10L / 2.0f / 100n
  if (e < n) {
    const c = src[e];
    if ('LlFfDdNn'.indexOf(c) >= 0) e += 1;
  }
  return e;
}

function readIdent(src, i) {
  const n = src.length;
  let e = i + 1;
  while (e < n && isIdentChar(src.charCodeAt(e))) e += 1;
  return e;
}

/** 标识符后面（跳过空白）是不是 '(' —— 是就当函数名 */
function nextIsParen(src, from) {
  const j = skipSpace(src, from);
  return j < src.length && src[j] === '(';
}

/** '-' 是否处在「可以起一个命令行参数」的位置（空白、行首或分隔符之后） */
function dashFlagBoundary(src, i) {
  if (i === 0) return true;
  const prev = src[i - 1];
  if (isSpaceChar(src.charCodeAt(i - 1))) return true;
  return '([{;,&|=+'.indexOf(prev) >= 0;
}

/* ============================================================
 * 通用扫描器（C 系 / SQL / shell / JSON 共用一套，靠 cfg 分叉）
 * ============================================================ */
function scanGeneric(src, cfg) {
  const n = src.length;
  const out = [];
  let i = 0;
  /** 当前「普通文本」这一段的起点：只有遇到真 token 时才切片 */
  let plainStart = 0;

  const flushPlain = (end) => {
    if (end > plainStart) addTok(out, 'plain', src.slice(plainStart, end));
  };

  while (i < n) {
    const c = src[i];
    const code = src.charCodeAt(i);

    // 1) 注释（最先判：注释里的引号绝不启新串）
    const cm = commentAt(src, i, cfg);
    if (cm) {
      flushPlain(i);
      addTok(out, 'comment', src.slice(i, cm.end));
      i = cm.end;
      plainStart = i;
      continue;
    }

    // 2) 字符串（串里的关键字绝不染色）
    const st = stringAt(src, i, cfg);
    if (st) {
      flushPlain(i);
      let type = 'string';
      if (cfg.jsonKeys) {
        const after = skipSpace(src, st.end);
        if (src[after] === ':') type = 'attr';
      }
      addTok(out, type, src.slice(i, st.end));
      i = st.end;
      plainStart = i;
      continue;
    }

    // 3) shell 变量：$HOME / ${JAVA_HOME} / $1 / $?
    if (cfg.dollarVar && c === '$') {
      const nxt = i + 1 < n ? src[i + 1] : '';
      if (nxt === '{') {
        const e = endAfter(src, i + 2, '}');
        flushPlain(i);
        addTok(out, 'attr', src.slice(i, e));
        i = e;
        plainStart = i;
        continue;
      }
      if (nxt && (isIdentChar(nxt.charCodeAt(0)) || '?#@*!$'.indexOf(nxt) >= 0)) {
        let e = i + 1;
        while (e < n && (isIdentChar(src.charCodeAt(e)) || '?#@*!$'.indexOf(src[e]) >= 0)) e += 1;
        flushPlain(i);
        addTok(out, 'attr', src.slice(i, e));
        i = e;
        plainStart = i;
        continue;
      }
    }

    // 4) shell 参数：--flag / -Xmx2g / -ErrorAction
    //    '-' 前面必须是空白或 ( | ; , = 之类的分隔符 —— 否则 Write-Host 会被拆成
    //    "Write" + "-Host"（半截染色比不染色更难看）
    if (cfg.dashFlag && c === '-' && dashFlagBoundary(src, i)) {
      let k = i + 1;
      while (k < n && src[k] === '-') k += 1;
      if (k > i + 1 || (k < n && isIdentStart(src.charCodeAt(k)))) {
        let e = k;
        while (e < n && (isIdentChar(src.charCodeAt(e)) || src[e] === '-')) e += 1;
        if (e > i + 1) {
          flushPlain(i);
          addTok(out, 'attr', src.slice(i, e));
          i = e;
          plainStart = i;
          continue;
        }
      }
    }

    // 5) 注解：@Test / @pytest.mark.parametrize（只认标识符开头，@ 后面跟别的不碰）
    if (cfg.atAttr && c === '@' && i + 1 < n && isIdentStart(src.charCodeAt(i + 1))) {
      const e = readIdent(src, i + 1);
      flushPlain(i);
      addTok(out, 'attr', src.slice(i, e));
      i = e;
      plainStart = i;
      continue;
    }

    // 6) 数字（前面必须是「非标识符」才起新 token；abc123 已在标识符里吃掉）
    if (isDigit(code)) {
      const end = readNumber(src, i);
      flushPlain(i);
      addTok(out, 'number', src.slice(i, end));
      i = end;
      plainStart = i;
      continue;
    }

    // 7) 标识符 → 关键字 / 函数名 / 普通
    if (isIdentStart(code)) {
      const end = readIdent(src, i);
      const word = src.slice(i, end);
      const key = cfg.ci ? word.toLowerCase() : word;
      let type = '';
      if (cfg.keywords && cfg.keywords.has(key)) type = 'keyword';
      else if (nextIsParen(src, end)) type = 'func';
      if (type) {
        flushPlain(i);
        addTok(out, type, word);
        i = end;
        plainStart = i;
        continue;
      }
      i = end;
      continue;
    }

    // 8) 标点：连着的标点并成一个 token（); 或 !=）
    if (cfg.punct && cfg.punct.has(c)) {
      let end = i + 1;
      while (end < n && cfg.punct.has(src[end])) end += 1;
      flushPlain(i);
      addTok(out, 'punct', src.slice(i, end));
      i = end;
      plainStart = i;
      continue;
    }

    // 9) 其它（空白 / 换行 / 未归类的符号）：留在 plain 流里
    i += 1;
  }

  flushPlain(n);
  return out;
}

/* ============================================================
 * XML（jmx）扫描器
 *
 * 单独一套，因为 XML 的结构是「标签 / 属性 / 文本」三种东西，
 * 用通用扫描器会把标签名当标识符、把属性名当普通词。
 *
 * 约定：
 *   <   </   >   />   ?>   =   → punct
 *   第一个名字（标签名）        → tag
 *   之后的名字（属性名）        → attr
 *   引号里的值                  → string
 *   <!-- -->                    → comment
 *   <![CDATA[ ... ]]>           → string（原样展示，别当标记）
 *   标签外的文本                → plain
 * ============================================================ */
function isXmlNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58;
}
function isXmlNameChar(c) {
  return isXmlNameStart(c) || isDigit(c) || c === 45 || c === 46;
}

function scanXml(src) {
  const n = src.length;
  const out = [];
  let i = 0;
  let plainStart = 0;

  const flushPlain = (end) => {
    if (end > plainStart) addTok(out, 'plain', src.slice(plainStart, end));
  };

  while (i < n) {
    // 注释
    if (src.startsWith('<!--', i)) {
      flushPlain(i);
      const e = endAfter(src, i + 4, '-->');
      addTok(out, 'comment', src.slice(i, e));
      i = e;
      plainStart = i;
      continue;
    }
    // CDATA：原样当字符串
    if (src.startsWith('<![CDATA[', i)) {
      flushPlain(i);
      const e = endAfter(src, i + 9, ']]>');
      addTok(out, 'string', src.slice(i, e));
      i = e;
      plainStart = i;
      continue;
    }
    // <!DOCTYPE ...>
    if (src.startsWith('<!', i)) {
      flushPlain(i);
      const e = endAfter(src, i + 2, '>');
      addTok(out, 'tag', src.slice(i, e));
      i = e;
      plainStart = i;
      continue;
    }

    if (src[i] !== '<') {
      // 标签外文本
      i += 1;
      continue;
    }

    // ---- 标签 ----
    flushPlain(i);
    let j = i + 1;
    let isClose = false;
    if (src[j] === '/') {
      isClose = true;
      j += 1;
    }
    addTok(out, 'punct', isClose ? '</' : '<');

    let firstName = true;
    if (src[j] === '?') {
      // <?xml ... ?>：'?' 单独一个 punct，后面 xml 还是 tag
      addTok(out, 'punct', '?');
      j += 1;
    }

    while (j < n) {
      // 跳过属性之间的空白 —— 必须作为 plain token **原样保留**，
      // 否则 <tg name="a"> 会变成 <tgname="a">（高亮把代码改了，这是最严重的 bug）
      if (isSpaceChar(src.charCodeAt(j))) {
        let e = j + 1;
        while (e < n && isSpaceChar(src.charCodeAt(e))) e += 1;
        addTok(out, 'plain', src.slice(j, e));
        j = e;
        continue;
      }
      if (j >= n) break;

      const c = src[j];
      if (c === '>') {
        addTok(out, 'punct', '>');
        j += 1;
        break;
      }
      if (c === '/' && src[j + 1] === '>') {
        addTok(out, 'punct', '/>');
        j += 2;
        break;
      }
      if (c === '?' && src[j + 1] === '>') {
        addTok(out, 'punct', '?>');
        j += 2;
        break;
      }
      if (c === '=') {
        addTok(out, 'punct', '=');
        j += 1;
        continue;
      }
      if (c === '"' || c === '\'') {
        let e = j + 1;
        while (e < n && src[e] !== c) e += 1;
        if (e < n) e += 1;
        addTok(out, 'string', src.slice(j, e));
        j = e;
        continue;
      }
      if (isXmlNameStart(src.charCodeAt(j))) {
        let e = j + 1;
        while (e < n && isXmlNameChar(src.charCodeAt(e))) e += 1;
        addTok(out, firstName ? 'tag' : 'attr', src.slice(j, e));
        firstName = false;
        j = e;
        continue;
      }
      // 标签里的其它字符（罕见）：当标点吐出去，保证不吞字符
      addTok(out, 'punct', c);
      j += 1;
    }

    i = j;
    plainStart = i;
  }

  flushPlain(n);
  return out;
}

/* ============================================================
 * 自动识别
 *
 * 只看前 4000 字符：够判断类型，又不至于把 5 万字整段扫一遍。
 * 顺序很重要（都是「宁可认错成 plain，也别把 python 认成 java」）：
 *   JSON → XML → SQL → Java → Groovy → Python → shell → plain
 * ============================================================ */
const DETECT_HEAD = 4000;

function detectLang(code) {
  const src = code == null ? '' : String(code);
  if (!src) return 'plain';
  const head = src.length > DETECT_HEAD ? src.slice(0, DETECT_HEAD) : src;
  const t = head.trim();
  if (!t) return 'plain';

  // JSON：{ / [ 开头且像键值结构
  if (t[0] === '{' || t[0] === '[') {
    if (/^\s*[[{]\s*("|}|\]|$)/.test(t) && /"[^"\n]*"\s*:/.test(t)) return 'json';
    if (/^\s*[[{]\s*(-?\d|"|true|false|null|\}|\])/.test(t) && !/;/.test(t) && !/<[A-Za-z]/.test(t)) return 'json';
  }

  // XML：<?xml / <Tag / <!--
  if (t[0] === '<') {
    if (/^<\?xml\b/i.test(t)) return 'xml';
    if (/^<!--/.test(t)) return 'xml';
    if (/^<![A-Za-z]/.test(t)) return 'xml';
    if (/^<\/?[A-Za-z_][\w.:-]*(\s|\/?>)/.test(t)) return 'xml';
  }

  // shell 的 shebang：最明确的信号，先收掉
  if (/^#!.*\b(?:ba|z|k)?sh\b/.test(t)) return 'bash';
  if (/^#!.*\bpwsh\b/i.test(t) || /^#!.*\bpowershell\b/i.test(t)) return 'powershell';

  // SQL：语句首词
  if (/^(select|insert|update|delete|create|drop|alter|truncate|with|grant|revoke)\b/i.test(t)) return 'sql';

  // Groovy（JMeter JSR223）：def + JMeter 内置对象，这个组合 java/python 都不会有，
  // 放在 java 之前判定 —— 脚本里常常贴了一段 java 示例字符串，先判 java 会认错
  if (/\bdef\s+[\w$]+\s*=/.test(t) && /\b(vars|prev|props|ctx|sampler)\s*\./.test(t)) return 'groovy';

  // Java：class/interface 声明、import java|org、System.out、@Test、main 方法
  if (/\bimport\s+(static\s+)?(java|javax|org|com)\.[\w.]+/.test(t)) return 'java';
  if (/^\s*package\s+[\w.]+\s*;/m.test(t)) return 'java';
  if (/\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|record)\b/.test(t)) return 'java';
  if (/\bSystem\.(out|err)\.print/.test(t)) return 'java';
  if (/@(Test|Override|Before\w*|After\w*|DataProvider|ParameterizedTest)\b/.test(t)) return 'java';
  if (/\bpublic\s+static\s+void\s+main\s*\(/.test(t)) return 'java';
  if (/^\s*(public|private|protected)\s+[\w<>\[\], ]+\s+\w+\s*\([^)]*\)\s*\{/m.test(t)) return 'java';

  // Groovy（JMeter JSR223 脚本）：def + JMeter 内置对象
  // 注意别把 log. 算进来：Java 代码里 log.info() 太常见，会把 java 认成 groovy
  if (/\b(vars|prev|props|ctx|sampler)\s*\.\s*\w+/.test(t)) return 'groovy';
  if (/import\s+org\.apache\.jmeter|import\s+groovy\.|javax\.script/.test(t)) return 'groovy';
  if (/^\s*def\s+\w+\s*=/m.test(t)) return 'groovy';

  // Python：def/class + 冒号、from x import、print(、@pytest、self.
  if (/^\s*def\s+\w+\s*\(/m.test(t)) return 'python';
  if (/^\s*(import|from)\s+[\w.]+\s*(import\b|$)/m.test(t)) return 'python';
  if (/^\s*print\s*\(/m.test(t)) return 'python';
  if (/@pytest|@fixture|if\s+__name__\s*==/.test(t)) return 'python';
  if (/\bself\.\w+/.test(t) || /:\s*$/m.test(t) && /^\s{2,}\S/m.test(t)) return 'python';

  // shell：命令风格 + PowerShell cmdlet
  if (/\b(Get-ChildItem|Write-Host|Invoke-WebRequest|Start-Process|param\s*\()/.test(t)) return 'powershell';
  if (/^(echo|export|cd|sudo|mvn|java\s+-jar|pytest|python|npm|node|git|curl|chmod)\b/m.test(t)) return 'bash';

  return 'plain';
}

/* ============================================================
 * 对外入口
 * ============================================================ */
/**
 * 把源码切成带类型的 token。
 *
 * @param {string} code  源码
 * @param {string} [lang] 语言（省略/auto/不认识 → 自动识别）
 * @returns {{type: string, text: string}[]} type ∈ TOKEN_TYPES
 */
function highlight(code, lang) {
  const src = code == null ? '' : String(code);
  if (!src) return [];

  let key = normalizeLang(lang);
  if (key === 'auto') key = detectLang(src);
  const cfg = CFG[key];
  if (!cfg) return [{ type: 'plain', text: src }];
  if (cfg.plain) return [{ type: 'plain', text: src }];

  try {
    return cfg.xml ? scanXml(src) : scanGeneric(src, cfg);
  } catch (e) {
    // 理论上到不了这里（扫描器不抛错），但高亮失败不该让整页白屏
    return [{ type: 'plain', text: src }];
  }
}

/* ============================================================
 * token 流辅助（给渲染层用，纯函数，方便单测）
 * ============================================================ */
/** 总行数：换行数 + 1（空 token 流也算 1 行） */
function countLines(tokens) {
  let n = 1;
  const list = tokens || [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i].text;
    for (let j = 0; j < t.length; j += 1) {
      if (t.charCodeAt(j) === 10) n += 1;
    }
  }
  return n;
}

/**
 * 只保留前 maxLines 行（给「超长折叠」用）。
 *
 * 关键点：保留的都是**原字符**（不做 trim、不加省略号），
 * 否则渲染出来的代码和源码就不一样了；截断点在第 maxLines 个换行符之前，
 * 所以结果里最多有 maxLines 行，且不会以换行结尾。
 *
 * @param {{type: string, text: string}[]} tokens
 * @param {number} maxLines
 */
function limitTokens(tokens, maxLines) {
  const list = tokens || [];
  const limit = Math.max(1, Math.floor(Number(maxLines)) || 1);
  const out = [];
  let newlines = 0;
  for (let k = 0; k < list.length; k += 1) {
    const t = list[k];
    let cut = -1;
    for (let j = 0; j < t.text.length; j += 1) {
      if (t.text.charCodeAt(j) === 10) {
        newlines += 1;
        if (newlines >= limit) {
          cut = j;
          break;
        }
      }
    }
    if (cut >= 0) {
      if (cut > 0) out.push({ type: t.type, text: t.text.slice(0, cut) });
      return out;
    }
    out.push(t);
  }
  return out;
}

module.exports = { highlight, detectLang, normalizeLang, countLines, limitTokens, TOKEN_TYPES };
