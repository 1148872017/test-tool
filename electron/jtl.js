'use strict';
/**
 * 压测报告解析（只读）
 *
 * 支持两种输入，优先用 JMeter 自己算好的 statistics.json：
 *   1. html-report/statistics.json —— JMeter 生成的 H5 报告数据（权威，但分位含义随配置变）
 *   2. result.jtl —— 原始样本（CSV 或 XML），自己算分位
 *
 * 关键决定：**分位一律从 jtl 自己算**。
 * 因为 JMeter 的 aggregate_rpt_pct1/2/3 是用户可改的，statistics.json 里的
 * pct1/pct2/pct3 不一定是 P90/P95/P99（实测用户那份 pct2=5.35 就不是 P95）。
 * 样本数/错误率/TPS 用 statistics.json（无歧义），分位用 jtl（口径确定）。
 */
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * jtl 解析
 * ------------------------------------------------------------------ */

/** CSV 行切分：JMeter 的 label/URL 里可能有逗号，但默认不加引号，按逗号切即可 */
function splitCsvLine(line) {
  // 有引号时按标准 CSV 处理
  if (line.indexOf('"') < 0) return line.split(',');
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * 解析 jtl（CSV 格式）。
 * 列顺序不固定（由 jmeter.save.saveservice.* 决定），必须按表头名取。
 */
function parseJtlCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('jtl 文件是空的或只有表头');

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });

  for (const need of ['timeStamp', 'elapsed', 'success']) {
    if (idx[need] === undefined) {
      throw new Error(`jtl 缺少必需列「${need}」，可能不是 JMeter 的 CSV 结果文件`);
    }
  }

  let n = 0;
  let fails = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let maxThreads = 0;
  const elapsed = [];
  const byLabel = new Map();

  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const ts = Number(c[idx.timeStamp]);
    const el = Number(c[idx.elapsed]);
    if (!Number.isFinite(ts) || !Number.isFinite(el)) continue;

    const ok = String(c[idx.success] || '').trim().toLowerCase() === 'true';
    const label = idx.label !== undefined ? String(c[idx.label] || '').trim() : '(未命名)';

    n++;
    if (!ok) fails++;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
    elapsed.push(el);

    // 并发取 grpThreads / allThreads 的最大值
    for (const key of ['allThreads', 'grpThreads']) {
      if (idx[key] === undefined) continue;
      const t = Number(c[idx[key]]);
      if (Number.isFinite(t) && t > maxThreads) maxThreads = t;
    }

    let b = byLabel.get(label);
    if (!b) {
      b = { label, n: 0, fails: 0, elapsed: [] };
      byLabel.set(label, b);
    }
    b.n++;
    if (!ok) b.fails++;
    b.elapsed.push(el);
  }

  if (!n) throw new Error('jtl 里没有有效样本');

  const sorted = elapsed.slice().sort((a, b) => a - b);
  const durationS = (maxTs - minTs) / 1000;

  return {
    source: 'jtl',
    samples: n,
    fails,
    errRate: (fails / n) * 100,
    durationS,
    tps: durationS > 0 ? n / durationS : 0,
    concurrency: maxThreads || 0,
    avg: elapsed.reduce((a, b) => a + b, 0) / n,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    labels: Array.from(byLabel.values())
      .map((b) => {
        const s = b.elapsed.slice().sort((x, y) => x - y);
        return {
          label: b.label,
          samples: b.n,
          fails: b.fails,
          errRate: (b.fails / b.n) * 100,
          avg: b.elapsed.reduce((x, y) => x + y, 0) / b.n,
          p95: percentile(s, 0.95)
        };
      })
      .sort((a, b) => b.samples - a.samples)
  };
}

