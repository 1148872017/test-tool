'use strict';
/**
 * v0.45.0 新增：jmx 只读详情（L1）+ 两页互跳
 *
 * 覆盖四件事：
 *   1) 解析：线程组 / 采样器 / 断言（含 JSR223Assertion）/ 前后置 / 定时器 /
 *      CSV 配置 / ${xxx} 变量去重 / summary 计数；
 *   2) 只读：解析前后文件 mtime、大小、内容、目录条目都不变；
 *   3) 错误处理：不存在 / 不是 XML / 根节点不对 / 超大文件 / 传目录；
 *   4) 路径校验 + 互跳接线（源码断言）。
 *
 * 本套件只读仓库源码 + os.tmpdir() 临时目录，属 unit 档（不碰本机真实资产）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const jmx = require('../electron/jmx.js');
const { parseJmx, checkHealth, readDetail, buildDetail, componentKind, MAX_DETAIL_BYTES } = jmx;
const { generateJmx } = require('../shared/jmxgen.js');

/* ============================================================
 * 临时目录：本次运行的所有文件都放这里，跑完删掉
 * ============================================================ */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-jmx-detail-'));
const JMX_DIR = path.join(TMP_ROOT, 'jmx');
const OTHER_DIR = path.join(TMP_ROOT, 'other');
fs.mkdirSync(JMX_DIR, { recursive: true });
fs.mkdirSync(OTHER_DIR, { recursive: true });

/**
 * 手写一份「结构齐全」的 jmx。
 *
 * 为什么手写而不是只用生成器：
 *   - 生成器不会产出 SetupThreadGroup / 禁用的 JSR223 断言 / ConstantTimer，
 *     这里要覆盖「按元件类型识别」而不是只覆盖自家生成的形状；
 *   - 同时验证解析器不依赖特定属性顺序。
 */
