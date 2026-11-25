'use strict';
/**
 * 代码高亮测试（shared/codeHighlight.js + CodeBlock 接线）
 *
 * ============================================================
 * 这份测试盯什么
 * ============================================================
 * 1. **7 种语言的 token 分类对不对**（java / python / json / xml(jmx) / sql /
 *    bash+powershell / groovy）：关键字、字符串、注释、数字、函数名各验一遍；
 * 2. **两条最容易写错的判定**（这两条一错，整页代码就是花脸）：
 *      · 字符串里的关键字**不许**染色（"public class" 里没有 public 关键字 token）；
 *      · 注释里的引号**不许**开启新字符串（// it's a "comment 后面不会多出一个 string）；
 * 3. **未闭合字符串 / 未闭合块注释不抛错**（用户粘贴半截代码是常态）；
 * 4. **无损**：所有 token 拼起来必须等于源码本身 —— 高亮只加类型，绝不能改字符
 *    （曾经把 XML 标签里的空格吞掉，`<tg name>` 变成 `<tgname>`，就是靠这条抓出来的）；
 * 5. **detectLang** 认得出 6 种典型片段（再多给 groovy / 纯文本两个兜底用例）；
 * 6. **长文本性能**：5~6 万字级源码单次高亮 < 200ms（设计目标是 50ms 内，
 *    实测值会打印出来，方便以后对比是不是退化了）。
 *
 * 为什么不引高亮库、也不做 DOM 测试：这是纯函数，Node 里直接跑最快最稳；
 * 渲染层（CodeBlock）的行为靠 test-gui-smoke + 源码断言守。
 */
const path = require('path');

const { highlight, detectLang, countLines, limitTokens } = require(path.join(__dirname, '..', 'shared', 'codeHighlight.js'));

const results = [];
const check = (name, cond, extra) => {
  results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
};

/* ============================================================
 * 工具
 * ============================================================ */
/** 某一类型的所有 token 文本 */
function texts(toks, type) {
  return toks.filter((t) => t.type === type).map((t) => t.text);
}
/** 是否有一个该类型、且文本里含 needle 的 token */
function hasType(toks, type, needle) {
  return toks.some((t) => t.type === type && t.text.indexOf(needle) >= 0);
}
/** token 拼回去是否等于原文（无损） */
function lossless(src, toks) {
  return toks.map((t) => t.text).join('') === src;
}
/** 合法 token 类型 */
const TYPES = ['keyword', 'string', 'comment', 'number', 'func', 'tag', 'attr', 'punct', 'plain'];
const typeOk = (toks) => toks.every((t) => TYPES.indexOf(t.type) >= 0);

/* ============================================================
 * 1. Java
 * ============================================================ */
{
  const src = [
    'package demo;',
    'import java.util.List;',
    '// 注释：字符串里的 public 不该染色',
    'public class Demo {',
    '  private static final String NAME = "public static";',
    '  public void run(int count) {',
    '    System.out.println("count = " + 42);',
    '  }',
    '}'
  ].join('\n');
  const toks = highlight(src, 'java');

  check('java 关键字（public / class / import）', hasType(toks, 'keyword', 'public') && hasType(toks, 'keyword', 'class') && hasType(toks, 'keyword', 'import'));
  check('java 字符串', hasType(toks, 'string', '"public static"') && hasType(toks, 'string', '"count = "'));
  check('java 行注释', hasType(toks, 'comment', '// 注释'));
  check('java 数字', hasType(toks, 'number', '42'));
  check('java 函数名（run / println）', texts(toks, 'func').indexOf('run') >= 0 && texts(toks, 'func').indexOf('println') >= 0, texts(toks, 'func'));
  check('java 无损', lossless(src, toks));
  check('java token 类型合法', typeOk(toks));
}

