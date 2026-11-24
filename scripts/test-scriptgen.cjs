/* JMeter 脚本生成 + MySQL SQL 生成 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const { generateJmx, splitUrl } = require('../shared/jmxgen.js');
const { parseJmx, checkHealth } = require('../electron/jmx.js');
const sqlgen = require('../shared/sqlgen.js');

/* ============================================================
 * 一、JMeter 脚本生成
 * ============================================================ */

/* ---------- 1. URL 拆分 ---------- */
const u1 = splitUrl('https://api.x.com/api/login');
check('URL 拆分：https', u1.protocol === 'https' && u1.domain === 'api.x.com' && u1.path === '/api/login', u1);
const u2 = splitUrl('http://127.0.0.1:8080/pet?page=1');
check('URL 拆分：端口', u2.port === '8080' && u2.path === '/pet', u2);
const u3 = splitUrl('api.x.com/pet');
check('URL 拆分：无协议补 http', u3.domain === 'api.x.com' && u3.path === '/pet', u3);

/* ---------- 2. 生成 jmx ---------- */
const apis = [
  {
    data: {
      name: '登录',
      method: 'POST',
      url: 'https://test.example.com/api/login',
      headers: 'Content-Type: application/json\nAuthorization: Bearer abc',
      body: '{"username":"admin"}',
      bodyType: 'json'
    }
  },
  {
    data: {
      name: '查用户',
      method: 'GET',
      url: 'http://test.example.com/api/v1/user',
      headers: 'Accept: application/json',
      body: '',
      bodyType: 'none'
    }
  }
];

const gen = generateJmx({
  apis,
  name: '冒烟计划',
  threads: 20,
  rampUp: 3,
  loops: 10,
  rtLimit: 500
});

check('jmx 生成成功', gen.ok === true, gen.message);
check('jmx 文件名', gen.filename === '冒烟计划.jmx', gen.filename);
check('jmx 有 XML 声明', /^<\?xml/.test(gen.xml), gen.xml.slice(0, 30));
check('jmx 有 jmeterTestPlan 根节点', /<jmeterTestPlan/.test(gen.xml), 'no root');

/* ---------- 3. 生成的 jmx 能被自己的解析器解析 ---------- */
const parsed = parseJmx(gen.xml, 't.jmx');
check('解析无错误', parsed.parseError === '', parsed.parseError);
check('测试计划名正确', parsed.testPlanName === '冒烟计划', parsed.testPlanName);
check('1 个线程组', parsed.threadGroups.length === 1, parsed.threadGroups.length);
check('线程数 20', parsed.threadGroups[0].numThreads === '20', parsed.threadGroups[0].numThreads);
check('Ramp 3', parsed.threadGroups[0].rampUp === '3', parsed.threadGroups[0].rampUp);
check('循环 10', parsed.threadGroups[0].loops === '10', parsed.threadGroups[0].loops);
check('2 个采样器', parsed.samplers.length === 2, parsed.samplers.length);
check('采样器方法正确', parsed.samplers[0].method === 'POST' && parsed.samplers[1].method === 'GET', parsed.samplers.map((s) => s.method));
check('采样器路径正确', parsed.samplers[0].path === '/api/login', parsed.samplers[0].path);
check('有响应断言', parsed.responseAssertions.length === 2, parsed.responseAssertions.length);
check('有持续时间断言', parsed.durationAssertions.length === 2, parsed.durationAssertions.length);
check('有 HTTP 头', parsed.headers.length === 2, parsed.headers.length);
check('健康检查 0 问题', checkHealth(parsed).issues.length === 0, checkHealth(parsed).issues);

/* ---------- 4. 持续时长模式 ---------- */
const genDur = generateJmx({ apis, name: '定时计划', duration: 30, rtLimit: 0 });
const parsedDur = parseJmx(genDur.xml, 't2.jmx');
check('定时模式：scheduler=true', parsedDur.threadGroups[0].scheduler === true, parsedDur.threadGroups[0].scheduler);
check('定时模式：duration=30', parsedDur.threadGroups[0].duration === '30', parsedDur.threadGroups[0].duration);
check('rtLimit=0 时不生成持续时间断言', parsedDur.durationAssertions.length === 0, parsedDur.durationAssertions.length);

/* ---------- 5. 生成器边界 ---------- */
check('空接口报错', generateJmx({ apis: [] }).ok === false);
check('单接口也能生成', generateJmx({ apis: [apis[0]] }).ok === true);

/* ---------- 6. XML 转义 ---------- */
const genEsc = generateJmx({
  apis: [{ data: { name: 'A&B<C>', method: 'GET', url: 'http://x.com/a?q=1&b=2', headers: '', body: '', bodyType: 'none' } }],
  name: 'T&T'
});
check('XML 转义 &', !/T&T/.test(genEsc.xml) && /T&amp;T/.test(genEsc.xml), 'not escaped');
check('转义后仍可解析', parseJmx(genEsc.xml, 't3.jmx').parseError === '', parseJmx(genEsc.xml, 't3.jmx').parseError);

/* ============================================================
 * 二、MySQL SQL 生成
 * ============================================================ */

