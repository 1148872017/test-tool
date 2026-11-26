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

/**
 * 从页面对象类文件里猜类名（v0.63）。
 *
 * 优先级：文件里真实的 `class X` 声明 > 文件名去掉扩展名。
 * 为什么不能只靠文件名：有人一个文件里放多个类，也有人用 `class LoginPageTests`
 * 这种带后缀的命名；反过来文件名也可能叫 `LoginPageHelper` 而真正的页面对象类
 * 叫 `LoginPage`。所以先找声明，找不到再退回文件名，并把「怎么来的」告诉界面。
 *
 * @returns {{className:string, kind:'java'|'python'|'kotlin'|'', source:'declared'|'filename', message:string}}
 */
function guessClassFromFile(file, text) {
  const base = String(file || '').replace(/\\/g, '/').split('/').pop() || '';
  const ext = (base.match(/\.([A-Za-z0-9]+)$/) || [])[1] || '';
  const kind =
    ext === 'java' ? 'java' : ext === 'py' ? 'python' : ext === 'kt' ? 'kotlin' : '';
  const fileBase = base.replace(/\.[^.]+$/, '');
  const src = String(text || '');

  // Java / Kotlin：public class LoginPage / public final class X / open class X / data class X
  // 修饰符可能连着好几个（public final class），所以用「一个或多个修饰符」
  const javaDecl =
    /(?:^|\n)\s*(?:(?:public|private|protected|abstract|final|open|data|sealed|static)\s+)*(?:class|interface)\s+([A-Za-z_$][\w$]*)/.exec(
      src
    );
  // Python：class LoginPage(Base):（排除「# class ...」注释）
  let pyDecl = null;
  const pyRe = /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)\s*[:(]/g;
  let m;
  while ((m = pyRe.exec(src))) {
    const before = src.slice(0, m.index + 1);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = src.slice(lineStart, m.index + 40);
    if (line.trimStart().startsWith('#')) continue; // 注释掉的不算
    pyDecl = m;
    break;
  }

  const decl = kind === 'python' ? pyDecl : javaDecl;
  if (decl && decl[1]) {
    return {
      className: decl[1],
      kind,
      source: 'declared',
      message: '已从文件里读到类名 ' + decl[1]
    };
  }
  return {
    className: fileBase,
    kind,
    source: 'filename',
    message: '文件里没找到 class 声明，先用文件名（' + fileBase + '），可以手动改'
  };
}

/**
 * 按 payload 把「接口数据」塞进 codegen 的 input（v0.63）。
 *
 * 三种来源，优先级从高到低：
 *   1. apiData —— OpenAPI 文件解析出来的单条（不查库）
 *   2. apiIds  —— 勾了多条接口记录：查库后放进 `input.apis`（多接口生成）
 *   3. apiId   —— 单条接口记录：查库后放进 `input.api`
 *
 * @returns 出错时返回 { ok:false, message }，正常返回 null
 */
function attachApiInput(input, payload, store) {
  if (payload.apiData) {
    input.api = payload.apiData;
    return null;
  }
  const apiIds = Array.isArray(payload.apiIds)
    ? payload.apiIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (apiIds.length > 1) {
    const list = [];
    for (const id of apiIds) {
      const rec = store.get(id);
      if (rec && rec.data) list.push(rec.data);
    }
    if (list.length < 2) return { ok: false, message: '选中的接口记录不足 2 条（可能被删了），刷新后重选' };
    input.apis = list;
    return null;
  }
  const singleId = apiIds.length === 1 ? apiIds[0] : String(payload.apiId || '').trim();
  if (singleId) {
    const rec = store.get(singleId);
    if (!rec) return { ok: false, message: '接口记录不存在' };
    input.api = rec.data;
  }
  return null;
}

