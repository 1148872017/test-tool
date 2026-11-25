'use strict';
/**
 * 「用系统浏览器实时高亮定位器」—— 纯函数单元测试（不启动浏览器）。
 *
 * 覆盖两块：
 *   1. electron/sniffer/highlight.js
 *      · jsLiteral 转义（引号/反斜杠/换行/尖括号/U+2028）与往返；
 *      · 9 种定位方式生成的定位表达式（css/xpath/role/label/placeholder/text/
 *        alttext/title/testid），含 role 的「角色:可访问名」拆解；
 *      · 注入脚本该有的东西：滚动、fixed 框、最高 z-index、pointer-events:none、
 *        红色实线/虚线、MutationObserver 常驻重建、shadow DOM / iframe 只报不画、
 *        window.__ttSniff 写入；
 *      · parseSniffState 收口（页面里的脏值不能污染上层）。
 *   2. electron/sniffer/browser-session.js 的纯函数部分
 *      · 浏览器候选路径（Edge 优先，Program Files / x86 / LOCALAPPDATA 都认）；
 *      · v0.56 浏览器选择：progId→浏览器名、auto/edge/chrome 解析、默认浏览器优先；
 *      · v0.56 残留清理判据：命令行必须同时含本 profile 绝对路径 + sniff-profile，
 *        不认识的进程名/pid 一律不碰；主进程（无 --type=）与账本读写；
 *      · url 只放 http/https；端口范围；启动参数（随机端口 + 只绑 127.0.0.1 + 独立 profile）；
 *      · 事实 → 人话。
 *   3. electron/ipc/ipc-sniff.js 的入参契约（reopen 兼容 preload 的包裹形状）。
 *
 * 真浏览器链路在 scripts/test-sniff-browser.cjs（找不到浏览器会显式 SKIP）。
 *
 * unit 档：不碰本机真实资产、不联网、不 spawn 任何进程（进程盘点/注册表都用注入的假实现）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const hl = require(path.join(ROOT, 'electron', 'sniffer', 'highlight.js'));
const bs = require(path.join(ROOT, 'electron', 'sniffer', 'browser-session.js'));
const ipcSniff = require(path.join(ROOT, 'electron', 'ipc', 'ipc-sniff.js'));
const lm = require(path.join(ROOT, 'shared', 'locatorModes.js'));

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HL_SRC = readSrc('electron/sniffer/highlight.js');
const BS_SRC = readSrc('electron/sniffer/browser-session.js');
const CDP_SRC = readSrc('electron/sniffer/cdp.js');
const IPC_SRC = readSrc('electron/ipc/ipc-sniff.js');

/** 生成脚本在当前 Node 里能不能被解析（语法对不对） */
function parses(src) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
    return true;
  } catch (e) {
    return false;
  }
}

/* ============================================================
 * 0. 模块边界与硬性约定
 * ============================================================ */
