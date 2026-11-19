'use strict';
/**
 * 应用内更新：检查 → 下载 → 启动安装器
 *
 * ============================================================
 * 检查更新的三种方式（v0.26.7 重写）
 * ============================================================
 * 问题：GitHub API 匿名限流 60 次/小时，用户点几次就 403。
 *
 * 方案演进：
 *   1. GitHub API `/releases/latest` → 消耗配额，会 403
 *   2. **重定向法**（首选）：请求 `releases/latest` 不跟随重定向，
 *      从 302 的 Location 头拿 tag（`.../releases/tag/v0.26.6`）
 *      → **零配额消耗**，永远不会 403
 *   3. API 兜底：重定向法失败时再试 API
 *
 * 下载链接是固定格式，不用 API 也能拼：
 *   https://github.com/{repo}/releases/download/{tag}/{assetName}
 *
 * 其他设计：
 *   - 多连接分段下载（4 并发，绕过 CDN 单连接限速）
 *   - 可取消 / 断点续传 / 速度显示
 */
const fs = require('fs');
const path = require('path');
const { shell, app, net } = require('electron');

const REPO = '1148872017/test-tool';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const REDIRECT_LATEST = `https://github.com/${REPO}/releases/latest`;
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;

/** 并发连接数 */
const CONCURRENCY = 4;
/** 小于这个大小不分段 */
const MIN_SEGMENT_SIZE = 2 * 1024 * 1024;

let activeReqs = [];
let cancelled = false;

/** 语义化版本比较 */
function compareVersion(a, b) {
  const pa = String(a || '0')
    .replace(/^v/i, '')
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0')
    .replace(/^v/i, '')
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 用 Electron net 发 GET，返回 { status, headers, body, url } */
function netGet(url, extraHeaders, redirectMode) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: redirectMode || 'follow' });
    } catch (e) {
      return reject(e);
    }
    req.setHeader('User-Agent', 'test-tool-updater');
    if (extraHeaders) {
      for (const k of Object.keys(extraHeaders)) req.setHeader(k, extraHeaders[k]);
    }

    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          // 跟随重定向后的最终 URL（Electron 的 IncomingMessage 没有 url 属性，
          // 但 response 事件里能拿到 headers，这里用 res.url 兜底）
          url: res.url || ''
        })
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 方式 1：解析 Release 页面（零配额）。
 *
 * 为什么不用 `redirect: 'manual'` 读 Location 头：
 *   Electron 的 net 模块在 manual 模式下实测报 `ERR_CONNECTION_CLOSED`。
 *
 * 改用 `redirect: 'follow'` 跟到最终页面，从 HTML 里解析 tag：
 *   页面里一定有 `<a href="/1148872017/test-tool/releases/tag/v0.26.8">`
 */
async function checkByRedirect() {
  const res = await netGet(REDIRECT_LATEST, null, 'follow');
  if (res.status !== 200) {
    return { ok: false, message: `Release 页面返回 ${res.status}` };
  }
  const html = res.body ? res.body.toString('utf8') : '';
  // 优先找 canonical / og:url 里的 tag
  let m = /\/releases\/tag\/(v[\d.]+)/.exec(html);
  if (!m) {
    // 兜底：找页面标题里的版本号
    m = /releases\/tag\/([\d.]+)/.exec(html);
  }
  if (!m) return { ok: false, message: '页面里找不到版本号' };
  const tag = m[1].startsWith('v') ? m[1] : 'v' + m[1];
  return { ok: true, tag, latest: tag.replace(/^v/i, '') };
}

/**
 * 方式 2：API 兜底（消耗配额）。
 */