function sampleJmx() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">',
    '  <hashTree>',
    '    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="登录压测" enabled="true">',
    '      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">',
    '        <collectionProp name="Arguments.arguments">',
    '          <elementProp name="host" elementType="Argument">',
    '            <stringProp name="Argument.name">host</stringProp>',
    '            <stringProp name="Argument.value">test.example.com</stringProp>',
    '          </elementProp>',
    '        </collectionProp>',
    '      </elementProp>',
    '      <stringProp name="TestPlan.user_define_classpath"></stringProp>',
    '    </TestPlan>',
    '    <hashTree>',
    '      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="登录场景" enabled="true">',
    '        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>',
    '        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '          <boolProp name="LoopController.continue_forever">false</boolProp>',
    '          <stringProp name="LoopController.loops">10</stringProp>',
    '        </elementProp>',
    '        <stringProp name="ThreadGroup.num_threads">50</stringProp>',
    '        <stringProp name="ThreadGroup.ramp_time">10</stringProp>',
    '        <boolProp name="ThreadGroup.scheduler">false</boolProp>',
    '        <stringProp name="ThreadGroup.duration"></stringProp>',
    '      </ThreadGroup>',
    '      <hashTree>',
    '        <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="CSV 数据文件设置" enabled="true">',
    '          <stringProp name="filename">data.csv</stringProp>',
    '          <stringProp name="variableNames">userName,token</stringProp>',
    '          <stringProp name="delimiter">,</stringProp>',
    '        </CSVDataSet>',
    '        <hashTree/>',
    '        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="POST /api/login" enabled="true">',
    '          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">',
    '            <collectionProp name="Arguments.arguments"/>',
    '          </elementProp>',
    '          <stringProp name="HTTPSampler.domain">test.example.com</stringProp>',
    '          <stringProp name="HTTPSampler.port">443</stringProp>',
    '          <stringProp name="HTTPSampler.protocol">https</stringProp>',
    '          <stringProp name="HTTPSampler.path">/api/login</stringProp>',
    '          <stringProp name="HTTPSampler.method">POST</stringProp>',
    '        </HTTPSamplerProxy>',
    '        <hashTree>',
    '          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="响应断言-状态码200" enabled="true">',
    '            <collectionProp name="Asserion.test_strings">',
    '              <stringProp name="49586">200</stringProp>',
    '            </collectionProp>',
    '            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>',
    '            <intProp name="Assertion.test_type">8</intProp>',
    '          </ResponseAssertion>',
    '          <hashTree/>',
    '          <JSR223Assertion guiclass="TestBeanGUI" testclass="JSR223Assertion" testname="断言-返回体成功" enabled="true">',
    '            <stringProp name="scriptLanguage">groovy</stringProp>',
    '            <stringProp name="parameters"></stringProp>',
    '            <stringProp name="filename"></stringProp>',
    '            <stringProp name="script">assert json.success == true</stringProp>',
    '            <boolProp name="cacheKey">true</boolProp>',
    '          </JSR223Assertion>',
    '          <hashTree/>',
    '          <JSR223PreProcessor guiclass="TestBeanGUI" testclass="JSR223PreProcessor" testname="前置-签名" enabled="true">',
    '            <stringProp name="scriptLanguage">groovy</stringProp>',
    '            <stringProp name="script">vars.put("sign", "abc")</stringProp>',
    '          </JSR223PreProcessor>',
    '          <hashTree/>',
    '          <JSR223PostProcessor guiclass="TestBeanGUI" testclass="JSR223PostProcessor" testname="后置-提取token" enabled="true">',
    '            <stringProp name="scriptLanguage">groovy</stringProp>',
    '            <stringProp name="script">vars.put("token", "Bearer ${token}")</stringProp>',
    '          </JSR223PostProcessor>',
    '          <hashTree/>',
    '          <ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="固定定时器" enabled="true">',
    '            <stringProp name="ConstantTimer.delay">300</stringProp>',
    '          </ConstantTimer>',
    '          <hashTree/>',
    '          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP 信息头管理器" enabled="true">',
    '            <collectionProp name="HeaderManager.headers">',
    '              <elementProp name="" elementType="Header">',
    '                <stringProp name="Header.name">Authorization</stringProp>',
    '                <stringProp name="Header.value">Bearer ${token}</stringProp>',
    '              </elementProp>',
    '              <elementProp name="" elementType="Header">',
    '                <stringProp name="Header.name">X-Time</stringProp>',
    '                <stringProp name="Header.value">${__time()}</stringProp>',
    '              </elementProp>',
    '            </collectionProp>',
    '          </HeaderManager>',
    '          <hashTree/>',
    '        </hashTree>',
    '        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="GET /api/user" enabled="true">',
    '          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">',
    '            <collectionProp name="Arguments.arguments"/>',
    '          </elementProp>',
    '          <stringProp name="HTTPSampler.domain">${__P(host,127.0.0.1)}</stringProp>',
    '          <stringProp name="HTTPSampler.port">8080</stringProp>',
    '          <stringProp name="HTTPSampler.protocol">http</stringProp>',
    '          <stringProp name="HTTPSampler.path">/api/user?u=${userName}&amp;t=${token}</stringProp>',
    '          <stringProp name="HTTPSampler.method">GET</stringProp>',
    '        </HTTPSamplerProxy>',
    '        <hashTree>',
    '          <JSR223Assertion guiclass="TestBeanGUI" testclass="JSR223Assertion" testname="断言-禁用" enabled="false">',
    '            <stringProp name="scriptLanguage">javascript</stringProp>',
    '            <stringProp name="script">true</stringProp>',
    '          </JSR223Assertion>',
    '          <hashTree/>',
    '        </hashTree>',
    '        <Arguments guiclass="ArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">',
    '          <collectionProp name="Arguments.arguments">',
    '            <elementProp name="token" elementType="Argument">',
    '              <stringProp name="Argument.name">token</stringProp>',
    '              <stringProp name="Argument.value">abc</stringProp>',
    '            </elementProp>',
    '            <elementProp name="userName" elementType="Argument">',
    '              <stringProp name="Argument.name">userName</stringProp>',
    '              <stringProp name="Argument.value">admin</stringProp>',
    '            </elementProp>',
    '          </collectionProp>',
    '        </Arguments>',
    '        <hashTree/>',
    '      </hashTree>',
    '      <SetupThreadGroup guiclass="SetupThreadGroupGui" testclass="SetupThreadGroup" testname="准备数据" enabled="true">',
    '        <stringProp name="ThreadGroup.num_threads">1</stringProp>',
    '        <stringProp name="ThreadGroup.ramp_time">0</stringProp>',
    '      </SetupThreadGroup>',
    '      <hashTree/>',
    '    </hashTree>',
    '  </hashTree>',
    '</jmeterTestPlan>'
  ].join('\n');
}

