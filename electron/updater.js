'use strict';
/**
 * 应用内更新：检查 → 下载 → 启动安装器
 *
 * 仓库是 Public，不需要 token。
 *
 * ============================================================
 * 为什么用 Electron 的 net 而不是 Node 的 https（v0.26.4 重写）
 * ============================================================
 * 用户实测：浏览器下载 5 MB/s，应用内只有 39 KB/s。
 * 根因：**Node 的 https 模块不走系统代理**，而浏览器走。
 * 用户开着 VPN（127.0.0.1:7897），浏览器走代理所以快，
 * 应用内直连 GitHub 所以慢。
 *
 * Electron 的 net 模块**自动使用系统代理设置**（Chromium 网络栈），
 * 所以换成 net 后速度应该和浏览器一致。
 *
 * 其他设计要点：
 *   1. 可取消：保存请求句柄
 *   2. 断点续传：Range 头
 *   3. 速度/剩余时间：滑动窗口
 *   4. 失败可重试
 */
const fs = require('fs');
const path = require('path');
const { shell, app, net } = require('electron');

const REPO = '1148872017/test-tool';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

let activeReq = null;
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

/**
 * 用 Electron net 发 GET，返回 { status, headers, body(Buffer) }。
 * net 自动走系统代理，这是它比 Node https 强的关键。
 */
function netGet(url) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'follow' });
    } catch (e) {
      return reject(e);
    }
    req.setHeader('User-Agent', 'test-tool-updater');
    req.setHeader('Accept', 'application/vnd.github+json');

    const chunks = [];
    let status = 0;
    let headers = {};

    req.on('response', (res) => {
      status = res.statusCode;
      headers = res.headers;
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
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

/** 取消当前下载 */
function cancel() {
  cancelled = true;
  if (activeReq) {
    try {
      activeReq.abort();
    } catch (e) {
      /* ignore */
    }
    activeReq = null;
  }
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
 * 下载安装包（net 模块，走系统代理）。
 * @param {{name:string, size:number, url:string}} asset
 * @param {(info:{pct,received,total,speed,eta})=>void} onProgress
 */
function download(asset, onProgress) {
  return new Promise((resolve) => {
    if (!asset || !asset.url) return resolve({ ok: false, message: '没有可下载的安装包' });

    cancelled = false;
    const dir = downloadDir();
    const file = path.join(dir, asset.name);
    const partFile = file + '.part';

    let startAt = 0;
    try {
      if (fs.existsSync(partFile)) startAt = fs.statSync(partFile).size;
    } catch (e) {
      startAt = 0;
    }
    let total = Number(asset.size) || 0;
    if (total && startAt >= total) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.renameSync(partFile, file);
        return resolve({ ok: true, file });
      } catch (e) {
        startAt = 0;
      }
    }

    const out = fs.createWriteStream(partFile, { flags: startAt > 0 ? 'a' : 'w' });
    let received = startAt;

    // 速度：滑动窗口（最近 3 秒）
    const samples = [];
    const pushSample = (bytes) => {
      const now = Date.now();
      samples.push({ t: now, b: bytes });
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

    const fail = (msg, isCancel) => {
      try {
        out.destroy();
      } catch (e) {
        /* ignore */
      }
      activeReq = null;
      if (isCancel) return resolve({ ok: false, cancelled: true, message: msg });
      resolve({ ok: false, message: msg });
    };

    let req;
    try {
      req = net.request({ method: 'GET', url: asset.url, redirect: 'follow' });
    } catch (e) {
      return fail('创建请求失败：' + ((e && e.message) || e));
    }
    activeReq = req;
    req.setHeader('User-Agent', 'test-tool-updater');
    if (startAt > 0) req.setHeader('Range', `bytes=${startAt}-`);

    req.on('response', (res) => {
      if (cancelled) return fail('已取消', true);

      const code = res.statusCode;
      // 206 = 续传成功；200 = 服务器忽略 Range（从头下）
      if (code !== 200 && code !== 206) {
        res.on('data', () => {});
        return fail(`下载失败：HTTP ${code}`);
      }
      if (code === 200 && startAt > 0) {
        // 服务器不支持续传，清空重来
        startAt = 0;
        received = 0;
        try {
          out.destroy();
        } catch (e) {
          /* ignore */
        }
        return fail('服务器不支持断点续传，请重试');
      }

      if (!total) {
        const len = Number(res.headers['content-length']) || 0;
        total = code === 206 ? startAt + len : len;
      }

      pushSample(received);

      res.on('data', (chunk) => {
        if (cancelled) return;
        const buf = Buffer.from(chunk);
        received += buf.length;
        out.write(buf);
        pushSample(received);
        if (onProgress && total) {
          const speed = speedNow();
          const remain = Math.max(0, total - received);
          const eta = speed > 0 ? Math.round(remain / speed) : 0;
          onProgress({
            pct: Math.min(100, Math.round((received / total) * 100)),
            received,
            total,
            speed,
            eta
          });
        }
      });

      res.on('end', () => {
        if (cancelled) return fail('已取消', true);
        out.end(() => {
          let actual = 0;
          try {
            actual = fs.statSync(partFile).size;
          } catch (e) {
            return fail('下载完成但文件读不到');
          }
          if (total && actual !== total) {
            return fail(`文件不完整（期望 ${total}，实际 ${actual}），可点重试续传`);
          }
          try {
            if (fs.existsSync(file)) fs.unlinkSync(file);
            fs.renameSync(partFile, file);
          } catch (e) {
            return fail('重命名失败：' + ((e && e.message) || e));
          }
          activeReq = null;
          resolve({ ok: true, file });
        });
      });

      res.on('error', (e) => {
        if (cancelled) return fail('已取消', true);
        fail('下载中断：' + ((e && e.message) || e));
      });
    });

    req.on('error', (e) => {
      if (cancelled) return fail('已取消', true);
      fail('网络错误：' + ((e && e.message) || e));
    });

    req.end();
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
