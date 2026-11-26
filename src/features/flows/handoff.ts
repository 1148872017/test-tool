/**
 * 「流程模板」→「代码生成」的一次性交接（v0.63）。
 *
 * 场景：用户在「流程模板」里编辑一条流程，只能改名字 / 备注，
 * 想调步骤得自己去「代码生成」页再手动从「载入流程」下拉里找回来。
 * 这里加一个跳转按钮：点一下带着流程 id 跳过去，到那边**自动载入**。
 *
 * 为什么用进程内交接槽而不是塞进 route：
 *   和 features/allure/handoff.ts、features/jmx/handoff.ts 同一个理由 ——
 *   跳转只是换 route.type，为了一次跳转往 route 里加字段会让以后每个互跳都要加。
 *   槽里的值只生效一次，刷新即失效（本来也只需要一次）。
 *
 * 注意：只在渲染进程内存里，不过 IPC、不落盘。
 */

export type FlowHandoff = {
  /** flows 集合里那条记录的 id */
  id: string;
  /** ui = UI 积木流程；api = 接口积木流程（决定跳到哪个视图） */
  kind: 'ui' | 'api';
  /** 来源提示（只有文案用途） */
  name?: string;
};

let pending: FlowHandoff | null = null;

/** 跳转前写入 */
export function setFlowHandoff(value: FlowHandoff | null): void {
  pending = value && value.id ? value : null;
}

/** 目标页挂载时取走并清空（只生效一次） */
export function takeFlowHandoff(): FlowHandoff | null {
  const value = pending;
  pending = null;
  return value;
}
