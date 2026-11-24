'use strict';
/**
 * Allure 报告解析 + 失败聚类 + Flaky 追踪。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **只读解析，不依赖 Allure CLI**
 *    allure-results 是纯 JSON 文件，直接读就行。
 *
 * 2. **失败聚类：归一化错误信息后分组**
 *    把错误信息里的数字/ID/路径替换成占位符，相同模式归为一组。
 *    例：`Timeout 3000ms` 和 `Timeout 5000ms` → 同一组「Timeout Xms」。
 *
 * 3. **Flaky 追踪：跨多次执行比对**
 *    同一个用例（按 fullName）在不同执行里「过/挂」交替 → 标记 flaky。
 */

const fs = require('fs');
const path = require('path');

/** 状态映射 */
const STATUS_MAP = {
  passed: 'passed',
  failed: 'failed',
  broken: 'broken',
  skipped: 'skipped',
  unknown: 'unknown'
};

/** 读 JSON，失败返回 null */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 从 labels 里取某个值 */
function labelOf(labels, name) {
  if (!Array.isArray(labels)) return '';
  const hit = labels.find((l) => l && l.name === name);
  return hit ? String(hit.value || '') : '';
}

/**
 * 解析一个 allure-results 目录。
 *
 * @param {string} dir
 * @returns {{
 *   ok: boolean,
 *   dir: string,
 *   tests: any[],
 *   summary: {total: number, passed: number, failed: number, broken: number, skipped: number, duration: number},
 *   message?: string
 * }}
 */
function parseAllureDir(dir) {
  const base = String(dir || '').trim();
  if (!base) return { ok: false, dir: '', tests: [], summary: emptySummary(), message: '没给目录' };
  if (!fs.existsSync(base)) return { ok: false, dir: base, tests: [], summary: emptySummary(), message: '目录不存在' };

  let files;
  try {
    files = fs.readdirSync(base).filter((f) => /-result\.json$/i.test(f));
  } catch (e) {
    return { ok: false, dir: base, tests: [], summary: emptySummary(), message: '读目录失败：' + (e && e.message) };
  }

  if (!files.length) {
    return { ok: false, dir: base, tests: [], summary: emptySummary(), message: '目录里没有 *-result.json（不是 allure-results）' };
  }

  const tests = [];
  for (const f of files) {
    const j = readJson(path.join(base, f));
    if (!j) continue;

    const status = STATUS_MAP[String(j.status || '').toLowerCase()] || 'unknown';
    const details = j.statusDetails || {};
    const start = Number(j.start) || 0;
    const stop = Number(j.stop) || 0;

    tests.push({
      id: String(j.uuid || f.replace(/-result\.json$/i, '')),
      name: String(j.name || '(未命名)'),
      fullName: String(j.fullName || ''),
      status,
      // 失败原因（聚类用）
      message: String(details.message || ''),
      trace: String(details.trace || ''),
      flaky: !!details.flaky,
      // 分类信息
      suite: labelOf(j.labels, 'suite'),
      subSuite: labelOf(j.labels, 'subSuite'),
      testClass: labelOf(j.labels, 'testClass'),
      testMethod: labelOf(j.labels, 'testMethod'),
      feature: labelOf(j.labels, 'feature'),
      story: labelOf(j.labels, 'story'),
      severity: labelOf(j.labels, 'severity'),
      framework: labelOf(j.labels, 'framework'),
      // 耗时
      start,
      stop,
      duration: stop > start ? stop - start : 0,
      // 附件（截图等）
      attachments: Array.isArray(j.attachments)
        ? j.attachments.map((a) => ({ name: String(a.name || ''), source: String(a.source || ''), type: String(a.type || '') }))
        : []
    });
  }

  // 按开始时间排序
  tests.sort((a, b) => a.start - b.start);

  return { ok: true, dir: base, tests, summary: summarize(tests) };
}

/** 空汇总 */
function emptySummary() {
  return { total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0, duration: 0 };
}

/** 汇总 */
function summarize(tests) {
  const s = emptySummary();
  s.total = tests.length;
  for (const t of tests) {
    if (t.status === 'passed') s.passed++;
    else if (t.status === 'failed') s.failed++;
    else if (t.status === 'broken') s.broken++;
    else if (t.status === 'skipped') s.skipped++;
    else s.unknown++;
    s.duration += t.duration || 0;
  }
  return s;
}

