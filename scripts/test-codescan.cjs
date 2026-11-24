/* 代码体检：覆盖矩阵 + 硬编码扫描 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const cs = require('../electron/codescan.js');

/* ---------- 1. 路径归一化 ---------- */
check('归一化：去协议域名', cs.normalizePath('https://api.x.com/v1/user') === '/v1/user', cs.normalizePath('https://api.x.com/v1/user'));
check('归一化：去查询参数', cs.normalizePath('/api/user?id=1') === '/api/user', cs.normalizePath('/api/user?id=1'));
check('归一化：去末尾斜杠', cs.normalizePath('/api/user/') === '/api/user', cs.normalizePath('/api/user/'));
check('归一化：补前导斜杠', cs.normalizePath('api/user') === '/api/user', cs.normalizePath('api/user'));
check('归一化：太短返回空', cs.normalizePath('/a') === '', cs.normalizePath('/a'));
check('归一化：空返回空', cs.normalizePath('') === '', cs.normalizePath(''));

/* ---------- 2. 路径匹配 ---------- */
check('匹配：完全相同', cs.pathMatches('/api/user', '/api/user') === true);
check('匹配：占位符', cs.pathMatches('/api/user/123', '/api/user/{id}') === true);
check('匹配：后缀', cs.pathMatches('/v1/user', '/api/v1/user') === true);
check('不匹配：不同路径', cs.pathMatches('/api/a', '/api/b') === false);

/* ---------- 3. 路径提取 ---------- */
const code1 = `
  given().get("/api/v1/user");
  requests.post("http://x.com/api/login");
  page.goto("/login");
`;
const paths1 = cs.extractPaths(code1);
check('提取：.get 字面量', paths1.includes('/api/v1/user'), paths1);
check('提取：requests.post', paths1.includes('/api/login'), paths1);
check('提取：page.goto', paths1.includes('/login'), paths1);

// 常量引用
const code2 = `
  private static final String LOGIN_PATH = "/api/login";
  given().post(LOGIN_PATH);
`;
const paths2 = cs.extractPaths(code2);
check('提取：常量引用', paths2.includes('/api/login'), paths2);

/* ---------- 4. 覆盖矩阵（真实项目）---------- */
const realProj = 'D:/AI_Workspace/Project/example';
if (fs.existsSync(realProj)) {
  const apis = [
    { id: '1', title: '登录', data: { method: 'POST', url: '/api/login', module: '认证' } },
    { id: '2', title: '不存在', data: { method: 'GET', url: '/api/not-exist', module: '测试' } }
  ];
  const cov = cs.buildCoverage(apis, realProj);
  check('覆盖：扫描成功', cov.ok === true, cov.message);
  check('覆盖：扫到文件', cov.scannedFiles > 0, cov.scannedFiles);
  check('覆盖：/api/login 已覆盖', cov.coveredList.some((c) => c.url === '/api/login'), cov.coveredList.map((c) => c.url));
  check('覆盖：/api/not-exist 未覆盖', cov.uncovered.some((u) => u.url === '/api/not-exist'), cov.uncovered.map((u) => u.url));
} else {
  console.log('（跳过真实项目测试）');
}

/* ---------- 5. 硬编码扫描（真实项目）---------- */
if (fs.existsSync(realProj)) {
  const scan = cs.scanHardcoded(realProj);
  check('硬编码：扫描成功', scan.ok === true, scan.message);
  check('硬编码：扫到文件', scan.scannedFiles > 0, scan.scannedFiles);
  check('硬编码：发现高危（密码）', scan.summary.high > 0, scan.summary);
  check('硬编码：发现中危（sleep）', scan.summary.medium > 0, scan.summary);
  check('硬编码：问题有 file/line', scan.issues.length > 0 && !!scan.issues[0].file && scan.issues[0].line > 0, scan.issues[0]);
  check('硬编码：按严重程度排序', scan.issues[0].severity === 'high', scan.issues[0].severity);
} else {
  console.log('（跳过真实项目测试）');
}

