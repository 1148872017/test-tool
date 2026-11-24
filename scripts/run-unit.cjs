'use strict';
/**
 * npm test —— 只跑 unit 档
 *
 * unit 档 = 纯函数 + 临时目录，不读任何本机真实资产，
 * **不设任何环境变量也必须全绿**（这是本档的存在意义）。
 */
const { unit } = require('./lib/suites.cjs');
const { runTier, validateSuites } = require('./lib/runner.cjs');

if (!validateSuites()) process.exit(1);
process.exit(runTier('unit', unit));