'use strict';
/**
 * ipc-jtl.js —— 压测报告（jtl / statistics.json）域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 通道前缀是 report:（历史原因，前端一直这么调），不是 jtl:。
 */
const jtlReport = require('../jtl');

function register(deps) {
  const { ipcMain, dialog, getWindow, getSettings, saveSettings, assertUnlocked } = deps;

  // ---- 压测报告导入（jtl / statistics.json）----

  /** 扫描报告根目录，列出所有可导入的跑批 */
  ipcMain.handle('report:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.reportDir;
    return jtlReport.scanReportRoot(dir);
  });

  /** 选一个跑批目录，解析并返回预览（不写库） */
  ipcMain.handle('report:pick', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
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
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择压测报告根目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.reportDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.reportDir };
  });
}

module.exports = { register };