/* ============================================================
 * 2. Python
 * ============================================================ */
{
  const src = [
    '# 注释：字符串里的 def 不该染色',
    'import pytest',
    '',
    'class Demo:',
    '    def test_login(self, page):',
    '        page.goto("https://example.com/def")',
    '        assert 42 == 42',
    '        return 3.14'
  ].join('\n');
  const toks = highlight(src, 'python');

  check('python 关键字（def / class / assert）', hasType(toks, 'keyword', 'def') && hasType(toks, 'keyword', 'class') && hasType(toks, 'keyword', 'assert'));
  check('python 字符串（含 def 的 URL）', hasType(toks, 'string', '"https://example.com/def"'));
  check('python 注释', hasType(toks, 'comment', '# 注释'));
  check('python 数字（42 / 3.14）', hasType(toks, 'number', '42') && hasType(toks, 'number', '3.14'));
  check('python 函数名（test_login / goto）', texts(toks, 'func').indexOf('test_login') >= 0 && texts(toks, 'func').indexOf('goto') >= 0, texts(toks, 'func'));
  check('python 无损', lossless(src, toks));
  check('python token 类型合法', typeOk(toks));
}

/* ============================================================
 * 3. Groovy（JMeter JSR223 脚本；词表兼容 python）
 * ============================================================ */
{
  const src = [
    '// 注释：groovy 的注释',
    'import groovy.json.JsonSlurper',
    'def body = prev.getResponseDataAsString()',
    'def json = new JsonSlurper().parseText(body)',
    'if (json.code == 0) {',
    "  vars.put('token', json.data.token)",
    '}',
    'println "count = 42"'
  ].join('\n');
  const toks = highlight(src, 'groovy');

  check('groovy 关键字（def / new / if）', hasType(toks, 'keyword', 'def') && hasType(toks, 'keyword', 'new') && hasType(toks, 'keyword', 'if'));
  check('groovy 字符串', hasType(toks, 'string', "'token'") && hasType(toks, 'string', '"count = 42"'));
  check('groovy 注释', hasType(toks, 'comment', '// 注释'));
  check('groovy 数字（0）', hasType(toks, 'number', '0'));
  check(
    'groovy 函数名（getResponseDataAsString / parseText / put）',
    ['getResponseDataAsString', 'parseText', 'put'].every((f) => texts(toks, 'func').indexOf(f) >= 0),
    texts(toks, 'func')
  );
  check('groovy 无损', lossless(src, toks));
  check('groovy token 类型合法', typeOk(toks));
}

/* ============================================================
 * 4. JSON
 *
 * 注意：JSON **没有注释语法**，也没有函数概念 —— 这不是漏测：
 * 这里验「键名算 attr、字面量算 keyword、串里的 true 不算 keyword」，
 * 并额外确认 '//' 不会被当成注释吃掉（那会破坏原文显示）。
 * ============================================================ */
{
  const src = JSON.stringify(
    {
      name: 'demo',
      count: 42,
      ratio: 1.5,
      ok: true,
      empty: null,
      list: [1, 2, 3]
    },
    null,
    2
  );
  const toks = highlight(src, 'json');

  check('json 字面量关键字（true / null）', hasType(toks, 'keyword', 'true') && hasType(toks, 'keyword', 'null'));
  check('json 字符串值', hasType(toks, 'string', '"demo"'));
  check('json 键名算 attr', hasType(toks, 'attr', '"name"') && hasType(toks, 'attr', '"list"'), texts(toks, 'attr'));
  check('json 数字（42 / 1.5）', hasType(toks, 'number', '42') && hasType(toks, 'number', '1.5'));
  check('json 无损', lossless(src, toks));
  check('json token 类型合法', typeOk(toks));

  // 字符串里的字面量不许染色
  const quoted = highlight('{"flag": "true"}', 'json');
  check('json 字符串里的 true 不染色', texts(quoted, 'keyword').length === 0, texts(quoted, 'keyword'));

  // '//' 在 JSON 里不是注释（保持原文，只是普通的 punct/plain）
  const slash = highlight('{"url": "http://x/y"}', 'json');
  check('json 不把 // 当注释', texts(slash, 'comment').length === 0, texts(slash, 'comment'));
}

