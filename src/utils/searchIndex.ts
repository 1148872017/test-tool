/**
 * 搜索 hay 索引：**扫描/加载时算一次，按键时只做 indexOf**。
 *
 * 为什么要单独一层（而不是留在页面里）：
 *   改造前 CasePage / CollectionPage 的过滤是「每敲一个键 → 遍历全量语料 → join + toLowerCase」。
 *   用例目录几千条（每条还有前置/操作/预期/断言/备注串起来上百字），记录也有几千条，
 *   于是一次按键要重新拼装几 MB 字符串再整体小写 —— 输入框会明显发涩，
 *   搜中文时尤其糟（toLowerCase 仍然要扫过整个长串）。
 *
 * 现在的分工：
 *   数据一变（扫描 / loadAll）→ buildHay 拼一次、toLowerCase 一次；
 *   每次按键                → normalizeKeyword（1 次 trim + 小写）+ indexOf（引擎内建，零分配）。
 *   再配合页面的 useDeferredValue：输入框先跟手，筛选结果稍后跟上。
 *
 * **约定（重要）**：hay 只是派生索引，**不得进入任何 payload / 导出**。
 *   两种安全的落点，本仓都用到了：
 *     · 挂在页面自己造的包装对象上（CasePage 的 { item, file, _hay }）——包装对象只喂给 Table 的 dataSource；
 *     · 放进 Map（CollectionPage 的 id → hay）——record 对象本身一个字段都不加，
 *       所以它进 RecordDetail / 表单 payload / exportData 时不可能带着 hay。
 *   千万不要图省事往 record 上写 r._hay：RecordForm 保存时会把 record 当 payload 带走。
 *
 * 本文件是纯函数（不 import React / 不碰 window / api），便于单测。
 */

/** 索引字段名：包装对象上用这个名字，方便 grep 和 review */
export const HAY_FIELD = '_hay';

/** 关键词规范化：trim + 小写。空串表示「不筛选」 */
export function normalizeKeyword(raw: any): string {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * 拼一条 hay。
 *
 * 跳过 null / undefined / false / 空串（否则会拼出 "null undefined 标题" 这种假命中），
 * 最后**只小写一次** —— 这是性能的关键：以前每个字段都在拼完的大串上再扫一遍。
 */
export function buildHay(parts: any[]): string {
  const list: string[] = [];
  const src = Array.isArray(parts) ? parts : [];
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    if (p === null || p === undefined || p === false || p === '') continue;
    list.push(typeof p === 'string' ? p : String(p));
  }
  return list.join(' ').toLowerCase();
}

/**
 * 匹配：只做一次 indexOf。
 * `kw` 必须是 normalizeKeyword 的结果（已经是小写）；空串直接放行。
 */
export function matchHay(hay: any, kw: string): boolean {
  if (!kw) return true;
  return typeof hay === 'string' && hay.indexOf(kw) >= 0;
}

/**
 * 把 [{ depth, text }] 这类结构拍平成一段文本。
 * 用例的前置 / 操作 / 预期 / 检查项 / 备注都是这个形状（检查项还带 done）。
 */
export function textOfNodes(list: any): string {
  if (!Array.isArray(list)) return '';
  const out: string[] = [];
  for (const x of list) {
    const t = x && typeof x === 'object' ? x.text : x;
    if (t === null || t === undefined || t === '') continue;
    out.push(String(t));
  }
  return out.join(' ');
}

/**
 * 用例（CasePage）的 hay。
 *
 * 字段清单和改造前页面里那段内联数组**一一对应**（顺序无关）：
 * 标题 / 模块 / 分支 / 编号 / 文件名 / 覆盖规则 / 前置 / 操作 / 预期 / 检查项 / 备注 / 断言迹 / 链路说明。
 * 少一个字段就等于「搜不到了」，加字段时两边要一起改。
 */
export function caseHay(item: any, file: any): string {
  const c = item || {};
  const f = file || {};
  const covers = Array.isArray(c.covers) ? c.covers.join(' ') : '';
  const assertions = Array.isArray(c.assertions)
    ? c.assertions.map((a: any) => (a ? String(a.dim || '') + ' ' + String(a.text || '') : '')).join(' ')
    : '';
  return buildHay([
    c.title,
    c.module,
    c.branch,
    c.id,
    f.name,
    covers,
    textOfNodes(c.pre),
    textOfNodes(c.steps),
    textOfNodes(c.expects),
    textOfNodes(c.checklist),
    textOfNodes(c.notes),
    assertions,
    Array.isArray(c.chainMeta) ? c.chainMeta.join(' ') : ''
  ]);
}

/**
 * 压测脚本（JmxPage）的 hay：文件名 / 测试计划名 / JMeter 版本 / 线程组名 /
 * 采样器的名称+路径 / CSV 文件名 / 脚本里的 ${...} 占位符。
 *
 * 和改造前 JmxPage 里那段内联数组一一对应；加字段时两边一起改。
 */
export function jmxHay(file: any): string {
  const f = file || {};
  const groups = Array.isArray(f.threadGroups) ? f.threadGroups : [];
  const samplers = Array.isArray(f.samplers) ? f.samplers : [];
  const csvs = Array.isArray(f.csvs) ? f.csvs : [];
  return buildHay([
    f.file,
    f.testPlanName,
    f.jmeterVersion,
    groups.map((t: any) => (t ? t.name : '')).join(' '),
    samplers.map((s: any) => (s ? String(s.name || '') + ' ' + String(s.path || '') : '')).join(' '),
    csvs.map((c: any) => (c ? c.filename : '')).join(' '),
    Array.isArray(f.placeholders) ? f.placeholders.join(' ') : ''
  ]);
}

/**
 * 记录（CollectionPage）的 hay：标题 + 标签 + 已经脱敏的 data 文本。
 *
 * data 那段**必须**走 CollectionPage 的 searchableText()（排除密码字段），
 * 这里只负责拼装，不负责脱敏 —— 脱敏逻辑留在页面里是因为有回归测试盯着它，
 * 挪走等于把它从防线里摘出去。
 */
export function recordHay(record: any, dataText: string): string {
  const r = record || {};
  const tags = Array.isArray(r.tags) ? r.tags.join(',') : '';
  return buildHay([r.title || '', tags, dataText]);
}

/**
 * 一次建好 Map<key, hay>（扫描 / 加载后调用一次）。
 *
 * 用 Map 而不是把 `_hay` 挂到行对象上：CollectionPage 的记录对象会被
 * RecordDetail / RecordForm / 导出复用，多一个字段就有混进 payload 的风险。
 */
export function buildHayIndex<T>(rows: T[], keyOf: (row: T) => string, hayOf: (row: T) => string): Map<string, string> {
  const index = new Map<string, string>();
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const key = String(keyOf(row));
    if (!key) continue;
    index.set(key, hayOf(row) || '');
  }
  return index;
}

/**
 * 取 hay：没算过（新数据 / key 变了）返回空串。
 *
 * 为什么返回空串而不是 undefined：matchHay 对空串只命中「无关键词」，
 * 所以新数据在索引补齐前会自然地「不参与搜索」，而不是意外全部命中。
 */
export function readHay(index: Map<string, string> | null, key: any): string {
  if (!index) return '';
  const hit = index.get(String(key));
  return typeof hit === 'string' ? hit : '';
}