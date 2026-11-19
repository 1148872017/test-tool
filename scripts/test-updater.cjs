/* 更新模块测试：版本比较 + 取消/清理/错误处理
 *
 * 注意：真实网络检查需要 Electron 的 net 模块（走系统代理），
 * 纯 Node 环境跑不了。所以这里只测纯逻辑，真实 API 用单独的脚本验证。
 */
const path = require('path');
const Module = require('module');

const origResolve = Module._resolveFilename;
const stubPath = path.join(__dirname, '_stub-electron.cjs');
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return stubPath;
  return origResolve.call(this, request, ...args);
};

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const { compareVersion, checkUpdate, download, cancel, cleanup } = require('../electron/updater.js');

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

(async () => {
  /* ---------- 2. 网络失败时优雅降级 ---------- */
  const res = await checkUpdate();
  check('网络失败时返回 ok:false', res.ok === false, res);
  check('网络失败时有 message', typeof res.message === 'string' && res.message.length > 0, res.message);

  /* ---------- 3. 取消 / 清理 ---------- */
  const c1 = cancel();
  check('无下载时取消不报错', c1 && c1.ok === true, c1);

  const cl = cleanup();
  check('清理不报错', cl && cl.ok === true, cl);

  /* ---------- 4. 下载参数校验 ---------- */
  const d1 = await download(null, () => {});
  check('无 asset 时下载报错', d1 && d1.ok === false && /没有可下载/.test(d1.message), d1);

  const d2 = await download({ name: 'x.exe', size: 100, url: '' }, () => {});
  check('空 url 时下载报错', d2 && d2.ok === false, d2);

  const failed = results.filter((r) => !r.ok);
  console.log('===== 更新模块测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})();
