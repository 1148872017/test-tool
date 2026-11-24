'use strict';
/**
 * ipc-allure.js —— Allure 报告解析域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 解析 allure-results → 失败聚类 + Flaky 追踪。
 */
const allure = require('../allure');

function register(deps) {
  const { handle, dialog, getWindow, getSettings, assertUnlocked, assertPathIn, rememberPicked } = deps;

  /** 扫描根目录下所有 allure-results */
  handle('allure:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    // 优先级：显式传的 root > 设置里的 allureDir > 项目目录
    const dir =
      (root && String(root).trim()) || settings.allureDir || settings.projectDir || '';
    return allure.scanAllureRoots(dir);
  });

  /** 选 allure-results 目录 */
  handle('allure:pickDir', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择 allure-results 目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 这个目录不写进 settings，必须记进会话白名单，否则随后的 allure:parse 会被守卫拦掉
    rememberPicked(picked.filePaths[0]);
    return { ok: true, dir: picked.filePaths[0] };
  });

  /**
   * 解析 allure-results 目录。
   *
   * 返回：用例列表 + 汇总 + 失败聚类。
   */
  handle('allure:parse', async (e, { dir } = {}) => {
    assertUnlocked();
    const d = String(dir || '').trim();
    if (!d) return { ok: false, message: '缺少目录' };
    // 入参守卫：只解析白名单目录（v0.43.0）
    const bad = assertPathIn(d);
    if (bad) return bad;
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
  handle('allure:flaky', async (e, { dirs } = {}) => {
    assertUnlocked();
    const list = Array.isArray(dirs) ? dirs : [];
    if (!list.length) return { ok: false, message: '缺少目录列表', flaky: [] };

    // 逐个校验：只要有一个越界就整单拒绝（不静默跳过，否则用户以为少了几次跑批）
    for (const d of list) {
      const bad = assertPathIn(String(d));
      if (bad) return Object.assign({}, bad, { flaky: [] });
    }

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