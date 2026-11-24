'use strict';
/**
 * ipc-links.js —— 用例 ↔ 接口关联（映射关系）域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 关联是软键：接口/用例被删掉后关联由 links:prune 清理。
 */
function register(deps) {
  const { ipcMain, store, assertUnlocked } = deps;

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

module.exports = { register };