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
    handle,
    dialog,
    shell,
    store,
    fs,
    path,
    getWindow,
    getSettings,
    saveSettings,
    assertUnlocked,
    assertPathIn,
    rememberPicked,
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
  handle('jmxgen:preview', async (e, payload = {}) => {
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
      // 附加 JSR223 代码（脚本生成页的「附加代码」/ 脚本模板带过来的断言、前置、后置）
      extraElements: payload.extraElements,
      jmeterVersion
    });
    return Object.assign({}, gen, { jmeterVersion: jmeterVersion || '5.6.3' });
  });

  /** 生成 jmx 并保存 */
  handle('jmxgen:save', async (e, payload = {}) => {
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
      // 保存走的是同一套生成逻辑，附加代码必须一起带上，否则「预览有、保存丢」
      extraElements: payload.extraElements,
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
  handle('jmx:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.jmxDir;
    const bat = detectJmeter();
    const version = bat ? jmeterVersionOf(bat) : '';
    const res = jmxIndex.scanJmx(dir, { jmeterVersion: version });
    res.jmeter = { path: bat, version, found: !!bat };
    return res;
  });

  /**
   * jmx 只读详情（L1）。
   *
   * 入参：{ file } —— 绝对路径，或相对「设置 → 压测」jmxDir 的路径。
   * 出参：{ ok:true, file, size, modifiedAt, testPlan, threadGroups, samplers,
   *         configs, variables, assertionCount, summary }
   *
   * 为什么单独开通道而不是复用 jmx:scan：
   *   scan 是整个目录的索引（健康检查、列表），detail 是单文件深读，
   *   打开一行才解析一次，几千个 jmx 的目录也不会因为点详情变慢。
   * 只读：readDetail 全程不写盘（有测试守着 mtime / 内容不变）。
   */
  handle('jmx:detail', async (e, { file } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const input = String(file == null ? '' : file).trim();
    if (!input) return { ok: false, code: 'BAD_PATH', message: '缺少文件路径' };

    // 相对路径按 jmxDir 拼（详情页传的是 scan 出来的 fullPath，一般是绝对路径）
    const jmxDir = String(settings.jmxDir || '').trim();
    const target = path.isAbsolute(input) ? input : jmxDir ? path.join(jmxDir, input) : '';
    if (!target) {
      return { ok: false, code: 'NO_JMX_DIR', message: '还没配置 jmx 目录，没法解析相对路径' };
    }
    // 路径白名单：和 jmx:openFile / jmx:openGui 同一套守卫，越界直接拒绝
    const bad = assertPathIn(target);
    if (bad) return bad;

    return jmxIndex.readDetail(target);
  });

  handle('jmx:openFile', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, message: '缺少文件路径' };
    const bad = assertPathIn(String(file));
    if (bad) return bad;
    const err = await shell.openPath(String(file));
    return { ok: !err, message: err || '' };
  });

  handle('jmx:reveal', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false };
    // showItemInFolder 要的是「文件」，传目录会打开它的父目录。
    // 这里传进来的可能是目录（打开目录按钮）也可能是文件（定位脚本），分开处理。
    const target = String(file);
    const bad = assertPathIn(target);
    if (bad) return bad;
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
  handle('jmx:launch', async () => {
    assertUnlocked();
    return launchJmeter('');
  });

  /** 用 JMeter GUI 打开某个 jmx（想法 1：一键启动并加载） */
  handle('jmx:openGui', async (e, { file }) => {
    assertUnlocked();
    if (!file) return { ok: false, code: 'NO_FILE', message: '缺少脚本路径' };
    // 入参守卫：脚本必须在白名单目录内（launchJmeter 内部还会再校验一次路径字符）
    const bad = assertPathIn(String(file));
    if (bad) return bad;
    return launchJmeter(String(file));
  });

  handle('jmx:pickDir', async () => {
    assertUnlocked();
    const settings = getSettings();
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择 jmx 目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    settings.jmxDir = result.filePaths[0];
    saveSettings();
    rememberPicked(settings.jmxDir);
    return { ok: true, dir: settings.jmxDir };
  });

  handle('jmx:pickJmeter', async () => {
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
    // jmeter.bat 可能在任意安装目录（不在白名单里），记一下会话根备查
    rememberPicked(settings.jmeterPath);
    return { ok: true, path: settings.jmeterPath, version: jmeterVersionOf(settings.jmeterPath) };
  });
}

module.exports = { register };