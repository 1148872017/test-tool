'use strict';
/**
 * nav-guard.js —— 窗口导航护栏（纯函数，方便单测）。
 *
 * ============================================================
 * 为什么需要（v0.42.0 的 High 缺口：markdown 外链 → RCE）
 * ============================================================
 * 知识库 / 笔记的 markdown 是 innerHTML 渲染的，DOMPurify 会保留 `<a href>`。
 * 而窗口上没有 `will-navigate`、也没有 `setWindowOpenHandler`：
 *
 *   用户点了一个 `https://evil.com/x` 的外链
 *     → 当前窗口直接导航过去（还在同一个 BrowserWindow 里）
 *     → 新页面保留了 window.api（preload 已注入）
 *     → 那个页面调 window.api.exportData() / updateInstall() 就是任意 IPC
 *
 * 所以两道口子都得焊死：
 *   1. `will-navigate`：只允许留在 app 自己的 file:// 页面，其余 preventDefault；
 *   2. `setWindowOpenHandler`：一律 deny，需要开外链的转 shell.openExternal，
 *      且只放行 http/https（file: / javascript: / ms-msdt: 一律不放）。
 */

const path = require('path');

/**
 * 是不是 app 自己的页面。
 *
 * loadFile() 出来的地址是 `file:///D:/.../dist/index.html`，
 * 只认 dist 目录下的 file:// 页面；`file:///C:/Windows/...` 不算。
 *
 * @param {string} url
 * @param {string} appDir dist 目录的绝对路径
 * @returns {boolean}
 */
function isAppUrl(url, appDir) {
  const u = String(url === undefined || url === null ? '' : url);
  const dir = String(appDir === undefined || appDir === null ? '' : appDir).trim();
  if (!u || !dir) return false;
  let parsed;
  try {
    parsed = new URL(u);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;

  let target;
  try {
    // file:///D:/a%20b/index.html → pathname='/D:/a b/index.html'
    target = decodeURIComponent(parsed.pathname || '');
  } catch (e) {
    target = parsed.pathname || '';
  }
  // Windows 上 pathname 以 / 开头（/D:/...），去掉它再 resolve
  const noSlash = target.replace(/^\/+/, '');
  if (!noSlash) return false;

  let realTarget;
  let realDir;
  try {
    realTarget = path.resolve(noSlash);
    realDir = path.resolve(dir);
  } catch (e) {
    return false;
  }
  if (process.platform === 'win32') {
    realTarget = realTarget.toLowerCase();
    realDir = realDir.toLowerCase();
  }
  if (realTarget === realDir) return true;
  const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  return realTarget.startsWith(prefix);
}

/**
 * 允许用系统浏览器打开的外链：只有 http / https。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isExternalUrlAllowed(url) {
  const u = String(url === undefined || url === null ? '' : url).trim();
  if (!u) return false;
  let parsed;
  try {
    parsed = new URL(u);
  } catch (e) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * 从 HTML 里找可安全外开的链接（供 markdown 里的 <a href> 用）。
 * 非 http/https 一律返回空串。
 *
 * @param {string} href
 * @returns {string} 可交给 shell.openExternal 的 URL，或空串
 */
function safeExternalHref(href) {
  const raw = String(href === undefined || href === null ? '' : href).trim();
  if (!raw) return '';
  // 相对链接（./x.md、#anchor）不归外链处理
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
  return isExternalUrlAllowed(raw) ? raw : '';
}

module.exports = { isAppUrl, isExternalUrlAllowed, safeExternalHref };