/* ---------- 7. 快照 ---------- */
const snap = sqlgen.genSnapshot({ database: 'test_db', tables: ['t_order', 't_user'], mode: 'table' });
check('快照生成成功', snap.ok === true, snap.message);
check('快照有 USE', /USE `test_db`;/.test(snap.sql), 'no USE');
check('快照有 CREATE TABLE', /CREATE TABLE `bak_t_order_/.test(snap.sql), 'no CREATE');
check('快照有 INSERT SELECT', /INSERT INTO `bak_t_order_.*` SELECT \* FROM `t_order`;/.test(snap.sql), 'no INSERT');

const dump = sqlgen.genSnapshot({ database: 'test_db', tables: ['t_order'], mode: 'dump' });
check('mysqldump 模式', /mysqldump/.test(dump.sql), 'no mysqldump');
check('mysqldump 有库名', /test_db t_order/.test(dump.sql), 'no db');

/* ---------- 8. 清理 ---------- */
const clean1 = sqlgen.genCleanup({
  database: 'test_db',
  tables: [{ name: 't_order', mode: 'delete', where: "create_time < '2026-01-01'" }]
});
check('带条件 DELETE 成功', clean1.ok === true, clean1.message);
check('DELETE 有 WHERE', /DELETE FROM `t_order` WHERE create_time/.test(clean1.sql), 'no WHERE');
check('有外键关闭', /SET FOREIGN_KEY_CHECKS = 0;/.test(clean1.sql), 'no FK off');

// TRUNCATE 未确认 → 拒绝
const clean2 = sqlgen.genCleanup({ database: 'test_db', tables: [{ name: 't_order', mode: 'truncate' }] });
check('TRUNCATE 未确认被拒', clean2.ok === false, clean2.ok);
check('拒绝理由提到整表清空', /整表清空/.test(clean2.message), clean2.message);

// TRUNCATE 已确认 → 通过
const clean3 = sqlgen.genCleanup({ database: 'test_db', tables: [{ name: 't_order', mode: 'truncate' }], confirm: true });
check('TRUNCATE 已确认通过', clean3.ok === true, clean3.message);
check('有 TRUNCATE 语句', /TRUNCATE TABLE `t_order`;/.test(clean3.sql), 'no TRUNCATE');

// DELETE 无 WHERE 未确认 → 拒绝
const clean4 = sqlgen.genCleanup({ database: 'test_db', tables: [{ name: 't_order', mode: 'delete', where: '' }] });
check('无条件 DELETE 未确认被拒', clean4.ok === false, clean4.ok);

/* ---------- 9. 还原 ---------- */
const restore = sqlgen.genRestore({
  database: 'test_db',
  pairs: [{ table: 't_order', backup: 'bak_t_order_20261124_113000', mode: 'truncate-insert' }]
});
check('还原生成成功', restore.ok === true, restore.message);
check('还原先 TRUNCATE', /TRUNCATE TABLE `t_order`;/.test(restore.sql), 'no truncate');
check('还原有 INSERT', /INSERT INTO `t_order` SELECT \* FROM `bak_t_order_/.test(restore.sql), 'no insert');

/* ---------- 10. 安全校验（防 SQL 注入）---------- */
check('非法库名被拒', sqlgen.genSnapshot({ database: 'db; DROP TABLE x', tables: ['t'] }).ok === false);
check('非法表名被拒', sqlgen.genSnapshot({ database: 'db', tables: ['t; DROP TABLE x'] }).ok === false);
check('safeIdent 过滤特殊字符', sqlgen.safeIdent('t_order;DROP') === '', sqlgen.safeIdent('t_order;DROP'));
check('safeIdent 正常表名通过', sqlgen.safeIdent('t_order') === 't_order', sqlgen.safeIdent('t_order'));
check('safeIdent 数字开头被拒', sqlgen.safeIdent('1table') === '', sqlgen.safeIdent('1table'));

/* ---------- 11. 备份表列表 ---------- */
const list = sqlgen.listBackupTables(['t_order', 'bak_t_order_20261124_113000', 'bak_t_user_20261123_090000']);
check('识别出 2 个备份表', list.length === 2, list.length);
check('解析出原表名', list[0].table === 't_order', list[0].table);
check('解析出时间', list[0].stamp === '2026-11-24 11:30:00', list[0].stamp);

/* ---------- 12. IPC 已注册 ---------- */
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('有 jmxgen:preview', /ipcMain\.handle\('jmxgen:preview'/.test(mainSrc), 'no preview');
check('有 jmxgen:save', /ipcMain\.handle\('jmxgen:save'/.test(mainSrc), 'no save');
check('有 sqlgen:snapshot', /ipcMain\.handle\('sqlgen:snapshot'/.test(mainSrc), 'no snapshot');
check('有 sqlgen:cleanup', /ipcMain\.handle\('sqlgen:cleanup'/.test(mainSrc), 'no cleanup');
check('有 sqlgen:restore', /ipcMain\.handle\('sqlgen:restore'/.test(mainSrc), 'no restore');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 jmxgenPreview', /jmxgenPreview:/.test(preloadSrc), 'no preview');
check('preload 有 sqlgenSnapshot', /sqlgenSnapshot:/.test(preloadSrc), 'no snapshot');

/* ---------- 13. 前端 + 侧栏 ---------- */
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ScriptGenPage.tsx'), 'utf8');
check('页面有 jmx Tab', /tab === 'jmx'/.test(pageSrc), 'no jmx tab');
check('页面有 sql Tab', /tab === 'sql'/.test(pageSrc), 'no sql tab');
check('页面有危险操作确认', /confirmClear/.test(pageSrc), 'no confirm');
check('页面有快照/清理/还原', /snapshot/.test(pageSrc) && /cleanup/.test(pageSrc) && /restore/.test(pageSrc), 'missing mode');

const collections = require('../shared/collections.js');
check('TOOLS 有脚本生成', collections.TOOLS.some((t) => t.key === 'scriptgen'), collections.TOOLS.map((t) => t.key));
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
check('App 有 scriptgen 路由', /route\.key === 'scriptgen'/.test(appSrc), 'no route');

const failed = results.filter((r) => !r.ok);
console.log('===== 脚本生成测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);