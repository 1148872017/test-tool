'use strict';
/**
 * jmx-writeback.js —— jmx 局部编辑写回（L2）
 *
 * ============================================================
 * 为什么单独一个模块（闸 1）
 * ============================================================
 * 这是本平台第一个「往用户资产里写」的功能。底线 #4（只读优先）不是被取消，
 * 而是被四道闸收紧了：
 *   闸 1：**只有本文件**允许改写已有的 .jmx。jmx.js / ipc-jmx.js 一律只读；
 *   闸 2：显式字段白名单（见 EDITABLE_FIELDS），白名单外一律 NOT_EDITABLE；
 *   闸 3：写盘前在同目录生成 sidecar 备份 <原文件名>.bak-<yyyyMMdd-HHmmss>，
 *         再用 tmp + fsync + rename 原子替换；写成功之后再按保留策略
 *         只留最近 KEEP_BACKUPS(10) 份本文件的备份（只删本文件的、失败不影响写回）；
 *   闸 4：scripts/test-jmx-writeback.cjs（golden test）守着「只改目标值那几个字节」。
 *
 * ============================================================
 * 为什么不重新序列化 XML（最容易犯的错）
 * ============================================================
 * 用 xmldom 解析再序列化，会把属性顺序、缩进、自闭合写法（<hashTree/>）、
 * 换行（CRLF/LF）全部「规范化」——用户文件会整份变脏，diff 里几千行噪音，
 * 下一次他根本不敢再用这个功能。
 *
 * 本文件的做法：
 *   1. 把文件读成 Buffer；
 *   2. 扫描原文，**只定位到「值的那几个字节」**（stringProp 标签之间的区间）；
 *   3. 用 Buffer.concat 把 [前缀][新值][后缀] 拼回去，其余字节一个不动。
 * 所以 CRLF、缩进、属性顺序、注释、BOM 都原样保留。
 *
 * 扫描用 `buf.toString('latin1')`：UTF-8 的多字节序列里不会出现 ASCII 的
 * `<` `>` `"` `/`，所以 latin1 字符串的下标 == 原文件的**字节偏移**，
 * 定位后直接拿 Buffer.slice 取字节，不会被解码/再编码破坏。
 *
 * ============================================================
 * 定位规则（别改成全文正则）
 * ============================================================
 *   · 线程组：按 <ThreadGroup / <SetupThreadGroup / <PostThreadGroup 到各自结束标签切块，
 *     三类**按全文出现顺序合并编号**（index 与 jmx.js 的 threadGroups 顺序一致：
 *     都是深度遍历时遇到哪个就 push 哪个）。标签按词边界匹配，
 *     <ThreadGroupX 不算，</SetupThreadGroup> 也不会被当成 </ThreadGroup>；
 *   · LoopController.loops 在文件里会出现多次（线程组主控制器 + 各种循环控制器），
 *     所以 only 在「该线程组内 name="ThreadGroup.main_controller" 的 elementProp」里找，
 *     不按全文匹配 prop 名；
 *   · 响应断言：按 <ResponseAssertion ...> 到 </ResponseAssertion> 切块，
 *     只改该块内 Asserion.test_strings（JMeter 官方拼写就少一个 t）的第一条值。
 *
 * ============================================================
 * 乐观锁
 * ============================================================
 * detail 返回 stamp = `<mtimeMs>:<size>`；writeback 前重新 stat，不一致回 STALE
 * 且不写盘。stamp 不是安全边界，只用来防「详情打开后文件被 JMeter 另存 / 被同事改过」。
 */

const fs = require('fs');
const path = require('path');

/** 单次最多 50 条修改（防渲染进程序列化一整份文件过来） */
const MAX_EDITS = 50;
/** 断言值长度上限（字符数） */
const MAX_ASSERTION_LEN = 500;
/** 线程数 / 爬坡 / 循环的整数范围（产品口径，含端点） */
const INT_MIN = 1;
const INT_MAX = 1000000;
/** JMeter 的「永久循环」：LoopController.loops = -1（勾了 infinite 时 JMeter 就写 -1） */
const LOOP_FOREVER = -1;
/** 爬坡允许 0（JMeter 本身允许「不爬坡，立刻全部启动」） */
const RAMPUP_MIN = 0;
/** 超过这个大小的文件不在「局部编辑」范围内（detail 也用同一个口径） */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 备份保留策略的**默认值**（用户拍板：默认只留最近 10 份）。
 *
 * 真正的份数由设置项 `backupKeep` 决定，调用方通过 writeback 的第 4 个参数传进来，
 * 和 backups/ 下每日备份共用同一个数（见 store.js 的 setBackupKeep）。
 * 这里的常量只在「调用方没传」时兜底（例如直接调模块的老测试）。
 *
 * 只清理「本文件的」备份：名字必须严格等于
 *   <本文件 basename>.bak-<yyyyMMdd-HHmmss>[-<n>]
 * 同目录下别的 jmx 的备份、用户自己命名的 *.bak-* 一律不碰（见 listBackups）。
 */