/** 解析 jtl（XML 格式，output_format=xml 时） */
function parseJtlXml(text) {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser({
    errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} }
  }).parseFromString(String(text || ''), 'text/xml');
  const root = doc && doc.documentElement;
  if (!root) throw new Error('jtl XML 解析失败');

  const samples = [];
  const nodes = root.getElementsByTagName('httpSample');
  const all = nodes.length ? nodes : root.getElementsByTagName('sample');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    samples.push({
      ts: Number(el.getAttribute('ts')),
      elapsed: Number(el.getAttribute('t')),
      label: el.getAttribute('lb') || '(未命名)',
      ok: el.getAttribute('s') === 'true',
      threads: Number(el.getAttribute('na')) || 0
    });
  }
  if (!samples.length) throw new Error('jtl XML 里没有样本');

  let fails = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let maxThreads = 0;
  const elapsed = [];
  const byLabel = new Map();

  for (const s of samples) {
    if (!Number.isFinite(s.ts) || !Number.isFinite(s.elapsed)) continue;
    if (!s.ok) fails++;
    if (s.ts < minTs) minTs = s.ts;
    if (s.ts > maxTs) maxTs = s.ts;
    if (s.threads > maxThreads) maxThreads = s.threads;
    elapsed.push(s.elapsed);
    let b = byLabel.get(s.label);
    if (!b) {
      b = { label: s.label, n: 0, fails: 0, elapsed: [] };
      byLabel.set(s.label, b);
    }
    b.n++;
    if (!s.ok) b.fails++;
    b.elapsed.push(s.elapsed);
  }

  const n = elapsed.length;
  const sorted = elapsed.slice().sort((a, b) => a - b);
  const durationS = (maxTs - minTs) / 1000;

  return {
    source: 'jtl-xml',
    samples: n,
    fails,
    errRate: (fails / n) * 100,
    durationS,
    tps: durationS > 0 ? n / durationS : 0,
    concurrency: maxThreads || 0,
    avg: elapsed.reduce((a, b) => a + b, 0) / n,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    labels: Array.from(byLabel.values())
      .map((b) => {
        const s = b.elapsed.slice().sort((x, y) => x - y);
        return {
          label: b.label,
          samples: b.n,
          fails: b.fails,
          errRate: (b.fails / b.n) * 100,
          avg: b.elapsed.reduce((x, y) => x + y, 0) / b.n,
          p95: percentile(s, 0.95)
        };
      })
      .sort((a, b) => b.samples - a.samples)
  };
}

function parseJtl(text) {
  const head = String(text || '').slice(0, 400).trim();
  if (head.startsWith('<?xml') || head.startsWith('<testResults')) return parseJtlXml(text);
  return parseJtlCsv(text);
}

/* ------------------------------------------------------------------ *
 * statistics.json（JMeter H5 报告的数据）
 * ------------------------------------------------------------------ */

/**
 * 只取无歧义的字段：样本数、错误数、错误率、吞吐。
 * **不取 pct1/pct2/pct3** —— 它们的含义随 aggregate_rpt_pct1/2/3 配置变，
 * 实测用户那份 pct2 就不是 P95。分位一律从 jtl 算。
 */
function parseStatistics(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error('statistics.json 不是合法 JSON');
  }
  const total = data && data.Total;
  if (!total) throw new Error('statistics.json 里没有 Total 节点');

  const labels = Object.keys(data)
    .filter((k) => k !== 'Total')
    .map((k) => {
      const d = data[k] || {};
      return {
        label: k,
        samples: Number(d.sampleCount) || 0,
        fails: Number(d.errorCount) || 0,
        errRate: Number(d.errorPct) || 0,
        avg: Number(d.meanResTime) || 0,
        p95: null // 不从 statistics.json 取，见上面的说明
      };
    })
    .sort((a, b) => b.samples - a.samples);

  return {
    source: 'statistics.json',
    samples: Number(total.sampleCount) || 0,
    fails: Number(total.errorCount) || 0,
    errRate: Number(total.errorPct) || 0,
    tps: Number(total.throughput) || 0,
    avg: Number(total.meanResTime) || 0,
    min: Number(total.minResTime) || 0,
    max: Number(total.maxResTime) || 0,
    durationS: null,
    concurrency: 0,
    labels
  };
}

/* ------------------------------------------------------------------ *
 * 目录扫描：一次跑 = 一个目录
 * ------------------------------------------------------------------ */

/**
 * 在一个目录里找报告文件。
 * 支持两种布局：
 *   <dir>/result.jtl + <dir>/html-report/statistics.json
 *   <dir>/*.jtl + <dir>/statistics.json
 */
