'use strict';
/**
 * ipc-app.js —— 应用生命周期 / 锁屏 / PIN 域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 锁状态（locked）和设置对象（settings）都活在 main.js 里，
 * 这里只通过 deps 的取值/赋值函数访问，不自己缓存。
 */
const security = require('../security');
const { TOOLS } = require('../../shared/collections');

function register(deps) {
  const { ipcMain, app, store, path, getSettings, saveSettings, setLocked, isLocked, publicSettings, detectJmeter } = deps;

  ipcMain.handle('app:init', async () => {
    // 启动时探一次 JMeter，探到就落盘，设置页才看得见
    try {
      detectJmeter();
    } catch (e) {
      /* 探测失败不影响启动 */
    }
    return {
      locked: isLocked(),
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
    setLocked(true);
    return true;
  });

  ipcMain.handle('app:unlock', async (e, { pin }) => {
    const settings = getSettings();
    if (!settings.pin) {
      setLocked(false);
      return { ok: true };
    }
    const ok = security.verifyPin(pin, settings.pin.salt, settings.pin.hash);
    if (ok) setLocked(false);
    return { ok, hasPin: true };
  });

  ipcMain.handle('pin:set', async (e, { oldPin, pin }) => {
    if (!pin || String(pin).length < 4) return { ok: false, message: '密码至少 4 位' };
    const settings = getSettings();
    if (settings.pin) {
      const ok = security.verifyPin(oldPin, settings.pin.salt, settings.pin.hash);
      if (!ok) return { ok: false, message: '原密码不对' };
    }
    settings.pin = security.hashPin(pin);
    saveSettings();
    setLocked(false);
    return { ok: true };
  });

  ipcMain.handle('pin:clear', async (e, { pin }) => {
    const settings = getSettings();
    if (settings.pin && !security.verifyPin(pin, settings.pin.salt, settings.pin.hash)) {
      return { ok: false, message: '密码不对' };
    }
    settings.pin = null;
    saveSettings();
    return { ok: true };
  });
}

module.exports = { register };