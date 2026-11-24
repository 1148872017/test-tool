/* IPC 通道不能重复注册（重复会让应用启动直接崩） */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

/**
 * 扫所有 ipcMain.handle('xxx')，找重复的通道名。
 *
 * 为什么这条重要（踩坑 #103）：
 *   用户装 0.41.0 后启动直接弹「启动失败」，
 *   因为 `data:openDir` 被注册了两次——
 *   原来的「打开数据目录」和后来加的「打开工作区」撞了名。
 *   Electron 第二次注册会直接抛异常，整个 app 起不来。
 */
const re = /ipcMain\.handle\('([^']+)'/g;
const seen = new Map();
const dups = [];
let m;
while ((m = re.exec(mainSrc)) !== null) {
  const name = m[1];
  const line = mainSrc.slice(0, m.index).split('\n').length;
  if (seen.has(name)) {
    dups.push({ name, first: seen.get(name), second: line });
  } else {
    seen.set(name, line);
  }
}

check('没有重复的 IPC 通道', dups.length === 0, dups);
check('handler 数量合理（≥90）', seen.size >= 90, seen.size);

/* 反向验证：故意造一个重复能被抓出来 */
{
  const fake = "ipcMain.handle('a:b', f);\nipcMain.handle('c:d', f);\nipcMain.handle('a:b', f);";
  const r2 = /ipcMain\.handle\('([^']+)'/g;
  const s2 = new Set();
  let found = false;
  let x;
  while ((x = r2.exec(fake)) !== null) {
    if (s2.has(x[1])) found = true;
    s2.add(x[1]);
  }
  check('能抓住重复通道的坏样本', found, 'not caught');
}

/* 关键通道逐一点名（防止改名时漏了 preload） */
{
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const invokes = [...preloadSrc.matchAll(/invoke\('([^']+)'/g)].map((x) => x[1]);
  const missing = [...new Set(invokes)].filter((ch) => !seen.has(ch));
  check('preload 里每个 invoke 都有 handler', missing.length === 0, missing);
}

const failed = results.filter((r) => !r.ok);
console.log('===== IPC 通道唯一性检查 =====');
console.log('handler 总数:', seen.size);
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);