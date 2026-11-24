'use strict';
/**
 * ipc-jmx.js —— JMeter 脚本（jmx）生成 / 索引 / 启动域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * JMeter 探测与启动逻辑在 shared-helpers.js（app / jtl 域也要用）。
 */
const jmxIndex = require('../jmx');
const jmxgen = require('../../shared/jmxgen');

function register(deps) {
  const {
    ipcMain,
    dialog,
    shell,
    store,
    fs,
    path,
    getWindow,
    getSettings,
    saveSettings,
    assertUnlocked,
    detectJmeter,
    jmeterVersionOf,
    launchJmeter
  } = deps;

  /* ==================== JMeter 脚本生成 ==================== *
   * 从接口记录生成标准 .jmx，JMeter GUI 能直接打开。
   * ------------------------------------------------------ */

  /**
   * 生成 jmx（预览，不写文件）。
   *
   * payload:
   *   apiIds   接口记录 id 数组
   *   name     测试计划名
   *   threads  线程数 / rampUp / loops / duration / rtLimit
   *   domain / port  默认域名端口（空 = 从第一个接口取）
   *   onError  出错策略
   */
  ipcMain.handle('jmxgen:preview', async (e, payload = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const ids = Array.isArray(payload.apiIds) ? payload.apiIds : [];
    if (!ids.length) return { ok: false, message: '至少选一个接口' };

    const apis = [];
    for (const id of ids) {
      const rec = store.get(String(id));
      if (rec) apis.push({ id: rec.id, data: rec.data });
    }
    if (!apis.length) return { ok: false, message: '选中的接口都不存在' };

    // JMeter 版本从设置里的 jmeterPath 读（避免打开时弹「版本不一致」）
    const jmeterVersion = settings.jmeterPath ? jmeterVersionOf(settings.jmeterPath) : '';

    const gen = jmxgen.generateJmx({
      apis,
      name: payload.name,
      threads: payload.threads,
      rampUp: payload.rampUp,
      loops: payload.loops,
      duration: payload.duration,
      rtLimit: payload.rtLimit,
      domain: payload.domain,
      port: payload.port,
      onError: payload.onError,
      csv: payload.csv,
      jmeterVersion
    });
    return Object.assign({}, gen, { jmeterVersion: jmeterVersion || '5.6.3' });
  });

  /** 生成 jmx 并保存 */
  ipcMain.handle('jmxgen:save', async (e, payload = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const ids = Array.isArray(payload.apiIds) ? payload.apiIds : [];
    if (!ids.length) return { ok: false, message: '至少选一个接口' };

    const apis = [];
    for (const id of ids) {
      const rec = store.get(String(id));
      if (rec) apis.push({ id: rec.id, data: rec.data });
    }
    if (!apis.length) return { ok: false, message: '选中的接口都不存在' };

    const jmeterVersion = settings.jmeterPath ? jmeterVersionOf(settings.jmeterPath) : '';

    const gen = jmxgen.generateJmx({
      apis,
      name: payload.name,
      threads: payload.threads,
      rampUp: payload.rampUp,
      loops: payload.loops,
      duration: payload.duration,
      rtLimit: payload.rtLimit,
      domain: payload.domain,
      port: payload.port,
      onError: payload.onError,
      csv: payload.csv,
      jmeterVersion
    });
    if (!gen.ok) return gen;

    let dir = String(payload.dir || '').trim();
    if (!dir) {
      const picked = await dialog.showOpenDialog(getWindow(), {
        title: '选择保存目录',
        defaultPath: settings.jmxDir || '',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      dir = picked.filePaths[0];
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, gen.filename);
      fs.writeFileSync(full, gen.xml, 'utf8');
      return { ok: true, file: full, filename: gen.filename };
    } catch (err) {
      return { ok: false, message: '写文件失败：' + (err && err.message) };
    }
  });

  // ---- JMeter jmx 索引（只读，文件为准） ----
  ipcMain.handle('jmx:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.jmxDir;
    const bat = detectJmeter();
    const version = bat ? jmeterVersionOf(bat) : '';
    const res = jmxIndex.scanJmx(dir, { jmeterVersion: version });
    res.jmeter = { path: bat, version, found: !!bat };
    return res;
  });

  ipcMain.handle('jmx:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  ipcMain.handle('jmx:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    // showItemInFolder 要的是「文件」，传目录会打开它的父目录。
    // 这里传进来的可能是目录（打开目录按钮）也可能是文件（定位脚本），分开处理。
    const target = String(file);
    if (!fs.existsSync(target)) return { ok: false, message: '路径不存在：' + target };
    const isDir = fs.statSync(target).isDirectory();
    if (isDir) {
      const err = await shell.openPath(target);
      return { ok: !err, message: err || '', dir: target };
    }
    shell.showItemInFolder(target);
    return { ok: true, dir: path.dirname(target) };
  });

  /** 不带 jmx 直接启动 JMeter GUI（空工作台，用户自己 Open） */
  ipcMain.handle('jmx:launch', async () => {
    assertUnlocked();
    return launchJmeter('');
  });

  /** 用 JMeter GUI 打开某个 jmx（想法 1：一键启动并加载） */
  ipcMain.handle('jmx:openGui', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, code: 'NO_FILE', message: '缺少脚本路径' };
    return launchJmeter(String(file));
  });

  ipcMain.handle('jmx:pickDir', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择 jmx 目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.jmxDir = result.filePaths[0];
    saveSettings();
    return { ok: true, dir: settings.jmxDir };
  });

  ipcMain.handle('jmx:pickJmeter', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择 jmeter.bat',
      properties: ['openFile'],
      filters: [{ name: 'JMeter 启动脚本', extensions: ['bat', 'cmd', 'sh'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.jmeterPath = result.filePaths[0];
    saveSettings();
    return { ok: true, path: settings.jmeterPath, version: jmeterVersionOf(settings.jmeterPath) };
  });
}

module.exports = { register };