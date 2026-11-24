'use strict';
/**
 * 套件执行器（unit / env / all 共用）
 *
 * 为什么不用 `a && b && c` 串联：
 *   串联时第一个套件崩了，后面 37 个根本不跑，但 shell 只回一个非零码，
 *   看起来像「跑完了有失败」，实际是「没跑」。这里逐个 spawnSync、逐个记账，
 *   最后给出完整汇总，任一失败即非零退出。
 *
 * 汇总口径：
 *   - 每个套件自己打印 `X/Y passed`（老格式）或 `X passed, Y failed, Z skipped`（跳过感知格式）；
 *   - 这里解析最后一条作为该套件的断言统计，解析不到就记 0，但不影响退出码判定（以子进程退出码为准）。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const SUITE_TIMEOUT_MS = 10 * 60 * 1000;

const TIER_LABEL = {
  unit: 'unit 档（纯函数 + 临时目录，不依赖本机真实资产）',
  env: 'env 档（依赖本机真实资产，已过前置检查）'
};

/** 从套件输出里解析断言统计；跳过感知格式优先 */
function parseSummary(out) {
  const text = String(out || '');
  const skipAware = [...text.matchAll(/(\d+)\s+passed,\s*(\d+)\s+failed,\s*(\d+)\s+skipped/g)];
  if (skipAware.length) {
    const m = skipAware[skipAware.length - 1];
    const passed = Number(m[1]);
    const failed = Number(m[2]);
    const skipped = Number(m[3]);
    return { passed, failed, skipped, total: passed + failed + skipped };
  }
  const legacy = [...text.matchAll(/(\d+)\s*\/\s*(\d+)\s+passed/g)];
  if (legacy.length) {
    const m = legacy[legacy.length - 1];
    const passed = Number(m[1]);
    const total = Number(m[2]);
    return { passed, failed: total - passed, skipped: 0, total };
  }
  return null;
}

/** 抽出套件自己打印的 SKIP 行，成功时也要让人看见「哪些项没跑」 */
function extractSkips(out) {
  return String(out || '')
    .split(/\r?\n/)
    .filter((l) => /^\s*SKIP\s{2,}/.test(l))
    .map((l) => l.trim());
}

function indent(text, prefix) {
  return String(text || '')
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((l) => prefix + l)
    .join('\n');
}

/**
 * 逐个跑套件并汇总。
 * @param {'unit'|'env'} tier
 * @param {string[]} files scripts/ 下的文件名
 * @returns {number} 进程退出码：0 全通过，1 有失败
 */
function runTier(tier, files) {
  const startedAt = Date.now();
  console.log(`\n===== ${TIER_LABEL[tier] || tier}：${files.length} 个套件 =====`);

  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, file)], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: SUITE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    });
    const ms = Date.now() - t0;
    const out = String(r.stdout || '') + String(r.stderr || '');
    const summary = parseSummary(out);
    const skippedLines = extractSkips(out);
    const crashed = r.error || r.status === null;
    const ok = !crashed && r.status === 0 && (!summary || summary.failed === 0);

    const head = `[${String(i + 1).padStart(2, '0')}/${files.length}] ${ok ? 'PASS' : 'FAIL'}  ${file}`;
    const stat = summary ? `  ${summary.passed}/${summary.total}${summary.skipped ? `（跳过 ${summary.skipped}）` : ''}` : '';
    console.log(`\n${head}${stat}  ${ms}ms`);

    if (skippedLines.length) {
      for (const l of skippedLines) console.log('       ' + l);
    }
    if (!ok) {
      if (r.error) {
        console.log(`  ! 子进程异常：${r.error.code || ''} ${r.error.message || r.error}`);
      } else {
        console.log(`  ! 退出码 ${r.status}${r.signal ? ' / 信号 ' + r.signal : ''}`);
      }
      if (out.trim()) console.log(indent(out, '  | '));
    }

    rows.push({ file, ok, ms, summary, crashed });
  }

  const failed = rows.filter((r) => !r.ok);
  const totalPassed = rows.reduce((s, r) => s + (r.summary ? r.summary.passed : 0), 0);
  const totalTotal = rows.reduce((s, r) => s + (r.summary ? r.summary.total : 0), 0);
  const totalSkipped = rows.reduce((s, r) => s + (r.summary ? r.summary.skipped : 0), 0);

  console.log(`\n===== ${tier} 档汇总 =====`);
  for (const r of rows) {
    const stat = r.summary ? `${r.summary.passed}/${r.summary.total}` : '统计未解析';
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(26)} ${stat.padEnd(12)} ${r.ms}ms`);
  }
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const judged = totalTotal - totalSkipped;
  console.log(
    `\n套件 ${rows.length - failed.length}/${rows.length} 通过，判定 ${totalPassed}/${judged} 通过` +
      (totalSkipped ? `，${totalSkipped} 项显式跳过（共 ${totalTotal} 项）` : '') +
      `，耗时 ${secs}s`
  );
  if (totalSkipped) {
    console.log('跳过项不算失败，但都在上面逐个列出来了（搜索 SKIP）。');
  }
  if (failed.length) {
    console.log('\n失败套件：' + failed.map((r) => r.file).join('、'));
  }
  return failed.length ? 1 : 0;
}

/** 校验分档表与磁盘是否一致；不一致直接报错（防止新套件永远跑不到） */
function validateSuites() {
  const { validate } = require('./suites.cjs');
  const bad = validate();
  const problems = [];
  if (bad.unclassified.length) {
    problems.push('磁盘上有、suites.cjs 里没登记（会永远跑不到）：' + bad.unclassified.join('、'));
  }
  if (bad.missingOnDisk.length) {
    problems.push('suites.cjs 里登记了、磁盘上没有（改名/删文件后忘了改表）：' + bad.missingOnDisk.join('、'));
  }
  if (bad.duplicated.length) {
    problems.push('同一个文件被登记了多次（会被跑两遍）：' + bad.duplicated.join('、'));
  }
  if (problems.length) {
    console.error('\n分档表自检失败：');
    for (const p of problems) console.error('  - ' + p);
    console.error('  修好 scripts/lib/suites.cjs 再跑。');
    return false;
  }
  return true;
}

module.exports = { runTier, validateSuites, parseSummary, extractSkips, ROOT };