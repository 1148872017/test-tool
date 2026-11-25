/* Allure 步骤解析（steps 递归 + 统计 + 首个失败步骤 + 截断）与前端步骤展示 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
/* 真实目录不存在时显式跳过：跳过进汇总，不静默变全绿 */
const skipped = [];
const skip = (name) => skipped.push(name);

const allure = require('../electron/allure.js');

/* ============================================================
 * 1. 造一份带步骤的 allure-results（临时目录，任何机器都能跑）
 * ============================================================ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'allure-steps-'));
const dir = path.join(tmp, 'allure-results');
fs.mkdirSync(dir, { recursive: true });

/** 3 个平行步骤：最后一步失败，带一个附件 */
const login = {
  uuid: 't-login',
  name: '空用户名登录应返回 400',
  fullName: 'com.example.tests.LoginTest.testEmptyUsername',
  status: 'failed',
  statusDetails: { message: '期望 HTTP 400，实际 500：服务端未对空参数做校验', trace: 'HTTP/1.1 500\nat com.example.UserApi.login' },
  start: 1000,
  stop: 1800,
  steps: [
    { name: '构造 username="" 的请求体', status: 'passed', stage: 'finished', start: 1000, stop: 1120, steps: [], attachments: [] },
    { name: 'POST /api/login', status: 'passed', stage: 'finished', start: 1120, stop: 1600, steps: [], attachments: [] },
    {
      name: '断言 HTTP 400',
      status: 'failed',
      stage: 'finished',
      start: 1600,
      stop: 1800,
      steps: [],
      attachments: [{ name: '接口响应 / 异常堆栈', source: 'resp-attachment.txt', type: 'text/plain' }]
    }
  ],
  attachments: [{ name: '请求日志', source: 'req-attachment.txt', type: 'text/plain' }],
  labels: [
    { name: 'suite', value: '登录接口' },
    { name: 'subSuite', value: '用户认证' },
    { name: 'testClass', value: 'com.example.tests.LoginTest' },
    { name: 'testMethod', value: 'testEmptyUsername' },
    { name: 'feature', value: '登录' },
    { name: 'story', value: '空参数校验' },
    { name: 'severity', value: 'critical' },
    { name: 'framework', value: 'testng' }
  ]
};

/** 3 层嵌套：A → A1 → A1a，A2 是失败的那层；另有 1 个 skipped */
const nested = {
  uuid: 't-nested',
  name: '嵌套步骤用例',
  fullName: 'com.example.tests.NestedTest.testDeep',
  status: 'failed',
  statusDetails: { message: '嵌套里挂了', trace: '' },
  start: 2000,
  stop: 2600,
  steps: [
    {
      // 缺 start/stop：duration 必须给 0，不能 NaN
      name: '第一层：走完整个下单链路',
      status: 'passed',
      steps: [
        {
          name: '第二层：准备数据',
          status: 'passed',
          start: 2000,
          stop: 2050,
          steps: [{ name: '第三层：插入 SKU 表', status: 'passed', start: 2000, stop: 2020, steps: [], attachments: [] }],
          attachments: []
        },
        {
          name: '第二层：断言 JSON schema',
          status: 'failed',
          start: 2050,
          stop: 2500,
          steps: [],
          attachments: [{ name: '实际响应', source: 'nested-attachment.txt', type: 'application/json' }]
        }
      ],
      attachments: []
    },
    { name: '第一层：清理数据', status: 'skipped', start: 2500, stop: 2600, steps: [], attachments: [] }
  ],
  attachments: [],
  labels: [{ name: 'suite', value: '下单接口' }]
};

/** 完全没有 steps 字段（如 @BeforeClass 里就挂了） */
const noSteps = {
  uuid: 't-nosteps',
  name: '依赖数据缺失被跳过',
  fullName: 'com.example.tests.GoodsTest.testNotFound',
  status: 'skipped',
  statusDetails: { message: '商品 SKU 表为空', trace: '' },
  start: 3000,
  stop: 3000,
  labels: [{ name: 'suite', value: '商品接口' }]
};

fs.writeFileSync(path.join(dir, 'login-result.json'), JSON.stringify(login), 'utf8');
fs.writeFileSync(path.join(dir, 'nested-result.json'), JSON.stringify(nested), 'utf8');
fs.writeFileSync(path.join(dir, 'nosteps-result.json'), JSON.stringify(noSteps), 'utf8');

/* ============================================================
 * 2. 解析：顶层字段 + steps + 统计
 * ============================================================ */
const res = allure.parseAllureDir(dir);
check('解析成功', res.ok === true, res.message);
check('解析出 3 个用例', res.tests.length === 3, res.tests.length);
check('每个用例都有 steps 数组', res.tests.every((t) => Array.isArray(t.steps)), res.tests.map((t) => typeof t.steps));

