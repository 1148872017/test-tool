/* v0.41.0：目录层级 / 复制格式 / 大数量导出 / JMeter 整合 / 三个 bug */
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const root = path.join(__dirname, '..');
const scanSrc = fs.readFileSync(path.join(root, 'src', 'pages', 'CodeScanPage.tsx'), 'utf8');
const setSrc = fs.readFileSync(path.join(root, 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
const envSrc = fs.readFileSync(path.join(root, 'src', 'components', 'EnvCard.tsx'), 'utf8');
const detailSrc = fs.readFileSync(path.join(root, 'src', 'components', 'RecordDetail.tsx'), 'utf8');
const dataSrc = fs.readFileSync(path.join(root, 'src', 'pages', 'DataTool.tsx'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(root, 'src', 'utils.ts'), 'utf8');
const mainSrc = require('./_electron-src.cjs').readElectronSource();
const preloadSrc = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');

/* ============================================================
 * Bug 1：代码体检「先切视图再请求」
 * ============================================================ */
for (const fn of ['doCoverage', 'doHardcoded', 'doDeps']) {
  const i = scanSrc.indexOf('const ' + fn);
  const seg = scanSrc.slice(i, i + 1200);
  const setViewIdx = seg.indexOf("setView('");
  const returnIdx = seg.indexOf('return;');
  check(`${fn}：setView 在提前 return 之前`, setViewIdx > 0 && setViewIdx < returnIdx, {
    setView: setViewIdx,
    ret: returnIdx
  });
}
check('失败时清空旧结果（coverage）', /setCov\(null\)/.test(scanSrc), 'no clear');
check('失败时清空旧结果（hardcoded）', /setScan\(null\)/.test(scanSrc), 'no clear');
check('失败时清空旧结果（deps）', /setDeps\(null\)/.test(scanSrc), 'no clear');

/* ============================================================
 * Bug 3：目录设置切页面不丢
 * ============================================================ */
{
  // useEffect 必须初始化所有目录字段
  const initMatch = /setCasesDir\(settings\.casesDir/.test(setSrc);
  check('useEffect 初始化 casesDir', initMatch);
  for (const f of ['workspaceDir', 'allureDir', 'projectDir', 'kbDir', 'notesDir', 'jmxDir', 'reportDir']) {
    const setter = 'set' + f.charAt(0).toUpperCase() + f.slice(1);
    check(`useEffect 初始化 ${f}`, new RegExp(setter + '\\(settings\\.' + f).test(setSrc), 'missing');
  }
  // 依赖数组要包含这些字段
  // 依赖数组：不能要求末尾逗号（最后一项通常没有）
  for (const f of ['workspaceDir', 'allureDir', 'projectDir']) {
    check(`useEffect 依赖含 ${f}`, new RegExp('settings\\.' + f + '[,) ]').test(setSrc), 'missing');
  }
  // 目录输入框改成 debounce 保存（不再依赖 onBlur）
  check('有 debounce 保存', /saveDirDebounced/.test(setSrc), 'no debounce');
  check('目录输入框用 debounce', /saveDirDebounced\('casesDir'/.test(setSrc), 'not used');
}

/* ============================================================
 * 优化 1：复制整条支持格式
 * ============================================================ */
check('有 copyFormat 状态', /copyFormat/.test(detailSrc), 'no state');
check('有三种格式选项', /整条详情/.test(detailSrc) && /JSON/.test(detailSrc) && /cURL/.test(detailSrc), 'missing');
check('有 copyAsFormat 函数', /copyAsFormat/.test(detailSrc), 'no fn');
check('复制 cURL 按钮已合并', !/复制 cURL\n          <\/Button>/.test(detailSrc), 'still separate');
check('Select 已导入', /import\s*\{[^}]*Select[^}]*\}\s*from\s*'antd'/.test(detailSrc), 'no import');

// recordToText 要美化账号
check('recordToText 有 fmtAccounts', /fmtAccounts/.test(utilsSrc), 'no fmt');
check('账号格式化成「账号 xxx 密码 yyy」', /账号 \$\{acc\}/.test(utilsSrc), 'no format');
check('recordToText 有 fmtVars', /fmtVars/.test(utilsSrc), 'no vars');

/* ============================================================
 * 优化 2：目录层级
 * ============================================================ */
check('有 1 级容器', /dir-level-1/.test(setSrc), 'no level1');
check('有 2 级容器', /dir-level-2/.test(setSrc), 'no level2');
check('有层级徽标', /dir-level-badge/.test(setSrc), 'no badge');
check('CSS 有层级样式', /\.dir-level-1/.test(fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')), 'no css');
check('7 个子目录都在', /dir-sub-row/.test(setSrc) && /项目代码/.test(setSrc), 'missing');

/* ============================================================
 * 优化 3：大数量走文件
 * ============================================================ */
check('有阈值常量', /LARGE_THRESHOLD\s*=\s*\d+/.test(dataSrc), 'no threshold');
check('有 generateToFile', /generateToFile/.test(dataSrc), 'no fn');
check('大数量走文件', /n > LARGE_THRESHOLD[\s\S]{0,1500}?generateToFile/.test(dataSrc), 'not used');
  check('大数量展示前 N 条', /PREVIEW_ROWS/.test(dataSrc), 'no preview');
check('没工作区时弹窗拦截', /needWorkspace/.test(dataSrc) && /Modal\.warning/.test(dataSrc), 'no modal');
check('有导出结果提示', /lastExport/.test(dataSrc), 'no result');
check('用了 shared/faker', /from '\.\.\/\.\.\/shared\/faker'/.test(dataSrc), 'not shared');
check('IPC 有 data:genFile', /ipcMain\.handle\('data:genFile'/.test(mainSrc), 'no ipc');
check('IPC 没工作区会提示', /needWorkspace: true/.test(mainSrc), 'no flag');
check('preload 有 dataGenFile', /dataGenFile:/.test(preloadSrc), 'no preload');

/* ============================================================
 * 优化 4：代码体检按钮 Tooltip
 * ============================================================ */
check('代码体检有 Tooltip', /<Tooltip/.test(scanSrc), 'no tooltip');
check('接口覆盖有提示', /真正调用了哪些接口/.test(scanSrc), 'no tip');
check('硬编码有提示', /密码\/Token\/URL 写死/.test(scanSrc), 'no tip');
check('依赖检查有提示', /pom\.xml/.test(scanSrc), 'no tip');

/* ============================================================
 * 优化 5：JMeter 整合
 * ============================================================ */
check('EnvCard 的 JMeter 行有选择按钮', /label="JMeter"[\s\S]{0,900}?选择…/.test(envSrc), 'no button');
check('设置页没有独立 JMeter 卡片', !/tool-card-title">\s*<DashboardOutlined \/> JMeter/.test(setSrc), 'still there');

/* ============================================================
 * 优化 6 + 后端：workspaceDir
 * ============================================================ */
check('DEFAULT_SETTINGS 有 workspaceDir', /workspaceDir: ''/.test(mainSrc), 'no default');
check('publicSettings 暴露 workspaceDir', /workspaceDir: settings\.workspaceDir/.test(mainSrc), 'not exposed');
check('allowed 含 workspaceDir', /'workspaceDir'/.test(mainSrc), 'not allowed');
check('工作区能推导子目录', /derive\('casesDir'/.test(mainSrc), 'no derive');
check('有 util:pickDir', /ipcMain\.handle\('util:pickDir'/.test(mainSrc), 'no ipc');
check('preload 有 pickDir', /pickDir:/.test(preloadSrc), 'no preload');

/* ============================================================
 * shared/faker 本身
 * ============================================================ */
{
  const faker = require('../shared/faker.js');
  check('faker 有 14 种类型', faker.TYPES.length === 14, faker.TYPES.length);
  check('faker 能生成姓名', typeof faker.genOne('name') === 'string' && faker.genOne('name').length >= 2, 'bad');
  check('faker 能生成手机号', /^1\d{10}$/.test(faker.genOne('phone')), faker.genOne('phone'));
  check('faker 能生成身份证', /^\d{17}[\dX]$/.test(faker.genOne('idcard')), 'bad');

  const d = faker.genDate('2026-01-01', '2026-12-31');
  check('日期在范围内', d.startsWith('2026-'), d);

  const rows = faker.genRows([{ name: 'a', type: 'name' }, { name: 'b', type: 'phone' }], 3);
  check('多字段 3 行 2 列', rows.length === 3 && rows[0].length === 2, rows);

  const csv = faker.toCsv(['A', 'B'], [['1', '2']]);
  check('CSV 有 BOM', csv.charCodeAt(0) === 0xfeff, 'no bom');
  check('CSV 有表头', csv.includes('A,B'), 'no header');

  const json = faker.toJson(['A'], [['1']]);
  const parsed = JSON.parse(json);
  check('JSON 是对象数组', Array.isArray(parsed) && parsed[0].A === '1', parsed);
}

const failed = results.filter((r) => !r.ok);
console.log('===== v0.41.0 测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);