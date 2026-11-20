/* cURL 解析器测试 */
const { parseCurl, normalize, tokenize, guessName, guessBodyType } = require('../shared/curl.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 归一化 ---------- */
check('去掉 Windows 续行 ^', /^curl 'a'\s+-H 'b'$/.test(normalize("curl 'a' ^\n  -H 'b'")));
check('去掉 Linux 续行 \\', /^curl 'a'\s+-H 'b'$/.test(normalize("curl 'a' \\\n  -H 'b'")));
check('去掉 BOM', normalize("\uFEFFcurl 'a'") === "curl 'a'");
check('空输入返回空', normalize('') === '');

/* ---------- 2. 分词 ---------- */
const t1 = tokenize("curl 'https://a.com/x' -H 'A: b c'");
check('分词：引号内空格不切', t1.length === 4 && t1[3] === 'A: b c', t1);
const t2 = tokenize('curl "https://a.com/x" -d "{\\"a\\":1}"');
check('分词：双引号转义', t2.length === 4 && t2[3] === '{"a":1}', t2);
const t3 = tokenize("curl $'a\\nb'");
check('分词：$ 引号处理换行', t3.length === 2 && t3[1] === 'a\nb', t3);
const t4 = tokenize("curl 'a' 'b'");
check('分词：多个引号参数', t4.length === 3 && t4[1] === 'a' && t4[2] === 'b', t4);

/* ---------- 3. 名称推断 ---------- */
check('名称：取最后一段路径', guessName('https://api.x.com/v1/user') === 'user');
check('名称：带查询参数', guessName('https://api.x.com/user?id=1') === 'user');
check('名称：根路径用域名', guessName('https://api.x.com/') === 'api.x.com');
check('名称：非法 URL 不崩', typeof guessName('not a url') === 'string');

/* ---------- 4. body 类型推断 ---------- */
check('类型：JSON', guessBodyType('application/json', '{"a":1}') === 'json');
check('类型：form', guessBodyType('application/x-www-form-urlencoded', 'a=1&b=2') === 'form');
check('类型：无 Content-Type 按内容猜 JSON', guessBodyType('', '{"a":1}') === 'json');
check('类型：无 Content-Type 按内容猜 form', guessBodyType('', 'a=1&b=2') === 'form');
check('类型：空 body', guessBodyType('application/json', '') === 'none');

/* ---------- 5. 完整解析：Chrome 风格 ---------- */
const chrome = `curl 'https://api.example.com/v1/user' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  --data-raw '{"id":1,"name":"test"}' \\
  --compressed`;
const r1 = parseCurl(chrome);
check('Chrome：解析成功', r1.ok === true, r1);
check('Chrome：方法推断为 POST', r1.method === 'POST', r1.method);
check('Chrome：URL 正确', r1.url === 'https://api.example.com/v1/user', r1.url);
check('Chrome：名称 user', r1.name === 'user', r1.name);
check('Chrome：2 个 header', r1.headers.split('\n').length === 2, r1.headers);
check('Chrome：body 正确', r1.body === '{"id":1,"name":"test"}', r1.body);
check('Chrome：bodyType json', r1.bodyType === 'json', r1.bodyType);
check('Chrome：--compressed 静默忽略（不报警告）', !r1.warnings.some((w) => /--compressed/.test(w.text)), r1.warnings);

/* ---------- 6. Postman 风格 ---------- */
const postman = `curl --location --request PUT 'https://api.example.com/v1/item/9' \\
--header 'Content-Type: application/json' \\
--header 'Authorization: Bearer abc123' \\
--data '{"status":"done"}'`;
const r2 = parseCurl(postman);
check('Postman：方法 PUT', r2.method === 'PUT', r2.method);
check('Postman：URL 正确', r2.url === 'https://api.example.com/v1/item/9', r2.url);
check('Postman：2 个 header', r2.headers.split('\n').length === 2, r2.headers);
check('Postman：--location 被忽略', !r2.warnings.some((w) => /--location/.test(w.text)), r2.warnings);

/* ---------- 7. Apifox 风格（带 -u 认证）---------- */
const apifox = `curl -X POST 'https://api.example.com/login' \\
  -H 'Content-Type: application/json' \\
  -u 'admin:secret' \\
  -d '{"user":"admin"}'`;
const r3 = parseCurl(apifox);
check('Apifox：方法 POST', r3.method === 'POST', r3.method);
check('Apifox：-u 转成 Authorization', /Authorization: Basic /.test(r3.headers), r3.headers);
check('Apifox：-u 有警告', r3.warnings.some((w) => /-u/.test(w.text)), r3.warnings);

/* ---------- 8. -F 表单 ---------- */
const form = `curl -X POST 'https://api.example.com/upload' -F 'file=@a.png' -F 'name=test'`;
const r4 = parseCurl(form);
check('表单：bodyType form', r4.bodyType === 'form', r4.bodyType);
check('表单：body 含 file', /file=@a\.png/.test(r4.body), r4.body);
check('表单：有警告', r4.warnings.some((w) => /multipart/.test(w.text)), r4.warnings);

/* ---------- 9. GET 无 body ---------- */
const get = `curl 'https://api.example.com/list?page=1'`;
const r5 = parseCurl(get);
check('GET：方法推断为 GET', r5.method === 'GET', r5.method);
check('GET：body 为空', r5.body === '', r5.body);
check('GET：bodyType none', r5.bodyType === 'none', r5.bodyType);
check('GET：无警告', r5.warnings.length === 0, r5.warnings);

/* ---------- 10. 异常输入 ---------- */
check('空输入报错', parseCurl('').ok === false);
check('非 curl 报错', parseCurl('wget https://a.com').ok === false);
check('只有 curl 不崩', typeof parseCurl('curl').ok === 'boolean');

/* ---------- 11. 未知参数 ---------- */
const unknown = `curl 'https://a.com/x' --some-unknown-flag value --another`;
const r6 = parseCurl(unknown);
check('未知参数有警告', r6.warnings.some((w) => /不认识/.test(w.text)), r6.warnings);

/* ---------- 12. URL 含占位符 ---------- */
const placeholder = `curl 'https://api.example.com/\${env}/user'`;
const r7 = parseCurl(placeholder);
check('占位符有警告', r7.warnings.some((w) => /占位符/.test(w.text)), r7.warnings);

/* ---------- 13. 非法 JSON body ---------- */
const badJson = `curl -X POST 'https://a.com/x' -H 'Content-Type: application/json' -d '{bad json'`;
const r8 = parseCurl(badJson);
check('非法 JSON 有警告', r8.warnings.some((w) => /解析失败/.test(w.text)), r8.warnings);
check('非法 JSON 保留原文', r8.body === '{bad json', r8.body);

/* ---------- 14. 多个 -d 拼接 ---------- */
const multiD = `curl -X POST 'https://a.com/x' -d 'a=1' -d 'b=2'`;
const r9 = parseCurl(multiD);
check('多个 -d 用 & 拼接', r9.body === 'a=1&b=2', r9.body);

const failed = results.filter((r) => !r.ok);
console.log('===== cURL 解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