/**
 * 归一化错误信息（聚类用）。
 *
 * 把「会变的部分」替换成占位符：
 *   - 数字 → <N>
 *   - UUID / 长 ID → <ID>
 *   - 文件路径 → <PATH>
 *   - 引号里的内容 → <STR>
 *   - 时间戳 → <TS>
 */
function normalizeMessage(msg) {
  let s = String(msg || '').trim();
  if (!s) return '';

  // 只取第一行（后面的堆栈对聚类没用）
  s = s.split('\n')[0];

  // 时间戳（13 位数字）
  s = s.replace(/\d{13}/g, '<TS>');
  // UUID
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>');
  // 文件路径（Windows / Unix）
  s = s.replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>');
  s = s.replace(/(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]+/g, '<PATH>');
  // 引号里的内容（可能是具体值）
  s = s.replace(/"[^"]*"/g, '"<STR>"');
  s = s.replace(/'[^']*'/g, "'<STR>'");
  // 剩余数字
  s = s.replace(/\d+/g, '<N>');
  // 压缩空白
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * 失败聚类。
 *
 * @param {any[]} tests
 * @returns {{key: string, pattern: string, count: number, tests: any[], sample: string}[]}
 */
function clusterFailures(tests) {
  const groups = new Map();

  for (const t of tests || []) {
    if (t.status !== 'failed' && t.status !== 'broken') continue;
    const pattern = normalizeMessage(t.message) || '(无错误信息)';
    if (!groups.has(pattern)) {
      groups.set(pattern, {
        key: pattern,
        pattern,
        count: 0,
        tests: [],
        sample: String(t.message || '').split('\n')[0]
      });
    }
    const g = groups.get(pattern);
    g.count++;
    g.tests.push({ id: t.id, name: t.name, fullName: t.fullName, status: t.status, message: t.message });
  }

  // 按数量降序
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

/**
 * Flaky 追踪：跨多次执行比对。
 *
 * @param {any[][]} runs 多次执行的 tests 数组（按时间顺序）
 * @returns {{fullName: string, name: string, history: string[], flaky: boolean}[]}
 */
function trackFlaky(runs) {
  const byName = new Map();

  for (const tests of runs || []) {
    for (const t of tests || []) {
      const key = t.fullName || t.name;
      if (!key) continue;
      if (!byName.has(key)) {
        byName.set(key, { fullName: key, name: t.name, history: [], flaky: false });
      }
      byName.get(key).history.push(t.status);
    }
  }

  const out = [];
  for (const item of byName.values()) {
    // 有「过」也有「挂」→ flaky
    const hasPass = item.history.includes('passed');
    const hasFail = item.history.some((s) => s === 'failed' || s === 'broken');
    item.flaky = hasPass && hasFail && item.history.length >= 2;
    if (item.flaky) out.push(item);
  }

  // 按「翻转次数」降序（越不稳定越靠前）
  out.sort((a, b) => flipCount(b.history) - flipCount(a.history));
  return out;
}

/** 统计状态翻转次数 */
function flipCount(history) {
  let n = 0;
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1] === 'passed';
    const b = history[i] === 'passed';
    if (a !== b) n++;
  }
  return n;
}

/**
 * 扫描一个根目录，找所有 allure-results 子目录。
 * @param {string} root
 */
function scanAllureRoots(root) {
  const base = String(root || '').trim();
  if (!base || !fs.existsSync(base)) return { ok: false, dirs: [], message: '目录不存在' };

  const dirs = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      // 注意：不跳过 target —— Maven 项目的 allure-results 常在 target/ 下
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.name === 'allure-results') {
        // 确认里面有 result.json
        try {
          const has = fs.readdirSync(full).some((f) => /-result\.json$/i.test(f));
          if (has) dirs.push(full);
        } catch (e) {
          /* ignore */
        }
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(base, 0);

  return { ok: true, dirs };
}

module.exports = {
  parseAllureDir,
  summarize,
  normalizeMessage,
  clusterFailures,
  trackFlaky,
  scanAllureRoots,
  flipCount
};
