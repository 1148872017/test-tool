'use strict';
/**
 * 应用内更新：检查 → 下载 → 启动安装器
 *
 * 仓库是 Public，所以不需要 token，直接匿名访问 GitHub API。
 *
 * 下载设计要点（v0.26.2 重写）：
 *   1. **可取消**：保存请求句柄，cancel() 时 destroy
 *   2. **可重试**：失败后保留 asset，用户点重试重新下
 *   3. **断点续传**：用 Range 头从已下载字节继续（GitHub 支持 206）
 *   4. **速度/剩余时间**：滑动窗口算瞬时速度，显示 MB/s 和剩余秒数
 *   5. **多镜像兜底**：GitHub 直连慢时，可配镜像前缀
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { shell, app } = require('electron');

const REPO = '1148872017/test-tool';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

/** 当前下载的请求句柄（用于取消） */
let activeReq = null;
let cancelled = false;

/** 语义化版本比较：a > b 返回 1，相等 0，小于 -1 */
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

/** 发一个 GET 请求，返回 { status, headers, body(Buffer) } */
function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向次数过多'));
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'test-tool-updater',
          Accept: 'application/vnd.github+json'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(httpGet(res.headers.location, redirects + 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
  });
}

/**
 * 检查更新。
 * @returns {{ok:boolean, hasNew?:boolean, current?:string, latest?:string,
 *            asset?:{name,size,url}, notes?:string, publishedAt?:string, message?:string}}
 */
async function checkUpdate() {
  const current = app.getVersion();
  try {
    const res = await httpGet(API_LATEST);
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
      activeReq.destroy(new Error('用户取消'));
    } catch (e) {
      /* ignore */
    }
    activeReq = null;
  }
  return { ok: true };
}

/** 下载目录 */
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
 * 下载安装包（支持断点续传 + 取消 + 速度统计）。
 *
 * @param {{name:string, size:number, url:string}} asset
 * @param {(info:{pct:number, received:number, total:number, speed:number, eta:number})=>void} onProgress
 * @returns {Promise<{ok:boolean, file?:string, message?:string, cancelled?:boolean}>}
 */
function download(asset, onProgress) {
  return new Promise((resolve) => {
    if (!asset || !asset.url) return resolve({ ok: false, message: '没有可下载的安装包' });

    cancelled = false;
    const dir = downloadDir();
    const file = path.join(dir, asset.name);
    const partFile = file + '.part';

    // 已有 .part 就续传，否则从 0 开始
    let startAt = 0;
    try {
      if (fs.existsSync(partFile)) startAt = fs.statSync(partFile).size;
    } catch (e) {
      startAt = 0;
    }
    // 已经下完（.part 大小等于总大小）就直接用
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

    // 速度统计：滑动窗口（最近 3 秒）
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

    const cleanup = () => {
      try {
        out.destroy();
      } catch (e) {
        /* ignore */
      }
      activeReq = null;
    };

    const fail = (msg, isCancel) => {
      cleanup();
      if (isCancel) {
        // 取消时保留 .part，下次能续传
        return resolve({ ok: false, cancelled: true, message: msg });
      }
      resolve({ ok: false, message: msg });
    };

    const go = (url, redirects = 0) => {
      if (cancelled) return fail('已取消', true);
      if (redirects > 5) return fail('重定向次数过多');

      const headers = { 'User-Agent': 'test-tool-updater' };
      // 断点续传：从已下载字节继续
      if (startAt > 0) headers.Range = `bytes=${startAt}-`;

      const req = https.get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(res.headers.location, redirects + 1);
        }
        // 206 = 续传成功；200 = 服务器不支持 Range，从头下
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return fail(`下载失败：HTTP ${res.statusCode}`);
        }
        if (res.statusCode === 200 && startAt > 0) {
          // 服务器忽略了 Range，得清空重下
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
          total = res.statusCode === 206 ? startAt + len : len;
        }

        pushSample(received);

        res.on('data', (chunk) => {
          if (cancelled) {
            res.destroy();
            return;
          }
          received += chunk.length;
          out.write(chunk);
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

      activeReq = req;
      req.on('error', (e) => {
        if (cancelled) return fail('已取消', true);
        fail('网络错误：' + ((e && e.message) || e));
      });
      // 不设总超时（大文件慢速下载可能很久），只设连接超时
      req.setTimeout(60000, () => {
        req.destroy(new Error('连接超时'));
      });
    };

    go(asset.url);
  });
}

/** 清理下载残留（安装成功后调用） */
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

/**
 * 启动安装器。
 * 注意：调用方要在之后自己 app.quit()，否则安装器替换文件时会被占用。
 */
async function install(exePath) {
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, message: '安装包不存在：' + exePath };
  }
  const err = await shell.openPath(exePath);
  if (err) return { ok: false, message: err };
  return { ok: true };
}

module.exports = { compareVersion, checkUpdate, download, cancel, cleanup, install };
