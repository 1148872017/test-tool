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
 *
 * ============================================================
 * 安全（v0.43.0 修补，原实现是 Critical）
 * ============================================================
 * 老实现把渲染进程给的 asset 直接当命令用：
 *   path.join(dir, asset.name) → 传 `..\..\..\Windows\System32\x.exe` 就写到任意路径；
 *   shell.openPath(exePath)    → 传什么就执行什么；
 *   没有 host 白名单、没有 sha512 校验、update:* 也没有解锁校验。
 *
 * 现在四处收紧：
 *   1. 文件名只认 `test-tool-Setup-*.exe` 的 basename（path.basename + 白名单）；
 *   2. url 必须以本仓库的 Release 下载前缀开头，别的一律拒绝；
 *   3. 下载完用官方 latest.yml 里的 sha512 校验，install 前再校验一次；
 *   4. install 只接受下载目录内的路径（见 ipc-misc 的 update:install 还带解锁守卫）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { shell, app, net } = require('electron');

const REPO = '1148872017/test-tool';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const REDIRECT_LATEST = `https://github.com/${REPO}/releases/latest`;
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
/** 允许下载的唯一前缀（含末尾斜杠，避免 `.../download-evil/` 这种同前缀绕过） */
const DOWNLOAD_PREFIX = DOWNLOAD_BASE + '/';

/**
 * 安装包文件名白名单。
 * electron-builder 的 nsis 产物固定叫 `test-tool-Setup-<version>-x64.exe`。
 */
const ASSET_NAME_RE = /^test-tool-Setup-[\w.\-]+\.exe$/i;

/** 最近一次「下载 + 校验通过」的安装包（install 只认它） */
let pendingInstall = null;

/** 并发连接数 */
const CONCURRENCY = 4;
/** 小于这个大小不分段 */
const MIN_SEGMENT_SIZE = 2 * 1024 * 1024;

let activeReqs = [];
let cancelled = false;

/* ============================================================
 * 安全校验小工具（导出给 scripts/test-security.cjs 单测）
 * ============================================================ */

/**
 * 下载地址白名单。
 *
 * 用**完整前缀**（含末尾 `/`）比较，防止
 * `https://github.com/1148872017/test-tool/releases/download-evil/x.exe`
 * 这类同前缀绕过。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedUpdateUrl(url) {
  const u = String(url === undefined || url === null ? '' : url).trim();
  if (!u) return false;
  if (!u.startsWith(DOWNLOAD_PREFIX)) return false;
  // 前缀之后还必须有内容，且不许空白/引号（GitHub 的 URL 里不会出现）
  const rest = u.slice(DOWNLOAD_PREFIX.length);
  if (!rest || /[\s<>"]/.test(rest)) return false;
  return true;
}

/**
 * 安装包文件名白名单：只留 basename，且必须匹配 test-tool-Setup-*.exe。
 *
 * 这一条挡的是路径穿越（`..\..\evil.exe`）和「任意可执行文件」（`calc.exe`）。
 *
 * @param {string} name
 * @returns {string} 合法文件名，或空串（= 不合法）
 */
function safeAssetName(name) {
  const raw = String(name === undefined || name === null ? '' : name).trim();
  if (!raw) return '';
  // 先把任何分隔符挡掉（path.basename 在不同平台行为不同，不能只靠它）
  if (raw.indexOf('/') >= 0 || raw.indexOf('\\') >= 0) return '';
  if (raw === '.' || raw === '..') return '';
  if (path.basename(raw) !== raw) return '';
  if (!ASSET_NAME_RE.test(raw)) return '';
  return raw;
}

/** base64 形式的 sha512 归一化（兼容 electron-builder 的 `sha512-xxx` 写法） */
function normalizeSha512(value) {
  let s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return '';
  if (/^sha512-/i.test(s)) s = s.slice(7);
  // base64 的 sha512 固定 88 字符（含结尾 =）
  if (!/^[A-Za-z0-9+/=]{40,120}$/.test(s)) return '';
  return s;
}

/** 算文件的 sha512（base64，和 latest.yml 一致） */
function sha512OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const rs = fs.createReadStream(file);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('base64')));
    rs.on('error', reject);
  });
}

/**
 * 校验文件 sha512 是否等于期望值。
 * @param {string} file
 * @param {string} expected base64 的 sha512
 * @returns {Promise<boolean>}
 */
