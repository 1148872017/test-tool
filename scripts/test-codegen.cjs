/* 代码骨架生成 + 造数导出 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 生成目标列表 ---------- */
const cg = require('../shared/codegen.js');
const targets = cg.listTargets();

check('有 7 个生成目标（v0.64 新增测试基类）', targets.length === 7, targets.length);
check(
  '有 Java Playwright 测试基类（不需要数据源的那个）',
  targets.some((t) => t.key === 'java-playwright-base' && t.kind === 'base'),
  targets.map((t) => t.key + ':' + t.kind)
);
check('有 Java REST Assured', targets.some((t) => t.key === 'java-restassured'), targets.map((t) => t.key));
check('有 Python pytest', targets.some((t) => t.key === 'python-pytest'), targets.map((t) => t.key));
check('有 Playwright Java POM', targets.some((t) => t.key === 'playwright-java'), targets.map((t) => t.key));
check('有 Playwright Python POM', targets.some((t) => t.key === 'playwright-python'), targets.map((t) => t.key));
check('有 Java POJO', targets.some((t) => t.key === 'pojo-java'), targets.map((t) => t.key));
check('有 Python Pydantic', targets.some((t) => t.key === 'dataclass-python'), targets.map((t) => t.key));

// 每个目标有必需字段
for (const t of targets) {
  check(`${t.key} 有 label/desc/lang/ext/kind`, !!(t.label && t.desc && t.lang && t.ext && t.kind), t);
}

/* ---------- 2. 工具函数 ---------- */
check('camel: pet-detail → petDetail', cg.camel('pet-detail') === 'petDetail', cg.camel('pet-detail'));
check('pascal: pet-detail → PetDetail', cg.pascal('pet-detail') === 'PetDetail', cg.pascal('pet-detail'));
check('classNameFromUrl: /pet/{id} → Pet', cg.classNameFromUrl('/pet/{id}') === 'Pet', cg.classNameFromUrl('/pet/{id}'));
check('methodNameFromApi: POST /pet → createPet', cg.methodNameFromApi('POST', '/pet') === 'createPet', cg.methodNameFromApi('POST', '/pet'));
check('methodNameFromApi: GET /pet → getPet', cg.methodNameFromApi('GET', '/pet') === 'getPet', cg.methodNameFromApi('GET', '/pet'));
check('methodNameFromApi: DELETE /pet → deletePet', cg.methodNameFromApi('DELETE', '/pet') === 'deletePet', cg.methodNameFromApi('DELETE', '/pet'));

/* ---------- 3. 生成 Java REST Assured ---------- */
const api = {
  name: '新建宠物',
  method: 'POST',
  url: '/pet',
  module: '宠物',
  paramTable: JSON.stringify([
    { in: 'query', name: 'page', type: 'integer', required: false, example: '1', desc: '' },
    { in: 'header', name: 'api_key', type: 'string', required: true, example: '', desc: '' }
  ]),
  body: 'name=Kitty&status=sold',
  bodyType: 'x-www-form-urlencoded'
};

