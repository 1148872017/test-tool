'use strict';
/**
 * 发布链路防线（P0-4）：asar 真实加载 + 「安装包 = 当前源码」
 *
 * 为什么必须有这个脚本（踩坑 #1 / #34.1 / v0.16 启动崩溃换来的）：
 *   `node_modules` 里有 ≠ asar 里有 ≠ 用户机器上能跑。
 *   electron-builder 只收 dependencies，间接依赖（@xmldom/xmldom、ejs）曾经没进包，
 *   用户装完一点就 `Cannot find module`，而本地 3833 项测试全绿。
 *   所以验收只认一件事：**用 Electron 本体从 asar 里真实 require 并跑一遍逻辑**。
 *
 * 两条纪律：
 *   1. 产物不在就输出「无法验证」并 exit 2 —— 不许把「没测」当成「通过」（假绿）。
 *   2. 「安装包 = 当前源码」用 **sha512 比内容**，不比时间戳。
 *      asar 格式本身不存 mtime；安装包 exe 的 mtime 只能说明「打包那一刻」，
 *      早于 dist/app.js 说明包是旧的，晚于也不代表内容一致（可能是别的源码打的）。
 *
 * 用法（必须用 Electron 本体跑，普通 node 不支持 asar 路径）：
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & ".\node_modules\electron\dist\electron.exe" scripts\verify-asar.cjs
 *
 * 退出码：0 = PASS / 1 = FAIL / 2 = 无法验证（工具链或产物缺失，绝不假绿）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ASAR_REL = 'release/win-unpacked/resources/app.asar';
const ASAR_PATH = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');

/** 包内路径 → 可 require 的绝对路径（Electron 的 fs 认 asar 路径） */
const A = (p) => path.join(ASAR_PATH, p.split('/').join(path.sep));

/**
 * 包内路径 → extractFile 的参数。
 *
 * 注意（实测踩到）：`@electron/asar` 3.4.1 的 getNode 用 `path.dirname/basename`，
 * 内部再按 `path.sep` 切分目录层级。Windows 上 path.sep 是 `\`，
 * 所以传 `electron/ipc/x.js`（正斜杠）会报 "was not found in this archive"，
 * 而 `dist/app.js` 这种只有两级、dirname 是 `dist` 的都恰好能过 —— 极易误判成「包里真没这个文件」。
 * 统一转成平台分隔符再传。
 */
const asarFileArg = (rel) => rel.split('/').join(path.sep);

const results = [];

/**
 * 记录一条断言。
 * fn 可以返回 Promise —— 必须 await 之后再判定，否则 Promise 是 truthy，
 * 「没跑完的断言」会被当成通过（这就是假绿）。
 */
async function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    if (typeof r === 'string') {
      ok = false;
      detail = r;
    } else if (r === false) {
      ok = false;
    } else {
      ok = true;
    }
  } catch (e) {
    ok = false;
    detail = (e && e.message) || String(e);
  }
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : detail ? '  -> ' + detail : ''));
  return ok;
}

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex');
const short = (hex) => String(hex).slice(0, 16);
const mtimeOf = (f) => {
  try {
    return fs.statSync(f).mtime.toISOString();
  } catch (e) {
    return '(不存在)';
  }
};
const relPath = (p) => p.split('/').join(path.sep);

/** 输出「无法验证」并以 exit 2 结束 —— 这是本脚本最重要的分支，别改成假绿 */
function cannotVerify(reasons, hint) {
  console.log('');
  console.log('===== 无法验证（CANNOT VERIFY，不算通过）=====');
  for (const r of reasons) console.log('  - ' + r);
  if (hint) {
    console.log('');
    console.log(hint);
  }
  console.log('');
  console.log('RESULT: CANNOT VERIFY（无法验证）');
  process.exit(2);
}

