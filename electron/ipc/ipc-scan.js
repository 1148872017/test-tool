'use strict';
/**
 * ipc-scan.js —— 代码体检（覆盖矩阵 / 代码体检 / 依赖冲突 / 规则表）域的 IPC。
 * 从 main.js 搬迁而来，原通道名/参数/返回值保持不变；
 * v0.41.3 只做加法：新增 codescan:rules，并给 coverage/hardcoded 加可选 ruleIds。
 *
 * 只读代码目录，不改被测项目。
 */
const codescan = require('../codescan');
const depsCheck = require('../deps');
const { RULES, SCAN_PACKS } = require('../scan-rules');

function register(deps) {
  const { handle, dialog, store, getWindow, getSettings, assertUnlocked, assertPathIn, rememberPicked } = deps;

  /* ==================== 代码扫描 ==================== *
   * 覆盖矩阵（接口清单 vs 代码路径）+ 硬编码检查。
   * ------------------------------------------------ */

  /**
   * 规则表（纯静态，不触盘）。
   *
   * 前端「规则」勾选面板靠它渲染：默认全选，用户可以关掉不想看的规则，
   * 关掉的规则由 codescan:coverage / codescan:hardcoded 的 ruleIds 参数带回来。
   */
  handle('codescan:rules', async () => {
    assertUnlocked();
    return {
      ok: true,
      total: RULES.length,
      packs: SCAN_PACKS.map((p) => ({ id: p.id, label: p.label, count: p.count })),
      rules: RULES.map((r) => ({
        id: r.id,
        pack: r.pack,
        category: r.category,
        severity: r.severity,
        title: r.title,
        desc: r.desc
      }))
    };
  });

  /**
   * 接口/页面的「模块」列表（给覆盖矩阵的范围筛选用）。
   *
   * 为什么需要：接口记录可能是全公司文档（100 个），
   * 某个项目只负责其中几个模块。不筛选就会报一堆无关的「未覆盖」。
   */
  handle('codescan:modules', async (e, { kind } = {}) => {
    assertUnlocked();
    const k = kind === 'page' ? 'page' : 'api';
    const items = k === 'page' ? store.list('pages') : store.list('apis');
    const counter = new Map();
    for (const it of items) {
      const d = it.data || {};
      const m = String(k === 'page' ? d.project || '' : d.module || '').trim();
      if (!m) continue;
      counter.set(m, (counter.get(m) || 0) + 1);
    }
    const modules = [...counter.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    return { ok: true, kind: k, modules, total: items.length, noModule: items.length - [...counter.values()].reduce((a, b) => a + b, 0) };
  });

  /**
   * 覆盖矩阵：接口清单 vs 代码里的请求路径。
   *
   * payload: { root, kind, modules, ruleIds }
   *   root    代码根目录（空 = settings.projectDir）
   *   ruleIds 只跑这些覆盖取数规则（缺省 = 全部，行为与 v0.41.2 一致）
   */
  handle('codescan:coverage', async (e, { root, kind, modules, ruleIds } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.projectDir || '';
    if (!dir) return { ok: false, message: '没配代码目录' };
    // 入参守卫：只扫设置里的目录 / 本会话选过扫过的目录（v0.43.0）
    const bad = assertPathIn(dir);
    if (bad) return bad;

    /**
     * 清单来源：
     *   api  → apis 集合（从 Apifox 同步的接口）
     *   page → pages 集合（在「页面元素」里维护的页面）
     *
     * modules：按模块过滤（用户反馈「导入 100 个接口，项目只用 20 个，
     * 剩下 80 个未覆盖」是噪音）——让用户限定「本项目相关的模块」。
     */
    const k = kind === 'page' ? 'page' : 'api';
    let items = k === 'page' ? store.list('pages') : store.list('apis');

    if (Array.isArray(modules) && modules.length) {
      const set = new Set(modules.map((m) => String(m)));
      items = items.filter((it) => {
        const d = it.data || {};
        const m = String(k === 'page' ? d.project || '' : d.module || '');
        return set.has(m);
      });
    }

    const res = codescan.buildCoverage(items, dir, k, { ruleIds });
    // 顺带把「本次参与对比的清单条数」也带上，方便前端说明
    return Object.assign({}, res, { filtered: Array.isArray(modules) && modules.length > 0 });
  });

  /**
   * 硬编码 / 脆弱定位 / 断言质量检查。
   *
   * payload: { root, ruleIds }  代码根目录 + 本次勾选的规则（缺省 = 全部）
   */
  handle('codescan:hardcoded', async (e, { root, ruleIds } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.projectDir || '';
    if (!dir) return { ok: false, message: '没配代码目录' };
    const bad = assertPathIn(dir);
    if (bad) return bad;
    return codescan.scanHardcoded(dir, { ruleIds });
  });

  /**
   * 依赖冲突检查（pom.xml / requirements.txt）。
   *
   * 只看「同一声明出现多次 / 版本不一致 / 占位符没定义」，
   * 不做传递依赖分析（那要联网查 Maven Central，成本远超收益）。
   */
  handle('codescan:deps', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.projectDir || '';
    if (!dir) return { ok: false, message: '没配代码目录' };
    const bad = assertPathIn(dir);
    if (bad) return bad;
    return depsCheck.checkDeps(dir);
  });

  /** 选代码目录 */
  handle('codescan:pickDir', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择代码目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 用户明确选过的目录 → 本会话可信根（后面 coverage/hardcoded/deps 要用）
    rememberPicked(picked.filePaths[0]);
    return { ok: true, dir: picked.filePaths[0] };
  });
}

module.exports = { register };