async function verifyFileSha512(file, expected) {
  const want = normalizeSha512(expected);
  if (!want) return false;
  try {
    const got = await sha512OfFile(file);
    return got === want;
  } catch (e) {
    return false;
  }
}

/**
 * 拉取某个 tag 的 latest.yml，取出安装包的 sha512。
 *
 * 为什么必须校验：安装包下载完是直接交给 shell.openPath 执行的。
 * 没有完整性校验，中间人/镜像劫持就能让「更新」变成任意代码执行。
 *
 * @param {string} tag 例如 v0.43.0
 * @returns {Promise<{ok: boolean, sha512?: string, name?: string, size?: number, message?: string}>}
 */
async function fetchLatestManifest(tag) {
  const t = String(tag || '').trim();
  if (!/^v?[\d.]+$/.test(t)) return { ok: false, message: '版本号不合法：' + t };
  const url = `${DOWNLOAD_PREFIX}${t}/latest.yml`;
  let res;
  try {
    res = await netGet(url);
  } catch (e) {
    return { ok: false, message: '取 latest.yml 失败：' + String((e && e.message) || e) };
  }
  if (res.status !== 200) return { ok: false, message: '取 latest.yml 失败（HTTP ' + res.status + '）' };

  let doc;
  try {
    doc = yaml.load(res.body.toString('utf8'));
  } catch (e) {
    return { ok: false, message: 'latest.yml 解析失败' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, message: 'latest.yml 内容为空' };

  const files = Array.isArray(doc.files) ? doc.files : [];
  let hit = null;
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const n = safeAssetName(f.url);
    if (n) {
      hit = { name: n, sha512: normalizeSha512(f.sha512), size: Number(f.size) || 0 };
      break;
    }
  }
  if (!hit && doc.path) {
    const n = safeAssetName(doc.path);
    if (n) hit = { name: n, sha512: normalizeSha512(doc.sha512), size: 0 };
  }
  if (!hit) return { ok: false, message: 'latest.yml 里没有合法的安装包条目' };
  if (!hit.sha512) return { ok: false, message: 'latest.yml 里没有 sha512，无法校验完整性' };
  return { ok: true, name: hit.name, sha512: hit.sha512, size: hit.size };
}

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
    const rawAsset =
      info.asset ||
      {
        name: `test-tool-Setup-${latest}-x64.exe`,
        size: 0,
        url: `${DOWNLOAD_BASE}/${tag}/test-tool-Setup-${latest}-x64.exe`
      };

    /**
     * 把 asset 收敛成「我们可以安全下载 + 校验」的形态：
     *   - name 必须过白名单；不合法就回落到固定命名，
     *     绝不把渲染进程/api 给的怪名字带到文件系统上；
     *   - url 必须落在本仓库的 Release 下载前缀内；
     *   - sha512 从官方 latest.yml 取（取不到就标记 integrity.ok=false，
     *     download() 会拒绝下载）。
     */
    const wantedName = safeAssetName(rawAsset.name) || `test-tool-Setup-${latest}-x64.exe`;
    const wantedUrl = isAllowedUpdateUrl(rawAsset.url) ? String(rawAsset.url).trim() : `${DOWNLOAD_BASE}/${tag}/${wantedName}`;

    let manifest = { ok: false, message: '没有取到 latest.yml' };
    try {
      manifest = await fetchLatestManifest(tag);
    } catch (e) {
      manifest = { ok: false, message: String((e && e.message) || e) };
    }

    const result = {
      ok: true,
      hasNew: compareVersion(latest, current) > 0,
      current,
      latest,
      asset: {
        name: wantedName,
        size: Number(rawAsset.size) || manifest.size || 0,
        url: wantedUrl,
        sha512: manifest.ok ? manifest.sha512 : ''
      },
      // 界面可以据此提示「这次更新有完整性校验 / 没有」；没有时下载会被拒绝
      integrity: {
        ok: !!manifest.ok,
        message: manifest.ok ? '' : manifest.message || '没有拿到官方 sha512'
      },
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

    /**
     * 三道闸（都在碰磁盘/网络之前）：
     *   1. 文件名白名单 → 挡住 `..\..\evil.exe` 和 `calc.exe`；
     *   2. URL 前缀白名单 → 挡住任意主机的下载；
     *   3. sha512 必须存在 → 没有校验值就不下载（下载完是要执行的）。
     */
    const safeName = safeAssetName(asset.name);
    if (!safeName) {
      return resolve({
        ok: false,
        code: 'BAD_ASSET_NAME',
        message: '安装包名不合法（只接受 test-tool-Setup-*.exe）：' + String(asset.name || '')
      });
    }
    if (!isAllowedUpdateUrl(asset.url)) {
      return resolve({
        ok: false,
        code: 'BAD_ASSET_URL',
        message: '下载地址不在允许的更新通道内：' + String(asset.url || '')
      });
    }
    const expectedSha = normalizeSha512(asset.sha512);
    if (!expectedSha) {
      return resolve({
        ok: false,
        code: 'NO_SHA512',
        message: '没有拿到官方 latest.yml 的 sha512，无法校验安装包完整性，已拒绝下载'
      });
    }

    cancelled = false;
    activeReqs = [];
    const dir = downloadDir();
    const file = path.join(dir, safeName);
    // 双保险：即使白名单被绕过，落点也必须在下载目录内
    if (!isInsideDownloadDir(file)) {
      return resolve({ ok: false, code: 'BAD_ASSET_NAME', message: '安装包落点不在下载目录内，已拒绝' });
    }
    pendingInstall = null;

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

    /**
     * 完整性：拿 latest.yml 的 sha512 比一次。
     * 不一致说明文件被替换（镜像/CDN/中间人），删掉并拒绝。
     */
    const gotSha = await sha512OfFile(file).catch(() => '');
    if (gotSha !== expectedSha) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        /* ignore */
      }
      return resolve({
        ok: false,
        code: 'SHA512_MISMATCH',
        message: '安装包校验失败（sha512 不一致），已删除，请重试'
      });
    }

    // 记下来：install() 只认这一次校验通过的文件
    pendingInstall = { file, sha512: expectedSha };
    resolve({ ok: true, file, sha512: gotSha });
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