/* ============================================================
 * 5. XML（jmx）
 *
 * 同理：XML 的「数字」是标签文本/属性值的一部分，标记语法里没有数字 token；
 * 这里验 tag / attr / string / comment / punct，再加一条「属性间空格必须保留」。
 * ============================================================ */
{
  const src = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- JMeter 计划：注释里的 <tag> 不该被当成标签 -->',
    '<jmeterTestPlan version="1.2" properties="5.0">',
    '  <hashTree>',
    '    <TestPlan guiclass="TestPlanGui" testname="登录压测" enabled="true"/>',
    '    <stringProp name="ThreadGroup.num_threads">42</stringProp>',
    '  </hashTree>',
    '</jmeterTestPlan>'
  ].join('\n');
  const toks = highlight(src, 'xml');

  check('xml 标签名（jmeterTestPlan / hashTree）', hasType(toks, 'tag', 'jmeterTestPlan') && hasType(toks, 'tag', 'hashTree'));
  check('xml 属性名（version / testname）', hasType(toks, 'attr', 'version') && hasType(toks, 'attr', 'testname'));
  check('xml 属性值算字符串', hasType(toks, 'string', '"1.2"') && hasType(toks, 'string', '"登录压测"'));
  check('xml 注释', hasType(toks, 'comment', '<!-- JMeter 计划'));
  check('xml 标签文本（42）原样保留', hasType(toks, 'plain', '42'));
  check('xml 标签结构的标点', hasType(toks, 'punct', '/>') && hasType(toks, 'punct', '</'));
  check('xml 无损', lossless(src, toks));
  check('xml 属性间空格没被吞（<jmeterTestPlan version 之间仍有空白 token）', hasType(toks, 'plain', ' '));
  check('xml token 类型合法', typeOk(toks));
}

/* ============================================================
 * 6. SQL
 * ============================================================ */
{
  const src = [
    '-- 注释：字符串里的 select 不该染色',
    'SELECT id, name, COUNT(*) AS total',
    'FROM t_order',
    "WHERE amount > 100 AND name LIKE 'select%'",
    'GROUP BY id, name',
    'ORDER BY total DESC;'
  ].join('\n');
  const toks = highlight(src, 'sql');

  check('sql 关键字（大小写不敏感：SELECT / FROM / WHERE）', hasType(toks, 'keyword', 'SELECT') && hasType(toks, 'keyword', 'FROM') && hasType(toks, 'keyword', 'WHERE'));
  check('sql 字符串（内含 select）', hasType(toks, 'string', "'select%'"));
  check('sql 注释', hasType(toks, 'comment', '-- 注释'));
  check('sql 数字（100）', hasType(toks, 'number', '100'));
  check('sql 函数名（COUNT）', texts(toks, 'func').indexOf('COUNT') >= 0, texts(toks, 'func'));
  check('sql 无损', lossless(src, toks));
  check('sql token 类型合法', typeOk(toks));

  // 小写关键字也认（用户手写 SQL 常常全小写）
  const lower = highlight('select 1 from dual', 'sql');
  check('sql 小写关键字也染色', hasType(lower, 'keyword', 'select') && hasType(lower, 'keyword', 'from'));
  // SQL 的 '' 转义
  const esc = highlight("select 'it''s' from dual", 'sql');
  check("sql '' 转义不提前收尾", hasType(esc, 'string', "'it''s'"), texts(esc, 'string'));
}

/* ============================================================
 * 7. Bash / PowerShell（算同一族，两种都验）
 * ============================================================ */
{
  const src = [
    '#!/bin/bash',
    '# 注释：字符串里的 echo 不该染色',
    'export JAVA_HOME="/opt/jdk"',
    'build() {',
    '  mvn -q test',
    '}',
    'echo "done"',
    'sleep 42'
  ].join('\n');
  const toks = highlight(src, 'bash');

  check('bash 关键字（export / sleep 不在词表里，验 export）', hasType(toks, 'keyword', 'export'));
  check('bash 字符串', hasType(toks, 'string', '"/opt/jdk"'));
  check('bash 注释', hasType(toks, 'comment', '# 注释') && hasType(toks, 'comment', '#!/bin/bash'));
  check('bash 数字（42）', hasType(toks, 'number', '42'));
  check('bash 函数名（build）', texts(toks, 'func').indexOf('build') >= 0, texts(toks, 'func'));
  check('bash 变量算 attr（$JAVA_HOME 形式：这里验 $-变量）', hasType(highlight('echo $HOME ${PATH}', 'bash'), 'attr', '$HOME'));
  check('bash 无损', lossless(src, toks));

  const ps = [
    '# 注释：powershell',
    "param($Name)",
    "$path = Join-Path -Path 'C:\\tmp' -ChildPath \"$Name.log\"",
    'Write-Host "hi $Name" # 尾注释',
    'Get-ChildItem $path | Select-Object -First 3',
    '$max = [Math]::Max(1, 2)'
  ].join('\r\n');
  const psToks = highlight(ps, 'powershell');

  check('powershell 关键字（param / function 族）', hasType(psToks, 'keyword', 'param'));
  check('powershell 字符串', hasType(psToks, 'string', "'C:\\tmp'"));
  check('powershell 注释', hasType(psToks, 'comment', '# 注释'));
  check('powershell 数字（3）', hasType(psToks, 'number', '3'));
  check('powershell 函数名（Max）', texts(psToks, 'func').indexOf('Max') >= 0, texts(psToks, 'func'));
  check('powershell 变量算 attr（$Name）', hasType(psToks, 'attr', '$Name'));
  check('powershell 参数算 attr（-Path）', hasType(psToks, 'attr', '-Path'));
  check('powershell 无损（含 \\r\\n）', lossless(ps, psToks));
  check('powershell token 类型合法', typeOk(psToks));
}

