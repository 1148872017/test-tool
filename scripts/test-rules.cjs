/* 代码体检规则表（electron/scan-rules.js）：完整性 + 正反例 + 上限/截断 + ruleIds 过滤 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const sr = require('../electron/scan-rules.js');
const cs = require('../electron/codescan.js');

/** 跑一次匹配，返回命中里的规则 id 列表（方便断言「报没报」） */
const hitIds = (text, file, ruleIds, opts) =>
  sr.matchRules(text, file || '', ruleIds, opts).hits.map((h) => h.ruleId);
const hits = (text, file, ruleIds, opts) => sr.matchRules(text, file || '', ruleIds, opts);
const has = (list, id) => list.includes(id);

/* ============================================================
 * 一、规则表完整性
 * ============================================================ */
check('规则表 17 条（现有 12 + 新增 5）', sr.RULES.length === 17, sr.RULES.length);

{
  const ids = sr.RULES.map((r) => r.id);
  check('规则 id 唯一', new Set(ids).size === ids.length, ids);

  const missingFields = sr.RULES.filter(
    (r) => !r.id || !r.pack || !r.category || !r.severity || !r.title || !r.desc
  ).map((r) => r.id);
  check('每条规则必填字段齐全', missingFields.length === 0, missingFields);

  const badSev = sr.RULES.filter((r) => !sr.SEVERITIES.includes(r.severity)).map((r) => r.id);
  check('severity 只能是 high/medium/low', badSev.length === 0, badSev);

  const badPack = sr.RULES.filter((r) => !sr.PACKS.includes(r.pack)).map((r) => r.id);
  check('pack 只能是 audit/coverage', badPack.length === 0, badPack);

  const badCat = sr.RULES.filter((r) => !sr.CATEGORIES.includes(r.category)).map((r) => r.id);
  check('category 只能是 ui/secret/assert/coverage', badCat.length === 0, badCat);

  const noPattern = sr.RULES.filter((r) => !(r.pattern instanceof RegExp) && r.scope !== 'method').map((r) => r.id);
  check('每条规则都有 pattern 或走方法级扫描', noPattern.length === 0, noPattern);

  const notChinese = sr.RULES.filter((r) => !/[\u4e00-\u9fa5]/.test(r.title)).map((r) => r.id);
  check('标题都是中文', notChinese.length === 0, notChinese);
}

{
  // 新增的 5 条必须在表里（这是本轮的需求本体）
  const newIds = ['ui-fragile-locator', 'ui-text-locator', 'sec-intranet-ip', 'assert-truthy-only', 'assert-no-assertion'];
  const lost = newIds.filter((id) => !sr.ruleOf(id));
  check('新增 5 条规则都在表里', lost.length === 0, lost);
  check('新增规则 id 与契约一致', newIds.every((id) => sr.RULES.some((r) => r.id === id)), lost);
}

{
  check('SCAN_PACKS 两个包', sr.SCAN_PACKS.length === 2, sr.SCAN_PACKS.map((p) => p.id));
  const total = sr.SCAN_PACKS.reduce((n, p) => n + p.rules.length, 0);
  check('SCAN_PACKS 规则数合计 = 规则表条数', total === sr.RULES.length, { total, all: sr.RULES.length });
  check('rulesOf(audit) 只返回 audit', sr.rulesOf('audit').every((r) => r.pack === 'audit'), sr.rulesOf('audit'));
  check('rulesOf(coverage) 有 5 条取数规则', sr.rulesOf('coverage').length === 5, sr.rulesOf('coverage').length);
  check('rulesOf() 缺省返回全部', sr.rulesOf().length === sr.RULES.length, sr.rulesOf().length);
  check('CODE_ONLY_RULE_RE 常量正确', sr.CODE_ONLY_RULE_RE.test('ui-any') && sr.CODE_ONLY_RULE_RE.test('cov-any') && !sr.CODE_ONLY_RULE_RE.test('sec-any'));
  check('DOC_FILE_RE 只认 md/txt', sr.DOC_FILE_RE.test('README.md') && sr.DOC_FILE_RE.test('a.txt') && !sr.DOC_FILE_RE.test('a.java'));
}

