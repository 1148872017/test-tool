'use strict';
/**
 * ipc-settings.js —— 设置 / 皮肤（背景图）域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 皮肤的图片文件存在 {数据目录}/skin/ 下，设置里只存文件名。
 */
function register(deps) {
  const {
    ipcMain,
    dialog,
    fs,
    path,
    store,
    getWindow,
    getSettings,
    saveSettings,
    publicSettings,
    assertUnlocked,
    resolveDataDir
  } = deps;

  /** 皮肤目录 */
  const skinDir = () => path.join(resolveDataDir(), 'skin');

  ipcMain.handle('settings:get', async () => publicSettings());

  ipcMain.handle('settings:set', async (e, patch) => {
    const settings = getSettings();
    const allowed = ['autoLockMinutes', 'clipboardClearSeconds', 'openCopyPassword', 'closeAction', 'workspaceDir', 'casesDir', 'jmxDir', 'jmeterPath', 'reportDir', 'allureDir', 'kbDir', 'notesDir', 'projectDir', 'javaHome', 'pythonPath', 'mvnPath', 'themeColor', 'bgImage', 'bgOpacity', 'bgTextMode', 'bgOverlay', 'bgOverlayColor'];
    for (const key of allowed) {
      if (patch && patch[key] !== undefined) settings[key] = patch[key];
    }
    saveSettings();
    return publicSettings();
  });

  /** 选背景图（复制到皮肤目录） */
  ipcMain.handle('skin:pickImage', async () => {
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
  ipcMain.handle('skin:clearImage', async () => {
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
  ipcMain.handle('skin:getImage', async () => {
    assertUnlocked();
    const settings = getSettings();
    if (!settings.bgImage) return { ok: true, url: '' };
    try {
      const full = path.join(skinDir(), settings.bgImage);
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