const SAMPLE = sampleJmx();
const SAMPLE_FILE = path.join(JMX_DIR, '登录压测.jmx');
fs.writeFileSync(SAMPLE_FILE, SAMPLE, 'utf8');

/* ============================================================
 * 一、元件分类：按 testclass 后缀认（JSR223 全家族）
 * ============================================================ */
check('componentKind：JSR223Assertion → assertion', componentKind('JSR223Assertion') === 'assertion', componentKind('JSR223Assertion'));
check('componentKind：ResponseAssertion → assertion', componentKind('ResponseAssertion') === 'assertion', componentKind('ResponseAssertion'));
check('componentKind：JSR223PreProcessor → preProcessor', componentKind('JSR223PreProcessor') === 'preProcessor', componentKind('JSR223PreProcessor'));
check('componentKind：JSR223PostProcessor → postProcessor', componentKind('JSR223PostProcessor') === 'postProcessor', componentKind('JSR223PostProcessor'));
check('componentKind：ConstantTimer → timer', componentKind('ConstantTimer') === 'timer', componentKind('ConstantTimer'));
check('componentKind：CSVDataSet → config', componentKind('CSVDataSet') === 'config', componentKind('CSVDataSet'));
check('componentKind：HTTPSamplerProxy → sampler', componentKind('HTTPSamplerProxy') === 'sampler', componentKind('HTTPSamplerProxy'));
check('componentKind：监听器不是任何一类（不误报）', componentKind('ResultCollector') === '', componentKind('ResultCollector'));

/* ============================================================
 * 二、解析：线程组 / 采样器 / 断言 / 前后置 / 配置 / 变量 / summary
 * ============================================================ */
const parsed = parseJmx(SAMPLE, SAMPLE_FILE);
check('手写样本解析无错误', parsed.parseError === '', parsed.parseError);
check('测试计划名解析正确', parsed.testPlanName === '登录压测', parsed.testPlanName);

const detail = buildDetail(parsed, { size: Buffer.byteLength(SAMPLE), mtimeMs: 1732500000000 });
check('detail.file 是文件名', detail.file === '登录压测.jmx', detail.file);
check('detail 带 size（来自 stat）', detail.size === Buffer.byteLength(SAMPLE), detail.size);
check('detail 带 modifiedAt（来自 stat）', detail.modifiedAt === 1732500000000, detail.modifiedAt);

check('线程组数量 = 2（含 setUp）', detail.threadGroups.length === 2, detail.threadGroups.length);
check('第一个线程组类型 thread', detail.threadGroups[0].type === 'thread', detail.threadGroups[0].type);
check('setUp 线程组类型被识别', detail.threadGroups[1].type === 'setup', detail.threadGroups[1].type);
check('线程数解析为数字 50', detail.threadGroups[0].numThreads === 50, detail.threadGroups[0].numThreads);
check('rampUp 解析为数字 10', detail.threadGroups[0].rampUp === 10, detail.threadGroups[0].rampUp);
check('循环次数从循环控制器里捞到 10', detail.threadGroups[0].loops === 10, detail.threadGroups[0].loops);
check('没配调度器时 duration = 0、scheduler = false', detail.threadGroups[0].duration === 0 && detail.threadGroups[0].scheduler === false, detail.threadGroups[0]);
check('线程组 enabled 解析正确', detail.threadGroups[0].enabled === true, detail.threadGroups[0].enabled);

