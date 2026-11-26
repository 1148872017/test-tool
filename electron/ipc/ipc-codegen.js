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

/**
 * 积木视图直接写盘时的文件名守卫（v0.60）。
 *
 * 只收「单段文件名」：不含路径分隔符、不含 ..、不以点开头；
 * 扩展名必须在「这个生成目标」允许的那几个里 —— 免得传到一股 .exe 或者别的东西上。
 *
 * @returns 出错时返回 { ok:false, message }，通过返回 null
 */
function checkInlineFilename(name, targetKey) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, message: '缺少文件名' };
  if (/[\\/]/.test(n) || n.indexOf('..') >= 0) {
    return { ok: false, message: '文件名只能是单段名字，不能带目录' };
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(n)) {
    return { ok: false, message: '文件名里有不能用的字符' };
  }
  if (n.startsWith('.')) return { ok: false, message: '文件名不能以点开头' };
  const allowed = targetKey.indexOf('python') === 0 ? ['.py'] : targetKey.indexOf('java') === 0 ? ['.java'] : [];
  if (allowed.length) {
    const ext = n.slice(n.lastIndexOf('.')).toLowerCase();
    if (n.lastIndexOf('.') <= 0 || allowed.indexOf(ext) < 0) {
      return { ok: false, message: '这个生成目标只写 ' + allowed.join(' / ') + ' 文件（收到 ' + n + '）' };
    }
  }
  return null;
}

function register(deps) {
  const { handle, dialog, store, fs, path, getWindow, assertUnlocked, assertPathIn, rememberPicked } = deps;

  /* ==================== 代码骨架生成 ==================== *
   * 从接口记录 / JSON / 页面元素生成 Java/Python 代码骨架。
   * 纯模板替换，不做 AST。
   * ---------------------------------------------------- */

  /** 可用的生成目标 */
  handle('codegen:targets', async () => {
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
  handle('codegen:preview', async (e, payload = {}) => {
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
  handle('codegen:save', async (e, payload = {}) => {
    assertUnlocked();
    /**
     * 入参守卫（v0.50.0）：dir 是「往哪写」的入参，不校验就等于
     * 「渲染进程指定目录 → 主进程写文件」。放在生成之前：越界入参不该先跑生成。
     * 不传 dir 时走 dialog（用户明确选的目录，记进会话白名单）。
     */
    const wantDir = String(payload.dir || '').trim();
    if (wantDir) {
      const bad = assertPathIn(wantDir);
      if (bad) return bad;
    }
    const targetKey = String(payload.targetKey || '').trim();
    if (!targetKey) return { ok: false, message: '缺少生成目标' };

    /**
     * v0.60：积木视图的代码是**拼出来的**，不是从输入参数重新生成的，
     * 所以允许直接把 `code` 传进来写盘（以前这条链断着：面板只有「复制」）。
     * 文件名只收单段文件名（不含路径分隔符、不含 ..），扩展名限定在生成目标允许的范围内。
     */
    const inlineCode = typeof payload.code === 'string' ? payload.code : '';
    let inlineName = '';
    if (inlineCode) {
      const badName = checkInlineFilename(payload.filename, targetKey);
      if (badName) return badName;
      inlineName = String(payload.filename).trim();
    }

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

    // 有现成代码就直接写它；没有才按输入参数重新生成
    const gen = inlineCode ? { ok: true, code: inlineCode, filename: inlineName } : codegen.generate(targetKey, input);
    if (!gen.ok) return gen;

    // 选目录
    let dir = wantDir;
    if (!dir) {
      const picked = await dialog.showOpenDialog(getWindow(), {
        title: '选择保存目录',
        properties: ['openDirectory']
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      dir = picked.filePaths[0];
      // 用户明确选过的目录 → 本会话可信根
      rememberPicked(dir);
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

  handle('sqlgen:snapshot', async (e, payload = {}) => {
    assertUnlocked();
    return sqlgen.genSnapshot(payload);
  });

  handle('sqlgen:cleanup', async (e, payload = {}) => {
    assertUnlocked();
    return sqlgen.genCleanup(payload);
  });

  handle('sqlgen:restore', async (e, payload = {}) => {
    assertUnlocked();
    return sqlgen.genRestore(payload);
  });

  handle('sqlgen:listBackups', async (e, { tables } = {}) => {
    assertUnlocked();
    return { ok: true, list: sqlgen.listBackupTables(tables) };
  });
}

module.exports = { register, checkInlineFilename };