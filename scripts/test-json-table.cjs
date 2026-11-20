/* JSON / Headers → 表格 测试 */
const { toTable, jsonToRows, headersToRows, tryParseJson, shortValue, MAX_ROWS } = require('../shared/jsonTable.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. JSON 对象 ---------- */
const objRows = jsonToRows({ a: 1, b: 'x', c: true });
check('对象：3 行', objRows.length === 3, objRows.length);
check('对象：key 正确', objRows.map((r) => r.key).join(',') === 'a,b,c', objRows.map((r) => r.key));
check('对象：值转字符串', objRows[0].value === '1' && objRows[1].value === 'x', objRows);

/* ---------- 2. JSON 数组 ---------- */
const arrRows = jsonToRows([10, 20, 30]);
check('数组：3 行', arrRows.length === 3, arrRows.length);
check('数组：key 是 [i]', arrRows[0].key === '[0]' && arrRows[2].key === '[2]', arrRows.map((r) => r.key));

/* ---------- 3. 嵌套 ---------- */
const nested = jsonToRows({ a: { x: 1, y: 2 }, b: [1, 2, 3] });
check('嵌套：只显示第一层', nested.length === 2, nested.length);
check('嵌套：对象显示字段数', nested[0].value === '{2 个字段}', nested[0].value);
check('嵌套：数组显示项数', nested[1].value === '[3 项]', nested[1].value);
check('嵌套：标记为 complex', nested[0].complex === true && nested[1].complex === true, nested);
check('嵌套：title 是完整 JSON', /"x": 1/.test(nested[0].title), nested[0].title);

/* ---------- 4. 特殊值 ---------- */
const special = jsonToRows({ n: null, e: '', z: 0, f: false });
check('null 显示 null', special[0].value === 'null', special[0].value);
check('空字符串有提示', special[1].value === '（空字符串）', special[1].value);
check('0 显示 0', special[2].value === '0', special[2].value);
check('false 显示 false', special[3].value === 'false', special[3].value);

/* ---------- 5. 长值截断 ---------- */
const long = 'x'.repeat(200);
const longRows = jsonToRows({ k: long });
check('长值截断', longRows[0].value.length <= 121, longRows[0].value.length);
check('长值带省略号', longRows[0].value.endsWith('…'), longRows[0].value.slice(-3));
check('长值 title 完整', longRows[0].title.length === 200, longRows[0].title.length);

/* ---------- 6. Headers 解析 ---------- */
const hRows = headersToRows('Content-Type: application/json\nAuthorization: Bearer abc\nX-Empty:');
check('Headers：3 行', hRows.length === 3, hRows.length);
check('Headers：key/value 正确', hRows[0].key === 'Content-Type' && hRows[0].value === 'application/json', hRows[0]);
check('Headers：空值不崩', hRows[2].key === 'X-Empty' && hRows[2].value === '', hRows[2]);
check('Headers：忽略空行', headersToRows('A: 1\n\n\nB: 2').length === 2, headersToRows('A: 1\n\n\nB: 2').length);
check('Headers：没冒号整行当 key', headersToRows('NoColon')[0].key === 'NoColon', headersToRows('NoColon'));

/* ---------- 7. tryParseJson ---------- */
check('合法 JSON', tryParseJson('{"a":1}').ok === true);
check('非法 JSON', tryParseJson('{bad').ok === false);
check('空内容', tryParseJson('').ok === false);
check('纯数字也算 JSON', tryParseJson('123').ok === true);

/* ---------- 8. toTable 统一入口 ---------- */
const t1 = toTable('headers', 'A: 1\nB: 2');
check('toTable headers 可表格', t1.canTable === true && t1.total === 2, t1);

const t2 = toTable('body', '{"a":1,"b":2}');
check('toTable body JSON 可表格', t2.canTable === true && t2.total === 2, t2);

const t3 = toTable('body', 'not json');
check('toTable body 非 JSON 不可表格', t3.canTable === false, t3);
check('toTable body 非 JSON 有 message', typeof t3.message === 'string', t3.message);

const t4 = toTable('body', '');
check('toTable 空内容不可表格', t4.canTable === false, t4);

const t5 = toTable('params', '{"a":1}');
check('toTable 非 headers 字段按 JSON 处理', t5.canTable === true, t5);

/* ---------- 9. 超行数限制 ---------- */
const big = {};
for (let i = 0; i < MAX_ROWS + 10; i++) big['k' + i] = i;
const t6 = toTable('body', JSON.stringify(big));
check('超行数不可表格', t6.canTable === false, t6.canTable);
check('超行数提示字段太多', /字段太多/.test(t6.message), t6.message);

/* ---------- 10. 边界 ---------- */
check('null 不崩', jsonToRows(null).length === 0);
check('undefined 不崩', jsonToRows(undefined).length === 0);
check('标量不崩', jsonToRows(42).length === 1);
check('空对象不崩', jsonToRows({}).length === 0);

const failed = results.filter((r) => !r.ok);
console.log('===== JSON 表格测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
