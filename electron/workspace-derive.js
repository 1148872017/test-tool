'use strict';
/**
 * workspace-derive.js —— 工作区目录推导（1 级工作区 → 7 个 2 级子目录）。
 *
 * ============================================================
 * 为什么要有这个模块（用户报的 bug）
 * ============================================================
 * 「设置工作区目录后，子目录没自动推导，而且本机没有预设的文件夹（比如 Notes）」。
 * 根因有两个：
 *   1. 推导只写在 main.js 的 loadSettings() 里 —— 那是**启动时跑一次**的逻辑。
 *      用户在设置页改了工作区，settings:set 只把 workspaceDir 存了，
 *      子目录一个都没重算，界面上还是旧值/空值；
 *   2. 推导只算路径字符串，**从不建目录**。算出来的 {工作区}/notes 在本机不存在，
 *      一用就报「目录不存在」，用户只能自己去资源管理器一个个建。
 *
 * 还有一个连带的老问题：loadSettings() 里「默认值填充」排在「工作区推导」前面，
 * 于是 casesDir 已经被填成「文档\测试工作台\test_cases」之后，
 * 后面的工作区推导（if (!settings[key]) …）永远不生效 —— 配了工作区也不生效。
 * 现在统一成「工作区优先，其次默认目录」。
 *
 * ============================================================
 * 怎么区分「我们推导出来的值」和「用户自己填的值」
 * ============================================================
 * 只比较旧 workspaceDir 不够：用户从没配过工作区时，启动默认值来自
 * 「文档\测试工作台」，它既不是哪个工作区推导出来的，也不是用户填的。
 * 所以在 settings 里留一本账 `derivedDirs`：
 *
 *   derivedDirs = { casesDir: '<上次推导出的值>', jmxDir: '…' }
 *
 *   - 当前值 == 账上的值              → 是我们推导的，可以随工作区一起重算
 *   - 当前值 == 空串                  → 从没配过，按推导处理
 *   - 当前值 == 「默认工作区」推导值  → 老版本写进去的默认值，也算自动值
 *   - 其余                            → 用户显式填的，一个字都不动
 *
 * 这本账只存在本机 settings 里（不进 publicSettings()），前端看不到也不需要看到。
 * 清空工作区时，账上那些推导值会被清成空串，而不是残留上一个工作区的路径。
 *
 * ============================================================
 * 建目录的规矩
 * ============================================================
 *   - 只建**推导出来的**路径；用户显式填的路径不建（他可能填错了，别乱建）；
 *   - 工作区根本身不存在（边输入边存，路径还没打完）时一个目录都不建，
 *     免得在磁盘上留一堆半截路径的垃圾目录；
 *   - 建失败（权限不足 / 路径非法）只记录，不抛异常、不阻塞保存。
 */
const fs = require('fs');
const path = require('path');

/**
 * 7 个子目录：设置字段 → 工作区下的相对路径。
 *
 * sub 为空串表示「工作区根本身」（allureDir 沿用既有语义：Allure 报告默认扫工作区根，
 * 这里故意不改，避免升级后老用户的报告一下全找不到了）。
 *
 * fromDefault：没配工作区时，这个字段要不要跟着「文档\测试工作台」兜底。
 *   老版本的默认值只填 5 个（用例/脚本/报告/知识库/笔记）；
 *   allureDir、projectDir 只在用户真配了工作区时才推导 —— 保持这个语义，
 *   否则会平白多出「文档\测试工作台\Project」这种并不存在的目录。
 */
const SUB_DIRS = [
  { key: 'casesDir', sub: 'test_cases', fromDefault: true },
  { key: 'jmxDir', sub: 'jmx', fromDefault: true },
  { key: 'reportDir', sub: path.join('jmx', '压测结果'), fromDefault: true },
  { key: 'allureDir', sub: '', fromDefault: false },
  { key: 'kbDir', sub: '知识库', fromDefault: true },
  { key: 'notesDir', sub: 'notes', fromDefault: true },
  { key: 'projectDir', sub: 'Project', fromDefault: false }
];

/** 键 → 子目录相对路径（derivePath 内部用；不认得返回 undefined） */
const SUB_MAP = (() => {
  const map = {};
  for (const item of SUB_DIRS) map[item.key] = item.sub;
  return map;
})();

