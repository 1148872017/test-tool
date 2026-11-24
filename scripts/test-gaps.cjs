/* 补齐规划差异的测试：OpenAPI 文件导入、双方言 SQL、断言质量、页面元素 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 一、OpenAPI 文件解析（JSON / YAML）
 * ============================================================ */

const openapifile = require('../electron/openapifile.js');

// 真实 JSON 文件
const realJson = 'C:/Users/EDY/Downloads/默认模块.openapi.json';
if (fs.existsSync(realJson)) {
  const r = openapifile.parseFile(realJson);
  check('JSON 文件解析成功', r.ok === true, r.message);
  check('JSON 解析出接口', r.items && r.items.length > 0, r.items ? r.items.length : 0);
  check('每个 item 有 tmpId', r.items && r.items.every((it) => it.tmpId), 'no tmpId');
  check('返回 doc 信息', !!r.doc && !!r.doc.title, r.doc);
} else {
  console.log('（跳过真实 JSON 测试）');
}

// 造 YAML 文件
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-test-'));
const yamlFile = path.join(tmp, 'test.yaml');
fs.writeFileSync(
  yamlFile,
  [
    'openapi: 3.0.1',
    'info:',
    '  title: YAML 测试',
    '  version: 1.0.0',
    'paths:',
    '  /user:',
    '    post:',
    '      summary: 创建用户',
    '      tags:',
    '        - 用户',
    '      responses:',
    "        '200':",
    '          description: OK',
    '  /user/{id}:',
    '    get:',
    '      summary: 查用户',
    '      parameters:',
    '        - name: id',
    '          in: path',
    '          required: true',
    '          schema:',
    '            type: string',
    '      responses:',
    "        '200':",
    '          description: OK'
  ].join('\n'),
  'utf8'
);

const ry = openapifile.parseFile(yamlFile);
check('YAML 文件解析成功', ry.ok === true, ry.message);
check('YAML 解析出 2 个接口', ry.items && ry.items.length === 2, ry.items ? ry.items.length : 0);
check('YAML 接口有 method', ry.items && ry.items[0].method === 'POST', ry.items ? ry.items[0].method : '');
check('YAML 接口有 url', ry.items && ry.items[0].url === '/user', ry.items ? ry.items[0].url : '');

// 边界
check('不存在的文件报错', openapifile.parseFile('D:/nonexistent-xyz.json').ok === false);
check('空路径报错', openapifile.parseFile('').ok === false);

// Swagger 2.0 拒绝
const swaggerFile = path.join(tmp, 'swagger.json');
fs.writeFileSync(swaggerFile, JSON.stringify({ swagger: '2.0', info: {}, paths: {} }), 'utf8');
const rsw = openapifile.parseFile(swaggerFile);
check('Swagger 2.0 被拒', rsw.ok === false && /Swagger 2.0/.test(rsw.message), rsw.message);

// 无 paths
const emptyFile = path.join(tmp, 'empty.json');
fs.writeFileSync(emptyFile, JSON.stringify({ openapi: '3.0.1', info: {}, paths: {} }), 'utf8');
check('无 paths 被拒', openapifile.parseFile(emptyFile).ok === false);

fs.rmSync(tmp, { recursive: true, force: true });

/* ============================================================
 * 二、SQL 双方言
 * ============================================================ */

const sqlgen = require('../shared/sqlgen.js');

check('方言列表有 2 个', sqlgen.listDialects().length === 2, sqlgen.listDialects());
check('有 mysql', sqlgen.listDialects().some((d) => d.key === 'mysql'), 'no mysql');
check('有 sqlite', sqlgen.listDialects().some((d) => d.key === 'sqlite'), 'no sqlite');
check('未知方言兜底 mysql', sqlgen.getDialect('oracle').label === 'MySQL', sqlgen.getDialect('oracle').label);

/* ---------- 快照：MySQL vs SQLite ---------- */
const mySnap = sqlgen.genSnapshot({ dialect: 'mysql', database: 'db', tables: ['t'], mode: 'table' });
const sqSnap = sqlgen.genSnapshot({ dialect: 'sqlite', database: 'db', tables: ['t'], mode: 'table' });

