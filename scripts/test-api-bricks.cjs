'use strict';
/**
 * 接口测试的「积木式流程拼装」（interface 版 v0.49）：
 *   shared/apiActions.js（7 动作 / 4 分类）
 *   shared/apiFlowGen.js（Java / Python 生成器）
 *   src/components/api-bricks/** + CodegenPage 的「接口流程（积木）」视图
 *   flows 集合的 kind 字段（ui / api 两种流程共用一个集合）
 *
 * 做法和 test-ui-bricks.cjs / test-bricks-save.cjs 完全一致（不启动 Electron、不连数据库）：
 *   1. 动作库是纯数据，逐条校验模板占位符和参数定义对得上（能抓 `%text%` 写成 `%txt%`）；
 *   2. 生成器**真跑**：同一组步骤分别按 Java / Python 生成，逐字比对产物；
 *      变量引用 `${x}` 的三种落点（header / body / path）、未定义变量、变量表累积都在这层验；
 *   3. 前端用 esbuild 把 TSX 转 CJS + 一个极小的 hooks 运行时**真渲染**：
 *      点积木 → 选接口（存快照）→ 填参数 → 加步骤 → 结果 textarea 出代码 → 存流程；
 *   4. 最后用真实 React + antd 渲染一遍（SSR），防 antd 用法写错。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const results = [];
const check = (name, cond, extra) =>
  results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const CODEGEN = path.join(ROOT, 'src', 'pages', 'CodegenPage.tsx');
const BRICKS_DIR = path.join(ROOT, 'src', 'components', 'api-bricks');
const PANEL = path.join(BRICKS_DIR, 'ApiBricksPanel.tsx');
const PARAM_MODAL = path.join(BRICKS_DIR, 'ApiActionParamModal.tsx');
const SAVE_MODAL = path.join(BRICKS_DIR, 'SaveApiFlowModal.tsx');
const HELPERS = path.join(BRICKS_DIR, 'apiBrickHelpers.ts');
const API_ACTIONS_FILE = path.join(ROOT, 'shared', 'apiActions.js');
const API_GEN_FILE = path.join(ROOT, 'shared', 'apiFlowGen.js');
const MOCK = path.join(ROOT, 'src', 'mockApi.ts');

const {
  API_ACTIONS,
  API_ACTION_CATEGORIES,
  API_PARAM_TYPES,
  API_PSEUDO_PARAMS,
  isIdentifier,
  actionById,
  actionsByCategory
} = require('../shared/apiActions.js');
const gen = require('../shared/apiFlowGen.js');
const { COLLECTIONS, COLLECTION_MAP } = require('../shared/collections.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================================================
 * 一、动作库（8 条）
 * ============================================================ */

check('动作库正好 7 个动作', API_ACTIONS.length === 7, API_ACTIONS.length);
check(
  '每个动作都有 id/category/name/params/java/python',
  API_ACTIONS.every(
    (a) =>
      a &&
      typeof a.id === 'string' &&
      a.id &&
      typeof a.category === 'string' &&
      typeof a.name === 'string' &&
      Array.isArray(a.params) &&
      a.params.length > 0 &&
      typeof a.java === 'string' &&
      a.java &&
      typeof a.python === 'string' &&
      a.python
  ),
  API_ACTIONS.filter((a) => !(a.id && a.category && a.name && a.java && a.python)).map((a) => a.id)
);
check(
  '动作 id 唯一',
  new Set(API_ACTIONS.map((a) => a.id)).size === API_ACTIONS.length,
  API_ACTIONS.map((a) => a.id)
);
check(
  '每个动作的分类都在 API_ACTION_CATEGORIES 里',
  API_ACTIONS.every((a) => API_ACTION_CATEGORIES.some((c) => c.key === a.category)),
  API_ACTIONS.filter((a) => !API_ACTION_CATEGORIES.some((c) => c.key === a.category)).map((a) => a.id)
);
check(
  '分类顺序是 请求/提取/断言/变量',
  API_ACTION_CATEGORIES.map((c) => c.key).join(',') === 'request,extract,assert,var' &&
    API_ACTION_CATEGORIES.map((c) => c.label).join(',') === '请求,提取,断言,变量',
  API_ACTION_CATEGORIES.map((c) => c.key)
);
check(
  '每个分类至少一个动作（4 类都有积木）',
  API_ACTION_CATEGORIES.every((c) => API_ACTIONS.some((a) => a.category === c.key)),
  API_ACTION_CATEGORIES.map((c) => c.key)
);
check(
  '参数 type 只能是 apiRecord/ident/text/number',
  API_ACTIONS.every((a) => (a.params || []).every((p) => API_PARAM_TYPES.indexOf(p.type) >= 0)),
  API_ACTIONS.flatMap((a) =>
    (a.params || [])
      .filter((p) => API_PARAM_TYPES.indexOf(p.type) < 0)
      .map((p) => a.id + '.' + p.key + ':' + p.type)
  )
);

/** 模板里的 %key% 必须在 params 里有定义（`call` 的 %apiName% 是接口快照字段，单独登记） */
for (const a of API_ACTIONS) {
  const defined = new Set((a.params || []).map((p) => p.key).concat(API_PSEUDO_PARAMS));
  const used = [];
  const re = /%([A-Za-z0-9_]+)%/g;
  let m;
  const src = String(a.java) + ' ' + String(a.python);
  while ((m = re.exec(src)) !== null) used.push(m[1]);
  const missing = used.filter((k) => !defined.has(k));
  check('模板占位符都有参数定义：' + a.name, missing.length === 0, missing);
}
check('call 的 %apiName% 确实是快照字段（不在表单 params 里）', (() => {
  const call = actionById('call');
  return (
    API_PSEUDO_PARAMS.indexOf('apiName') >= 0 &&
    !(call.params || []).some((p) => p.key === 'apiName') &&
    String(call.java).indexOf('%apiName%') >= 0
  );
})(), actionById('call').params);
check(
  'actionById 能按 id 取到动作、未知 id 返回 null',
  actionById('assert-status').name === '断言状态码' && actionById('not-exist') === null,
  actionById('not-exist')
);
check(
  'actionsByCategory 覆盖全部动作且没有空分组',
  actionsByCategory().reduce((n, g) => n + g.actions.length, 0) === API_ACTIONS.length &&
    actionsByCategory().every((g) => g.actions.length > 0),
  actionsByCategory().map((g) => g.key + ':' + g.actions.length)
);
check(
  'ident 规则：字母/下划线开头 + 字母数字下划线（Java / Python 都认）',
  isIdentifier('loginResp') &&
    isIdentifier('_tmp1') &&
    !isIdentifier('1resp') &&
    !isIdentifier('my-var') &&
    !isIdentifier('a b') &&
    !isIdentifier('') &&
    !isIdentifier('$x'),
  ['loginResp', '1resp', 'my-var', 'a b', '$x'].map((x) => [x, isIdentifier(x)])
);

/* ============================================================
 * 二、生成器（Java）
 * ============================================================ */

const LOGIN = {
  actionId: 'call',
  params: {
    apiId: 'a1',
    apiName: '登录',
    as: 'loginResp',
    method: 'POST',
    path: '/api/login',
    headers: [{ k: 'Content-Type', v: 'application/json' }],
    body: '{"username":"${username}","password":"123"}'
  }
};
const ORDER = {
  actionId: 'call',
  params: {
    apiId: 'a2',
    apiName: '查订单',
    as: 'orderResp',
    method: 'GET',
    path: '/api/order/${orderId}',
    headers: [{ k: 'Authorization', v: 'Bearer ${token}' }],
    body: ''
  }
};

