'use strict';
/**
 * ipc-guard.js —— 所有 IPC 通道的统一解锁守卫。
 *
 * ============================================================
 * 为什么要有这一层（v0.42.0 的 High 缺口）
 * ============================================================
 * 锁定只是个界面状态：`locked` 只被部分 handler 里的 assertUnlocked() 检查。
 * 实测锁定态下 `data:export` / `data:import` / `backup:now` / `data:openDir` /
 * `settings:set` / `clipboard:copy` / `update:*` 等 13+ 个敏感通道**照样能调**，
 * 于是「锁屏」根本不是安全边界 —— 导出一次就拿到含明文口令的整库。
 *
 * 为什么不在每个域里手写 assertUnlocked：
 *   110 个通道、15 个域，手写一定会漏（这次漏的就是 13 个）。
 *   改成**默认全部要求解锁**，白名单显式放行 —— 以后新增通道自动带守卫，
 *   漏写的方向从「忘了加」变成「忘了放行」（表现为功能报错，一用就发现）。
 *
 * 白名单只有 6 项 + pin:* 一族：
 *   app:init      首屏拿版本/目录/锁状态（锁定时的锁屏页也要它）
 *   app:unlock    解锁本身
 *   app:lock      上锁（锁定态再上锁无副作用）
 *   settings:get  锁屏页要主题色/背景图，且不含任何秘密
 *   pin:*         设置/修改/清除锁屏密码（内部自己校验旧密码）
 *   update:check  只读一次 Release 页面，不写盘不执行
 *
 * scripts/test-ipc-unique.cjs 里有一条护栏断言：
 *   白名单之外的通道必须全部通过本文件包出来的 handle() 注册。
 *
 * ============================================================
 * v0.50.0：这一层**只管解锁**，不许再碰路径白名单
 * ============================================================
 * 曾经的 P0（已修）：包装层里有个 rememberIfScan()，只要通道名以 `:scan` 结尾
 * 就无条件把 `payload.root` 记成本会话可信根 —— root 完全没校验。
 * 于是渲染进程传一次 `root='C:\\'`，全盘就成了可信根，
 * 后续所有 assertPathIn 全部失效。
 *
 * 现在的规矩：
 *   1. 本文件不 require shared-helpers，也不往会话白名单里塞任何东西；
 *   2. 「记住扫描根」在各 *:scan handler 内部做，且必须先过
 *      sharedHelpers.acceptScanRoot()（挡盘符根 / 系统目录，见 shared-helpers.js）；
 *   3. 下面那张 PATH_PARAM_CHANNELS 列出所有带 file/dir/root 入参的通道，
 *      scripts/test-guard-paths.cjs 拿它做表驱动断言 ——
 *      以后新增带路径入参的通道，忘了加守卫会红，不会悄悄漏。
 */

/**
 * 带路径入参的通道总表（唯一事实源）。
 *
 * guard 取值：
 *   'seed'          —— *:scan 的 root，走 acceptScanRoot（校验 + 记成本会话可信根）
 *   'assertPathIn'  —— 单文件/单目录入参，handler 里必须有一处 assertPathIn(...)
 *   'dialog'        —— 路径只来自 dialog，渲染进程塞不进来（只记不校验）
 *   'updater'       —— 校验在 electron/updater.js 内部（下载目录 + sha512）
 *   'none'          —— 目前没有守卫（历史遗留 / 有意为之，note 写明原因）
 *
 * param 只是给人看的：handler 实际可能在 payload 里取（payload.dir）。
 */
