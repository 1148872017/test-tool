/* 代码调试页 · Groovy 模式「导入模板」：插入逻辑 + 页面接线 + 挂载说明 */
const fs = require('fs');
const path = require('path');

const tpl = require('../shared/scriptTemplates.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { TEMPLATES, TEMPLATE_CATEGORIES, GROOVY_CATEGORIES, JMETER_USAGE, templateSnippet, insertCodeAtCursor } = tpl;

/* ============================================================
 * 一、insertCodeAtCursor：纯函数插入逻辑（不碰 DOM，直接单测）
 * ============================================================ */

{
  const SNIP = '// 模板\nlog.info("hi")';

  // 1. 空编辑器 → 直接填满
  {
    const r = insertCodeAtCursor('', SNIP, 0, 0);
    check('空编辑器插入 → 内容就是模板本身', r.text === SNIP, r.text);
    check('空编辑器插入 → 光标在末尾', r.cursor === SNIP.length, r.cursor);
  }

  // 2. 只有空白也算空（否则会在最前面留一个空行）
  {
    const r = insertCodeAtCursor('  \n \n', SNIP, 3, 3);
    check('编辑器只有空白 → 当成空处理，不留前导空行', r.text === SNIP, JSON.stringify(r.text.slice(0, 20)));
  }

  // 3. 光标在末尾 → 追加
  {
    const cur = '第一行\n第二行\n';
    const r = insertCodeAtCursor(cur, SNIP, cur.length, cur.length);
    check('光标在末尾 → 追加（原内容在最前）', r.text.startsWith(cur) && r.text.indexOf(SNIP) > cur.length - 1, r.text);
    check('光标在末尾 → 插入后光标落在插入内容末尾', r.text.slice(0, r.cursor).endsWith(SNIP), r.cursor);
  }

  // 4. 光标在中间 → 前后都在，模板夹中间
  {
    const cur = 'a\nb\nc';
    const pos = 2; // a\n | b\nc
    const r = insertCodeAtCursor(cur, SNIP, pos, pos);
    const i = r.text.indexOf(SNIP);
    check('光标在中间 → 前面的代码还在', r.text.startsWith('a\n'), r.text.slice(0, 8));
    check('光标在中间 → 后面的代码还在', r.text.endsWith('b\nc'), r.text.slice(-8));
    check('光标在中间 → 模板插在光标处（不是行首/行尾）', i > 0 && i < r.text.length - SNIP.length, i);
  }

  // 5. 光标位置 = 插入内容末尾（三种位置都验）
  {
    const cur = 'aaaa\nbbbb\ncccc';
    const cases = [0, 5, 10, cur.length];
    const ok = cases.every((p) => {
      const r = insertCodeAtCursor(cur, SNIP, p, p);
      return r.text.slice(0, r.cursor).endsWith(SNIP);
    });
    check('光标总落在插入内容末尾（开头/行间/结尾都成立）', ok, cases);
  }

  // 6. 光标前不是换行 → 补一个换行（不粘在同一行）
  {
    const r = insertCodeAtCursor('abc', SNIP, 3, 3);
    check('光标前不是换行 → 插入内容另起一行', r.text.startsWith('abc\n' + SNIP), r.text.slice(0, 12));
  }

  // 7. 后面已经挨着换行 → 不再补，避免连续空行
  {
    const cur = 'a\n\nb';
    const r = insertCodeAtCursor(cur, 'X', 2, 2); // a\n | \nb
    check('后面已经是换行 → 不产生新的空行', !/\n\n\n/.test(r.text), JSON.stringify(r.text));
  }
  {
    const cases = [
      ['', 0, 0],
      ['a', 0, 0],
      ['a', 1, 1],
      ['a\n', 2, 2],
      ['a\n\nb', 3, 3],
      ['a\r\nb', 3, 3]
    ];
    const bad = cases.filter(([cur, s, e]) => /\n{3,}/.test(insertCodeAtCursor(cur, 'X', s, e).text));
    check('各种位置插入都不产生连续空行', bad.length === 0, bad);
  }

  // 8. 选中一段再插入 → 选区被替换，两侧保留
  {
    const cur = 'keep DELETEME keep2';
    const r = insertCodeAtCursor(cur, 'X', 5, 13);
    check('有选区时先删掉选区再插入', !r.text.includes('DELETEME'), r.text);
    check('有选区时两侧内容都保留', r.text.startsWith('keep ') && r.text.endsWith(' keep2'), r.text);
  }

  // 9. 越界 / 反向选区不炸
  {
    const r1 = insertCodeAtCursor('abc', 'X', 999, 999);
    check('越界光标被钳到末尾', r1.text.startsWith('abc') && r1.text.indexOf('X') >= 3, r1.text);
    const r2 = insertCodeAtCursor('abc', 'X', 2, 1);
    check('终点小于起点时不抛异常且内容不丢', typeof r2.text === 'string' && r2.text.includes('ab') && r2.text.includes('c'), r2.text);
    const r3 = insertCodeAtCursor(null, 'X');
    check('入参为空也不炸（占位默认值）', r3.text === 'X' && r3.cursor === 1, r3);
  }
}

/* ============================================================
 * 二、templateSnippet：占位符填默认值 + 挂载说明
 * ============================================================ */

{
  const assertTpl = TEMPLATES.find((t) => t.id === 'assert-code');
  const snippet = templateSnippet(assertTpl);

  check(
    '断言模板插入时带「JMeter 里加到哪」的用法注释',
    /\/\/ 用法：JMeter 里「右键采样器 → 添加 → 断言 → JSR223 断言」/.test(snippet),
    snippet.split('\n').slice(0, 2)
  );
  check(
    '断言模板说明「调试页只验证语法，真正生效要在 JMeter 挂载」',
    /在代码调试页运行只能验证语法，真正生效要在 JMeter 里挂载/.test(snippet),
    snippet.split('\n').slice(0, 3)
  );
  check('插入的代码只剩模板本身（默认值已填，没有 {{占位符}}）', !/\{\{/.test(snippet), (snippet.match(/\{\{[^}]*\}\}/g) || []).slice(0, 3));
  check(
    '插入的代码保留了模板里的「为什么」注释',
    /\/\/ prev 是 JMeter 内置对象/.test(snippet),
    snippet.split('\n').slice(0, 6)
  );
  check('插入的代码里默认值真的填进去了', /String expected = "200";/.test(snippet), snippet.match(/String expected[^\n]*/));

  // JSON 字段模板：两个占位符都填
  {
    const jsonSnippet = templateSnippet(TEMPLATES.find((t) => t.id === 'assert-json-field'));
    check(
      'JSON 断言模板的占位符按默认值填（路径 + 期望值）',
      /def actual = json\.data\.status/.test(jsonSnippet) && /def expected = "SUCCESS"/.test(jsonSnippet),
      jsonSnippet.slice(0, 80)
    );
  }

  // 非 JMeter 分类（RestAssured / Playwright）不该冒充 JMeter 脚本
  {
    const apiTpl = TEMPLATES.find((t) => t.category === 'api-assert');
    const apiSnippet = templateSnippet(apiTpl);
    check('非 JMeter 模板不加 JMeter 挂载说明', !/在代码调试页运行只能验证语法/.test(apiSnippet), apiSnippet.slice(0, 40));
    check('非 JMeter 模板仍原样填默认值', apiSnippet === tpl.fillTemplateDefaults(apiTpl.code, apiTpl.vars), 'differs');
  }

  // 所有能进下拉的模板都必须带挂载说明（否则用户以为调试页跑通就生效了）
  {
    const groovyTpls = TEMPLATES.filter((t) => GROOVY_CATEGORIES.indexOf(t.category) >= 0);
    check('能进下拉的模板数量 >= 10', groovyTpls.length >= 10, groovyTpls.length);
    const missing = groovyTpls.filter((t) => !/真正生效要在 JMeter 里挂载/.test(templateSnippet(t)));
    check('每个可导入模板都带 JMeter 挂载说明', missing.length === 0, missing.map((t) => t.id));
    const noUsage = GROOVY_CATEGORIES.filter((k) => !/用法：/.test(JMETER_USAGE[k] || ''));
    check('每个可导入分类都有「用法：」说明', noUsage.length === 0, noUsage);
    check('可导入分类不含 RestAssured / Playwright 那些', GROOVY_CATEGORIES.indexOf('api-assert') < 0 && GROOVY_CATEGORIES.indexOf('ui-assert') < 0, GROOVY_CATEGORIES);
  }

  // 插入整段断言：语法上还是一段可运行代码（括号配对粗检）
  {
    const stripped = templateSnippet(TEMPLATES.find((t) => t.id === 'assert-json-field'))
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/\/\/.*$/gm, '');
    const ok = ['{', '(', '['].every((open) => {
      const close = { '{': '}', '(': ')', '[': ']' }[open];
      return (stripped.match(new RegExp('\\' + open, 'g')) || []).length === (stripped.match(new RegExp('\\' + close, 'g')) || []).length;
    });
    check('插入的断言语括号仍然配对（没被拼接弄坏）', ok, stripped.slice(0, 60));
  }
}

/* ============================================================
 * 三、CodeRunnerPage 接线（源码断言）
 * ============================================================ */

{
  const page = read('src/pages/CodeRunnerPage.tsx');

  check('调试页从 shared/scriptTemplates 取模板数据', /from '\.\.\/\.\.\/shared\/scriptTemplates'/.test(page), 'no import');
  check(
    '调试页 import 了 GROOVY_CATEGORIES / templateSnippet / insertCodeAtCursor',
    /GROOVY_CATEGORIES/.test(page) && /templateSnippet/.test(page) && /insertCodeAtCursor/.test(page),
    'missing import'
  );
  check('有 isGroovy 判定', /const isGroovy = runnerKey === 'groovy'/.test(page), 'no isGroovy');
  check('有「导入模板」入口', /导入模板/.test(page), 'no entry');
  check('模板菜单按 GROOVY_CATEGORIES 过滤分类（不另写一份清单）', /GROOVY_CATEGORIES\.map\(\(key\) =>/.test(page), 'no filter');
  check('菜单顺序由 GROOVY_CATEGORIES 决定，断言排第一', GROOVY_CATEGORIES[0] === 'assert', GROOVY_CATEGORIES[0]);
  check(
    '菜单项从 TEMPLATES 里按 category 取（数据同源）',
    /SCRIPT_TEMPLATES\.filter\(\(t\) => t\.category === key\)/.test(page),
    'hardcoded list?'
  );

  // 「导入模板」必须只在 Groovy 模式下渲染：把 {isGroovy ? ( ... ) : null} 这一块抠出来看
  const start = page.indexOf('{isGroovy ? (');
  const end = start < 0 ? -1 : page.indexOf(') : null}', start);
  const groovyBlock = start >= 0 && end > start ? page.slice(start, end) : '';
  check('「导入模板」写在 isGroovy 条件块里（其他运行器不显示）', groovyBlock.includes('导入模板'), groovyBlock.length);
  check('这个条件块里没有「运行」按钮（入口只多不少，不动原有按钮）', !/onClick=\{doRun\}/.test(groovyBlock), 'run button inside block');
  check('条件块内有完整模板库入口', /完整模板库/.test(groovyBlock) && /onPickTemplate=\{insertTemplate\}/.test(page), 'no drawer entry');

  // 插入：用纯函数 + 拿真实光标 + 光标回位
  check('插入走 templateSnippet（占位符 + 用法注释）', /const snippet = templateSnippet\(tpl\)/.test(page), 'no snippet');
  check(
    '插入用的是真实选区（selectionStart / selectionEnd）',
    /insertCodeAtCursor\(code, snippet, ta\.selectionStart, ta\.selectionEnd\)/.test(page),
    'no selection'
  );
  check('编辑器挂上了 ref（拿光标位置的前提）', /ref=\{textareaRef\}/.test(page) && /const textareaRef = useRef/.test(page), 'no ref');
  check(
    '插入后光标落到插入内容末尾',
    /requestAnimationFrame\(\(\) => \{[\s\S]{0,200}setSelectionRange\(res\.cursor, res\.cursor\)/.test(page),
    'cursor not moved'
  );
  check('没有焦点时退化成追加，不丢已有代码', /if \(!ta\) \{[\s\S]{0,160}setCode\(\(cur\) => insertCodeAtCursor\(cur, snippet\)\.text\)/.test(page), 'no fallback');
  check('插入后给了 toast 回执', /已插入模板：/.test(page), 'no toast');
  const duplicated = ['断言：HTTP 状态码', '断言：JSON 字段值等于预期', '提取：从响应拿 token 存变量'].filter((n) => page.indexOf(n) >= 0);
  check('页面里不写死模板名（模板必须来自模板库）', duplicated.length === 0, duplicated);

  // 抽屉：复用现有组件，但换成「插入到光标处」的说法
  check('调试页挂载了 ScriptTemplatesDrawer', /import ScriptTemplatesDrawer from '\.\.\/components\/ScriptTemplatesDrawer'/.test(page), 'no drawer import');
  check('抽屉按钮文案是「插入到光标处」', /pickLabel="插入到光标处"/.test(page), 'label');
  check('抽屉底部说明了「调试页跑通 ≠ 断言生效」', /本页只是用 groovy 跑一遍语法/.test(page), 'no footer hint');
}

/* ============================================================
 * 四、抽屉改造不破坏原有「填入附加代码」语义
 * ============================================================ */

{
  const drawer = read('src/components/ScriptTemplatesDrawer.tsx');
  check('抽屉仍支持 onPick（脚本生成页在用）', /onPick\?: \(item: \{ type: TemplateInsertKind; code: string; name: string \}\) => void/.test(drawer), 'onPick removed');
  check('抽屉新增 onPickTemplate（交整个模板对象）', /onPickTemplate\?: \(tpl: TemplatePickPayload\) => void/.test(drawer), 'no onPickTemplate');
  check('插入按钮文案可覆盖，默认仍是「填入附加代码」', /pickLabel = '填入附加代码'/.test(drawer), 'default label lost');
  check('两个回调都可点（canInsert 兼容两种）', /const canInsert = !!insertKind && \(!!onPick \|\| !!onPickTemplate\)/.test(drawer), 'canInsert');
  check('onPickTemplate 优先，且不改动 onPick 的 payload', /if \(onPickTemplate\) \{/.test(drawer) && /code: fillTemplateDefaults\(active\.code, active\.vars\)/.test(drawer), 'branch');
  check('底部说明可覆盖（默认文案保留）', /footerHint = DEFAULT_FOOTER_HINT/.test(drawer) && /复制后粘到 JMeter GUI 的对应元件里/.test(drawer), 'footer');
}

/* ============================================================
 * 五、模板库本身没被动过（回归）
 * ============================================================ */

check('模板库仍是 18 个 / 7 个分类', TEMPLATES.length === 18 && TEMPLATE_CATEGORIES.length === 7, {
  tpl: TEMPLATES.length,
  cat: TEMPLATE_CATEGORIES.length
});
check(
  '每个可导入分类在模板库里都真有模板',
  GROOVY_CATEGORIES.every((k) => TEMPLATES.some((t) => t.category === k)),
  GROOVY_CATEGORIES.filter((k) => !TEMPLATES.some((t) => t.category === k))
);

/* ---------- 输出 ---------- */
const failed = results.filter((r) => !r.ok);
console.log('===== Groovy 导入模板测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);