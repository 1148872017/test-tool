/*
 * 第 3 波（键盘与性能）回归测试。
 *
 * 覆盖两件事：
 *   1. 运行输出环形缓冲 lineBuffer.ts —— **真跑逻辑**（esbuild 现场把 TS 转成 CJS 再执行），
 *      不做源码字符串匹配：5000 行丢 3000、保留的是最后 2000、id 连续不回退、clear 归零、cap=1 边界。
 *   2. 快捷键匹配 matchesHotkey / parseCombo —— 同样是真跑逻辑（Ctrl+Enter、Esc、修饰键严格匹配）。
 *
 * 最后一段是「接线断言」：确认页面确实用了缓冲 + 100ms 批处理 + memo + aria/键位，
 * 以及 electron/runner.js 的 settled 只收尾一次（修 error/close 双触发）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));

/* ---------- 加载被测算模块（TS → CJS） ---------- */
function loadTs(relFile) {
  const ts = fs.readFileSync(path.join(root, relFile), 'utf8');
  const out = esbuild.transformSync(ts, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
  return mod.exports;
}

const { createLineBuffer, DEFAULT_LINE_CAP } = loadTs('src/features/runner/lineBuffer.ts');
const { matchesHotkey, parseCombo } = loadTs('src/hooks/useHotkeys.ts');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 1. 核心：5000 行 / 上限 2000
 * ============================================================ */
{
  const buf = createLineBuffer(2000);
  for (let i = 1; i <= 5000; i += 1) buf.push(i % 2 ? 'stdout' : 'stderr', 'L' + i);

  const lines = buf.lines();
  check('上限常量是 2000', DEFAULT_LINE_CAP === 2000, DEFAULT_LINE_CAP);
  check('push 5000 行后只剩 2000 行', lines.length === 2000, lines.length);
  check('丢弃计数 = 3000', buf.dropped() === 3000, buf.dropped());
  check('保留的是最后 2000 行（首行 L3001）', lines[0].text === 'L3001', lines[0].text);
  check('保留到最新的 L5000（末行）', lines[1999].text === 'L5000', lines[1999].text);
  check('首行 id = 3001（id 从 1 开始自增）', lines[0].id === 3001, lines[0].id);
  check('末行 id = 5000', lines[1999].id === 5000, lines[1999].id);

  // id 连续、不重复（丢行后仍然连续）
  let contiguous = true;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].id !== lines[i - 1].id + 1) {
      contiguous = false;
      break;
    }
  }
  check('丢弃后 id 仍逐行 +1（连续）', contiguous, lines.slice(0, 3).map((l) => l.id));
  check('id 不重复', new Set(lines.map((l) => l.id)).size === 2000, new Set(lines.map((l) => l.id)).size);
  check(
    'stdout / stderr 两种流都原样保留',
    lines.some((l) => l.stream === 'stdout') && lines.some((l) => l.stream === 'stderr'),
    lines.slice(0, 4).map((l) => l.stream)
  );
}

/* ============================================================
 * 2. 环形顺序：跨圈之后仍按时间正序
 * ============================================================ */
{
  const buf = createLineBuffer(3);
  for (let i = 1; i <= 5; i += 1) buf.push('stdout', 'L' + i);
  check('跨多圈后顺序正确（L3 L4 L5）', buf.lines().map((l) => l.text).join(',') === 'L3,L4,L5', buf.lines().map((l) => l.text));
  check('cap=3 push 5 次丢了 2 行', buf.dropped() === 2, buf.dropped());
}

/* ============================================================
 * 3. 快照：数组是新的，行对象是同一引用（OutputConsole 的 memo 靠这个）
 * ============================================================ */
{
  const buf = createLineBuffer(10);
  buf.push('stdout', 'A');
  const snap = buf.lines();
  snap.push({ id: 999, stream: 'stdout', text: '脏数据' });
  const again = buf.lines();
  check('快照是独立数组（外部 push 不污染缓冲）', again.length === 1, again.length);
  check('行对象跨快照保持同一引用（逐行 memo 才能命中）', again[0] === snap[0], 'reference changed');
  check('快照里行的内容正确', again[0].text === 'A', again[0].text);
}

