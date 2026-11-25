'use strict';

const { app, BrowserWindow, ipcMain, clipboard, shell, Tray, Menu, globalShortcut, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const demo = require('./demo');
const sharedHelpers = require('./shared-helpers');
const ipcGuard = require('./ipc-guard');
const navGuard = require('./nav-guard');
const workspaceDerive = require('./workspace-derive');

const DEBUG = process.env.TT_DEBUG === '1';
if (DEBUG) app.commandLine.appendSwitch('remote-debugging-port', '9222');

const APP_NAME = '测试工作台';
app.setName(APP_NAME);
app.setAppUserModelId('com.testtool.workbench');

let win = null;
let tray = null;
let locked = true;
let settings = {};
/** 当前正在跑的代码任务 id（runner:output 事件要用） */
let currentRunId = '';
let initialized = false;

/**
 * 默认目录：放在「文档」下，跟着用户走。
 * 不写死 D:\你的工作区 —— 换机器/换人 clone 下来，首次启动指向自己的文档目录。
 * 用户可以在设置里改成任意路径，改完存库，这里只是首次启动的兜底。
 */
function defaultWorkspaceDir() {
  try {
    return path.join(app.getPath('documents'), '测试工作台');
  } catch (e) {
    return '';
  }
}

const DEFAULT_SETTINGS = {
  autoLockMinutes: 10,
  clipboardClearSeconds: 30,
  openCopyPassword: true,
  /**
   * 点 X 时的行为：'tray' 缩到托盘（默认）/ 'quit' 直接退出。
   *
   * 为什么默认是 tray：
   *   用户日常会频繁切回平台（查密码、看接口），缩托盘能 Ctrl+Alt+T 秒开，
   *   比重新启动（几十秒）快得多。
   *
   * 代价：点 X 后进程还在（这是托盘的正常行为），
   *       装新版本时会提示「程序正在运行」——见 installer.nsh 的提示文案。
   *       想改的直接去「设置 → 选项 → 点 X 时」选「退出程序」。
   */
  closeAction: 'tray',
  // 内部标记：首次缩托盘时提示过一次（不暴露给前端）
  trayHintShown: false,
  /**
   * 工作区根目录（1 级）。
   *
   * 下面 7 个目录都是它的子目录，空值时自动推导：
   *   {workspace}/test_cases、{workspace}/jmx、{workspace}/知识库 …
   * 用户只需要配这一个，其他都能省。
   */
  workspaceDir: '',
  // 空字符串 = 首次启动时按 defaultWorkspaceDir() 算，见 loadSettings()
  casesDir: '',
  jmxDir: '',
  reportDir: '',
  // Allure 报告根目录（报告分析默认扫这里，仍可手动选）
  allureDir: '',
  kbDir: '',
  notesDir: '',
  // 代码项目根目录（代码调试用）
  projectDir: '',
  // 开发环境手动指定（空 = 自动探测）
  javaHome: '',
  pythonPath: '',
  mvnPath: '',
  // 皮肤：主题色 / 背景图文件名 / 面板透明度（0-100）
  themeColor: 'purple',
  bgImage: '',
  bgOpacity: 85,
  // 文字颜色：auto（透明度低时自动加深）/ deep（强制加深）/ normal（默认）
  bgTextMode: 'auto',
  // 背景蒙版：强度 0-100 + 颜色 dark/light
  bgOverlay: 35,
  bgOverlayColor: 'dark',
  jmeterPath: '',
  pin: null
};

function resolveDataDir() {
  if (process.env.TT_DATA_DIR) return process.env.TT_DATA_DIR;
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && fs.existsSync(path.join(portableDir, 'portable.marker'))) {
    return path.join(portableDir, 'data');
  }
  return path.join(app.getPath('appData'), APP_NAME);
}

// Chromium 运行时数据（缓存、锁文件）也要落在可写目录，否则单实例锁会拿不到
const DATA_DIR = (() => {
  try {
    const dir = resolveDataDir();
    fs.mkdirSync(dir, { recursive: true });
    const runtime = path.join(dir, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    app.setPath('userData', runtime);
    return dir;
  } catch (e) {
    return app.getPath('userData');
  }
})();

/**
 * 启动诊断日志：无条件写（不依赖 TT_DEBUG）。
 * 出问题时看 %APPDATA%\测试工作台\startup.log 就知道卡在哪一步。
 */
function logStartup(msg) {
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'startup.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    /* 写不了就算了，不能因为日志影响启动 */
  }
}

