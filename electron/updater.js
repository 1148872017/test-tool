'use strict';
/**
 * 应用内更新：检查 → 下载 → 启动安装器
 *
 * 仓库是 Public，所以不需要 token，直接匿名访问 GitHub API。
 *
 * 流程：
 *   1. checkUpdate()  拿最新 Release 的 tag + Setup 附件
 *   2. download()     流式下载到临时目录，带进度回调
 *   3. install()      启动安装器，然后自己退出（让安装器能替换文件）
 *
 * 为什么不用 electron-updater：
 *   它要求 oneClick 安装器 + 自动静默安装，我们的安装器是 assisted（有向导），
 *   而且用户要求「下载完弹确认框，点了才装」。自己写 200 行更可控。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { shell, app } = require('electron');

const REPO = '1148872017/test-tool';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

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
        // GitHub 的下载链接会 302 到 objects.githubusercontent.com
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
    req.setTimeout(30000, () => {
      req.destroy(new Error('请求超时'));
    });
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
    if (res.status === 404) {
      return { ok: false, message: '仓库还没有发布任何 Release' };
    }
    if (res.status !== 200) {
      return { ok: false, message: `GitHub API 返回 ${res.status}` };
    }
    const rel = JSON.parse(res.body.toString('utf8'));
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const asset = (rel.assets || []).find(
      (a) => /Setup/i.test(a.name) && /\.exe$/i.test(a.name)
    );
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

/**
 * 下载安装包到临时目录。
 * @param {{name:string, size:number, url:string}} asset
 * @param {(pct:number, received:number, total:number)=>void} onProgress
 * @returns {Promise<{ok:boolean, file?:string, message?:string}>}
 */
function download(asset, onProgress) {
  return new Promise((resolve) => {
    if (!asset || !asset.url) {
      return resolve({ ok: false, message: '没有可下载的安装包' });
    }
    const dir = path.join(app.getPath('temp'), 'test-tool-update');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return resolve({ ok: false, message: '创建临时目录失败：' + ((e && e.message) || e) });
    }
    const file = path.join(dir, asset.name);
    // 清掉上次残留
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      /* ignore */
    }

    const out = fs.createWriteStream(file);
    let received = 0;
    let total = Number(asset.size) || 0;

    const fail = (msg) => {
      try {
        out.destroy();
      } catch (e) {
        /* ignore */
      }
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (e) {
        /* ignore */
      }
      resolve({ ok: false, message: msg });
    };

    const go = (url, redirects = 0) => {
      if (redirects > 5) return fail('重定向次数过多');
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'test-tool-updater' } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return fail(`下载失败：HTTP ${res.statusCode}`);
          }
          if (!total) total = Number(res.headers['content-length']) || 0;
          res.on('data', (chunk) => {
            received += chunk.length;
            out.write(chunk);
            if (onProgress && total) {
              onProgress(Math.min(100, Math.round((received / total) * 100)), received, total);
            }
          });
          res.on('end', () => {
            out.end(() => {
              // 校验大小（GitHub 给了 size，能对上才算完整）
              let actual = 0;
              try {
                actual = fs.statSync(file).size;
              } catch (e) {
                return fail('下载完成但文件读不到');
              }
              if (total && actual !== total) {
                return fail(`文件大小不符（期望 ${total}，实际 ${actual}）`);
              }
              resolve({ ok: true, file });
            });
          });
          res.on('error', (e) => fail('下载中断：' + ((e && e.message) || e)));
        }
      );
      req.on('error', (e) => fail('网络错误：' + ((e && e.message) || e)));
      req.setTimeout(120000, () => {
        req.destroy(new Error('下载超时'));
      });
    };

    go(asset.url);
  });
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

module.exports = { compareVersion, checkUpdate, download, install };