check('采样器数量 = 2', detail.samplers.length === 2, detail.samplers.length);
check('采样器 method/path 解析正确', detail.samplers[0].method === 'POST' && detail.samplers[0].path === '/api/login', detail.samplers[0]);
check('采样器 domain 解析正确', detail.samplers[0].domain === 'test.example.com', detail.samplers[0].domain);
check('第二个采样器 domain 保留占位符原文', detail.samplers[1].domain === '${__P(host,127.0.0.1)}', detail.samplers[1].domain);

const s0 = detail.samplers[0];
const types0 = s0.assertions.map((a) => a.type);
check('采样器 0 识别出 ResponseAssertion', types0.indexOf('ResponseAssertion') >= 0, types0);
check('采样器 0 识别出 JSR223Assertion（本次核心）', types0.indexOf('JSR223Assertion') >= 0, types0);
check('采样器 0 断言数为 2（响应 + JSR223）', s0.assertions.length === 2, s0.assertions.length);
check('JSR223Assertion 带脚本语言 groovy', (s0.assertions.find((a) => a.type === 'JSR223Assertion') || {}).language === 'groovy', s0.assertions);
check(
  'JSR223Assertion 带代码首行预览（能认出是哪段断言）',
  /json\.success/.test(String((s0.assertions.find((a) => a.type === 'JSR223Assertion') || {}).scriptPreview)),
  s0.assertions
);
check('采样器 0 识别出 JSR223PreProcessor', (s0.preProcessors[0] || {}).type === 'JSR223PreProcessor', s0.preProcessors);
check('前置处理器语言/代码预览没丢', s0.preProcessors[0].language === 'groovy' && /vars\.put/.test(s0.preProcessors[0].scriptPreview), s0.preProcessors[0]);
check('采样器 0 识别出 JSR223PostProcessor', (s0.postProcessors[0] || {}).type === 'JSR223PostProcessor', s0.postProcessors);
check('采样器 0 识别出 ConstantTimer', (s0.timers[0] || {}).type === 'ConstantTimer', s0.timers);
check('断言不串台：采样器 0 的前置没跑到采样器 1', detail.samplers[1].preProcessors.length === 0, detail.samplers[1].preProcessors);
check('采样器 1 的禁用断言保留了 enabled=false', detail.samplers[1].assertions[0].enabled === false, detail.samplers[1].assertions);
check('采样器 1 只有 1 条断言', detail.samplers[1].assertions.length === 1, detail.samplers[1].assertions);
check('禁用的断言也计入 assertionCount（看得见才叫只读详情）', detail.assertionCount === 3, detail.assertionCount);

const configTypes = detail.configs.map((c) => c.type);
check('配置元件识别出 CSVDataSet', configTypes.indexOf('CSVDataSet') >= 0, configTypes);
check('配置元件识别出 HeaderManager', configTypes.indexOf('HeaderManager') >= 0, configTypes);
check('配置元件识别出 Arguments（用户定义变量）', configTypes.indexOf('Arguments') >= 0, configTypes);
check('CSV 配置带 scope（挂在哪个线程组）', (detail.configs.find((c) => c.type === 'CSVDataSet') || {}).scope === '登录场景', detail.configs);

check('${xxx} 变量抽取正确且去重：["token","userName"]', JSON.stringify(detail.variables) === JSON.stringify(['token', 'userName']), detail.variables);
check('${__P(...)} / ${__time()} 这类函数不算变量', detail.variables.every((v) => v.indexOf('__') !== 0), detail.variables);
check(
  'summary 计数：1 线程组 + 1 setUp + 2 采样器 + 3 断言 + 3 配置',
  detail.summary.threadGroups === 2 && detail.summary.samplers === 2 && detail.summary.assertions === 3 && detail.summary.configs === 3,
  detail.summary
);

/* ============================================================
 * 三、生成器 → 详情：能反过来验证「附加 JSR223 真的进 jmx 了」
 * ============================================================ */
