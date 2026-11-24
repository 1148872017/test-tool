/*
 * 目录输入框的防抖保存：每字段独立计时器（P0 回归）
 *
 * 要防的 bug（v0.41.x 之前的真实事故）：
 *   8 个目录字段共用一个 useRef 计时器，600ms 内改第二个字段时
 *   前一个字段的 clearTimeout 会把它清掉 —— 那个值永远不落库，且没有任何提示。
 *
 * 这个测试**跑真行为**：用 esbuild 现场把 src/utils/debounceMap.ts 转成 CJS，
 * 然后拿真实计时器喂它，看看到底发出了几次、发出的内容是什么。
 * 不做源码字符串匹配（除了最后两条集成断言，防止 SettingsPage 又退回共用计时器）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const esbuild = require(path.join(root, 'node_modules', 'esbuild'));

/* ---------- 加载被测模块（TS → CJS，跑真代码） ---------- */
const tsFile = path.join(root, 'src', 'utils', 'debounceMap.ts');
const ts = fs.readFileSync(tsFile, 'utf8');
const out = esbuild.transformSync(ts, { loader: 'ts', format: 'cjs' });
const mod = { exports: {} };
new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
const { createDebouncedSaver } = mod.exports;

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 造一个记录调用的假保存函数（和 saveSettings 一样收 patch 对象） */
function makeSaver(delayMs) {
  const calls = [];
  const saver = createDebouncedSaver((patch) => {
    calls.push(patch);
  }, delayMs);
  return { saver, calls };
}