async function checkByApi() {
  const res = await netGet(API_LATEST, { Accept: 'application/vnd.github+json' });
  if (res.status === 403) {
    return { ok: false, message: 'GitHub API 限流（每小时 60 次），请稍后再试' };
  }
  if (res.status === 404) return { ok: false, message: '仓库还没有发布任何 Release' };
  if (res.status !== 200) return { ok: false, message: `GitHub API 返回 ${res.status}` };
  const rel = JSON.parse(res.body.toString('utf8'));
  const tag = String(rel.tag_name || '');
  const latest = tag.replace(/^v/i, '');
  const asset = (rel.assets || []).find((a) => /Setup/i.test(a.name) && /\.exe$/i.test(a.name));
  return {
    ok: true,
    tag,
    latest,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
    notes: rel.body || '',
    publishedAt: rel.published_at || ''
  };
}

/** 检查结果缓存（避免高频请求） */
let lastCheck = null;
/** 缓存有效期：10 分钟 */
const CACHE_TTL = 10 * 60 * 1000;

/** 检查更新 */
async function checkUpdate(force) {
  const current = app.getVersion();

  // 缓存命中：10 分钟内重复点「检查更新」直接用上次结果
  if (!force && lastCheck && Date.now() - lastCheck.at < CACHE_TTL) {
    return Object.assign({}, lastCheck.data, { cached: true });
  }

  try {
    // 优先用页面解析（不消耗 API 配额）
    let info = await checkByRedirect();
    if (!info.ok) {
      // 兜底：API（消耗配额，但只在页面解析失败时用）
      info = await checkByApi();
    }
    if (!info.ok) return { ok: false, message: info.message };

    const latest = info.latest;
    const tag = info.tag || 'v' + latest;

    // 附件名是固定格式：test-tool-Setup-{version}-x64.exe
    const asset =
      info.asset ||
      {
        name: `test-tool-Setup-${latest}-x64.exe`,
        size: 0,
        url: `${DOWNLOAD_BASE}/${tag}/test-tool-Setup-${latest}-x64.exe`
      };

    const result = {
      ok: true,
      hasNew: compareVersion(latest, current) > 0,
      current,
      latest,
      asset,
      notes: info.notes || '',
      publishedAt: info.publishedAt || ''
    };

    lastCheck = { at: Date.now(), data: result };
    return result;
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 取消当前下载 */
function cancel() {
  cancelled = true;
  for (const r of activeReqs) {
    try {
      r.abort();
    } catch (e) {
      /* ignore */
    }
  }
  activeReqs = [];
  return { ok: true };
}

function downloadDir() {
  const dir = path.join(app.getPath('temp'), 'test-tool-update');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* ignore */
  }
  return dir;
}

/** 探测远端文件：总大小 + 是否支持 Range */
function probe(url) {
  return new Promise((resolve) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (e) {
      return resolve({ ok: false, message: String((e && e.message) || e) });
    }
    req.setHeader('User-Agent', 'test-tool-updater');
    req.setHeader('Range', 'bytes=0-0');

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        req.abort();
      } catch (e) {
        /* ignore */
      }
      resolve(v);
    };

    req.on('response', (res) => {
      const code = res.statusCode;
      const cr = res.headers['content-range'];
      let total = 0;
      let supportsRange = false;
      if (code === 206 && cr) {
        const m = /\/(\d+)\s*$/.exec(String(cr));
        if (m) total = Number(m[1]);
        supportsRange = true;
      } else if (code === 200) {
        total = Number(res.headers['content-length']) || 0;
        supportsRange = false;
      }
      res.on('data', () => {});
      res.on('end', () => done({ ok: true, total, supportsRange }));
      res.on('error', () => done({ ok: false, message: '探测失败' }));
    });
    req.on('error', (e) => done({ ok: false, message: String((e && e.message) || e) }));
    req.end();
  });
}

