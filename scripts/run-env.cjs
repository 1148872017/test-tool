'use strict';
/**
 * npm run test:env —— 只跑 env 档
 *
 * 先过前置检查：4 个真实资产目录缺一个就打印可操作提示并非零退出，
 * 不再出现「目录不存在 → 套件崩 / 静默跳过还全绿」。
 */
const { env } = require('./lib/suites.cjs');
const { runTier, validateSuites } = require('./lib/runner.cjs');
const { checkDirs, printReport } = require('./lib/preflight.cjs');

if (!validateSuites()) process.exit(1);
if (!printReport(checkDirs())) process.exit(1);
process.exit(runTier('env', env));