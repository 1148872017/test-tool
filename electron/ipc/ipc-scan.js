'use strict';
/**
 * ipc-scan.js —— 代码体检（覆盖矩阵 / 代码体检 / 依赖冲突 / 规则表）域的 IPC。
 * 从 main.js 搬迁而来，原通道名/参数/返回值保持不变；
 * v0.41.3 只做加法：新增 codescan:rules，并给 coverage/hardcoded 加可选 ruleIds。
 * v0.46.0 也只做加法（**没有新开通道**，通道总数不变）：
 *   · codescan:modules 多回一份 records（范围下拉「按单个接口/页面」用）
 *   · codescan:coverage 多认一个 ids（按单条记录筛），与 modules 取并集
 *
 * 只读代码目录，不改被测项目。
 */
const codescan = require('../codescan');
const depsCheck = require('../deps');
const { RULES, SCAN_PACKS } = require('../scan-rules');

/**
 * 某条记录在「按记录」下拉里的一行文字。
 *
 * 接口：`POST /api/login · 登录`（方法 + 路径，有接口名就补在后面，
 *       同名两行靠 id 区分，但人眼认的是方法与路径）
 * 页面：`登录页 /login`（页面名在前，路径在后）
 *
 * 放在后端算，是因为下拉里显示什么属于「清单」，不属于「页面渲染」；
 * 前端拿到的就是能直接显示的字符串，不用再拼一次（两处拼容易拼出两种格式）。
 *
 * @param {'api'|'page'} kind
 * @param {any} data 记录 data
 * @param {any} it 记录本体（title 兜底）
 * @returns {string}
 */
function recordLabel(kind, data, it) {
  const d = data || {};
  const name = String(it.title || d.name || '').trim();
  const url = String(d.url || d.path || '').trim();

  if (kind === 'page') {
    if (name && url && name !== url) return name + ' ' + url;
    return name || url || '（未命名页面）';
  }

  const method = String(d.method || '')
    .trim()
    .toUpperCase();
  const head = [method, url || name].filter(Boolean).join(' ');
  if (!head) return '（未命名接口）';
  // 名字和路径不同才补：名字就是路径时补一遍等于「/x /x」
  return name && url && name !== url ? head + ' · ' + name : head;
}

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
   * 接口/页面的「范围清单」：模块（项目）聚合 + 单条记录，一次取回。
   *
   * 为什么需要：接口记录可能是全公司文档（100 个），
   * 某个项目只负责其中几个模块。不筛选就会报一堆无关的「未覆盖」。
   *
   * v0.46.0 起多回一份 records（id + 展示文字）：
   * 范围下拉多了「按单个接口 / 按单个页面」这一粒度，
   * 选项数据直接复用这个通道 —— 不新开通道，通道总数不变，
   * 也就不会碰到「通道数 111」那道防线。
   */
  handle('codescan:modules', async (e, { kind } = {}) => {
    assertUnlocked();
    const k = kind === 'page' ? 'page' : 'api';
    const items = k === 'page' ? store.list('pages') : store.list('apis');
    const counter = new Map();
    const records = [];
    for (const it of items) {
      const d = it.data || {};
      const m = String(k === 'page' ? d.project || '' : d.module || '').trim();
      if (m) counter.set(m, (counter.get(m) || 0) + 1);
      // 单条记录的选项：id 是唯一键，label 是下拉里直接显示的那一行
      records.push({
        id: it.id,
        name: String(it.title || d.name || ''),
        method: k === 'api' ? String(d.method || '') : '',
        url: String(d.url || d.path || ''),
        module: m,
        label: recordLabel(k, d, it)
      });
    }
    // 固定顺序：先按模块聚在一起，同模块内按路径，最后按 id 兜底（保证两次打开顺序一致）
    records.sort(
      (a, b) =>
        String(a.module).localeCompare(String(b.module)) ||
        String(a.url).localeCompare(String(b.url)) ||
        String(a.id).localeCompare(String(b.id))
    );
    const modules = [...counter.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    return {
      ok: true,
      kind: k,
      modules,
      records,
      total: items.length,
      noModule: items.length - [...counter.values()].reduce((a, b) => a + b, 0)
    };
  });

  /**
   * 覆盖矩阵：接口/页面清单 vs 代码里的请求路径。
   *
   * payload: { root, kind, modules, ids, ruleIds }
   *   root    代码根目录（空 = settings.projectDir）
   *   modules 按模块/项目筛（可选）
   *   ids     按单条记录筛（可选，记录 id 数组）
   *   ruleIds 只跑这些覆盖取数规则（缺省 = 全部，行为与 v0.41.2 一致）
   *
   * 范围语义（v0.46.0，两种粒度）：
   *   · 都不给        → 全量（老行为，一个字节都没变）
   *   · 只给 modules  → 只对比这些模块/项目（v0.41.3 的行为）
   *   · 只给 ids      → 只对比这几条记录
   *   · 两个都给      → **并集**（选中的模块 ∪ 选中的单条记录）
   *
   * 为什么两个都给时取并集、而不是「ids 说了算、modules 丢掉」：
   *   前端是一个多选框，两个分组（按模块 / 按记录）共用一个值数组，
   *   用户勾了「订单」再勾一条「认证」下的接口，他表达的是「我选的这些都要」；
   *   这时把模块丢掉，用户会看到自己刚选的模块悄悄失效（结果里没有订单的接口）。
   *   并集同时满足「ids 不会被模块挡住」——某条 id 即使在未选中的模块里也照样参与对比。
   *   返回里的 scopeMode 会写明这次实际走的是哪种（all / modules / ids / mixed）。
   *
   * 边界：ids 里有不存在的 id、重复 id、null/空串 —— 一律只是「匹配不到」，
   *       不抛错、不返回 ok:false（脏参数不该让整页红）。
   */
  handle('codescan:coverage', async (e, { root, kind, modules, ids, ruleIds } = {}) => {
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
     * ids：再细一档，直接点名几条记录（回归时只盯自己改的那两个接口）。
     */
    const k = kind === 'page' ? 'page' : 'api';
    let items = k === 'page' ? store.list('pages') : store.list('apis');

    const mods = (Array.isArray(modules) ? modules : []).map((m) => String(m)).filter(Boolean);
    const idList = (Array.isArray(ids) ? ids : [])
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x).trim())
      .filter(Boolean);
    const scopeMode = idList.length && mods.length ? 'mixed' : idList.length ? 'ids' : mods.length ? 'modules' : 'all';

    if (scopeMode !== 'all') {
      const modSet = new Set(mods);
      const idSet = new Set(idList);
      items = items.filter((it) => {
        // 点名的记录优先命中（不受模块限制）——这就是「ids 不会被模块拦住」
        if (idSet.has(String(it.id))) return true;
        const d = it.data || {};
        const m = String(k === 'page' ? d.project || '' : d.module || '');
        return modSet.has(m);
      });
    }

    const res = codescan.buildCoverage(items, dir, k, { ruleIds });
    // 顺带把「本次参与对比的清单条数」和「范围是怎么筛的」也带上，方便前端说明
    return Object.assign({}, res, {
      filtered: scopeMode !== 'all',
      scopeMode,
      scopeCount: items.length
    });
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