function register(deps) {
  const { handle, dialog, store, fs, path, getWindow, assertUnlocked, assertPathIn, rememberPicked } = deps;

  /**
   * v0.65：每个生成目标上次保存到哪个目录（会话级）。
   * 不给记住的话，用户每次点「保存到文件」都要从 C:\ 一路翻，
   * 而且很容易把同名文件存到三四个不同目录，最后 `duplicate class`。
   */
  const lastDirByTarget = new Map();

  /** 写文件并包一层统一的错误信息（覆盖确认里「另存到别的目录」分支也用它） */
  function writeCodeFile(full, code, filename) {
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, code, 'utf8');
      return { ok: true, file: full, filename };
    } catch (err) {
      return { ok: false, message: '写文件失败：' + (err && err.message) };
    }
  }

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

    // 接口数据来源：优先 apiData（OpenAPI 文件解析结果），其次 apiIds（多接口）/ apiId（单接口，查库）
    const apiErr = attachApiInput(input, payload, store);
    if (apiErr) return apiErr;

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
    const apiErr = attachApiInput(input, payload, store);
    if (apiErr) return apiErr;

    // 有现成代码就直接写它；没有才按输入参数重新生成
    const gen = inlineCode ? { ok: true, code: inlineCode, filename: inlineName } : codegen.generate(targetKey, input);
    if (!gen.ok) return gen;

    /**
     * v0.65：**生成名的 filename 也要过一遍守卫**。
     *
     * v0.60 加 checkInlineFilename 时只守了 inline 分支，生成名分支一直没守 ——
     * 实测 className='../evil' 会让 filename 变成 '../evil.java'，
     * path.join(dir, ...) 直接把文件写到用户所选目录之外。
     * 现在 className 在 codegen 里已经会拦（isSafeIdent），这里是第二道防线。
     */
    const badGenName = checkInlineFilename(gen.filename, targetKey);
    if (badGenName) return badGenName;

    // 选目录：优先用上次给这个目标选过的目录（省得每次都翻）
    let dir = wantDir || lastDirByTarget.get(targetKey) || '';
    if (dir && wantDir) {
      // 显式传了 dir，照旧记一下，下次同一目标默认用它
      lastDirByTarget.set(targetKey, dir);
    }
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
    lastDirByTarget.set(targetKey, dir);

    const full = path.join(dir, gen.filename);

    /**
     * v0.65：已存在就先问，别静默覆盖。
     *
     * 为什么必须问：模板注释和 README 都引导用户「改这两行」，也就是说
     * 这个文件**注定会被手改**；而「保存到文件」很可能又被点一次
     * （尤其目录被记住之后），writeFileSync 会无声地把用户改的内容抹掉。
     */
    if (fs.existsSync(full)) {
      const answer = await dialog.showMessageBox(getWindow(), {
        type: 'warning',
        title: '文件已存在',
        message: '这个目录里已经有 ' + gen.filename + ' 了',
        detail: full + '\n\n覆盖会丢掉你对这个文件做过的修改（比如改过 setHeadless / setSlowMo）。',
        buttons: ['覆盖', '另存到别的目录', '取消'],
        defaultId: 1,
        cancelId: 2,
        noLink: true
      });
      if (answer.response === 2) return { ok: false, canceled: true };
      if (answer.response === 1) {
        const picked = await dialog.showOpenDialog(getWindow(), {
          title: '另存为：选择目录',
          properties: ['openDirectory']
        });
        if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
        dir = picked.filePaths[0];
        rememberPicked(dir);
        lastDirByTarget.set(targetKey, dir);
        return writeCodeFile(path.join(dir, gen.filename), gen.code, gen.filename);
      }
      // response === 0：覆盖，往下走
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(full, gen.code, 'utf8');
      return { ok: true, file: full, filename: gen.filename };
    } catch (err) {
      return { ok: false, message: '写文件失败：' + (err && err.message) };
    }
  });

  /**
   * v0.63：为「选择已有类」挑一个页面对象类文件。
   *
   * 为什么要这个：以前这一档只能**手打类名**——打错了要到生成出来以后才发现
   * （生成器不知道你项目里有什么类）。选文件之后类名从文件内容里读出来，
   * 顺手还能确认「这个类真的存在」。
   *
   * 只读文件、不写库；读到的类名回给界面，由界面填进输入框（用户仍可改）。
   */
  handle('codegen:pickClass', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择页面对象类文件',
      filters: [{ name: '类文件', extensions: ['java', 'py', 'kt'] }],
      properties: ['openFile']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const file = picked.filePaths[0];
    // 用户明确选过的文件 → 本会话可信根（后面若再读它不会越界）
    rememberPicked(file);

    let text = '';
    try {
      const stat = fs.statSync(file);
      // 只读前面一段：类声明一定在文件靠前的位置，没必要把整个大文件读进来
      const size = Math.min(stat.size, 200 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch (err) {
      return { ok: false, message: '读文件失败：' + (err && err.message ? err.message : String(err)) };
    }

    const info = guessClassFromFile(file, text);
    return {
      ok: true,
      file,
      className: info.className,
      kind: info.kind,
      /** 'declared' = 在文件里找到了类声明；'filename' = 只用文件名推的（可能是工具类） */
      source: info.source,
      message: info.message
    };
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

module.exports = { register, checkInlineFilename, guessClassFromFile };