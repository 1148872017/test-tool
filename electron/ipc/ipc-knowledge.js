'use strict';
/**
 * ipc-knowledge.js —— 知识库 + 笔记索引域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 两边都是「文件为准、只读索引」，只是根目录不同；
 * 笔记多了「导入 md（先返回待确认清单，确认后才移动）」。
 */
const knowledge = require('../knowledge');
const notesIndex = require('../notes');
const { acceptScanRoot } = require('../shared-helpers');

function register(deps) {
  const {
    handle,
    dialog,
    shell,
    fs,
    path,
    getWindow,
    getSettings,
    saveSettings,
    assertUnlocked,
    assertPathIn,
    rememberPicked
  } = deps;

  // ---- 知识库索引（只读，文件为准）----
  handle('kb:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.kbDir;
    /**
     * 扫描根守卫 + 记进会话白名单（v0.50.0 的 P0 修复）：
     * 这一步原来在 ipc-guard 的包装层无条件做（root 不校验），
     * 传一次 root='C:\' 就能把全盘登记成本会话可信根。
     * 现在只有「存在、是目录、不是盘符根/系统目录」的根才会被记住。
     */
    const badSeed = acceptScanRoot(dir);
    if (badSeed) return badSeed;
    return knowledge.scanKnowledge(dir, {});
  });

  handle('kb:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    // 入参守卫：只允许打开白名单目录内的文件（v0.43.0）
    const bad = assertPathIn(String(file));
    if (bad) return bad;
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  handle('kb:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    const target = String(file);
    const bad = assertPathIn(target);
    if (bad) return bad;
    if (!fs.existsSync(target)) return { ok: false, message: '路径不存在：' + target };
    if (fs.statSync(target).isDirectory()) {
      const err = await shell.openPath(target);
      return { ok: !err, message: err || '', dir: target };
    }
    shell.showItemInFolder(target);
    return { ok: true, dir: path.dirname(target) };
  });

  handle('kb:pickDir', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择知识库目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.kbDir = result.filePaths[0];
    saveSettings();
    rememberPicked(settings.kbDir);
    return { ok: true, dir: settings.kbDir };
  });

  // ---- 笔记索引（只读）+ 导入 md ----
  handle('notes:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.notesDir;
    // 扫描根守卫 + 记进会话白名单（v0.50.0，同 kb:scan）
    const badSeed = acceptScanRoot(dir);
    if (badSeed) return badSeed;
    return notesIndex.scanNotes(dir);
  });

  handle('notes:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const bad = assertPathIn(String(file));
    if (bad) return bad;
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  handle('notes:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    const target = String(file);
    const bad = assertPathIn(target);
    if (bad) return bad;
    if (!fs.existsSync(target)) return { ok: false, message: '路径不存在：' + target };
    if (fs.statSync(target).isDirectory()) {
      const err = await shell.openPath(target);
      return { ok: !err, message: err || '', dir: target };
    }
    shell.showItemInFolder(target);
    return { ok: true, dir: path.dirname(target) };
  });

  handle('notes:pickDir', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择笔记目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.notesDir = result.filePaths[0];
    saveSettings();
    rememberPicked(settings.notesDir);
    return { ok: true, dir: settings.notesDir };
  });

  /**
   * 导入 md：选文件 → 移动到笔记目录。
   * 先返回待确认清单（含冲突情况），界面确认后才真正移动。
   */
  handle('notes:pickImport', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择要导入的 markdown 文件（会移动到笔记目录）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };

    const root = settings.notesDir;
    // 用户明确选过的文件 → 本会话可信根（导入时要读它们）
    for (const f of result.filePaths) rememberPicked(f);
    const items = result.filePaths.map((f) => {
      const baseName = path.basename(f);
      const target = path.join(root, baseName);
      return {
        from: f,
        name: baseName,
        target,
        conflict: fs.existsSync(target),
        samePlace: path.resolve(f) === path.resolve(target)
      };
    });
    return { ok: true, root, items };
  });

  handle('notes:import', async (e, { files, onConflict } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    /**
     * 入参守卫（v0.50.0）：这条通道会 **把用户的文件 rename 进来**，
     * 不校验等于「渲染进程说搬哪个就搬哪个」—— 是全仓最危险的一处。
     * 逐个校验，有一个越界就整单拒绝（和 allure:flaky 同一套口径：
     * 不静默跳过，否则用户会以为少导了几篇，还找不到原因）。
     *
     * 正常流程不会踩到：notes:pickImport 选完文件就把它们记进会话白名单了。
     */
    const list = Array.isArray(files) ? files : [];
    for (const f of list) {
      const badFile = assertPathIn(String(f));
      if (badFile) return badFile;
    }
    const res = notesIndex.importNotes(list, settings.notesDir, onConflict);
    return Object.assign({ ok: true, dir: settings.notesDir }, res);
  });
}

module.exports = { register };