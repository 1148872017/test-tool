'use strict';
/**
 * ipc-demo.js —— 示例数据域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 示例数据只在首次启动写一次（写库的时机在 main.js 的 whenReady 里），
 * 这里只负责「数条数 / 清除 / 给出配套文件路径」。
 */
const demo = require('../demo');

function register(deps) {
  const { ipcMain, store, path, dataDir, assertUnlocked } = deps;

  /* ==================== 示例数据 ==================== *
   * 首次启动写入 11 条示例（可一键清除）。
   * ------------------------------------------------ */

  /** 示例记录条数（0 = 已经清掉了） */
  ipcMain.handle('demo:count', async () => {
    assertUnlocked();
    try {
      return { ok: true, count: demo.countDemo(store) };
    } catch (e) {
      return { ok: false, count: 0, message: String(e && e.message) };
    }
  });

  /** 清除所有示例数据（记录 + 配套文件） */
  ipcMain.handle('demo:clear', async () => {
    assertUnlocked();
    try {
      const demoRoot = path.join(dataDir, 'demo');
      const res = demo.clearDemo(store, demoRoot);
      store.persist();
      return { ok: true, removed: res.removed, errors: res.errors };
    } catch (e) {
      return { ok: false, message: String(e && e.message) };
    }
  });

  /** 示例配套文件的路径（代码体检 / 报告分析可以直接用） */
  ipcMain.handle('demo:paths', async () => {
    assertUnlocked();
    const demoRoot = path.join(dataDir, 'demo');
    return {
      ok: true,
      project: path.join(demoRoot, 'project'),
      allure: path.join(demoRoot, 'allure-results')
    };
  });
}

module.exports = { register };