/* ============================================================
 * 二、注释与字符串
 * ============================================================ */
check('注释里的 sleep 不报', !has(hitIds('// Thread.sleep(3000);', 'A.java'), 'ui-hard-sleep'), hitIds('// Thread.sleep(3000);', 'A.java'));
check('块注释里的口令不报', !has(hitIds('/* password = "abc123"; */', 'A.java'), 'sec-password-literal'));
check('代码行 + 行尾注释：代码照样报', has(hitIds('Thread.sleep(3000); // 这里等 3 秒', 'A.java'), 'ui-hard-sleep'));

{
  const out = sr.stripComments('String u = "https://a.com/x"; // 注释', 'A.java');
  check('stripComments 行数不变', out.length === 1, out.length);
  check('字符串里的 // 不被当注释截断', out[0].includes('"https://a.com/x"'), out[0]);
  check('行尾注释被抹掉', !out[0].includes('注释'), out[0]);
}

check('硬编码地址：字符串里的 URL 能报', has(hitIds('String u = "https://api.x.com/v1";', 'A.java'), 'sec-hardcoded-url'));
check('硬编码地址：example.com 不报', !has(hitIds('String u = "https://api.example.com/v1";', 'A.java'), 'sec-hardcoded-url'));
check('硬编码地址：localhost 不报', !has(hitIds('String u = "http://localhost:8080/api";', 'A.java'), 'sec-hardcoded-url'));

/* ============================================================
 * 三、每类规则的正例 / 反例
 * ============================================================ */
/* --- ui-* --- */
check('硬编码等待正例', has(hitIds('Thread.sleep(1000L * attempt);', 'A.java'), 'ui-hard-sleep'));
check('绝对 XPath 正例', has(hitIds('By.xpath("/html/body/div[1]/span");', 'A.java'), 'ui-abs-xpath'));
check('深层 CSS 正例（4 级以上）', has(hitIds('By.cssSelector("div > div > div > div > span");', 'A.java'), 'ui-deep-css'));
check('深层 CSS 反例（2 级）', !has(hitIds('By.cssSelector("div > div > span");', 'A.java'), 'ui-deep-css'));

check('按下标定位正例', has(hitIds('By.xpath("//ul/li[2]/span");', 'A.java'), 'ui-fragile-locator'));
check('按下标定位正例（nth-child）', has(hitIds('By.cssSelector(".list li:nth-child(2)");', 'A.java'), 'ui-fragile-locator'));
check('按下标定位反例（普通数组下标）', !has(hitIds('String[] args = new String[3];', 'A.java'), 'ui-fragile-locator'));
check('按下标定位反例（有 data-testid）', !has(hitIds('By.xpath("//div[@data-testid=\'row\'][2]");', 'A.java'), 'ui-fragile-locator'));

check('按文案定位正例（linkText）', has(hitIds('By.linkText("登录");', 'A.java'), 'ui-text-locator'));
check('按文案定位反例（普通 text 赋值）', !has(hitIds('String text = "登录";', 'A.java'), 'ui-text-locator'));

/* --- sec-* --- */
check('内网 IP 正例（192.168）', has(hitIds('String base = "http://192.168.1.10/api";', 'A.java'), 'sec-intranet-ip'));
check('内网 IP 正例（10 段）', has(hitIds('baseUrl = "http://10.2.3.4:8080";', 'A.java'), 'sec-intranet-ip'));
check('内网 IP 正例（172.16）', has(hitIds('host = 172.16.5.9;', 'A.java'), 'sec-intranet-ip'));
check('内网 IP 反例（127.0.0.1）', !has(hitIds('String u = "http://127.0.0.1:8080";', 'A.java'), 'sec-intranet-ip'));
check('内网 IP 反例（172.32 不是内网段）', !has(hitIds('host = 172.32.5.9;', 'A.java'), 'sec-intranet-ip'));

