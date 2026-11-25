/**
 * test-guard-paths.cjs —— 路径守卫总表测试（v0.51.0）
 *
 * 这一套守的是**同一个 P0**：
 *   ipc-guard.js 的包装层里曾经有 rememberIfScan() —— 只要通道名以 :scan 结尾，
 *   就把 payload.root 无条件记成本会话可信根（root 完全没校验）。
 *   渲染进程传一次 root='C:\' 就能把全盘登记进来，之后每一处 assertPathIn 全部失效。
 *
 * 现在验四件事：
 *   1. 扫描种子校验（assertScanRoot / acceptScanRoot / rememberRoot）本身行为正确；
 *   2. 7 个 *:scan 通道：盘符根 / 系统目录 → OUTSIDE_ROOT 且**不被登记**；
 *      任意业务目录 → 照常能扫，且被登记（保住「零配置」底线）；
 *   3. 带 file/dir 入参的通道：越界一律 OUTSIDE_ROOT（表驱动，见 ipc-guard.js 的
 *      PATH_PARAM_CHANNELS —— 那张表是全仓唯一事实源，新通道忘了登记这条会红）；
 *   4. 守卫层不再碰会话白名单（真造一个 ipcMain 走一遍 createHandle）。
 *
 * 全是行为断言 + 一处源码结构断言，不依赖本机真实资产（只用 os.tmpdir()）。
 *
 * 注：这份文件在 2026-11-25 曾因 PowerShell 文本管道（Get-Content|Set-Content）
 * 被按 GBK 重写而损坏，已整体重写。改这个仓库的中文文件请用 edit/write 工具，
 * 不要用 PowerShell 读写管道——那会把 UTF-8 三字节字符和后面的换行一起吃掉。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-guard-'));
process.env.TT_DATA_DIR = tmp;
process.env.TT_NO_DEMO = '1';

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 0. stub electron + 真加载 main.js（守卫要真行为，不是读源码）
 * ============================================================ */
const handlers = {};
const openedPaths = [];

const fakeElectron = {
  app: {
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getPath(p) {
      if (p === 'temp') return path.join(tmp, 'temp');
      if (p === 'appData') return path.join(tmp, 'appData');
      return path.join(tmp, p);
    },
    requestSingleInstanceLock() {
      return true;
    },
    on() {},
    once() {},
    whenReady() {
      return Promise.resolve();
    },
    quit() {},
    getVersion() {
      return '0.51.0';
    },
    commandLine: { appendSwitch() {} }
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        send() {},
        on() {},
        toggleDevTools() {},
        setWindowOpenHandler(fn) {
          handlers.__windowOpenHandler = fn;
        }
      };
    }
    loadFile() {
      return Promise.resolve();
    }
    once() {}
    on() {}
    show() {}
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
  },
  ipcMain: {
    handle(channel, fn) {
      if (handlers[channel] && channel.indexOf('__') !== 0) {
        throw new Error("Attempted to register a second handler for '" + channel + "'");
      }
      handlers[channel] = fn;
    }
  },
  clipboard: { writeText() {}, readText: () => '', clear() {} },
  shell: {
    openExternal: async () => true,
    openPath: async (p) => {
      openedPaths.push(p);
      return '';
    },
    showItemInFolder() {}
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
  Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
  globalShortcut: { register() {}, unregisterAll() {} },
  dialog: {
    showErrorBox() {},
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 })
  },
  nativeImage: { createFromPath() { return {}; } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  },
  net: { request: () => { throw new Error('stub: 测试不联网'); } }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

require(path.join(proj, 'electron', 'main.js'));

const sharedHelpers = require(path.join(proj, 'electron', 'shared-helpers.js'));
const ipcGuard = require(path.join(proj, 'electron', 'ipc-guard.js'));
const TABLE = ipcGuard.PATH_PARAM_CHANNELS;

const call = (channel, payload) => handlers[channel]({}, payload);