/** 下载单个分段 */
function downloadSegment(url, start, end, filePath, onBytes) {
  return new Promise((resolve) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (e) {
      return resolve({ ok: false, received: 0, message: String((e && e.message) || e) });
    }
    activeReqs.push(req);
    req.setHeader('User-Agent', 'test-tool-updater');
    req.setHeader('Range', `bytes=${start}-${end}`);

    let received = 0;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      const i = activeReqs.indexOf(req);
      if (i >= 0) activeReqs.splice(i, 1);
      resolve(v);
    };

    req.on('response', (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.on('data', () => {});
        return done({ ok: false, received: 0, message: `HTTP ${res.statusCode}` });
      }
      const ws = fs.createWriteStream(filePath, { flags: 'r+', start });
      res.on('data', (chunk) => {
        if (cancelled) return;
        const buf = Buffer.from(chunk);
        received += buf.length;
        ws.write(buf);
        if (onBytes) onBytes(buf.length);
      });
      res.on('end', () => ws.end(() => done({ ok: true, received })));
      res.on('error', (e) => {
        try {
          ws.destroy();
        } catch (err) {
          /* ignore */
        }
        done({ ok: false, received, message: String((e && e.message) || e) });
      });
    });
    req.on('error', (e) => done({ ok: false, received, message: String((e && e.message) || e) }));
    req.end();
  });
}

/** 多连接分段下载 */
function download(asset, onProgress) {
  return new Promise(async (resolve) => {
    if (!asset || !asset.url) return resolve({ ok: false, message: '没有可下载的安装包' });

    cancelled = false;
    activeReqs = [];
    const dir = downloadDir();
    const file = path.join(dir, asset.name);

    const info = await probe(asset.url);
    if (!info.ok) return resolve({ ok: false, message: '探测文件失败：' + (info.message || '') });
    const total = info.total || Number(asset.size) || 0;
    if (!total) return resolve({ ok: false, message: '拿不到文件大小' });

    const useMulti = info.supportsRange && total >= MIN_SEGMENT_SIZE;
    const parts = useMulti ? CONCURRENCY : 1;
    const segSize = Math.ceil(total / parts);

    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, total);
      fs.closeSync(fd);
    } catch (e) {
      return resolve({ ok: false, message: '创建文件失败：' + ((e && e.message) || e) });
    }

    let received = 0;
    const samples = [];
    const pushSample = () => {
      const now = Date.now();
      samples.push({ t: now, b: received });
      while (samples.length > 2 && now - samples[0].t > 3000) samples.shift();
    };
    const speedNow = () => {
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt <= 0) return 0;
      return Math.max(0, (last.b - first.b) / dt);
    };
    pushSample();

    const onBytes = (n) => {
      received += n;
      pushSample();
      if (onProgress) {
        const speed = speedNow();
        const remain = Math.max(0, total - received);
        const eta = speed > 0 ? Math.round(remain / speed) : 0;
        onProgress({
          pct: Math.min(100, Math.round((received / total) * 100)),
          received,
          total,
          speed,
          eta,
          connections: parts
        });
      }
    };

    const tasks = [];
    for (let i = 0; i < parts; i++) {
      const start = i * segSize;
      const end = Math.min(total - 1, start + segSize - 1);
      if (start > end) break;
      tasks.push(downloadSegment(asset.url, start, end, file, onBytes));
    }

    const results = await Promise.all(tasks);

    if (cancelled) return resolve({ ok: false, cancelled: true, message: '已取消' });

    const bad = results.find((r) => !r.ok);
    if (bad) return resolve({ ok: false, message: '下载失败：' + (bad.message || '未知错误') });

    let actual = 0;
    try {
      actual = fs.statSync(file).size;
    } catch (e) {
      return resolve({ ok: false, message: '下载完成但文件读不到' });
    }
    if (actual !== total) {
      return resolve({ ok: false, message: `文件大小不符（期望 ${total}，实际 ${actual}）` });
    }

    resolve({ ok: true, file });
  });
}

/** 清理下载残留 */
function cleanup() {
  const dir = downloadDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return { ok: true };
}

/** 启动安装器 */
async function install(exePath) {
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, message: '安装包不存在：' + exePath };
  }
  const err = await shell.openPath(exePath);
  if (err) return { ok: false, message: err };
  return { ok: true };
}

module.exports = { compareVersion, checkUpdate, download, cancel, cleanup, install };
