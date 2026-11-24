'use strict';
/**
 * npm run test:all —— unit + env 全量
 *
 * 顺序：unit（无条件跑）→ 前置检查 → env。
 * 前置检查不过时 unit 的结果仍然有效，退出码为非零（env 没跑成）。
 */
const { unit, env } = require('./lib/suites.cjs');
const { runTier, validateSuites } = require('./lib/runner.cjs');
const { checkDirs, printReport } = require('./lib/preflight.cjs');

if (!validateSuites()) process.exit(1);

let code = 0;
if (runTier('unit', unit) !== 0) code = 1;

if (!printReport(checkDirs())) {
  code = 1;
} else if (runTier('env', env) !== 0) {
  code = 1;
}

console.log(code === 0 ? '\n全量测试通过。' : '\n全量测试未通过，见上方汇总。');
process.exit(code);