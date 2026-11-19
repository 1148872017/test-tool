const path = require('path');
const os = require('os');
/* jmx 解析冒烟测试：跑真实 jmx 目录（JMX_ROOT 环境变量） */
const { scanJmx, parseJmx, checkHealth } = require('../electron/jmx.js');

const ROOT = process.env.JMX_ROOT || path.join(os.homedir(), 'Documents', '测试工作台', 'jmx');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const res = scanJmx(ROOT, { jmeterVersion: '5.4.3' });
console.log('root =', res.root);
console.log('files =', res.totalFiles, ' errors =', res.errors.length);
if (res.errors.length) console.log(res.errors);

check('扫到至少 2 个 jmx', res.totalFiles >= 2, res.totalFiles);
check('没有扫描错误', res.errors.length === 0, res.errors);

const byName = (part) => res.files.find((f) => f.file === part);
// 按特征找，不写死文件名：jmx 目录会持续新增脚本
const plan = byName('测试计划.jmx');
const demo = res.files.find((f) => f.file !== '测试计划.jmx' && /测试计划\.jmx$/.test(f.file));

check('找到 测试计划.jmx', !!plan);
check('找到第二个测试计划脚本', !!demo, res.files.map((f) => f.file));

if (plan) {
  check('识别 JMeter 版本 5.4.3', plan.jmeterVersion === '5.4.3', plan.jmeterVersion);
  check('解析出 4 个线程组', plan.threadGroups.length === 4, plan.threadGroups.length);
  check('线程组类型都是 thread', plan.threadGroups.every((t) => t.type === 'thread'), plan.threadGroups.map((t) => t.type));
  check('用户模块 10 线程', plan.threadGroups[0].numThreads === '10', plan.threadGroups[0]);
  check('只启用 1 个线程组', plan.threadGroups.filter((t) => t.enabled).length === 1, plan.threadGroups.map((t) => t.enabled));
  check('解析出 16 个采样器', plan.samplers.length === 16, plan.samplers.length);
  check('采样器带 method', plan.samplers.every((s) => !!s.method), plan.samplers.slice(0, 2));
  check('登录采样器 path 正确', plan.samplers.some((s) => s.path === '/api/v1/user/login' && s.method === 'POST'), plan.samplers.map((s) => s.path));
  check('解析出 HTTP 请求默认值', plan.defaults.length === 1, plan.defaults.length);
  check('默认值 domain 是占位符', plan.defaults[0].domain === '${test_environment}', plan.defaults[0]);
  check('解析出 3 个 CSV', plan.csvs.length === 3, plan.csvs.length);
  check('CSV 变量名解析正确', plan.csvs.some((c) => c.variableNames === 'id,title'), plan.csvs.map((c) => c.variableNames));
  check('解析出用户变量', plan.variables.length > 0 && plan.variables.some((v) => v.vars.length >= 2), plan.variables.length);
  check('变量带描述', plan.variables.some((v) => v.vars.some((x) => x.desc)), plan.variables[0]);
  check('解析出 header', plan.headers.length === 1 && plan.headers[0].headers.length === 2, plan.headers);
  check('header 含 token 占位符', plan.headers[0].headers.some((h) => h.value.indexOf('${token_file}') >= 0), plan.headers[0].headers);
  check('解析出同步定时器', plan.syncTimers.length === 1, plan.syncTimers.length);
  check('解析出监听器', plan.listeners.length === 5, plan.listeners.length);
  check('监听器带 scope（挂在哪个采样器/线程组下）', plan.listeners.every((l) => typeof l.scope === 'string'), plan.listeners.map((l) => l.scope));
  check('同名监听器靠 scope 能区分开', new Set(plan.listeners.map((l) => l.name + '@' + l.scope)).size === plan.listeners.length, plan.listeners.map((l) => l.name + '@' + l.scope));
  check('监听器带 guiClass（类型稳定，testname 会被改）', plan.listeners.every((l) => !!l.guiClass), plan.listeners.map((l) => l.guiClass));
  check('监听器 scope 指向真实采样器或线程组', plan.listeners.every((l) => plan.samplers.some((s) => s.name === l.scope) || plan.threadGroups.some((t) => t.name === l.scope)), plan.listeners.map((l) => l.scope));
  check('解析出循环控制器（挂在线程组上）', plan.threadGroups.some((t) => t.loops), plan.threadGroups.map((t) => t.loops));
  check('解析出 BeanShell 三类', plan.beanShell.pre.length === 1 && plan.beanShell.post.length === 1 && plan.beanShell.assert.length === 1, {
    pre: plan.beanShell.pre.length,
    post: plan.beanShell.post.length,
    assert: plan.beanShell.assert.length
  });
  check('解析出 JSON 提取器', plan.jsonExtractors.length === 1, plan.jsonExtractors.length);
  check('断言数为 0（demo 未配）', plan.responseAssertions.length === 0 && plan.durationAssertions.length === 0);
  check('占位符提取到 test_environment', plan.placeholders.indexOf('test_environment') >= 0, plan.placeholders);
  check('占位符提取到 token_file', plan.placeholders.indexOf('token_file') >= 0, plan.placeholders);

  // 健康检查
  const codes = plan.health.issues.map((i) => i.code);
  check('健康检查报「没有断言」', codes.indexOf('no-assertion') >= 0, codes);
  check('健康检查报 CSV 缺失（token.txt）', codes.indexOf('csv-missing') >= 0, codes);
  check('健康检查报 CSV 用了绝对路径', codes.indexOf('csv-absolute-path') >= 0, codes);
  check('缺失的 CSV 不重复报绝对路径', (() => {
    const missing = plan.health.issues.filter((i) => i.code === 'csv-missing');
    const abs = plan.health.issues.filter((i) => i.code === 'csv-absolute-path');
    // token.txt 缺失 → 只报 csv-missing；user.csv / 课程清单存在 → 报绝对路径
    return missing.length === 1 && abs.length === 2 && !abs.some((i) => i.title.includes('token.txt'));
  })(), plan.health.issues.map((i) => i.code + ':' + i.title));
  check('健康检查不误报 path 为空（默认值有 domain）', codes.indexOf('sampler-no-path') < 0 && codes.indexOf('sampler-inherit') >= 0, codes);
  check('健康检查报部分线程组未启用', codes.indexOf('partial-groups') >= 0, codes);
  check('健康等级是 error（token.txt 真的缺失）', plan.health.level === 'error', plan.health.level);
  console.log('\n[测试计划.jmx 健康检查]');
  for (const i of plan.health.issues) console.log(`  [${i.level}] ${i.title}  ${i.detail}`);
}

if (demo) {
  check('demo 解析出 12 个采样器', demo.samplers.length === 12, demo.samplers.length);
  check('demo 解析出 2 个 CSV', demo.csvs.length === 2, demo.csvs.length);
  check('demo 变量 test_environment 有值', demo.variables.some((v) => v.vars.some((x) => x.name === 'test_environment' && x.value)), demo.variables);
}

// 容错
const bad = parseJmx('<not-jmeter/>', 'x.jmx');
check('非 jmeter 文件报解析错误而不是抛异常', !!bad.parseError, bad.parseError);
const broken = parseJmx('<jmeterTestPlan><unclosed>', 'y.jmx');
check('残缺 XML 不抛异常', typeof broken === 'object' && broken !== null);

const empty = scanJmx('D:\\不存在的目录', {});
check('目录不存在时返回 error 字段', !!empty.error, empty.error);

const failed = results.filter((r) => !r.ok);
console.log('\n===== jmx 解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
