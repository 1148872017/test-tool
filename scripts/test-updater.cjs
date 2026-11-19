/* 更新模块测试：版本比较 + 真实 GitHub API 检查 */
const path = require('path');
const Module = require('module');

// updater.js 依赖 electron 的 app/shell，测试里用 stub 顶掉
const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, '_stub-electron.cjs');
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return stubPath;
  return origResolve.call(this, request, ...args);
};

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const { compareVersion, checkUpdate } = require('../electron/updater.js');

/* ---------- 1. 版本比较 ---------- */
check('相同版本返回 0', compareVersion('0.25.0', '0.25.0') === 0);
check('新版大于旧版', compareVersion('0.26.0', '0.25.0') === 1);
check('旧版小于新版', compareVersion('0.25.0', '0.26.0') === -1);
check('带 v 前缀也能比', compareVersion('v0.26.0', '0.25.0') === 1);
check('主版本号优先', compareVersion('1.0.0', '0.99.99') === 1);
check('补丁号比较', compareVersion('0.25.1', '0.25.0') === 1);
check('位数不同也能比', compareVersion('0.25', '0.25.0') === 0);
check('0.25.0.1 大于 0.25.0', compareVersion('0.25.0.1', '0.25.0') === 1);
check('空值当 0', compareVersion('', '0.0.0') === 0);
check('非法值不崩', typeof compareVersion('abc', 'def') === 'number');

/* ---------- 2. 真实 API 检查（仓库已转 Public，匿名可访问）---------- */
(async () => {
  const res = await checkUpdate();
  check('checkUpdate 返回 ok', res.ok === true, res);
  if (res.ok) {
    check('拿到 latest 版本号', /^\d+\.\d+\.\d+/.test(res.latest), res.latest);
    check('拿到 current 版本号', /^\d+\.\d+\.\d+/.test(res.current), res.current);
    check('hasNew 是布尔', typeof res.hasNew === 'boolean', res.hasNew);
    check('找到 Setup 附件', !!res.asset && /Setup/i.test(res.asset.name), res.asset);
    check('附件有下载链接', !!res.asset && /^https:\/\//.test(res.asset.url), res.asset && res.asset.url);
    check('附件有大小', !!res.asset && res.asset.size > 0, res.asset && res.asset.size);
    check('有 release notes', typeof res.notes === 'string', typeof res.notes);
    // stub 的 app.getVersion() 返回 0.0.1，所以一定有新版
    check('stub 版本 0.0.1 时 hasNew 为 true', res.hasNew === true, { current: res.current, latest: res.latest });
  }

  const failed = results.filter((r) => !r.ok);
  console.log('===== 更新模块测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();