async function main() {
  /* ============================================================
   * 1. 核心 P0：600ms 内改两个字段，两个都要发出
   *    （旧实现里 a 会被 b 的 clearTimeout 清掉，只有 b 落库）
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(60);
    saver.save('casesDir', 'D:/a');
    await wait(10);
    saver.save('jmxDir', 'D:/b');
    await wait(200);
    check('两个字段都在 600ms 内各发一次', calls.length === 2, calls);
    const keys = calls.map((c) => Object.keys(c)[0]).sort();
    check('发出的 key 是 casesDir + jmxDir', keys.join(',') === 'casesDir,jmxDir', keys);
    const merged = Object.assign({}, ...calls);
    check('casesDir 的值没丢', merged.casesDir === 'D:/a', merged);
    check('jmxDir 的值没丢', merged.jmxDir === 'D:/b', merged);
  }

  /* 8 个目录字段交叉输入（真实使用场景：一次粘贴好几个目录） */
  {
    const { saver, calls } = makeSaver(50);
    const dirs = ['workspaceDir', 'casesDir', 'jmxDir', 'reportDir', 'allureDir', 'kbDir', 'notesDir', 'projectDir'];
    dirs.forEach((k, i) => saver.save(k, 'D:/d' + i));
    await wait(180);
    const merged = Object.assign({}, ...calls);
    check('8 个目录字段一个都没丢', dirs.every((k, i) => merged[k] === 'D:/d' + i), merged);
    check('8 个目录字段正好发 8 次', calls.length === 8, calls.length);
  }

  /* ============================================================
   * 2. 同一个字段连改 3 次 → 只发最后一次
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(50);
    saver.save('casesDir', 'D:/1');
    await wait(10);
    saver.save('casesDir', 'D:/12');
    await wait(10);
    saver.save('casesDir', 'D:/123');
    await wait(180);
    check('同字段连改 3 次只发 1 次', calls.length === 1, calls);
    check('发的是最后一次的值', calls[0] && calls[0].casesDir === 'D:/123', calls);
  }

  /* 同字段再输入会重新计时：不足 delay 发不出去 */
  {
    const { saver, calls } = makeSaver(60);
    saver.save('casesDir', 'D:/x');
    await wait(40);
    saver.save('casesDir', 'D:/xy'); // 重置计时
    await wait(40); // 距第一次 80ms、距第二次 40ms
    check('再输入会重置计时（此时还没发）', calls.length === 0, calls);
    await wait(120);
    check('重置后照样发出，且只发最后的值', calls.length === 1 && calls[0].casesDir === 'D:/xy', calls);
  }

  /* ============================================================
   * 3. 延迟边界：delayMs 内不发出、超出后发出
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(80);
    saver.save('kbDir', 'D:/kb');
    await wait(40); // 半个 delay
    check('delayMs 内不发出', calls.length === 0, calls);
    await wait(160);
    check('超出 delayMs 后发出', calls.length === 1 && calls[0].kbDir === 'D:/kb', calls);
  }

  /* 默认 600ms（真实产品参数） */
  {
    const calls = [];
    const saver = createDebouncedSaver((patch) => calls.push(patch)); // 不传 delay
    saver.save('notesDir', 'D:/notes');
    await wait(300);
    check('默认 600ms：300ms 时还没发出', calls.length === 0, calls);
    await wait(500);
    check('默认 600ms：800ms 时已发出', calls.length === 1 && calls[0].notesDir === 'D:/notes', calls);
  }

  /* ============================================================
   * 4. flushAll：所有 pending 立刻发出，且 pending 清空
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(1000); // 故意把 delay 拉长，证明是 flush 发的而不是计时器
    saver.save('casesDir', 'D:/a');
    saver.save('jmxDir', 'D:/b');
    check('flushAll 前 pendingCount = 2', saver.pendingCount() === 2, saver.pendingCount());
    const sent = saver.flushAll();
    check('flushAll 立即发出 2 个', calls.length === 2 && sent === 2, { calls: calls.length, sent });
    const merged = Object.assign({}, ...calls);
    check('flushAll 发出的内容正确', merged.casesDir === 'D:/a' && merged.jmxDir === 'D:/b', merged);
    check('flushAll 后 pendingCount = 0', saver.pendingCount() === 0, saver.pendingCount());
    // 计时器也要被清掉，否则 1000ms 后还会再发一遍
    await wait(1100);
    check('flushAll 后计时器已清（不会重复发）', calls.length === 2, calls.length);
  }

  /* ============================================================
   * 5. flushOne：只发指定字段，并把它从 Map 里删掉
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(1000);
    saver.save('casesDir', 'D:/a');
    saver.save('jmxDir', 'D:/b');
    const ok = saver.flushOne('casesDir');
    check('flushOne 返回 true', ok === true, ok);
    check('flushOne 只发指定的那个字段', calls.length === 1 && calls[0].casesDir === 'D:/a', calls);
    check('flushOne 后该 key 已从 Map 删除', saver.hasPending('casesDir') === false, saver.pendingKeys());
    check('flushOne 后 pendingCount = 1', saver.pendingCount() === 1, saver.pendingCount());
    check('flushOne 后再 flushOne 同一个 key 返回 false', saver.flushOne('casesDir') === false, null);
    check('没 pending 的 key flushOne 不发', saver.flushOne('kbDir') === false && calls.length === 1, calls);
    const sent = saver.flushAll();
    check('剩下的字段还能正常 flush', sent === 1 && calls.some((c) => c.jmxDir === 'D:/b'), { sent, calls });
  }

  /* ============================================================
   * 6. save 后立即 flushAll 不会重复发（既不清成 0 次，也不发 2 次）
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(80);
    saver.save('casesDir', 'D:/a');
    saver.flushAll();
    check('立即 flushAll 只发 1 次', calls.length === 1, calls);
    await wait(200); // 等原计时器应该触发的时间点过去
    check('计时器已被 flush 取消，不会再发一次', calls.length === 1, calls);
    check('此时 pendingCount = 0', saver.pendingCount() === 0, saver.pendingCount());
  }

  /* flushAll 之后再 save 新值，仍然能正常发 */
  {
    const { saver, calls } = makeSaver(50);
    saver.save('casesDir', 'D:/a');
    saver.flushAll();
    saver.save('casesDir', 'D:/b');
    await wait(160);
    check('flush 之后再输入照常保存', calls.length === 2 && calls[1].casesDir === 'D:/b', calls);
  }

  /* ============================================================
   * 7. dispose：先 flush 再丢状态（组件卸载后的清理）
   * ============================================================ */
  {
    const { saver, calls } = makeSaver(1000);
    saver.save('kbDir', 'D:/kb');
    saver.dispose();
    check('dispose 会先把 pending 发出去', calls.length === 1 && calls[0].kbDir === 'D:/kb', calls);
    check('dispose 后 pendingCount = 0', saver.pendingCount() === 0, saver.pendingCount());
  }

  /* 保存函数抛异常时，不能连累其它字段（否则又会静默丢） */
  {
    const calls = [];
    const saver = createDebouncedSaver((patch) => {
      if (patch.bad) throw new Error('模拟保存失败');
      calls.push(patch);
    }, 30);
    saver.save('bad', 'x');
    saver.save('good', 'y');
    let threw = false;
    try {
      saver.flushAll();
    } catch (e) {
      threw = true;
    }
    check('单个字段保存抛异常不会中断 flushAll', threw === false, 'flushAll threw');
    check('其它字段照样发出去了', calls.length === 1 && calls[0].good === 'y', calls);
  }

  /* ============================================================
   * 8. 反向验证：把旧实现（8 个字段共用一个计时器）照抄一遍，
   *    确认它真的会丢值 —— 证明上面那群断言不是随便写都能过
   * ============================================================ */
  {
    const oldCalls = [];
    let oldTimer = null;
    const oldSaveDirDebounced = (key, value) => {
      if (oldTimer) clearTimeout(oldTimer); // 旧代码：清掉别人的计时器
      oldTimer = setTimeout(() => oldCalls.push({ [key]: value }), 60);
    };
    oldSaveDirDebounced('casesDir', 'D:/a');
    await wait(10);
    oldSaveDirDebounced('jmxDir', 'D:/b');
    await wait(200);
    check('旧实现（共用计时器）会把 casesDir 丢掉 —— bug 确实能复现', oldCalls.length === 1 && !oldCalls.some((c) => c.casesDir), oldCalls);
  }

  /* ============================================================
   * 9. 集成：SettingsPage 真的用了这套东西（防止退回共用计时器）
   * ============================================================ */
  {
    const page = fs.readFileSync(path.join(root, 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
    // 去掉注释再断言，避免注释里的说明文字误导
    const codeOnly = page
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    check('设置页引用了 createDebouncedSaver', /createDebouncedSaver/.test(codeOnly), 'not imported');
    check('设置页没有共用单个计时器（旧写法已清除）', !/dirSaveTimer/.test(codeOnly), 'old shared timer still there');
    check('卸载时会 flushAllDirs', /return\s*\(\)\s*=>\s*\{\s*flushAllDirs\(\)/.test(codeOnly), 'no unmount flush');
    const dirCalls = codeOnly.match(/saveDirDebounced\('/g) || [];
    check('8 个目录字段都走 saveDirDebounced', dirCalls.length === 8, dirCalls.length);
    check('beforeunload 兜底 flush 在', /beforeunload/.test(codeOnly), 'no beforeunload');
  }

  /* ---------- 汇总 ---------- */
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed' + (failed.length ? '  (' + failed.length + ' FAILED)' : ''));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身崩了：', e);
  process.exit(1);
});