/* ============================================================
 * 8. 字符串里的关键字不许染色（测试重点）
 * ============================================================ */
{
  // 每条用例的「串外」都故意只放变量名/等号，不放关键字 ——
  // 这样「关键字 token 数 = 0」就是「串里的关键字没被染色」的硬证据
  const cases = [
    ['java', 's = "public class 42";'],
    ['python', 's = "def class return 42"'],
    ['groovy', 's = "if new def 42"'],
    ['sql', "x = 'from where 42'"],
    ['bash', 's="export 42"'],
    ['json', '{"a": "true"}']
  ];
  for (const [lang, src] of cases) {
    const toks = highlight(src, lang);
    const kw = texts(toks, 'keyword');
    const nums = texts(toks, 'number');
    check(`字符串里的关键字不染色（${lang}）`, kw.length === 0 && nums.length === 0, { kw, nums, src });
    check(`字符串里的内容仍是完整 string token（${lang}）`, toks.some((t) => t.type === 'string' && /public|def|if|from|export|true/.test(t.text)), toks);
  }
}

/* ============================================================
 * 9. 注释里的引号不开启新字符串
 * ============================================================ */
{
  const cases = [
    ['java', "// it's a \"comment\nint x = 1;"],
    ['python', "# don't \"start a string\nx = 1"],
    ['sql', "-- don't \"start\nselect 1"],
    ['bash', "# don't \"start\necho 1"],
    ['groovy', "// don't \"start\ndef x = 1"]
  ];
  for (const [lang, src] of cases) {
    const toks = highlight(src, lang);
    check(`注释里的引号不启新串（${lang}）`, texts(toks, 'string').length === 0, texts(toks, 'string'));
    check(`注释整行吃到行尾（${lang}）`, toks.some((t) => t.type === 'comment' && t.text.indexOf("don't") >= 0 || (t.type === 'comment' && t.text.indexOf("it's") >= 0)), toks);
    check(`注释后面的代码照常染色（${lang}）`, toks.some((t) => t.type === 'keyword' || t.type === 'number'), toks);
  }

  // 块注释：注释里的 */ 之后才恢复正常
  const block = highlight('/* "unclosed quote */ public class A {}', 'java');
  check('块注释里的引号不启新串', texts(block, 'string').length === 0, texts(block, 'string'));
  check('块注释结束后照常染色', hasType(block, 'keyword', 'public'));

  // xml 注释里的 <tag> 不启标签
  const xml = highlight('<!-- <fakeTag a="1"> -->\n<real/>', 'xml');
  check('xml 注释里的标签不染色', texts(xml, 'tag').indexOf('fakeTag') < 0 && texts(xml, 'tag').indexOf('real') >= 0, texts(xml, 'tag'));
}

/* ============================================================
 * 10. 未闭合字符串 / 未闭合注释不抛错，且不吞掉后面几行
 * ============================================================ */
{
  const cases = [
    ['java', 'public class A {\n  String s = "abc\n  int x = 1;\n}'],
    ['python', 'def f():\n    s = "abc\n    return 1'],
    ['python', 'x = """abc\nstill string'],
    ['sql', "select 'abc\nfrom dual"],
    ['bash', "echo 'abc\necho done"],
    ['json', '{"a": "abc'],
    ['java', 'public class A { /* 没闭合'],
    ['xml', '<a name="1"><!-- 没闭合']
  ];
  for (const [lang, src] of cases) {
    let toks = null;
    let err = null;
    try {
      toks = highlight(src, lang);
    } catch (e) {
      err = e;
    }
    check(`未闭合不抛错（${lang}：${JSON.stringify(src.slice(-12))}）`, !err, err && err.message);
    check(`未闭合仍无损（${lang}：${JSON.stringify(src.slice(-12))}）`, toks && lossless(src, toks), toks && toks.map((t) => t.text).join(''));
  }

  // 单行字符串未闭合只在当前行收尾，后面的代码仍然正常着色
  const oneLine = highlight('String s = "abc\nint x = 1;', 'java');
  check('未闭合字符串只吃到行尾', oneLine.some((t) => t.text === 'int') && hasType(oneLine, 'number', '1'), oneLine);
}

