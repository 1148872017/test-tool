'use strict';
/**
 * ipc-env.js —— 本机环境 / 通用工具域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 只有跟「系统交互但不属于某个业务流程」的通道放这里：
 * 通用文件/目录选择器、哈希、打开外部链接。
 */
const crypto = require('crypto');

function register(deps) {
  const { handle, dialog, shell, getWindow, assertUnlocked, rememberPicked } = deps;

  /**
   * 通用文件选择器（给「手动指定环境路径」用）。
   *
   * payload:
   *   title    对话框标题
   *   filters  文件类型过滤（[{name, extensions}]）
   *   defaultPath 默认路径
   */
  /**
   * 通用目录选择器（给「工作区目录」这种跨模块配置用）。
   *
   * payload: { title, defaultPath }
   */
  handle('util:pickDir', async (e, payload = {}) => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: String(payload.title || '选择目录'),
      defaultPath: String(payload.defaultPath || ''),
      properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 用户明确选过的目录 → 本会话可信根（后面可能有 openFile/parse 用它）
    rememberPicked(picked.filePaths[0]);
    return { ok: true, dir: picked.filePaths[0] };
  });

  handle('util:pickFile', async (e, payload = {}) => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: String(payload.title || '选择文件'),
      defaultPath: String(payload.defaultPath || ''),
      filters: Array.isArray(payload.filters) ? payload.filters : undefined,
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 例如「手动指定 jmeter.bat / Maven / python」—— 选完就在白名单里
    rememberPicked(picked.filePaths[0]);
    return { ok: true, path: picked.filePaths[0] };
  });

  handle('util:hash', async (e, { algo, text }) => {
    const allowed = ['md5', 'sha1', 'sha256', 'sha512'];
    const name = String(algo || 'sha256').toLowerCase();
    const use = allowed.includes(name) ? name : 'sha256';
    return crypto.createHash(use).update(String(text === undefined ? '' : text), 'utf8').digest('hex');
  });

  handle('shell:open', async (e, { url }) => {
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
}

module.exports = { register };