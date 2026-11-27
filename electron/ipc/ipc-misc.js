'use strict';
/**
 * ipc-misc.js —— 零散但各自独立的小通道。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 包含：剪贴板、应用内更新、接口只读镜像（Apifox 同步）。
 * 这几个功能都不够大，单独开域反而更碎，先放这里。
 */
const updater = require('../updater');
const openapi = require('../openapi');

/**
 * 敏感内容复制后的清空定时器。
 *
 * 原来挂在 main.js 顶层，只有 clipboard:copy 用；
 * 现在它跟着通道一起搬过来，模块级单例，语义不变
 * （连续复制时取消上一个定时器，只保留最后一次）。
 */
let clipboardTimer = null;

function register(deps) {
  const {
    handle,
    app,
    dialog,
    store,
    fs,
    path,
    clipboard,
    getWindow,
    getSettings,
    assertUnlocked,
    assertPathIn,
    rememberPicked,
    logStartup
  } = deps;

  handle('clipboard:copy', async (e, { text, secret }) => {
    const value = String(text === undefined || text === null ? '' : text);
    clipboard.writeText(value);
    if (secret) {
      const settings = getSettings();
      const secs = Number(settings.clipboardClearSeconds || 0);
      if (clipboardTimer) clearTimeout(clipboardTimer);
      if (secs > 0) {
        clipboardTimer = setTimeout(() => {
          try {
            if (clipboard.readText() === value) clipboard.clear();
          } catch (err) {
            /* ignore */
          }
        }, secs * 1000);
      }
    }
    return true;
  });

  // ---- 应用内更新（检查 / 下载 / 安装）----
  handle('update:check', async (e, { force } = {}) => updater.checkUpdate(!!force));

  handle('update:download', async (e, { asset } = {}) => {
    const res = await updater.download(asset, (info) => {
      try {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('update:progress', info);
      } catch (err) {
        /* ignore */
      }
    });
    return res;
  });

  handle('update:cancel', async () => updater.cancel());

  handle('update:cleanup', async () => updater.cleanup());

  handle('update:install', async (e, { file } = {}) => {
    const res = await updater.install(file);
    if (res.ok) {
      // 安装器已启动，自己退出让出文件占用
      logStartup('update install started, quitting');
      setTimeout(() => {
        app.isQuitting = true;
        app.quit();
      }, 600);
    }
    return res;
  });

  // ---- 接口只读镜像：Apifox 导出的 openapi.json → 幂等 upsert ----
  handle('apis:sync', async (e, payload = {}) => {
    assertUnlocked();
    let file = payload && payload.file ? String(payload.file) : '';
    /**
     * 入参守卫（v0.50.0）：file 是渲染进程直接给的路径，
     * 不校验就能让主进程读任意文件（还能把里面解析出来的内容写进库）。
     * 只认白名单目录内的文件 —— 走 dialog 选的文件会被记进白名单，正常流程不受影响。
     */
    if (file) {
      const bad = assertPathIn(file);
      if (bad) return bad;
    } else {
      const picked = await dialog.showOpenDialog(getWindow(), {
        title: '选择 Apifox 导出的 openapi.json',
        filters: [{ name: 'OpenAPI JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      file = picked.filePaths[0];
      // 用户明确选过的文件 → 本会话可信根（同一次会话里再同步不用重选）
      rememberPicked(file);
    }
    try {
      const st = fs.statSync(file);
      if (st.size > 40 * 1024 * 1024) {
        return { ok: false, message: '文件超过 40MB，先在 Apifox 里只导出要测的目录再同步' };
      }
      const raw = fs.readFileSync(file, 'utf8');
      let doc;
      try {
        doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      } catch (err) {
        return { ok: false, message: 'JSON 解析失败：' + ((err && err.message) || err) };
      }
      const parsed = openapi.parseOpenApi(doc);
      // 解析层去重掉的条目（同一个文件里同方法同地址）也要进 stats，
      // 否则结果卡片只能报「重复 N 条」，说不出重复的是哪几个
      const stats = store.syncApis({
        items: parsed.items,
        dupList: parsed.stats.dupList,
        dupCount: parsed.stats.dup
      });
      store.persist(); // 同步是个"大事"，立刻落盘，不等 400ms 防抖
      return { ok: true, file, doc: parsed.doc, stats, dup: parsed.stats.dup };
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  });

  // ---- 上次同步的变更（关掉卡片后还能从列表页重新打开影响面清单） ----
  handle('apis:lastSync', async () => {
    assertUnlocked();
    return store.lastSyncChanges();
  });
}

module.exports = { register };