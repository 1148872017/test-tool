'use strict';
/**
 * ipc-records.js —— 记录 / 备份 / 数据导入导出 / 造数域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 注意 data:openDir 与 data:openWorkspace 是两个不同的通道：
 *   data:openDir       打开数据目录（%APPDATA%\测试工作台）
 *   data:openWorkspace 打开工作区目录（造数导出后的「去看看」）
 * 两个都用同一个名字会注册两次 → 启动直接崩（踩坑 #103）。
 */
const faker = require('../../shared/faker');
const { COLLECTION_MAP } = require('../../shared/collections');
const { buildTemplate, templateFileName } = require('../../shared/importTemplate');

function register(deps) {
  const {
    handle,
    dialog,
    shell,
    app,
    store,
    path,
    fs,
    getWindow,
    getSettings,
    loadSettings,
    publicSettings,
    assertUnlocked,
    assertPathIn,
    rememberPicked,
    isLocked
  } = deps;

  handle('records:list', async (e, payload) => {
    assertUnlocked();
    const { collection, keyword, tag, favorite } = payload || {};
    return store.list(collection, { keyword, tag, favorite });
  });

  handle('records:get', async (e, { id }) => {
    assertUnlocked();
    return store.get(id);
  });

  handle('records:save', async (e, record) => {
    assertUnlocked();
    return store.save(record);
  });

  handle('records:remove', async (e, { id }) => {
    assertUnlocked();
    return store.remove(id);
  });

  handle('records:counts', async () => {
    assertUnlocked();
    return store.counts();
  });

  /* ------------------------------------------------------------------ *
   * 回收站（软删除）
   *
   * records:remove 已经改成「写 deleted_at」而不是真删，
   * 所以删完还能在这里找回来。列表 / 统计 / 导出都默认不含回收站。
   * 保留天数是 store.TRASH_RETENTION_DAYS（30 天），界面文案也从那取。
   * ------------------------------------------------------------------ */

  handle('records:trash-list', async () => {
    assertUnlocked();
    return store.listTrash();
  });

  handle('records:trash-count', async () => {
    assertUnlocked();
    return store.countTrash();
  });

  handle('records:trash-restore', async (e, { id } = {}) => {
    assertUnlocked();
    return store.restore(String(id || ''));
  });

  handle('records:trash-purge', async (e, { id } = {}) => {
    assertUnlocked();
    return store.purge(String(id || ''));
  });

  handle('records:trash-clear', async () => {
    assertUnlocked();
    return store.clearTrash();
  });

  handle('backup:now', async () => {
    const file = store.backup();
    return { file };
  });

  handle('backup:list', async () => store.listBackups());

  // ---- 可配置选项（环境 / 角色·权限 / 标签）----
  handle('options:get', async () => {
    assertUnlocked();
    return store.getOptions();
  });

  handle('options:save', async (e, { key, items } = {}) => {
    assertUnlocked();
    return store.saveOptions(String(key || ''), items);
  });

  handle('data:openDir', async () => {
    const dir = path.dirname(store.dbPath);
    await shell.openPath(dir);
    return dir;
  });

  /**
   * 清除数据。target: 'backups' 只清备份文件；'local' 重置本地数据文件。
   * 破坏性操作，界面侧有 3 秒倒计时兜一层手滑。
   */
  handle('data:clear', async (e, { target } = {}) => {
    assertUnlocked();
    const what = String(target || '');
    if (what === 'backups') {
      return Object.assign({ ok: true, target: what }, store.clearBackups());
    }
    if (what === 'local') {
      const res = store.clearLocalData();
      // 设置和锁屏密码都存在库里，库重置后就回到默认值（也就没有密码了）
      loadSettings();
      return Object.assign({ ok: true, target: what }, res, { settings: publicSettings() });
    }
    return { ok: false, target: what, message: '未知的清除目标' };
  });

  handle('data:export', async (e, { includeSecrets, collection } = {}) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const conf = collection ? COLLECTION_MAP[collection] : null;
    const base = conf ? `测试工作台-${conf.name}-${stamp}.json` : `测试工作台-备份-${stamp}.json`;
    const result = await dialog.showSaveDialog(getWindow(), {
      title: collection ? `导出「${conf.name}」` : '导出数据',
      defaultPath: path.join(app.getPath('desktop'), base),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const payload = store.exportAll(!!includeSecrets, collection || null);
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, file: result.filePath, count: payload.records.length };
  });

  /**
   * 下载「导入模板」：该集合的一条字段齐全的示例记录。
   *
   * 为什么需要：用户手里没有样本时，不知道「导入备份」认什么结构、
   * 字段名叫什么、账号列表是数组还是 JSON 字符串。
   * 模板就是**能直接导入**的示例 —— 照着改值，再点「导入备份」即可。
   *
   * 模板由 shared/importTemplate.js 生成（纯函数，字段取自 shared/collections.js），
   * 所以集合加字段后模板自动跟着变，不用手工维护一份样例。
   */
  handle('data:importTemplate', async (e, { collection } = {}) => {
    assertUnlocked();
    const key = String(collection || '').trim();
    const conf = key ? COLLECTION_MAP[key] : null;
    if (!conf) return { ok: false, message: '不认识的集合：' + (key || '(空)') };

    let text = '';
    let name = '';
    try {
      text = buildTemplate(conf);
      name = templateFileName(conf);
    } catch (err) {
      return { ok: false, message: '生成模板失败：' + String((err && err.message) || err) };
    }

    const result = await dialog.showSaveDialog(getWindow(), {
      title: '下载「' + conf.name + '」导入模板',
      defaultPath: path.join(app.getPath('desktop'), name),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, text, 'utf8');
    } catch (err) {
      return { ok: false, message: '写文件失败：' + String((err && err.message) || err) };
    }

    return { ok: true, file: result.filePath, count: 1, bytes: Buffer.byteLength(text, 'utf8'), collection: conf.key };
  });

  /**
   * 导入：.json = 合并（留原 id，关联和选项一起带过来）
   *      .db   = 整库覆盖，破坏性操作，先回给界面确认，不在这里直接恢复
   */
  handle('data:import', async (e, { collection } = {}) => {
    const conf = collection ? COLLECTION_MAP[collection] : null;
    // 按集合导入只认 JSON：.db 是整库覆盖，不能只导一个集合，
    // 所以过滤器里也不该出现它（否则用户选了才被告知不行）
    const filters = conf
      ? [{ name: 'JSON', extensions: ['json'] }]
      : [
          { name: 'JSON 或数据库备份', extensions: ['json', 'db'] },
          { name: 'JSON', extensions: ['json'] },
          { name: '数据库备份', extensions: ['db'] }
        ];
    const result = await dialog.showOpenDialog(getWindow(), {
      title: conf ? `导入到「${conf.name}」` : '导入数据',
      properties: ['openFile'],
      filters
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const file = result.filePaths[0];
    // 用户明确选过的文件 → 本会话可信根（后面 backup:restore 可能用它覆盖整库）
    rememberPicked(file);

    // 选了 .db：这是整库覆盖，不能悄悄执行，回给界面弹确认
    if (/\.db$/i.test(file)) {
      if (collection) {
        return { ok: false, message: '数据库备份是整库覆盖，不能只导入某个集合' };
      }
      try {
        const info = store.inspectDbFile(file);
        return {
          ok: false,
          needConfirm: true,
          mode: 'db',
          file,
          recordCount: info.recordCount,
          fromVersion: info.version
        };
      } catch (err) {
        return { ok: false, message: (err && err.message) || '这个 .db 读不了' };
      }
    }

    const raw = fs.readFileSync(file, 'utf8');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return { ok: false, message: '不是合法的 JSON 文件' };
    }
    const stat = store.importAll(payload, collection || null);
    return {
      ok: true,
      file,
      imported: stat.imported,
      skipped: stat.skipped,
      keptIds: stat.keptIds,
      links: stat.links
    };
  });

  /** 用备份（或任意 .db）覆盖当前库；恢复前自动给当前库留安全备份 */
  handle('backup:restore', async (e, { file } = {}) => {
    assertUnlocked();
    const name = String(file || '').trim();
    if (!name) return { ok: false, message: '缺少备份文件' };
    // 只给文件名时按备份目录解析；给绝对路径则原样用（从别处拷来的 .db）
    const target = path.isAbsolute(name) ? name : path.join(store.backupDir, name);
    /**
     * 入参守卫（v0.43.0）：
     * 恢复 = 用外来 .db 覆盖当前库，等于「把库内容交给这个文件」。
     * 只允许备份目录（+ 本会话选过的路径），不允许任意 .db。
     */
    const bad = assertPathIn(target);
    if (bad) return bad;
    try {
      const res = store.restoreFrom(target);
      loadSettings();
      // 备份里可能带着锁屏密码：恢复后按备份里的设置走（有密码就重新上锁）
      return Object.assign({ ok: true, file: target, locked: isLocked(), settings: publicSettings() }, res);
    } catch (err) {
      return { ok: false, message: (err && err.message) || '恢复失败' };
    }
  });

  /** 导出整库 .db（备份到指定位置，可拿去别的机器覆盖用） */
  handle('data:exportDb', async () => {
    assertUnlocked();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const result = await dialog.showSaveDialog(getWindow(), {
      title: '导出整库备份',
      defaultPath: path.join(app.getPath('desktop'), `测试工作台-整库-${stamp}.db`),
      filters: [{ name: '数据库备份', extensions: ['db'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const res = store.exportDbTo(result.filePath);
    return { ok: true, file: res.file, bytes: res.bytes };
  });

  /**
   * 生成测试数据文件。
   *
   * payload:
   *   mode    'single'（单类型）| 'multi'（多字段组合）
   *   type    单类型时的类型 key
   *   fields  多字段时的字段定义 [{name, type, fixed}]
   *   count   行数
   *   format  'csv' | 'json'
   *   from/to 日期范围（date 类型用）
   *   dir     输出目录（空 = 工作区根目录）
   */
  handle('data:genFile', async (e, payload = {}) => {
    assertUnlocked();
    const settings = getSettings();

    const count = Math.max(1, Math.min(1000000, Number(payload.count) || 1));
    const format = payload.format === 'json' ? 'json' : 'csv';
    const mode = payload.mode === 'multi' ? 'multi' : 'single';

    /**
     * 输出目录：显式传的 > 工作区根目录。
     * 都没有就回一个标记，让前端弹「去设置配工作区」。
     */
    const dir = String(payload.dir || '').trim() || String(settings.workspaceDir || '').trim();
    if (!dir) {
      return { ok: false, needWorkspace: true, message: '没有工作区目录，请先去设置里配' };
    }
    /**
     * 入参守卫（v0.43.0）：
     * 这条通道是**写文件**（在 dir 下生成 csv/json），
     * 不校验的话渲染进程可以往任意目录写以指定名字结尾的文件。
     */
    const bad = assertPathIn(dir);
    if (bad) return bad;

    // 生成数据
    let headers = [];
    let rows = [];
    try {
      if (mode === 'multi') {
        const fields = Array.isArray(payload.fields) ? payload.fields : [];
        const valid = fields.filter((f) => f && String(f.name || '').trim());
        if (!valid.length) return { ok: false, message: '至少填一个字段名' };
        headers = valid.map((f) => String(f.name).trim());
        rows = faker.genRows(valid, count, { from: payload.from, to: payload.to });
      } else {
        const t = faker.TYPE_MAP[String(payload.type || '')] || faker.TYPES[0];
        headers = [t.label];
        rows = faker.genColumn(t.value, count, { from: payload.from, to: payload.to });
      }
    } catch (err) {
      return { ok: false, message: '生成失败：' + (err && err.message) };
    }

    // 序列化
    const content = format === 'csv' ? faker.toCsv(headers, rows) : faker.toJson(headers, rows);

    // 文件名
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    const baseName = mode === 'multi' ? 'multi-data' : String((faker.TYPE_MAP[payload.type] || faker.TYPES[0]).value);
    const fileName = `${baseName}-${count}-${stamp}.${format}`;

    try {
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, fileName);
      fs.writeFileSync(full, content, 'utf8');
      return { ok: true, file: full, count, bytes: Buffer.byteLength(content, 'utf8') };
    } catch (err) {
      return { ok: false, message: '写文件失败：' + (err && err.message) };
    }
  });

  /**
   * 打开工作区目录（造数导出后给个「去看看」的入口）。
   *
   * 注意通道名是 data:openWorkspace 而不是 data:openDir ——
   * data:openDir 已经被「打开数据目录」占了，
   * 两个都用同一个名字会注册两次 → 启动直接崩（踩坑 #103）。
   */
  handle('data:openWorkspace', async (e, { dir } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const target = String(dir || '').trim() || String(settings.workspaceDir || '').trim();
    if (!target) return { ok: false, message: '没有工作区目录' };
    try {
      await shell.openPath(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err && err.message) };
    }
  });

  /**
   * 启动时清一次回收站里的过期记录（超过 30 天）。
   *
   * 为什么放这里而不是 main.js：
   *   main.js 是装配层，业务逻辑一律留在域模块里。
   *   registerIpc() 在 store.init() 之后调用，这时库一定已经打开。
   * 清理失败不影响启动，只打日志。
   */
  try {
    const swept = store.purgeExpired(store.TRASH_RETENTION_DAYS);
    if (swept && swept.removed) {
      console.log(`[trash] 启动清理：${swept.removed} 条超过 ${swept.days} 天的记录已彻底删除`);
    }
  } catch (err) {
    console.error('[trash] 启动清理失败', err);
  }
}

module.exports = { register };