if (!app.requestSingleInstanceLock()) {
  // 锁失败时给明确提示：首次用户不知道有托盘，会以为启动失败
  try {
    dialog.showMessageBoxSync({
      type: 'info',
      title: '测试工作台已在运行',
      message: '程序已经在运行了',
      detail: '如果没看到窗口，请检查系统托盘（右下角），或按 Ctrl+Alt+T 唤起。',
      buttons: ['知道了']
    });
  } catch (e) {
    /* 弹框失败也要退出 */
  }
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function loadSettings() {
  const saved = store.getMeta('settings', {}) || {};
  settings = Object.assign({}, DEFAULT_SETTINGS, saved);

  /**
   * 目录推导（1 级 → 2 级）收口在 electron/workspace-derive.js。
   *
   * 优先级：
   *   1. 用户显式配的 2 级目录（他自己填的，一个字都不动）
   *   2. 工作区下的子目录（settings.workspaceDir + 子目录名）
   *   3. 默认的「文档\测试工作台」
   *
   * 老实现是「先填默认值、再按工作区推导」，而推导条件是 if (!settings[key]) ——
   * 默认值已经把字段填满，工作区推导永远不生效（这就是「配了工作区子目录不动」的一半原因）。
   * 现在一处实现（workspace-derive.js）两个入口共用：启动时补默认值（不建目录），
   * 用户在设置页改工作区时立即重算 + 建目录（见 ipc-settings.js 的 settings:set）。
   */
  workspaceDerive.applyStartupDefaults(settings, defaultWorkspaceDir());

  // 代码项目目录：默认 {文档}\Project（和「文档\测试工作台」同级）
  if (!settings.projectDir) {
    const base = defaultWorkspaceDir();
    const guess = path.join(path.dirname(base || ''), 'Project');
    if (base && fs.existsSync(guess)) settings.projectDir = guess;
  }

  locked = !!settings.pin;
  return settings;
}

function saveSettings() {
  store.setMeta('settings', settings);
  store.persist();
}

function assertUnlocked() {
  if (locked) {
    const err = new Error('已锁定，请先解锁');
    err.code = 'LOCKED';
    throw err;
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  /** app 自己的页面目录（导航护栏用） */
  const distDir = path.join(__dirname, '..', 'dist');
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f4f5fa',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * sandbox: true（v0.43.0）
       *
       * 原来是 false，等于渲染进程崩了就是个普通进程。preload.js 只用
       * contextBridge + ipcRenderer（**没有任何 Node 模块 require**），
       * 沙箱里完全够用。改完必须回归 preload 的 window.api 是否仍然可用
       * （test-security.cjs 静态校验 preload 不依赖 Node，真机由冒烟覆盖）。
       */
      sandbox: true,
      spellcheck: false
    }
  });

  /**
   * 导航护栏（High：markdown 外链 → RCE）
   *
   * 知识库/笔记的 markdown 用 innerHTML 渲染，DOMPurify 会保留 <a href>。
   * 没有这两道口子的话：点外链 → 窗口导航到 evil.com → 那个页面还握着
   * 已注入的 window.api → 直接调任意 IPC（导出整库、装更新）。
   *
   * 规则：
   *   - will-navigate：只放行 app 自己的 file:// 页面（dist/ 下），其余拦掉，
   *     http/https 的转系统浏览器；
   *   - setWindowOpenHandler：一律 deny（不新开窗），http/https 同样转
   *     shell.openExternal —— 外部页面永远进不了这个 BrowserWindow。
   */
  win.webContents.on('will-navigate', (event, url) => {
    if (navGuard.isAppUrl(url, distDir)) return;
    event.preventDefault();
    logStartup('blocked navigation: ' + url);
    if (navGuard.isExternalUrlAllowed(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // typeof 兜底：测试桩里的 webContents 只实现了最小接口
  if (typeof win.webContents.setWindowOpenHandler === 'function') {
    win.webContents.setWindowOpenHandler(({ url }) => {
      logStartup('blocked window.open: ' + url);
      if (navGuard.isExternalUrlAllowed(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });
  }

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  /**
   * 窗口显示的三重保险。
   *
   * 原来只有 `ready-to-show` 一个触发点，如果它没触发（渲染进程加载失败、
   * GPU 崩溃、事件在监听器绑定前就发了），窗口永远不出现——但进程活着、
   * 托盘有图标，用户会以为启动失败。
   */
  let shown = false;
  const showOnce = (reason) => {
    if (shown || !win) return;
    shown = true;
    logStartup('window shown (' + reason + ')');
    win.show();
  };

  win.once('ready-to-show', () => showOnce('ready-to-show'));

  // 保险 1：加载失败也要显示，让用户看到错误而不是黑屏
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    logStartup('did-fail-load code=' + code + ' desc=' + desc + ' url=' + url);
    showOnce('did-fail-load');
  });

  // 保险 2：渲染进程崩溃也要显示
  win.webContents.on('render-process-gone', (e, details) => {
    logStartup('render-process-gone reason=' + (details && details.reason));
    showOnce('render-process-gone');
  });

  // 保险 3：3 秒还没 ready 就强制显示（宁可白屏也别让用户以为没启动）
  setTimeout(() => {
    if (!shown) {
      logStartup('3s timeout, forcing show');
      showOnce('timeout');
    }
  }, 3000);

  win.on('closed', () => {
    win = null;
  });

  /**
   * 点 X 时的行为，由设置 closeAction 决定：
   *   'tray'  → 隐藏到托盘（程序继续跑，热键/托盘能唤回）
   *   'quit'  → 直接退出程序
   * 默认 'tray'：本地工具常驻托盘更顺手（热键 Ctrl+Alt+T 随时唤）。
   */
  win.on('close', (e) => {
    const action = settings.closeAction === 'quit' ? 'quit' : 'tray';
    if (action === 'quit') return; // 走默认关闭流程
    if (app.isQuitting) return; // 托盘菜单「退出」时放行
    e.preventDefault();
    win.hide();
    logStartup('window hidden to tray');

    /**
     * 首次缩托盘时提示一次。
     *
     * 为什么需要：
     *   用户点 X 后以为关了，实际进程还在（托盘的正常行为）。
     *   结果装新版本时看到「程序正在运行」觉得是 bug（踩坑 #93）。
     *   提示一次就能让用户记住「缩托盘 = 还在跑」。
     *
     * 只提示一次，之后不再打扰。
     */
    if (!settings.trayHintShown) {
      settings.trayHintShown = true;
      try {
        store.setMeta('settings', settings);
        store.persist();
      } catch (err) {
        /* 存不上也不影响功能 */
      }
      try {
        if (tray && typeof tray.displayBalloon === 'function') {
          tray.displayBalloon({
            title: '已缩到托盘，程序还在跑',
            content: '右键托盘图标可退出；Ctrl+Alt+T 唤回窗口。装新版本前记得先退出。'
          });
        }
      } catch (err) {
        logStartup('tray balloon failed: ' + (err && err.message));
      }
    }
  });

  if (DEBUG) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

function createTray() {
  const trayPath = path.join(__dirname, '..', 'build', 'tray.png');
  if (!fs.existsSync(trayPath)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(trayPath));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
        { label: '立即锁定', click: () => { locked = true; if (win) win.webContents.send('app:locked'); } },
        { type: 'separator' },
        { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
      ])
    );
    tray.on('double-click', () => {
      if (win) {
        win.show();
        win.focus();
      }
    });
  } catch (e) {
    console.error('[tray] init failed', e);
  }
}

/**
 * 注册所有 IPC 域。
 *
 * 每个域一个模块，放在 electron/ipc/ 下，模块导出 register(deps)。
 * 这里按文件名排序自动加载 —— 以后新增域不用再回来改 main.js。
 *
 * 为什么这么改（踩坑 #103）：
 *   新增通道和已有通道撞名（data:openDir 注册两次），
 *   Electron 第二次注册直接抛异常，应用启动崩溃。
 *   现在通道清单由 scripts/test-ipc-unique.cjs 扫整个 electron 目录兜住，
 *   重复一定在测试阶段就被拦住。
 *
 * deps 里只放各域真正需要的东西：
 *   - 模块级对象（ipcMain/app/store/dialog/shell/path/fs/clipboard）
 *   - 运行期状态一律用函数取值（getWindow/getSettings/isLocked/setLocked），
 *     因为 win / settings 会被重新赋值，直接传引用会拿到旧值
 *   - 跨域共用的 helper 从 shared-helpers.js 来
 *
 * **handle(channel, fn) 是唯一的注册方式**（v0.43.0）：
 *   默认要求已解锁，白名单在 electron/ipc-guard.js 里。
 *   各域模块一律用 `const { handle } = deps` 注册通道，不再直接 ipcMain.handle ——
 *   否则「锁屏不是安全边界」那个缺口会立刻回潮（scripts/test-ipc-unique.cjs 有护栏）。
 */
function registerIpc() {
  const dir = path.join(__dirname, 'ipc');
  /** 路径守卫额外放行的根：数据目录自己（含 backups/、skin/） */
  const extraRoots = () => [DATA_DIR, store.backupDir].filter(Boolean);

  const deps = {
    ipcMain,
    dialog,
    shell,
    app,
    store,
    path,
    fs,
    clipboard,
    getWindow: () => win,
    getSettings: () => settings,
    publicSettings: () => sharedHelpers.publicSettings(settings),
    loadSettings,
    saveSettings,
    dataDir: DATA_DIR,
    resolveDataDir,
    isLocked: () => locked,
    setLocked: (value) => {
      locked = !!value;
    },
    assertUnlocked,
    /**
     * 统一注册入口（默认带解锁守卫）。
     * 白名单见 electron/ipc-guard.js 的 UNLOCK_WHITELIST。
     */
    handle: ipcGuard.createHandle({ ipcMain, assertUnlocked }),
    /**
     * 路径归属守卫：不在「设置里的目录 / 会话内选过扫过的目录 / 数据目录」内
     * 一律返回 { ok:false, code:'OUTSIDE_ROOT' }。
     * 用法：`const bad = assertPathIn(dir); if (bad) return bad;`
     */
    assertPathIn: (target, moreRoots) =>
      sharedHelpers.assertPathIn(target, extraRoots().concat(Array.isArray(moreRoots) ? moreRoots : []), settings),
    isPathAllowed: (target, moreRoots) =>
      sharedHelpers.isPathAllowed(target, extraRoots().concat(Array.isArray(moreRoots) ? moreRoots : []), settings),
    /** dialog 选过 / 显式扫描过的目录记进本会话白名单 */
    rememberPicked: sharedHelpers.rememberPicked,
    rememberRoot: sharedHelpers.rememberRoot,
    detectJmeter: () => sharedHelpers.detectJmeter(settings, saveSettings),
    jmeterVersionOf: sharedHelpers.jmeterVersionOf,
    launchJmeter: (jmxFile) => sharedHelpers.launchJmeter(settings, saveSettings, jmxFile),
    logStartup
  };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const mod = require(path.join(dir, f));
    if (typeof mod.register === 'function') mod.register(deps);
  }
}