check('highlight.js 导出 6 个能力（literal/expr/script/parse/mode 列表/BOX_ID）', (() => {
  const keys = ['jsLiteral', 'locatorExpr', 'buildHighlightScript', 'parseSniffState', 'LOCATOR_MODES', 'BOX_ID'];
  return keys.every((k) => hl[k] !== undefined);
})(), Object.keys(hl));
check('高亮框 id 固定为 tt-sniff-box（重新注入时靠它清场）', hl.BOX_ID === 'tt-sniff-box', hl.BOX_ID);
check('highlight.js 支持 9 种定位方式', hl.LOCATOR_MODES.length === 9, hl.LOCATOR_MODES);
check(
  '9 种定位方式与 shared/locatorModes.js 完全同源（不另立一套）',
  hl.LOCATOR_MODES.join(',') === lm.LOCATOR_MODES.join(','),
  [hl.LOCATOR_MODES, lm.LOCATOR_MODES]
);
check(
  'highlight.js 不 require 任何 Node 模块（要能原样丢进浏览器页面）',
  !/require\(\s*['"](fs|path|net|http|https|os|child_process|electron|url)['"]\s*\)/.test(HL_SRC)
);
check(
  'highlight.js 只 require shared/locatorModes（零 Node 依赖）',
  (HL_SRC.match(/require\(/g) || []).length === 1,
  (HL_SRC.match(/require\([^)]*\)/g) || [])
);
check('cdp.js 自己实现 id 对成（有 pending 表 + id 自增）', /pending\.set\(id/.test(CDP_SRC) && /nextId \+= 1/.test(CDP_SRC));
check('cdp.js 有命令超时（不能挂着不回）', /CDP_TIMEOUT/.test(CDP_SRC) && /setTimeout/.test(CDP_SRC));
check('ipc-sniff.js 6 个通道全在这里注册', (IPC_SRC.match(/handle\('sniff:/g) || []).length === 6, (IPC_SRC.match(/handle\('sniff:[^']+'/g) || []));

/* ============================================================
 * 1. jsLiteral：拼进注入脚本的字面量必须安全
 * ============================================================ */
{
  const roundTrip = (value) => {
    const lit = hl.jsLiteral(value);
    try {
      // eslint-disable-next-line no-new-func
      return { ok: true, value: new Function('return (' + lit + ');')() };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  };

  const plain = roundTrip('hello');
  check('字面量：普通字符串往返一致', plain.ok && plain.value === 'hello', plain);

  const withQuote = roundTrip('a"b');
  check('字面量：双引号被转义且往返一致', withQuote.ok && withQuote.value === 'a"b', withQuote);
  check('字面量：双引号在源码里以 \\" 出现', hl.jsLiteral('a"b').indexOf('\\"') >= 0, hl.jsLiteral('a"b'));

  const withBackslash = roundTrip('C:\\tmp\\a');
  check('字面量：反斜杠往返一致（不会被当成转义）', withBackslash.ok && withBackslash.value === 'C:\\tmp\\a', withBackslash);

  const withNewline = roundTrip('a\nb\tc\rd');
  check('字面量：\\n / \\t / \\r 往返一致', withNewline.ok && withNewline.value === 'a\nb\tc\rd', withNewline);
  check('字面量：换行不会写成真的换行（否则脚本会串行）', hl.jsLiteral('a\nb').indexOf('\n') < 0, hl.jsLiteral('a\nb'));

  const withCn = roundTrip('登录 / 用户名「测试」');
  check('字面量：中文原样保留', withCn.ok && withCn.value === '登录 / 用户名「测试」', withCn);

  const withHtml = hl.jsLiteral('<script>alert(1)</script>&');
  check('字面量：< > & 被转成 \\u003c 形式', withHtml.indexOf('\\u003c') >= 0 && withHtml.indexOf('\\u003e') >= 0 && withHtml.indexOf('\\u0026') >= 0, withHtml);
  check('字面量：源码里不再出现裸的 <script', withHtml.indexOf('<script') < 0, withHtml);

  check('字面量：U+2028 / U+2029 被转义（旧引擎里是行终止符）', (() => {
    const lit = hl.jsLiteral('a\u2028b\u2029c');
    return lit.indexOf('\\u2028') >= 0 && lit.indexOf('\\u2029') >= 0 && roundTrip('a\u2028b\u2029c').value === 'a\u2028b\u2029c';
  })(), hl.jsLiteral('a\u2028b\u2029c'));

  check('字面量：数字 / 布尔 / null 正常', hl.jsLiteral(7) === '7' && hl.jsLiteral(true) === 'true' && hl.jsLiteral(null) === 'null');
  check('字面量：undefined 退成 null（注入脚本里不能出现 undefined 字面量解析问题）', hl.jsLiteral(undefined) === 'null', hl.jsLiteral(undefined));

  const objLit = hl.jsLiteral({ mode: 'css', selector: 'a"b' });
  check('字面量：对象往返一致（SPEC 就是这么塞进去的）', (() => {
    try {
      // eslint-disable-next-line no-new-func
      const v = new Function('return (' + objLit + ');')();
      return v.mode === 'css' && v.selector === 'a"b';
    } catch (e) {
      return false;
    }
  })(), objLit);

  const tricky = ['a"b\'c', 'a\\b', '//div[@id="x"]', 'button:登录:备注', '[data-x="1"] > span', 'a\nb', '${x}', '`tick`', '$&', '$1'];
  check(
    '字面量：11 个刁钻定位值全部能解析回来（含 $& / $1 / 反引号 / ${}）',
    tricky.every((s) => {
      const r = roundTrip(s);
      return r.ok && r.value === s;
    }),
    tricky.filter((s) => {
      const r = roundTrip(s);
      return !(r.ok && r.value === s);
    })
  );
}

/* ============================================================
 * 2. 定位方式归一化
 * ============================================================ */
check('归一化：9 种合法方式原样返回', hl.LOCATOR_MODES.every((m) => hl.normalizeMode(m) === m));
check('归一化：大写按小写处理', hl.normalizeMode('TESTID') === 'testid', hl.normalizeMode('TESTID'));
check('归一化：前后空格去掉', hl.normalizeMode('  xpath  ') === 'xpath', hl.normalizeMode('  xpath  '));
check('归一化：认不出的当 css（老记录没有 mode 字段）', hl.normalizeMode('nonsense') === 'css', hl.normalizeMode('nonsense'));
check('归一化：null / undefined / 空串都当 css', hl.normalizeMode(null) === 'css' && hl.normalizeMode(undefined) === 'css' && hl.normalizeMode('') === 'css');

/* ============================================================
 * 3. 9 种定位方式的表达式
 * ============================================================ */
{
  const exprOf = (mode, sel) => hl.locatorExpr(mode, sel);

  const cssExpr = exprOf('css', '#login .btn');
  check('css：调用 css 查询助手', cssExpr.indexOf('__ttFind.css(') === 0, cssExpr);
  check('css：定位值以字面量出现', cssExpr.indexOf('"#login .btn"') > 0, cssExpr);

  const xpathExpr = exprOf('xpath', '//button[@id="ok"]');
  check('xpath：调用 xpath 助手（走 document.evaluate）', xpathExpr.indexOf('__ttFind.xpath(') === 0, xpathExpr);
  check('xpath：注入脚本里用 ORDERED_NODE_SNAPSHOT 收节点', /document\.evaluate/.test(HL_SRC) && /ORDERED_NODE_SNAPSHOT|7 \/\* ORDERED/.test(HL_SRC));
  check('xpath：不自动加 xpath= 前缀（前缀是 Playwright 生成器的事）', xpathExpr.indexOf('xpath=') < 0, xpathExpr);

  const roleExpr = exprOf('role', 'button:登录');
  check('role：拆成角色 + 可访问名两个参数', roleExpr.indexOf('"button"') > 0 && roleExpr.indexOf('"登录"') > 0, roleExpr);
  check('role：走 role 助手（按 role + accname 匹配）', roleExpr.indexOf('__ttFind.role(') === 0, roleExpr);
  const roleColon = exprOf('role', 'button:登录:备注');
  check('role：名称里的第二个冒号保留在名称里', roleColon.indexOf('"button"') > 0 && roleColon.indexOf('"登录:备注"') > 0, roleColon);
  const roleOnly = exprOf('role', 'button');
  check('role：只写角色时名称为空串', roleOnly.indexOf('"button"') > 0 && /,\s*""\)$/.test(roleOnly), roleOnly);
  const roleEmpty = exprOf('role', ':登录');
  check('role：角色为空时退化成空角色（脚本里返回 0 个，不会报错）', roleEmpty.indexOf('""') > 0, roleEmpty);

  check('label：走 label 助手（<label> 关联 + aria-label）', exprOf('label', '用户名').indexOf('__ttFind.label(') === 0);
  check('text：走 text 助手（文本节点所在元素）', exprOf('text', '立即登录').indexOf('__ttFind.text(') === 0);
  check('placeholder：按 [placeholder] 属性匹配', exprOf('placeholder', '请输入用户名').indexOf('"placeholder"') > 0, exprOf('placeholder', 'x'));
  check('title：按 [title] 属性匹配', exprOf('title', '关闭').indexOf('"title"') > 0, exprOf('title', 'x'));
  check('alttext：按 [alt] 属性匹配（不是 aria-alt）', exprOf('alttext', '头像').indexOf('"alt"') > 0, exprOf('alttext', 'x'));
  check('testid：按 [data-testid] 属性匹配', exprOf('testid', 'login-btn').indexOf('"data-testid"') > 0, exprOf('testid', 'x'));
  check('认不出的定位方式退回 css', exprOf('nope', '#x').indexOf('__ttFind.css(') === 0, exprOf('nope', '#x'));

  const all = hl.LOCATOR_MODES.map((m) => exprOf(m, 'x'));
  check('9 种表达式都引用 __ttScope（同一套能查 iframe / shadow）', all.every((e) => e.indexOf('__ttScope') > 0), all);
  check('9 种表达式都能被 JS 解析', all.every((e) => parses('return (' + e + ');')), all.filter((e) => !parses('return (' + e + ');')));
  check('9 种表达式里的定位值都被安全转义（带引号也不炸）', (() => {
    const bad = hl.LOCATOR_MODES.map((m) => hl.locatorExpr(m, 'a"b\\c'));
    return bad.every((e) => parses('return (' + e + ');'));
  })());
  check('空定位值也能生成合法表达式（不抛异常）', hl.LOCATOR_MODES.every((m) => parses('return (' + hl.locatorExpr(m, '') + ');')));
}

/* ============================================================
 * 4. 注入脚本：该做的事一件不少
 * ============================================================ */
{
  const src = hl.buildHighlightScript('testid', 'login-btn', { name: '登录按钮' });

  check('脚本：是一段能解析的 JS', parses(src), 'syntax error');
  check('脚本：SPEC 里带上了 mode', src.indexOf('"mode":"testid"') > 0, 'no mode');
  check('脚本：SPEC 里带上了 selector', src.indexOf('"selector":"login-btn"') > 0, 'no selector');
  check('脚本：SPEC 里带上了元素名（只回传用，不参与定位）', src.indexOf('"name":"登录按钮"') > 0, 'no name');
  check('脚本：没有残留占位符', src.indexOf('__TT_SPEC__') < 0 && src.indexOf('__TT_LOCATOR__') < 0);
  check('脚本：定位表达式已内联（testid → data-testid）', src.indexOf('__ttFind.byAttr(__ttScope, "data-testid", "login-btn")') > 0);

  // --- 滚动到可见 ---
  check('脚本：滚动到元素（scrollIntoView）', src.indexOf('scrollIntoView') > 0);
  check('脚本：滚动用居中（block/inline: center）', src.indexOf("block: 'center'") > 0 && src.indexOf("inline: 'center'") > 0);

  // --- 高亮框 ---
  check("脚本：框是 position:fixed", src.indexOf("s.position = 'fixed'") > 0, 'no fixed');
  check("脚本：框不吃鼠标事件（pointer-events:none）", src.indexOf("s.pointerEvents = 'none'") > 0, 'no pointer-events');
  check("脚本：框是最高 z-index 2147483647", src.indexOf("s.zIndex = '2147483647'") > 0, 'no z-index');
  check('脚本：框是 fixed 且只画在 body/documentElement 上', src.indexOf('DOC.body || DOC.documentElement') > 0);
  check('脚本：可见元素画红色实线框', src.indexOf("'2px solid #ff3b30'") > 0, 'no solid');
  check('脚本：不可见元素画红色虚线框', src.indexOf("'2px dashed #ff3b30'") > 0, 'no dashed');
  check('脚本：每次重画前先清掉旧框（不会叠一堆框）', src.indexOf('clearBox()') > 0 && /function clearBox/.test(src));
  check('脚本：重新注入时先摘掉旧观察器（幂等，不叠监听）', src.indexOf('__ttSniffStop') > 0);

  // --- 常驻重建 ---
  check('脚本：装了 MutationObserver（路由变化/重渲染后自动重建）', src.indexOf('MutationObserver') > 0);
  check('脚本：观察 childList + subtree + attributes + characterData', (() => {
    const m = /mo\.observe\(DOC\.documentElement, \{([^}]+)\}\)/.exec(src);
    if (!m) return false;
    const body = m[1];
    return /childList: true/.test(body) && /subtree: true/.test(body) && /attributes: true/.test(body) && /characterData: true/.test(body);
  })());
  check('脚本：mutation 重建有去抖（setTimeout 合并）', /setTimeout\(function/.test(src) && src.indexOf('}, 80)') > 0);
  check('脚本：忽略自己画的框产生的 mutation（否则自激循环）', src.indexOf('onlyOwnMutation') > 0);
  check('脚本：滚动/窗口大小变化会挪框（reposition）', src.indexOf("addEventListener('scroll'") > 0 && src.indexOf("addEventListener('resize'") > 0 && src.indexOf('reposition') > 0);
  check('脚本：页面 load 之后再算一次', src.indexOf("addEventListener('load'") > 0);

  // --- 事实（只描述、不判对错） ---
  check('脚本：把事实写进 window.__ttSniff', src.indexOf('window.__ttSniff = st') > 0);
  check('脚本：事实里有 found / total', src.indexOf('st.found =') > 0 && src.indexOf('st.total =') > 0);
  check('脚本：事实里有 visible', src.indexOf('st.visible = isVisible(el)') > 0);
  check('脚本：事实里有 label', src.indexOf('st.label = labelOf(el)') > 0);
  check('脚本：事实里有 inIframe', src.indexOf('st.inIframe = true') > 0);
  check('脚本：not-found 是默认 reason', src.indexOf("reason: 'not-found'") > 0);
  check('脚本：iframe 内元素报 in-iframe', src.indexOf("st.reason = 'in-iframe'") > 0);
  check('脚本：shadow DOM 内元素报 shadow-dom', src.indexOf("st.reason = 'shadow-dom'") > 0);
  check('脚本：会去 iframe 里找（contentDocument）', src.indexOf('contentDocument') > 0 && src.indexOf('searchIframes') > 0);
  check('脚本：会去 shadowRoot 里找（递归、有深度上限）', src.indexOf('shadowRoot') > 0 && src.indexOf('searchShadow') > 0 && src.indexOf('depth > 4') > 0);
  check('脚本：iframe / shadow 里的元素不画框（只有主文档命中才给 el 赋值）', (() => {
    const at = src.indexOf("st.reason = 'shadow-dom'");
    const shadowBlock = src.slice(at, at + 400);
    const at2 = src.indexOf("st.reason = 'in-iframe'");
    const frameBlock = src.slice(at2, at2 + 400);
    // 主文档命中分支里有 "el = hits[0]"；这两块里不能有对 el 赋值
    return src.indexOf('el = hits[0]') > 0 && !/\bel = /.test(shadowBlock) && !/\bel = /.test(frameBlock);
  })());
  check('脚本：可访问名优先（aria-labelledby / aria-label / label / 文本）', src.indexOf('aria-labelledby') > 0 && src.indexOf('aria-label') > 0 && src.indexOf('accName') > 0);
  check('脚本：role 语义表覆盖 button/textbox/checkbox/link/heading', ['button', 'textbox', 'checkbox', 'link', 'heading'].every((r) => src.indexOf("'" + r + "'") > 0));
  check('脚本：可见性判断用 getBoundingClientRect + getComputedStyle', src.indexOf('getBoundingClientRect') > 0 && src.indexOf('getComputedStyle') > 0);
  check('脚本：display:none / visibility:hidden / opacity:0 都算不可见', /display === 'none'/.test(src) && /visibility === 'hidden'/.test(src) && /Number\(cs\.opacity\) === 0/.test(src));
  check('脚本：有节点上限（怪页面不会把主线程拖死）', src.indexOf('MAX_NODES') > 0);
  check('脚本：脚本里没有 require（页面里根本没有 require）', src.indexOf('require(') < 0);
  check('脚本：没有模板字符串残留（String.raw 里反引号会提前收尾）', src.indexOf('`') < 0);

  // --- 不同定位方式的脚本都能生成 ---
  const scripts = hl.LOCATOR_MODES.map((m) => hl.buildHighlightScript(m, 'x'));
  check('9 种定位方式都能生成可解析的脚本', scripts.every((s) => parses(s)), scripts.map((s) => parses(s)));
  check('同一输入两次生成结果一致（可复现）', hl.buildHighlightScript('css', '#a') === hl.buildHighlightScript('css', '#a'));
  check('selector 里的引号在脚本里被转义且仍可解析', (() => {
    const s = hl.buildHighlightScript('css', 'a[title="x\\y"]');
    return parses(s) && s.indexOf('\\"') > 0;
  })());
  check('name 超过 120 字符会被截断（不把整段文本塞进页面）', (() => {
    const long = 'x'.repeat(300);
    const s = hl.buildHighlightScript('css', '#a', { name: long });
    const m = /"name":"(x+)"/.exec(s);
    return !!m && m[1].length === 120;
  })());
  check('模式大小写在脚本里已归一化', hl.buildHighlightScript('TESTID', 'a').indexOf('"mode":"testid"') > 0);
}

/* ============================================================
 * 5. parseSniffState：页面返回的值不可信
 * ============================================================ */
{
  const empty = hl.parseSniffState(null);
  check('解析：null → 全零事实 + not-found', empty.found === 0 && empty.total === 0 && empty.visible === false && empty.reason === 'not-found', empty);
  check('解析：字符串垃圾也不抛', hl.parseSniffState('oops').found === 0);
  check('解析：undefined → 默认值', hl.parseSniffState(undefined).inIframe === false);

  const ok = hl.parseSniffState({ found: 3, total: 3, visible: true, inIframe: false, reason: '', label: '登录', href: 'http://a/', at: 1700000000000 });
  check('解析：正常事实原样保留', ok.found === 3 && ok.total === 3 && ok.visible === true && ok.reason === '' && ok.label === '登录', ok);
  check('解析：at / href 保留（排查用）', ok.at === 1700000000000 && ok.href === 'http://a/', ok);

  check('解析：found=0 时 reason 一定是 not-found（界面靠这个显示没匹配到）', hl.parseSniffState({ found: 0, reason: 'in-iframe' }).reason === 'not-found');
  check('解析：found>0 时 reason 不会被写成 not-found（自相矛盾的值要纠正）', hl.parseSniffState({ found: 2, reason: 'not-found' }).reason === '');
  check('解析：iframe 事实保留', hl.parseSniffState({ found: 2, reason: 'in-iframe', inIframe: true }).reason === 'in-iframe');
  check('解析：认不出的 reason 归空串', hl.parseSniffState({ found: 1, reason: 'weird' }).reason === '');
  check('解析：负数 / NaN / 小数都收敛', (() => {
    const a = hl.parseSniffState({ found: -5 });
    const b = hl.parseSniffState({ found: 'abc' });
    const c = hl.parseSniffState({ found: 2.9 });
    return a.found === 0 && b.found === 0 && c.found === 2;
  })());
  check('解析：total 小于 found 时抬到 found（total 只表示总数）', hl.parseSniffState({ found: 4, total: 1 }).total === 4);
  check('解析：visible 只认真正的 true', hl.parseSniffState({ found: 1, visible: 1 }).visible === false);
  check('解析：label 截断到 200 字符', hl.parseSniffState({ found: 1, label: 'x'.repeat(900) }).label.length === 200);
  check('解析：invalid + error 保留（选择器写错时用）', (() => {
    const r = hl.parseSniffState({ found: 0, invalid: true, error: 'bad selector' });
    return r.invalid === true && r.error === 'bad selector';
  })());
  check('解析：多余字段被丢掉（不把页面的东西透传到界面）', (() => {
    const r = hl.parseSniffState({ found: 1, evil: '<img onerror=1>', cookie: 'a=b' });
    return r.evil === undefined && r.cookie === undefined;
  })());
  check('解析：reason 白名单只有 4 个值', hl.SNIFF_REASONS.join(',') === ',not-found,in-iframe,shadow-dom', hl.SNIFF_REASONS);
}

/* ============================================================
 * 6. browser-session 的纯函数
 * ============================================================ */
{
  check('session：导出 9 个纯函数/常量', ['browserCandidates', 'findBrowser', 'isHttpUrl', 'isPortInRange', 'buildLaunchArgs', 'pickFreePort', 'factsMessage', 'PORT_MIN', 'PORT_MAX'].every((k) => bs[k] !== undefined));

  check('端口范围是需求写的 10000-60000', bs.PORT_MIN === 10000 && bs.PORT_MAX === 60000, [bs.PORT_MIN, bs.PORT_MAX]);
  check('端口判断：范围内', bs.isPortInRange(10000) && bs.isPortInRange(60000) && bs.isPortInRange(31000));
  check('端口判断：范围外/非整数都拒', !bs.isPortInRange(9999) && !bs.isPortInRange(60001) && !bs.isPortInRange('31000') && !bs.isPortInRange(1.5));

  const fakeEnv = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local'
  };
  const cand = bs.browserCandidates(fakeEnv);
  check('候选：Edge 排在 Chrome 前面（需求指定先 Edge）', (() => {
    const firstEdge = cand.findIndex((c) => c.name === 'edge');
    const firstChrome = cand.findIndex((c) => c.name === 'chrome');
    return firstEdge === 0 && firstChrome > firstEdge;
  })(), cand.map((c) => c.name));
  check('候选：Edge 覆盖 Program Files (x86)（本机实测装在这里）', cand.some((c) => c.name === 'edge' && c.path.indexOf('(x86)') > 0), cand);
  check('候选：Edge 也覆盖 Program Files', cand.some((c) => c.name === 'edge' && c.path.indexOf('(x86)') < 0), cand);
  check('候选：Chrome 覆盖 LOCALAPPDATA（本机实测装在这里）', cand.some((c) => c.name === 'chrome' && c.path.indexOf('AppData') > 0), cand);
  check('候选：全部指向 msedge.exe / chrome.exe', cand.every((c) => /(msedge|chrome)\.exe$/.test(c.path)), cand.map((c) => c.path));
  check('候选：没有重复路径', new Set(cand.map((c) => c.path.toLowerCase())).size === cand.length, cand.length);
  check('候选：空环境变量不会拼出相对路径', bs.browserCandidates({}).length === 0, bs.browserCandidates({}));
  check('候选：TT_SNIFF_BROWSER 显式指定排最前（排查用）', bs.browserCandidates({ TT_SNIFF_BROWSER: 'D:\\my\\chrome.exe' })[0].path === 'D:\\my\\chrome.exe');
  check('候选：TT_SNIFF_BROWSER 指向 msedge 时识别成 edge', bs.browserCandidates({ TT_SNIFF_BROWSER: 'D:\\Edge\\msedge.exe' })[0].name === 'edge');
  check('候选：认 CHROME_PATH（和 GUI 冒烟套件同一个约定）', bs.browserCandidates({ CHROME_PATH: 'D:\\c\\chrome.exe' }).some((c) => c.path === 'D:\\c\\chrome.exe'));

  const found = bs.findBrowser(fakeEnv);
  check('findBrowser：返回带 tried 列表的结果（找不到也要能说清找过哪儿）', typeof found === 'object' && Array.isArray(found.tried) && found.tried.length > 0, found);
  check('findBrowser：找不到时 ok=false 且有 message', found.ok === true || found.message.indexOf('没有找到') >= 0, found.message);

  // url 只放 http/https
  const good = ['http://a.test/x', 'https://a.test', 'HTTP://A.TEST', 'http://127.0.0.1:8080/fixture.html'];
  const bad = ['', '   ', 'file:///C:/x.html', 'javascript:alert(1)', 'data:text/html,<b>x', 'ftp://a.test', 'about:blank', 'localhost:8080', '/relative/path', 'chrome://settings'];
  check('url：http / https 放行（4 个样本）', good.every((u) => bs.isHttpUrl(u) === true), good.filter((u) => !bs.isHttpUrl(u)));
  check('url：file/javascript/data/ftp/about/相对路径/chrome: 全拒（11 个样本）', bad.every((u) => bs.isHttpUrl(u) === false), bad.filter((u) => bs.isHttpUrl(u)));
  check('url：null / undefined 不抛', bs.isHttpUrl(null) === false && bs.isHttpUrl(undefined) === false);

  const args = bs.buildLaunchArgs({ port: 34567, userDataDir: 'C:\\data\\sniff-profile', headless: false, url: 'about:blank' });
  check('启动参数：带调试端口', args.indexOf('--remote-debugging-port=34567') >= 0, args);
  check('启动参数：调试口只绑 127.0.0.1', args.indexOf('--remote-debugging-address=127.0.0.1') >= 0, args);
  check('启动参数：独立 profile（--user-data-dir 指向 dataDir/sniff-profile）', args.some((a) => a.indexOf('--user-data-dir=') === 0 && a.indexOf('sniff-profile') > 0), args);
  check('启动参数：不首启/不检查默认浏览器', args.indexOf('--no-first-run') >= 0 && args.indexOf('--no-default-browser-check') >= 0, args);
  check('启动参数：非 headless 时不带 --headless', args.every((a) => a.indexOf('--headless') < 0), args);
  check('启动参数：headless 时带 --headless=new（自动化测试用）', bs.buildLaunchArgs({ port: 12345, userDataDir: 'x', headless: true }).indexOf('--headless=new') >= 0);
  check('启动参数：默认打开 about:blank（随后由 CDP 导航）', args[args.length - 1] === 'about:blank', args[args.length - 1]);

  // 事实 → 人话（只描述，不判对错）
  check('文案：0 个匹配说「没找到匹配的元素」', bs.factsMessage(hl.parseSniffState({ found: 0 })).indexOf('没找到') >= 0);
  check('文案：iframe 里说清「画不了框」', bs.factsMessage(hl.parseSniffState({ found: 2, reason: 'in-iframe', inIframe: true })).indexOf('iframe') >= 0);
  check('文案：shadow DOM 里说清「画不了框」', bs.factsMessage(hl.parseSniffState({ found: 1, reason: 'shadow-dom' })).indexOf('shadow') >= 0);
  check('文案：不可见时说「红色虚线框」', bs.factsMessage(hl.parseSniffState({ found: 1, visible: false })).indexOf('虚线') >= 0);
  check('文案：可见时带上元素名', bs.factsMessage(hl.parseSniffState({ found: 1, visible: true, label: '登录' })).indexOf('登录') >= 0);
  check('文案：选择器写错时给原因', bs.factsMessage(hl.parseSniffState({ found: 0, invalid: true, error: 'boom' })).indexOf('boom') >= 0);
}

/* ============================================================
 * 6.5 v0.56 真机 bug 修复：浏览器选择 / 残留清理判据 / pid 账本
 * ============================================================ */
{
  /* ---------------- 6.5.1 常量与「目录名/账本名」约定 ---------------- */
  check('v0.56：profile 目录名固定 sniff-profile（命令行校验靠它）', bs.PROFILE_DIR_NAME === 'sniff-profile', bs.PROFILE_DIR_NAME);
  check('v0.56：pid 账本文件名是 tt-pids.json', bs.PID_FILE_NAME === 'tt-pids.json', bs.PID_FILE_NAME);
  check('v0.56：浏览器选择只有 auto / edge / chrome', bs.BROWSER_CHOICES.join(',') === 'auto,edge,chrome', bs.BROWSER_CHOICES);
  check('v0.56：默认浏览器选择是 auto（不写也不换浏览器）', bs.DEFAULT_BROWSER_CHOICE === 'auto', bs.DEFAULT_BROWSER_CHOICE);

  /* ---------------- 6.5.2 注册表 ProgId → 浏览器名 ---------------- */
  check('ProgId：ChromeHTML → chrome（用户默认 Chrome 就该用 Chrome）', bs.progIdToBrowser('ChromeHTML') === 'chrome', bs.progIdToBrowser('ChromeHTML'));
  check('ProgId：ChromeHTML 带后缀也认（真机上偶见 ChromeHTML.PROGID）', bs.progIdToBrowser('ChromeHTML.abc123') === 'chrome', bs.progIdToBrowser('ChromeHTML.abc123'));
  check('ProgId：MSEdgeHTM → edge', bs.progIdToBrowser('MSEdgeHTM') === 'edge', bs.progIdToBrowser('MSEdgeHTM'));
  check('ProgId：大小写不敏感', bs.progIdToBrowser('chromehtml') === 'chrome' && bs.progIdToBrowser('msedgehtm') === 'edge');
  check('ProgId：别的浏览器（Firefox）认不出 → 空串', bs.progIdToBrowser('FirefoxURL-308046B0AF4A39CB') === '', bs.progIdToBrowser('FirefoxURL-308046B0AF4A39CB'));
  check('ProgId：PDF 阅读器之类也认不出 → 空串', bs.progIdToBrowser('AcrobatURL') === '' && bs.progIdToBrowser('IE.HTTP') === '');
  check('ProgId：空 / null / undefined 都不抛', bs.progIdToBrowser('') === '' && bs.progIdToBrowser(null) === '' && bs.progIdToBrowser(undefined) === '');

  check('注册表：reg query 的 ProgId 行能解析出来', (() => {
    const fake = () => ({ status: 0, stdout: '\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n\r\n', stderr: '' });
    return bs.readDefaultBrowserProgId({ spawnSync: fake }) === 'ChromeHTML';
  })());
  check('注册表：reg 失败/没有这个键 → 空串（不抛、不瞎猜）', (() => {
    const fail = () => ({ status: 1, stdout: '', stderr: 'reg: 找不到指定的注册表项' });
    const crash = () => {
      throw new Error('reg 不在');
    };
    return bs.readDefaultBrowserProgId({ spawnSync: fail }) === '' && bs.readDefaultBrowserProgId({ spawnSync: crash }) === '';
  })());
  check('注册表：注入 defaultProgId 时不去碰注册表（单测/排查用）', bs.readDefaultBrowserProgId({ defaultProgId: 'MSEdgeHTM', spawnSync: () => { throw new Error('不该被调用'); } }) === 'MSEdgeHTM');
  check('注册表：http 键认得出浏览器就只读一次（以需求写的 http 键为准）', (() => {
    const calls = [];
    const fake = (cmd, args) => {
      calls.push(args[1]);
      return { status: 0, stdout: '    ProgId    REG_SZ    MSEdgeHTM\r\n', stderr: '' };
    };
    const got = bs.readDefaultBrowserProgId({ spawnSync: fake });
    return got === 'MSEdgeHTM' && calls.length === 1 && /\\http\\/.test(calls[0]);
  })());
  check('注册表：http 键是 PDF 阅读器之类（认不出）→ 补看 https 键', (() => {
    const fake = (cmd, args) => {
      const key = String(args[1] || '');
      const prog = /\\https\\/i.test(key) ? 'MSEdgeHTM' : 'AcrobatURL';
      return { status: 0, stdout: '    ProgId    REG_SZ    ' + prog + '\r\n', stderr: '' };
    };
    return bs.readDefaultBrowserProgId({ spawnSync: fake }) === 'MSEdgeHTM';
  })());
  check('注册表：http 键不存在但 https 键有浏览器 → 用 https 的', (() => {
    const fake = (cmd, args) => {
      const isHttps = /\\https\\/i.test(String(args[1] || ''));
      return isHttps
        ? { status: 0, stdout: '    ProgId    REG_SZ    ChromeHTML\r\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'reg: 找不到指定的注册表项' };
    };
    return bs.readDefaultBrowserProgId({ spawnSync: fake }) === 'ChromeHTML';
  })());
  check('注册表：两个键都不是浏览器 → 回 http 原值（日志能看出「默认是别的程序」）', (() => {
    const fake = (cmd, args) => {
      const prog = /\\https\\/i.test(String(args[1] || '')) ? 'FirefoxURL-x' : 'AcrobatURL';
      return { status: 0, stdout: '    ProgId    REG_SZ    ' + prog + '\r\n', stderr: '' };
    };
    return bs.readDefaultBrowserProgId({ spawnSync: fake }) === 'AcrobatURL';
  })());

  /* ---------------- 6.5.3 入参 browser 解析 ---------------- */
  check('入参：不传 / null / 空串 → auto', (() => {
    return bs.parseBrowserChoice(undefined).choice === 'auto' && bs.parseBrowserChoice(null).choice === 'auto' && bs.parseBrowserChoice('  ').choice === 'auto';
  })());
  check('入参：auto / edge / chrome 原样收下（大小写、空格都能容错）', ['auto', 'edge', 'chrome', ' EDGE ', 'Chrome'].every((v) => bs.parseBrowserChoice(v).ok === true && bs.parseBrowserChoice(v).choice === v.trim().toLowerCase()));
  check('入参：写错了要明确报错（不能悄悄当 auto）', (() => {
    const r = bs.parseBrowserChoice('firefox');
    return r.ok === false && String(r.message).indexOf('auto / edge / chrome') >= 0;
  })(), bs.parseBrowserChoice('firefox'));
  check('归一化：认不出的一律 auto（内部兜底用）', bs.normalizeBrowserChoice('firefox') === 'auto' && bs.normalizeBrowserChoice(undefined) === 'auto');

  /* ---------------- 6.5.4 选浏览器：auto 真的跟着系统默认走 ---------------- */
  // 用临时目录造「装了哪些浏览器」的假环境，绝不碰本机真实安装
  const candRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-cand-'));
  const touch = (rel) => {
    const p = path.join(candRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    return p;
  };
  try {
    const candEnv = {
      ProgramFiles: path.join(candRoot, 'pf'),
      'ProgramFiles(x86)': path.join(candRoot, 'pf86'),
      LOCALAPPDATA: path.join(candRoot, 'local')
    };
    const edgeExe = touch('pf86/Microsoft/Edge/Application/msedge.exe');
    const chromeExe = touch('local/Google/Chrome/Application/chrome.exe');

    const autoChrome = bs.resolveBrowser('auto', candEnv, { defaultProgId: 'ChromeHTML' });
    check('auto：系统默认是 Chrome 就用 Chrome（bug3 的核心）', autoChrome.ok === true && autoChrome.name === 'chrome' && autoChrome.path === chromeExe, autoChrome);
    check('auto：默认浏览器优先时 source=default-browser', autoChrome.source === 'default-browser', autoChrome.source);
    check('auto：返回值里 chosen 仍是 auto（界面回显用）', autoChrome.chosen === 'auto', autoChrome.chosen);

    const autoEdge = bs.resolveBrowser('auto', candEnv, { defaultProgId: 'MSEdgeHTM' });
    check('auto：系统默认是 Edge 就用 Edge', autoEdge.ok === true && autoEdge.name === 'edge' && autoEdge.path === edgeExe, autoEdge);

    const autoUnknown = bs.resolveBrowser('auto', candEnv, { defaultProgId: 'FirefoxURL-xxx' });
    check('auto：认不出默认浏览器 → Edge → Chrome 兜底（先 Edge）', autoUnknown.ok === true && autoUnknown.name === 'edge', autoUnknown);

    const autoNone = bs.resolveBrowser('auto', candEnv, { defaultProgId: '' });
    check('auto：连 ProgId 都读不到也照样先 Edge', autoNone.ok === true && autoNone.name === 'edge', autoNone);

    // 把 Edge 挪走 → 只剩 Chrome
    fs.renameSync(edgeExe, edgeExe + '.bak');
    const fallbackChrome = bs.resolveBrowser('auto', candEnv, { defaultProgId: 'MSEdgeHTM' });
    check('auto：默认是 Edge 但只有 Chrome 能启动 → 退到 Chrome 并标记 fallback', fallbackChrome.ok === true && fallbackChrome.name === 'chrome' && fallbackChrome.source === 'fallback', fallbackChrome);

    const explicitChrome = bs.resolveBrowser('chrome', candEnv, { defaultProgId: 'MSEdgeHTM' });
    check('显式 chrome：照办，不看默认浏览器', explicitChrome.ok === true && explicitChrome.name === 'chrome' && explicitChrome.source === 'explicit', explicitChrome);
    const missEdge = bs.resolveBrowser('edge', candEnv, { defaultProgId: 'ChromeHTML' });
    check('显式 edge 但本机没装 → 明确报错（不偷偷换 Chrome）', missEdge.ok === false && String(missEdge.message).indexOf('指定用 Edge') >= 0, missEdge);
    check('显式 edge 报错文案里说清找过几个位置', /找过 \d+ 个位置/.test(String(missEdge.message)), missEdge.message);

    fs.renameSync(edgeExe + '.bak', edgeExe);
    const backToEdge = bs.resolveBrowser('edge', candEnv, { defaultProgId: '' });
    check('挪回来之后显式 edge 又能找到', backToEdge.ok === true && backToEdge.name === 'edge' && backToEdge.path === edgeExe, backToEdge);

    check('显式选择写错（firefox）→ 明确错误，不静默', bs.resolveBrowser('firefox', candEnv, { defaultProgId: '' }).ok === false);
    check('一台浏览器都没有 → ok:false + 明确文案', bs.resolveBrowser('auto', { LOCALAPPDATA: path.join(candRoot, 'empty') }, { defaultProgId: '' }).ok === false);
  } finally {
    try {
      fs.rmSync(candRoot, { recursive: true, force: true });
    } catch (e) {
      /* 临时目录删不掉就留着 */
    }
  }

  /* ---------------- 6.5.5 残留清理判据（bug2） ---------------- */
  const P = 'C:\\Users\\t\\AppData\\Local\\Temp\\sniff-e2e-1\\sniff-profile';
  check('认领：命令行同时含 profile 绝对路径 + sniff-profile → 是我们的', bs.isOurProfileCommand('"C:\\x\\msedge.exe" --user-data-dir=C:\\Users\\t\\AppData\\Local\\Temp\\sniff-e2e-1\\sniff-profile --remote-debugging-port=0', P) === true);
  check('认领：别的会话（不同 profile 目录）→ 不是我们的，绝不碰', bs.isOurProfileCommand('"C:\\x\\msedge.exe" --user-data-dir=C:\\Users\\t\\AppData\\Local\\Temp\\sniff-e2e-2\\sniff-profile', P) === false);
  check('认领：用户自己的浏览器（没有 sniff-profile）→ 不碰', bs.isOurProfileCommand('"C:\\x\\msedge.exe" --profile-directory=Default', P) === false);
  check('认领：斜杠方向 / 大小写不影响判断', bs.isOurProfileCommand('"c:/users/T/appdata/local/temp/SNIFF-E2E-1/sniff-profile/msedge.exe"', P) === true);
  check('认领：空命令行 → false（不认识就不动）', bs.isOurProfileCommand('', P) === false && bs.isOurProfileCommand(null, P) === false);
  check('认领：没有 profileDir 时退回「含 sniff-profile 标记」', bs.isOurProfileCommand('--user-data-dir=D:\\d\\sniff-profile', '') === true);

  check('主进程识别：没有 --type= 的是浏览器主进程', bs.isMainBrowserProcess('"C:\\x\\msedge.exe" --user-data-dir=... --remote-debugging-port=0') === true);
  check('主进程识别：--type=renderer / gpu-process 都不算主进程（窗口只有主进程那个）', bs.isMainBrowserProcess('msedge.exe --type=renderer --user-data-dir=...') === false && bs.isMainBrowserProcess('msedge.exe --type=gpu-process') === false);

  check('进程名白名单：msedge/chrome/chromium 认，别的一律不认', (() => {
    return bs.isBrowserProcessName('msedge.exe') && bs.isBrowserProcessName('chrome.exe') && bs.isBrowserProcessName('CHROME.EXE') && bs.isBrowserProcessName('chromium.exe') && !bs.isBrowserProcessName('notepad.exe') && !bs.isBrowserProcessName('msedgewebview2.exe') && !bs.isBrowserProcessName('');
  })());

  check('进程列表解析：单个对象也能解析（PowerShell 只有一条时不是数组）', (() => {
    const r = bs.parseProcessList(JSON.stringify({ ProcessId: 42, Name: 'msedge.exe', CommandLine: '--user-data-dir=' + P }));
    return r.ok === true && r.list.length === 1 && r.list[0].pid === 42 && r.list[0].name === 'msedge.exe' && r.list[0].cmd.indexOf('sniff-profile') > 0;
  })());
  check('进程列表解析：数组 / 空输出 / BOM 都稳', (() => {
    const arr = bs.parseProcessList(JSON.stringify([{ ProcessId: 1, Name: 'chrome.exe', CommandLine: 'a' }, { ProcessId: 2, Name: 'msedge.exe', CommandLine: 'b' }]));
    const empty = bs.parseProcessList('');
    const nullOut = bs.parseProcessList('null');
    const bom = bs.parseProcessList('\uFEFF' + JSON.stringify([{ ProcessId: 3, Name: 'chrome.exe', CommandLine: 'c' }]));
    return arr.list.length === 2 && empty.list.length === 0 && nullOut.list.length === 0 && bom.list.length === 1;
  })());
  check('进程列表解析：垃圾输出 → ok:false（上层据此「不敢乱杀」）', (() => {
    const bad = bs.parseProcessList('Get-CimInstance : 拒绝访问');
    return bad.ok === false && bad.list.length === 0;
  })());

  check('collectOwnedPids：账本里的 pid 必须命令行验明才认领，其它只记 skipped', (() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-own-'));
    const dir = path.join(root, 'sniff-profile');
    try {
      bs.writePidFile(dir, { pids: [11, 12, 13], browser: 'edge', exe: 'msedge.exe' }, { replace: true });
      const fakeList = () => ({
        status: 0,
        stdout: JSON.stringify([
          { ProcessId: 11, Name: 'msedge.exe', CommandLine: '"C:\\x\\msedge.exe" --user-data-dir=' + dir },
          // 12 号 pid 被系统复用成了记事本 → 名字就不对
          { ProcessId: 12, Name: 'notepad.exe', CommandLine: 'notepad.exe D:\\note.txt' },
          // 13 号 pid 命令行里没有我们的 profile（不认识的 pid 一律不碰）
          { ProcessId: 13, Name: 'msedge.exe', CommandLine: '"C:\\x\\msedge.exe" --profile-directory=Default' },
          // 14 号没记账但命令行明确写着我们 profile（上一轮的子孙进程）
          { ProcessId: 14, Name: 'msedge.exe', CommandLine: '"C:\\x\\msedge.exe" --type=renderer --user-data-dir=' + dir }
        ]),
        stderr: ''
      });
      const r = bs.collectOwnedPids(dir, { spawnSync: fakeList });
      const ours = r.ours.map((p) => p.pid).sort((a, b) => a - b);
      const skipped = r.skipped.map((s) => s.pid).sort((a, b) => a - b);
      return JSON.stringify(ours) === '[11,14]' && JSON.stringify(skipped) === '[12,13]';
    } finally {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    }
  })(), '按命令行验明正身的判据不对');

  /* ---------------- 6.5.6 pid 账本（tt-pids.json） ---------------- */
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-pids-'));
    const dir = path.join(root, 'sniff-profile');
    try {
      check('账本：路径落在 <profile>/tt-pids.json', bs.pidFilePath(dir) === path.join(dir, 'tt-pids.json'), bs.pidFilePath(dir));
      check('账本：没写过时是空账本（不抛）', bs.readPidFile(dir).pids.length === 0);
      bs.writePidFile(dir, { pids: [100], browser: 'edge', exe: 'C:\\x\\msedge.exe' });
      check('账本：启动后立即写就能读回来', (() => {
        const r = bs.readPidFile(dir);
        return r.pids.join(',') === '100' && r.browser === 'edge' && r.exe === 'C:\\x\\msedge.exe';
      })(), bs.readPidFile(dir));
      bs.writePidFile(dir, { pids: [200] });
      check('账本：默认合并 pid（启动 pid + 盘点到的子孙 pid 都要留底）', bs.readPidFile(dir).pids.sort((a, b) => a - b).join(',') === '100,200', bs.readPidFile(dir).pids);
      bs.writePidFile(dir, { pids: [300] }, { replace: true });
      check('账本：replace=true 时整体替换（清理后把死 pid 去掉）', bs.readPidFile(dir).pids.join(',') === '300', bs.readPidFile(dir).pids);
      check('账本：坏 JSON / 垃圾 pid 都收敛成空账本', (() => {
        fs.writeFileSync(bs.pidFilePath(dir), '{不是 JSON', 'utf8');
        const bad = bs.readPidFile(dir);
        bs.writePidFile(dir, { pids: ['abc', -1, 0, 4.5, 501] }, { replace: true });
        const mixed = bs.readPidFile(dir);
        return bad.pids.length === 0 && mixed.pids.join(',') === '501';
      })());
      bs.clearPidFile(dir);
      check('账本：clear 之后文件没了（不抛）', !fs.existsSync(bs.pidFilePath(dir)));
      check('账本：profileDir 为空时写不进去但也不抛', bs.writePidFile('', { pids: [1] }).ok === false);
    } finally {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* ---------------- 6.5.7 静态：三个 bug 的修法必须在源码里 ---------------- */
  const BS_CODE = BS_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('bug1：等就绪不再看子进程 exitCode（只认 DevToolsActivePort + /json/version）', !/exitCode/.test(BS_CODE), '还在用 exitCode 判就绪');
  check('bug1：waitForDevTools 签名里没有 child 参数', /async function waitForDevTools\(profileDir, timeoutMs\)/.test(BS_CODE));
  check('bug1：子进程 exit / error 只记日志（注释里写明不代表浏览器退出）', /child\.on\('exit'/.test(BS_CODE) && /只记日志/.test(BS_SRC));
  check('bug2：不再换「干净 profile」重试（那是第二个窗口的来源）', BS_CODE.indexOf('sniff-profile-clean') < 0, 'still has clean-profile retry');
  check('bug2：重试只挂在 DAP 超时上', /first\.reason !== 'dap-timeout'/.test(BS_CODE), 'retry condition missing');
  check('bug2：重试前先 killOwnedAndWait（先杀再试）', /first\.reason !== 'dap-timeout'[\s\S]{0,900}killOwnedAndWait/.test(BS_CODE));
  check('bug2：启动前先清残留（cleanupResidual 在 launchOnce 之前）', /cleanupResidual\(profileDir\)[\s\S]{0,900}launchOnce\(/.test(BS_CODE));
  check('bug2：pid 账本文件名常量与 writePidFile/readPidFile 都在', /PID_FILE_NAME = 'tt-pids\.json'/.test(BS_CODE) && /function writePidFile/.test(BS_CODE) && /function readPidFile/.test(BS_CODE));
  check('bug2：stop 三级（Browser.close → taskkill → 报错）', /Browser\.close/.test(BS_CODE) && /level: 'taskkill'/.test(BS_CODE) && /level: 'failed'/.test(BS_CODE));
  check('bug2：关不掉时如实返回 ok:false（不假装关掉了）', /ok: false,\s*level: 'failed'/.test(BS_CODE), 'no failed result');
  check('bug3：resolveBrowser 支持 auto / edge / chrome', /function resolveBrowser\(choice, env, options\)/.test(BS_CODE) && /source: 'explicit'/.test(BS_CODE) && /'default-browser'/.test(BS_CODE));
  check('bug3：auto 才读注册表（显式选择不去碰）', (() => {
    const at = BS_CODE.indexOf("if (chosen === 'edge' || chosen === 'chrome')");
    const autoAt = BS_CODE.indexOf('const progId =');
    return at > 0 && autoAt > at;
  })());
  check('bug3：返回值里有 browserChosen（界面回显用）', /browserChosen: current\.browserChoice/.test(BS_CODE), 'no browserChosen');
  check('bug3：已有会话但浏览器变了 → 先停旧的再起新的', /先关旧会话再起新的/.test(BS_SRC) && /stopInternal\(\)/.test(BS_CODE));
}

/* ============================================================
 * 7. ipc-sniff 的安全约定（静态）
 * ============================================================ */
{
  const ipcCode = IPC_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('ipc：url 校验走 isHttpUrl（不是 assertPathIn —— 那是文件路径守卫）', /isHttpUrl\(url\)/.test(ipcCode) && ipcCode.indexOf('assertPathIn') < 0, 'assertPathIn found');
  check('ipc：非法 url 直接回 ok:false（reject）', /return sniffer\.reject\(URL_REJECT\)/.test(IPC_SRC));
  check('ipc：6 个通道每个都显式 assertUnlocked', (IPC_SRC.match(/assertUnlocked\(\)/g) || []).length === 6, (IPC_SRC.match(/assertUnlocked\(\)/g) || []).length);
  check('ipc：没有直接碰 ipcMain（统一走 deps.handle）', IPC_SRC.indexOf('ipcMain') < 0);
  check('ipc：before-quit 里同步杀浏览器（应用退出不留残尸）', /before-quit/.test(IPC_SRC) && /stopSync\(\)/.test(IPC_SRC));
  check('ipc：process exit 也兜了一层', /process\.on\('exit'/.test(IPC_SRC));
  check('ipc：不 require electron（域模块靠 deps 注入）', !/require\(\s*['"]electron['"]\s*\)/.test(IPC_SRC));
  check('cdp.js 只发我们自己的命令（没有 Network/Storage/Cookie 域）', !/Network\.|Storage\.|Cookie/.test(CDP_SRC), 'forbidden domain');
  check('browser-session 里没有裸的 ipcMain.handle', !/ipcMain\.handle\(/.test(BS_SRC));

  /* ---- v0.55：codegen 录制语言（Python 系 / Java）---- */
  check('ipc：codegen 接受 lang 参数（python / pytest / java）', /payload[\s\S]{0,120}lang/.test(IPC_SRC) && IPC_SRC.indexOf("'java'") >= 0, 'no lang');
  check('ipc：Java 录制先探测 npx playwright（spawnSync）', /probeNodePlaywright/.test(IPC_SRC) && /npx playwright --version/.test(IPC_SRC), 'no probe');
  check('ipc：探测绝不联网/自动安装（npm_config_offline + yes=false）', /npm_config_offline/.test(IPC_SRC) && /npm_config_yes/.test(IPC_SRC), 'probe may go online');
  check('ipc：Java 探测失败回 NO_NODE_PLAYWRIGHT + 明确降级文案', /NO_NODE_PLAYWRIGHT/.test(IPC_SRC) && /不会自动安装、也不会联网下载/.test(IPC_SRC), 'no fallback message');
  check('ipc：Java 录制命令是 npx playwright codegen --target java', /playwright codegen --target java/.test(IPC_SRC), 'no java command');
  check('ipc：python 系仍走 python -m playwright codegen（原路径不变）', /'playwright',\s*'codegen'/.test(IPC_SRC) && /'-m',\s*'playwright',\s*'codegen'/.test(IPC_SRC), 'python command changed');
  check('ipc：Java 走 shell 前先挡掉引号/百分号/换行（UNSAFE_URL）', /UNSAFE_URL/.test(IPC_SRC) && /\["%\\r\\n\]/.test(IPC_SRC), 'unsafe url guard missing');

  /* ---- v0.56：浏览器选择（bug3）---- */
  check(
    'ipc：start / highlight / reopen 都把 browser 透传给会话（不再写死 Edge）',
    /sniffer\.start\(\{ url, name, mode, selector, browser \}\)/.test(IPC_SRC) &&
      /sniffer\.highlight\(\{ name, mode, selector, browser \}\)/.test(IPC_SRC) &&
      /sniffer\.reopen\(\{ url: norm\.url, browser: norm\.browser \}\)/.test(IPC_SRC),
    'browser not forwarded'
  );
  check('ipc：注释里写清 auto / edge / chrome 三种取值', IPC_SRC.indexOf("'auto'") >= 0 && IPC_SRC.indexOf("'edge'") >= 0 && IPC_SRC.indexOf("'chrome'") >= 0);
  check('ipc：返回形状文档里有 browserChosen（界面回显用）', /browserChosen/.test(IPC_SRC));
  check('ipc：browser 不合法时由会话层回明确错误（IPC 不自己瞎兜）', /return sniffer\.reject\(parsed\.message\)|parseBrowserChoice/.test(BS_SRC));

  /* ---- v0.56：reopen 入参兼容拆包（preload 仍是 (url) => invoke(..., {url})）---- */
  check(
    'ipc：reopen 用 normalizeReopenPayload 归一化入参',
    /normalizeReopenPayload\(payload\)/.test(IPC_SRC) && /sniffer\.reopen\(\{ url: norm\.url, browser: norm\.browser \}\)/.test(IPC_SRC)
  );
  check('ipc：reopen 归一化——纯字符串入参当成 url', (() => {
    const r = ipcSniff.normalizeReopenPayload('http://a.test/x');
    return r.url === 'http://a.test/x' && r.browser === undefined;
  })());
  check('ipc：reopen 归一化——{url,browser} 原样通过', (() => {
    const r = ipcSniff.normalizeReopenPayload({ url: 'http://a.test/x', browser: 'chrome' });
    return r.url === 'http://a.test/x' && r.browser === 'chrome';
  })());
  check('ipc：reopen 归一化——能拆开 preload 的 {url:{url,browser}} 包裹（url 与 browser 都不丢）', (() => {
    const r = ipcSniff.normalizeReopenPayload({ url: { url: 'http://a.test/x', browser: 'edge' } });
    return r.url === 'http://a.test/x' && r.browser === 'edge';
  })());
  check('ipc：reopen 归一化——内层没带 browser 时取外层', ipcSniff.normalizeReopenPayload({ url: { url: 'http://a.test/' }, browser: 'chrome' }).browser === 'chrome');
  check('ipc：reopen 归一化——垃圾/空入参 → 空 url（按会话记住的地址重开）', (() => {
    return ipcSniff.normalizeReopenPayload(null).url === '' && ipcSniff.normalizeReopenPayload(42).url === '' && ipcSniff.normalizeReopenPayload({}).url === '';
  })());
}

/* ============================================================
 * 汇总
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
console.log('===== 高亮定位器：纯函数单元测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);