check('硬编码口令正例（correctPassword 形式）', has(hitIds('correctPassword = "admin123";', 'A.java'), 'sec-password-literal'));
check('硬编码令牌正例', has(hitIds('String token = "abcdefgh12345678";', 'A.java'), 'sec-token-literal'));

/* --- assert-* --- */
check('只判真假正例（assert 裸表达式）', has(hitIds('    assert resp', 'test_api.py'), 'assert-truthy-only'));
check('只判真假正例（toBeTruthy）', has(hitIds('expect(page.title()).toBeTruthy();', 'a.spec.ts'), 'assert-truthy-only'));
check('只判真假反例（有 == 比较）', !has(hitIds('assert resp == 200', 'test_api.py'), 'assert-truthy-only'));
check('只判真假反例（is not None）', !has(hitIds('assert resp is not None', 'test_api.py'), 'assert-truthy-only'));
check('只判真假反例（in 判断）', !has(hitIds('assert code in (0, 200)', 'test_api.py'), 'assert-truthy-only'));
check('只判真假反例（isinstance 多参数）', !has(hitIds('assert isinstance(x, int)', 'test_api.py'), 'assert-truthy-only'));
check('只判真假反例（json 取值比较）', !has(hitIds('assert resp.json()["code"] == 0', 'test_api.py'), 'assert-truthy-only'));
check('只判真假：裸表达式带分号也报', has(hitIds('    assert resp;', 'test_api.py'), 'assert-truthy-only'));

const javaNoAssert = [
  'public class T {',
  '  @Test',
  '  public void testA() {',
  '    api.call();',
  '  }',
  '  @Test',
  '  public void testB() {',
  '    assertEquals(1, 1);',
  '  }',
  '}'
].join('\n');
{
  const out = hits(javaNoAssert, 'T.java', ['assert-no-assertion']);
  check('断言缺失正例（Java 无断言方法）', out.hits.length === 1, out.hits.map((h) => h.snippet));
  check('断言缺失带方法名', out.hits[0] && out.hits[0].snippet.includes('testA'), out.hits[0]);
  check('断言缺失反例（有 assertEquals）', !out.hits.some((h) => h.snippet.includes('testB')), out.hits.map((h) => h.snippet));
}
const pyNoAssert = 'def test_a():\n    api.call()\n\ndef helper():\n    pass\n';
check('断言缺失正例（Python）', hits(pyNoAssert, 'test_x.py', ['assert-no-assertion']).hits.length === 1, hits(pyNoAssert, 'test_x.py', ['assert-no-assertion']).hits);
check('断言缺失反例（Python 有 assert）', hits('def test_a():\n    assert x == 1\n', 'test_x.py', ['assert-no-assertion']).hits.length === 0);

const javaStatusOnly = [
  'public class T {',
  '  @Test',
  '  public void t1() {',
  '    given().get("/x").then().statusCode(200);',
  '  }',
  '  @Test',
  '  public void t2() {',
  '    given().get("/x").then().statusCode(200).body("code", equalTo(0));',
  '  }',
  '}'
].join('\n');
{
  const out = hits(javaStatusOnly, 'T.java', ['assert-status-only']);
  check('只断言状态码正例', out.hits.length === 1 && out.hits[0].snippet.includes('t1'), out.hits.map((h) => h.snippet));
  check('只断言状态码反例（校验了 body）', !out.hits.some((h) => h.snippet.includes('t2')), out.hits.map((h) => h.snippet));
}

