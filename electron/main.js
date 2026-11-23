'use strict';

const { app, BrowserWindow, ipcMain, clipboard, shell, Tray, Menu, globalShortcut, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const caseIndex = require('./cases');
const jmxIndex = require('./jmx');
const jtlReport = require('./jtl');
const knowledge = require('./knowledge');
const notesIndex = require('./notes');
const updater = require('./updater');
const openapi = require('./openapi');
const security = require('./security');
const runner = require('./runner');
const projects = require('./projects');
const { RUNNERS, listRunners } = require('../shared/runners');
const { TOOLS, COLLECTION_MAP } = require('../shared/collections');

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
let clipboardTimer = null;
let initialized = false;

/**
 * 默认目录：放在「文档」下，跟着用户走。
 * 不写死 D:\AI_Workspace —— 换机器/换人 clone 下来，首次启动指向自己的文档目录。
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
  // 点 X 时的行为：'tray' 缩到托盘（默认）/ 'quit' 直接退出
  closeAction: 'tray',
  // 空字符串 = 首次启动时按 defaultWorkspaceDir() 算，见 loadSettings()
  casesDir: '',
  jmxDir: '',
  reportDir: '',
  kbDir: '',
  notesDir: '',
  // 代码项目根目录（代码调试用）
  projectDir: '',
  // 开发环境手动指定（空 = 自动探测）
  javaHome: '',
  pythonPath: '',
  mvnPath: '',
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

  // 首次启动（或用户清空过）时，把四个目录指向「文档\测试工作台\...」
  const base = defaultWorkspaceDir();
  if (base) {
    const fill = (key, sub) => {
      if (!settings[key]) settings[key] = path.join(base, sub);
    };
    fill('casesDir', 'test_cases');
    fill('jmxDir', 'jmx');
    fill('reportDir', path.join('jmx', '压测结果'));
    fill('kbDir', '知识库');
    fill('notesDir', 'notes');
  }

  // 代码项目目录：默认 D:\AI_Workspace\Project（和「文档\测试工作台」同级）
  if (!settings.projectDir) {
    const guess = path.join(path.dirname(base || ''), 'Project');
    if (base && fs.existsSync(guess)) settings.projectDir = guess;
  }

  locked = !!settings.pin;
  return settings;
}

function publicSettings() {
  return {
    projectDir: settings.projectDir || '',
    javaHome: settings.javaHome || '',
    pythonPath: settings.pythonPath || '',
    mvnPath: settings.mvnPath || '',
    autoLockMinutes: settings.autoLockMinutes,
    clipboardClearSeconds: settings.clipboardClearSeconds,
    openCopyPassword: settings.openCopyPassword !== false,
    closeAction: settings.closeAction === 'quit' ? 'quit' : 'tray',
    casesDir: settings.casesDir || '',
    jmxDir: settings.jmxDir || '',
    reportDir: settings.reportDir || '',
    kbDir: settings.kbDir || '',
    notesDir: settings.notesDir || '',
    jmeterPath: settings.jmeterPath || '',
    hasPin: !!settings.pin
  };
}

function saveSettings() {
  store.setMeta('settings', settings);
  store.persist();
}

/**
 * 探测 JMeter。优先级：
 *   1. 设置里存的路径
 *   2. 环境变量 JMETER_HOME（指向 JMeter 安装目录，不是 bin）
 *   3. PATH 里的 jmeter
 *   4. 常见安装位置（兜底，不保证存在）
 * 探测到就写回设置，否则设置页永远显示空、用户以为没生效。
 */
function detectJmeter() {
  const candidates = [];
  if (settings.jmeterPath) candidates.push(settings.jmeterPath);

  // 环境变量：JMETER_HOME 指向安装目录
  const home = process.env.JMETER_HOME;
  if (home) {
    candidates.push(path.join(home, 'bin', 'jmeter.bat'));
    candidates.push(path.join(home, 'bin', 'jmeter'));
  }

  // PATH 里的 jmeter（Windows 上可能是 .bat 或 .cmd）
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'jmeter.bat'));
    candidates.push(path.join(dir, 'jmeter.cmd'));
  }

  // 常见安装位置兜底
  for (const drive of ['C:', 'D:', 'E:']) {
    for (const ver of ['5.6.3', '5.5', '5.4.3']) {
      candidates.push(path.join(drive + path.sep, `apache-jmeter-${ver}`, 'bin', 'jmeter.bat'));
    }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      if (settings.jmeterPath !== c) {
        settings.jmeterPath = c;
        try {
          saveSettings();
        } catch (err) {
          /* 存不下也不影响本次使用 */
        }
      }
      return c;
    }
  }
  return '';
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
      sandbox: false,
      spellcheck: false
    }
  });

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