/** 收集 release/ 的现状，作为「无法验证」的证据（别让人以为脚本自己坏了） */
function releaseEvidence() {
  const lines = [];
  const relDir = path.join(ROOT, 'release');
  lines.push('release/win-unpacked 是否存在：' + (fs.existsSync(path.join(relDir, 'win-unpacked')) ? '是' : '否'));
  const appJs = path.join(ROOT, 'dist', 'app.js');
  lines.push(
    '本地 dist/app.js mtime：' +
      mtimeOf(appJs) +
      '（' +
      (fs.existsSync(appJs) ? fs.statSync(appJs).size + ' 字节' : '缺失') +
      '）'
  );
  try {
    const setups = fs
      .readdirSync(relDir)
      .filter((f) => /^test-tool-Setup-.*\.exe$/.test(f))
      .map((f) => f + '  mtime ' + mtimeOf(path.join(relDir, f)));
    if (setups.length) for (const s of setups) lines.push('安装包：' + s);
    else lines.push('release/ 里没有任何 test-tool-Setup-*.exe');
  } catch (e) {
    lines.push('release/ 目录读取失败：' + e.message);
  }
  return lines;
}

async function main() {
  console.log('===== asar 真实加载验证（发布链路 P0-4）=====');
  console.log('  asar: ' + ASAR_REL);
  console.log('  node: ' + process.version + ' / electron: ' + (process.versions.electron || '（无，不是 Electron 环境）'));

  /* ---------- 门 1：产物在不在 ---------- */
  if (!fs.existsSync(ASAR_PATH)) {
    cannotVerify(
      ['找不到 ' + ASAR_REL + ' —— 还没打出 win-unpacked，asar 无从验证。'].concat(releaseEvidence()),
      [
        '先打一次 --dir 包（NSIS 在沙箱里内存不够，--dir 可以）：',
        '  $env:ELECTRON_BUILDER_CACHE="D:\\AI_Workspace\\_scratch\\2026-10-28\\builder-cache"',
        '  $env:ELECTRON_CACHE="D:\\AI_Workspace\\_scratch\\2026-10-28\\electron-cache"',
        '  $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"',
        '  node node_modules\\electron-builder\\cli.js --dir --x64',
        '打完再跑本脚本。'
      ].join('\n')
    );
  }

  /* ---------- 门 2：是不是 Electron 环境（普通 node 读不了 asar）---------- */
  const isElectronNode = !!process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1';
  if (!isElectronNode) {
    cannotVerify(
      [
        '当前不是 ELECTRON_RUN_AS_NODE 环境（process.versions.electron=' + (process.versions.electron || 'undefined') + '）。',
        '普通 node 不支持 asar 路径，真实 require 跑不了 —— 这一段不能用「查字符串」代替。'
      ].concat(releaseEvidence()),
      '正确用法：\n  $env:ELECTRON_RUN_AS_NODE="1"\n  & ".\\node_modules\\electron\\dist\\electron.exe" scripts\\verify-asar.cjs'
    );
  }

  const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
  const entries = asar.listPackage(ASAR_PATH).map((x) => x.split('\\').join('/'));
  const entrySet = new Set(entries);
  console.log('  包内条目：' + entries.length);

  /* ---------- 1. 包结构 ---------- */
  console.log('');
  console.log('--- 1. 包结构（该在的在、该排除的排除）---');

  await check('asar 有内容（条目数 > 100）', () => (entries.length > 100 ? true : '条目只有 ' + entries.length));
  await check('dist/preview 已排除（v0.43 的坑：预览 mock 打进安装包）', () => {
    const bad = entries.filter((x) => x.indexOf('/dist/preview/') >= 0);
    return bad.length === 0 ? true : '还有 ' + bad.length + ' 条：' + bad.slice(0, 3).join(', ');
  });
  await check('scripts/ 不在包里（开发工具不该进用户机器）', () => {
    const bad = entries.filter((x) => /(^|\/)scripts\//.test(x));
    return bad.length === 0 ? true : '还有 ' + bad.length + ' 条：' + bad.slice(0, 3).join(', ');
  });
  await check('electron/ipc/*.js 全部在包里', () => {
    const local = fs.readdirSync(path.join(ROOT, 'electron', 'ipc')).filter((f) => /\.js$/.test(f));
    const missing = local.filter((f) => !entrySet.has('/electron/ipc/' + f));
    return missing.length === 0 ? true : '缺 ' + missing.join(', ');
  });

  /* 生产依赖：electron-builder 只收 dependencies，间接依赖会整块漏掉（踩坑 #1 / #34.1） */
  const PROD_DEPS = [
    'node_modules/sql.js/package.json',
    'node_modules/sql.js/dist/sql-wasm.wasm',
    'node_modules/ejs/package.json',
    'node_modules/js-yaml/package.json',
    'node_modules/@xmldom/xmldom/package.json'
  ];
  for (const dep of PROD_DEPS) {
    await check('包内有 ' + dep, () => (entrySet.has('/' + dep) ? true : '缺这个文件'));
  }

  /* ---------- 2. 安装包 = 当前源码（sha512）----------- */
  console.log('');
  console.log('--- 2. 安装包 = 当前源码（sha512 逐字节比对，不看时间戳）---');

  const HEADLINE = ['dist/app.js', 'dist/styles.css', 'electron/main.js', 'shared/collections.js'];
  const mismatch = Object.create(null);
  for (const rel of HEADLINE) {
    let packedHash;
    let localHash;
    try {
      packedHash = sha512(asar.extractFile(ASAR_PATH, asarFileArg(rel)));
    } catch (e) {
      packedHash = 'EXTRACT_FAILED:' + e.message;
    }
    try {
      localHash = sha512(fs.readFileSync(path.join(ROOT, relPath(rel))));
    } catch (e) {
      localHash = 'READ_FAILED:' + e.message;
    }
    mismatch[rel] = packedHash !== localHash;
    console.log('  ' + (packedHash === localHash ? '= ' : '≠ ') + rel.padEnd(22) + ' 本地 ' + short(localHash) + ' / 包内 ' + short(packedHash));
  }

  await check('dist/app.js 与本地构建一致（安装包 = 当前源码）', () =>
    mismatch['dist/app.js'] ? 'sha512 不一致 —— 安装包不是用当前 dist/app.js 打的，必须重打' : true
  );
  await check('dist/styles.css 与本地构建一致', () => (mismatch['dist/styles.css'] ? 'sha512 不一致' : true));
  await check('electron/main.js 与本地源码一致', () => (mismatch['electron/main.js'] ? 'sha512 不一致' : true));
  await check('shared/collections.js 与本地源码一致', () => (mismatch['shared/collections.js'] ? 'sha512 不一致' : true));

  /* 全量比对：electron/ + shared/ + dist 顶层 + package.json 逐文件 sha512 */
  const manifest = [];
  const walk = (relDir) => {
    const abs = path.join(ROOT, relPath(relDir));
    for (const name of fs.readdirSync(abs)) {
      const rel = relDir + '/' + name;
      const absChild = path.join(abs, name);
      if (fs.statSync(absChild).isDirectory()) walk(rel);
      else manifest.push(rel);
    }
  };
  walk('electron');
  walk('shared');
  for (const f of fs.readdirSync(path.join(ROOT, 'dist'))) {
    if (fs.statSync(path.join(ROOT, 'dist', f)).isFile()) manifest.push('dist/' + f);
  }
  /* package.json 不进逐字节比对：electron-builder 会剥掉 scripts / devDependencies / build，
     这是它正常的行为。改成语义比对（见下面那条 name/version/main/dependencies） */
  manifest.push('package.json');

  await check('包内 electron/ + shared/ + dist/ 逐文件一致（' + (manifest.length - 1) + ' 个）', () => {
    const bad = [];
    for (const rel of manifest) {
      if (rel === 'package.json') continue; // 单独做语义比对
      let packed;
      try {
        packed = asar.extractFile(ASAR_PATH, asarFileArg(rel));
      } catch (e) {
        bad.push(rel + '(包里没有)');
        continue;
      }
      const local = fs.readFileSync(path.join(ROOT, relPath(rel)));
      if (sha512(packed) !== sha512(local)) bad.push(rel + '(内容不同)');
    }
    return bad.length === 0 ? true : '不一致 ' + bad.length + ' 个：' + bad.slice(0, 8).join(', ');
  });

  /* 时间戳只作为参考线索打印，不参与判定 */
  const installer = fs
    .readdirSync(path.join(ROOT, 'release'))
    .filter((f) => /^test-tool-Setup-.*\.exe$/.test(f))
    .sort()
    .pop();
  if (installer) {
    console.log('  [参考] 最新安装包 ' + installer + ' mtime ' + mtimeOf(path.join(ROOT, 'release', installer)));
    console.log('  [参考] 本地 dist/app.js   mtime ' + mtimeOf(path.join(ROOT, 'dist', 'app.js')));
    console.log('  [参考] 时间戳只说明打包时刻，内容是否一致以上面的 sha512 为准。');
  }

  /* ---------- 3. 生产包内容（防 mock / 重复 import 回归）----------- */
  console.log('');
  console.log('--- 3. 生产包内容（防回归）---');

  const appJs = asar.extractFile(ASAR_PATH, asarFileArg('dist/app.js'));
  const appText = appJs.toString('utf8');

  await check('无 mock 痕迹（installMockIfNeeded / Admin@123 不在包里）', () => {
    const hits = [];
    if (appText.indexOf('installMockIfNeeded') >= 0) hits.push('installMockIfNeeded');
    if (appText.indexOf('Admin@123') >= 0) hits.push('Admin@123');
    return hits.length === 0 ? true : '打进来了：' + hits.join(', ');
  });
  await check('antd 里没有假导出的 ReloadOutlined（v0.50 修过的重复 import）', () =>
    /from\s*["']antd["'][^;]{0,200}ReloadOutlined/.test(appText) ? '又出现「从 antd 导入 ReloadOutlined」' : true
  );
  await check('dist/app.js 体积像样（> 3 MB，别是半截产物）', () =>
    appJs.length > 3 * 1024 * 1024 ? true : appJs.length + ' 字节，太小了'
  );

  /* ---------- 4. 真实加载（只有这一步能证明「打包后能跑」）----------- */
  console.log('');
  console.log('--- 4. 从 asar 里真实 require 并跑一遍 ---');

  await check('shared/locatorModes.js 可 require，9 种定位方式', () => {
    const lm = require(A('shared/locatorModes.js'));
    return lm.LOCATOR_MODES && lm.LOCATOR_MODES.length === 9 ? true : '定位方式 ' + (lm.LOCATOR_MODES || []).length + ' 种';
  });
  await check('shared/uiActions.js 可 require，17 个 UI 动作', () => {
    const ua = require(A('shared/uiActions.js'));
    return ua.UI_ACTIONS && ua.UI_ACTIONS.length === 17 ? true : '动作 ' + (ua.UI_ACTIONS || []).length + ' 个';
  });
  await check('shared/apiActions.js 可 require，7 动作 / 4 分类', () => {
    const aa = require(A('shared/apiActions.js'));
    if (!aa.API_ACTIONS || aa.API_ACTIONS.length !== 7) return '动作 ' + (aa.API_ACTIONS || []).length + ' 个';
    const cats = new Set(aa.API_ACTIONS.map((x) => x.category));
    return cats.size === 4 ? true : '分类 ' + cats.size + ' 个';
  });
  await check('shared/collections.js 可 require，6 集合 + 8 工具', () => {
    const col = require(A('shared/collections.js'));
    if (col.COLLECTIONS.length !== 6) return '集合 ' + col.COLLECTIONS.length + ' 个';
    if (col.TOOLS.length !== 8) return '工具 ' + col.TOOLS.length + ' 个';
    return true;
  });
  await check('shared/apiFlowGen.js 可 require，并生成 Java 链路代码', () => {
    const g = require(A('shared/apiFlowGen.js'));
    const r = g.generateApiFlow({
      steps: [
        {
          actionId: 'call',
          params: {
            apiId: 'a1',
            as: 'loginResp',
            apiName: '登录',
            method: 'POST',
            path: '/api/login',
            headers: [],
            body: '{}'
          }
        }
      ],
      lang: 'java'
    });
    if (!/given\(\)/.test(r.code)) return '生成的代码里没有 given()';
    if (!/\.extract\(\)\.response\(\)/.test(r.code)) return '生成的代码里没有 extract().response()';
    return true;
  });
  await check('shared/codegen.js 可 require（ejs 真在包里，v0.34.1 事故），并生成 REST Assured 代码', () => {
    const cg = require(A('shared/codegen.js'));
    const out = cg.generate('java-restassured', {
      api: {
        name: '新建宠物',
        method: 'POST',
        url: '/pet',
        module: '宠物',
        paramTable: JSON.stringify([
          { in: 'query', name: 'page', type: 'integer', required: false, example: '1', desc: '' }
        ]),
        body: 'name=Kitty',
        bodyType: 'x-www-form-urlencoded'
      }
    });
    if (!out || out.ok !== true) return '生成失败：' + ((out && out.message) || '无返回');
    if (!/public class /.test(out.code)) return '生成的 Java 里没有 class';
    return true;
  });
  await check('electron/jmx.js 可 require（@xmldom/xmldom 真在包里，v0.16 事故），并能解析 jmx', () => {
    const jmx = require(A('electron/jmx.js'));
    /* 根节点必须叫 jmeterTestPlan，parseJmx 是按 tagName 判的（写成 jmxTestPlan 会被当坏文件） */
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.4.3"><hashTree>' +
      '<TestPlan guiclass="TestPlanGui" testname="冒烟计划" enabled="true"/>' +
      '<hashTree><ThreadGroup guiclass="ThreadGroupGui" testname="线程组" enabled="true">' +
      '<stringProp name="ThreadGroup.num_threads">5</stringProp>' +
      '<stringProp name="ThreadGroup.ramp_time">1</stringProp>' +
      '</ThreadGroup><hashTree/></hashTree>' +
      '</hashTree></jmeterTestPlan>';
    const parsed = jmx.parseJmx(xml, 'smoke.jmx');
    if (!parsed) return 'parseJmx 返回空';
    if (parsed.parseError) return '解析失败：' + parsed.parseError;
    if (parsed.testPlanName !== '冒烟计划') return 'testPlanName=' + JSON.stringify(parsed.testPlanName);
    if (!parsed.threadGroups || parsed.threadGroups.length !== 1) return '线程组 ' + ((parsed.threadGroups || []).length) + ' 个';
    return true;
  });
  await check('node_modules/sql.js 可 require，并用包内 wasm 真跑一条 SQL', async () => {
    const initSqlJs = require(A('node_modules/sql.js'));
    if (typeof initSqlJs !== 'function') return 'sql.js 入口不是 initSqlJs 函数';
    const SQL = await initSqlJs({ locateFile: (f) => A('node_modules/sql.js/dist/' + f) });
    const db = new SQL.Database();
    db.run('CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (42);');
    const v = db.exec('SELECT a FROM t')[0].values[0][0];
    db.close();
    return v === 42 ? true : '查出来是 ' + v;
  });
  await check('包内 package.json 的 name/version/main/dependencies 与本地一致', () => {
    const inPkg = JSON.parse(asar.extractFile(ASAR_PATH, asarFileArg('package.json')).toString('utf8'));
    const localPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    /* electron-builder 会剥掉 scripts / devDependencies / build —— 这些不一致是正常的，不参与判定 */
    if (inPkg.name !== localPkg.name) return 'name 包内 ' + inPkg.name + ' / 本地 ' + localPkg.name;
    if (inPkg.version !== localPkg.version) return 'version 包内 ' + inPkg.version + ' / 本地 ' + localPkg.version;
    if (inPkg.main !== localPkg.main) return 'main 包内 ' + inPkg.main + ' / 本地 ' + localPkg.main;
    const inDeps = inPkg.dependencies || {};
    const localDeps = localPkg.dependencies || {};
    const keys = Object.keys(localDeps);
    const missing = keys.filter((k) => !inDeps[k]);
    if (missing.length) return '依赖漏了：' + missing.join(', ');
    const diff = keys.filter((k) => inDeps[k] !== localDeps[k]);
    if (diff.length) return '依赖版本不一致：' + diff.map((k) => k + ' ' + inDeps[k] + '≠' + localDeps[k]).join(', ');
    return true;
  });
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.log('');
    console.log('脚本异常：' + ((e && e.stack) || e));
    results.push({ name: '脚本自身抛异常', ok: false, detail: String(e && e.message) });
  }
  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log('失败项：');
    for (const r of failed) console.log('  - ' + r.name + (r.detail ? '  -> ' + r.detail : ''));
  }
  const total = results.length;
  const passed = total - failed.length;
  console.log('===== 汇总：' + passed + '/' + total + ' passed' + (failed.length ? '，' + failed.length + ' 项失败' : '') + ' =====');
  console.log('RESULT: ' + (failed.length || !total ? 'FAIL' : 'PASS'));
  process.exit(failed.length || !total ? 1 : 0);
})();