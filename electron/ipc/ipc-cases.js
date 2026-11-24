'use strict';
/**
 * ipc-cases.js —— 用例索引 + OpenAPI 文件解析域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 用例索引用文件为准、只读；OpenAPI 文件解析也不写接口记录表
 * （要写库走 apis:sync，见 ipc-misc.js）。
 */
const caseIndex = require('../cases');
const openapifile = require('../openapifile');

function register(deps) {
  const { ipcMain, dialog, shell, getWindow, getSettings, saveSettings, assertUnlocked } = deps;

  // ---- 用例索引（只读，文件为准） ----
  ipcMain.handle('cases:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
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
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择用例目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.casesDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.casesDir };
  });

  /* ==================== OpenAPI 文件直接解析 ==================== *
   * 只读文件生成代码骨架，**不写接口记录表**。
   * --------------------------------------------------------- */

  /** 选 OpenAPI 文件（json / yaml / yml） */
  ipcMain.handle('openapi:pickFile', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择 OpenAPI 文件',
      filters: [{ name: 'OpenAPI', extensions: ['json', 'yaml', 'yml'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, file: picked.filePaths[0] };
  });

  /** 解析 OpenAPI 文件，返回接口列表（不写库） */
  ipcMain.handle('openapi:parseFile', async (e, { file } = {}) => {
    assertUnlocked();
    return openapifile.parseFile(String(file || ''));
  });
}

module.exports = { register };