const gen = generateJmx({
  apis: [
    { data: { name: '登录', method: 'POST', url: 'https://test.example.com/api/login', headers: 'Content-Type: application/json', body: '{}', bodyType: 'json' } }
  ],
  name: '生成计划',
  threads: 50,
  rampUp: 10,
  loops: 10,
  rtLimit: 500,
  extraElements: [
    { type: 'assertion', code: 'assert json.success == true', name: '模板断言' },
    { type: 'pre', code: 'vars.put("sign", "abc")' },
    { type: 'post', code: 'vars.put("token", "x")' }
  ]
});
const GEN_FILE = path.join(JMX_DIR, '生成计划.jmx');
fs.writeFileSync(GEN_FILE, gen.xml, 'utf8');
const genDetail = readDetail(GEN_FILE);
check('生成出来的 jmx 能被详情解析成功', genDetail.ok === true, genDetail);
const genTypes = genDetail.samplers[0].assertions.map((a) => a.type);
check('详情里看得到 JSR223Assertion', genTypes.indexOf('JSR223Assertion') >= 0, genTypes);
check('详情里同时保留 ResponseAssertion / DurationAssertion', genTypes.indexOf('ResponseAssertion') >= 0 && genTypes.indexOf('DurationAssertion') >= 0, genTypes);
check('附加的前置/后置也按采样器归位', genDetail.samplers[0].preProcessors[0].type === 'JSR223PreProcessor' && genDetail.samplers[0].postProcessors[0].type === 'JSR223PostProcessor', genDetail.samplers[0]);
check('生成计划的线程数/rampUp 从 jmx 里读回来是 50 / 10', genDetail.threadGroups[0].numThreads === 50 && genDetail.threadGroups[0].rampUp === 10, genDetail.threadGroups[0]);

const genParsed = parseJmx(gen.xml, GEN_FILE);
const genHealthCodes = checkHealth(genParsed).issues.map((i) => i.code);
check('健康检查不再把「只有 JSR223 断言」误报成没有断言', genHealthCodes.indexOf('no-assertion') < 0, genHealthCodes);

{
  /**
   * 生成器回归（v0.45.0 修的 bug）：
   *   同时开 CSV 参数化时，CSVDataSet 曾被插在 </ThreadGroup> 和采样器的 hashTree 中间，
   *   采样器成了没有父元素的孤儿树 —— JMeter / 本仓解析器都看不到采样器。
   */
  const csvGen = generateJmx({
    apis: [{ data: { name: 'CSV 计划', method: 'GET', url: 'http://a.com/x' } }],
    name: 'CSV 计划',
    csv: { fileName: 'data.csv', variableNames: 'userName' }
  });
  const csvParsed = parseJmx(csvGen.xml, 'csv.jmx');
  check('开 CSV 后采样器仍挂在线程组下（不是孤儿 hashTree）', csvParsed.samplers.length === 1, csvParsed.samplers.length);
  check('开 CSV 后 CSV 配置本身照常解析', csvParsed.csvs.length === 1 && csvParsed.csvs[0].filename === 'data.csv', csvParsed.csvs);

  const CSV_FILE = path.join(JMX_DIR, 'CSV 计划.jmx');
  fs.writeFileSync(CSV_FILE, csvGen.xml, 'utf8');
  const csvDetail = readDetail(CSV_FILE);
  check('CSV + 采样器的脚本能被详情看全（采样器 1、配置含 CSVDataSet）', csvDetail.ok && csvDetail.samplers.length === 1 && csvDetail.configs.some((c) => c.type === 'CSVDataSet'), csvDetail);
}

