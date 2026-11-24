/* IPC 通道不能重复注册（重复会让应用启动直接崩） */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');
/** 搬迁前 main.js 里的通道总数，搬迁只换位置、不换数量 */
/**
 * 期望的 handler 总数。
 *
 * 102 = IPC 域拆分搬迁前 main.js 的数量（搬迁本身不增不减）；
 * 之后每加一个通道必须同步改这个数，否则「重复注册」这条防线的分母就飘了。
 *   +5 回收站：records:trash-list / -count / -restore / -purge / -clear
 *   +1 代码体检规则表：codescan:rules（v0.41.3 规则表数据化）
 *   +2 同期其它改造（ipc-records / ipc-runner 新增）→ 当前实际 110
 *
 * 注意：这个数字是**整个 electron/ 目录的通道总数**，多人并行改不同域时
 * 以最后一次实测为准（合并后跑一遍 node scripts/test-ipc-unique.cjs 对一下）。
 */
const EXPECTED_CHANNELS = 110;

/**
 * 递归列出 electron/ 下所有 .js。
 *
 * 为什么不再只扫 main.js：
 *   handler 已按域拆到 electron/ipc/*.js，main.js 只剩启动流程。
 *   只扫 main.js 会「一个通道都扫不到」，这条测试就变成永远绿的空壳；
 *   扫整个目录才不会漏掉任何一个域（包括以后新加的）。
 */
function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(full));
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/**
 * 扫所有 ipcMain.handle('xxx')，找重复的通道名。
 *
 * 为什么这条重要（踩坑 #103）：
 *   用户装 0.41.0 后启动直接弹「启动失败」，
 *   因为 `data:openDir` 被注册了两次——
 *   原来的「打开数据目录」和后来加的「打开工作区」撞了名。
 *   Electron 第二次注册会直接抛异常，整个 app 起不来。
 *
 * 现在 handler 分散在 electron/ipc/*.js，跨文件撞名同样要拦，
 * 所以这里必须扫整个 electron/ 目录，而不是只看某一支文件。
 */
const re = /ipcMain\.handle\('([^']+)'/g;
const seen = new Map();
const dups = [];
for (const file of listJs(ELECTRON_DIR)) {
  const src = fs.readFileSync(file, 'utf8');
  re.lastIndex = 0; // 全局正则跨文件复用，每换一个文件必须归零
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    const where = path.relative(ELECTRON_DIR, file) + ':' + line;
    if (seen.has(name)) {
      dups.push({ name, first: seen.get(name), second: where });
    } else {
      seen.set(name, where);
    }
  }
}

check('没有重复的 IPC 通道', dups.length === 0, dups);
check('handler 总数 = ' + EXPECTED_CHANNELS + '（搬迁前后一致）', seen.size === EXPECTED_CHANNELS, seen.size);

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
console.log('扫描目录:', path.relative(path.join(__dirname, '..'), ELECTRON_DIR));
console.log('handler 总数:', seen.size);
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);