/* ============================================================
 * 4. clear：归零 + id 不回退
 * ============================================================ */
{
  const buf = createLineBuffer(5);
  for (let i = 1; i <= 8; i += 1) buf.push('stdout', 'X' + i);
  const lastId = buf.lines()[buf.lines().length - 1].id;
  buf.clear();
  check('clear 后没有行', buf.lines().length === 0, buf.lines().length);
  check('clear 后丢弃计数归零', buf.dropped() === 0, buf.dropped());

  buf.push('stdout', '新的一行');
  const after = buf.lines();
  check('clear 后还能继续 push', after.length === 1, after.length);
  check('clear 后 id 继续自增（不回退，避免 key 撞车）', after[0].id > lastId, { before: lastId, after: after[0].id });
}

/* ============================================================
 * 5. cap=1 边界
 * ============================================================ */
{
  const buf = createLineBuffer(1);
  buf.push('stdout', 'a');
  check('cap=1 时保留 1 行', buf.lines().length === 1 && buf.lines()[0].text === 'a', buf.lines());
  buf.push('stderr', 'b');
  buf.push('stdout', 'c');
  check('cap=1 只留最新一行', buf.lines()[0].text === 'c', buf.lines());
  check('cap=1 push 3 次丢 2 行', buf.dropped() === 2, buf.dropped());
  check('cap=1 最新一行的流也正确', buf.lines()[0].stream === 'stdout', buf.lines()[0].stream);
}

/* ============================================================
 * 6. 空缓冲 / 非法入参不抛
 * ============================================================ */
{
  const empty = createLineBuffer(2000);
  check('空缓冲 lines() 是空数组', Array.isArray(empty.lines()) && empty.lines().length === 0, empty.lines());
  check('空缓冲 dropped() 是 0', empty.dropped() === 0, empty.dropped());

  let threw = '';
  try {
    empty.clear();
    empty.clear();
    empty.lines();
    empty.dropped();
  } catch (e) {
    threw = String(e && e.message);
  }
  check('空缓冲 clear / lines / dropped 重复调用不抛', threw === '', threw);

  // 文本一律按 String 存，不丢 null / 0 / 空串
  empty.push('stderr', '');
  empty.push('stdout', 0);
  const two = empty.lines();
  check('空串与数字入参也如实存成字符串', two.length === 2 && two[0].text === '' && two[1].text === '0', two.map((l) => l.text));

  // cap 非法时退化成 1，不能抛
  let badThrew = '';
  let bad;
  try {
    bad = createLineBuffer(0);
    bad.push('stdout', 'x');
    bad.push('stdout', 'y');
  } catch (e) {
    badThrew = String(e && e.message);
  }
  check('cap=0 不抛且退化为保留 1 行', badThrew === '' && !!bad && bad.lines().length === 1, { badThrew, n: bad && bad.lines().length });

  let nanThrew = '';
  try {
    createLineBuffer(NaN).push('stdout', 'z');
    createLineBuffer(-5).push('stdout', 'z');
    createLineBuffer(Infinity).push('stdout', 'z');
  } catch (e) {
    nanThrew = String(e && e.message);
  }
  check('cap=NaN/-5/Infinity 构造与 push 都不抛', nanThrew === '', nanThrew);
}

/* ============================================================
 * 7. 快捷键匹配（useHotkeys 的纯函数部分）
 * ============================================================ */