{
  // 只有 JSR223 断言的最小脚本：健康检查不能报 no-assertion
  const onlyJsr = [
    '<jmeterTestPlan version="1.2" jmeter="5.6.3">',
    '  <hashTree>',
    '    <TestPlan testclass="TestPlan" testname="只有JSR223" enabled="true"/>',
    '    <hashTree>',
    '      <ThreadGroup testclass="ThreadGroup" testname="G" enabled="true">',
    '        <stringProp name="ThreadGroup.num_threads">1</stringProp>',
    '      </ThreadGroup>',
    '      <hashTree>',
    '        <HTTPSamplerProxy testclass="HTTPSamplerProxy" testname="S" enabled="true">',
    '          <stringProp name="HTTPSampler.path">/x</stringProp>',
    '          <stringProp name="HTTPSampler.domain">a.com</stringProp>',
    '        </HTTPSamplerProxy>',
    '        <hashTree>',
    '          <JSR223Assertion testclass="JSR223Assertion" testname="A" enabled="true">',
    '            <stringProp name="script">true</stringProp>',
    '          </JSR223Assertion>',
    '          <hashTree/>',
    '        </hashTree>',
    '      </hashTree>',
    '    </hashTree>',
    '  </hashTree>',
    '</jmeterTestPlan>'
  ].join('\n');
  const p = parseJmx(onlyJsr, 'only-jsr.jmx');
  check('最小 JSR223 断言脚本能解析', p.parseError === '' && p.samplers.length === 1, p.parseError || p.samplers.length);
  const codes = checkHealth(p).issues.map((i) => i.code);
  check('最小 JSR223 脚本：健康检查报「没有断言」被抑制', codes.indexOf('no-assertion') < 0, codes);
  check('最小 JSR223 脚本：仍提示缺持续时间断言（信息级）', codes.indexOf('no-duration-assertion') >= 0, codes);
}

/* ============================================================
 * 四、只读：解析前后文件完全不变
 * ============================================================ */
{
  const statBefore = fs.statSync(SAMPLE_FILE);
  const contentBefore = fs.readFileSync(SAMPLE_FILE, 'utf8');
  const entriesBefore = fs.readdirSync(JMX_DIR).sort().join('|');

  const r1 = readDetail(SAMPLE_FILE);
  const r2 = readDetail(SAMPLE_FILE);

  const statAfter = fs.statSync(SAMPLE_FILE);
  const contentAfter = fs.readFileSync(SAMPLE_FILE, 'utf8');
  const entriesAfter = fs.readdirSync(JMX_DIR).sort().join('|');

  check('详情解析连续两次都成功（幂等）', r1.ok === true && r2.ok === true, [r1, r2]);
  check('解析前后 mtime 不变', statBefore.mtimeMs === statAfter.mtimeMs, [statBefore.mtimeMs, statAfter.mtimeMs]);
  check('解析前后文件大小不变', statBefore.size === statAfter.size, [statBefore.size, statAfter.size]);
  check('解析前后文件内容逐字不变', contentBefore === contentAfter, 'content changed');
  check('解析不会在目录里留下临时文件', entriesBefore === entriesAfter, [entriesBefore, entriesAfter]);
  check('jmx.js 整个模块没有任何写盘调用（只读承诺）', fs.readFileSync(path.join(ROOT, 'electron', 'jmx.js'), 'utf8').indexOf('writeFileSync') < 0, 'jmx.js 出现了 writeFileSync');
}