check('MySQL 用 CREATE TABLE ... LIKE', /CREATE TABLE `bak_t_[^`]+` LIKE `t`;/.test(mySnap.sql), mySnap.sql.slice(0, 200));
check('MySQL 有 USE', /USE `db`;/.test(mySnap.sql), 'no USE');
check('SQLite 用 CREATE TABLE ... AS SELECT', /CREATE TABLE "bak_t_[^"]+" AS SELECT \* FROM "t";/.test(sqSnap.sql), sqSnap.sql.slice(0, 200));
check('SQLite 没有 USE', !/USE /.test(sqSnap.sql), 'has USE');
check('SQLite 用双引号', /"/.test(sqSnap.sql), 'no double quote');
check('MySQL 用反引号', /`/.test(mySnap.sql), 'no backtick');

/* ---------- 快照：导出命令 ---------- */
const myDump = sqlgen.genSnapshot({ dialect: 'mysql', database: 'db', tables: ['t'], mode: 'dump' });
const sqDump = sqlgen.genSnapshot({ dialect: 'sqlite', database: 'db', tables: ['t'], mode: 'dump' });
check('MySQL 导出用 mysqldump', /mysqldump/.test(myDump.sql), 'no mysqldump');
check('SQLite 导出用 sqlite3', /sqlite3/.test(sqDump.sql), 'no sqlite3');
check('SQLite 导出有 .backup', /\.backup/.test(sqDump.sql), 'no .backup');

/* ---------- 清理：TRUNCATE 差异 ---------- */
const myClean = sqlgen.genCleanup({ dialect: 'mysql', database: 'db', tables: [{ name: 't', mode: 'truncate' }], confirm: true });
const sqClean = sqlgen.genCleanup({ dialect: 'sqlite', database: 'db', tables: [{ name: 't', mode: 'truncate' }], confirm: true });

check('MySQL 有 TRUNCATE', /TRUNCATE TABLE `t`;/.test(myClean.sql), 'no TRUNCATE');
check('MySQL 有 FOREIGN_KEY_CHECKS', /SET FOREIGN_KEY_CHECKS = 0;/.test(myClean.sql), 'no FK');
// 只看「非注释的语句行」——注释里会写「SQLite 无 TRUNCATE」这种说明
const sqlOnly = (txt) => String(txt).split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
check('SQLite 语句里没有 TRUNCATE', !/TRUNCATE/i.test(sqlOnly(sqClean.sql)), sqlOnly(sqClean.sql));
check('SQLite 用 DELETE', /DELETE FROM "t";/.test(sqClean.sql), 'no DELETE');
check('SQLite 重置自增', /sqlite_sequence WHERE name = 't'/.test(sqClean.sql), 'no sqlite_sequence');
check('SQLite 有 PRAGMA foreign_keys', /PRAGMA foreign_keys = OFF;/.test(sqClean.sql), 'no PRAGMA');
check('SQLite 有 VACUUM', /VACUUM;/.test(sqClean.sql), 'no VACUUM');
check('MySQL 没有 VACUUM', !/VACUUM/.test(myClean.sql), 'has VACUUM');

/* ---------- 还原：REPLACE 差异 ---------- */
const myRes = sqlgen.genRestore({ dialect: 'mysql', database: 'db', pairs: [{ table: 't', backup: 'bak_t_20261124_120000', mode: 'replace' }] });
const sqRes = sqlgen.genRestore({ dialect: 'sqlite', database: 'db', pairs: [{ table: 't', backup: 'bak_t_20261124_120000', mode: 'replace' }] });
check('MySQL 用 REPLACE INTO', /REPLACE INTO `t`/.test(myRes.sql), 'no REPLACE');
check('SQLite 用 INSERT OR REPLACE', /INSERT OR REPLACE INTO "t"/.test(sqRes.sql), 'no INSERT OR REPLACE');

/* ---------- 安全校验（双方言一致）---------- */
check('TRUNCATE 未确认被拒（mysql）', sqlgen.genCleanup({ dialect: 'mysql', database: 'db', tables: [{ name: 't', mode: 'truncate' }] }).ok === false);
check('TRUNCATE 未确认被拒（sqlite）', sqlgen.genCleanup({ dialect: 'sqlite', database: 'db', tables: [{ name: 't', mode: 'truncate' }] }).ok === false);
check('SQL 注入被拒（sqlite）', sqlgen.genSnapshot({ dialect: 'sqlite', database: 'db', tables: ['t; DROP TABLE x'] }).ok === false);

/* ============================================================
 * 三、断言质量检查
 * ============================================================ */

const codescan = require('../electron/codescan.js');