const key = (k, mods) => Object.assign({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, mods || {});
{
  check('Ctrl+Enter 命中', matchesHotkey(key('Enter', { ctrlKey: true }), 'Ctrl+Enter'), 'miss');
  check('单独 Enter 不命中 Ctrl+Enter', !matchesHotkey(key('Enter'), 'Ctrl+Enter'), 'false positive');
  check('Ctrl+Shift+Enter 不命中 Ctrl+Enter（修饰键严格匹配）', !matchesHotkey(key('Enter', { ctrlKey: true, shiftKey: true }), 'Ctrl+Enter'), 'shift not strict');
  check('Escape 命中', matchesHotkey(key('Escape'), 'Escape'), 'miss');
  check('Esc 别名命中', matchesHotkey(key('Escape'), 'Esc'), 'alias miss');
  check('Ctrl+Esc 不命中无修饰的 Esc', !matchesHotkey(key('Escape', { ctrlKey: true }), 'Esc'), 'modifier leaked');
  check('Mod+Enter 认 Ctrl', matchesHotkey(key('Enter', { ctrlKey: true }), 'Mod+Enter'), 'ctrl miss');
  check('Mod+Enter 认 Cmd/Meta', matchesHotkey(key('Enter', { metaKey: true }), 'Mod+Enter'), 'meta miss');
  check('Ctrl+K 大小写不敏感', matchesHotkey(key('K', { ctrlKey: true }), 'Ctrl+K'), 'uppercase miss');
  check('Shift+K 不命中 Ctrl+K', !matchesHotkey(key('k', { shiftKey: true }), 'Ctrl+K'), 'false positive');

  const parsed = parseCombo('Ctrl+Shift+K');
  check(
    'parseCombo 解析 Ctrl+Shift+K',
    parsed.ctrl === true && parsed.shift === true && parsed.alt === false && parsed.mod === false && parsed.key === 'k',
    parsed
  );
  check('parseCombo 解析 Mod+Enter', parseCombo('Mod+Enter').mod === true && parseCombo('Mod+Enter').key === 'enter', parseCombo('Mod+Enter'));
}

/* ============================================================
 * 8. 接线断言：页面确实用上了缓冲 / 批处理 / memo / 无障碍
 * ============================================================ */
{
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const runnerPage = read('src/pages/CodeRunnerPage.tsx');
  const consoleSrc = read('src/features/runner/OutputConsole.tsx');
  const dataTool = read('src/pages/DataTool.tsx');
  const sidebar = read('src/components/Sidebar.tsx');
  const hookSrc = read('src/hooks/useHotkeys.ts');
  const runnerSrc = read('electron/runner.js');

  // --- 任务 1：环形缓冲接线 ---
  check('代码调试页用 createLineBuffer(默认上限)', /useState\(\(\) => createLineBuffer\(DEFAULT_LINE_CAP\)\)/.test(runnerPage), 'no buffer');
  check('输出回调只往缓冲里 push', /buffer\.push\(/.test(runnerPage), 'not buffered');
  check('不再无上限 concat 输出', !/setLines\(\(prev\) => prev\.concat/.test(runnerPage), 'still concat');
  check('有 100ms 批处理常量', /FLUSH_INTERVAL = 100/.test(runnerPage), 'no interval');
  check('用 setTimeout 合并 setState', /flushTimer\.current = setTimeout\(/.test(runnerPage), 'no timer');
  check('退出前把最后一批刷出来', /flushOutput\(\);\s*\n\s*setRunning\(false\)/.test(runnerPage), 'exit not flushed');
  check('渲染改用 OutputConsole', /<OutputConsole/.test(runnerPage), 'not used');
  check('OutputConsole 用 React.memo', /React\.memo/.test(consoleSrc), 'no memo');
  check('每行 key 用自增 id', /key=\{line\.id\}/.test(consoleSrc), 'row key not id');
  check('丢弃行数如实展示', /已丢弃前 \{dropped\} 行/.test(consoleSrc), 'dropped hidden');
  check('复制输出会说明丢行', /前面 \$\{dropped\} 行已丢弃/.test(runnerPage), 'copy lies');

  // --- 任务 1 附带 bug：runner.js 只收尾一次 ---
  check('runner.js 有 settled 收尾标志', /let settled = false/.test(runnerSrc) && /if \(settled\) return/.test(runnerSrc), 'no settled guard');
  check('error / close 都走 finish()', /proc\.on\('error'[\s\S]{0,200}?finish\(/.test(runnerSrc) && /proc\.on\('close'[\s\S]{0,200}?finish\(/.test(runnerSrc), 'handlers not unified');
  check('onExit 只有「构造失败」和 finish 两处调用', (runnerSrc.match(/opts\.onExit\(/g) || []).length === 2, (runnerSrc.match(/opts\.onExit\(/g) || []).length);

  // --- 任务 3：侧栏键盘可达 ---
  check('侧栏 nav 有 aria-label=主导航', /<nav[^>]*aria-label="主导航"/.test(sidebar), 'no nav label');
  check('导航项有 role=link', /role="link"/.test(sidebar), 'no role');
  check('导航项可聚焦（tabIndex=0）', /tabIndex=\{0\}/.test(sidebar), 'not focusable');
  check('导航项有 aria-current=page', /aria-current=\{isActive\(item\) \? 'page' : undefined\}/.test(sidebar), 'no aria-current');
  check('导航项支持 Enter/Space', /e\.key === 'Enter' \|\| e\.key === ' '/.test(sidebar), 'no keydown');

  // --- 任务 3：快捷键接到两个页面 ---
  check('useHotkeys 导出 matchesHotkey（纯函数可测）', /export function matchesHotkey/.test(hookSrc), 'not exported');
  check('代码调试页接 Ctrl+Enter + Esc', /'Ctrl\+Enter':/.test(runnerPage) && /Escape:/.test(runnerPage), 'hotkeys missing');
  check('造数页接 Ctrl+Enter', /useHotkeys\(\{\s*'Ctrl\+Enter'/.test(dataTool), 'no hotkey');

  // --- 任务 3：图标按钮 aria-label ---
  check('代码调试页关闭提示按钮有 aria-label', /aria-label="关闭环境提示"/.test(runnerPage), 'no close label');
  check('输出控制台有 role=log + aria-label', /role="log"/.test(runnerPage) && /aria-label="运行输出"/.test(runnerPage), 'no log label');
  check('造数页删除字段按钮有 aria-label', /aria-label=\{'删除字段 ' \+/.test(dataTool), 'no delete label');
  check('造数页复制单条按钮有 aria-label', /aria-label=\{'复制第 ' \+/.test(dataTool), 'no copy label');

  // --- 任务 2 + 4：造数页 ---
  check('两处 TYPES 下拉都关掉虚拟化', (dataTool.match(/virtual=\{false\}/g) || []).length === 2, (dataTool.match(/virtual=\{false\}/g) || []).length);
  check('字段行 key 用行 id 不用下标', /<tr key=\{f\.id\}>/.test(dataTool), 'field row keyed by index');
  check('字段增删按 id 操作', /removeField = \(id: number\)/.test(dataTool) && /setField = \(id: number/.test(dataTool), 'still index based');
  check('预览行 key 不是纯下标', /key=\{previewKey\(/.test(dataTool), 'preview keyed by index');
  check('多字段预览列 key 用字段名', /key=\{activeFieldNames\[j\] \|\| j\}/.test(dataTool), 'cell keyed by index');
}

/* ============================================================
 * 9. runner.js：error / close 只收尾一次（真跑子进程）
 * ============================================================ */
/** 等一 waitMs，让 error / close 两个事件都走完 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkRunnerOnce() {
  const runner = require(path.join(root, 'electron', 'runner.js'));

  /* 9.1 不存在的命令：spawn 会先抛 error，随后 close 也会来 —— 必须只回调一次 */
  {
    const exits = [];
    runner.run({
      cmd: 'definitely-not-a-real-cmd-xyz',
      args: [],
      timeout: 5000,
      onData: () => {},
      onExit: (r) => exits.push(r)
    });
    await wait(400);
    check('不存在的命令：onExit 只触发一次（error/close 不双发）', exits.length === 1, exits.length);
    check('不存在的命令：退出码是 -1 且带 error 说明', !!exits[0] && exits[0].code === -1 && !!exits[0].error, exits[0]);
  }

  /* 9.2 正常命令：输出能流式收到，退出只回调一次、退出码 0 */
  {
    const exits = [];
    const chunks = [];
    runner.run({
      cmd: process.execPath,
      args: ['-e', 'console.log("hello-from-runner")'],
      timeout: 15000,
      onData: (d) => chunks.push(d),
      onExit: (r) => exits.push(r)
    });
    await wait(1500);
    check('正常命令：onExit 只触发一次', exits.length === 1, exits.length);
    check('正常命令：退出码 0', !!exits[0] && exits[0].code === 0, exits[0]);
    check(
      '正常命令：stdout 流式回调带内容',
      chunks.some((c) => c.stream === 'stdout' && c.text.includes('hello-from-runner')),
      chunks
    );
    check('正常命令：耗时是正数', !!exits[0] && exits[0].duration >= 0, exits[0] && exits[0].duration);
  }
}

checkRunnerOnce()
  .catch((e) => results.push({ name: 'runner 行为测试执行失败', ok: false, extra: String(e && e.stack) }))
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log('===== 运行输出环形缓冲 + 快捷键 + 键盘可达性测试 =====');
    for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
    process.exit(failed.length ? 1 : 0);
  });