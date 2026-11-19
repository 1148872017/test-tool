'use strict';
/**
 * 应用内更新：检查 → 下载 → 启动安装器
 *
 * 仓库是 Public，不需要 token。
 *
 * ============================================================
 * 下载策略演进
 * ============================================================
 * v0.26.0：Node https 单连接 → 39 KB/s（不走系统代理）
 * v0.26.4：Electron net 单连接 → 90 KB/s（走代理了，但单连接被限速）
 * v0.26.5：**多连接分段下载** → 目标接近浏览器速度
 *
 * 为什么单连接慢：
 *   GitHub 的 CDN（objects.githubusercontent.com）对**单个 TCP 连接**限速，
 *   浏览器下载器（IDM、Chrome）都用 4-8 个并发连接分段拉，所以快。
 *
 * 多连接实现要点：
 *   1. 先发 HEAD 或 Range: bytes=0-0 拿总大小 + 确认支持 Range
 *   2. 把文件切成 N 段，每段一个 net.request，带 Range 头
 *   3. 各段写入同一个文件的对应偏移（fs.createWriteStream + start）
 *   4. 任一段失败 → 整体失败，但已下载的段保留（下次续传）
 *   5. 取消 → abort 所有连接
 */
const fs = require('fs');
const path = require('path');
const { shell, app, net } = require('electron');

const REPO = '1148872017/test-tool';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

/** 并发连接数：4 是速度和稳定性的平衡点（浏览器一般 6） */
const CONCURRENCY = 4;
/** 小于这个大小不分段（分段开销不划算） */
const MIN_SEGMENT_SIZE = 2 * 1024 * 1024; // 2 MB

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

/** 用 Electron net 发 GET，返回 { status, headers, body(Buffer) } */
function netGet(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (e) {
      return reject(e);
    }
    req.setHeader('User-Agent', 'test-tool-updater');
    req.setHeader('Accept', 'application/vnd.github+json');
    if (extraHeaders) {
      for (const k of Object.keys(extraHeaders)) req.setHeader(k, extraHeaders[k]);
    }

    const chunks = [];
    req.on('response', (res) => {
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** 检查更新 */
async function checkUpdate() {
  const current = app.getVersion();
  try {
    const res = await netGet(API_LATEST);
    if (res.status === 404) return { ok: false, message: '仓库还没有发布任何 Release' };
    if (res.status !== 200) return { ok: false, message: `GitHub API 返回 ${res.status}` };
    const rel = JSON.parse(res.body.toString('utf8'));
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const asset = (rel.assets || []).find((a) => /Setup/i.test(a.name) && /\.exe$/i.test(a.name));
    return {
      ok: true,
      hasNew: compareVersion(latest, current) > 0,
      current,
      latest,
      asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
      notes: rel.body || '',
      publishedAt: rel.published_at || ''
    };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** 取消当前下载（abort 所有连接） */
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

/**
 * 探测远端文件：总大小 + 是否支持 Range。
 * 用 Range: bytes=0-0 拿 Content-Range，比 HEAD 可靠（有些 CDN 不支持 HEAD）。
 */
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
        // Content-Range: bytes 0-0/12345678
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

/**
 * 下载单个分段到文件的指定偏移。
 * @returns {Promise<{ok:boolean, received:number, message?:string}>}
 */
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
      // 用 'a' 追加不行（多段并发），必须按偏移写
      const ws = fs.createWriteStream(filePath, { flags: 'r+', start });
      res.on('data', (chunk) => {
        if (cancelled) return;
        const buf = Buffer.from(chunk);
        received += buf.length;
        ws.write(buf);
        if (onBytes) onBytes(buf.length);
      });
      res.on('end', () => {
        ws.end(() => done({ ok: true, received }));
      });
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

/**
 * 多连接分段下载。
 * @param {{name:string, size:number, url:string}} asset
 * @param {(info:{pct,received,total,speed,eta,connections})=>void} onProgress
 */
function download(asset, onProgress) {
  return new Promise(async (resolve) => {
    if (!asset || !asset.url) return resolve({ ok: false, message: '没有可下载的安装包' });

    cancelled = false;
    activeReqs = [];
    const dir = downloadDir();
    const file = path.join(dir, asset.name);

    // 1. 探测总大小 + Range 支持
    const info = await probe(asset.url);
    if (!info.ok) return resolve({ ok: false, message: '探测文件失败：' + (info.message || '') });
    const total = info.total || Number(asset.size) || 0;
    if (!total) return resolve({ ok: false, message: '拿不到文件大小' });

    // 2. 决定分段数
    const useMulti = info.supportsRange && total >= MIN_SEGMENT_SIZE;
    const parts = useMulti ? CONCURRENCY : 1;
    const segSize = Math.ceil(total / parts);

    // 3. 预分配文件（避免并发写时文件大小不对）
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, total);
      fs.closeSync(fd);
    } catch (e) {
      return resolve({ ok: false, message: '创建文件失败：' + ((e && e.message) || e) });
    }

    // 4. 速度统计（滑动窗口）
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

    // 5. 并发拉各段
    const tasks = [];
    for (let i = 0; i < parts; i++) {
      const start = i * segSize;
      const end = Math.min(total - 1, start + segSize - 1);
      if (start > end) break;
      tasks.push(downloadSegment(asset.url, start, end, file, onBytes));
    }

    const results = await Promise.all(tasks);

    if (cancelled) {
      return resolve({ ok: false, cancelled: true, message: '已取消' });
    }

    const bad = results.find((r) => !r.ok);
    if (bad) {
      return resolve({ ok: false, message: '下载失败：' + (bad.message || '未知错误') });
    }

    // 6. 校验大小
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