const tLogin = res.tests.find((t) => t.id === 't-login');
check('找到失败用例', !!tLogin, res.tests.map((t) => t.id));
check('失败用例 firstFailedStep = 断言 HTTP 400', tLogin.firstFailedStep === '断言 HTTP 400', tLogin.firstFailedStep);
check('stepSummary.total = 3（顶层 3 步）', tLogin.stepSummary.total === 3, tLogin.stepSummary);
check('stepSummary.passed = 2', tLogin.stepSummary.passed === 2, tLogin.stepSummary);
check('stepSummary.failed = 1', tLogin.stepSummary.failed === 1, tLogin.stepSummary);
check(
  'stepSummary 没有多算（skipped/broken 全 0）',
  tLogin.stepSummary.skipped === 0 && tLogin.stepSummary.broken === 0,
  tLogin.stepSummary
);

const lastStep = tLogin.steps[2];
check('失败步骤的附件被解析', lastStep.attachments.length === 1, lastStep.attachments);
check(
  '步骤附件含 name/source/type',
  lastStep.attachments[0].name === '接口响应 / 异常堆栈' &&
    lastStep.attachments[0].source === 'resp-attachment.txt' &&
    lastStep.attachments[0].type === 'text/plain',
  lastStep.attachments[0]
);
check('步骤耗时为 200ms（1600→1800）', lastStep.duration === 200, lastStep.duration);
check('步骤名/状态原样带过来', lastStep.name === '断言 HTTP 400' && lastStep.status === 'failed', lastStep);

/* 回归：原有字段一个都不能少 */
const LEGACY_FIELDS = [
  'id',
  'name',
  'fullName',
  'status',
  'message',
  'trace',
  'flaky',
  'suite',
  'subSuite',
  'testClass',
  'testMethod',
  'feature',
  'story',
  'severity',
  'framework',
  'start',
  'stop',
  'duration',
  'attachments'
];
const missing = LEGACY_FIELDS.filter((k) => !(k in tLogin));
check('现有 19 个字段一个没少', missing.length === 0, missing);
check('message 仍是原始失败信息', tLogin.message.includes('期望 HTTP 400'), tLogin.message);
check('trace 仍在', tLogin.trace.includes('HTTP/1.1 500'), tLogin.trace);
check('duration 仍是 800ms', tLogin.duration === 800, tLogin.duration);
check('顶层 attachments 仍在', tLogin.attachments.length === 1 && tLogin.attachments[0].name === '请求日志', tLogin.attachments);
check('status 仍是 failed', tLogin.status === 'failed', tLogin.status);
check('suite 标签仍能取到', tLogin.suite === '登录接口', tLogin.suite);

/* ============================================================
 * 3. 嵌套步骤：递归解析（3 层）
 * ============================================================ */
const tNested = res.tests.find((t) => t.id === 't-nested');
check('嵌套用例有 2 个顶层步骤', tNested.steps.length === 2, tNested.steps.length);
check('第一层的子步骤有 2 个（第 2 层）', tNested.steps[0].steps.length === 2, tNested.steps[0].steps.length);
check('第 3 层步骤被递归解析出来', tNested.steps[0].steps[0].steps.length === 1, tNested.steps[0].steps[0].steps);
check(
  '第 3 层步骤名正确',
  tNested.steps[0].steps[0].steps[0].name === '第三层：插入 SKU 表',
  tNested.steps[0].steps[0].steps[0]
);
check('嵌套子步骤的附件也被解析', tNested.steps[0].steps[1].attachments[0].source === 'nested-attachment.txt', tNested.steps[0].steps[1].attachments);
check(
  '嵌套统计覆盖整棵树（5 个节点：3 通过 / 1 失败 / 1 跳过）',
  tNested.stepSummary.total === 5 &&
    tNested.stepSummary.passed === 3 &&
    tNested.stepSummary.failed === 1 &&
    tNested.stepSummary.skipped === 1,
  tNested.stepSummary
);
check('嵌套用例 firstFailedStep 定位到里层失败步骤', tNested.firstFailedStep === '第二层：断言 JSON schema', tNested.firstFailedStep);

/* 边界：步骤缺 start/stop → duration 0，不是 NaN */
const noRange = tNested.steps[0];
check('缺 start/stop 的步骤 duration = 0', noRange.duration === 0, noRange.duration);
check('缺 start/stop 的步骤 duration 不是 NaN', !Number.isNaN(noRange.duration), noRange.duration);

/* parseStep 直接调：脏数据不崩、状态归一化 */
const dirty = allure.parseStep({ name: '脏步骤', status: 'WEIRD', start: 'x', stop: null, steps: 'not-array', attachments: null });
check('parseStep 未知状态归一化为 unknown', dirty.status === 'unknown', dirty.status);
check('parseStep 非法 steps/attachments 给空数组', dirty.steps.length === 0 && dirty.attachments.length === 0, dirty);
check('parseStep 非法时间给 0', dirty.duration === 0, dirty.duration);
check('parseStep 空节点返回 null', allure.parseStep(null) === null, allure.parseStep(null));

