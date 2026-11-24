'use strict';
/**
 * ipc-allure.js —— Allure 报告解析域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 解析 allure-results → 失败聚类 + Flaky 追踪。
 */
const allure = require('../allure');

function register(deps) {
  const { ipcMain, dialog, getWindow, getSettings, assertUnlocked } = deps;

  /** 扫描根目录下所有 allure-results */
  ipcMain.handle('allure:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    // 优先级：显式传的 root > 设置里的 allureDir > 项目目录
    const dir =
      (root && String(root).trim()) || settings.allureDir || settings.projectDir || '';
    return allure.scanAllureRoots(dir);
  });

  /** 选 allure-results 目录 */
  ipcMain.handle('allure:pickDir', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择 allure-results 目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: picked.filePaths[0] };
  });

  /**
   * 解析 allure-results 目录。
   *
   * 返回：用例列表 + 汇总 + 失败聚类。
   */
  ipcMain.handle('allure:parse', async (e, { dir } = {}) => {
    assertUnlocked();
    const d = String(dir || '').trim();
    if (!d) return { ok: false, message: '缺少目录' };
    const res = allure.parseAllureDir(d);
    if (!res.ok) return res;
    return Object.assign({}, res, {
      clusters: allure.clusterFailures(res.tests)
    });
  });

  /**
   * Flaky 追踪：解析多个 allure-results 目录，比对同一用例的通过/失败。
   *
   * payload: { dirs: string[] }
   */
  ipcMain.handle('allure:flaky', async (e, { dirs } = {}) => {
    assertUnlocked();
    const list = Array.isArray(dirs) ? dirs : [];
    if (!list.length) return { ok: false, message: '缺少目录列表', flaky: [] };

    const runs = [];
    const errors = [];
    for (const d of list) {
      const res = allure.parseAllureDir(String(d));
      if (res.ok) runs.push(res.tests);
      else errors.push({ dir: d, message: res.message });
    }

    return {
      ok: true,
      runs: runs.length,
      flaky: allure.trackFlaky(runs),
      errors
    };
  });
}

module.exports = { register };