function findReportFiles(dir) {
  const out = { jtl: '', statistics: '', htmlIndex: '', dir };
  if (!dir || !fs.existsSync(dir)) return out;

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isFile()) {
      if (/\.jtl$/i.test(ent.name) && !out.jtl) out.jtl = full;
      if (/^statistics\.json$/i.test(ent.name) && !out.statistics) out.statistics = full;
      if (/^index\.html$/i.test(ent.name) && !out.htmlIndex) out.htmlIndex = full;
    } else if (ent.isDirectory()) {
      // html-report/ 子目录
      const sub = path.join(full, 'statistics.json');
      if (fs.existsSync(sub) && !out.statistics) out.statistics = sub;
      const subIdx = path.join(full, 'index.html');
      if (fs.existsSync(subIdx) && !out.htmlIndex) out.htmlIndex = subIdx;
      // 子目录里也可能有 jtl
      if (!out.jtl) {
        try {
          const inner = fs.readdirSync(full).find((f) => /\.jtl$/i.test(f));
          if (inner) out.jtl = path.join(full, inner);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
  return out;
}

/**
 * 解析一个「跑批目录」。
 * 优先 statistics.json（样本数/错误率/TPS 权威），分位从 jtl 算。
 */
function parseReportDir(dir) {
  const files = findReportFiles(dir);
  if (!files.jtl && !files.statistics) {
    throw new Error('这个目录里没找到 result.jtl 或 statistics.json');
  }

  let stat = null;
  let jtl = null;
  const errors = [];

  if (files.statistics) {
    try {
      stat = parseStatistics(fs.readFileSync(files.statistics, 'utf8'));
    } catch (e) {
      errors.push('statistics.json: ' + ((e && e.message) || e));
    }
  }
  if (files.jtl) {
    try {
      jtl = parseJtl(fs.readFileSync(files.jtl, 'utf8'));
    } catch (e) {
      errors.push('jtl: ' + ((e && e.message) || e));
    }
  }

  if (!stat && !jtl) throw new Error(errors.join('；') || '报告解析失败');

  // 合并：无歧义的用 statistics，分位/时长/并发用 jtl
  const merged = {
    dir,
    files,
    sources: [],
    samples: 0,
    fails: 0,
    errRate: 0,
    tps: 0,
    durationS: null,
    concurrency: 0,
    avg: 0,
    min: 0,
    max: 0,
    p50: null,
    p90: null,
    p95: null,
    p99: null,
    labels: [],
    warnings: errors
  };

  if (stat) {
    merged.sources.push('statistics.json');
    merged.samples = stat.samples;
    merged.fails = stat.fails;
    merged.errRate = stat.errRate;
    merged.tps = stat.tps;
    merged.avg = stat.avg;
    merged.min = stat.min;
    merged.max = stat.max;
    merged.labels = stat.labels.slice();
  }
  if (jtl) {
    merged.sources.push(jtl.source);
    if (!stat) {
      merged.samples = jtl.samples;
      merged.fails = jtl.fails;
      merged.errRate = jtl.errRate;
      merged.tps = jtl.tps;
      merged.avg = jtl.avg;
      merged.min = jtl.min;
      merged.max = jtl.max;
      merged.labels = jtl.labels.slice();
    } else {
      // statistics 有标签但没 p95，用 jtl 的补上
      const byLabel = new Map(jtl.labels.map((l) => [l.label, l]));
      merged.labels = merged.labels.map((l) => {
        const hit = byLabel.get(l.label);
        return hit ? Object.assign({}, l, { p95: hit.p95 }) : l;
      });
    }
    merged.durationS = jtl.durationS;
    merged.concurrency = jtl.concurrency;
    merged.p50 = jtl.p50;
    merged.p90 = jtl.p90;
    merged.p95 = jtl.p95;
    merged.p99 = jtl.p99;
  }

  return merged;
}

/** 扫描根目录下所有「跑批目录」（一层子目录） */
function scanReportRoot(root) {
  const out = { root: root || '', reports: [], errors: [] };
  if (!root) {
    out.error = '未配置报告目录';
    return out;
  }
  if (!fs.existsSync(root)) {
    out.error = '目录不存在：' + root;
    return out;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    out.error = String((e && e.message) || e);
    return out;
  }

  // 根目录自己就是一个跑批目录
  const selfFiles = findReportFiles(root);
  if (selfFiles.jtl || selfFiles.statistics) {
    try {
      const r = parseReportDir(root);
      r.name = path.basename(root);
      r.mtime = fs.statSync(root).mtimeMs;
      out.reports.push(r);
    } catch (e) {
      out.errors.push({ dir: root, message: String((e && e.message) || e) });
    }
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    // html-report 是父目录的附属产物，不是独立跑批
    if (/^html-report$/i.test(ent.name)) continue;
    const full = path.join(root, ent.name);
    const files = findReportFiles(full);
    if (!files.jtl && !files.statistics) continue;
    try {
      const r = parseReportDir(full);
      r.name = ent.name;
      r.mtime = fs.statSync(full).mtimeMs;
      out.reports.push(r);
    } catch (e) {
      out.errors.push({ dir: full, message: String((e && e.message) || e) });
    }
  }

  out.reports.sort((a, b) => b.mtime - a.mtime);
  return out;
}

module.exports = {
  parseJtl,
  parseJtlCsv,
  parseJtlXml,
  parseStatistics,
  findReportFiles,
  parseReportDir,
  scanReportRoot
};