/* ============================================================
 * 4. 边界：没有 steps 的用例
 * ============================================================ */
const tNo = res.tests.find((t) => t.id === 't-nosteps');
check('没有 steps 的用例 steps = []', Array.isArray(tNo.steps) && tNo.steps.length === 0, tNo.steps);
check(
  '没有 steps 的用例 stepSummary 全 0',
  tNo.stepSummary.total === 0 &&
    tNo.stepSummary.passed === 0 &&
    tNo.stepSummary.failed === 0 &&
    tNo.stepSummary.skipped === 0 &&
    tNo.stepSummary.broken === 0,
  tNo.stepSummary
);
check('没有 steps 的用例 firstFailedStep = 空串', tNo.firstFailedStep === '', tNo.firstFailedStep);
check('没有 steps 的用例不算截断', tNo.stepsTruncated === false, tNo.stepsTruncated);
check('没有 steps 的用例原有字段仍在', tNo.name === '依赖数据缺失被跳过' && tNo.status === 'skipped', tNo);

/* 解析后聚类照旧可用（steps 不能把聚类搞坏） */
const clusters = allure.clusterFailures(res.tests);
check('解析步骤后失败聚类仍有结果', clusters.length === 2, clusters.map((c) => c.pattern));
check('聚类 count 合计 = 失败/异常用例数', clusters.reduce((s, c) => s + c.count, 0) === 2, clusters.map((c) => c.count));

/* ============================================================
 * 5. 上限：超大步骤树截断到 200 并标记
 * ============================================================ */
const bigDir = path.join(tmp, 'big', 'allure-results');
fs.mkdirSync(bigDir, { recursive: true });

const flat300 = {
  uuid: 't-flat300',
  name: '300 个平行步骤',
  status: 'passed',
  start: 1,
  stop: 2,
  steps: Array.from({ length: 300 }, (_, i) => ({
    name: '步骤 ' + (i + 1),
    status: 'passed',
    start: i,
    stop: i + 1,
    steps: [],
    attachments: []
  })),
  attachments: [],
  labels: []
};
// 1 个根 + 299 个子 = 300 个节点，用来验证嵌套也一起吃上限
const nested300 = {
  uuid: 't-nested300',
  name: '300 个嵌套步骤',
  status: 'passed',
  start: 1,
  stop: 2,
  steps: [
    {
      name: '根步骤',
      status: 'passed',
      steps: Array.from({ length: 299 }, (_, i) => ({ name: '子步骤 ' + (i + 1), status: 'passed', steps: [], attachments: [] })),
      attachments: []
    }
  ],
  attachments: [],
  labels: []
};
fs.writeFileSync(path.join(bigDir, 'flat-result.json'), JSON.stringify(flat300), 'utf8');
fs.writeFileSync(path.join(bigDir, 'nested-result.json'), JSON.stringify(nested300), 'utf8');

const big = allure.parseAllureDir(bigDir);
const tFlat = big.tests.find((t) => t.id === 't-flat300');
const tBigNested = big.tests.find((t) => t.id === 't-nested300');

check('上限常量 = 200', allure.MAX_STEPS === 200, allure.MAX_STEPS);
check('300 个平行步骤被截断到 200', tFlat.steps.length === 200, tFlat.steps.length);
check('截断后 stepSummary.total 也是 200', tFlat.stepSummary.total === 200, tFlat.stepSummary.total);
check('截断被标记（stepsTruncated = true）', tFlat.stepsTruncated === true, tFlat.stepsTruncated);
check('截断原因写明上限与原始数量', /200/.test(tFlat.stepsTruncatedReason) && /300/.test(tFlat.stepsTruncatedReason), tFlat.stepsTruncatedReason);
check(
  '嵌套 300 个节点整棵树一起截断到 200',
  tBigNested.stepSummary.total === 200 && tBigNested.stepsTruncated === true,
  { total: tBigNested.stepSummary.total, truncated: tBigNested.stepsTruncated }
);
check('没超限的用例不标记截断', tLogin.stepsTruncated === false, tLogin.stepsTruncated);

/* ============================================================
 * 6. 真实报告（本机有就用，没有显式跳过）
 * ============================================================ */
/* 递归数节点（和 parseStep 的口径一致：整棵树） */
const countAll = (list) =>
  (list || []).reduce((n, s) => n + 1 + countAll(s.steps), 0);

/** 递归走一遍每个步骤节点，全部满足才返回 true */
const walkStepsAll = (list, fn) => {
  for (const s of list || []) {
    if (!fn(s)) return false;
    if (!walkStepsAll(s.steps, fn)) return false;
  }
  return true;
};

