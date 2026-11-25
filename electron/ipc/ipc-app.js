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
  const { handle, app, store, path, getSettings, saveSettings, setLocked, isLocked, publicSettings, detectJmeter } = deps;

  handle('app:init', async () => {
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

  handle('app:info', async () => ({
    version: app.getVersion(),
    schemaVersion: store.schemaVersion(),
    dataDir: path.dirname(store.dbPath),
    dbPath: store.dbPath,
    backupDir: store.backupDir,
    encryptionAvailable: security.available(),
    backups: store.listBackups()
  }));

  handle('app:lock', async () => {
    setLocked(true);
    return true;
  });

  handle('app:unlock', async (e, { pin }) => {
    const settings = getSettings();
    if (!settings.pin) {
      setLocked(false);
      return { ok: true };
    }
    const ok = security.verifyPin(pin, settings.pin.salt, settings.pin.hash);
    if (ok) setLocked(false);
    return { ok, hasPin: true };
  });

  handle('pin:set', async (e, { oldPin, pin }) => {
    if (!pin || String(pin).length < 4) return { ok: false, message: '密码至少 4 位' };
    const settings = getSettings();
    if (settings.pin) {
      /**
       * 已有密码时必须验原密码。
       *
       * 空值和「填错了」分开报：前端原来把 oldPin 复用给「移除」按钮，
       * 用户看到的就是一句笼统的「原密码不对」，根本不知道是框没填还是密码记错。
       */
      const old = String(oldPin === undefined || oldPin === null ? '' : oldPin);
      if (!old.trim()) return { ok: false, message: '请输入原密码' };
      const ok = security.verifyPin(old, settings.pin.salt, settings.pin.hash);
      if (!ok) return { ok: false, message: '原密码不对' };
    }
    settings.pin = security.hashPin(pin);
    saveSettings();
    setLocked(false);
    return { ok: true, hasPin: true };
  });

  /**
   * 清除锁屏密码。
   *
   * 后端兜底（v0.43.1）：
   *   - 没有密码时直接成功（幂等）——「本来就没密码」不该报错；
   *   - 有密码时必须验证。前端老实现拿 oldPin（设置完就被清空）来调这个通道，
   *     于是「设置密码 → 移除密码」必然报「密码不对」，用户以为密码坏了；
   *   - 空值和填错分开报，前端才能给出「请输入当前密码」而不是「密码不对」。
   */
  handle('pin:clear', async (e, payload) => {
    const settings = getSettings();
    // 兼容两种调用：{ pin } 对象（preload 的正常形态）和直接传字符串
    const raw = payload && typeof payload === 'object' ? payload.pin : payload;
    const pin = String(raw === undefined || raw === null ? '' : raw);

    if (!settings.pin) return { ok: true, hasPin: false };
    if (!pin.trim()) return { ok: false, message: '请输入当前密码' };
    if (!security.verifyPin(pin, settings.pin.salt, settings.pin.hash)) {
      return { ok: false, message: '密码不对' };
    }
    settings.pin = null;
    saveSettings();
    return { ok: true, hasPin: false };
  });
}

module.exports = { register };