/* v0.38.0：补齐规划剩余 6 项 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 1. 造数：时间范围
 * ============================================================ */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'DataTool.tsx'), 'utf8');
  // genDate 已抽到 shared/faker.js（前后端共用）
  const fakerSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'faker.js'), 'utf8');
  check('genDate 接受 from/to', /function genDate\(from, to\)/.test(fakerSrc), 'no params');
  check('有 dateFrom 状态', /dateFrom/.test(src), 'no state');
  check('有 dateTo 状态', /dateTo/.test(src), 'no state');
  check('日期范围 UI 存在', src.includes('dateFrom') && src.includes('dateTo') && src.includes('type="date"'), 'no ui');
  check('单类型用自定义范围', /def\.value === 'date' \? genDate\(dateFrom, dateTo\)/.test(src), 'not used');
  check('多字段也用自定义范围', /t\.value === 'date' \? \(\) => genDate\(dateFrom, dateTo\)/.test(src), 'not used');
  check('范围非法时兜底', /endMs <= startMs/.test(fakerSrc), 'no fallback');
}

/* ============================================================
 * 2. 断言库：新分类 + 8 个模板
 * ============================================================ */
{
  const t = require('../shared/scriptTemplates.js');
  const cats = t.TEMPLATE_CATEGORIES.map((c) => c.key);
  check('有 api-assert 分类', cats.includes('api-assert'), cats);
  check('有 ui-assert 分类', cats.includes('ui-assert'), cats);
  check('模板总数 ≥ 18', t.TEMPLATES.length >= 18, t.TEMPLATES.length);

  const api = t.TEMPLATES.filter((x) => x.category === 'api-assert');
  const ui = t.TEMPLATES.filter((x) => x.category === 'ui-assert');
  check('接口断言 ≥ 5 个', api.length >= 5, api.length);
  check('UI 断言 ≥ 3 个', ui.length >= 3, ui.length);

  check('有 JSON Schema（RestAssured）', api.some((x) => /Schema/.test(x.name)), api.map((x) => x.name));
  check('有 JSON Schema（pytest）', api.some((x) => /Schema/.test(x.name) && /pytest/.test(x.name)), 'no');
  check('有可见性断言', ui.some((x) => /可见/.test(x.name)), ui.map((x) => x.name));
  check('有文本断言', ui.some((x) => /文本/.test(x.name)), ui.map((x) => x.name));
  check('有属性断言', ui.some((x) => /属性/.test(x.name)), ui.map((x) => x.name));

  // 每个模板字段完整
  const bad = t.TEMPLATES.filter((x) => !x.id || !x.category || !x.name || !x.code || !x.gotcha);
  check('所有模板字段完整', bad.length === 0, bad.map((x) => x.id));

  // 分类都有模板
  const usedCats = new Set(t.TEMPLATES.map((x) => x.category));
  check('每个分类都有模板', cats.every((c) => usedCats.has(c)), [...usedCats]);
}