/* ============================================================
 * 四、文档：ui/assert/cov 不扫，sec 要扫
 * ============================================================ */
{
  const doc = [
    '# 测试规范',
    '不要写 div > div > div > div > span 这种选择器（说明文字，不是问题）',
    '代码里别写 Thread.sleep(3000)',
    '这条用例以前没有断言，后来补了',
    '示例路径 /api/v1/user 只是举例',
    '内网地址 http://192.168.1.10:8080/api 需要换掉',
    '值班机 10.8.9.10'
  ].join('\n');
  const ids = hitIds(doc, 'README.md');
  check('文档不报 ui-*', !ids.some((id) => id.startsWith('ui-')), ids);
  check('文档不报 assert-*', !ids.some((id) => id.startsWith('assert-')), ids);
  check('文档不报 cov-*', !ids.some((id) => id.startsWith('cov-')), ids);
  check('文档要报 sec-*（内网 IP）', ids.filter((id) => id === 'sec-intranet-ip').length >= 2, ids);
  check('文档里的 URL 不被 // 截断（能扫到内网 IP）', hitIds('见 http://192.168.1.10/x', 'README.md').includes('sec-intranet-ip'), 'not found');
}

/* ============================================================
 * 五、ruleIds 过滤
 * ============================================================ */
{
  const code = ['Thread.sleep(1000);', 'password = "abc123";', 'By.linkText("登录");'].join('\n');
  const only = hitIds(code, 'A.java', ['ui-hard-sleep']);
  check('ruleIds 过滤只留指定规则', only.length === 1 && only[0] === 'ui-hard-sleep', only);
  check('ruleIds 缺省 = 全部规则', hitIds(code, 'A.java').length >= 3, hitIds(code, 'A.java'));
  check('ruleIds 空数组 = 全部规则', hitIds(code, 'A.java', []).length >= 3, hitIds(code, 'A.java', []));
  check('ruleIds 老 id 兼容（sleep）', has(hitIds(code, 'A.java', ['sleep']), 'ui-hard-sleep'), hitIds(code, 'A.java', ['sleep']));
  check('ruleIds 未知 id 不报错', hitIds(code, 'A.java', ['not-exist']).length === 0, hitIds(code, 'A.java', ['not-exist']));
}

/* ============================================================
 * 六、每规则上限 3 条 + suppressed 计数
 * ============================================================ */
{
  const code = ['Thread.sleep(1);', 'Thread.sleep(2);', 'Thread.sleep(3);', 'Thread.sleep(4);', 'Thread.sleep(5);'].join('\n');
  const out = hits(code, 'A.java');
  check('每规则每文件最多 3 条', out.hits.filter((h) => h.ruleId === 'ui-hard-sleep').length === 3, out.hits.length);
  check('被抑制的条数回传（suppressed=2）', out.suppressed === 2, out.suppressed);
  check('上限不影响一文件里的其它规则', hits(code + '\npassword = "abc123";', 'A.java').suppressed === 2);
}

/* ============================================================
 * 七、snippet：原文 + 截断 200
 * ============================================================ */
{
  const longLine = '  Thread.sleep(3000); // ' + 'A'.repeat(400);
  const out = hits(longLine, 'A.java');
  const snip = out.hits[0] ? out.hits[0].snippet : '';
  check('snippet 截断到 200 字符', snip.length === 200, snip.length);
  check('snippet 取原文那行（保留行尾注释）', snip.includes('//') && snip.startsWith('Thread.sleep(3000);'), snip);
  check('snippet 不含其它行', out.hits[0] && !snip.includes('\n'), 'has newline');
}

/* ============================================================
 * 八、isInsideRoot（路径归属校验）
 * ============================================================ */
{
  const root = path.join(os.tmpdir(), 'scan-root-proj');
  const inside = path.join(root, 'src', 'A.java');
  const escape = path.join(root, '..', 'other', 'A.java');
  const sibling = path.join(os.tmpdir(), 'scan-root-proj-evil', 'A.java');
  check('isInsideRoot：内部路径通过', sr.isInsideRoot(root, inside) === true);
  check('isInsideRoot：根目录自身通过', sr.isInsideRoot(root, root) === true);
  check('isInsideRoot：.. 越界拒绝', sr.isInsideRoot(root, escape) === false, escape);
  check('isInsideRoot：同前缀兄弟目录拒绝', sr.isInsideRoot(path.join(os.tmpdir(), 'scan-root-proj'), sibling) === false, sibling);
  check('isInsideRoot：空参数拒绝', sr.isInsideRoot('', inside) === false && sr.isInsideRoot(root, '') === false);
}

