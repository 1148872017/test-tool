/* 真实加载 main.js，确认 registerIpc() 不抛异常（0.41.0 启动崩溃的回归测试） */
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-test-'));
process.env.TT_DATA_DIR = tmp;
process.env.TT_NO_DEMO = '1';
delete process.env.TT_DEBUG;

const handlers = {};
const clip = { value: '' };

const fakeElectron = {
  app: {
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getPath(p) {
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
      return '0.1.0';
    },
    commandLine: { appendSwitch() {} }
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send() {}, on() {}, toggleDevTools() {} };
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
      if (handlers[channel]) {
        throw new Error("Attempted to register a second handler for '" + channel + "'");
      }
      handlers[channel] = fn;
    }
  },
  clipboard: {
    writeText(t) {
      clip.value = String(t);
    },
    readText() {
      return clip.value;
    },
    clear() {
      clip.value = '';
    }
  },
  shell: { openExternal: async () => true, openPath: async () => '' },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
  Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
  globalShortcut: { register() {}, unregisterAll() {} },
  dialog: {
    showErrorBox(title, msg) {
      console.error('DIALOG', title, msg);
    },
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true })
  },
  nativeImage: { createFromPath() { return {}; } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  }
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

(async () => {
  let crashed = null;
  try {
    require('D:/AI_Workspace/Project/test-tool/electron/main.js');
    // 等 whenReady 跑完 registerIpc
    await new Promise((r) => setTimeout(r, 2500));
  } catch (e) {
    crashed = String(e && e.message);
  }

  check('main.js 加载不抛异常', !crashed, crashed);
  check('注册了 handler', Object.keys(handlers).length > 90, Object.keys(handlers).length);

  /* 关键通道存在 */
  for (const ch of ['data:openDir', 'data:openWorkspace', 'data:genFile', 'codescan:modules', 'demo:count']) {
    check('通道存在：' + ch, !!handlers[ch], 'missing');
  }

  /* 两个 open 通道语义分开 */
  check('data:openDir 和 data:openWorkspace 是两个', handlers['data:openDir'] !== handlers['data:openWorkspace'], 'same fn');

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('===== 启动回归测试 =====');
  console.log('handler 数:', Object.keys(handlers).length);
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('崩了:', e && e.message);
  process.exit(1);
});