/* ============================================================
 * 五、错误处理：都要给能直接展示的中文原因，而不是抛异常
 * ============================================================ */
{
  const missing = readDetail(path.join(JMX_DIR, '不存在.jmx'));
  check('不存在的文件 → ok:false + NOT_FOUND', missing.ok === false && missing.code === 'NOT_FOUND', missing);
  check('不存在的文件 → 提示里带「文件不存在」', /文件不存在|无法访问/.test(missing.message), missing.message);
}
{
  const notXml = path.join(JMX_DIR, 'not-xml.jmx');
  fs.writeFileSync(notXml, '这不是 XML，只是一段文字', 'utf8');
  const bad = readDetail(notXml);
  check('非 XML 文件 → BAD_JMX', bad.ok === false && bad.code === 'BAD_JMX', bad);
  check('非 XML 文件 → 提示「不是合法的 jmx 文件」+ 原因', /不是合法的 jmx 文件/.test(bad.message) && bad.message.length > 12, bad.message);
}
{
  const wrongRoot = path.join(JMX_DIR, 'wrong-root.jmx');
  fs.writeFileSync(wrongRoot, '<?xml version="1.0"?><foo><bar/></foo>', 'utf8');
  const bad = readDetail(wrongRoot);
  check('根节点不是 jmeterTestPlan → BAD_JMX 且说明原因', bad.ok === false && /jmeterTestPlan/.test(bad.message), bad.message);
}
{
  const bigFile = path.join(JMX_DIR, 'too-big.jmx');
  fs.writeFileSync(bigFile, Buffer.alloc(MAX_DETAIL_BYTES + 1, 0x20));
  const big = readDetail(bigFile);
  check('超过 5MB → 拒绝（TOO_LARGE）', big.ok === false && big.code === 'TOO_LARGE', big.code);
  check('超过 5MB → 提示里写了上限', /上限/.test(big.message) && /MB/.test(big.message), big.message);
  check('5MB 上限常量就是 5 * 1024 * 1024', MAX_DETAIL_BYTES === 5 * 1024 * 1024, MAX_DETAIL_BYTES);
  fs.rmSync(bigFile, { force: true });
}
{
  const dir = readDetail(JMX_DIR);
  check('传目录 → NOT_A_FILE（不会把目录当文件读）', dir.ok === false && dir.code === 'NOT_A_FILE', dir);
}
{
  const blank = readDetail('');
  check('空路径 → BAD_PATH', blank.ok === false && blank.code === 'BAD_PATH', blank);
}

/* ============================================================
 * 六、路径校验：jmxDir 之外的路径被拒（和 ipc-jmx 用的是同一套守卫）
 * ============================================================ */
{
  const { assertPathIn } = require('../electron/shared-helpers.js');
  const outsideFile = path.join(OTHER_DIR, 'secret.jmx');
  fs.writeFileSync(outsideFile, SAMPLE, 'utf8');
  const settings = { jmxDir: JMX_DIR };

  check('jmxDir 内的文件通过白名单', assertPathIn(SAMPLE_FILE, [], settings) === null, assertPathIn(SAMPLE_FILE, [], settings));
  const rejected = assertPathIn(outsideFile, [], settings);
  check('jmxDir 之外的文件被拒', !!rejected && rejected.code === 'OUTSIDE_ROOT', rejected);
  check('越界提示是中文且可展示', !!rejected && /已拒绝/.test(rejected.message), rejected && rejected.message);

  // 和 handler 同款逻辑：相对路径先按 jmxDir 拼，再走白名单（../ 逃逸必须被拦）
  const escaped = path.join(JMX_DIR, '..', 'other', 'secret.jmx');
  const escapedBad = assertPathIn(escaped, [], settings);
  check('相对路径用 ../ 逃出 jmxDir 被拒', !!escapedBad && escapedBad.code === 'OUTSIDE_ROOT', escapedBad);
}