/* ============================================================
 * 11. detectLang：6 种典型片段（+ groovy / 纯文本兜底）
 * ============================================================ */
{
  const samples = [
    ['java', 'package com.demo;\n\nimport org.testng.annotations.Test;\n\npublic class LoginTest {\n  @Test\n  public void login() {\n    System.out.println("ok");\n  }\n}'],
    ['python', 'import pytest\n\n\ndef test_login(page):\n    page.goto("https://example.com")\n    assert page.title() == "首页"'],
    ['json', '{\n  "orderNo": "SO202610280001",\n  "amount": 99.9,\n  "items": []\n}'],
    ['xml', '<?xml version="1.0" encoding="UTF-8"?>\n<jmeterTestPlan version="1.2">\n  <hashTree/>\n</jmeterTestPlan>'],
    ['sql', 'SELECT id, name FROM t_order WHERE amount > 100 GROUP BY id'],
    ['bash', '#!/bin/bash\nset -e\nexport JAVA_HOME=/opt/jdk\nmvn -q -Dtest=LoginTest test'],
    ['groovy', 'def body = prev.getResponseDataAsString()\nvars.put("token", body)\nprintln body'],
    ['plain', '这是一段普通说明文字，不是代码']
  ];
  for (const [expect, src] of samples) {
    check(`detectLang 认出 ${expect}`, detectLang(src) === expect, detectLang(src));
  }
  // 空输入兜底
  check('detectLang 空字符串 → plain', detectLang('') === 'plain', detectLang(''));
  check('detectLang null → plain', detectLang(null) === 'plain', detectLang(null));
}

/* ============================================================
 * 12. 语言别名 / 异常输入
 * ============================================================ */
{
  check('别名 jmx → xml', texts(highlight('<a/>', 'jmx'), 'tag').indexOf('a') >= 0, texts(highlight('<a/>', 'jmx'), 'tag'));
  check('别名 .py → python', texts(highlight('def f():', '.py'), 'keyword').indexOf('def') >= 0);
  check('别名 ps1 → powershell', texts(highlight('param($a)', 'ps1'), 'keyword').indexOf('param') >= 0);
  check('别名 sh → bash', texts(highlight('echo $HOME', 'sh'), 'keyword').indexOf('echo') >= 0);
  check('未知语言不抛错', Array.isArray(highlight('x = 1', 'cobol')));
  check(
    'undefined 语言 → 自动识别（public class A {} 认成 java）',
    texts(highlight('public class A {}'), 'keyword').indexOf('public') >= 0,
    texts(highlight('public class A {}'), 'keyword')
  );
  check('空源码返回空数组', highlight('').length === 0 && highlight(null).length === 0 && highlight(undefined).length === 0);
  check('plain 语言只出一个 plain token', highlight('public class', 'plain').length === 1);
}