/** 没配工作区时也要兜底的字段（老版本的 5 个默认目录） */
const FROM_DEFAULT = new Set(SUB_DIRS.filter((x) => x.fromDefault).map((x) => x.key));

/** 所有可推导的字段名（顺序同 SUB_DIRS） */
const DIR_KEYS = SUB_DIRS.map((x) => x.key);

/**
 * 默认工作区：放在「文档」下，跟着用户走（和 main.js 的 defaultWorkspaceDir 同一算法）。
 * 换机器 / 换人 clone 下来，首次启动指向自己的文档目录，不写死某个盘。
 *
 * @param {object} app Electron 的 app（测试里是 stub，有 getPath 即可）
 * @returns {string} 拿不到就返回空串
 */
function defaultWorkspaceDir(app) {
  try {
    return path.join(app.getPath('documents'), '测试工作台');
  } catch (e) {
    return '';
  }
}

/** 路径比较：Windows 大小写不敏感，尾部分隔符也不算差别 */
function samePath(a, b) {
  const norm = (p) => String(p === undefined || p === null ? '' : p).trim().replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** 某个字段在指定工作区下的应有路径；base 为空返回空串 */
function derivePath(key, base) {
  const sub = SUB_MAP[key];
  if (sub === undefined) return '';
  const root = String(base === undefined || base === null ? '' : base).trim();
  if (!root) return '';
  return sub ? path.join(root, sub) : root;
}

/** 账本（settings.derivedDirs）取出来，没有就建一个 */
function ensureBook(settings) {
  if (!settings.derivedDirs || typeof settings.derivedDirs !== 'object' || Array.isArray(settings.derivedDirs)) {
    settings.derivedDirs = {};
  }
  return settings.derivedDirs;
}

/**
 * 这个字段当前的值是不是「自动推导」来的（可以直接被工作区重算覆盖）。
 *
 * @param {object} settings 设置对象
 * @param {string} key      字段名
 * @param {string} defaultBase 默认工作区（「文档\测试工作台」），用于识别老版本写入的默认值
 */
function isAutoValue(settings, key, defaultBase) {
  const current = String((settings && settings[key]) || '').trim();
  if (!current) return true;
  const book = ensureBook(settings);
  const recorded = String(book[key] || '').trim();
  if (recorded && samePath(current, recorded)) return true;
  const fallback = derivePath(key, defaultBase);
  if (fallback && samePath(current, fallback)) return true;
  return false;
}

/** 记一笔：这个值是推导出来的 */
function markDerived(settings, key, value) {
  const book = ensureBook(settings);
  if (value) book[key] = value;
  else delete book[key];
}

/** 记一笔：这个值是用户填的（以后不许自动覆盖） */
function markUser(settings, key) {
  delete ensureBook(settings)[key];
}

/**
 * 启动时补默认值（**不建目录**，启动要快也要稳）。
 *
 * 优先级：工作区 > 「文档\测试工作台」。
 * 只动自动值（空值 / 账上值 / 旧默认值），用户显式填的一律保留。
 *
 * @param {object} settings   设置对象（会被就地修改）
 * @param {string} defaultBase 默认工作区
 * @returns {object} settings
 */
function applyStartupDefaults(settings, defaultBase) {
  const ws = String((settings && settings.workspaceDir) || '').trim();
  const base = ws || String(defaultBase || '').trim();
  if (!base) return settings;

  /**
   * 启动期推导一个字段（只算路径，不建目录）。
   * @returns {'derived'|'user'|'skipped'}
   */
  const derive = (key) => {
    // 没配工作区时，allureDir / projectDir 不兜底（见 SUB_DIRS.fromDefault 的说明）
    if (!ws && !FROM_DEFAULT.has(key)) return 'skipped';
    if (!isAutoValue(settings, key, defaultBase)) {
      markUser(settings, key);
      return 'user';
    }
    const target = derivePath(key, base);
    if (!target) return 'skipped';
    settings[key] = target;
    markDerived(settings, key, target);
    return 'derived';
  };

  // 顺序 = 设置页展示顺序；子目录名统一在 SUB_DIRS 里，这里只管「哪些键要补」
  derive('casesDir');
  derive('jmxDir');
  derive('reportDir');
  derive('allureDir');
  derive('kbDir');
  derive('notesDir');
  derive('projectDir');
  return settings;
}

/**
 * settings:set 收到 workspaceDir 之后：重新推导 7 个子目录 + 建目录。
 *
 * 三种情况分开处理（这是本次 bug 的核心）：
 *   - patch 里**显式填了具体路径** → 尊重用户输入，不覆盖（也不建目录）；
 *   - patch 里**显式传空串**        → 「我要清空，回退到推导」→ 按工作区重算；
 *   - patch 里**没有这个键**        → 只有自动值才重算，用户填的路径保持不动。
 *
 * @param {object} settings 设置对象（会被就地修改）
 * @param {object} patch    settings:set 收到的 patch
 * @param {object} [options]
 * @param {string} [options.defaultBase] 默认工作区（识别老版本默认值用）
 * @param {object} [options.io]          文件系统替身（测试注入用，默认 fs）
 * @returns {{workspaceDir:string, derived:string[], kept:string[], created:string[], failed:Array, skipped:number, rootReady:boolean}}
 *          推导报告：derived 重算的字段、kept 保留的字段、created 新建的目录、failed 建失败的目录
 */
function applyWorkspaceChange(settings, patch, options) {
  const opts = options || {};
  const io = opts.io || fs;
  const defaultBase = String(opts.defaultBase || '').trim();
  const base = String((settings && settings.workspaceDir) || '').trim();

  const report = {
    workspaceDir: base,
    derived: [],
    kept: [],
    created: [],
    failed: [],
    skipped: 0,
    rootReady: false
  };

  // 工作区根不存在（边输入边存时很常见）就只推导路径，不建目录
  if (base) {
    try {
      const st = io.statSync(base);
      report.rootReady = !!(st && typeof st.isDirectory === 'function' && st.isDirectory());
    } catch (e) {
      report.rootReady = false;
    }
  }

  for (const item of SUB_DIRS) {
    const key = item.key;
    const patched = patch ? patch[key] : undefined;
    const explicit = patched === undefined || patched === null ? null : String(patched).trim();

    // 用户这次显式填了具体路径：以他为准
    if (explicit) {
      markUser(settings, key);
      report.kept.push(key);
      continue;
    }
    // 没传这个键，而且当前值是用户自己填的：不动
    if (explicit === null && !isAutoValue(settings, key, defaultBase)) {
      markUser(settings, key);
      report.kept.push(key);
      continue;
    }

    const target = base ? derivePath(key, base) : ''; // 清空工作区 → 推导值也清空（不残留旧工作区路径）
    settings[key] = target;
    markDerived(settings, key, target);
    report.derived.push(key);
    if (!target) continue; // 没有工作区，没什么可建
    if (!report.rootReady) {
      report.skipped += 1;
      continue;
    }

    try {
      const existed = io.existsSync(target);
      io.mkdirSync(target, { recursive: true });
      if (!existed) report.created.push(target);
    } catch (err) {
      // 权限不足 / 路径非法：只提示，不阻塞保存，更不能把整个 settings:set 弄成异常
      report.failed.push({ dir: target, message: String((err && err.message) || err) });
    }
  }

  return report;
}

/**
 * 这次 settings:set 要不要重新推导 / 重建目录。
 *
 * 两种情况：
 *   1. patch 里带 workspaceDir（改了工作区，哪怕改成空串 = 清空）；
 *   2. patch 里把某个子目录**显式清空**（传空串 = 「我还是用推导值」）——
 *      比如用户把「笔记」那行删空，得立刻回退成 {工作区}/notes，
 *      否则空值会一路传到笔记页，页面直接打不开。
 *
 * @param {object} patch
 * @returns {boolean}
 */
function needsWorkspaceSync(patch) {
  if (!patch) return false;
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;
  if (has('workspaceDir')) return true;
  for (const key of DIR_KEYS) {
    if (has(key) && String(patch[key] === null ? '' : patch[key]).trim() === '') return true;
  }
  return false;
}

module.exports = {
  SUB_DIRS,
  DIR_KEYS,
  FROM_DEFAULT,
  defaultWorkspaceDir,
  derivePath,
  isAutoValue,
  applyStartupDefaults,
  applyWorkspaceChange,
  needsWorkspaceSync
};