/**
 * 关联用例的「灰字候选」：从接口的名称 / 模块 / 描述 / URL 里抽关键词，
 * 拿去和用例的标题 / 模块 / 分支做包含匹配，给几个可能相关的用例。
 *
 * 三条原则（别破坏）：
 * 1. 只给候选，不自动关联 —— 点了才算数，保存前都能反悔；
 * 2. 拿不准就不给 —— 分数不到阈值宁可空着，也别塞一堆无关的让人逐个划掉；
 * 3. 自己会说话 —— 每条候选都说清「命中了什么词」，不信就一眼看得出为什么。
 *
 * 纯函数，不碰 api/dom，方便在 node 里直接测。
 */

/** 这些词出现频率太高，拿来匹配就是纯噪音 */
const STOP = new Set([
  '接口',
  '功能',
  '测试',
  '用例',
  '列表',
  '详情',
  '数据',
  '信息',
  '操作',
  '默认',
  '未分组',
  '其他',
  '成功',
  '异常',
  '参数',
  '返回'
]);

/** 候选门槛：一次「名称整句命中」= 10 分，模块命中标题 = 6 分，URL 段命中标题 = 4 分 */
const MIN_SCORE = 4;
const DEFAULT_LIMIT = 5;
const MAX_KEYWORDS = 24;

/**
 * 抽关键词，带权重。
 * 权重决定「命中标题」时加多少分：名称(5) > 名称拆出来的词(4) > 模块(3) > 描述/URL(2)。
 * @returns {{kw: string, w: number}[]}
 */
function keywordsOf(data) {
  const out = new Map();
  const add = (raw, w) => {
    const kw = String(raw === undefined || raw === null ? '' : raw).trim();
    if (kw.length < 2 || kw.length > 24) return;
    if (STOP.has(kw)) return;
    if (!out.has(kw) || out.get(kw) < w) out.set(kw, w);
  };

  const d = data || {};

  // 模块（Apifox 的目录名）往往就是用例里的「模块」一级，权重不低
  const mod = String(d.module || '').trim();
  if (mod) add(mod, 3);

  // 接口名：整句最有区分度，再按分隔符拆一遍
  const name = String(d.name || '').trim();
  if (name) {
    add(name, 5);
    for (const part of name.split(/[\s,，、/|·\-—()（）[\]【】:：]+/)) add(part, 4);
  }

  // 描述：只取第一行前 80 字，按标点切
  const summary = String(d.summary || '')
    .split('\n')[0]
    .slice(0, 80);
  if (summary) {
    for (const part of summary.split(/[\s,，。、；;/|·\-—()（）[\]【】:：]+/)) add(part, 2);
  }

  // URL 路径段：英文的（refund / order）能匹配英文标题，中文路径也能用
  const path = String(d.url || '').replace(/^https?:\/\/[^/]+/i, '');
  for (const seg of path.split('/')) {
    const s = seg.replace(/[{}]/g, '').trim();
    if (!s || /^v\d+$/i.test(s) || s === 'api') continue;
    add(s, 2);
    for (const part of s.split(/[-_.]/)) add(part.toLowerCase(), 2);
  }

  const list = Array.from(out.entries()).map(([kw, w]) => ({ kw, w }));
  // 长的优先留下（区分度更高），防止小词把长词挤掉
  list.sort((a, b) => b.w - a.w || b.kw.length - a.kw.length || (a.kw < b.kw ? -1 : 1));
  return list.slice(0, MAX_KEYWORDS);
}

function scoreOf(keywords, c) {
  const title = String(c.title || '');
  const mod = String(c.module || '');
  const branch = String(c.branch || '');
  let score = 0;
  const hits = [];
  for (const { kw, w } of keywords) {
    let s = 0;
    if (title.indexOf(kw) >= 0) s = w * 2; // 标题命中算两倍
    else if (mod.indexOf(kw) >= 0) s = w;
    else if (branch.indexOf(kw) >= 0) s = w;
    if (s) {
      score += s;
      hits.push(kw);
    }
  }
  return { score, hits };
}

/**
 * @param {object} api   接口记录 data（name / module / summary / url）
 * @param {Array}  cases 用例列表：[{ key, filePath, title, module, branch }]
 * @param {{ exclude?: string[], limit?: number }} opts
 * @returns {{ key, filePath, title, module, score, hits }[]} 按分数从高到低
 */
function suggestCases(api, cases, opts) {
  const options = opts || {};
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Math.max(0, Number(options.limit) || 0);
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  if (!limit || !Array.isArray(cases) || !cases.length) return [];

  const keywords = keywordsOf(api);
  if (!keywords.length) return [];

  const scored = [];
  for (const c of cases) {
    if (!c || !c.title) continue;
    if (exclude.has(c.key)) continue;
    const { score, hits } = scoreOf(keywords, c);
    if (score < MIN_SCORE) continue;
    scored.push({ key: c.key, filePath: c.filePath || '', title: c.title, module: c.module || '', score, hits: hits.slice(0, 3) });
  }

  scored.sort((a, b) => b.score - a.score || b.hits.length - a.hits.length || (a.title < b.title ? -1 : 1));
  return scored.slice(0, limit);
}

module.exports = { keywordsOf, suggestCases, MIN_SCORE, DEFAULT_LIMIT, STOP };