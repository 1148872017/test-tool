'use strict';
/* env 档前置检查（CLI）：缺哪个目录就打印可操作提示，然后非零退出 */
const { checkDirs, printReport } = require('./lib/preflight.cjs');

const ok = printReport(checkDirs());
process.exitCode = ok ? 0 : 1;