const java = cg.generate('java-restassured', { api });
check('Java 生成成功', java.ok === true, java.message);
check('Java 文件名 PetApiTest.java', java.filename === 'PetApiTest.java', java.filename);
check('Java 有 package', /package com\.test\.api;/.test(java.code), 'no package');
check('Java 有 class', /public class PetApiTest/.test(java.code), 'no class');
check('Java 有 @Test', /@Test/.test(java.code), 'no @Test');
check('Java 有 testCreatePet', /testCreatePet/.test(java.code), 'no method');
check('Java 有 queryParam', /queryParam\("page"/.test(java.code), 'no queryParam');
check('Java 有 header', /header\("api_key"/.test(java.code), 'no header');
check('Java 有 formParam', /formParam\("name", "Kitty"\)/.test(java.code), 'no formParam');
check('Java contentType 只出现一次', (java.code.match(/contentType/g) || []).length === 1, (java.code.match(/contentType/g) || []).length);
check('Java 用 x-www-form-urlencoded', /application\/x-www-form-urlencoded/.test(java.code), 'wrong content type');

/* ---------- 4. 生成 Python pytest ---------- */
const py = cg.generate('python-pytest', { api });
check('Python 生成成功', py.ok === true, py.message);
check('Python 文件名 PetApiTest.py', py.filename === 'PetApiTest.py', py.filename);
check('Python 有 import requests', /import requests/.test(py.code), 'no requests');
check('Python 有 class TestPet', /class TestPet/.test(py.code), 'no class');
check('Python 有 test_create_pet', /def test_create_pet/.test(py.code), 'no method');
check('Python 有 data 字典', /data = \{/.test(py.code), 'no data');
check('Python 有 status_code 断言', /assert resp\.status_code == 200/.test(py.code), 'no assert');

/* ---------- 5. 生成 POJO ---------- */
const pojo = cg.generate('pojo-java', {
  json: JSON.stringify({ code: 0, msg: 'ok', list: [1], data: { id: 1 }, flag: true }),
  className: 'ApiResponse'
});
check('POJO 生成成功', pojo.ok === true, pojo.message);
check('POJO 有 @Data', /@Data/.test(pojo.code), 'no @Data');
check('POJO 有 Integer code', /private Integer code;/.test(pojo.code), 'no Integer');
check('POJO 有 String msg', /private String msg;/.test(pojo.code), 'no String');
check('POJO 有 Boolean flag', /private Boolean flag;/.test(pojo.code), 'no Boolean');
check('POJO 的 List 没被 HTML 转义', /java\.util\.List<Object>/.test(pojo.code), 'escaped!');
check('POJO 没有 &lt;', !/&lt;/.test(pojo.code), 'has &lt;');

/* ---------- 6. 生成 Pydantic ---------- */
const dc = cg.generate('dataclass-python', {
  json: JSON.stringify({ code: 0, msg: 'ok', flag: true }),
  className: 'ApiResponse'
});
check('Pydantic 生成成功', dc.ok === true, dc.message);
check('Pydantic 有 BaseModel', /class ApiResponse\(BaseModel\)/.test(dc.code), 'no BaseModel');
check('Pydantic 有 Optional[int]', /Optional\[int\]/.test(dc.code), 'no int');
check('Pydantic 有 Optional[str]', /Optional\[str\]/.test(dc.code), 'no str');
check('Pydantic 有 Optional[bool]', /Optional\[bool\]/.test(dc.code), 'no bool');

/* ---------- 7. 生成 Playwright POM ---------- */
const pom = cg.generate('playwright-java', {
  page: {
    name: 'login',
    url: '/login',
    elements: [
      { name: 'usernameInput', selector: '#username', desc: '用户名' },
      { name: 'submitBtn', selector: 'button[type=submit]', desc: '提交' }
    ]
  }
});
check('POM 生成成功', pom.ok === true, pom.message);
check('POM 文件名 LoginPage.java', pom.filename === 'LoginPage.java', pom.filename);
check('POM 有 Page 注入', /private final Page page;/.test(pom.code), 'no page');
check('POM 有 Locator 方法', /public Locator usernameInput\(\)/.test(pom.code), 'no locator');
check('POM 有 selector', /page\.locator\("#username"\)/.test(pom.code), 'no selector');
check('POM 有 open 方法', /public void open\(String baseUrl\)/.test(pom.code), 'no open');

/* ---------- 8. 边界 ---------- */
check('未知目标报错', cg.generate('nonexistent', {}).ok === false);
check('缺 api 报错', cg.generate('java-restassured', {}).ok === false);
check('空 JSON 报错', cg.generate('pojo-java', { json: '{}' }).ok === false);
check('坏 JSON 报错', cg.generate('pojo-java', { json: '{bad' }).ok === false);

/* ---------- 9. IPC 已注册 ---------- */
const mainSrc = require('./_electron-src.cjs').readElectronSource();
check('有 codegen:targets', /handle\('codegen:targets'/.test(mainSrc), 'no targets');
check('有 codegen:preview', /handle\('codegen:preview'/.test(mainSrc), 'no preview');
check('有 codegen:save', /handle\('codegen:save'/.test(mainSrc), 'no save');

/* ---------- 9.1 v0.60：积木视图能直接存文件 ---------- */
{
  const { checkInlineFilename } = require('../electron/ipc/ipc-codegen.js');

  check('文件名守卫放行正常名字', checkInlineFilename('LoginTest.java', 'java-playwright-pom') === null, checkInlineFilename('LoginTest.java', 'java-playwright-pom'));
  check('放行 Python 名字', checkInlineFilename('test_login.py', 'python-pytest') === null, checkInlineFilename('test_login.py', 'python-pytest'));
  check('拦目录穿越', (checkInlineFilename('../evil.java', 'java-playwright-pom') || {}).ok === false, checkInlineFilename('../evil.java', 'java-playwright-pom'));
  check('拦带分隔符的名字', (checkInlineFilename('a/b.java', 'java-playwright-pom') || {}).ok === false, checkInlineFilename('a/b.java', 'java-playwright-pom'));
  check('拦 Windows 非法字符', (checkInlineFilename('a:b.java', 'java-playwright-pom') || {}).ok === false, checkInlineFilename('a:b.java', 'java-playwright-pom'));
  check('拦扩展名不匹配（Java 目标写 .py）', (checkInlineFilename('x.py', 'java-playwright-pom') || {}).ok === false, checkInlineFilename('x.py', 'java-playwright-pom'));
  check('拦没有扩展名', (checkInlineFilename('x', 'java-playwright-pom') || {}).ok === false, checkInlineFilename('x', 'java-playwright-pom'));
  check('拦空文件名', (checkInlineFilename('', 'java-playwright-pom') || {}).ok === false, checkInlineFilename('', 'java-playwright-pom'));

  // handler 真的会走 inline code 分支（源码层：有 code 就不调 codegen.generate）
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ipc', 'ipc-codegen.js'), 'utf8');
  check('codegen:save 支持直接写传入的 code', /inlineCode \? \{ ok: true, code: inlineCode/.test(ipcSrc), 'no inline branch');
  check('inline 分支也过目录守卫（assertPathIn 在生成之前）', ipcSrc.indexOf('assertPathIn(wantDir)') < ipcSrc.indexOf('inlineCode ?'), 'guard order');
}

/* ---------- 9.2 v0.63：一个类里放多个接口 ---------- */
{
  const MULTI_APIS = [
    { name: '登录', method: 'POST', url: '/api/login', module: '用户', bodyType: 'json', body: '{"u":"a","p":"b"}' },
    { name: '查订单', method: 'GET', url: '/api/order/1', module: '订单' }
  ];

  const multiJava = cg.generate('java-restassured', { apis: MULTI_APIS });
  check('多接口：生成成功且标记条数', !!multiJava.ok && multiJava.count === 2, multiJava.message);
  check(
    '多接口：一个类里两个 @Test 方法',
    (multiJava.code.match(/@Test/g) || []).length === 2,
    (multiJava.code.match(/@Test/g) || []).length
  );
  check('多接口：类名只出现一次（不是两个类）', (multiJava.code.match(/public class /g) || []).length === 1, 'multiple classes');
  check(
    '多接口：中文模块名不会变成非法类名（回退到接口名）',
    /public class LoginApiTest \{/.test(multiJava.code) && !/class 户/.test(multiJava.code),
    (multiJava.code.match(/public class [^\s{]+/) || [])[0]
  );
  check('多接口：setUp 只出现一次（共用一个类头）', (multiJava.code.match(/public void setUp/g) || []).length === 1, 'dup setUp');

  const multiPy = cg.generate('python-pytest', { apis: MULTI_APIS });
  check(
    '多接口（Python）：一个类里两个 test_ 方法',
    !!multiPy.ok && (multiPy.code.match(/    def test_/g) || []).length === 2,
    multiPy.ok ? multiPy.code.slice(0, 200) : multiPy.message
  );

  // 单接口必须和以前逐字一致：模板没动过（这条防「改多接口顺手改坏了单接口」）
  const single = cg.generate('java-restassured', { api: MULTI_APIS[0] });
  check('单接口仍然只有一个 @Test', (single.code.match(/@Test/g) || []).length === 1, 'single changed');
  check(
    '单接口 JSON body 不会漏出 JS 片段（旧模板三元表达式写在 EJS 标签外，v0.63 修掉）',
    single.code.indexOf('.body(') >= 0 && !/bodyParams\.length/.test(single.code),
    (single.code.match(/\.body[\s\S]{0,160}/) || [])[0]
  );
  const bodyBlock = single.code.slice(single.code.indexOf('.body('), single.code.indexOf('.when()'));
  // Java 源码里键名是转义的（\"u\"），先去掉反斜杠再断言，免得正则里堆一堆 \\\"
  const flatBody = bodyBlock.replace(/\\"/g, '"');
  check(
    'JSON body 的项目之间逗号正确（第一个带逗号、最后一个不带）',
    /"u": "a",/.test(flatBody) && /"p": "b"(?!,)/.test(flatBody),
    bodyBlock
  );
}

/* ---------- 9.3 v0.63：「选择已有类」从文件里读类名 ---------- */
{
  const { guessClassFromFile } = require('../electron/ipc/ipc-codegen.js');
  const j = guessClassFromFile('D:/p/LoginPage.java', 'package x;\npublic class LoginPage { }');
  check('Java：读到 class 声明', j.className === 'LoginPage' && j.source === 'declared', j);
  const k = guessClassFromFile('D:/p/H.java', 'public final class HelperUils { }');
  check('Java：多个修饰符也能读到类名', k.className === 'HelperUils', k);
  const p = guessClassFromFile('D:/p/login_page.py', '# class Fake:\nclass LoginPage(Base):\n    pass');
  check('Python：跳过被注释掉的 class', p.className === 'LoginPage' && p.kind === 'python', p);
  const n = guessClassFromFile('D:/p/NoDecl.java', 'just text');
  check('没有 class 声明时退回文件名并标记 source=filename', n.className === 'NoDecl' && n.source === 'filename', n);
  check(
    'preload / mock 都接了这个通道',
    /codegenPickClass: \(\) => invoke\('codegen:pickClass'\)/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')),
    'preload missing'
  );
}

/* ---------- 9.4 v0.64：Java · Playwright 测试基类（不需要数据源） ---------- */
{
  const r = cg.generate('java-playwright-base', {});
  check('基类：默认类名 BaseTest，文件名对得上', !!r.ok && r.filename === 'BaseTest.java', r.filename);
  check(
    '基类：有 @BeforeClass / @AfterClass（起 + 收）',
    /@BeforeClass/.test(r.code) && /@AfterClass/.test(r.code),
    'no lifecycle annotations'
  );
  check(
    '基类：按用户要求简化成 chromium + headless=false + slowMo=500',
    /playwright\.chromium\(\)\.launch\(/.test(r.code) &&
      /setHeadless\(false\)/.test(r.code) &&
      /setSlowMo\(500\)/.test(r.code),
    'launch not simplified'
  );
  check(
    '基类：建了 context / page（原稿只起 browser，方法体里用 page 会 NPE）',
    /context = browser\.newContext\(\)/.test(r.code) && /page = context\.newPage\(\)/.test(r.code),
    'no context/page'
  );
  check(
    '基类：简化后不再有 Properties / loadConfig',
    !/Properties/.test(r.code) && !/loadConfig/.test(r.code),
    'still has config code'
  );
  check(
    '基类：收尾按 context → browser → playwright 三级关闭',
    /context\.close\(\)/.test(r.code) && /browser\.close\(\)/.test(r.code) && /playwright\.close\(\)/.test(r.code),
    'no teardown'
  );
  check('基类：自定义类名生效', cg.generate('java-playwright-base', { className: 'BaseUi' }).filename === 'BaseUi.java', 'name not applied');
  check('基类：kind=base 且不进积木视图（页面元素那套与它无关）', r.target.kind === 'base', r.target.kind);
}

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 codegenTargets', /codegenTargets:/.test(preloadSrc), 'no targets');
check('preload 有 codegenPreview', /codegenPreview:/.test(preloadSrc), 'no preview');
check('preload 有 codegenSave', /codegenSave:/.test(preloadSrc), 'no save');

/* ---------- 10. 前端页面 ---------- */
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodegenPage.tsx'), 'utf8');
check('页面有生成预览', /doPreview/.test(pageSrc), 'no preview');
check('页面有保存', /doSave/.test(pageSrc), 'no save');
check('页面有复制', /doCopy/.test(pageSrc), 'no copy');
check('页面支持三种数据源', /kind === 'api'/.test(pageSrc) && /kind === 'page'/.test(pageSrc) && /kind === 'model'/.test(pageSrc), 'missing kind');
check('页面有元素增删', /addElement/.test(pageSrc) && /removeElement/.test(pageSrc), 'no element edit');

/* ---------- 11. 侧边栏入口 ---------- */
const collections = require('../shared/collections.js');
check('TOOLS 有代码生成', collections.TOOLS.some((t) => t.key === 'codegen'), collections.TOOLS.map((t) => t.key));
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
check('App 有 codegen 路由', /route\.key === 'codegen'/.test(appSrc), 'no route');

/* ---------- 12. 造数导出 ---------- */
const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'DataTool.tsx'), 'utf8');
check('造数上限 10 万', /Math\.min\(100000/.test(dataSrc), 'limit not raised');
check('有 CSV 导出', /doExport\('csv'\)/.test(dataSrc), 'no csv');
check('有 JSON 导出', /doExport\('json'\)/.test(dataSrc), 'no json');
check('CSV 加 BOM', /\\uFEFF/.test(dataSrc), 'no BOM');
check('CSV 转义引号', /replace\(\/"\/g, '""'\)/.test(dataSrc), 'no escape');

const failed = results.filter((r) => !r.ok);
console.log('===== 代码生成 + 造数导出测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
