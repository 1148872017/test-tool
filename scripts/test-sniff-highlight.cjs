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
 *      · url 只放 http/https；端口范围；启动参数（随机端口 + 只绑 127.0.0.1 + 独立 profile）；
 *      · 事实 → 人话。
 *
 * 真浏览器链路在 scripts/test-sniff-browser.cjs（找不到浏览器会显式 SKIP）。
 *
 * unit 档：不碰本机真实资产、不联网、不 spawn 任何进程。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const hl = require(path.join(ROOT, 'electron', 'sniffer', 'highlight.js'));
const bs = require(path.join(ROOT, 'electron', 'sniffer', 'browser-session.js'));
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
check('ipc-sniff.js 5 个通道全在这里注册', (IPC_SRC.match(/handle\('sniff:/g) || []).length === 5, (IPC_SRC.match(/handle\('sniff:[^']+'/g) || []));

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
 * 7. ipc-sniff 的安全约定（静态）
 * ============================================================ */
{
  const ipcCode = IPC_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('ipc：url 校验走 isHttpUrl（不是 assertPathIn —— 那是文件路径守卫）', /isHttpUrl\(url\)/.test(ipcCode) && ipcCode.indexOf('assertPathIn') < 0, 'assertPathIn found');
  check('ipc：非法 url 直接回 ok:false（reject）', /return sniffer\.reject\(URL_REJECT\)/.test(IPC_SRC));
  check('ipc：5 个通道每个都显式 assertUnlocked', (IPC_SRC.match(/assertUnlocked\(\)/g) || []).length === 5, (IPC_SRC.match(/assertUnlocked\(\)/g) || []).length);
  check('ipc：没有直接碰 ipcMain（统一走 deps.handle）', IPC_SRC.indexOf('ipcMain') < 0);
  check('ipc：before-quit 里同步杀浏览器（应用退出不留残尸）', /before-quit/.test(IPC_SRC) && /stopSync\(\)/.test(IPC_SRC));
  check('ipc：process exit 也兜了一层', /process\.on\('exit'/.test(IPC_SRC));
  check('ipc：不 require electron（域模块靠 deps 注入）', !/require\(\s*['"]electron['"]\s*\)/.test(IPC_SRC));
  check('cdp.js 只发我们自己的命令（没有 Network/Storage/Cookie 域）', !/Network\.|Storage\.|Cookie/.test(CDP_SRC), 'forbidden domain');
  check('browser-session 里没有裸的 ipcMain.handle', !/ipcMain\.handle\(/.test(BS_SRC));
}

/* ============================================================
 * 汇总
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
console.log('===== 高亮定位器：纯函数单元测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);