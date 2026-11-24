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
 */

const sharedHelpers = require('./shared-helpers');

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

/** 扫描类通道（root 参数记成本会话可信根，见 shared-helpers.assertPathIn） */
function isScanChannel(channel) {
  return /:scan$/.test(String(channel === undefined || channel === null ? '' : channel));
}

/**
 * 造一个带解锁守卫的 handle()。
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

  /** 扫描通道：把用户显式给的 root 记进会话白名单 */
  function rememberIfScan(channel, payload) {
    if (!isScanChannel(channel)) return;
    if (!payload || typeof payload !== 'object') return;
    const root = payload.root;
    if (typeof root === 'string' && root.trim()) sharedHelpers.rememberRoot(root);
  }

  return function handle(channel, fn) {
    if (!channel || typeof fn !== 'function') {
      throw new Error('handle(channel, fn) 参数不合法：' + String(channel));
    }
    const guarded = needsUnlock(channel);
    const wrapped = function (event, ...args) {
      // 先解锁校验，再动任何状态（锁定态不允许写会话白名单）
      if (guarded) assertUnlocked();
      rememberIfScan(channel, args[0]);
      return fn(event, ...args);
    };
    return ipcMain.handle(channel, wrapped);
  };
}

module.exports = {
  UNLOCK_WHITELIST,
  UNLOCK_WHITELIST_PREFIX,
  needsUnlock,
  isScanChannel,
  createHandle
};