/* ============================================================
 * 3. POJO：从 CREATE TABLE
 * ============================================================ */
{
  const { parseCreateTable, toCamel } = require('../shared/sqlschema.js');

  const mysql = `
CREATE TABLE \`t_order\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '主键',
  \`order_no\` varchar(64) NOT NULL COMMENT '订单号',
  \`amount\` decimal(10,2) COMMENT '金额',
  \`status\` tinyint(4) COMMENT '状态',
  \`created_at\` datetime COMMENT '创建时间',
  \`is_deleted\` bit(1) COMMENT '删除标记',
  \`remark\` text COMMENT '备注',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_no\` (\`order_no\`)
);`;
  const r = parseCreateTable(mysql);
  check('解析 CREATE TABLE 成功', r.ok === true, r.message);
  check('表名正确', r.table === 't_order', r.table);
  check('字段数 7（跳过 PRIMARY/UNIQUE）', r.columns.length === 7, r.columns.length);
  check('bigint → Long', r.columns[0].javaType === 'Long', r.columns[0].javaType);
  check('varchar → String', r.columns[1].javaType === 'String', r.columns[1].javaType);
  check('decimal → BigDecimal', r.columns[2].javaType === 'java.math.BigDecimal', r.columns[2].javaType);
  check('tinyint → Integer', r.columns[3].javaType === 'Integer', r.columns[3].javaType);
  check('datetime → LocalDateTime', r.columns[4].javaType === 'java.time.LocalDateTime', r.columns[4].javaType);
  check('bit → Boolean', r.columns[5].javaType === 'Boolean', r.columns[5].javaType);
  check('text → String', r.columns[6].javaType === 'String', r.columns[6].javaType);
  check('注释提取', r.columns[1].comment === '订单号', r.columns[1].comment);
  check('下划线转驼峰', r.columns[1].camel === 'orderNo', r.columns[1].camel);

  // SQLite
  const sqlite = `CREATE TABLE IF NOT EXISTS "user_info" (id INTEGER PRIMARY KEY, user_name VARCHAR(50), avatar BLOB);`;
  const r2 = parseCreateTable(sqlite);
  check('SQLite 解析成功', r2.ok === true, r2.message);
  check('SQLite 表名', r2.table === 'user_info', r2.table);
  check('SQLite 字段数 3', r2.columns.length === 3, r2.columns.length);
  check('BLOB → byte[]', r2.columns[2].javaType === 'byte[]', r2.columns[2].javaType);

  // 边界
  check('空串报错', parseCreateTable('').ok === false);
  check('非建表报错', parseCreateTable('select 1').ok === false);

  // codegen 集成
  const cg = require('../shared/codegen.js');
  const g = cg.generate('pojo-java', { sql: mysql, className: '' });
  check('codegen 从 SQL 生成成功', g.ok === true, g.message);
  check('类名从表名推断（t_order → Order）', g.filename === 'Order.java', g.filename);
  check('生成的代码有字段', /private Long id;/.test(g.code), 'no id');
  check('生成的代码有注释', /主键/.test(g.code), 'no comment');
}

/* ============================================================
 * 4. jmx：CSV 参数化
 * ============================================================ */
{
  const { generateJmx } = require('../shared/jmxgen.js');
  const jmx = require('../electron/jmx.js');

  const apis = [{ data: { name: 'T', method: 'GET', url: 'http://x.com/a', headers: '', body: '', bodyType: 'none' } }];

  // 不启用
  const g1 = generateJmx({ apis, name: 'T' });
  check('不传 csv 时不生成', !/CSVDataSet/.test(g1.xml), 'has CSVDataSet');

  // 启用
  const g2 = generateJmx({
    apis,
    name: 'T',
    csv: { fileName: 'data.csv', variableNames: 'userName,mobile', delimiter: ',', recycle: true }
  });
  check('生成 CSVDataSet', /CSVDataSet/.test(g2.xml), 'no CSVDataSet');
  check('有文件名', /data\.csv/.test(g2.xml), 'no filename');
  check('有变量名', /userName,mobile/.test(g2.xml), 'no vars');

  // 能被解析器读
  const p2 = jmx.parseJmx(g2.xml, 't.jmx');
  check('解析无错误', p2.parseError === '', p2.parseError);
  check('解析出 1 个 CSV', p2.csvs.length === 1, p2.csvs.length);
  check('CSV 文件名正确', p2.csvs[0].filename === 'data.csv', p2.csvs[0].filename);
  check('CSV 变量名正确', p2.csvs[0].variableNames === 'userName,mobile', p2.csvs[0].variableNames);
  check('recycle=true', p2.csvs[0].recycle === true, p2.csvs[0].recycle);

  // stopThread
  const g3 = generateJmx({ apis, name: 'T', csv: { fileName: 'd.csv', variableNames: 'a', stopThread: true } });
  check('stopThread=true', jmx.parseJmx(g3.xml, 't.jmx').csvs[0].stopThread === true, 'not set');
}