const single = gen.generateApiFlow({
  steps: [
    {
      actionId: 'call',
      params: {
        apiId: 'a1',
        apiName: '登录',
        as: 'loginResp',
        method: 'POST',
        path: '/api/login',
        headers: [{ k: 'Content-Type', v: 'application/json' }],
        body: '{"username":"admin","password":"123"}'
      }
    }
  ],
  lang: 'java',
  testName: 'testOrderFlow'
});
check(
  '单接口 call → 完整的 given()…when()…then().extract()',
  single.code.indexOf('Response loginResp = given()') >= 0 &&
    single.code.indexOf('.when()') > 0 &&
    single.code.indexOf('.post("/api/login")') > 0 &&
    single.code.indexOf('.then()') > 0 &&
    single.code.indexOf('.extract().response();') > 0,
  single.code
);
check('Java 方法签名按 testName 出（public void testOrderFlow()）', /public void testOrderFlow\(\) \{/.test(single.code), single.code);
check(
  'Java 链式缩进对齐样例（given() 在 4，.contentType 在 12）',
  single.code.indexOf('\n    Response loginResp = given()') >= 0 &&
    single.code.indexOf('\n            .contentType(ContentType.JSON)') >= 0,
  single.code
);
check(
  'JSON body 走 .body("…") 且引号被转义',
  single.code.indexOf('.body("{\\"username\\":\\"admin\\",\\"password\\":\\"123\\"}")') >= 0,
  single.code
);

/* ---- 两个接口串联 + 变量传递 ---- */
const chain = gen.generateApiFlow({
  steps: [
    { actionId: 'set-var', params: { name: 'username', value: 'admin' } },
    { actionId: 'set-var', params: { name: 'orderId', value: '1001' } },
    LOGIN,
    { actionId: 'extract-json', params: { from: 'loginResp', path: '$.data.token', as: 'token' } },
    ORDER,
    { actionId: 'assert-status', params: { from: 'orderResp', code: 200 } }
  ],
  lang: 'java',
  testName: 'testOrderFlow'
});
check(
  '两接口串联：提取 token 后用它拼 Authorization',
  chain.code.indexOf('String token = loginResp.jsonPath().getString("$.data.token");') >= 0 &&
    chain.code.indexOf('.header("Authorization", "Bearer " + token)') >= 0,
  chain.code
);
check(
  '${var} 在 header 里 → Java 字符串拼接（"Bearer " + token）',
  chain.code.indexOf('"Bearer " + token') >= 0 && chain.code.indexOf('"Bearer ${token}"') < 0,
  chain.code
);
check(
  '${var} 在 body 里 → 拼进 JSON 字符串',
  chain.code.indexOf('.body("{\\"username\\":\\"" + username + "\\",\\"password\\":\\"123\\"}")') >= 0,
  chain.code
);
check(
  '${var} 在 path 里 → .get("/api/order/" + orderId)',
  chain.code.indexOf('.get("/api/order/" + orderId)') >= 0,
  chain.code
);
check(
  '两个 Response 各自成变量（loginResp / orderResp）',
  chain.code.indexOf('Response loginResp = given()') >= 0 &&
    chain.code.indexOf('Response orderResp = given()') >= 0,
  chain.code
);

/* ---- 提取 ---- */
const extractJson = gen.generateApiFlow({
  steps: [
    LOGIN,
    { actionId: 'extract-json', params: { from: 'loginResp', path: '$.data.id', as: 'userId' } }
  ],
  lang: 'java'
});
check(
  'extract-json → String userId = loginResp.jsonPath().getString("$.data.id");',
  extractJson.code.indexOf('String userId = loginResp.jsonPath().getString("$.data.id");') >= 0,
  extractJson.code
);

const extractRegex = gen.generateApiFlow({
  steps: [
    LOGIN,
    { actionId: 'extract-regex', params: { from: 'loginResp', expr: '"token":"([^"]+)"', as: 'tk' } }
  ],
  lang: 'java'
});
check(
  'extract-regex → Pattern/Matcher + group(1)（不是一行敷衍了事）',
  extractRegex.code.indexOf('Matcher tkMatcher = Pattern.compile("\\"token\\":\\"([^\\"]+)\\"").matcher(loginResp.asString());') >= 0 &&
    extractRegex.code.indexOf('if (!tkMatcher.find()) {') >= 0 &&
    extractRegex.code.indexOf('throw new IllegalStateException(') >= 0 &&
    extractRegex.code.indexOf('String tk = tkMatcher.group(1);') >= 0,
  extractRegex.code
);

/* ---- 断言 + 变量 ---- */
const asserts = gen.generateApiFlow({
  steps: [
    LOGIN,
    { actionId: 'assert-status', params: { from: 'loginResp', code: 201 } },
    { actionId: 'assert-json', params: { from: 'loginResp', path: '$.code', value: '0' } },
    { actionId: 'assert-time', params: { from: 'loginResp', ms: 1500 } },
    { actionId: 'set-var', params: { name: 'flag', value: 'ok' } }
  ],
  lang: 'java'
});
check('assert-status → statusCode(201)', asserts.code.indexOf('loginResp.then().statusCode(201);') >= 0, asserts.code);
check(
  'assert-json → body("$.code", equalTo(0))（数字期望值不加引号）',
  asserts.code.indexOf('.body("$.code", equalTo(0));') >= 0,
  asserts.code
);
check('assert-time → time(lessThan(1500L))', asserts.code.indexOf('.time(lessThan(1500L));') >= 0, asserts.code);
check('set-var → String flag = "ok";', asserts.code.indexOf('String flag = "ok";') >= 0, asserts.code);

/* ---- imports ---- */
check(
  'imports 去重且排序',
  asserts.imports.join('|') === asserts.imports.slice().sort().join('|') &&
    new Set(asserts.imports).size === asserts.imports.length,
  asserts.imports
);
check(
  'imports 总是含 Response + given',
  asserts.imports.indexOf('io.restassured.response.Response') >= 0 &&
    asserts.imports.indexOf('static io.restassured.RestAssured.given') >= 0,
  asserts.imports
);
check(
  '有 assert-json 才有 equalTo',
  asserts.imports.indexOf('static org.hamcrest.Matchers.equalTo') >= 0 &&
    extractJson.imports.indexOf('static org.hamcrest.Matchers.equalTo') < 0,
  [asserts.imports, extractJson.imports]
);
check(
  '有 assert-time 才有 lessThan',
  asserts.imports.indexOf('static org.hamcrest.Matchers.lessThan') >= 0 &&
    extractJson.imports.indexOf('static org.hamcrest.Matchers.lessThan') < 0,
  [asserts.imports, extractJson.imports]
);
/** 一个「只有 GET、没有 header/body」的最简请求：用来对照 ContentType 的按需 import */
const plainGet = gen.generateApiFlow({
  steps: [
    {
      actionId: 'call',
      params: { apiId: 'a2', apiName: '查订单', as: 'orderResp', method: 'GET', path: '/api/order' }
    }
  ],
  lang: 'java'
});
check(
  '有 JSON body 才有 ContentType',
  single.imports.indexOf('io.restassured.http.ContentType') >= 0 &&
    plainGet.imports.indexOf('io.restassured.http.ContentType') < 0 &&
    plainGet.code.indexOf('contentType') < 0,
  [single.imports, plainGet.imports, plainGet.code]
);
check(
  '有 extract-regex 才有 java.util.regex.*',
  extractRegex.imports.indexOf('java.util.regex.*') >= 0 &&
    extractJson.imports.indexOf('java.util.regex.*') < 0,
  [extractRegex.imports, extractJson.imports]
);

/* ---- baseUrl ---- */
const withBase = gen.generateApiFlow({
  steps: [LOGIN],
  lang: 'java',
  baseUrl: 'http://localhost:8080'
});
check(
  'baseUrl → Java 用 .baseUri("http://localhost:8080")，path 仍写相对路径',
  withBase.code.indexOf('.baseUri("http://localhost:8080")') >= 0 &&
    withBase.code.indexOf('.post("/api/login")') >= 0,
  withBase.code
);
check(
  '不给 baseUrl 时没有 baseUri（不凭空造配置）',
  single.code.indexOf('baseUri') < 0,
  single.code
);

/* ============================================================
 * 三、生成器（Python）
 * ============================================================ */

const py = gen.generateApiFlow({
  steps: [
    { actionId: 'set-var', params: { name: 'username', value: 'admin' } },
    { actionId: 'set-var', params: { name: 'orderId', value: '1001' } },
    LOGIN,
    { actionId: 'extract-json', params: { from: 'loginResp', path: '$.data.token', as: 'token' } },
    ORDER,
    { actionId: 'assert-status', params: { from: 'orderResp', code: 200 } },
    { actionId: 'assert-json', params: { from: 'orderResp', path: '$.code', value: '0' } }
  ],
  lang: 'python',
  baseUrl: 'http://localhost:8080',
  testName: 'testOrderFlow'
});
check('Python 方法定义：def test_order_flow():（testName 转下划线）', /def test_order_flow\(\):/.test(py.code), py.code.split('\n').slice(0, 2).join(' / '));
check(
  'Python 用 requests.post / requests.get',
  py.code.indexOf("requests.post(") >= 0 && py.code.indexOf("requests.get(") >= 0,
  py.code
);
check(
  'Python 的 ${var} 在 header 里 → f\'Bearer {token}\'',
  py.code.indexOf("headers={'Authorization': f'Bearer {token}'}") >= 0,
  py.code
);
check(
  'Python 的 ${var} 在 path 里 → f\'{BASE}/api/order/{orderId}\'',
  py.code.indexOf("f'{BASE}/api/order/{orderId}'") >= 0,
  py.code
);
check(
  'Python 的 JSON body 转成 dict 字面量（json={...}）',
  py.code.indexOf("json={'username': username, 'password': '123'}") >= 0,
  py.code
);
check(
  'Python 断言用 assert（状态码 + JSON 字段）',
  py.code.indexOf('assert orderResp.status_code == 200') >= 0 &&
    py.code.indexOf("assert _dig(orderResp.json(), '$.code') == 0") >= 0,
  py.code
);
check(
  'Python 的 extract-json 走 _dig（requests 的 Response 没有 jsonpath()）',
  py.code.indexOf("token = _dig(loginResp.json(), '$.data.token')") >= 0,
  py.code
);
check(
  '用了 assert-json → 代码末尾生成 _dig 辅助函数',
  /def _dig\(data, path\):/.test(py.code) && py.code.indexOf('return cur') > 0,
  py.code
);
check(
  'Python 的 imports 是 requests（+ 用到正则有 re）',
  py.imports.indexOf('import requests') >= 0 && py.imports.indexOf('import re') < 0,
  py.imports
);
const pyRegex = gen.generateApiFlow({
  steps: [LOGIN, { actionId: 'extract-regex', params: { from: 'loginResp', expr: 'token=([0-9a-z]+)', as: 'tk' } }],
  lang: 'python'
});
check(
  'Python extract-regex：re.search + group(1)，并 import re',
  pyRegex.code.indexOf("_m = re.search('token=([0-9a-z]+)', loginResp.text)") >= 0 &&
    pyRegex.code.indexOf('tk = _m.group(1)') >= 0 &&
    pyRegex.imports.indexOf('import re') >= 0,
  [pyRegex.code, pyRegex.imports]
);
check(
  'Python 不用 assert-json 时不生成 _dig（按需，不塞无用代码）',
  pyRegex.code.indexOf('def _dig(') < 0,
  pyRegex.code
);
check(
  'Python baseUrl → 顶部 BASE 常量 + f\'{BASE}/…\'',
  py.code.indexOf("BASE = 'http://localhost:8080'") === 0,
  py.code.split('\n')[0]
);
check(
  'Python 单接口无 header/body 时压成一行（不用多行括号）',
  gen.generateApiFlow({
    steps: [{ actionId: 'call', params: { apiName: 'ping', as: 'r', method: 'GET', path: '/ping' } }],
    lang: 'python'
  }).code.indexOf("r = requests.get('/ping')") >= 0,
  gen.generateApiFlow({
    steps: [{ actionId: 'call', params: { apiName: 'ping', as: 'r', method: 'GET', path: '/ping' } }],
    lang: 'python'
  }).code
);

/* ============================================================
 * 四、生成器：warnings / variables / 边界
 * ============================================================ */

const undef = gen.generateApiFlow({
  steps: [LOGIN, { actionId: 'assert-status', params: { from: 'nope', code: 200 } }],
  lang: 'java'
});
check(
  '引用未定义变量 → warning（指名是第几步、哪个变量）',
  undef.warnings.some((w) => w.indexOf('未定义的变量 nope') >= 0 && w.indexOf('第 2 步') >= 0),
  undef.warnings
);
const undefInText = gen.generateApiFlow({
  steps: [
    LOGIN,
    { actionId: 'set-var', params: { name: 'x', value: 'Bearer ${ghost}' } }
  ],
  lang: 'java'
});
check(
  '文本参数里引用未定义变量 → 同样 warning（不静默生成坏代码）',
  undefInText.warnings.some((w) => w.indexOf('未定义的变量 ghost') >= 0),
  undefInText.warnings
);
const noCall = gen.generateApiFlow({
  steps: [{ actionId: 'assert-status', params: { from: 'loginResp', code: 200 } }],
  lang: 'java'
});
check(
  '没有 call 步骤 → warning「流程里没有「调用接口」」',
  noCall.warnings.some((w) => w.indexOf('没有「调用接口」') >= 0),
  noCall.warnings
);
check(
  '空步骤 → 空代码 + 提示',
  (() => {
    const r = gen.generateApiFlow({ steps: [], lang: 'java' });
    return r.code === '' && r.imports.length === 0 && r.warnings.length === 1 && r.warnings[0].indexOf('还没有选任何步骤') >= 0;
  })(),
  gen.generateApiFlow({ steps: [], lang: 'java' })
);
check(
  '变量表按步骤累积（set-var / call / extract 都进表，带 fromStep 和 type）',
  JSON.stringify(chain.variables) ===
    JSON.stringify([
      { name: 'username', fromStep: 1, type: 'value' },
      { name: 'orderId', fromStep: 2, type: 'value' },
      { name: 'loginResp', fromStep: 3, type: 'response' },
      { name: 'token', fromStep: 4, type: 'value' },
      { name: 'orderResp', fromStep: 5, type: 'response' }
    ]),
  chain.variables
);
const dup = gen.generateApiFlow({
  steps: [
    { actionId: 'set-var', params: { name: 'token', value: 'a' } },
    { actionId: 'set-var', params: { name: 'token', value: 'b' } }
  ],
  lang: 'java'
});
check(
  '变量名重复定义 → warning（说明会覆盖），变量表里仍是唯一一条',
  dup.warnings.some((w) => w.indexOf('已经定义过') >= 0) && dup.variables.length === 1,
  [dup.warnings, dup.variables]
);
const badName = gen.generateApiFlow({
  steps: [{ actionId: 'set-var', params: { name: 'bad name', value: 'x' } }],
  lang: 'java'
});
check(
  '变量名非法 → warning（不是合法标识符）',
  badName.warnings.some((w) => w.indexOf('不是合法的标识符') >= 0),
  badName.warnings
);
check(
  '不填「响应存为变量」→ 兜底 respN 并提示',
  (() => {
    const r = gen.generateApiFlow({
      steps: [{ actionId: 'call', params: { apiName: 'x', method: 'GET', path: '/x' } }],
      lang: 'java'
    });
    return r.code.indexOf('Response resp1 = given()') >= 0 && r.warnings.some((w) => w.indexOf('响应存为变量') >= 0);
  })(),
  gen.generateApiFlow({
    steps: [{ actionId: 'call', params: { apiName: 'x', method: 'GET', path: '/x' } }],
    lang: 'java'
  })
);
check(
  '未知动作被跳过并提示',
  (() => {
    const r = gen.generateApiFlow({
      steps: [LOGIN, { actionId: 'no-such', params: {} }],
      lang: 'java'
    });
    return r.warnings.some((w) => w.indexOf('不认识的动作') >= 0) && r.code.indexOf('no-such') < 0;
  })(),
  'not skipped'
);
check(
  '生成结果里不会残留 %key% 占位符（7 个动作逐个空参数跑一遍）',
  API_ACTIONS.every((a) => {
    const r = gen.generateApiFlow({ steps: [{ actionId: a.id, params: {} }], lang: 'java' });
    return !/%[A-Za-z0-9_]+%/.test(r.code);
  }),
  'leftover placeholder'
);
check(
  'header 里的 {{token}}（接口记录的 mustache 写法）也能当变量用',
  (() => {
    const r = gen.generateApiFlow({
      steps: [
        { actionId: 'set-var', params: { name: 'token', value: 'abc' } },
        {
          actionId: 'call',
          params: {
            apiName: 'x',
            as: 'r1',
            method: 'GET',
            path: '/x',
            headers: 'Authorization: Bearer {{token}}'
          }
        }
      ],
      lang: 'java'
    });
    return r.code.indexOf('.header("Authorization", "Bearer " + token)') >= 0 && r.warnings.length === 0;
  })(),
  'mustache not normalized'
);
/** 生成器真实的 require 调用（去掉注释行：头注释里拿 codegen.js 的 ejs 举例，不是依赖） */
function moduleRequires(file) {
  return read(file)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
    .match(/require\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
}

check(
  '生成器零依赖（只 require 纯数据的 apiActions，渲染进程能直接调用）',
  (() => {
    const reqs = moduleRequires(API_GEN_FILE);
    return reqs.length === 1 && reqs[0] === "require('./apiActions.js')";
  })(),
  moduleRequires(API_GEN_FILE)
);
check(
  '生成器只读步骤里的快照，不回查 apis 集合（快照语义）',
  !/collections|records\(|apis\.find/.test(read(API_GEN_FILE)),
  'reads apis'
);

/* ============================================================
 * 五、迷你渲染运行时（不依赖 React 包）
 * ============================================================ */
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };

function makeComp(name) {
  const C = (props) => ({ __comp: name, props: props || {} });
  C.__name = name;
  return C;
}
function makeProxy() {
  const cache = new Map();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (!cache.has(prop)) cache.set(prop, makeComp(prop));
        return cache.get(prop);
      }
    }
  );
}