const realDir = 'D:/AI_Workspace/allure-results';
if (fs.existsSync(realDir)) {
  const real = allure.parseAllureDir(realDir);
  check('真实目录解析成功', real.ok === true, real.message);
  check('真实目录 15 个用例', real.tests.length === 15, real.tests.length);
  check('真实用例都有 steps 字段', real.tests.every((t) => Array.isArray(t.steps)), 'missing steps');
  const realFailed = real.tests.filter((t) => t.status === 'failed');
  check('真实失败用例都有 firstFailedStep', realFailed.length > 0 && realFailed.every((t) => !!t.firstFailedStep), realFailed.map((t) => t.firstFailedStep));
  check(
    '真实失败用例的 firstFailedStep 是「断言 HTTP 400」',
    realFailed.some((t) => t.firstFailedStep === '断言 HTTP 400'),
    realFailed.map((t) => t.firstFailedStep)
  );
  const realWithAttach = real.tests.filter((t) => t.attachments.length > 0);
  check('真实报告的顶层附件仍被解析', realWithAttach.length > 0, real.tests.map((t) => t.attachments.length));
  // 这份数据把附件挂在用例上，所以步骤侧只校验结构（内容用上面造的数据覆盖）
  check(
    '真实步骤的 attachments 都是数组',
    real.tests.every((t) => walkStepsAll(t.steps, (s) => Array.isArray(s.attachments))),
    'step attachments not array'
  );
  // 单元测试造的数据里看不到「断言」这类名字，真实数据才是最终的回归样本
  check(
    '真实报告的步骤统计和步骤树对得上',
    real.tests.every((t) => t.stepSummary.total === countAll(t.steps)),
    real.tests.map((t) => [t.stepSummary.total, countAll(t.steps)])
  );
} else {
  skip('真实 allure-results（不存在：' + realDir + '，6 项真实数据断言跳过）');
}

fs.rmSync(tmp, { recursive: true, force: true });

/* ============================================================
 * 7. 前端：ReportPage 的用例详情渲染步骤
 * ============================================================ */
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ReportPage.tsx'), 'utf8');
const stepsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'StepsList.tsx'), 'utf8');

check('ReportPage 引入 StepsList', /from '\.\.\/components\/StepsList'/.test(pageSrc), 'no import');
check('ReportPage 渲染步骤列表', /<StepsList/.test(pageSrc), 'no <StepsList');
check('ReportPage 有「用例详情」区块', /用例详情/.test(pageSrc), 'no 用例详情');
check('ReportPage 用例行可展开（点击切换）', /setOpenId\(open \? '' : t\.id\)/.test(pageSrc), 'no toggle');
check('ReportPage 列表有「挂在哪一步」列', /report-test-step/.test(pageSrc) && /挂在：/.test(pageSrc), 'no step column');
check('ReportPage 用例详情里有失败信息 + trace', /失败信息/.test(pageSrc) && /展开 trace/.test(pageSrc), 'no fail info');

check('StepsList 递归渲染子步骤', /<StepNode/.test(stepsSrc) && /depth=\{depth \+ 1\}/.test(stepsSrc), 'no recursion');
check('StepsList 嵌套缩进按层级递增', /depth \* 18/.test(stepsSrc), 'no indent');
check('StepsList 失败步骤有红色左条', /#e5534b/.test(stepsSrc), 'no red bar');
check('StepsList 失败步骤字体加粗', /fontWeight: m\.loud \? 600 : 400/.test(stepsSrc), 'not bold');
check('StepsList 通过步骤用灰色 ✅', /mark: '✅'/.test(stepsSrc) && /#7d8497/.test(stepsSrc), 'no gray pass');
check('StepsList 认不出的状态不画成通过', /mark: '❔'/.test(stepsSrc), 'unknown status shown as pass');
check('StepsList 标题行带「N 个失败」', /个失败/.test(stepsSrc), 'no count');
check('StepsList 步骤耗时超 1s 标黄', /step\.duration > 1000/.test(stepsSrc) && /#f5a623/.test(stepsSrc), 'no slow mark');
check('StepsList 步骤附件缩进显示', /附件：/.test(stepsSrc), 'no attachment');
check('StepsList 无步骤兜底文案', /这个用例没有记录步骤/.test(stepsSrc), 'no empty text');
check('StepsList 无步骤时不渲染列表头', /if \(!list\.length\) \{/.test(stepsSrc), 'head renders when empty');
check('StepsList 也展示截断提示', /步骤已截断/.test(stepsSrc), 'no truncated hint');

/* ============================================================
 * 汇总
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
console.log('===== Allure 步骤解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
for (const name of skipped) console.log('  SKIP  ' + name);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
process.exit(failed.length ? 1 : 0);