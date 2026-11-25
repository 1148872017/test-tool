'use strict';
/**
 * npm test —— 只跑 unit 档
 *
 * unit 档 = 纯函数 + 临时目录，不读任何本机真实资产，
 * **不设任何环境变量也必须全绿**（这是本档的存在意义）。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { unit } = require('./lib/suites.cjs');
const { runTier, validateSuites } = require('./lib/runner.cjs');

if (!validateSuites()) process.exit(1);

/*
 * 先跑「提交前自检」。
 *
 * 为什么要塞进 npm test：
 *   144 条踩坑笔记里能自动化的那部分，如果只做成「另一个命令」，
 *   就没人会跑（坑 #18：「以后怎么防」说了不等于记了）。
 *   塞在这里，跑测试的人顺手就过了检查。
 *
 * 放 main 前面是刻意的：类型错/越界引用这种「根本跑不起来」的问题，
 * 先拦掉比等 53 个套件报一堆无关错更省时间。
 */
try {
  execFileSync(process.execPath, [path.join(__dirname, 'selfcheck.cjs')], {
    stdio: 'inherit'
  });
} catch (e) {
  console.log('');
  console.log('自检没过，先修完再跑测试（加 --fix-hint 看怎么修）：');
  console.log('  node scripts/selfcheck.cjs --fix-hint');
  process.exit(1);
}
console.log('');

process.exit(runTier('unit', unit));