/* ---------- 6. 造数据测规则 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
const testFile = path.join(tmp, 'Test.java');
fs.writeFileSync(
  testFile,
  [
    'public class Test {',
    '  String password = "secret123";',           // high
    '  String token = "abcdefgh12345678";',        // high
    '  String url = "https://api.example.com";',   // 跳过（example.com）
    '  Thread.sleep(3000);',                       // medium
    '  By.xpath("/html/body/div[1]/span");',       // low
    '  // password = "commented";',                // 跳过（注释）
    '}'
  ].join('\n'),
  'utf8'
);

const scan2 = cs.scanHardcoded(tmp);
check('规则：发现密码', scan2.issues.some((i) => i.rule === 'hardcoded-password'), scan2.issues.map((i) => i.rule));
check('规则：发现 token', scan2.issues.some((i) => i.rule === 'hardcoded-token'), scan2.issues.map((i) => i.rule));
check('规则：发现 sleep', scan2.issues.some((i) => i.rule === 'sleep'), scan2.issues.map((i) => i.rule));
check('规则：发现绝对 XPath', scan2.issues.some((i) => i.rule === 'absolute-xpath'), scan2.issues.map((i) => i.rule));
check('规则：跳过 example.com', !scan2.issues.some((i) => i.rule === 'hardcoded-url'), scan2.issues.map((i) => i.rule));
check('规则：跳过注释行', !scan2.issues.some((i) => i.snippet.includes('commented')), scan2.issues.map((i) => i.snippet));

fs.rmSync(tmp, { recursive: true, force: true });

/* ---------- 7. 边界 ---------- */
check('空目录报错', cs.scanHardcoded('').ok === false);
check('不存在目录报错', cs.scanHardcoded('D:/nonexistent-xyz').ok === false);
check('覆盖：空目录报错', cs.buildCoverage([], '').ok === false);

/* ---------- 8. IPC ---------- */
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
check('有 codescan:coverage', /ipcMain\.handle\('codescan:coverage'/.test(mainSrc), 'no coverage');
check('有 codescan:hardcoded', /ipcMain\.handle\('codescan:hardcoded'/.test(mainSrc), 'no hardcoded');
check('有 codescan:pickDir', /ipcMain\.handle\('codescan:pickDir'/.test(mainSrc), 'no pickDir');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
check('preload 有 codescanCoverage', /codescanCoverage:/.test(preloadSrc), 'no coverage');
check('preload 有 codescanHardcoded', /codescanHardcoded:/.test(preloadSrc), 'no hardcoded');

/* ---------- 9. 前端 ---------- */
const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'CodeScanPage.tsx'), 'utf8');
check('页面有覆盖矩阵', /doCoverage/.test(pageSrc), 'no coverage');
check('页面有硬编码检查', /doHardcoded/.test(pageSrc), 'no hardcoded');
check('页面有覆盖率进度条', /Progress/.test(pageSrc), 'no progress');
check('页面有严重程度筛选', /sevFilter/.test(pageSrc), 'no filter');

/* ---------- 10. 侧栏 ---------- */
const collections = require('../shared/collections.js');
check('TOOLS 有代码体检', collections.TOOLS.some((t) => t.key === 'codescan'), collections.TOOLS.map((t) => t.key));
check('TOOLS 有 group 字段', collections.TOOLS.every((t) => !!t.group), collections.TOOLS.map((t) => t.group));
check('TOOLS 自动化组有 4 个', collections.TOOLS.filter((t) => t.group === '自动化').length === 4, collections.TOOLS.filter((t) => t.group === '自动化').length);
check('TOOLS 辅助组有 3 个', collections.TOOLS.filter((t) => t.group === '辅助').length === 3, collections.TOOLS.filter((t) => t.group === '辅助').length);
check('COLLECTIONS 用「资产」分组', collections.COLLECTIONS.every((c) => c.group === '资产'), collections.COLLECTIONS.map((c) => c.group));

const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8');
check('侧栏有 4 个分组', (sidebarSrc.match(/label: '/g) || []).length === 4, (sidebarSrc.match(/label: '/g) || []).length);
check('侧栏有「资产」', /label: '资产'/.test(sidebarSrc), 'no 资产');
check('侧栏有「索引」', /label: '索引'/.test(sidebarSrc), 'no 索引');
check('侧栏有「自动化」', /label: '自动化'/.test(sidebarSrc), 'no 自动化');
check('侧栏有「辅助」', /label: '辅助'/.test(sidebarSrc), 'no 辅助');

const failed = results.filter((r) => !r.ok);
console.log('===== 代码体检测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
