'use strict';
/**
 * ipc-sniff.js —— 「用系统浏览器实时高亮定位器」的 IPC 域。
 *
 * ============================================================
 * 五个通道（全部走 deps.handle + assertUnlocked）
 * ============================================================
 *   sniff:status     入参 {}                        查会话状态（界面轮询用）
 *   sniff:start      入参 {url,name,mode,selector}  起浏览器 + 打开页面 + 高亮
 *   sniff:highlight  入参 {name,mode,selector}      不导航，只重新框
 *                                                  （浏览器被关掉了会按记住的地址自动拉起）
 *   sniff:reopen     入参 {url}                     重新导航并框住当前元素
 *   sniff:stop       入参 {}                        关掉浏览器（幂等）
 *
 * 统一返回形状（五个通道完全一致，前端只认一套）：
 *   { ok, running, browser, url, name, mode, selector,
 *     found, total, visible, inIframe, reason, message, browserVersion }
 *
 *   ok        —— 这一次操作本身成没成（status 恒为 true：查询成功就是成功，
 *                浏览器在不在看 running，免得界面轮询时老弹错误）
 *   running   —— 浏览器会话还在不在（用户自己关窗口后会变 false）
 *   browser   —— 'edge' | 'chrome'（没起来过是空串）
 *   found     —— 匹配到几个元素
 *   total     —— 上报上下文里的匹配总数（正常等于 found）
 *   visible   —— 第一个是否可见
 *   inIframe  —— 是否在 iframe 里
 *   reason    —— '' / 'not-found' / 'in-iframe' / 'shadow-dom'
 *   message   —— 一句人话（只描述事实，不判对错）
 *
 * ============================================================
 * 安全边界
 * ============================================================
 *   · url 只允许 http/https，非法**直接**回 ok:false；
 *     这里不用 assertPathIn —— 那是文件路径守卫，对 URL 没有意义（也会误判）；
 *   · 不读 cookie / localStorage / 页面内容，只做「导航 + 注入高亮」；
 *   · 浏览器只监听 127.0.0.1 的随机端口（见 sniffer/browser-session.js）；
 *   · 应用退出时（before-quit / process exit）同步杀掉浏览器进程，不留残尸。
 */

const sessionModule = require('../sniffer/browser-session');

/** process exit 钩子只挂一次（多次 require/register 不重复挂） */
let exitHooked = false;
/** 所有活着的会话（退出时统一收尾；正常只有一个） */
const liveSessions = [];

/** 非法 url 的统一回执文案 */
const URL_REJECT = '只支持 http:// 或 https:// 开头的链接';

function register(deps) {
  const { handle, assertUnlocked, dataDir, app, logStartup } = deps;

  /**
   * 一个 IPC 域一个会话（模块级单例，但不放全局）：
   * 浏览器关了再开是同一个会话对象，界面状态不会丢（url/name/mode/selector 都还在）。
   */
  const sniffer = sessionModule.createSession({
    dataDir,
    log: typeof logStartup === 'function' ? (msg) => logStartup('[sniff] ' + msg) : undefined
  });

  /**
   * 应用退出要杀干净。
   *
   * 为什么挂在这里而不是 main.js：
   *   本域是自己接线的（main.js 里 IPC 域是自动加载的），
   *   为了一个功能去改装配层不划算；deps.app 就是真 app，挂事件一样有效。
   * before-quit 里只做同步 taskkill（异步等不到），所以用 stopSync。
   */
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      sniffer.stopSync();
    });
    app.on('will-quit', () => {
      sniffer.stopSync();
    });
  }
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const one of liveSessions) {
        try {
          one.stopSync();
        } catch (e) {
          /* 退出路径上不能再抛 */
        }
      }
    });
  }
  liveSessions.push(sniffer);

  // ---- 状态 ----
  handle('sniff:status', async () => {
    assertUnlocked();
    return sniffer.status();
  });

  // ---- 起浏览器 + 打开页面 + 高亮 ----
  handle('sniff:start', async (e, payload = {}) => {
    assertUnlocked();
    const { url, name, mode, selector } = payload || {};
    if (!sniffer.isHttpUrl(url)) return sniffer.reject(URL_REJECT);
    return sniffer.start({ url, name, mode, selector });
  });

  // ---- 只重新框（不导航） ----
  handle('sniff:highlight', async (e, payload = {}) => {
    assertUnlocked();
    const { name, mode, selector } = payload || {};
    return sniffer.highlight({ name, mode, selector });
  });

  // ---- 重新导航并框住当前元素 ----
  handle('sniff:reopen', async (e, payload = {}) => {
    assertUnlocked();
    const { url } = payload || {};
    const raw = String(url === undefined || url === null ? '' : url).trim();
    // 不传 url = 用会话里的地址重开；传了就必须是 http/https
    if (raw && !sniffer.isHttpUrl(raw)) return sniffer.reject(URL_REJECT);
    return sniffer.reopen({ url: raw });
  });

  // ---- 关掉浏览器 ----
  handle('sniff:stop', async () => {
    assertUnlocked();
    return sniffer.stop();
  });
}

module.exports = { register, URL_REJECT };