const weakJava = `public class WeakTest {
    @Test
    public void testLogin() {
        given().when().post("/api/login").then().statusCode(200);
    }
}`;
const strongJava = `public class StrongTest {
    @Test
    public void testLogin() {
        given().when().post("/api/login").then().statusCode(200).body("code", equalTo(0));
    }
}`;
const weakPy = `import requests

def test_login():
    resp = requests.post("http://x.com/api/login")
    assert resp.status_code == 200
`;
const strongPy = `import requests

def test_login():
    resp = requests.post("http://x.com/api/login")
    assert resp.status_code == 200
    assert resp.json()["code"] == 0
`;

check('弱断言 Java 被报', codescan.scanAssertionQuality(weakJava, 'WeakTest.java').length === 1, codescan.scanAssertionQuality(weakJava, 'WeakTest.java').length);
check('强断言 Java 不报', codescan.scanAssertionQuality(strongJava, 'StrongTest.java').length === 0, codescan.scanAssertionQuality(strongJava, 'StrongTest.java').length);
check('弱断言 Python 被报', codescan.scanAssertionQuality(weakPy, 'test_api.py').length === 1, codescan.scanAssertionQuality(weakPy, 'test_api.py').length);
check('强断言 Python 不报', codescan.scanAssertionQuality(strongPy, 'test_api2.py').length === 0, codescan.scanAssertionQuality(strongPy, 'test_api2.py').length);
check('非测试代码不报', codescan.scanAssertionQuality('const a = 1;', 'util.js').length === 0);

// 报出的问题字段完整
const weakIssues = codescan.scanAssertionQuality(weakJava, 'WeakTest.java');
check('弱断言有 rule', weakIssues[0] && weakIssues[0].rule === 'weak-assertion', weakIssues[0]);
check('弱断言有 methodName', weakIssues[0] && !!weakIssues[0].methodName, weakIssues[0]);
check('弱断言 severity=medium', weakIssues[0] && weakIssues[0].severity === 'medium', weakIssues[0]);

/* ============================================================
 * 四、页面元素集合
 * ============================================================ */

const collections = require('../shared/collections.js');
const pagesConf = collections.COLLECTIONS.find((c) => c.key === 'pages');
check('有 pages 集合', !!pagesConf, collections.COLLECTIONS.map((c) => c.key));
check('pages 分组是资产', pagesConf && pagesConf.group === '资产', pagesConf && pagesConf.group);
check('pages 有 titleField', pagesConf && pagesConf.titleField === 'name', pagesConf && pagesConf.titleField);
check('pages 有 elements 字段', pagesConf && pagesConf.fields.some((f) => f.key === 'elements'), pagesConf && pagesConf.fields.map((f) => f.key));

/* ============================================================
 * 五、IPC 已注册
 * ============================================================ */

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('有 openapi:pickFile', /ipcMain\.handle\('openapi:pickFile'/.test(mainSrc), 'no pickFile');
check('有 openapi:parseFile', /ipcMain\.handle\('openapi:parseFile'/.test(mainSrc), 'no parseFile');
check('codegen:preview 支持 apiData', /payload\.apiData/.test(mainSrc), 'no apiData');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 openapiPickFile', /openapiPickFile:/.test(preloadSrc), 'no pickFile');
check('preload 有 openapiParseFile', /openapiParseFile:/.test(preloadSrc), 'no parseFile');

/* ============================================================
 * 六、前端支持
 * ============================================================ */

const codegenSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodegenPage.tsx'), 'utf8');
check('CodegenPage 有数据源切换', /apiSource/.test(codegenSrc), 'no apiSource');
check('CodegenPage 能选 OpenAPI 文件', /doPickOpenapi/.test(codegenSrc), 'no pick');
check('CodegenPage 能载入页面元素', /doLoadPage/.test(codegenSrc), 'no loadPage');

const scriptSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ScriptGenPage.tsx'), 'utf8');
check('ScriptGenPage 有方言切换', /dialect/.test(scriptSrc), 'no dialect');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'DataTool.tsx'), 'utf8');
check('DataTool 有模式切换', /mode === 'multi'/.test(dataSrc), 'no multi mode');
check('DataTool 有字段表格', /addField/.test(dataSrc), 'no addField');
check('DataTool 导出多列 CSV', /activeFieldNames/.test(dataSrc), 'no fields export');

const failed = results.filter((r) => !r.ok);
console.log('===== 补齐差异测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);