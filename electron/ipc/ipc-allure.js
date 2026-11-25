'use strict';
/**
 * ipc-allure.js —— Allure 报告解析域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 解析 allure-results → 失败聚类 + Flaky 追踪。
 */
const allure = require('../allure');

/**
 * 归档进 runs 时用的 kind。
 *
 * runs 的 kind 只有 api（接口测试）/ perf（压测）两个选项，Allure 跑的多半是
 * 接口（REST Assured / pytest）或 UI 用例，两边都能归到「接口测试」这一档。
 * 刻意**不新增 'ui'**：加一个值要同步改 RUN_KIND_OPTIONS + 列表筛选 + 字段裁剪，
 * 而收益只是标签更准；等真有一批纯 UI 报告要分开统计时再加（见交付 notes）。
 */
const ARCHIVE_KIND = 'api';

/** 两位补零（默认名称里用） */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 默认归档名称：「Allure 归档-11-25 09:40」。
 *
 * 为什么带时间而不是只写目录名：同一次跑批可能一天归档两次（不同结论），
 * 列表里能按时间区分开；目录名太长，标题列放不下。
 */
function defaultArchiveName(now) {
  const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  return 'Allure 归档-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 目录路径归一化（Windows 大小写不敏感、斜杠不统一，比较前先抹平） */
function dirKey(dir) {
  return String(dir || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 只接受非负有限数，其余一律当「没传」 */
function nonNegativeInt(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function register(deps) {
  const { handle, dialog, getWindow, getSettings, store, assertUnlocked, assertPathIn, rememberPicked } = deps;

  /** 扫描根目录下所有 allure-results */
  handle('allure:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    // 优先级：显式传的 root > 设置里的 allureDir > 项目目录
    const dir =
      (root && String(root).trim()) || settings.allureDir || settings.projectDir || '';
    return allure.scanAllureRoots(dir);
  });

  /** 选 allure-results 目录 */
  handle('allure:pickDir', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择 allure-results 目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 这个目录不写进 settings，必须记进会话白名单，否则随后的 allure:parse 会被守卫拦掉
    rememberPicked(picked.filePaths[0]);
    return { ok: true, dir: picked.filePaths[0] };
  });

  /**
   * 解析 allure-results 目录。
   *
   * 返回：用例列表 + 汇总 + 失败聚类。
   */
  handle('allure:parse', async (e, { dir } = {}) => {
    assertUnlocked();
    const d = String(dir || '').trim();
    if (!d) return { ok: false, message: '缺少目录' };
    // 入参守卫：只解析白名单目录（v0.43.0）
    const bad = assertPathIn(d);
    if (bad) return bad;
    const res = allure.parseAllureDir(d);
    if (!res.ok) return res;
    return Object.assign({}, res, {
      clusters: allure.clusterFailures(res.tests)
    });
  });

  /**
   * Flaky 追踪：解析多个 allure-results 目录，比对同一用例的通过/失败。
   *
   * payload: { dirs: string[] }
   */
  handle('allure:flaky', async (e, { dirs } = {}) => {
    assertUnlocked();
    const list = Array.isArray(dirs) ? dirs : [];
    if (!list.length) return { ok: false, message: '缺少目录列表', flaky: [] };

    // 逐个校验：只要有一个越界就整单拒绝（不静默跳过，否则用户以为少了几次跑批）
    for (const d of list) {
      const bad = assertPathIn(String(d));
      if (bad) return Object.assign({}, bad, { flaky: [] });
    }

    const runs = [];
    const errors = [];
    for (const d of list) {
      const res = allure.parseAllureDir(String(d));
      if (res.ok) runs.push(res.tests);
      else errors.push({ dir: d, message: res.message });
    }

    return {
      ok: true,
      runs: runs.length,
      flaky: allure.trackFlaky(runs),
      errors
    };
  });

  /**
   * 归档到「测试执行」——把一次 Allure 解析结果写成一条 runs 记录（v0.46.1）。
   *
   * 为什么要这个通道：
   *   压测报告能一键填进 runs，Allure 报告分析完什么都不留 ——
   *   同一句「跑完留痕」，压测有、接口/UI 测试没有。这里是补上的那一半。
   *
   * payload:
   *   dir        报告目录（必填，必须在白名单内）
   *   name       标题，空 = 自动生成「Allure 归档-11-25 09:40」
   *   env        环境，空 = test
   *   passCount  通过数（前端解析结果）
   *   failCount  失败数（failed + broken；前端解析结果）
   *   total      总数
   *   duration   总耗时（毫秒）
   *   note       备注，落进「结论」字段
   *
   * 返回：{ ok, id, duplicated, duplicates, counts, ... }
   *
   * 幂等：**同一个 reportDir 重复归档会新建一条**，返回里带 duplicated:true。
   *   理由：runs 的语义是「跑一次记一笔」的流水账，同一次跑批完全可能想留两条
   *   不同结论（比如先按「失败待查」记一条，排查完再补一条「已复核：环境问题」）。
   *   直接覆盖会悄悄改掉用户已经写下的结论，比多一条更难解释。
   *   duplicated 只是提示，不拦人。
   */
  handle('allure:archive', async (e, payload = {}) => {
    assertUnlocked();
    const p = payload || {};
    const dir = String(p.dir || '').trim();
    if (!dir) return { ok: false, code: 'NO_DIR', message: '缺少报告目录' };

    // 入参守卫：归档会把 dir 写进执行记录，和 allure:parse 一样只认白名单目录
    const bad = assertPathIn(dir);
    if (bad) return bad;

    /**
     * 不直接采信前端传的统计：先把目录当 allure-results 真解析一遍。
     * 这样「目录被删了 / 选的不是 allure-results」在写库之前就能拦下来，
     * 不会在「测试执行」里留下一条指向不存在报告的记录。
     */
    const parsed = allure.parseAllureDir(dir);
    if (!parsed.ok) {
      if (String(parsed.message || '').indexOf('目录不存在') >= 0) {
        return { ok: false, code: 'DIR_NOT_FOUND', message: '报告目录不存在：' + dir + '（可能已经被移动或删除）' };
      }
      return {
        ok: false,
        code: 'NOT_ALLURE_DIR',
        message: '这不是 allure-results 目录：' + dir + '（' + (parsed.message || '解析失败') + '）'
      };
    }

    const sum = parsed.summary || {};
    // broken 也是「没通过」，和界面上「失败」的统计口径一致
    const summaryFailed = (Number(sum.failed) || 0) + (Number(sum.broken) || 0);

    let passCount = nonNegativeInt(p.passCount);
    let failCount = nonNegativeInt(p.failCount);
    let total = nonNegativeInt(p.total);
    let duration = nonNegativeInt(p.duration);
    if (passCount === null) passCount = Number(sum.passed) || 0;
    if (failCount === null) failCount = summaryFailed;
    if (total === null) total = Number(sum.total) || 0;
    if (duration === null) duration = Number(sum.duration) || 0;
    // 总数至少要装得下「通过 + 失败」，否则「跳过」会被算成负数
    if (total < passCount + failCount) total = passCount + failCount;

    // 结果判定：全过 → ok；有失败 → bad；其余（比如全都跳过）→ unknown
    let result = 'unknown';
    if (failCount > 0) result = 'bad';
    else if (total > 0 && passCount >= total) result = 'ok';

    // 执行时间：取最后一条用例的结束时间（allure 的 start/stop 就是毫秒时间戳）
    const ranAt =
      parsed.tests.reduce((max, t) => {
        const end = Number(t.stop) || Number(t.start) || 0;
        return end > max ? end : max;
      }, 0) || Date.now();

    const name = String(p.name || '').trim() || defaultArchiveName(new Date());
    const env = String(p.env || '').trim() || 'test';
    // runs 里没有独立的「备注」字段，人话备注就落进「结论」
    const conclusion = String(p.note || '').trim();

    const data = {
      name,
      kind: ARCHIVE_KIND,
      result,
      ranAt,
      env,
      passCount,
      failCount,
      // 总耗时（毫秒）。runs 里 duration 字段目前是按压测「时长」写的文本字段、
      // 只对 perf 展示，但数据要留着：归档记录能自己说清这次跑了多久。
      duration,
      // 关键锚点：测试执行列表靠它跳回「报告分析」
      reportDir: dir,
      conclusion
    };

    // 归档前先数一遍同一个目录已经归档过几次（只用于提示，不拦人）
    const key = dirKey(dir);
    const duplicates = (store.list('runs') || []).filter((r) => r && r.data && dirKey(r.data.reportDir) === key).length;

    let saved = null;
    try {
      saved = store.save({ collection: 'runs', data, tags: [], favorite: false });
    } catch (err) {
      return { ok: false, code: 'SAVE_FAILED', message: '写入执行记录失败：' + String((err && err.message) || err) };
    }
    if (!saved || !saved.id) {
      return { ok: false, code: 'SAVE_FAILED', message: '写入执行记录失败：没有拿到记录 id' };
    }

    return {
      ok: true,
      id: saved.id,
      name,
      kind: ARCHIVE_KIND,
      result,
      dir,
      duplicated: duplicates > 0,
      duplicates,
      counts: {
        total,
        passCount,
        failCount,
        skipped: Math.max(0, total - passCount - failCount),
        duration
      }
    };
  });
}

module.exports = { register };