/* ============================================================
 * 13. 性能：5~6 万字级源码 < 200ms（设计目标 50ms 内）
 * ============================================================ */
{
  const chunk = [
    'public class Big {',
    '  // 注释 comment 不许当代码',
    '  private static final String S = "literal public class 42";',
    '  public int f(int a) { return a * 2 + 42; }',
    '}',
    ''
  ].join('\n');
  let big = '';
  while (big.length < 60000) big += chunk;
  const bigJson = JSON.stringify(
    Array.from({ length: 900 }, (_, i) => ({ id: i, name: 'n' + i, ok: true, ratio: i / 3 })),
    null,
    2
  );
  const bigXml = ['<?xml version="1.0"?>']
    .concat(
      Array.from({ length: 400 }, (_, i) => '  <hashTree>\n    <!-- c -->\n    <stringProp name="p' + i + '">v' + i + '</stringProp>\n  </hashTree>')
    )
    .join('\n');
  const docs = {
    java: big,
    python: big,
    json: bigJson,
    xml: bigXml,
    sql: big,
    bash: big,
    groovy: big
  };

  const timings = {};
  for (const lang of Object.keys(docs)) {
    const src = docs[lang];
    // 预热一次（第一趟含 JIT），计时取第二趟，数字更有代表性
    highlight(src, lang);
    const t0 = process.hrtime.bigint();
    const toks = highlight(src, lang);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    timings[lang] = { ms: Math.round(ms * 100) / 100, chars: src.length, tokens: toks.length };
    check(`长文本性能 ${lang}（${src.length} 字符）< 200ms`, ms < 200, timings[lang]);
    check(`长文本无损 ${lang}`, lossless(src, toks));
  }

  // detectLang 也要扫一遍长文本（只看前 4000 字符，应该很快）
  const t1 = process.hrtime.bigint();
  detectLang(big);
  const detectMs = Number(process.hrtime.bigint() - t1) / 1e6;
  check('长文本 detectLang < 50ms', detectMs < 50, { ms: detectMs });

  console.log('  性能实测（node ' + process.version + '）：');
  for (const lang of Object.keys(timings)) {
    const t = timings[lang];
    console.log(
      '    ' + lang.padEnd(9) + String(t.chars).padStart(6) + ' 字符  ' + String(t.ms).padStart(6) + ' ms  ' + String(t.tokens).padStart(6) + ' token'
    );
  }
  console.log('    detectLang  ' + Math.round(detectMs * 100) / 100 + ' ms');
}

/* ============================================================
 * 13. 超长折叠的纯逻辑（countLines / limitTokens）
 *
 * 折叠是「只渲染前 N 行，但复制仍是完整代码」，所以截断必须：
 *   - 保留原字符（不加省略号、不 trim）；
 *   - 结果正好 N 行且不以换行结尾（否则渲染出一个多出来的空行）。
 * ============================================================ */
{
  const ten = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10';
  const toks = highlight(ten, 'plain');
  check('countLines 数得对（10 行）', countLines(toks) === 10, countLines(toks));
  check('countLines 空 token 流算 1 行', countLines([]) === 1, countLines([]));
  check('countLines 尾随换行算一行', countLines(highlight('a\n', 'plain')) === 2, countLines(highlight('a\n', 'plain')));

  const cut3 = limitTokens(toks, 3);
  const cut3Text = cut3.map((t) => t.text).join('');
  check('limitTokens 只保留前 3 行', cut3Text === 'l1\nl2\nl3', JSON.stringify(cut3Text));
  check('limitTokens 结果正好 3 行', countLines(cut3) === 3, countLines(cut3));
  check('limitTokens 不以换行结尾', cut3Text.slice(-1) !== '\n', JSON.stringify(cut3Text.slice(-1)));
  check('limitTokens 是原文的前缀（没改字符）', ten.startsWith(cut3Text), cut3Text);

  const cut1 = limitTokens(toks, 1).map((t) => t.text).join('');
  check('limitTokens(1) 只留第一行', cut1 === 'l1', JSON.stringify(cut1));

  const all = limitTokens(toks, 10).map((t) => t.text).join('');
  check('正好 N 行时 limitTokens 原样返回', all === ten, JSON.stringify(all));

  const more = limitTokens(toks, 99).map((t) => t.text).join('');
  check('N 大于总行数时原样返回', more === ten);

  // 真实长文本：截到 400 行后仍是原文前缀
  const longSrc = Array.from({ length: 1200 }, (_, i) => 'line ' + i).join('\n');
  const longToks = highlight(longSrc, 'plain');
  const cut400 = limitTokens(longToks, 400).map((t) => t.text).join('');
  check('1200 行截到 400 行', countLines(limitTokens(longToks, 400)) === 400, countLines(limitTokens(longToks, 400)));
  check('截断后仍是原文前缀', longSrc.startsWith(cut400) && cut400.split('\n').length === 400, cut400.slice(-20));

  // 非法参数不抛错（limit 0 / NaN / 负数都退化成 1 行）
  check('limitTokens 非法 limit 不抛错', limitTokens(toks, 0).map((t) => t.text).join('') === 'l1' && limitTokens(toks, NaN).length > 0);
}