/* ============================================================
 * 九、codescan.js 对外接口（ruleIds 支持 + 老签名不破）
 * ============================================================ */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-scan-'));
  fs.writeFileSync(
    path.join(tmp, 'A.java'),
    ['Thread.sleep(1000);', 'Thread.sleep(2000);', 'Thread.sleep(3000);', 'Thread.sleep(4000);', 'password = "abc123";'].join('\n'),
    'utf8'
  );

  const all = cs.scanHardcoded(tmp);
  check('scanHardcoded 不传 ruleIds 跑全部规则', all.issues.some((i) => i.ruleId === 'sec-password-literal') && all.issues.some((i) => i.ruleId === 'ui-hard-sleep'), all.issues.map((i) => i.ruleId));
  check('scanHardcoded 回传 suppressed', all.suppressed === 1, all.suppressed);
  check('scanHardcoded 回传截断原因', all.truncated === true && /未列出/.test(all.truncatedReason), all.truncatedReason);

  const onlySleep = cs.scanHardcoded(tmp, { ruleIds: ['ui-hard-sleep'] });
  check('scanHardcoded 支持 ruleIds', onlySleep.issues.every((i) => i.ruleId === 'ui-hard-sleep') && onlySleep.issues.length === 3, onlySleep.issues.map((i) => i.ruleId));
  check('scanHardcoded 的 rulesRun 是本次勾选', onlySleep.rulesRun.length === 1 && onlySleep.rulesRun[0] === 'ui-hard-sleep', onlySleep.rulesRun);

  const legacy = cs.scanHardcoded(tmp, { ruleIds: ['sleep'] });
  check('老规则 key 输出保持兼容', legacy.issues.every((i) => i.rule === 'sleep'), legacy.issues.map((i) => i.rule));

  // 覆盖取数：ruleIds 过滤生效
  fs.writeFileSync(path.join(tmp, 'B.java'), 'given().get("/api/v1/user");\n@GetMapping("/api/v1/order")\n', 'utf8');
  const covAll = cs.buildCoverage([], tmp);
  check('buildCoverage 老签名可用', covAll.ok === true && covAll.codePaths.length > 0, covAll.codePaths);
  const covOnly = cs.buildCoverage([], tmp, 'api', { ruleIds: ['cov-spring-mapping'] });
  check('buildCoverage 支持 ruleIds', covOnly.codePaths.every((p) => p.path === '/api/v1/order'), covOnly.codePaths.map((p) => p.path));

  // 文档不参与覆盖取数（示例路径不能当「已覆盖」证据）
  fs.writeFileSync(path.join(tmp, 'README.md'), '示例：/api/v1/doc-only 只是说明\n', 'utf8');
  const covDoc = cs.buildCoverage([], tmp);
  check('文档不参与覆盖取数', !covDoc.codePaths.some((p) => p.path === '/api/v1/doc-only'), covDoc.codePaths.map((p) => p.path));

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ============================================================
 * 十、IPC 通道（静态检查：handler 在 ipc-scan.js 里）
 * ============================================================ */
{
  const src = require('./_electron-src.cjs').readElectronSource();
  check('有 codescan:rules 通道', /handle\('codescan:rules'/.test(src), 'no rules ipc');
  check('codescan:hardcoded 透传 ruleIds', /codescan\.scanHardcoded\(dir, \{ ruleIds \}\)/.test(src), 'no ruleIds');
  check('codescan:coverage 透传 ruleIds', /buildCoverage\(items, dir, k, \{ ruleIds \}\)/.test(src), 'no ruleIds');
}

const failed = results.filter((r) => !r.ok);
console.log('===== 代码体检规则表测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);