/** 越界用：一个与所有会话根、临时根都无关的位置 */
const FORGED = path.join(tmp, '..', 'tt-guard-forged-' + Date.now(), 'x.txt');
const CUR_ROOT = path.parse(tmp).root; // C:\ 之类
const SYSTEM_DIR = process.env.SystemRoot || process.env.windir || 'C:\\Windows';

/**
 * 把「越界路径」塞进所有可能被读的键，免得每个通道各写一份 payload。
 *
 * testClass 是给 projects:locateTest 的：它先校验「有没有 testClass」再校验路径
 * （顺序无所谓，都是在校验点之前不碰文件系统），不传就永远走不到 assertPathIn。
 */
const forgedPayload = (extra) =>
  Object.assign(
    {
      file: FORGED,
      dir: FORGED,
      root: FORGED,
      files: [FORGED],
      dirs: [FORGED],
      filePath: FORGED,
      testClass: 'com.example.DemoTest'
    },
    extra || {}
  );

/* ============================================================
 * 一、扫描种子校验本身（shared-helpers.js）
 * ============================================================ */
function seedChecks() {
  check("种子：盘符根 'C:\\' 被判为盘符根", sharedHelpers.isDriveRoot(CUR_ROOT) === true, CUR_ROOT);
  check(
    "种子：裸盘符 'C:'（不带反斜杠）也算盘符根",
    sharedHelpers.isDriveRoot(CUR_ROOT.replace(/[\\/]+$/, '')) === true,
    CUR_ROOT
  );
  check('种子：正斜杠形式也算盘符根', sharedHelpers.isDriveRoot(CUR_ROOT.replace(/\\/g, '/')) === true);
  check('种子：UNC 共享根被判为盘符根', sharedHelpers.isDriveRoot('\\\\server\\share') === true);
  check('种子：普通业务目录不是盘符根', sharedHelpers.isDriveRoot(tmp) === false, tmp);

  check('种子：系统目录被禁', sharedHelpers.isForbiddenScanRoot(SYSTEM_DIR) === true, SYSTEM_DIR);
  check('种子：系统目录的子目录也被禁', sharedHelpers.isForbiddenScanRoot(path.join(SYSTEM_DIR, 'System32')) === true);
  check('种子：盘符根被禁', sharedHelpers.isForbiddenScanRoot(CUR_ROOT) === true);
  check('种子：业务目录不禁', sharedHelpers.isForbiddenScanRoot(tmp) === false);

  sharedHelpers.resetSessionRoots();
  const okSeed = sharedHelpers.acceptScanRoot(tmp);
  check('种子：合法目录 acceptScanRoot 返回空（放行）', okSeed === null, okSeed);
  check('种子：合法目录被记进会话白名单', sharedHelpers.isPathAllowed(tmp) === true);

  sharedHelpers.resetSessionRoots();
  const badSeed = sharedHelpers.acceptScanRoot(CUR_ROOT);
  check('种子：盘符根 acceptScanRoot 返回 OUTSIDE_ROOT', !!(badSeed && badSeed.ok === false && badSeed.code === 'OUTSIDE_ROOT'), badSeed);
  check('种子：盘符根没被登记', sharedHelpers.isPathAllowed(CUR_ROOT) === false);

  sharedHelpers.resetSessionRoots();
  const sysSeed = sharedHelpers.acceptScanRoot(SYSTEM_DIR);
  check('种子：系统目录 acceptScanRoot 返回 OUTSIDE_ROOT', !!(sysSeed && sysSeed.code === 'OUTSIDE_ROOT'), sysSeed);
  check('种子：系统目录没被登记', sharedHelpers.isPathAllowed(SYSTEM_DIR) === false);

  sharedHelpers.resetSessionRoots();
  const gone = path.join(tmp, 'not-exist-' + Date.now());
  check('种子：不存在的目录不拦（交扫描函数自己报错）', sharedHelpers.acceptScanRoot(gone) === null);
  check('种子：不存在的目录不登记', sharedHelpers.isPathAllowed(gone) === false);

  sharedHelpers.resetSessionRoots();
  const aFile = path.join(tmp, 'a-file.txt');
  fs.writeFileSync(aFile, 'x', 'utf8');
  check('种子：文件不能当种子（不拦但不登记）', sharedHelpers.acceptScanRoot(aFile) === null);
  check('种子：文件没被当目录登记', sharedHelpers.isPathAllowed(aFile) === false);

  sharedHelpers.resetSessionRoots();
  sharedHelpers.rememberRoot(CUR_ROOT);
  check('种子：rememberRoot 自己也校验（盘符根进不去）', sharedHelpers.sessionRootsSnapshot().length === 0, sharedHelpers.sessionRootsSnapshot());
}