function createRuntime() {
  const slots = [];
  let hookIndex = 0;
  let pendingEffects = [];
  let dirty = false;
  const toasts = [];

  function depsChanged(prev, deps) {
    if (!prev || !('deps' in prev)) return true;
    if (!deps || !prev.deps) return true;
    if (prev.deps.length !== deps.length) return true;
    for (let i = 0; i < deps.length; i++) {
      if (!Object.is(prev.deps[i], deps[i])) return true;
    }
    return false;
  }

  const hooks = {
    useState(init) {
      const i = hookIndex++;
      if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? init() : init };
      const slot = slots[i];
      if (!slot.set) {
        slot.set = (next) => {
          const v = typeof next === 'function' ? next(slot.value) : next;
          if (Object.is(v, slot.value)) return;
          slot.value = v;
          dirty = true;
        };
      }
      return [slot.value, slot.set];
    },
    useRef(init) {
      const i = hookIndex++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useEffect(fn, deps) {
      const i = hookIndex++;
      pendingEffects.push({ i, fn, deps });
    },
    useMemo(fn, deps) {
      const i = hookIndex++;
      const prev = slots[i];
      if (prev && !depsChanged(prev, deps)) return prev.value;
      const value = fn();
      slots[i] = { deps, value };
      return value;
    }
  };
  hooks.default = hooks;
  hooks.__esModule = true;

  function render(component, props) {
    let tree;
    let guard = 0;
    for (;;) {
      dirty = false;
      hookIndex = 0;
      pendingEffects = [];
      tree = component(props);
      for (const e of pendingEffects) {
        const prev = slots[e.i];
        if (!depsChanged(prev, e.deps)) continue;
        if (prev && typeof prev.cleanup === 'function') prev.cleanup();
        const cleanup = e.fn();
        slots[e.i] = { deps: e.deps, cleanup };
      }
      guard += 1;
      if (!dirty || guard > 40) break;
    }
    return tree;
  }

  const antd = makeProxy();
  const icons = makeProxy();
  const moduleCache = new Map();

  function load(file, overrides) {
    const abs = path.resolve(file);
    if (moduleCache.has(abs)) return moduleCache.get(abs);
    const src = read(abs);
    const { code } = esbuild.transformSync(src, {
      loader: /\.tsx$/.test(abs) ? 'tsx' : 'ts',
      format: 'cjs',
      jsx: 'automatic',
      target: 'node18',
      charset: 'utf8',
      sourcefile: abs
    });
    const mod = { exports: {} };
    moduleCache.set(abs, mod.exports);
    const requireStub = (id) => {
      if (overrides && overrides[id]) return overrides[id]();
      if (id === 'react') return hooks;
      if (id === 'react/jsx-runtime') return jsxRuntime;
      if (id === 'antd') return antd;
      if (id === '@ant-design/icons') return icons;
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(abs), id);
        const hit =
          ['.tsx', '.ts', '.js', '.json'].map((e) => base + e).filter((p) => fs.existsSync(p))[0] ||
          (fs.existsSync(base) ? base : null);
        if (!hit) throw new Error('测试找不到模块：' + id + '（来自 ' + abs + '）');
        const rel = path.relative(ROOT, hit).replace(/\\/g, '/');
        if (rel.indexOf('shared/') === 0) return require(hit);
        return load(hit);
      }
      throw new Error('测试没有为这个依赖准备桩：' + id);
    };
    new Function('require', 'module', 'exports', code)(requireStub, mod, mod.exports);
    moduleCache.set(abs, mod.exports);
    return mod.exports;
  }

  return { render, load, antd, icons, toasts, hooks };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function collect(node, out) {
  const acc = out || [];
  if (node === null || node === undefined || typeof node === 'boolean') return acc;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  acc.push(node);
  if (node.props) collect(node.props.children, acc);
  return acc;
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props) return textOf(node.props.children);
  return '';
}