/* ============================================================
 * 14. CodeBlock 接线（源码断言：渲染点确实换成了统一组件）
 * ============================================================ */
{
  const fs = require('fs');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  const codeBlock = read('src/components/CodeBlock.tsx');
  check('CodeBlock 用统一高亮函数', /from '\.\.\/\.\.\/shared\/codeHighlight\.js'/.test(codeBlock), 'no highlighter import');
  check('CodeBlock 有行号槽', /code-block-gutter/.test(codeBlock) && /code-block-ln/.test(codeBlock), 'no gutter');
  check('CodeBlock 复制走现有剪贴板通道', /api\.copy\(text, false\)/.test(codeBlock), 'copy not wired');
  check('CodeBlock 超长折叠', /COLLAPSE_AT/.test(codeBlock) && /展开全部/.test(codeBlock), 'no collapse');
  check('CodeBlock 主题跟随（样式在 styles.css 第 11 节）', /code-block is-hl/.test(codeBlock), 'no root class');
  // 代码文本用真 \n（不做「一行一个 div」），否则拖选复制会丢空行
  check('CodeBlock 代码列是真换行（不是逐行 div）', /code-block-code/.test(codeBlock) && !/code-block-line/.test(codeBlock), 'per-line divs');

  const css = read('src/styles.css');
  check('styles.css 有 .code-block 段落', /\.code-block\.is-hl\s*\{/.test(css), 'no block');
  check('行号槽是不进选区的（user-select: none）', /\.code-block-gutter\s*\{[^}]*user-select:\s*none/.test(css), 'gutter selectable');
  check('代码列不折行（white-space: pre）', /\.code-block-code\s*\{[^}]*white-space:\s*pre/.test(css), 'code wraps');
  check('代码块背景走变量（不写死深色）', /\.code-block\.is-hl\s*\{[^}]*background:\s*var\(--panel\)/.test(css), 'hardcoded bg');
  check('关键字配色跟主题走（var(--primary-text)）', /\.code-block-tok\.is-keyword\s*\{[^}]*var\(--primary-text\)/.test(css), 'keyword not themed');
  check('旧的深色 .tpl-code 已收掉', !/\.tpl-code\s*\{/.test(css), 'tpl-code remains');

  const codegen = read('src/pages/CodegenPage.tsx');
  check('代码生成预览用 CodeBlock（受保护的 require）', /CodeBlockLazy/.test(codegen) && /<CodeBlockLazy/.test(codegen), 'not used');
  check('代码生成预览带语言（java / python）', /renderCodePreview\(code, previewLang\)/.test(codegen), 'no lang');

  const scriptgen = read('src/pages/ScriptGenPage.tsx');
  check('jmx 预览用 CodeBlock + xml', /<CodeBlock code=\{jmxCode\} lang="xml"/.test(scriptgen), 'jmx not wired');
  check('SQL 预览用 CodeBlock + sql', /<CodeBlock code=\{sqlCode\} lang="sql"/.test(scriptgen), 'sql not wired');

  const drawer = read('src/components/ScriptTemplatesDrawer.tsx');
  check('脚本模板抽屉用 CodeBlock + groovy', /<CodeBlock code=\{active\.code\} lang="groovy"/.test(drawer), 'drawer not wired');

  const toggle = read('src/components/JsonTableToggle.tsx');
  check('JSON 表格切换的原文视图用 CodeBlock', (toggle.match(/<CodeBlock /g) || []).length >= 3, (toggle.match(/<CodeBlock /g) || []).length);
  // headers 是 `Key: Value`，不是 JSON —— 这里故意不写死 lang，交给自动识别，
  // 断言「JSON 视图没有把语言钉死成 json」（否则徽标会对着 headers 说自己是 JSON）
  check('JSON 视图不写死语言（交给自动识别）', !/<CodeBlock[^>]*lang=/.test(toggle), 'lang hardcoded');

  const report = read('src/pages/ReportPage.tsx');
  check('报告失败 trace 用 CodeBlock', /<CodeBlock code=\{t\.trace\}/.test(report), 'trace not wired');
}

/* ============================================================
 * 汇总
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
console.log('===== 代码高亮测试 =====');
for (const r of results) {
  if (!r.ok) console.log('  FAIL  ' + r.name + (r.extra ? '  -> ' + r.extra : ''));
}
console.log((results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