app.whenReady().then(async () => {
  logStartup('=== app ready, version=' + app.getVersion() + ' ===');
  try {
    await store.init(DATA_DIR);
    logStartup('store init ok, db=' + store.dbPath);
    loadSettings();
    logStartup('settings loaded, casesDir=' + settings.casesDir);

    /**
     * 首次启动写入示例数据（只写一次）。
     *
     * 放这里而不是 registerIpc 之后：
     *   窗口创建时会读列表，示例数据得在那之前就落库，
     *   否则首屏空白、要手动刷新才看得到。
     */
    try {
      // 测试时可设 TT_NO_DEMO=1 关掉（否则测试库会混进示例数据）
      if (process.env.TT_NO_DEMO === '1') {
        logStartup('demo seed disabled by TT_NO_DEMO');
      } else {
      const demoRoot = path.join(DATA_DIR, 'demo');
      const seed = demo.seedDemo(store, demoRoot);
      if (seed.seeded) {
        logStartup('demo seeded: ' + seed.records + ' records, files=' + JSON.stringify(seed.files));
        store.persist();
      } else {
        logStartup('demo already seeded, skip');
      }
      }
    } catch (e) {
      // 示例数据写失败不能影响启动
      logStartup('demo seed failed: ' + (e && e.message));
    }

    registerIpc();
    logStartup('ipc registered');
    createWindow();
    logStartup('window created');
    createTray();
    logStartup('tray created');
    try {
      globalShortcut.register('Control+Alt+T', () => {
        if (!win) createWindow();
        else {
          win.show();
          win.focus();
        }
      });
    } catch (e) {
      /* 热键被占用时忽略 */
    }
    initialized = true;
    logStartup('startup complete');
    if (DEBUG) {
      try {
        fs.appendFileSync(path.join(DATA_DIR, 'debug.log'), `[${new Date().toISOString()}] ready, db=${store.dbPath}\n`);
      } catch (e) {
        /* ignore */
      }
    }
  } catch (err) {
    logStartup('FATAL ' + ((err && err.stack) || err));
    try {
      fs.appendFileSync(path.join(DATA_DIR, 'debug.log'), `[${new Date().toISOString()}] FATAL ${(err && err.stack) || err}\n`);
    } catch (e) {
      /* ignore */
    }
    dialog.showErrorBox('启动失败', String((err && err.stack) || err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  store.close();
  app.quit();
});

app.on('before-quit', () => {
  try {
    store.persist();
  } catch (e) {
    /* ignore */
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (!win) createWindow();
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err);
});