const KEEP_BACKUPS = 10;
const KEEP_MIN = 1;
const KEEP_MAX = 100;

/** 把设置里来的份数收成 1..100 的整数；非法值回默认（绝不能变成 0 = 全删） */
function clampKeep(value) {
  const n = Math.floor(Number(value));
  if (!isFinite(n) || n <= 0) return KEEP_BACKUPS;
  return Math.max(KEEP_MIN, Math.min(KEEP_MAX, n));
}

/**
 * 线程组的三种标签 → 契约里的 type。
 *
 * 顺序不影响 index：三者要按**全文出现位置**合并排序后再编号，
 * 这样 index 才和 jmx.js 里 threadGroups 的顺序（深度遍历遇到即 push）一致。
 */
const THREAD_GROUP_TAGS = [
  { tag: 'ThreadGroup', type: 'thread' },
  { tag: 'SetupThreadGroup', type: 'setup' },
  { tag: 'PostThreadGroup', type: 'teardown' }
];
const ASSERTION_TAG = 'ResponseAssertion';
const MAIN_CONTROLLER_NAME = 'ThreadGroup.main_controller';
const LOOP_PROP = 'LoopController.loops';
/** JMeter 源码里的历史拼写：Asserion（少一个 t），不要「修」它，否则定位不到 */
const ASSERTION_COLLECTION = 'Asserion.test_strings';
const PROP_TAGS = ['stringProp', 'intProp', 'longProp'];

/**
 * 闸 2：显式字段白名单（唯一事实源）
 *
 * 键是前端契约里的 field，值是 jmx 里的 prop 名。
 * 想加字段必须改这里 + 写测试；「顺手多支持一个」就是闸失效的开始。
 */
const EDITABLE_FIELDS = {
  thread: {
    numThreads: 'ThreadGroup.num_threads',
    rampUp: 'ThreadGroup.ramp_time',
    loops: LOOP_PROP
  },
  assertion: {
    value: ASSERTION_COLLECTION
  }
};

/**
 * 线程组三个字段各自的合法区间（唯一事实源；错误信息也从这里取 desc）。
 *
 *   numThreads  1..1000000
 *   rampUp      0..1000000   （JMeter 允许 ramp=0：不爬坡，立刻起满）
 *   loops       -1（永久循环）或 1..1000000
 *
 * loops 不是「连续区间」：0 非法、-1 合法、-2 以下非法，所以用断言函数而不是 min/max。
 * 注意 loops 的 -1 只是**值**合法；写回时仍只落在该线程组的 main_controller 里
 * （见 scanDocument 的 findMainController），不会碰到别处的循环控制器。
 */
const THREAD_VALUE_RULE = {
  numThreads: { test: (n) => n >= INT_MIN && n <= INT_MAX, desc: INT_MIN + '..' + INT_MAX },
  rampUp: { test: (n) => n >= RAMPUP_MIN && n <= INT_MAX, desc: RAMPUP_MIN + '..' + INT_MAX },
  loops: { test: (n) => n === LOOP_FOREVER || (n >= INT_MIN && n <= INT_MAX), desc: LOOP_FOREVER + '（永久循环）或 ' + INT_MIN + '..' + INT_MAX }
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function fail(code, message) {
  return { ok: false, code, message };
}

function errMsg(e) {
  return String((e && e.message) || e || '未知错误');
}

function toBuf(raw) {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw == null ? '' : raw), 'utf8');
}

/** 文件字节 → 逐字节对应的 latin1 字符串（下标 == 字节偏移） */
function asScanText(buf) {
  return buf.toString('latin1');
}

/** 字节区间 → 解码后的字符串（xml 实体还原） */
function decodeXmlText(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, body) => {
    switch (body) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const n = body.charAt(1) === 'x' || body.charAt(1) === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(n);
        } catch (e) {
          return whole;
        }
      }
    }
  });
}

/** 值区间 → 可展示/可比较的字符串 */
function valueAt(buf, span) {
  return decodeXmlText(buf.slice(span.valueStart, span.valueEnd).toString('utf8'));
}

/**
 * XML 文本转义（只用于写进 stringProp 的「值」）。
 * `&` 必须转；`<` `>` 在值校验阶段已被拒绝（避免用户写出嵌套标签），
 * 这里仍然转义一次做纵深防御；`\r` 转成 &#13;，否则 XML 解析会把裸 CR 归一化成 LF，
 * 「往返一致」就不成立了。
 */