const PATH_PARAM_CHANNELS = [
  /* ---- 扫描根（root）：先挡盘符根/系统目录，再记进会话白名单 ---- */
  { channel: 'kb:scan', param: 'root', guard: 'seed', note: '知识库索引' },
  { channel: 'notes:scan', param: 'root', guard: 'seed', note: '笔记索引' },
  { channel: 'cases:scan', param: 'root', guard: 'seed', note: '用例索引' },
  { channel: 'jmx:scan', param: 'root', guard: 'seed', note: 'jmx 索引' },
  { channel: 'allure:scan', param: 'root', guard: 'seed', note: 'Allure 报告根扫描' },
  { channel: 'report:scan', param: 'root', guard: 'seed', note: '压测报告根扫描' },
  { channel: 'projects:scan', param: 'root', guard: 'seed', note: '代码项目扫描' },

  /* ---- 单文件 / 单目录入参：assertPathIn ---- */
  { channel: 'kb:openFile', param: 'file', guard: 'assertPathIn' },
  { channel: 'kb:reveal', param: 'file', guard: 'assertPathIn' },
  { channel: 'notes:openFile', param: 'file', guard: 'assertPathIn' },
  { channel: 'notes:reveal', param: 'file', guard: 'assertPathIn' },
  { channel: 'notes:import', param: 'files', guard: 'assertPathIn', note: '会 rename 用户文件，逐个校验' },
  { channel: 'cases:openFile', param: 'file', guard: 'assertPathIn' },
  { channel: 'cases:reveal', param: 'file', guard: 'assertPathIn' },
  { channel: 'openapi:parseFile', param: 'file', guard: 'assertPathIn' },
  { channel: 'apis:sync', param: 'file', guard: 'assertPathIn', note: '读 openapi.json 写接口镜像' },
  { channel: 'jmx:detail', param: 'file', guard: 'assertPathIn' },
  { channel: 'jmx:writeback', param: 'file', guard: 'assertPathIn', note: '唯一改动用户已有 jmx 的通道（L2），写盘全在 jmx-writeback.js' },
  { channel: 'jmx:openFile', param: 'file', guard: 'assertPathIn' },
  { channel: 'jmx:reveal', param: 'file', guard: 'assertPathIn' },
  { channel: 'jmx:openGui', param: 'file', guard: 'assertPathIn', note: '交给 launchJmeter 前先过白名单' },
  { channel: 'jmxgen:save', param: 'dir', guard: 'assertPathIn', note: '往 dir 写 .jmx' },
  { channel: 'codegen:save', param: 'dir', guard: 'assertPathIn', note: '往 dir 写骨架代码' },
  { channel: 'report:parse', param: 'dir', guard: 'assertPathIn' },
  { channel: 'allure:parse', param: 'dir', guard: 'assertPathIn' },
  { channel: 'allure:flaky', param: 'dirs', guard: 'assertPathIn', note: '任一越界整单拒绝' },
  { channel: 'allure:archive', param: 'dir', guard: 'assertPathIn' },
  { channel: 'codescan:coverage', param: 'root', guard: 'assertPathIn' },
  { channel: 'codescan:hardcoded', param: 'root', guard: 'assertPathIn' },
  { channel: 'codescan:deps', param: 'root', guard: 'assertPathIn' },
  { channel: 'projects:testClasses', param: 'dir', guard: 'assertPathIn' },
  { channel: 'projects:locateTest', param: 'root', guard: 'assertPathIn', note: '在项目中定位（payload.root，属 ipc-projects.js）' },
  { channel: 'projects:reveal', param: 'file', guard: 'assertPathIn', note: '在文件管理器里选中（属 ipc-projects.js）' },
  { channel: 'backup:restore', param: 'file', guard: 'assertPathIn', note: '外来 .db 覆盖整库' },
  { channel: 'data:genFile', param: 'dir', guard: 'assertPathIn', note: '往 dir 写 csv/json' },

  /* ---- 路径来自 dialog 或自带校验 ---- */
  { channel: 'update:install', param: 'file', guard: 'updater', note: 'updater.install 校验下载目录 + sha512' },
  { channel: 'links:forCase', param: 'filePath', guard: 'none', note: '只是关联键，不碰文件系统' },
  { channel: 'data:openWorkspace', param: 'dir', guard: 'none', note: '只 shell.openPath，不读不写（ipc-records.js，另议）' },
  { channel: 'runner:run', param: 'file', guard: 'none', note: '按设计执行用户给的代码，路径守卫在这一层没有意义' }
];

/** 锁定态也允许调用的通道（精确匹配） */
const UNLOCK_WHITELIST = [
  'app:init',
  'app:unlock',
  'app:lock',
  'settings:get',
  'update:check'
];

/** 锁定态也允许调用的通道（前缀匹配） */
const UNLOCK_WHITELIST_PREFIX = ['pin:'];

/**
 * 这个通道需不需要解锁。
 * @param {string} channel
 * @returns {boolean} true = 需要先解锁
 */
function needsUnlock(channel) {
  const ch = String(channel === undefined || channel === null ? '' : channel);
  if (!ch) return true; // 空通道名按「需要解锁」处理（宁可拒绝）
  if (UNLOCK_WHITELIST.indexOf(ch) >= 0) return false;
  for (const p of UNLOCK_WHITELIST_PREFIX) {
    if (ch.indexOf(p) === 0) return false;
  }
  return true;
}

/**
 * 扫描类通道（root 参数 = 扫描种子）。
 *
 * 注意语义变化（v0.50.0）：以前本文件据此**自动记根**（P0 的来源）；
 * 现在它只是一个查询函数（给表驱动测试和排查用），
 * 校验和记忆都在各 *:scan handler 内部通过 acceptScanRoot 完成。
 */
function isScanChannel(channel) {
  return /:scan$/.test(String(channel === undefined || channel === null ? '' : channel));
}

/**
 * 造一个带解锁守卫的 handle()。
 *
 * **这里只加解锁校验**：不要往这个包装层里塞任何「按参数改状态」的逻辑
 * （v0.50.0 的 P0 就是 rememberIfScan 这么来的 —— 它在 fn 之前跑，
 * 所以哪怕 handler 自己后来拒绝了入参，信任也已经记进去了）。
 *
 * @param {object} deps
 * @param {object} deps.ipcMain Electron 的 ipcMain
 * @param {() => void} deps.assertUnlocked 锁定态会抛 code='LOCKED' 的函数
 * @returns {(channel: string, fn: Function) => void}
 */
function createHandle(deps) {
  const { ipcMain, assertUnlocked } = deps || {};
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('createHandle 需要 ipcMain');
  }
  if (typeof assertUnlocked !== 'function') {
    throw new Error('createHandle 需要 assertUnlocked');
  }

  return function handle(channel, fn) {
    if (!channel || typeof fn !== 'function') {
      throw new Error('handle(channel, fn) 参数不合法：' + String(channel));
    }
    const guarded = needsUnlock(channel);
    const wrapped = function (event, ...args) {
      // 先解锁校验，再调 handler（锁定态一律拒绝，不做任何副作用）
      if (guarded) assertUnlocked();
      return fn(event, ...args);
    };
    return ipcMain.handle(channel, wrapped);
  };
}

module.exports = {
  UNLOCK_WHITELIST,
  UNLOCK_WHITELIST_PREFIX,
  PATH_PARAM_CHANNELS,
  needsUnlock,
  isScanChannel,
  createHandle
};