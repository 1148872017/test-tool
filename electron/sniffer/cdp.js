'use strict';
/**
 * cdp.js —— 够用就好的 Chrome DevTools Protocol 客户端（不引第三方依赖）。
 *
 * ============================================================
 * 为什么要自己写
 * ============================================================
 * 需求是「用系统浏览器实时高亮定位器」：只用得到 Page.navigate / Page.enable /
 * Page.addScriptToEvaluateOnNewDocument / Runtime.evaluate 这四个命令。
 * 为此装 puppeteer / chrome-remote-interface 要多带几十 MB 依赖，
 * 而且 electron 主进程（Node 22）**自带 WebSocket 与 fetch**，直连 CDP 完全够。
 *
 * ============================================================
 * 边界（比功能重要）
 * ============================================================
 *   · 只连我们自己拉起的那个 target（页面），不碰浏览器级 target；
 *   · 只发上面那几个命令 —— 不读 cookie、不读 localStorage、不读页面内容；
 *   · 所有请求都有超时，超时/断线都会 reject，绝不挂着不回；
 *   · 断线只标记 closed，重连由上层（browser-session）决定。
 */

const DEFAULT_TIMEOUT_MS = 15000;

/** 给调用方判断「是不是通道断了」用（上层据此改报 running:false） */
function isClosedError(err) {
  const code = err && err.code;
  return code === 'CDP_CLOSED' || code === 'CDP_CONNECT';
}

function cdpError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 连上一个 CDP WebSocket 端点。
 *
 * @param {string} wsUrl 形如 ws://127.0.0.1:PORT/devtools/page/XXXX
 * @param {object} [options]
 * @param {number} [options.timeout] 单个命令的默认超时（毫秒）
 * @param {Function} [options.WebSocketImpl] 注入 WebSocket 实现（测试/别的运行时用）
 * @param {(reason: string) => void} [options.onClose] 通道断开时的回调
 * @returns {Promise<object>} client：{send, waitFor, close, closed, url}
 */
function createCdpClient(wsUrl, options) {
  const opt = options || {};
  const defaultTimeout = Math.max(1000, Number(opt.timeout) || DEFAULT_TIMEOUT_MS);
  const WS = opt.WebSocketImpl || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : null);
  const url = String(wsUrl || '');

  if (!url) return Promise.reject(cdpError('CDP 地址为空', 'CDP_CONNECT'));
  if (typeof WS !== 'function') {
    return Promise.reject(
      cdpError('当前运行环境没有全局 WebSocket（需要 Node 22+ 或 Electron 主进程）', 'CDP_CONNECT')
    );
  }

  let socket;
  try {
    socket = new WS(url);
  } catch (e) {
    return Promise.reject(cdpError('创建 WebSocket 失败：' + ((e && e.message) || e), 'CDP_CONNECT'));
  }

  /** id → {resolve, reject, timer, method} */
  const pending = new Map();
  /** CDP 事件名 → 等待者数组 */
  const waiters = new Map();
  let nextId = 0;
  let closed = false;
  let closeReason = '';

  const client = {
    url,
    get closed() {
      return closed;
    },
    get closeReason() {
      return closeReason;
    },
    get pendingCount() {
      return pending.size;
    },
    send,
    waitFor,
    close
  };

  function failAll(reason) {
    const errs = [];
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(cdpError(item.method + ' 因通道关闭失败：' + reason, 'CDP_CLOSED'));
      errs.push(item.method);
    }
    pending.clear();
    for (const [method, list] of waiters) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(cdpError('等待事件 ' + method + ' 时通道关闭：' + reason, 'CDP_CLOSED'));
      }
    }
    waiters.clear();
    return errs;
  }

  function markClosed(reason) {
    if (closed) return;
    closed = true;
    closeReason = String(reason || '');
    failAll(closeReason || 'closed');
    if (typeof opt.onClose === 'function') {
      try {
        opt.onClose(closeReason);
      } catch (e) {
        /* 回调自己出错不能影响收尾 */
      }
    }
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // 1) 命令回包：按 id 对成
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (msg.error) {
        item.reject(
          cdpError(
            item.method + ' 失败：' + (msg.error.message || '未知错误') + '（code ' + msg.error.code + '）',
            'CDP_ERROR',
            { cdpCode: msg.error.code, cdpData: msg.error.data }
          )
        );
      } else {
        item.resolve(msg.result || {});
      }
      return;
    }

    // 2) 事件：分发给等待者
    if (msg.method) {
      const list = waiters.get(msg.method);
      if (list && list.length) {
        const one = list.shift();
        if (!list.length) waiters.delete(msg.method);
        clearTimeout(one.timer);
        one.resolve(msg.params || {});
      }
      return;
    }
  }

  function send(method, params, timeoutMs) {
    if (closed) {
      return Promise.reject(cdpError('CDP 通道已关闭：' + closeReason, 'CDP_CLOSED'));
    }
    const name = String(method || '');
    if (!name) return Promise.reject(cdpError('CDP 方法名为空', 'CDP_ERROR'));
    const wait = Math.max(500, Number(timeoutMs) || defaultTimeout);

    return new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(cdpError(name + ' 超时（' + wait + 'ms）', 'CDP_TIMEOUT'));
      }, wait);
      pending.set(id, { resolve, reject, timer, method: name });
      try {
        socket.send(JSON.stringify({ id, method: name, params: params || {} }));
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(cdpError(name + ' 发送失败：' + ((e && e.message) || e), 'CDP_CLOSED'));
      }
    });
  }

  /** 等一个 CDP 事件（比如 Page.loadEventFired）；超时 reject */
  function waitFor(method, timeoutMs) {
    const name = String(method || '');
    if (closed) return Promise.reject(cdpError('CDP 通道已关闭：' + closeReason, 'CDP_CLOSED'));
    const wait = Math.max(200, Number(timeoutMs) || defaultTimeout);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = waiters.get(name) || [];
        const idx = list.findIndex((w) => w.timer === timer);
        if (idx >= 0) list.splice(idx, 1);
        if (!list.length) waiters.delete(name);
        reject(cdpError('等待事件 ' + name + ' 超时（' + wait + 'ms）', 'CDP_TIMEOUT'));
      }, wait);
      if (!waiters.has(name)) waiters.set(name, []);
      waiters.get(name).push({ resolve, reject, timer });
    });
  }

  function close() {
    if (closed) return;
    markClosed('客户端主动关闭');
    try {
      socket.close();
    } catch (e) {
      /* 已经断了就算了 */
    }
  }

  socket.addEventListener('message', (ev) => handleMessage(ev && ev.data));
  socket.addEventListener('error', (ev) => {
    markClosed('WebSocket 出错' + (ev && ev.message ? '：' + ev.message : ''));
  });
  socket.addEventListener('close', () => {
    markClosed('WebSocket 已断开');
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      markClosed('连接超时');
      reject(cdpError('连 CDP 超时（' + defaultTimeout + 'ms）', 'CDP_CONNECT'));
    }, defaultTimeout);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(cdpError('连 CDP 失败：' + url, 'CDP_CONNECT'));
    });
  });
}

module.exports = { createCdpClient, isClosedError, DEFAULT_TIMEOUT_MS };