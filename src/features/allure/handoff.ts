/**
 * 「测试执行」→「报告分析」的一次性目录交接。
 *
 * 为什么用模块级变量而不是把参数塞进 App.tsx 的 route：
 *   和 v0.45 的 features/jmx/handoff.ts 是同一个理由 —— 两个页面都是
 *   「按 route.type 条件渲染」的兄弟页面，跳转只需要换 route。
 *   为了一次跳转把 dir 挂到路由上，等于以后每个互跳都要在 route 里加字段
 *   （openId / openCase / logFor 已经三个了）。
 *   这里用一个进程内交接槽：跳转前 set、目标页挂载时 take 并清空，
 *   不污染路由、刷新即失效（本来也只需要生效一次）。
 *
 * 方向说明：
 *   测试执行 --(点「关联报告」图标)--> 报告分析：把 reportDir 带过去自动解析
 *   报告分析 --(归档成功)--> 测试执行：不需要交接槽，直接切 route 就行，
 *   但用户可能马上又想回报告页，所以两边的导航都用同一种 route 切换。
 *
 * 注意：只在渲染进程内存里，不过 IPC、不落盘，页面关闭即丢。
 */

import { useEffect } from 'react';

export type AllureHandoff = {
  /** 要打开并自动解析的 allure-results 目录 */
  dir: string;
  /** 来源提示：从哪条执行记录跳过来的（只有文案用途） */
  from?: string;
};

/** 待交接的目录；null = 没有（用户是正常点菜单进来的） */
let pending: AllureHandoff | null = null;

/** 跳转前写入 */
export function setAllureHandoff(value: AllureHandoff | null): void {
  pending = value && value.dir ? value : null;
}

/** 目标页挂载时取出并清空 —— 只能消费一次，避免来回切页面时反复覆盖用户选的目录 */
export function takeAllureHandoff(): AllureHandoff | null {
  const value = pending;
  pending = null;
  return value;
}

/**
 * 目标页的「挂载即消费」钩子：报告分析页写一行就够了。
 *
 *   useAllureHandoff((dir) => { setDir(dir); doParse(dir); });
 *
 * 依赖故意留空 —— 交接只发生在跳转那一刻，之后用户在页面里换目录
 * 不该被这个钩子覆盖回去。
 */
export function useAllureHandoff(onDir: (dir: string, from?: string) => void): void {
  useEffect(() => {
    const h = takeAllureHandoff();
    if (h && h.dir) onDir(h.dir, h.from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}