'use strict';
/**
 * ipc-codegen.js —— 代码骨架生成 + SQL 脚本生成域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * codegen:* 从接口记录 / JSON / 页面元素生成 Java/Python 骨架（纯模板替换，不做 AST）。
 * sqlgen:* 只生成 SQL，不连数据库、不执行。
 */
const codegen = require('../../shared/codegen');
const sqlgen = require('../../shared/sqlgen');

function register(deps) {
  const { ipcMain, dialog, store, fs, path, getWindow, assertUnlocked } = deps;

  /* ==================== 代码骨架生成 ==================== *
   * 从接口记录 / JSON / 页面元素生成 Java/Python 代码骨架。
   * 纯模板替换，不做 AST。
   * ---------------------------------------------------- */

  /** 可用的生成目标 */
  ipcMain.handle('codegen:targets', async () => {
    assertUnlocked();
    return { ok: true, targets: codegen.listTargets() };
  });

  /**
   * 生成代码（预览，不写文件）。
   *
   * payload:
   *   targetKey  生成目标（java-restassured / python-pytest / ...）
   *   apiId      接口记录 id（kind=api 用）
   *   page       页面信息（kind=page 用）
   *   json       JSON 文本（kind=model 用）
   *   className  类名（可选）
   */
  ipcMain.handle('codegen:preview', async (e, payload = {}) => {
    assertUnlocked();
    const targetKey = String(payload.targetKey || '').trim();
    if (!targetKey) return { ok: false, message: '缺少生成目标' };

    const input = {
      className: String(payload.className || '').trim(),
      page: payload.page,
      json: payload.json,
      sql: payload.sql
    };

    // 接口数据来源：优先 apiData（OpenAPI 文件解析结果），其次 apiId（查库）
    if (payload.apiData) {
      input.api = payload.apiData;
    } else if (payload.apiId) {
      const rec = store.get(String(payload.apiId));
      if (!rec) return { ok: false, message: '接口记录不存在' };
      input.api = rec.data;
    }

    return codegen.generate(targetKey, input);
  });

  /**
   * 生成并保存到文件。
   *
   * payload: 同 codegen:preview，另加
   *   dir  保存目录（空 = 弹选择框）
   */
  ipcMain.handle('codegen:save', async (e, payload = {}) => {
    assertUnlocked();
    const targetKey = String(payload.targetKey || '').trim();
    if (!targetKey) return { ok: false, message: '缺少生成目标' };

    const input = {
      className: String(payload.className || '').trim(),
      page: payload.page,
      json: payload.json,
      sql: payload.sql
    };
    if (payload.apiData) {
      input.api = payload.apiData;
    } else if (payload.apiId) {
      const rec = store.get(String(payload.apiId));
      if (!rec) return { ok: false, message: '接口记录不存在' };
      input.api = rec.data;
    }

    const gen = codegen.generate(targetKey, input);
    if (!gen.ok) return gen;

    // 选目录
    let dir = String(payload.dir || '').trim();
    if (!dir) {
      const picked = await dialog.showOpenDialog(getWindow(), {
        title: '选择保存目录',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      dir = picked.filePaths[0];
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, gen.filename);
      fs.writeFileSync(full, gen.code, 'utf8');
      return { ok: true, file: full, filename: gen.filename };
    } catch (err) {
      return { ok: false, message: '写文件失败：' + (err && err.message) };
    }
  });

  /* ==================== MySQL 快照 / 清理 SQL ==================== *
   * 只生成 SQL，不连数据库、不执行。
   * ---------------------------------------------------------- */

  ipcMain.handle('sqlgen:snapshot', async (e, payload = {}) => {
    assertUnlocked();
    return sqlgen.genSnapshot(payload);
  });

  ipcMain.handle('sqlgen:cleanup', async (e, payload = {}) => {
    assertUnlocked();
    return sqlgen.genCleanup(payload);
  });

  ipcMain.handle('sqlgen:restore', async (e, payload = {}) => {
    assertUnlocked();
    return sqlgen.genRestore(payload);
  });

  ipcMain.handle('sqlgen:listBackups', async (e, { tables } = {}) => {
    assertUnlocked();
    return { ok: true, list: sqlgen.listBackupTables(tables) };
  });
}

module.exports = { register };