/* ============================================================
 * 5. 依赖冲突检查
 * ============================================================ */
{
  const { checkDeps, parsePom, parseRequirements } = require('../electron/deps.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-t-'));
  fs.writeFileSync(
    path.join(tmp, 'pom.xml'),
    `<?xml version="1.0"?>
<project>
  <properties><junit.version>5.9.0</junit.version></properties>
  <dependencies>
    <dependency><groupId>org.junit</groupId><artifactId>junit-jupiter</artifactId><version>5.9.0</version></dependency>
    <dependency><groupId>org.junit</groupId><artifactId>junit-jupiter</artifactId><version>5.10.0</version></dependency>
    <dependency><groupId>com.foo</groupId><artifactId>bar</artifactId><version>\${undefined.prop}</version></dependency>
    <dependency><groupId>com.ok</groupId><artifactId>good</artifactId><version>\${junit.version}</version></dependency>
  </dependencies>
</project>`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmp, 'requirements.txt'),
    ['requests==2.28.0', 'flask>=2.0', 'requests==2.31.0'].join('\n'),
    'utf8'
  );

  const r = checkDeps(tmp);
  const kinds = r.issues.map((i) => i.kind);
  check('检查出 pom + req', r.poms === 1 && r.reqs === 1, { poms: r.poms, reqs: r.reqs });
  check('发现 Maven 版本冲突', kinds.includes('maven-version-conflict'), kinds);
  check('发现 Maven 重复声明', kinds.includes('maven-duplicate'), kinds);
  check('发现占位符未定义', kinds.includes('maven-unresolved-property'), kinds);
  check('已定义的占位符不误报', !r.issues.some((i) => /junit\.version/.test(i.detail)), 'false positive');
  check('发现 pip 版本冲突', kinds.includes('pip-version-conflict'), kinds);
  check('summary 有 high', r.summary.high >= 2, r.summary);

  // 边界
  check('空目录不报错', checkDeps('').ok === false);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-e-'));
  const er = checkDeps(empty);
  check('没依赖文件时返回提示', er.ok === true && !!er.message, er.message);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  // 真实项目
  const real = 'D:/AI_Workspace/Project/example';
  if (fs.existsSync(real)) {
    const rr = checkDeps(real);
    check('真实项目能检查', rr.ok === true && rr.poms >= 1, { poms: rr.poms });
  }
}

/* ============================================================
 * 6. 页面元素可视化编辑
 * ============================================================ */
{
  const ed = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PageElementsEditor.tsx'), 'utf8');
  check('有 PageElementsEditor 组件', /export default function PageElementsEditor/.test(ed), 'no comp');
  check('有 parseElements', /export function parseElements/.test(ed), 'no parse');
  check('有 serializeElements', /export function serializeElements/.test(ed), 'no serialize');
  check('有 dropEmptyElements', /export function dropEmptyElements/.test(ed), 'no drop');
  check('支持 JSON 格式解析', /JSON\.parse\(s\)/.test(ed), 'no json parse');
  check('兼容旧文本格式', /indexOf\('='\)/.test(ed), 'no text fallback');

  // collections 里 type 是 elements
  const c = require('../shared/collections.js');
  const pg = c.COLLECTIONS.find((x) => x.key === 'pages');
  const el = pg.fields.find((f) => f.key === 'elements');
  check('pages.elements 类型是 elements', el.type === 'elements', el.type);

  // RecordForm 有分支
  const rf = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RecordForm.tsx'), 'utf8');
  check('RecordForm 有 elements 分支', /case 'elements'/.test(rf), 'no case');
  check('保存前清理空元素', /dropEmptyElements/.test(rf), 'no cleanup');
}

/* ============================================================
 * 7. IPC / preload
 * ============================================================ */
{
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');

  check('有 codescan:deps', /ipcMain\.handle\('codescan:deps'/.test(mainSrc), 'no deps ipc');
  check('preload 有 codescanDeps', /codescanDeps:/.test(preloadSrc), 'no preload');
  check('codegen IPC 透传 sql', /sql: payload\.sql/.test(mainSrc), 'no sql');
  check('jmxgen IPC 透传 csv', /csv: payload\.csv/.test(mainSrc), 'no csv');

  const scanSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodeScanPage.tsx'), 'utf8');
  check('代码体检有依赖按钮', /依赖检查/.test(scanSrc), 'no button');
  check('代码体检有依赖视图', /view === 'deps'/.test(scanSrc), 'no view');

  const cgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodegenPage.tsx'), 'utf8');
  check('代码生成有 CREATE TABLE 模式', /modelSource === 'sql'/.test(cgSrc), 'no sql mode');

  const sgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ScriptGenPage.tsx'), 'utf8');
  check('脚本生成有 CSV 配置', /csvEnabled/.test(sgSrc), 'no csv ui');
}

const failed = results.filter((r) => !r.ok);
console.log('===== v0.38.0 补齐 6 项测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);