/** 路径是否落在下载目录内（用 resolved 路径按分隔符比较，兄弟目录不算） */
function isInsideDownloadDir(p) {
  const dir = downloadDir();
  const root = path.resolve(dir);
  const target = path.resolve(String(p || ''));
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * 启动安装器。
 *
 * 老实现只要文件存在就 `shell.openPath` —— 等于「传什么执行什么」。
 * 现在：只接受下载目录内、文件名过白名单、且刚刚通过 sha512 校验的那个文件。
 *
 * @param {string} exePath
 */
async function install(exePath) {
  const target = String(exePath === undefined || exePath === null ? '' : exePath).trim();
  if (!target) return { ok: false, code: 'BAD_PATH', message: '缺少安装包路径' };
  if (!fs.existsSync(target)) {
    return { ok: false, code: 'NOT_FOUND', message: '安装包不存在：' + target };
  }

  // 1. 落点必须在下载目录内（挡住「传 C:\Windows\System32\cmd.exe」）
  if (!isInsideDownloadDir(target)) {
    return { ok: false, code: 'OUTSIDE_DOWNLOAD_DIR', message: '只允许启动下载目录内的安装包：' + target };
  }
  // 2. 文件名必须是本产品的安装包
  const name = safeAssetName(path.basename(target));
  if (!name) {
    return { ok: false, code: 'BAD_ASSET_NAME', message: '安装包名不合法，已拒绝启动：' + path.basename(target) };
  }
  // 3. 必须就是本次下载并校验通过的那个文件
  const expected =
    pendingInstall && pendingInstall.file && path.resolve(pendingInstall.file) === path.resolve(target)
      ? pendingInstall.sha512
      : '';
  if (!expected) {
    return {
      ok: false,
      code: 'UNVERIFIED',
      message: '这个安装包没有完成完整性校验（请重新下载），已拒绝启动安装器'
    };
  }
  // 4. 再校验一次：防止下载完到点安装之间文件被替换
  const okSha = await verifyFileSha512(target, expected);
  if (!okSha) {
    return { ok: false, code: 'SHA512_MISMATCH', message: '安装包在下载后被改动过（sha512 不一致），已拒绝启动' };
  }

  const err = await shell.openPath(target);
  if (err) return { ok: false, message: err };
  return { ok: true, file: target };
}

module.exports = {
  compareVersion,
  checkUpdate,
  download,
  cancel,
  cleanup,
  install,
  // 安全相关的纯函数（单测用，不参与业务）
  isAllowedUpdateUrl,
  safeAssetName,
  normalizeSha512,
  verifyFileSha512,
  fetchLatestManifest,
  isInsideDownloadDir,
  downloadDir,
  DOWNLOAD_PREFIX,
  ASSET_NAME_RE
};