function escapeXmlText(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/** 读数值：只认整数（"10" → 10；"10.5"/"" /"abc" → null） */
function intOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 乐观锁值：mtimeMs + size（不用内容 hash：大文件算 hash 不划算，stamp 只防手滑） */
function stampOf(stat) {
  const st = stat || {};
  return String(st.mtimeMs) + ':' + String(st.size);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** sidecar 备份用的时间戳（本地时间，人能看懂） */
function backupStamp(d) {
  const t = d || new Date();
  return (
    String(t.getFullYear()) +
    pad2(t.getMonth() + 1) +
    pad2(t.getDate()) +
    '-' +
    pad2(t.getHours()) +
    pad2(t.getMinutes()) +
    pad2(t.getSeconds())
  );
}

/** 正则元字符转义（备份名要拼进 RegExp） */
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 「这份文件自己的备份」的严格名字形状：
 *   ^<basename>\.bak-\d{8}-\d{6}(-\d+)?$
 *
 * 两端都锚：既不接受别的 jmx 的备份（前缀不同），也不接受
 *   foo.jmx.bak-bar（尾巴不是时间戳）、
 *   foo.jmx.bak-20200101-010101.bak（多一截）、
 *   foo.jmx.bak-x20200101-010101（前面多字符）——
 * 只按「前缀 + 合法尾巴」两段判断容易漏掉最后一种，所以整名一次匹配。
 */
function backupNameRe(target) {
  return new RegExp('^' + reEscape(path.basename(target)) + '\\.bak-\\d{8}-\\d{6}(?:-\\d+)?$');
}

/**
 * 备份名 → 排序用的键。
 *
 * 同一秒内多次写回会产生 base / base-1 / base-2 ……（见 createBackup）。
 * 排「新→旧」时：
 *   · 先按 mtime（文件系统给的真实写入时间）；
 *   · mtime 相同（FAT 2 秒粒度、或同一批复制过来的）时按时间戳串倒序，
 *     再按 -n 后缀**数值**倒序 —— 后缀是本次进程里递增分配的，数值大的更新。
 * 不能图省事直接对整名倒序：字符串比较会把 "-9" 判成比 "-10" 新，
 * 结果把真正更新的 -10 当最旧的删掉。
 */
function backupRank(name) {
  const m = /^.*\.bak-(\d{8}-\d{6})(?:-(\d+))?$/.exec(name);
  return { stamp: m ? m[1] : '', suffix: m && m[2] ? Number(m[2]) : 0 };
}

/** 备份「新→旧」比较器 */
function compareBackupsNewestFirst(a, b) {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.rank.stamp !== b.rank.stamp) return a.rank.stamp < b.rank.stamp ? 1 : -1;
  if (a.rank.suffix !== b.rank.suffix) return b.rank.suffix - a.rank.suffix;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/* ------------------------------------------------------------------ *
 * 原文扫描：标签 / 元素区间
 * ------------------------------------------------------------------ */

/** 从 '<' 开始找到这个开始标签的 '>' 之后（跳过引号里的 >） */
function tagEnd(text, lt) {
  let quote = '';
  for (let i = lt + 1; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i + 1;
  }
  return -1;
}

function isSelfClosing(text, start, openEnd) {
  let k = openEnd - 2;
  while (k > start && /\s/.test(text.charAt(k))) k--;
  return text.charAt(k) === '/';
}

/**
 * 找某个标签名的所有元素区间（按出现顺序）。
 * 支持同名嵌套（用 depth 配对），自闭合元素也返回（closeStart = -1）。
 *
 * @returns {Array<{start:number, openEnd:number, closeStart:number, end:number, selfClosing:boolean}>}
 */
function findElements(text, tagName, from, to) {
  const limit = to === undefined || to === null ? text.length : to;
  const out = [];
  const startRe = new RegExp('<' + tagName + '(?=[\\s/>])', 'g');
  const endRe = new RegExp('</' + tagName + '\\s*>', 'g');
  let cursor = from || 0;

  while (cursor < limit) {
    startRe.lastIndex = cursor;
    const sm = startRe.exec(text);
    if (!sm || sm.index >= limit) break;
    const start = sm.index;
    const openEnd = tagEnd(text, start);
    if (openEnd < 0 || openEnd > limit) break;

    if (isSelfClosing(text, start, openEnd)) {
      out.push({ start, openEnd, closeStart: -1, end: openEnd, selfClosing: true });
      cursor = openEnd;
      continue;
    }

    let depth = 1;
    let scan = openEnd;
    let closeStart = -1;
    let after = -1;
    while (scan < limit) {
      startRe.lastIndex = scan;
      endRe.lastIndex = scan;
      const s2 = startRe.exec(text);
      const e2 = endRe.exec(text);
      const ns = s2 && s2.index < limit ? s2.index : -1;
      const ne = e2 && e2.index < limit ? e2.index : -1;
      if (ne < 0) break;
      if (ns >= 0 && ns < ne) {
        const oe = tagEnd(text, ns);
        if (oe < 0) break;
        if (!isSelfClosing(text, ns, oe)) depth++;
        scan = oe;
      } else {
        depth--;
        if (depth === 0) {
          closeStart = ne;
          after = e2.index + e2[0].length;
          break;
        }
        scan = ne + e2[0].length;
      }
    }
    if (closeStart < 0) break; // 文件里标签没闭合：后面的定位都不可信，直接停止
    out.push({ start, openEnd, closeStart, end: after, selfClosing: false });
    cursor = after;
  }
  return out;
}

/** 开始标签里的属性原值（latin1；调用方需要时再解码） */
function attrRaw(tagText, attr) {
  const re = new RegExp('(?:^|[\\s])' + attr + '\\s*=\\s*"([^"]*)"');
  const m = re.exec(tagText);
  return m ? m[1] : '';
}

/** 属性值（UTF-8 解码 + 实体还原） */
function attrText(tagText, attr) {
  const raw = attrRaw(tagText, attr);
  if (!raw) return '';
  return decodeXmlText(Buffer.from(raw, 'latin1').toString('utf8'));
}

/** 在 [from,to) 里找某个 prop（任意 Prop 标签） */
function findProp(text, from, to, propName) {
  for (const tag of PROP_TAGS) {
    for (const el of findElements(text, tag, from, to)) {
      if (el.selfClosing) continue;
      const name = attrRaw(text.slice(el.start, el.openEnd), 'name');
      if (name !== propName) continue;
      return {
        tag,
        start: el.start,
        openEnd: el.openEnd,
        closeStart: el.closeStart,
        end: el.end,
        valueStart: el.openEnd,
        valueEnd: el.closeStart
      };
    }
  }
  return null;
}

/** 线程组 block 内，main_controller（LoopController）的 elementProp 区间 */
function findMainController(text, group) {
  if (group.selfClosing) return null;
  for (const el of findElements(text, 'elementProp', group.openEnd, group.closeStart)) {
    if (el.selfClosing) continue;
    const tagText = text.slice(el.start, el.openEnd);
    if (attrRaw(tagText, 'name') !== MAIN_CONTROLLER_NAME) continue;
    const testclass = attrRaw(tagText, 'testclass');
    // testclass 缺失时也接受（老脚本 / 第三方生成器），但必须叫 main_controller
    if (testclass && testclass !== 'LoopController') continue;
    return el;
  }
  return null;
}

/** 响应断言 block 内，Asserion.test_strings 的第一条 stringProp */
function findFirstAssertionValue(text, assertion) {
  if (assertion.selfClosing) return null;
  for (const cp of findElements(text, 'collectionProp', assertion.openEnd, assertion.closeStart)) {
    if (cp.selfClosing) continue;
    if (attrRaw(text.slice(cp.start, cp.openEnd), 'name') !== ASSERTION_COLLECTION) continue;
    const props = findElements(text, 'stringProp', cp.openEnd, cp.closeStart);
    if (!props.length) return null;
    const el = props[0];
    return { valueStart: el.openEnd, valueEnd: el.closeStart };
  }
  return null;
}

/**
 * 三类线程组标签扫全文，按**出现位置**合并排序。
 *
 * 词边界靠 findElements 里的 `(?=[\s/>])` 保证：
 *   <ThreadGroupX ...>  不匹配（后面不是空白 / / / >）
 *   </SetupThreadGroup> 不会被当成 </ThreadGroup>（`<` 后面紧邻的是 S，不是 T）
 * 合并排序后编号，正是 jmx.js 里 threadGroups 的顺序（深度遍历先遇到先 push）。
 */
function findThreadGroups(text) {
  const out = [];
  for (const def of THREAD_GROUP_TAGS) {
    for (const el of findElements(text, def.tag, 0, text.length)) {
      out.push({
        start: el.start,
        openEnd: el.openEnd,
        closeStart: el.closeStart,
        end: el.end,
        selfClosing: el.selfClosing,
        type: def.type
      });
    }
  }
  // 线程组之间不可能嵌套，只可能是兄弟；按起点排一次即可（同起点不会出现）
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 扫全文，得到「可编辑模型 + 值区间」。
 * 这是 writeback 内部的定位基础；detail 只用其中不暴露区间的部分。
 */
function scanDocument(raw) {
  const buf = toBuf(raw);
  const text = asScanText(buf);
  const groups = [];
  const assertions = [];

  for (const g of findThreadGroups(text)) {
    const item = {
      region: g,
      type: g.type,
      name: attrText(text.slice(g.start, g.openEnd), 'testname'),
      span: { numThreads: null, rampUp: null, loops: null }
    };
    if (!g.selfClosing) {
      item.span.numThreads = findProp(text, g.openEnd, g.closeStart, EDITABLE_FIELDS.thread.numThreads);
      item.span.rampUp = findProp(text, g.openEnd, g.closeStart, EDITABLE_FIELDS.thread.rampUp);
      // loops 必须限定在 main_controller 里：线程组下面还可能挂着独立的循环控制器
      const main = findMainController(text, g);
      if (main) item.span.loops = findProp(text, main.openEnd, main.closeStart, EDITABLE_FIELDS.thread.loops);
    }
    groups.push(item);
  }

  for (const a of findElements(text, ASSERTION_TAG, 0, text.length)) {
    const item = {
      region: a,
      name: attrText(text.slice(a.start, a.openEnd), 'testname'),
      testField: '',
      spanValue: null
    };
    if (!a.selfClosing) {
      const tf = findProp(text, a.openEnd, a.closeStart, 'Assertion.test_field');
      if (tf) item.testField = valueAt(buf, tf);
      item.spanValue = findFirstAssertionValue(text, a);
    }
    assertions.push(item);
  }

  return { buf, text, groups, assertions };
}

/**
 * 详情页用的可编辑模型（**不含字节位置**：span 只在 writeback 内部重算）。
 *
 * @param {Buffer|string} raw 文件原文
 * @param {{mtimeMs?: number, size?: number}} stat
 * @returns {{stamp: string, groups: Array, assertions: Array}}
 */
function buildEditable(raw, stat) {
  const stamp = stampOf(stat);
  try {
    const doc = scanDocument(raw);
    const buf = doc.buf;
    const groups = doc.groups.map((g, index) => ({
      index,
      type: g.type,
      name: g.name,
      numThreads: g.span.numThreads ? intOrNull(valueAt(buf, g.span.numThreads)) : null,
      rampUp: g.span.rampUp ? intOrNull(valueAt(buf, g.span.rampUp)) : null,
      loops: g.span.loops ? intOrNull(valueAt(buf, g.span.loops)) : null
    }));
    const assertions = doc.assertions.map((a, index) => ({
      index,
      name: a.name,
      testField: a.testField,
      value: a.spanValue ? valueAt(buf, a.spanValue) : ''
    }));
    return { stamp, groups, assertions };
  } catch (e) {
    // 详情是只读视图：坏文件不该让整个页面打不开（解析错误由 readDetail 先拦）
    return { stamp, groups: [], assertions: [] };
  }
}

/* ------------------------------------------------------------------ *
 * 校验（闸 2 + 值校验）——全部通过之前不碰文件系统
 * ------------------------------------------------------------------ */

function describeAllowed() {
  return '线程组 numThreads/rampUp/loops、响应断言 value';
}

/**
 * 校验并规范化入参 edits。
 * @returns {{ok:true, edits:Array}|{ok:false,code:string,message:string}}
 */
function normalizeEdits(edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return fail('BAD_VALUE', '至少要有 1 条修改（本次 0 条）');
  }
  if (edits.length > MAX_EDITS) {
    return fail('BAD_VALUE', '一次最多 ' + MAX_EDITS + ' 条修改（本次 ' + edits.length + ' 条）');
  }

  const seen = new Set();
  const out = [];

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const at = '第 ' + (i + 1) + ' 条修改';
    if (!e || typeof e !== 'object') return fail('BAD_VALUE', at + '格式不对');

    const kind = String(e.kind == null ? '' : e.kind);
    const field = String(e.field == null ? '' : e.field);
    const whitelist = Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS, kind) ? EDITABLE_FIELDS[kind] : null;
    if (!whitelist || !Object.prototype.hasOwnProperty.call(whitelist, field)) {
      return fail(
        'NOT_EDITABLE',
        at + '想改 ' + (kind || '(空)') + '.' + (field || '(空)') + '，不在可编辑白名单内（只支持：' + describeAllowed() + '）'
      );
    }

    const indexRaw = String(e.index == null ? '' : e.index);
    if (!/^\d+$/.test(indexRaw)) return fail('BAD_VALUE', at + '的 index 必须是非负整数');
    const index = Number(indexRaw);

    const key = kind + ':' + index + ':' + field;
    if (seen.has(key)) return fail('BAD_VALUE', at + '与前面的修改重复（同一目标同一字段只能改一次）');
    seen.add(key);

    const item = { kind, field, index, text: '', logical: '' };
    // 可选 name：原样带到定位阶段，用于核对「index 对应的 testname 还是不是详情里那个」
    if (e.name !== undefined && e.name !== null) item.name = String(e.name);
    /**
     * 可选 type（'thread' | 'setup' | 'teardown'）：只有 kind === 'thread' 有意义。
     * 传了就带到定位阶段和文件里实际标签比对，不一致 → NO_SUCH_TARGET
     * （挡住「中间插入/删掉了一个 SetupThreadGroup，index 整体错位」这种漂移）。
     */
    if (kind === 'thread' && e.type !== undefined && e.type !== null) item.type = String(e.type);

    if (kind === 'thread') {
      const valueRaw = typeof e.value === 'number' ? String(e.value) : String(e.value == null ? '' : e.value).trim();
      // 允许前导负号：loops = -1 是合法的「永久循环」；具体区间由 THREAD_VALUE_RULE 判
      if (!/^-?\d+$/.test(valueRaw)) {
        return fail('BAD_VALUE', at + '（' + kind + '.' + field + '）必须是整数：' + valueRaw);
      }
      const n = Number(valueRaw);
      const rule = THREAD_VALUE_RULE[field];
      if (!Number.isSafeInteger(n) || !rule || !rule.test(n)) {
        return fail(
          'BAD_VALUE',
          at + '（' + kind + '.' + field + '）超出允许范围 ' + (rule ? rule.desc : '（未知字段）') + '：' + valueRaw
        );
      }
      item.text = String(n);
      item.logical = String(n);
    } else {
      const v = typeof e.value === 'string' ? e.value : typeof e.value === 'number' ? String(e.value) : null;
      if (v === null) return fail('BAD_VALUE', at + '（' + kind + '.' + field + '）的值必须是字符串');
      if (v.length === 0) return fail('BAD_VALUE', at + '的值不能为空');
      if (v.length > MAX_ASSERTION_LEN) {
        return fail('BAD_VALUE', at + '的值 ' + v.length + ' 个字符，超过 ' + MAX_ASSERTION_LEN + ' 上限');
      }
      if (v.indexOf('<') >= 0 || v.indexOf('>') >= 0) {
        return fail('BAD_VALUE', at + '的值不能包含 < 或 >（断言值是文本，不是 XML 片段）');
      }
      // 控制字符会让 XML 1.0 非法；\t \n 允许，\r 由转义成 &#13; 保留
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) {
        return fail('BAD_VALUE', at + '的值包含控制字符');
      }
      item.text = escapeXmlText(v);
      item.logical = v;
    }

    out.push(item);
  }
  return { ok: true, edits: out };
}