/* ============================================================
 * 二、总表 ↔ 源码对账（新通道漏登记会红）
 * ============================================================ */
function tableChecks() {
  const ipcFiles = fs
    .readdirSync(path.join(proj, 'electron', 'ipc'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(proj, 'electron', 'ipc', f));
  ipcFiles.push(path.join(proj, 'electron', 'main.js'));

  /** 收集每个 handler 的源码块（从 handle('x' 到下一个 handle( ） */
  const blocks = new Map();
  for (const file of ipcFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /handle\(\s*'([^']+)'/g;
    const hits = [];
    let m;
    while ((m = re.exec(src))) hits.push({ channel: m[1], at: m.index });
    for (let i = 0; i < hits.length; i++) {
      const end = i + 1 < hits.length ? hits[i + 1].at : src.length;
      blocks.set(hits[i].channel, src.slice(hits[i].at, end));
    }
  }

  const tableChannels = TABLE.map((r) => r.channel);
  check('表：通道不重复登记', new Set(tableChannels).size === tableChannels.length);
  check('表：没有登记了但根本没注册的通道（孤儿行）', TABLE.every((r) => handlers[r.channel]), TABLE.filter((r) => !handlers[r.channel]).map((r) => r.channel));

  // 源码里解构出来的路径参数，必须都在表里
  const PATH_PARAM_NAMES = ['root', 'file', 'dir', 'files', 'dirs', 'filePath'];
  const destructured = [];
  for (const [channel, body] of blocks) {
    const dm = /\{\s*([^}]+)\}\s*=\s*(?:payload|args\[0\]|(?:payload|args\[0\])\s*\|\|)/.exec(body);
    if (!dm) continue;
    const names = dm[1]
      .split(',')
      .map((s) => s.split(':')[0].split('=')[0].trim().replace(/^\.\.\./, ''))
      .filter(Boolean);
    if (names.some((n) => PATH_PARAM_NAMES.indexOf(n) >= 0)) destructured.push(channel);
  }
  const missing = destructured.filter((ch) => tableChannels.indexOf(ch) < 0);
  check('表：源码里解构路径入参的通道都登记了（共 ' + destructured.length + ' 个）', missing.length === 0, missing);

  // 所有 *:scan 必须是 seed
  const scanChannels = Object.keys(handlers).filter((ch) => /:scan$/.test(ch));
  const scanNotSeed = scanChannels.filter((ch) => {
    const row = TABLE.find((r) => r.channel === ch);
    return !row || row.guard !== 'seed';
  });
  check('表：' + scanChannels.length + ' 个 *:scan 通道全部按 seed 登记', scanChannels.length >= 7 && scanNotSeed.length === 0, scanNotSeed);
  check(
    '表：seed 行数 = *:scan 通道数（没有多登记成 seed 的非扫描通道）',
    TABLE.filter((r) => r.guard === 'seed').length === scanChannels.length,
    TABLE.filter((r) => r.guard === 'seed').map((r) => r.channel)
  );

  // 声明了守卫的通道，handler 里真的调了
  const noCall = [];
  for (const row of TABLE) {
    const body = blocks.get(row.channel) || '';
    if (row.guard === 'seed' && body.indexOf('acceptScanRoot') < 0) noCall.push(row.channel + ' (acceptScanRoot)');
    if (row.guard === 'assertPathIn' && body.indexOf('assertPathIn') < 0) noCall.push(row.channel + ' (assertPathIn)');
  }
  check('表：guard=seed 的真的调了 acceptScanRoot；assertPathIn 的真的调了 assertPathIn', noCall.length === 0, noCall);

  // 守卫层结构：不许再 require shared-helpers、不许在包装层记根
  const guardSrc = fs.readFileSync(path.join(proj, 'electron', 'ipc-guard.js'), 'utf8');
  const guardCode = guardSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('守卫层：ipc-guard.js 不 require shared-helpers', guardCode.indexOf('shared-helpers') < 0);
  check('守卫层：包装函数里没有 rememberRoot / acceptScanRoot 调用', !/rememberRoot\s*\(|acceptScanRoot\s*\(/.test(guardCode));
}

/* ============================================================
 * 三、行为：真走一遍 createHandle，白名单不能被污染
 * ============================================================ */
function guardLayerChecks() {
  const registered = {};
  const fakeIpc = {
    handle(ch, fn) {
      registered[ch] = fn;
    }
  };
  const handle = ipcGuard.createHandle({ ipcMain: fakeIpc, assertUnlocked() {} });

  handle('probe:scan', () => ({ ok: true }));
  sharedHelpers.resetSessionRoots();
  registered['probe:scan']({}, { root: CUR_ROOT });
  check('守卫层：任意 *:scan 通道传盘符根后，白名单没被写进任何东西', sharedHelpers.sessionRootsSnapshot().length === 0, sharedHelpers.sessionRootsSnapshot());

  // 真名通道也走一遍（确认不是只有假名才安全）
  const realName = 'kb:scan';
  handle(realName, () => ({ ok: true }));
  sharedHelpers.resetSessionRoots();
  registered[realName]({}, { root: SYSTEM_DIR });
  check('守卫层：真名 kb:scan 传系统目录也不会被包装层登记', sharedHelpers.sessionRootsSnapshot().length === 0, sharedHelpers.sessionRootsSnapshot());
}

/* ============================================================
 * 四、行为：真域模块，逐个通道验
 * ============================================================ */
async function domainChecks() {
  const biz = path.join(tmp, 'biz');
  fs.mkdirSync(biz, { recursive: true });
  const mdFile = path.join(biz, 'note.md');
  fs.writeFileSync(mdFile, '# 标题\n\n正文\n', 'utf8');

  /* ---- 4.1 扫描通道：盘符根 / 系统目录 → 拒绝且不登记 ---- */
  const scanChannels = TABLE.filter((r) => r.guard === 'seed').map((r) => r.channel);

  for (const ch of scanChannels) {
    sharedHelpers.resetSessionRoots();
    const r = await call(ch, { root: CUR_ROOT });
    check('扫描 ' + ch + ' 传盘符根 → OUTSIDE_ROOT', r && r.ok === false && r.code === 'OUTSIDE_ROOT', r);
    check('扫描 ' + ch + ' 传盘符根后没把盘根记成可信根', sharedHelpers.isPathAllowed(path.join(CUR_ROOT, 'Windows', 'win.ini')) === false);
  }

  for (const ch of scanChannels) {
    sharedHelpers.resetSessionRoots();
    const r = await call(ch, { root: SYSTEM_DIR });
    check('扫描 ' + ch + ' 传系统目录 → OUTSIDE_ROOT', r && r.ok === false && r.code === 'OUTSIDE_ROOT', r);
    check('扫描 ' + ch + ' 传系统目录后没把系统目录记成可信根', sharedHelpers.isPathAllowed(path.join(SYSTEM_DIR, 'win.ini')) === false);
  }

  /* ---- 4.2 业务目录：不拦，且被登记 ---- */
  for (const ch of scanChannels) {
    sharedHelpers.resetSessionRoots();
    const r = await call(ch, { root: biz });
    check('扫描 ' + ch + ' 能扫任意业务目录（不报 OUTSIDE_ROOT）', !(r && r.ok === false && r.code === 'OUTSIDE_ROOT'), r);
    check('扫描 ' + ch + ' 扫完把业务目录记进会话白名单（后续打开/定位才不拦）', sharedHelpers.isPathAllowed(mdFile) === true);
  }

  /* ---- 4.3 表驱动：带 file/dir 入参的通道，越界一律 OUTSIDE_ROOT ---- */
  const pathChannels = TABLE.filter((r) => r.guard === 'assertPathIn').map((r) => r.channel);
  for (const ch of pathChannels) {
    sharedHelpers.resetSessionRoots();
    let r;
    let threw = null;
    try {
      r = await call(ch, forgedPayload());
    } catch (e) {
      threw = e;
    }
    const rejected = threw ? /OUTSIDE_ROOT|不在允许|越界/.test(String(threw.message || '')) || threw.code === 'OUTSIDE_ROOT' : !!(r && r.ok === false && r.code === 'OUTSIDE_ROOT');
    check('越界 ' + ch + ' → OUTSIDE_ROOT', rejected, threw ? String(threw.message) : r);
  }

  /* ---- 4.4 空路径：给 BAD_PATH（不是越界，别混） ---- */
  sharedHelpers.resetSessionRoots();
  const emptyParse = await call('openapi:parseFile', { file: '' });
  check('越界：openapi:parseFile 空路径 → BAD_PATH', !!(emptyParse && emptyParse.ok === false && emptyParse.code === 'BAD_PATH'), emptyParse);

  /* ---- 4.5 正例：白名单内一切照旧（防「把功能拦死」） ---- */
  sharedHelpers.resetSessionRoots();
  await call('kb:scan', { root: biz });
  const opened = await call('kb:openFile', { file: mdFile });
  check('正例：扫过的业务目录里 kb:openFile 照常成功', !!(opened && opened.ok === true), opened);

  sharedHelpers.resetSessionRoots();
  await call('notes:scan', { root: biz });
  const md2 = path.join(biz, 'todo.md');
  fs.writeFileSync(md2, '# 待办\n\n- [ ] 一条\n', 'utf8');
  const imported = await call('notes:import', { files: [md2], onConflict: 'rename' });
  check('正例：选过的 md 能被导入（notes:import 没被拦死）', !!(imported && imported.ok === true), imported);

  sharedHelpers.resetSessionRoots();
  await call('kb:scan', { root: biz });
  const saved = await call('codegen:save', {
    dir: biz,
    targetKey: 'java-restassured',
    className: 'DemoApiTest',
    apiData: { name: '示例', method: 'GET', path: '/demo', baseUrl: 'http://127.0.0.1' }
  });
  check('正例：codegen:save 往白名单目录写时不被守卫拦（结果不是 OUTSIDE_ROOT）', !(saved && saved.code === 'OUTSIDE_ROOT'), saved);

  /* ---- 4.6 设置里配了盘符根也扫不动（口径统一，不给后门） ---- */
  sharedHelpers.resetSessionRoots();
  const viaSettings = await call('cases:scan', {});
  check('设置目录：不传 root 时用 settings.casesDir 正常扫（不是 OUTSIDE_ROOT）', !(viaSettings && viaSettings.code === 'OUTSIDE_ROOT'), viaSettings);
}

/* ============================================================
 * 主流程
 * ============================================================ */
(async () => {
  // 等 main.js 的 whenReady().then 注册完通道
  await new Promise((r) => setTimeout(r, 400));

  seedChecks();
  tableChecks();
  guardLayerChecks();
  await domainChecks();

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('===== 路径守卫总表测试（v0.51.0） =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  // 汇总口径与 run-unit 的解析规则一致（X passed, Y failed, Z skipped）
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, 0 skipped`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('测试自身崩了：', e);
  process.exit(1);
});