function registerIpc() {
  ipcMain.handle('app:init', async () => {
    // 启动时探一次 JMeter，探到就落盘，设置页才看得见
    try {
      detectJmeter();
    } catch (e) {
      /* 探测失败不影响启动 */
    }
    return {
      locked,
      settings: publicSettings(),
      version: app.getVersion(),
      dataDir: path.dirname(store.dbPath),
      encryptionAvailable: security.available(),
      tools: TOOLS
    };
  });

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    schemaVersion: store.schemaVersion(),
    dataDir: path.dirname(store.dbPath),
    dbPath: store.dbPath,
    backupDir: store.backupDir,
    encryptionAvailable: security.available(),
    backups: store.listBackups()
  }));

  ipcMain.handle('app:lock', async () => {
    locked = true;
    return true;
  });

  ipcMain.handle('app:unlock', async (e, { pin }) => {
    if (!settings.pin) {
      locked = false;
      return { ok: true };
    }
    const ok = security.verifyPin(pin, settings.pin.salt, settings.pin.hash);
    if (ok) locked = false;
    return { ok, hasPin: true };
  });

  ipcMain.handle('pin:set', async (e, { oldPin, pin }) => {
    if (!pin || String(pin).length < 4) return { ok: false, message: '密码至少 4 位' };
    if (settings.pin) {
      const ok = security.verifyPin(oldPin, settings.pin.salt, settings.pin.hash);
      if (!ok) return { ok: false, message: '原密码不对' };
    }
    settings.pin = security.hashPin(pin);
    saveSettings();
    locked = false;
    return { ok: true };
  });

  ipcMain.handle('pin:clear', async (e, { pin }) => {
    if (settings.pin && !security.verifyPin(pin, settings.pin.salt, settings.pin.hash)) {
      return { ok: false, message: '密码不对' };
    }
    settings.pin = null;
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('settings:get', async () => publicSettings());

  ipcMain.handle('settings:set', async (e, patch) => {
    const allowed = ['autoLockMinutes', 'clipboardClearSeconds', 'openCopyPassword', 'closeAction', 'casesDir', 'jmxDir', 'jmeterPath', 'reportDir', 'kbDir', 'notesDir'];
    for (const key of allowed) {
      if (patch && patch[key] !== undefined) settings[key] = patch[key];
    }
    saveSettings();
    return publicSettings();
  });

  ipcMain.handle('records:list', async (e, payload) => {
    assertUnlocked();
    const { collection, keyword, tag, favorite } = payload || {};
    return store.list(collection, { keyword, tag, favorite });
  });

  ipcMain.handle('records:get', async (e, { id }) => {
    assertUnlocked();
    return store.get(id);
  });

  ipcMain.handle('records:save', async (e, record) => {
    assertUnlocked();
    return store.save(record);
  });

  ipcMain.handle('records:remove', async (e, { id }) => {
    assertUnlocked();
    return store.remove(id);
  });

  ipcMain.handle('records:counts', async () => {
    assertUnlocked();
    return store.counts();
  });

  ipcMain.handle('clipboard:copy', async (e, { text, secret }) => {
    const value = String(text === undefined || text === null ? '' : text);
    clipboard.writeText(value);
    if (secret) {
      const secs = Number(settings.clipboardClearSeconds || 0);
      if (clipboardTimer) clearTimeout(clipboardTimer);
      if (secs > 0) {
        clipboardTimer = setTimeout(() => {
          try {
            if (clipboard.readText() === value) clipboard.clear();
          } catch (err) {
            /* ignore */
          }
        }, secs * 1000);
      }
    }
    return true;
  });

  ipcMain.handle('shell:open', async (e, { url }) => {
    let u = String(url || '').trim();
    if (!u) return false;
    // 用户常填 www.xxx.com 或 xxx.com（没写协议），自动补 https://
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
      u = 'https://' + u.replace(/^\/+/, '');
    }
    // 只允许 http/https（防止 file:// / javascript: 等）
    if (!/^https?:\/\//i.test(u)) return false;
    await shell.openExternal(u);
    return true;
  });

  ipcMain.handle('util:hash', async (e, { algo, text }) => {
    const allowed = ['md5', 'sha1', 'sha256', 'sha512'];
    const name = String(algo || 'sha256').toLowerCase();
    const use = allowed.includes(name) ? name : 'sha256';
    return crypto.createHash(use).update(String(text === undefined ? '' : text), 'utf8').digest('hex');
  });

  ipcMain.handle('backup:now', async () => {
    const file = store.backup();
    return { file };
  });

  ipcMain.handle('backup:list', async () => store.listBackups());

  // ---- 可配置选项（环境 / 角色·权限 / 标签）----
  ipcMain.handle('options:get', async () => {
    assertUnlocked();
    return store.getOptions();
  });

  ipcMain.handle('options:save', async (e, { key, items } = {}) => {
    assertUnlocked();
    return store.saveOptions(String(key || ''), items);
  });

  ipcMain.handle('data:openDir', async () => {
    const dir = path.dirname(store.dbPath);
    await shell.openPath(dir);
    return dir;
  });

  /**
   * 清除数据。target: 'backups' 只清备份文件；'local' 重置本地数据文件。
   * 破坏性操作，界面侧有 3 秒倒计时兜一层手滑。
   */
  ipcMain.handle('data:clear', async (e, { target } = {}) => {
    assertUnlocked();
    const what = String(target || '');
    if (what === 'backups') {
      return Object.assign({ ok: true, target: what }, store.clearBackups());
    }
    if (what === 'local') {
      const res = store.clearLocalData();
      // 设置和锁屏密码都存在库里，库重置后就回到默认值（也就没有密码了）
      loadSettings();
      return Object.assign({ ok: true, target: what }, res, { settings: publicSettings() });
    }
    return { ok: false, target: what, message: '未知的清除目标' };
  });

  ipcMain.handle('data:export', async (e, { includeSecrets, collection } = {}) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const conf = collection ? COLLECTION_MAP[collection] : null;
    const base = conf ? `测试工作台-${conf.name}-${stamp}.json` : `测试工作台-备份-${stamp}.json`;
    const result = await dialog.showSaveDialog(win, {
      title: collection ? `导出「${conf.name}」` : '导出数据',
      defaultPath: path.join(app.getPath('desktop'), base),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const payload = store.exportAll(!!includeSecrets, collection || null);
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, file: result.filePath, count: payload.records.length };
  });

  /**
   * 导入：.json = 合并（留原 id，关联和选项一起带过来）
   *      .db   = 整库覆盖，破坏性操作，先回给界面确认，不在这里直接恢复
   */
  ipcMain.handle('data:import', async (e, { collection } = {}) => {
    const conf = collection ? COLLECTION_MAP[collection] : null;
    // 按集合导入只认 JSON：.db 是整库覆盖，不能只导一个集合，
    // 所以过滤器里也不该出现它（否则用户选了才被告知不行）
    const filters = conf
      ? [{ name: 'JSON', extensions: ['json'] }]
      : [
          { name: 'JSON 或数据库备份', extensions: ['json', 'db'] },
          { name: 'JSON', extensions: ['json'] },
          { name: '数据库备份', extensions: ['db'] }
        ];
    const result = await dialog.showOpenDialog(win, {
      title: conf ? `导入到「${conf.name}」` : '导入数据',
      properties: ['openFile'],
      filters
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const file = result.filePaths[0];

    // 选了 .db：这是整库覆盖，不能悄悄执行，回给界面弹确认
    if (/\.db$/i.test(file)) {
      if (collection) {
        return { ok: false, message: '数据库备份是整库覆盖，不能只导入某个集合' };
      }
      try {
        const info = store.inspectDbFile(file);
        return {
          ok: false,
          needConfirm: true,
          mode: 'db',
          file,
          recordCount: info.recordCount,
          fromVersion: info.version
        };
      } catch (err) {
        return { ok: false, message: (err && err.message) || '这个 .db 读不了' };
      }
    }

    const raw = fs.readFileSync(file, 'utf8');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return { ok: false, message: '不是合法的 JSON 文件' };
    }
    const stat = store.importAll(payload, collection || null);
    return {
      ok: true,
      file,
      imported: stat.imported,
      skipped: stat.skipped,
      keptIds: stat.keptIds,
      links: stat.links
    };
  });

  /** 用备份（或任意 .db）覆盖当前库；恢复前自动给当前库留安全备份 */
  ipcMain.handle('backup:restore', async (e, { file } = {}) => {
    assertUnlocked();
    const name = String(file || '').trim();
    if (!name) return { ok: false, message: '缺少备份文件' };
    // 只给文件名时按备份目录解析；给绝对路径则原样用（从别处拷来的 .db）
    const target = path.isAbsolute(name) ? name : path.join(store.backupDir, name);
    try {
      const res = store.restoreFrom(target);
      loadSettings();
      // 备份里可能带着锁屏密码：恢复后按备份里的设置走（有密码就重新上锁）
      return Object.assign({ ok: true, file: target, locked: locked, settings: publicSettings() }, res);
    } catch (err) {
      return { ok: false, message: (err && err.message) || '恢复失败' };
    }
  });

  /** 导出整库 .db（备份到指定位置，可拿去别的机器覆盖用） */
  ipcMain.handle('data:exportDb', async () => {
    assertUnlocked();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const result = await dialog.showSaveDialog(win, {
      title: '导出整库备份',
      defaultPath: path.join(app.getPath('desktop'), `测试工作台-整库-${stamp}.db`),
      filters: [{ name: '数据库备份', extensions: ['db'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const res = store.exportDbTo(result.filePath);
    return { ok: true, file: res.file, bytes: res.bytes };
  });

  // ---- 用例索引（只读，文件为准） ----
  ipcMain.handle('cases:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const dir = (root && String(root).trim()) || settings.casesDir;
    return caseIndex.scanCases(dir, {});
  });

  ipcMain.handle('cases:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  ipcMain.handle('cases:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    shell.showItemInFolder(String(file));
    return { ok: true };
  });

  ipcMain.handle('cases:pickDir', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择用例目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.casesDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.casesDir };
  });

  // ---- JMeter jmx 索引（只读，文件为准） ----

  /**
   * 启动 JMeter。
   *
   * Windows 上**不能直接 spawn 一个 .bat**：Node 从 CVE-2024-27980 修复后
   * 禁止直接执行批处理文件，会抛 EINVAL。必须走 shell:true（或 cmd /c）。
   * 用 shell:true 时路径里有空格/中文要自己加引号，否则会被拆成多个参数。
   */
  const launchJmeter = (jmxFile) => {
    const bat = detectJmeter();
    if (!bat) {
      return {
        ok: false,
        code: 'JMETER_NOT_FOUND',
        message: '没找到 JMeter。请到「设置 → 压测」里点「选择…」指定 jmeter.bat 的路径（通常在 JMeter 安装目录的 bin 下）'
      };
    }
    if (jmxFile && !fs.existsSync(jmxFile)) {
      return { ok: false, code: 'JMX_NOT_FOUND', message: '脚本文件不存在：' + jmxFile };
    }

    const quoted = '"' + bat + '"';
    const args = jmxFile ? ['-t', '"' + jmxFile + '"'] : [];
    const cmd = [quoted].concat(args).join(' ');

    try {
      const child = spawn(cmd, {
        cwd: path.dirname(bat),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: true
      });
      child.on('error', (err) => {
        console.error('[jmeter] spawn error', err);
      });
      child.unref();
      return { ok: true, jmeter: bat, version: jmeterVersionOf(bat), command: cmd };
    } catch (err) {
      const code = (err && err.code) || '';
      let message = (err && err.message) || '启动 JMeter 失败';
      if (code === 'EINVAL') {
        message = '启动失败（EINVAL）：Windows 不允许直接执行 .bat，已改用 shell 方式；如果仍失败请检查路径是否含特殊字符';
      } else if (code === 'ENOENT') {
        message = '启动失败：找不到 ' + bat + '，请到设置里重新指定';
      } else if (code === 'EACCES') {
        message = '启动失败：没有执行权限，' + bat;
      }
      return { ok: false, code, message };
    }
  };

  /**
   * 读 JMeter 版本（不启动 JMeter）。
   * jar 名不带版本号，所以依次试：目录名 → jmeter.properties 里的注释 → jar 的 MANIFEST。
   */
  const jmeterVersionOf = (batPath) => {
    try {
      const home = path.dirname(path.dirname(batPath));
      // 1) 目录名里通常带版本：apache-jmeter-5.4.3
      const m = /jmeter[-_]?([\d]+\.[\d]+(?:\.[\d]+)?)/i.exec(path.basename(home));
      if (m) return m[1];

      // 2) jmeter.properties 顶部注释
      const propsFile = path.join(home, 'bin', 'jmeter.properties');
      if (fs.existsSync(propsFile)) {
        const head = fs.readFileSync(propsFile, 'utf8').slice(0, 2000);
        const pm = /jmeter[- ]?([\d]+\.[\d]+(?:\.[\d]+)?)/i.exec(head);
        if (pm) return pm[1];
      }

      // 3) jar 的 MANIFEST.MF（zip 里找 Implementation-Version）
      const jar = path.join(home, 'lib', 'ext', 'ApacheJMeter_core.jar');
      if (fs.existsSync(jar)) {
        const buf = fs.readFileSync(jar);
        const text = buf.toString('latin1');
        const vm = /Implementation-Version:\s*([\d.]+)/.exec(text);
        if (vm) return vm[1];
      }
      return '';
    } catch (e) {
      return '';
    }
  };

  /* ==================== 代码调试 ==================== *
   * 在平台里写代码 → 跑 → 看输出。
   * 支持 Groovy（JMeter）/ Python / pytest / Maven。
   * -------------------------------------------------- */

  /** 运行器列表 + 完整环境状态（给前端下拉和状态面板） */
  ipcMain.handle('runner:list', async () => {
    assertUnlocked();
    const env = runner.detectAll();
    return {
      ok: true,
      runners: listRunners(),
      env,
      // 多版本列表（设置页下拉用）
      jdks: runner.listJdks(),
      pythons: runner.listPythons(),
      // 手动指定的路径（空 = 自动）
      manual: {
        javaHome: settings.javaHome || '',
        pythonPath: settings.pythonPath || '',
        mvnPath: settings.mvnPath || ''
      }
    };
  });

  /** 打开 Playwright 浏览器缓存目录 */
  ipcMain.handle('runner:openBrowserDir', async () => {
    assertUnlocked();
    const pw = runner.detectPlaywrightBrowsers();
    if (!pw.dir) return { ok: false, message: '找不到缓存目录' };
    try {
      fs.mkdirSync(pw.dir, { recursive: true });
      await shell.openPath(pw.dir);
      return { ok: true, dir: pw.dir };
    } catch (e) {
      return { ok: false, message: String(e && e.message) };
    }
  });

  /** 扫描代码项目目录 */
  ipcMain.handle('projects:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const dir = (root && String(root).trim()) || settings.projectDir || '';
    return projects.scanProjects(dir);
  });

  /** 列出某个 Maven 项目的测试类 */
  ipcMain.handle('projects:testClasses', async (e, { dir } = {}) => {
    assertUnlocked();
    const d = String(dir || '').trim();
    if (!d) return { ok: false, classes: [], message: '缺少项目目录' };
    return { ok: true, classes: projects.listTestClasses(d) };
  });

  /** 选项目目录 */
  ipcMain.handle('projects:pickDir', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(win, {
      title: '选择代码项目目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: picked.filePaths[0] };
  });

  /**
   * 跑代码。
   *
   * payload:
   *   runnerKey  运行器（groovy / python / pytest / maven）
   *   code       代码内容（临时文件模式）
   *   file       已有文件路径（可选，优先用这个）
   *   projectDir 项目目录（maven 用）
   *   testClass  测试类名（maven 用）
   *
   * 输出通过 runner:output 事件流式推送：
   *   { runId, stream: 'stdout'|'stderr', text }
   * 结束时推 runner:exit：
   *   { runId, code, signal, duration, timedOut }
   */
  ipcMain.handle('runner:run', async (e, payload = {}) => {
    assertUnlocked();
    const key = String(payload.runnerKey || '').trim();
    const conf = RUNNERS[key];
    if (!conf) return { ok: false, message: '不认识的运行器：' + key };

    const env = runner.detectAll();
    // JMeter 路径从 settings 取
    env.jmeter = settings.jmeterDir || '';

    // 手动指定的路径优先（设置 → 开发环境）
    if (settings.pythonPath) env.python = settings.pythonPath;
    if (settings.mvnPath) env.mvn = settings.mvnPath;

    // Maven 用 JAVA_HOME 决定 JDK 版本（不是 PATH 里的 java）。
    // 优先级：手动指定 > 按 pom.xml 版本自动选
    const projectDir = String(payload.projectDir || '').trim();
    if (settings.javaHome) {
      env.javaHome = settings.javaHome;
    } else if (key === 'maven' && projectDir) {
      const want = runner.readJavaVersion(projectDir);
      env.javaHome = runner.detectJavaHome(want);
    }

    // 代码内容 → 临时文件
    let file = String(payload.file || '').trim();
    let tmpFile = '';
    if (!file && payload.code) {
      const ext = conf.ext || '.txt';
      const tmpDir = path.join(app.getPath('temp'), 'test-tool-runner');
      fs.mkdirSync(tmpDir, { recursive: true });
      tmpFile = path.join(tmpDir, `run-${Date.now()}${ext}`);
      fs.writeFileSync(tmpFile, String(payload.code), 'utf8');
      file = tmpFile;
    }
    if (!file && conf.ext) {
      return { ok: false, message: '没有代码内容' };
    }

    const ctx = {
      java: env.java,
      python: env.python,
      mvn: env.mvn,
      jmeter: env.jmeter,
      projectDir: String(payload.projectDir || '').trim(),
      testClass: String(payload.testClass || '').trim(),
      file
    };

    const built = conf.build(ctx);
    if (built.error) {
      if (tmpFile) fs.rmSync(tmpFile, { force: true });
      return { ok: false, message: built.error };
    }

    // 先占位 runId，runner.run 内部会生成真正的 id
    let realRunId = '';
    realRunId = runner.run({
      cmd: built.cmd,
      args: built.args,
      cwd: built.cwd,
      // Maven 需要 JAVA_HOME 才能用对的 JDK
      env: env.javaHome ? { JAVA_HOME: env.javaHome } : undefined,
      timeout: Number(payload.timeout) || undefined,
      onData: (chunk) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('runner:output', { runId: realRunId, ...chunk });
        }
      },
      onExit: (result) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('runner:exit', { runId: realRunId, ...result });
        }
        if (tmpFile) {
          try {
            fs.rmSync(tmpFile, { force: true });
          } catch (err) {
            /* ignore */
          }
        }
      }
    });

    return { ok: true, runId: realRunId, cmd: built.cmd, args: built.args, cwd: built.cwd };
  });

  /** 取消正在跑的任务 */
  ipcMain.handle('runner:cancel', async (e, { runId } = {}) => {
    assertUnlocked();
    return { ok: runner.cancel(String(runId || '')) };
  });

  ipcMain.handle('jmx:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const dir = (root && String(root).trim()) || settings.jmxDir;
    const bat = detectJmeter();
    const version = bat ? jmeterVersionOf(bat) : '';
    const res = jmxIndex.scanJmx(dir, { jmeterVersion: version });
    res.jmeter = { path: bat, version, found: !!bat };
    return res;
  });

  ipcMain.handle('jmx:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  ipcMain.handle('jmx:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    // showItemInFolder 要的是「文件」，传目录会打开它的父目录。
    // 这里传进来的可能是目录（打开目录按钮）也可能是文件（定位脚本），分开处理。
    const target = String(file);
    if (!fs.existsSync(target)) return { ok: false, message: '路径不存在：' + target };
    const isDir = fs.statSync(target).isDirectory();
    if (isDir) {
      const err = await shell.openPath(target);
      return { ok: !err, message: err || '', dir: target };
    }
    shell.showItemInFolder(target);
    return { ok: true, dir: path.dirname(target) };
  });

  /** 不带 jmx 直接启动 JMeter GUI（空工作台，用户自己 Open） */
  ipcMain.handle('jmx:launch', async () => {
    assertUnlocked();
    return launchJmeter('');
  });

  /** 用 JMeter GUI 打开某个 jmx（想法 1：一键启动并加载） */
  ipcMain.handle('jmx:openGui', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, code: 'NO_FILE', message: '缺少脚本路径' };
    return launchJmeter(String(file));
  });

  ipcMain.handle('jmx:pickDir', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择 jmx 目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.jmxDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.jmxDir };
  });

  ipcMain.handle('jmx:pickJmeter', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择 jmeter.bat',
      properties: ['openFile'],
      filters: [{ name: 'JMeter 启动脚本', extensions: ['bat', 'cmd', 'sh'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.jmeterPath = result.filePaths[0];
    saveSettings();
    return { ok: true, path: settings.jmeterPath, version: jmeterVersionOf(settings.jmeterPath) };
  });

  // ---- 压测报告导入（jtl / statistics.json）----

  /** 扫描报告根目录，列出所有可导入的跑批 */
  ipcMain.handle('report:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const dir = (root && String(root).trim()) || settings.reportDir;
    return jtlReport.scanReportRoot(dir);
  });

  /** 选一个跑批目录，解析并返回预览（不写库） */
  ipcMain.handle('report:pick', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择压测结果目录（含 result.jtl 或 html-report）',
      properties: ['openDirectory'],
      defaultPath: settings.reportDir || undefined
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const dir = result.filePaths[0];
    try {
      const parsed = jtlReport.parseReportDir(dir);
      return { ok: true, report: parsed };
    } catch (err) {
      return { ok: false, message: (err && err.message) || '解析失败' };
    }
  });

  /** 解析指定目录（扫描列表里点某一条时用） */
  ipcMain.handle('report:parse', async (e, { dir } = {}) => {
    assertUnlocked();
    if (!dir) return { ok: false, message: '缺少目录' };
    try {
      return { ok: true, report: jtlReport.parseReportDir(String(dir)) };
    } catch (err) {
      return { ok: false, message: (err && err.message) || '解析失败' };
    }
  });

  ipcMain.handle('report:pickDir', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择压测报告根目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.reportDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.reportDir };
  });

  // ---- 知识库索引（只读，文件为准）----
  ipcMain.handle('kb:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const dir = (root && String(root).trim()) || settings.kbDir;
    return knowledge.scanKnowledge(dir, {});
  });

  ipcMain.handle('kb:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  ipcMain.handle('kb:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    const target = String(file);
    if (!fs.existsSync(target)) return { ok: false, message: '路径不存在：' + target };
    if (fs.statSync(target).isDirectory()) {
      const err = await shell.openPath(target);
      return { ok: !err, message: err || '', dir: target };
    }
    shell.showItemInFolder(target);
    return { ok: true, dir: path.dirname(target) };
  });

  ipcMain.handle('kb:pickDir', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择知识库目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.kbDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.kbDir };
  });

  // ---- 笔记索引（只读）+ 导入 md ----
  ipcMain.handle('notes:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const dir = (root && String(root).trim()) || settings.notesDir;
    return notesIndex.scanNotes(dir);
  });

  ipcMain.handle('notes:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  ipcMain.handle('notes:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    const target = String(file);
    if (!fs.existsSync(target)) return { ok: false, message: '路径不存在：' + target };
    if (fs.statSync(target).isDirectory()) {
      const err = await shell.openPath(target);
      return { ok: !err, message: err || '', dir: target };
    }
    shell.showItemInFolder(target);
    return { ok: true, dir: path.dirname(target) };
  });

  ipcMain.handle('notes:pickDir', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择笔记目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.notesDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.notesDir };
  });

  /**
   * 导入 md：选文件 → 移动到笔记目录。
   * 先返回待确认清单（含冲突情况），界面确认后才真正移动。
   */
  ipcMain.handle('notes:pickImport', async () => {
    assertUnlocked();
    const result = await dialog.showOpenDialog(win, {
      title: '选择要导入的 markdown 文件（会移动到笔记目录）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };

    const root = settings.notesDir;
    const items = result.filePaths.map((f) => {
      const baseName = path.basename(f);
      const target = path.join(root, baseName);
      return {
        from: f,
        name: baseName,
        target,
        conflict: fs.existsSync(target),
        samePlace: path.resolve(f) === path.resolve(target)
      };
    });
    return { ok: true, root, items };
  });

  ipcMain.handle('notes:import', async (e, { files, onConflict } = {}) => {
    assertUnlocked();
    const res = notesIndex.importNotes(files, settings.notesDir, onConflict);
    return Object.assign({ ok: true, dir: settings.notesDir }, res);
  });

  // ---- 应用内更新（检查 / 下载 / 安装）----
  ipcMain.handle('update:check', async (e, { force } = {}) => updater.checkUpdate(!!force));

  ipcMain.handle('update:download', async (e, { asset } = {}) => {
    const res = await updater.download(asset, (info) => {
      try {
        if (win && !win.isDestroyed()) win.webContents.send('update:progress', info);
      } catch (err) {
        /* ignore */
      }
    });
    return res;
  });

  ipcMain.handle('update:cancel', async () => updater.cancel());

  ipcMain.handle('update:cleanup', async () => updater.cleanup());

  ipcMain.handle('update:install', async (e, { file } = {}) => {
    const res = await updater.install(file);
    if (res.ok) {
      // 安装器已启动，自己退出让出文件占用
      logStartup('update install started, quitting');
      setTimeout(() => {
        app.isQuitting = true;
        app.quit();
      }, 600);
    }
    return res;
  });

  // ---- 接口只读镜像：Apifox 导出的 openapi.json → 幂等 upsert ----
  ipcMain.handle('apis:sync', async (e, payload = {}) => {
    assertUnlocked();
    let file = payload && payload.file ? String(payload.file) : '';
    if (!file) {
      const picked = await dialog.showOpenDialog(win, {
        title: '选择 Apifox 导出的 openapi.json',
        filters: [{ name: 'OpenAPI JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      file = picked.filePaths[0];
    }
    try {
      const st = fs.statSync(file);
      if (st.size > 40 * 1024 * 1024) {
        return { ok: false, message: '文件超过 40MB，先在 Apifox 里只导出要测的目录再同步' };
      }
      const raw = fs.readFileSync(file, 'utf8');
      let doc;
      try {
        doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      } catch (err) {
        return { ok: false, message: 'JSON 解析失败：' + ((err && err.message) || err) };
      }
      const parsed = openapi.parseOpenApi(doc);
      const stats = store.syncApis({ items: parsed.items });
      store.persist(); // 同步是个"大事"，立刻落盘，不等 400ms 防抖
      return { ok: true, file, doc: parsed.doc, stats, dup: parsed.stats.dup };
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  });

  // ---- 上次同步的变更（关掉卡片后还能从列表页重新打开影响面清单） ----
  ipcMain.handle('apis:lastSync', async () => {
    assertUnlocked();
    return store.lastSyncChanges();
  });

  // ---- 用例 ↔ 接口关联（映射关系，软键，空关联是合法状态） ----
  ipcMain.handle('links:forApi', async (e, { apiId } = {}) => {
    assertUnlocked();
    return store.links.forApi(apiId);
  });

  ipcMain.handle('links:forCase', async (e, { filePath, caseTitle } = {}) => {
    assertUnlocked();
    return store.links.forCase(filePath, caseTitle);
  });

  ipcMain.handle('links:counts', async () => {
    assertUnlocked();
    return store.links.counts();
  });

  ipcMain.handle('links:save', async (e, { apiId, targets } = {}) => {
    assertUnlocked();
    return store.links.save({ apiId, targets });
  });

  ipcMain.handle('links:add', async (e, payload) => {
    assertUnlocked();
    return store.links.add(payload || {});
  });

  ipcMain.handle('links:remove', async (e, { id } = {}) => {
    assertUnlocked();
    return store.links.remove(id);
  });

  ipcMain.handle('links:prune', async () => {
    assertUnlocked();
    return store.links.prune();
  });
}

app.whenReady().then(async () => {
  logStartup('=== app ready, version=' + app.getVersion() + ' ===');
  try {
    await store.init(DATA_DIR);
    logStartup('store init ok, db=' + store.dbPath);
    loadSettings();
    logStartup('settings loaded, casesDir=' + settings.casesDir);
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