/**
 * 把 edits 解析成具体的字节替换区间。
 * 任何一条定位失败 → 整单失败（要么全改要么不改）。
 */
function planReplacements(doc, edits) {
  const replacements = [];

  for (const e of edits) {
    const list = e.kind === 'thread' ? doc.groups : doc.assertions;
    const label = e.kind === 'thread' ? '线程组' : '响应断言';
    const target = list[e.index];
    if (!target) {
      return fail('NO_SUCH_TARGET', '文件里没有第 ' + e.index + ' 个' + label + '（共 ' + list.length + ' 个）');
    }
    /**
     * 可选 name：前端若带上 testname（来自 detail 的 editable），这里再核对一次。
     * 契约里它是可选的（edits 只要求 kind/index/field/value），所以不传不报错；
     * 传了就能挡住「详情打开后文件被换成了同名同大小的另一份」这种索引漂移。
     */
    if (e.name !== undefined && e.name !== null && String(e.name) !== String(target.name)) {
      return fail(
        'NO_SUCH_TARGET',
        '第 ' + e.index + ' 个' + label + '的名字对不上（文件里是「' + target.name + '」，请求是「' + String(e.name) + '」），请刷新详情后重试'
      );
    }
    /**
     * 可选 type：只在 thread 上有意义。Setup/Post 线程组和普通线程组混在一起编号，
     * 文件里删掉一个就会整体错位 —— 带上 type 就能在改错类型时直接拒绝。
     */
    if (e.kind === 'thread' && e.type !== undefined && String(e.type) !== String(target.type)) {
      return fail(
        'NO_SUCH_TARGET',
        '第 ' + e.index + ' 个线程组的类型对不上（文件里是「' + target.type + '」，请求是「' + String(e.type) + '」），请刷新详情后重试'
      );
    }

    const span = e.kind === 'thread' ? target.span[e.field] : target.spanValue;
    if (!span || span.valueStart === undefined || span.valueEnd === undefined) {
      return fail('NO_SUCH_TARGET', '第 ' + e.index + ' 个' + label + '里没有可修改的 ' + e.field + ' 字段');
    }

    replacements.push({
      start: span.valueStart,
      end: span.valueEnd,
      text: e.text,
      change: {
        kind: e.kind,
        index: e.index,
        field: e.field,
        from: valueAt(doc.buf, span),
        to: e.logical
      }
    });
  }

  // 不同字段不会重叠；这里是防御（以后白名单扩展时别把两个值指到同一段字节）
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++) {
    if (replacements[i].start < replacements[i - 1].end) {
      return fail('BAD_VALUE', '修改区间重叠，已拒绝（请拆成两次写回）');
    }
  }
  return { ok: true, replacements };
}

