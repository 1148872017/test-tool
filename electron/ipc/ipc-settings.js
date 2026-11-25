'use strict';
/**
 * ipc-settings.js —— 设置 / 皮肤（背景图）域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 皮肤的图片文件存在 {数据目录}/skin/ 下，设置里只存文件名。
 */
const sharedHelpers = require('../shared-helpers');
const workspaceDerive = require('../workspace-derive');

function register(deps) {
  const {
    handle,
    dialog,
    fs,
    path,
    store,
    app,
    getWindow,
    getSettings,
    saveSettings,
    publicSettings,
    assertUnlocked,
    resolveDataDir
  } = deps;

  /** 皮肤目录 */
  const skinDir = () => path.join(resolveDataDir(), 'skin');

  handle('settings:get', async () => publicSettings());

  handle('settings:set', async (e, patch) => {
    const settings = getSettings();
    const allowed = ['autoLockMinutes', 'clipboardClearSeconds', 'openCopyPassword', 'closeAction', 'workspaceDir', 'casesDir', 'jmxDir', 'jmeterPath', 'reportDir', 'allureDir', 'kbDir', 'notesDir', 'projectDir', 'javaHome', 'pythonPath', 'mvnPath', 'themeColor', 'bgImage', 'bgOpacity', 'bgTextMode', 'bgOverlay', 'bgOverlayColor', 'backupKeep'];
    for (const key of allowed) {
      if (patch && patch[key] !== undefined) settings[key] = patch[key];
    }

    /**
     * 备份保留份数：收成 1..100 的整数并**立刻生效**。
     *
     * 为什么要在这里落一次，而不是只在启动时读：
     *   数据层的 pruneBackups() 读的是 store 里的模块级变量，jmx 写回读的是
     *   getSettings().backupKeep —— 用户刚改完就点「立即备份」或写回 jmx，
     *   必须用新值，不能等下一次启动。
     * 顺便把规范化后的值写回 settings，界面上显示的就是真正生效的数。
     */
    if (patch && patch.backupKeep !== undefined) {
      settings.backupKeep = store.setBackupKeep(settings.backupKeep);
    }

    /**
     * 工作区变了 → 立刻重新推导 7 个子目录，并把缺的目录建出来。
     *
     * 为什么必须在这里做：
     *   老实现的推导只在 main.js 的 loadSettings() 里，也就是**启动时跑一次**。
     *   用户在设置页改了工作区，settings:set 存完就返回了，子目录一个都没重算，
     *   界面上还是旧值 —— 用户看到的就是「设置了工作区，子目录纹丝不动」。
     *
     * 推导结果会写回 settings 并 saveSettings()：
     *   publicSettings() 要给前端显示 casesDir / notesDir ……，不写回 UI 就是空的。
     * 但「写回」和「用户配置」是两回事，靠 settings.derivedDirs 这本账区分：
     *   账上的值可以随工作区重算，用户显式填的路径一个字都不动（详见 workspace-derive.js）。
     *
     * 建目录失败（比如把工作区挂在只读盘）只记录在 dirSync.failed 里，不阻塞保存。
     */
    let dirSync = null;
    if (workspaceDerive.needsWorkspaceSync(patch)) {
      dirSync = workspaceDerive.applyWorkspaceChange(settings, patch, {
        defaultBase: workspaceDerive.defaultWorkspaceDir(app)
      });
    }

    saveSettings();
    const out = publicSettings();
    // 只有这次真的动了工作区才带 dirSync，前端据此决定 toast 文案
    if (dirSync) out.dirSync = dirSync;
    return out;
  });

  /** 选背景图（复制到皮肤目录） */
  handle('skin:pickImage', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择背景图',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

    const src = picked.filePaths[0];
    try {
      const st = fs.statSync(src);
      if (st.size > 20 * 1024 * 1024) {
        return { ok: false, message: '图片超过 20MB，请压缩后再选' };
      }
      const dir = skinDir();
      fs.mkdirSync(dir, { recursive: true });
      // 用固定文件名（覆盖旧的），保留扩展名
      const ext = path.extname(src).toLowerCase() || '.png';
      const name = 'bg' + ext;
      const dest = path.join(dir, name);
      // 删掉旧的（可能是别的扩展名）
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('bg.')) fs.rmSync(path.join(dir, f), { force: true });
      }
      fs.copyFileSync(src, dest);
      const settings = getSettings();
      settings.bgImage = name;
      store.setMeta('settings', settings);
      store.persist();
      return { ok: true, name, url: 'tt-skin://' + name };
    } catch (err) {
      return { ok: false, message: '复制图片失败：' + (err && err.message) };
    }
  });

  /** 清除背景图 */
  handle('skin:clearImage', async () => {
    assertUnlocked();
    try {
      const dir = skinDir();
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith('bg.')) fs.rmSync(path.join(dir, f), { force: true });
        }
      }
      const settings = getSettings();
      settings.bgImage = '';
      store.setMeta('settings', settings);
      store.persist();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err && err.message) };
    }
  });

  /** 读背景图（返回 data URL，给前端用） */
  handle('skin:getImage', async () => {
    assertUnlocked();
    const settings = getSettings();
    if (!settings.bgImage) return { ok: true, url: '' };
    /**
     * **路径穿越点**（v0.43.0 修补，High）：
     * 老实现直接把 bgImage 拼到皮肤目录后面（path.join(skinDir(), bgImage)）—— bgImage 来自渲染进程
     * （settings:set 的 allowed 白名单里就有它），传
     * `..\..\..\Users\x\.ssh\id_rsa` 就能把私钥读成 base64 回给前端。
     * 现在只接受 `bg.<图片扩展名>`：basename + 扩展名白名单，其余当没有背景图。
     */
    const safeName = sharedHelpers.safeSkinFileName(settings.bgImage);
    if (!safeName) return { ok: true, url: '', rejected: true };
    try {
      const full = path.join(skinDir(), safeName);
      if (!fs.existsSync(full)) return { ok: true, url: '' };
      const buf = fs.readFileSync(full);
      const ext = path.extname(full).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : 'image/png';
      return { ok: true, url: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      return { ok: false, url: '', message: String(err && err.message) };
    }
  });
}

module.exports = { register };