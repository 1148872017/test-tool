/**
 * 代码调试 → 「测试执行」账本的草稿逻辑（纯函数，不碰 React / window）。
 *
 * 为什么单独一个模块：
 *   CodeRunnerPage 已经 900 多行，把「从运行结果里读出退出码/耗时/失败数」塞进
 *   组件里，就只能靠肉眼验；这里的三个函数都是「输入一段文本 → 输出一个值」，
 *   以后要加单测直接 require 就行。
 *
 * 口径（重要，别在这里造假数据）：
 *   - 退出码 / 耗时：来自 runner:exit 的真实字段，一定有；
 *   - 通过数 / 失败数：**只有**能从控制台输出里认出 Maven Surefire 或 pytest 的
 *     汇总行时才填；认不出来就留空，让用户自己填 —— 不按「退出码 0 = 1 通过」
 *     硬凑两个数字，那种「看起来有统计」比空着更误导。
 *   - 类型（api / ui）：按代码和输出里的迹象猜一个（playwright / selenium …），
 *     只是**预填**，弹窗里能改。
 */

/** 一次跑批的用例统计 */
export type RunSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

/** 账本草稿（弹窗里可编辑的字段） */
export type LedgerDraft = {
  name: string;
  kind: string;
  result: string;
  env: string;
  passCount: number | null;
  failCount: number | null;
  conclusion: string;
};

/** Maven Surefire / Failsafe 的汇总行 */
const RE_MAVEN_SUMMARY = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g;

/** pytest 汇总行里的计数片段（1 failed, 2 passed in 0.50s） */
const RE_PY_COUNT = /(\d+)\s+(passed|failed|errors?|skipped)/gi;

/** UI 测试的迹象（只用于预填类型，不是判定） */
const RE_UI_HINT = /(playwright|selenium|webdriver|puppeteer|page\.(?:goto|locator|click|fill)|locator\(|browser\.)/i;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 毫秒 → 人类可读 */
function fmtDuration(ms: number): string {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return n + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
}

/** 「11-25 15:40」 */
function stamp(d: Date): string {
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * 从控制台输出里认出「跑了多少、过了多少、挂了多少」。
 *
 * @param text 控制台全文（调用方给环形缓冲的快照）
 * @returns null = 认不出来（宁可返回 null，也不返回一串 0 假装有统计）
 */
export function parseTestSummary(text: string): RunSummary | null {
  const t = String(text || '');
  if (!t) return null;

  // ---- Maven：取**最后一条**汇总行（多模块会打印多次，最后一条是全局结论）----
  RE_MAVEN_SUMMARY.lastIndex = 0;
  let m: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((m = RE_MAVEN_SUMMARY.exec(t)) !== null) {
    last = m;
    if (RE_MAVEN_SUMMARY.lastIndex === m.index) RE_MAVEN_SUMMARY.lastIndex += 1; // 防零宽死循环
  }
  if (last) {
    const total = Number(last[1]) || 0;
    const failures = Number(last[2]) || 0;
    const errors = Number(last[3]) || 0;
    const skipped = Number(last[4]) || 0;
    const failed = failures + errors;
    return { total, passed: Math.max(0, total - failed - skipped), failed, skipped };
  }

  // ---- pytest：找带计数的汇总行，取最后一条 ----
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!/(passed|failed|error|skipped)/i.test(line)) continue;
    const counts: Record<string, number> = {};
    RE_PY_COUNT.lastIndex = 0;
    let c: RegExpExecArray | null = null;
    while ((c = RE_PY_COUNT.exec(line)) !== null) {
      const key = c[2].toLowerCase().replace(/s$/, ''); // errors → error
      counts[key] = (counts[key] || 0) + (Number(c[1]) || 0);
    }
    const passed = counts.passed || 0;
    const failed = (counts.failed || 0) + (counts.error || 0);
    const skipped = counts.skipped || 0;
    const total = passed + failed + skipped;
    if (total > 0) return { total, passed, failed, skipped };
  }

  return null;
}

/**
 * 猜这次跑的是接口还是 UI（**只是预填**，界面上可改）。
 *
 * 依据：代码或输出里出现 playwright / selenium / webdriver / page.xxx / locator( …
 * 有就是 UI，没有就当接口（跑接口断言/脚本的是大多数）。
 */
export function guessKind(input: { runnerLabel?: string; code?: string; output?: string }): string {
  const text = [input.runnerLabel, input.code, (input.output || '').slice(-20000)].filter(Boolean).join('\n');
  return RE_UI_HINT.test(text) ? 'ui' : 'api';
}

/**
 * 拼一条「测试执行」记录的数据草稿。
 *
 * @param input.runnerLabel 运行器显示名（Groovy / Python / Maven…）
 * @param input.code 编辑器里的代码（猜类型用；Maven 模式传空）
 * @param input.output 控制台全文（认用例统计用）
 * @param input.result runner:exit 的事件体（code / duration / timedOut / canceled / phase）
 * @param input.env 环境，缺省 test
 * @param input.now 当前时间（测试可注入）
 */
export function buildLedgerDraft(input: {
  runnerLabel: string;
  code?: string;
  output?: string;
  result: any;
  env?: string;
  now?: Date;
}): LedgerDraft {
  const r = input.result || {};
  const summary = parseTestSummary(input.output || '');
  const code = r.code === null || r.code === undefined ? null : Number(r.code);
  const duration = Number(r.duration) || 0;

  // 结果：超时 / 非 0 退出码 = bad；0 = ok；取消/无退出码 = 未判定
  let result = 'unknown';
  if (r.canceled) result = 'unknown';
  else if (r.timedOut) result = 'bad';
  else if (code !== null && code !== 0) result = 'bad';
  else if (code === 0) result = 'ok';

  // 结论：runs 里 api / ui 没有「耗时」字段（duration 只给压测），
  // 所以退出码和耗时写进结论 —— 不新造字段，也不让信息丢掉。
  const parts: string[] = [];
  parts.push(input.runnerLabel ? '运行器 ' + input.runnerLabel : '代码调试');
  parts.push(code === null ? '退出码 —' : '退出码 ' + code);
  parts.push('耗时 ' + fmtDuration(duration));
  if (r.timedOut) parts.push('超时终止');
  if (r.canceled) parts.push('手动取消');
  if (r.phase === 'compile') parts.push('编译阶段');
  if (summary) parts.push('用例 ' + summary.total + '（通过 ' + summary.passed + ' / 失败 ' + summary.failed + '）');
  else parts.push('输出里没认出用例统计（通过/失败数留空，可手填）');

  const label = input.runnerLabel || '代码调试';
  return {
    name: label + ' · ' + stamp(input.now || new Date()),
    kind: guessKind({ runnerLabel: input.runnerLabel, code: input.code, output: input.output }),
    result,
    env: input.env || 'test',
    passCount: summary ? summary.passed : null,
    failCount: summary ? summary.failed : null,
    conclusion: parts.join(' · ')
  };
}