/** 用替换区间拼出新文件字节（其余字节原样） */
function applyReplacements(buf, replacements) {
  const parts = [];
  let cursor = 0;
  for (const r of replacements) {
    parts.push(buf.slice(cursor, r.start));
    parts.push(Buffer.from(r.text, 'utf8'));
    cursor = r.end;
  }
  parts.push(buf.slice(cursor));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ *
 * 闸 3：sidecar 备份 + tmp/fsync/rename 原子写
 * ------------------------------------------------------------------ */

/**
 * 同目录 sidecar 备份，内容 == 原始字节。
 * 同一秒内多次写回时用 -1 / -2 后缀避免互相覆盖（备份只能多不能少）。
 */
function createBackup(target, originalBuf) {
  const base = target + '.bak-' + backupStamp(new Date());
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : base + '-' + n;
    let fd = -1;
    try {
      fd = fs.openSync(candidate, 'wx'); // wx：已存在就失败，绝不覆盖旧备份
      fs.writeFileSync(fd, originalBuf);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return candidate;
    } catch (e) {
      if (fd >= 0) {
        try {
          fs.closeSync(fd);
        } catch (e2) {
          /* ignore */
        }
        // 备份只写了一半（磁盘满 / IO 错）：删掉，免得留下一个假的「备份」
        try {
          fs.unlinkSync(candidate);
        } catch (e2) {
          /* ignore */
        }
      }
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  throw new Error('同目录里备份文件名冲突过多');
}

function tmpPathFor(target) {
  return target + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

/**
 * 备份保留：只留最近 keep 份，其余删掉。
 *
 * keep 由调用方传（默认 KEEP_BACKUPS）：值来自设置项 backupKeep，
 * 与 backups/ 下每日备份共用同一个数（见 store.js 的 setBackupKeep）。
 *
 * **调用时机必须在 rename 成功之后**（见 writeAtomic）：新备份落盘 + 新内容写成功，
 * 才有资格删旧的。写盘失败时只有 `return fail` 一条路，压根不会进这里。
 *
 * 只认「本文件自己的备份」——备份名必须整名匹配 backupNameRe(target)：
 *   · 同目录别的 jmx 的备份：前缀不同 → 不匹配 → 不碰；
 *   · 用户自己放的 foo.jmx.bak-bar / foo.jmx.bak-2020-01-01：尾巴不合法 → 不碰；
 *   · 名字像备份但其实是目录 / 符号链接：isFile() 为假 → 跳过。
 *
 * 失败一律 best effort：删不掉只记日志，绝不把已经成功的写回变成失败。
 *
 * @returns {{pruned:number, failed:number, total:number}}
 */
function pruneBackups(target, currentBackup, keep) {
  const stat = { pruned: 0, failed: 0, total: 0 };
  const limit = clampKeep(keep);
  const dir = path.dirname(target);

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    // 目录都读不了：宁可不删（备份多留不算错，误删就没救了）
    console.warn('[jmx-writeback] 扫描备份目录失败，本次跳过清理', dir, errMsg(e));
    return stat;
  }

  const re = backupNameRe(target);
  const list = [];
  for (const name of names) {
    if (!re.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue; // 拿不到 mtime 就先不动它
    }
    if (!st.isFile()) continue;
    list.push({ path: full, name, mtimeMs: st.mtimeMs, rank: backupRank(name) });
  }
  stat.total = list.length;
  if (list.length <= limit) return stat;

  list.sort(compareBackupsNewestFirst);

  for (let i = limit; i < list.length; i++) {
    const item = list[i];
    /**
     * 兜底：刚写出来的这份备份永远不删。
     * 正常排序下它必然在前 KEEP_BACKUPS 里，但系统时钟被回拨、或文件系统
     * 时间戳精度不够时它可能被排到后面 —— 这时宁可多留一份，也不能删掉
     * 「刚刚这次写回」唯一的退路。
     * 比 basename 而不是整路径：target 里可能带 / 或 \，path.join 后的写法未必一致。
     */
    if (currentBackup && item.name === path.basename(currentBackup)) continue;
    try {
      fs.unlinkSync(item.path);
      stat.pruned += 1;
    } catch (e) {
      stat.failed += 1;
      console.warn('[jmx-writeback] 删除旧备份失败（已跳过）', item.path, errMsg(e));
    }
  }
  return stat;
}

/**
 * 原子替换：写备份 → 写 tmp + fsync → rename 覆盖 → 清理超出保留数的旧备份。
 * rename 失败时把 tmp 和本次备份都删掉（不留半截文件），原文件不受影响。
 */
function writeAtomic(target, newBuf, originalBuf, keep) {
  let backup = '';
  try {
    backup = createBackup(target, originalBuf);
  } catch (e) {
    return fail('WRITE_FAILED', '生成备份失败（原文件未改动）：' + errMsg(e));
  }

  let tmp = '';
  try {
    tmp = tmpPathFor(target);
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, newBuf);
      fs.fsyncSync(fd);
    } finally {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
    }
    fs.renameSync(tmp, target);
    // 到这里原文件已被新内容替换、新备份也已 fsync 落盘，才有资格删旧备份
    let pruned = 0;
    try {
      pruned = pruneBackups(target, backup, keep).pruned;
    } catch (e) {
      // 清理是附加动作：它出问题不影响本次写回成功
      console.warn('[jmx-writeback] 备份清理异常（已忽略）', target, errMsg(e));
    }
    return { ok: true, backup, pruned };
  } catch (e) {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(backup);
    } catch (e2) {
      /* ignore */
    }
    return fail('WRITE_FAILED', '写盘失败（原文件未改动）：' + errMsg(e));
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 局部编辑写回。
 *
 * @param {string} file 绝对路径（调用方负责 assertPathIn）
 * @param {string} stamp 详情返回的 stamp
 * @param {Array<{kind:string,index:number,field:string,value:(string|number),name?:string,type?:string}>} edits
 * @param {{keepBackups?:number}} [opts] keepBackups = 设置项 backupKeep（缺省用 KEEP_BACKUPS）
 * @returns {{ok:true,file:string,backup:string,pruned:number,changes:Array,editable:object}
 *          |{ok:false,code:string,message:string}}
 */
function writeback(file, stamp, edits, opts) {
  const keep = clampKeep(opts && opts.keepBackups);
  const target = String(file == null ? '' : file).trim();
  if (!target) return fail('BAD_PATH', '缺少文件路径');

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (e) {
    return fail('BAD_PATH', '文件不存在或无法访问：' + target);
  }
  if (!stat.isFile()) return fail('BAD_PATH', '不是文件：' + target);
  if (stat.size > MAX_BYTES) {
    return fail('BAD_VALUE', '文件 ' + (stat.size / 1024 / 1024).toFixed(1) + ' MB，超过 5 MB，不在局部编辑范围内');
  }

  // 乐观锁：先比 stamp（文件被 JMeter 另存 / 被同事改过 → 整单拒绝）
  const expected = String(stamp == null ? '' : stamp).trim();
  if (!expected) return fail('STALE', '缺少 stamp，无法确认文件是否被外部修改，请刷新详情后重试');
  if (expected !== stampOf(stat)) {
    return fail('STALE', '文件已被外部修改（mtime/size 与详情不一致），请刷新详情后重试；本次未写盘');
  }

  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch (e) {
    return fail('BAD_PATH', '读取失败：' + errMsg(e));
  }
  if (buf.length !== stat.size) return fail('STALE', '文件在读取过程中被修改，请刷新详情后重试；本次未写盘');

  // 闸 2 + 值校验 + 定位（全部在内存里完成，任何一条失败都不写盘）
  const normalized = normalizeEdits(edits);
  if (!normalized.ok) return normalized;

  let doc;
  let plan;
  try {
    doc = scanDocument(buf);
    plan = planReplacements(doc, normalized.edits);
  } catch (e) {
    // 结构异常（标签没闭合等）不该把异常抛给 Electron（会被包成看不懂的 remote method error）
    return fail('WRITE_FAILED', '扫描文件结构失败（原文件未改动）：' + errMsg(e));
  }
  if (!plan.ok) return plan;

  const newBuf = applyReplacements(buf, plan.replacements);

  /**
   * 权限探测：Windows 上只读属性会让后面的 rename 失败（POSIX 上 rename 只看目录权限，
   * 所以这里主动探一次，让「只读 → WRITE_FAILED」在两套系统上行为一致）。
   * 只 open 不写，不改变内容。
   */
  try {
    const probe = fs.openSync(target, 'r+');
    fs.closeSync(probe);
  } catch (e) {
    return fail('WRITE_FAILED', '文件不可写（只读或权限不足）：' + errMsg(e));
  }

  const written = writeAtomic(target, newBuf, buf, keep);
  if (!written.ok) return written;

  // 写成功后重新取 stat / 内容，返回新的 editable（前端据此刷新乐观锁）
  let afterStat = stat;
  let afterBuf = newBuf;
  try {
    afterStat = fs.statSync(target);
  } catch (e) {
    afterStat = { mtimeMs: stat.mtimeMs, size: newBuf.length };
  }
  try {
    afterBuf = fs.readFileSync(target);
  } catch (e) {
    /* 读不回就用内存里的新内容 */
  }

  return {
    ok: true,
    file: target,
    backup: written.backup,
    /**
     * 本次删掉了几份过期备份（0 表示没删，可能本来就不超过保留数，也可能清理失败）。
     * 保留策略见 KEEP_BACKUPS / pruneBackups；清理失败不影响 ok。
     */
    pruned: written.pruned || 0,
    changes: plan.replacements.map((r) => r.change),
    editable: buildEditable(afterBuf, afterStat)
  };
}

module.exports = {
  buildEditable,
  writeback,
  EDITABLE_FIELDS,
  MAX_EDITS,
  MAX_ASSERTION_LEN,
  INT_MIN,
  INT_MAX,
  LOOP_FOREVER,
  RAMPUP_MIN,
  KEEP_BACKUPS,
  MAX_BYTES,
  stampOf
};