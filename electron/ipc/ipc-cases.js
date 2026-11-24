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
  const { handle, dialog, shell, getWindow, getSettings, saveSettings, assertUnlocked, assertPathIn, rememberPicked } = deps;

  // ---- 用例索引（只读，文件为准） ----
  handle('cases:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.casesDir;
    return caseIndex.scanCases(dir, {});
  });

  handle('cases:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    // 入参守卫：只打开白名单目录内的文件（v0.43.0）
    const bad = assertPathIn(String(file));
    if (bad) return bad;
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  handle('cases:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    const bad = assertPathIn(String(file));
    if (bad) return bad;
    shell.showItemInFolder(String(file));
    return { ok: true };
  });

  handle('cases:pickDir', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择用例目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.casesDir = result.filePaths[0];
    saveSettings();
    rememberPicked(settings.casesDir);
    return { ok: true, dir: settings.casesDir };
  });

  /* ==================== OpenAPI 文件直接解析 ==================== *
   * 只读文件生成代码骨架，**不写接口记录表**。
   * --------------------------------------------------------- */

  /** 选 OpenAPI 文件（json / yaml / yml） */
  handle('openapi:pickFile', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择 OpenAPI 文件',
      filters: [{ name: 'OpenAPI', extensions: ['json', 'yaml', 'yml'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 用户明确选过的文件 → 本会话可信根（openapi:parseFile 要读它）
    rememberPicked(picked.filePaths[0]);
    return { ok: true, file: picked.filePaths[0] };
  });

  /** 解析 OpenAPI 文件，返回接口列表（不写库） */
  handle('openapi:parseFile', async (e, { file } = {}) => {
    assertUnlocked();
    return openapifile.parseFile(String(file || ''));
  });
}

module.exports = { register };