const hasText = (tree, s) => collect(tree).some((n) => textOf(n).indexOf(s) >= 0);
const nodesOf = (tree, type) => collect(tree).filter((n) => n.type === type);

/* ============================================================
 * 六、UI：CodegenPage 的视图切换
 * ============================================================ */
(async () => {
  const APIS = [
    {
      id: 'a1',
      collection: 'apis',
      title: '登录',
      data: {
        name: '登录',
        method: 'POST',
        url: '/api/login',
        headers: 'Content-Type: application/json',
        body: '{"username":"admin","password":"123"}'
      }
    },
    {
      id: 'a2',
      collection: 'apis',
      title: '查订单',
      data: {
        name: '查订单',
        method: 'GET',
        url: '/api/order',
        headers: 'Authorization: Bearer {{token}}',
        body: ''
      }
    }
  ];

  const codegenSrc = read(CODEGEN);
  const panelSrc = read(PANEL);
  const helpersSrc = read(HELPERS);
  const genSrc = read(API_GEN_FILE);

  check('CodegenPage 引用了 api-bricks/ApiBricksPanel（受保护 require）', /api-bricks\/ApiBricksPanel/.test(codegenSrc), 'no panel import');
  check(
    'CodegenPage 有接口积木的目标闸门（java-restassured / python-pytest）',
    /API_BRICKS_TARGETS\s*=\s*\['java-restassured', 'python-pytest'\]/.test(codegenSrc) &&
      /isApiBricksTarget/.test(codegenSrc),
    'no api gate'
  );
  check(
    'Playwright 的闸门没被改坏（kind === page && playwright- 前缀）',
    /kind === 'page' && String\(targetKey\)\.indexOf\('playwright-'\) === 0/.test(codegenSrc),
    'playwright gate broken'
  );
  check(
    '接口积木的状态也有 ref 兜底（切视图回来步骤不丢）',
    /apiBricksStateRef/.test(codegenSrc) && /initialState=\{apiBricksStateRef\.current\}/.test(codegenSrc),
    'no api state ref'
  );
  check(
    'CodegenPage 把 flows 按 kind 拆成两拨（flows / apiFlows）',
    /setApiFlows/.test(codegenSrc) && /flowIsApiKind/.test(codegenSrc) && /flows=\{apiFlows\}/.test(codegenSrc),
    'flows not split'
  );

  const rt = createRuntime();
  const pageEditorStub = {
    parseElements: () => [],
    LOCATOR_MODE_OPTIONS: [],
    LOCATOR_MODE_PLACEHOLDER: {},
    normalizeMode: (m) => (m ? m : 'css'),
    looksLikeXPath: () => false
  };
  const recordsByCollection = { apis: APIS, pages: [], flows: [] };
  const apiStub = {
    codegenTargets: async () => ({ targets: require('../shared/codegen.js').listTargets() }),
    records: async (c) => recordsByCollection[c] || [],
    copy: async () => true,
    saveRecord: async (input) => ({ id: 'new', data: input.data, title: input.title })
  };

  const pageMod = rt.load(CODEGEN, {
    '../api': () => ({ __esModule: true, default: apiStub }),
    '../msg': () => ({ __esModule: true, toast: (m) => rt.toasts.push(m) }),
    '../components/PageElementsEditor': () => pageEditorStub
  });
  const ApiBricksPanel = rt.load(PANEL).default;

  let tree = rt.render(pageMod.default, {});
  await tick();
  await tick();
  tree = rt.render(pageMod.default, {});

  /** 视图切换的文案在 Segmented 的 options 里（不是 children），只能查 props */
  const hasApiViewSwitch = (t) =>
    collect(t).some(
      (n) =>
        n.type === rt.antd.Segmented &&
        Array.isArray(n.props.options) &&
        n.props.options.some((o) => o.label === '接口流程（积木）') &&
        n.props.options.some((o) => o.label === '接口测试类骨架')
    );

  check('接口目标（默认 java-restassured）下渲染出接口积木视图切换', hasApiViewSwitch(tree), 'no api segmented');
  check('接口目标下**不**渲染 UI 积木区', collect(tree).every((n) => n.type !== rt.load(path.join(ROOT, 'src/components/ui-bricks/BricksPanel.tsx')).default), 'ui bricks leaked');
  check('接口目标下视图切换默认停在「单个接口」（老路径不变）', !!collect(tree).find((n) => n.type === rt.antd.Segmented && n.props.value === 'single'), 'not single by default');
  check('默认（单个接口）视图里没有接口积木面板', collect(tree).every((n) => n.type !== ApiBricksPanel), 'panel leaked');
  check('默认视图仍是原来的两栏（codegen-body）', collect(tree).some((n) => n.props && n.props.className === 'codegen-body'), 'no codegen-body');

  const apiSwitch = collect(tree).find(
    (n) =>
      n.type === rt.antd.Segmented &&
      Array.isArray(n.props.options) &&
      n.props.options.some((o) => o.label === '接口流程（积木）') &&
      n.props.options.some((o) => o.label === '接口测试类骨架')
  );
  check('两个视图的文案是「接口测试类骨架 / 接口流程（积木）」', !!apiSwitch, 'no switch');

  apiSwitch.props.onChange('bricks');
  tree = rt.render(pageMod.default, {});
  const panelNode = collect(tree).find((n) => n.type === ApiBricksPanel);
  check('切到「接口流程（积木）」后渲染接口积木面板', !!panelNode, 'no panel');
  check(
    '面板拿到 apis 集合与语言（props 透传正确）',
    !!panelNode && panelNode.props.apis.length === 2 && panelNode.props.lang === 'java',
    panelNode && { apis: panelNode.props.apis.length, lang: panelNode.props.lang }
  );
  check('积木视图下工具条的「生成预览」让位（不点了没反应）', !hasText(tree, '生成预览'), 'preview button still there');

  /* 切到 Playwright 目标 → 接口积木消失、出现 UI 积木 */
  const targetSelect = collect(tree).find(
    (n) => n.props && Array.isArray(n.props.options) && n.props.options.every((o) => o && Array.isArray(o.options))
  );
  targetSelect.props.onChange('playwright-java');
  tree = rt.render(pageMod.default, {});
  check('切到 Playwright 目标后接口积木彻底消失', collect(tree).every((n) => n.type !== ApiBricksPanel), 'api panel leaked');
  check('Playwright 目标下也不显示接口的视图切换', !hasApiViewSwitch(tree), 'api segmented leaked');

  collect(tree)
    .find((n) => n.props && Array.isArray(n.props.options) && n.props.options.every((o) => o && Array.isArray(o.options)))
    .props.onChange('pojo-java');
  tree = rt.render(pageMod.default, {});
  check('模型目标（pojo-java）下也没有接口积木（只在 api 类目标显示）', collect(tree).every((n) => n.type !== ApiBricksPanel), 'panel on model target');

  collect(tree)
    .find((n) => n.props && Array.isArray(n.props.options) && n.props.options.every((o) => o && Array.isArray(o.options)))
    .props.onChange('python-pytest');
  tree = rt.render(pageMod.default, {});
  check('接口目标切到 python-pytest 后视图切换还在（语言跟着目标走）', hasApiViewSwitch(tree), 'no segmented on python target');

  /* ============================================================
   * 七、UI：三栏面板交互
   * ============================================================ */
  const rt2 = createRuntime();
  const Panel = rt2.load(PANEL).default;
  const modalSrc = read(PARAM_MODAL);

  /* 参数面板按 param.type 分派（3.3 的两个特殊控件都在这） */
  check(
    '参数面板有 apiRecord 分支（从 apis 集合选接口 + 选中存快照）',
    /p\.type === 'apiRecord'/.test(modalSrc) && /apiSnapshot\(hit\)/.test(modalSrc) && /apiOptions\(apis\)/.test(modalSrc),
    'no apiRecord branch'
  );
  check(
    '参数面板有 ident 分支（`from` 给变量下拉 + 其它变量名做合法性校验）',
    /p\.type === 'ident'/.test(modalSrc) && /p\.key === 'from'/.test(modalSrc) && /identOk\(value\)/.test(modalSrc),
    'no ident branch'
  );
  check(
    '参数面板有「插入变量」下拉，插入走 insertVarToken（能插到光标处）',
    /placeholder="插入变量"/.test(modalSrc) && /insertVarToken\(/.test(modalSrc),
    'no insert-var control'
  );

  const UI_FLOW = {
    id: 'fl-ui',
    collection: 'flows',
    title: '登录页流程-1125',
    data: { name: '登录页流程-1125', pageId: 'pg1', pageName: '登录页', steps: '[]', pomMode: 'generated' }
  };
  const API_FLOW = {
    id: 'fl-api',
    collection: 'flows',
    title: '接口流程-1125',
    data: {
      name: '接口流程-1125',
      kind: 'api',
      baseUrl: 'http://localhost:8080',
      testName: 'testOrderFlow',
      steps: JSON.stringify([
        {
          actionId: 'call',
          params: {
            apiId: 'a1',
            apiName: '登录',
            as: 'loginResp',
            method: 'POST',
            path: '/api/login',
            headers: [{ k: 'Content-Type', v: 'application/json' }],
            body: '{"username":"admin","password":"123"}'
          }
        },
        { actionId: 'extract-json', params: { from: 'loginResp', path: '$.data.token', as: 'token' } },
        { actionId: 'assert-status', params: { from: 'loginResp', code: 200 } }
      ]),
      note: '演示'
    }
  };

  const calls = { saved: null, notify: [], copied: null };
  const props = {
    apis: APIS,
    lang: 'java',
    flows: [UI_FLOW, API_FLOW],
    onCopy: (t) => (calls.copied = t),
    onSaveFlow: (d) => {
      calls.saved = d;
      return true;
    },
    onNotify: (m, l) => calls.notify.push([m, l]),
    onStateChange: () => {}
  };

  let panel = rt2.render(Panel, props);
  check(
    '三栏齐了（积木库 / 已选步骤 / 生成结果）',
    hasText(panel, '积木库') && hasText(panel, '已选步骤') && hasText(panel, '生成结果'),
    'missing column'
  );
  check(
    '积木库按 4 个分类分组（请求 / 提取 / 断言 / 变量）',
    ['请求', '提取', '断言', '变量'].every((l) => hasText(panel, l)),
    'no categories'
  );
  const addButtons = nodesOf(panel, rt2.antd.Button).filter(
    (n) => n.props.icon && n.props.icon.type === rt2.icons.PlusOutlined
  );
  check('积木库里 7 个动作各一个按钮', addButtons.length === API_ACTIONS.length, [addButtons.length, API_ACTIONS.length]);
  check('空步骤时结果区提示先加一步', hasText(panel, '还没有选任何步骤'), 'no empty hint');
  check('设置条上有 BaseUrl 与「方法名」输入', hasText(panel, 'BaseUrl') && hasText(panel, '方法名'), 'no baseUrl input');

  /* ---- 点「调用接口」→ apiRecord 下拉 → 存快照 ---- */
  nodesOf(panel, rt2.antd.Button).find((n) => textOf(n) === '调用接口').props.onClick();
  panel = rt2.render(Panel, props);
  const modalNode = collect(panel).find((n) => n.props && n.props.action && n.props.action.id === 'call');
  check('点「调用接口」弹出参数面板', !!modalNode, 'no modal');
  const modalTree = modalNode.type(modalNode.props);
  const apiSelect = collect(modalTree).find(
    (n) => n.type === rt2.antd.Select && Array.isArray(n.props.options) && n.props.options.some((o) => String(o.label).indexOf('/api/login') >= 0)
  );
  check(
    'apiRecord 参数的下拉从 apis 集合读（2 条，标签带方法+路径+名字）',
    !!apiSelect && apiSelect.props.options.length === 2 && /^POST \/api\/login · 登录$/.test(apiSelect.props.options[0].label),
    apiSelect && apiSelect.props.options
  );
  apiSelect.props.onChange('a1');
  panel = rt2.render(Panel, props);
  const modalNode2 = collect(panel).find((n) => n.props && n.props.action && n.props.action.id === 'call');
  check(
    '选中接口后把 method/path/headers/body 存成快照（不是只存 apiId）',
    modalNode2.props.params.method === 'POST' &&
      modalNode2.props.params.path === '/api/login' &&
      JSON.stringify(modalNode2.props.params.headers) === JSON.stringify([{ k: 'Content-Type', v: 'application/json' }]) &&
      modalNode2.props.params.body.indexOf('admin') >= 0 &&
      modalNode2.props.params.apiName === '登录',
    modalNode2.props.params
  );
  check('选中接口后响应变量自动起名（resp1，不和前面撞）', modalNode2.props.params.as === 'resp1', modalNode2.props.params.as);
  modalNode2.props.onOk();
  panel = rt2.render(Panel, props);
  const codeArea = collect(panel).find((n) => n.type === 'textarea');
  check(
    '加完步骤后结果区实时出给定接口的请求代码',
    codeArea.props.value.indexOf('Response resp1 = given()') >= 0 &&
      codeArea.props.value.indexOf('.post("/api/login")') >= 0,
    codeArea.props.value
  );
  check('步骤列表里显示「POST /api/login → resp1」', hasText(panel, 'POST /api/login → resp1'), 'no step row');
  check('需要的 import 单独列出来（Response / given）', hasText(panel, 'io.restassured.response.Response'), 'no imports');

  /* ---- 变量下拉：只列前面步骤已经产生的变量 ---- */
  const BOOT = {
    steps: [
      {
        key: 's1',
        actionId: 'call',
        params: {
          apiId: 'a1',
          apiName: '登录',
          as: 'loginResp',
          method: 'POST',
          path: '/api/login',
          headers: [],
          body: ''
        }
      },
      { key: 's2', actionId: 'extract-json', params: { from: 'loginResp', path: '$.data.token', as: 'token' } },
      { key: 's3', actionId: 'assert-status', params: { from: 'token', code: 201 } }
    ],
    baseUrl: 'http://localhost:8080',
    testName: ''
  };

  const rt3 = createRuntime();
  const Panel3 = rt3.load(PANEL).default;
  const Panel3Props = Object.assign({}, props, { initialState: BOOT, flows: [] });
  let panel3 = rt3.render(Panel3, Panel3Props);
  check('用 initialState 恢复 3 步（切视图回来不丢）', hasText(panel3, '已选步骤（3）'), 'no restore');

  /* 点第 3 步（assert-status）→ 它的「响应变量」下拉只能列第 1、2 步的变量 */
  const stepRow = collect(panel3).find(
    (n) => n.props && n.props.title === '点击修改参数；按住可拖动排序' && textOf(n).indexOf('断言状态码') >= 0
  );
  check('步骤行可点击编辑', !!stepRow, 'no step row');
  stepRow.props.onClick();
  panel3 = rt3.render(Panel3, Panel3Props);
  const assertModal = collect(panel3).find((n) => n.props && n.props.action && n.props.action.id === 'assert-status');
  const assertTree = assertModal.type(assertModal.props);
  const fromSelect = collect(assertTree).find((n) => n.type === rt3.antd.AutoComplete);
  check(
    '「从哪个响应」下拉只列前面步骤的变量（loginResp / token，且带第几步）',
    !!fromSelect &&
      fromSelect.props.options.length === 2 &&
      fromSelect.props.options[0].value === 'loginResp' &&
      /loginResp（第 1 步 · POST \/api\/login）/.test(fromSelect.props.options[0].label) &&
      fromSelect.props.options[1].value === 'token',
    fromSelect && fromSelect.props.options
  );
  check(
    '变量下拉不列「当前这一步之后」的变量（不然生成器会报未定义）',
    !!fromSelect && fromSelect.props.options.every((o) => o.value !== 'respFuture'),
    fromSelect && fromSelect.props.options
  );

  /* ---- 「插入变量」下拉：点了把 ${var} 插进文本 ---- */
  const rt4 = createRuntime();
  const Panel4 = rt4.load(PANEL).default;
  const Panel4Props = Object.assign({}, props, { initialState: BOOT, flows: [] });
  let panel4 = rt4.render(Panel4, Panel4Props);
  nodesOf(panel4, rt4.antd.Button).find((n) => textOf(n) === '设置变量').props.onClick();
  panel4 = rt4.render(Panel4, Panel4Props);
  const svModal = collect(panel4).find((n) => n.props && n.props.action && n.props.action.id === 'set-var');
  const svTree = svModal.type(svModal.props);
  const insertSelect = collect(svTree).find(
    (n) => n.type === rt4.antd.Select && n.props.placeholder === '插入变量'
  );
  check('文本参数旁有「插入变量」下拉（只列前面步骤的变量）', !!insertSelect && insertSelect.props.options.length === 2, insertSelect && insertSelect.props.options);
  insertSelect.props.onChange('token');
  panel4 = rt4.render(Panel4, Panel4Props);
  const svModal2 = collect(panel4).find((n) => n.props && n.props.action && n.props.action.id === 'set-var');
  check('点「插入变量」把 ${token} 写进值里', svModal2.props.params.value === '${token}', svModal2.props.params.value);
  svModal2.props.onOk();
  panel4 = rt4.render(Panel4, Panel4Props);
  check(
    '变量引用落进代码：String myVar = token;（不是死字符串）',
    collect(panel4).find((n) => n.type === 'textarea').props.value.indexOf('String myVar = token;') >= 0,
    collect(panel4).find((n) => n.type === 'textarea').props.value
  );

  /* ---- 非法变量名：面板里当场提示 ---- */
  const rt5 = createRuntime();
  const Panel5 = rt5.load(PANEL).default;
  const Panel5Props = Object.assign({}, props, { initialState: { steps: [], baseUrl: '', testName: '' }, flows: [] });
  let panel5 = rt5.render(Panel5, Panel5Props);
  nodesOf(panel5, rt5.antd.Button).find((n) => textOf(n) === '设置变量').props.onClick();
  panel5 = rt5.render(Panel5, Panel5Props);
  const sv5 = collect(panel5).find((n) => n.props && n.props.action && n.props.action.id === 'set-var');
  const nameInput = nodesOf(sv5.type(sv5.props), rt5.antd.Input).find((n) => n.props.value === 'myVar');
  check('变量名输入框有默认值 myVar', !!nameInput, 'no name input');
  nameInput.props.onChange({ target: { value: 'my var' } });
  panel5 = rt5.render(Panel5, Panel5Props);
  const sv5b = collect(panel5).find((n) => n.props && n.props.action && n.props.action.id === 'set-var');
  check(
    '变量名不合法时参数面板当场标红并说明规则',
    hasText(sv5b.type(sv5b.props), '变量名只能用字母 / 数字 / 下划线'),
    'no inline validation'
  );

  /* ---- 保存为流程：kind: 'api' + baseUrl ---- */
  const rt6 = createRuntime();
  const Panel6 = rt6.load(PANEL).default;
  // 每个 runtime 有自己的 module 缓存：比较组件身份必须用同一个 runtime 加载的那份
  const SaveModal6 = rt6.load(SAVE_MODAL).default;
  const saved = { data: null };
  const Panel6Props = Object.assign({}, props, {
    initialState: BOOT,
    flows: [UI_FLOW, API_FLOW],
    onSaveFlow: (d) => {
      saved.data = d;
      return true;
    }
  });
  let panel6 = rt6.render(Panel6, Panel6Props);
  const saveBtn = nodesOf(panel6, rt6.antd.Button).find((n) => textOf(n) === '保存为流程');
  check('工具条上有「保存为流程」按钮且可用', !!saveBtn && saveBtn.props.disabled === false, saveBtn && saveBtn.props.disabled);
  saveBtn.props.onClick();
  panel6 = rt6.render(Panel6, Panel6Props);
  const saveModalNode = collect(panel6).find((n) => n.type === SaveModal6);
  check('点保存弹出保存弹窗（默认名「接口流程-MMDD」）', !!saveModalNode && /^接口流程-\d{4}$/.test(saveModalNode.props.name), saveModalNode && saveModalNode.props.name);
  nodesOf(saveModalNode.type(saveModalNode.props), rt6.antd.Modal)[0].props.onOk();
  await tick();
  await tick();
  check('保存时写了 kind: "api"（UI 积木据此不列它）', !!saved.data && saved.data.kind === 'api', saved.data);
  check('保存时带上 baseUrl 与测试方法名', !!saved.data && saved.data.baseUrl === 'http://localhost:8080' && saved.data.testName === '', saved.data);
  check(
    '保存的 steps 是 JSON 字符串且不存前端 key',
    (() => {
      const list = JSON.parse(saved.data.steps);
      return list.length === 3 && list.every((s) => !('key' in s)) && list[0].params.method === 'POST';
    })(),
    saved.data && saved.data.steps
  );

  /* ---- 载入流程：只列 kind === 'api' ---- */
  const rt7 = createRuntime();
  const Panel7 = rt7.load(PANEL).default;
  const loaded = { notify: [] };
  const Panel7Props = Object.assign({}, props, {
    flows: [UI_FLOW, API_FLOW],
    onNotify: (m, l) => loaded.notify.push([m, l])
  });
  let panel7 = rt7.render(Panel7, Panel7Props);
  const loadSelect = nodesOf(panel7, rt7.antd.Select).find((n) => /载入流程/.test(String(n.props.placeholder || '')));
  check(
    '「载入流程」只列 kind === "api" 的流程（UI 流程不串台）',
    !!loadSelect && loadSelect.props.options.length === 1 && loadSelect.props.options[0].value === 'fl-api',
    loadSelect && loadSelect.props.options
  );
  loadSelect.props.onChange('fl-api');
  panel7 = rt7.render(Panel7, Panel7Props);
  check('载入后恢复 3 步并出代码', hasText(panel7, '已选步骤（3）') && collect(panel7).find((n) => n.type === 'textarea').props.value.indexOf('.post("/api/login")') >= 0, 'load failed');
  check('载入后恢复 baseUrl（结果里出现 baseUri）', collect(panel7).find((n) => n.type === 'textarea').props.value.indexOf('.baseUri("http://localhost:8080")') >= 0, collect(panel7).find((n) => n.type === 'textarea').props.value);
  check('载入后弹 toast', loaded.notify.some(([m]) => m.indexOf('已载入流程「接口流程-1125」') >= 0), loaded.notify);

  /* ---- 复制：import + 方法体一起给 ---- */
  const rt8 = createRuntime();
  const Panel8 = rt8.load(PANEL).default;
  const copied = {};
  const Panel8Props = Object.assign({}, props, { initialState: BOOT, flows: [], onCopy: (t) => (copied.text = t) });
  let panel8 = rt8.render(Panel8, Panel8Props);
  nodesOf(panel8, rt8.antd.Button)
    .find((n) => n.props.icon && n.props.icon.type === rt8.icons.CopyOutlined)
    .props.onClick();
  check(
    '复制把 import + 方法体一起给出去',
    typeof copied.text === 'string' && copied.text.indexOf('io.restassured.response.Response') >= 0 && copied.text.indexOf('@Test') >= 0,
    copied.text && copied.text.slice(0, 60)
  );

  /* ============================================================
   * 八、flows 扩展：kind 字段
   * ============================================================ */
  const flowsConf = COLLECTION_MAP.flows;
  const kindField = (flowsConf.fields || []).find((f) => f.key === 'kind');
  check('flows 有 kind 字段（流程类型）', !!kindField && kindField.label === '流程类型' && kindField.type === 'text', kindField);
  check(
    'kind 是 formHidden + hideInForm，并写明 formHiddenReason（详情/表单一致性）',
    !!kindField && kindField.formHidden === true && kindField.hideInForm === true && /ui\/api/.test(String(kindField.formHiddenReason)),
    kindField
  );
  check(
    'flows 里所有 formHidden 字段都写了 formHiddenReason（没引入新的不一致）',
    (flowsConf.fields || []).filter((f) => f.formHidden && !String(f.formHiddenReason || '').trim()).length === 0,
    (flowsConf.fields || []).filter((f) => f.formHidden && !f.formHiddenReason).map((f) => f.key)
  );
  check(
    '老记录没有 kind → flowKindOf 返回 "ui"',
    (() => {
      const rtH = createRuntime();
      const helpers = rtH.load(HELPERS);
      return (
        helpers.flowKindOf({ id: 'x', data: { name: '老流程' } }) === 'ui' &&
        helpers.flowKindOf({ id: 'x', data: { name: '新流程', kind: 'api' } }) === 'api' &&
        helpers.flowKindOf({ id: 'x', data: { name: '大写', kind: ' API ' } }) === 'api' &&
        helpers.flowKindOf(null) === 'ui'
      );
    })(),
    'kind fallback wrong'
  );
  check(
    'apiFlowsOnly 只留 api 流程，parseApiFlowSteps 对坏 JSON 返回空数组',
    (() => {
      const rtH = createRuntime();
      const helpers = rtH.load(HELPERS);
      return (
        helpers.apiFlowsOnly([UI_FLOW, API_FLOW]).length === 1 &&
        helpers.apiFlowsOnly([UI_FLOW, API_FLOW])[0].id === 'fl-api' &&
        helpers.parseApiFlowSteps('{not json').length === 0 &&
        helpers.parseApiFlowSteps(JSON.stringify([{ actionId: 'no-such' }, { actionId: 'call' }])).length === 1
      );
    })(),
    'api flows helpers wrong'
  );
  check(
    'CodegenPage 的 flowIsApiKind 兜底规则和 apiBrickHelpers.flowKindOf 一致',
    /String\(d\.kind \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'api'/.test(codegenSrc),
    'fallback rule drifted'
  );
  check(
    'apiSnapshot 存的是「当时」的接口数据（不是 id 引用）',
    (() => {
      const rtH = createRuntime();
      const helpers = rtH.load(HELPERS);
      const snap = helpers.apiSnapshot(APIS[1]);
      return (
        snap.apiId === 'a2' &&
        snap.apiName === '查订单' &&
        snap.method === 'GET' &&
        snap.path === '/api/order' &&
        Array.isArray(snap.headers) &&
        snap.headers[0].k === 'Authorization' &&
        snap.body === ''
      );
    })(),
    'snapshot wrong'
  );
  check(
    '预览 mock 里两条流程：一条无 kind（当 ui）、一条 kind: "api"',
    /kind: 'api'/.test(read(MOCK)) && /登录页流程-1125/.test(read(MOCK)) && /接口流程-1125/.test(read(MOCK)),
    'mock flows missing'
  );
  check(
    'helpers 里没有第二套变量命名规则（复用 apiActions 的 isIdentifier）',
    /from '\.\.\/\.\.\/\.\.\/shared\/apiActions'/.test(helpersSrc) &&
      /isIdentifier/.test(helpersSrc) &&
      !/\/\^\[A-Za-z_\]/.test(helpersSrc),
    'duplicated identifier rule'
  );
  check(
    '面板源码里没有裸 api 请求（生成代码全靠 shared/apiFlowGen）',
    !/fetch\(|axios/.test(panelSrc) && /from '\.\.\/\.\.\/\.\.\/shared\/apiFlowGen'/.test(panelSrc),
    'panel builds code itself'
  );
  check(
    '生成器用了和 uiStepGen 一样的「纯函数 + warnings」形态',
    /warnings\.push|warnOnce\(/.test(genSrc) && /variables:/.test(genSrc) && /imports:/.test(genSrc),
    'generator shape changed'
  );

  /* ============================================================
   * 九、真实 React + antd 渲染（防 antd 用法写错）
   * ============================================================ */
  function createRealLoader() {
    const cache = new Map();
    function load(file) {
      const abs = path.resolve(file);
      if (cache.has(abs)) return cache.get(abs);
      const src = read(abs);
      const { code } = esbuild.transformSync(src, {
        loader: /\.tsx$/.test(abs) ? 'tsx' : 'ts',
        format: 'cjs',
        jsx: 'automatic',
        target: 'node18',
        charset: 'utf8',
        sourcefile: abs
      });
      const mod = { exports: {} };
      cache.set(abs, mod.exports);
      const req = (id) => {
        if (id === 'react') return require('react');
        if (id === 'react/jsx-runtime') return require('react/jsx-runtime');
        if (id === 'antd') return require('antd');
        if (id === '@ant-design/icons') return require('@ant-design/icons');
        if (id.startsWith('.')) {
          const base = path.resolve(path.dirname(abs), id);
          const hit =
            ['.tsx', '.ts', '.js'].map((e) => base + e).filter((p) => fs.existsSync(p))[0] ||
            (fs.existsSync(base) ? base : null);
          if (!hit) throw new Error('测试找不到模块：' + id + '（来自 ' + abs + '）');
          const rel = path.relative(ROOT, hit).replace(/\\/g, '/');
          if (rel.indexOf('shared/') === 0) return require(hit);
          return load(hit);
        }
        throw new Error('测试没有为这个依赖准备桩：' + id);
      };
      new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
      cache.set(abs, mod.exports);
      return mod.exports;
    }
    return load;
  }

  let realHtml = '';
  let realErr = '';
  try {
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const RealPanel = createRealLoader()(PANEL).default;
    realHtml = renderToStaticMarkup(
      React.createElement(RealPanel, {
        apis: APIS,
        lang: 'java',
        flows: [UI_FLOW, API_FLOW],
        onCopy: () => {},
        onSaveFlow: () => true,
        onNotify: () => {},
        initialState: BOOT,
        onStateChange: () => {}
      })
    );
  } catch (e) {
    realErr = (e && e.message) || String(e);
  }
  check('真实 React + antd 能把接口积木面板渲染出来', !realErr && realHtml.length > 1000, realErr || String(realHtml.length));
  check('真实渲染结果里有可编辑 textarea', /<textarea/.test(realHtml), realHtml.slice(0, 160));
  check(
    '真实渲染结果里有积木库 / BaseUrl / 生成结果',
    realHtml.indexOf('积木库') >= 0 && realHtml.indexOf('BaseUrl') >= 0 && realHtml.indexOf('生成结果') >= 0,
    'missing text'
  );
  check(
    '真实渲染结果里有生成的请求代码（POST /api/login）',
    realHtml.indexOf('/api/login') >= 0,
    realHtml.slice(0, 200)
  );

  /* ============================================================
   * 汇总
   * ============================================================ */
  const failed = results.filter((r) => !r.ok);
  console.log('===== 接口积木（接口流程拼装）测试 =====');
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  }
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();