/* ============================================================
 * 七、IPC / preload / mock 接线
 * ============================================================ */
{
  const ipcSrc = read('electron/ipc/ipc-jmx.js');
  check("IPC 注册了 jmx:detail 通道", /handle\('jmx:detail'/.test(ipcSrc), 'no jmx:detail');
  check('jmx:detail 做了路径白名单校验（assertPathIn）', /assertPathIn\(target\)/.test(ipcSrc), 'no guard');
  check('jmx:detail 复用 jmxIndex.readDetail（没另写一套解析）', /jmxIndex\.readDetail\(target\)/.test(ipcSrc), 'no reuse');
  check('jmx:detail 支持相对 jmxDir 的路径', /path\.isAbsolute\(input\)/.test(ipcSrc), 'no relative path');
  check('jmx:detail 只读、没有写盘调用', (() => {
    // 只截 jmx:detail 这一段（同文件里 jmxgen:save 是要写盘的，不能整文件断言）
    const start = ipcSrc.indexOf("handle('jmx:detail'");
    if (start < 0) return false;
    const rest = ipcSrc.slice(start);
    const next = rest.indexOf('handle(', 10);
    const body = next > 0 ? rest.slice(0, next) : rest;
    return !/writeFileSync|writeFile|appendFileSync/.test(body);
  })(), 'jmx:detail 里出现了写盘调用');

  const preloadSrc = read('electron/preload.js');
  check("preload 暴露 jmxDetail → 'jmx:detail'", /jmxDetail: \(file\) => invoke\('jmx:detail', \{ file \}\)/.test(preloadSrc), 'preload not wired');

  const mockSrc = read('src/mockApi.ts');
  check('浏览器预览的 mock 有 jmxDetail（否则预览点详情会白屏）', /jmxDetail\s*:/.test(mockSrc), 'mock missing');
  check('mock 详情里有 JSR223 断言样例', /JSR223Assertion/.test(mockSrc), 'no jsr223 sample');
}

/* ============================================================
 * 八、两页互跳接线
 * ============================================================ */
{
  const jmxPage = read('src/pages/JmxPage.tsx');
  check('JmxPage 打开行时调用 api.jmxDetail', /api\.jmxDetail\(/.test(jmxPage), 'not called');
  check('JmxPage 有「基于这个重新生成」按钮', /基于这个重新生成/.test(jmxPage), 'no button');
  check('JmxPage 用 setJmxHandoff 交接参数', /setJmxHandoff\(/.test(jmxPage), 'no handoff');
  check('JmxPage 跳转用 onNavigate（不硬编码路由）', /onNavigate\(\{ type: 'tool', key: 'scriptgen' \}\)/.test(jmxPage), 'no navigate');
  check('JmxPage 详情里展示断言/前置/后置/定时（含 JSR223 类型）', /JSR223Assertion/.test(jmxPage) && /AttachLine/.test(jmxPage), 'no attachment ui');
  check('JmxPage 健康检查复用 scan 结果（没有重新 checkHealth）', /detail\.health/.test(jmxPage) && !/checkHealth\(/.test(jmxPage), 'health recomputed');
  check('JmxPage 详情里有概览 summary', /summary\.threadGroups/.test(jmxPage) && /summary\.assertions/.test(jmxPage), 'no summary');

  const genPage = read('src/pages/ScriptGenPage.tsx');
  check('ScriptGenPage 有「去『压测脚本』页查看」入口', /去「压测脚本」页查看/.test(genPage), 'no link');
  check('ScriptGenPage 读取交接参数 takeJmxHandoff', /takeJmxHandoff\(/.test(genPage), 'no take');
  check('ScriptGenPage 保存成功后记录保存路径', /setSavedJmx\(res\.file\)/.test(genPage), 'not saved');
  check('ScriptGenPage 跳转用 onNavigate', /onNavigate\(\{ type: 'jmx' \}\)/.test(genPage), 'no navigate');
  check('预填了 4 个值：线程数 / rampUp / 循环 / 域名', /setThreads\(h\.threads\)/.test(genPage) && /setRampUp\(h\.rampUp\)/.test(genPage) && /setLoops\(h\.loops\)/.test(genPage) && /setDomain\(h\.domain\)/.test(genPage), 'prefill incomplete');

  const appSrc = read('src/App.tsx');
  check('App 给 JmxPage 传了 onNavigate', /<JmxPage onNavigate=\{setRoute\}/.test(appSrc), 'no prop');
  check('App 给 ScriptGenPage 传了 onNavigate', /<ScriptGenPage onNavigate=\{setRoute\}/.test(appSrc), 'no prop');

  const handoff = read('src/features/jmx/handoff.ts');
  check('handoff 模块提供 set / take 两个入口', /export function setJmxHandoff/.test(handoff) && /export function takeJmxHandoff/.test(handoff), 'missing api');
  check('handoff 取出后清空（只生效一次）', /export function takeJmxHandoff[\s\S]{0,200}pending = null/.test(handoff), 'not cleared');
  check('handoff 会把 ${__P(host,x)} 还原成真实域名', /__P/.test(handoff) && /plainDomain/.test(handoff), 'no plainDomain');
}

/* ============================================================
 * 汇总
 * ============================================================ */
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('===== jmx 只读详情（L1）+ 两页互跳 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);