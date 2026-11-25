/**
 * 积木面板的纯函数小工具（无 React、无 antd）。
 *
 * 放在这里而不是塞进 BricksPanel.tsx：
 * 摘要文本、默认参数、元素快照这些逻辑要能被测试直接跑，不用起组件。
 */
import { actionById } from '../../../shared/uiActions';

/** 一条已选步骤（前端态）：比生成器入参多一个列表 key */
export type BricksStep = {
  key: string;
  actionId: string;
  params: Record<string, any>;
  /** 选元素时快照下来的定位方式 / 定位值（pomMode = none 时直接用它出定位器） */
  elementMode?: string;
  elementSelector?: string;
};

/** 新步骤的默认参数：有 default 用 default，boolean 默认 false，其余空串 */
export function stepDefaults(action: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of (action && action.params) || []) {
    if (p.default !== undefined) out[p.key] = p.default;
    else if (p.type === 'boolean') out[p.key] = false;
    else out[p.key] = '';
  }
  return out;
}

/** 一行摘要：动作名 + 已填的参数值（步骤列表里显示） */
export function summarizeStep(step: BricksStep): string {
  const action = actionById(step.actionId);
  if (!action) return '未知动作：' + step.actionId;
  const parts: string[] = [];
  for (const p of action.params || []) {
    const v = step.params ? step.params[p.key] : undefined;
    if (v === undefined || v === null || String(v).trim() === '') continue;
    parts.push(p.type === 'element' ? String(v) : p.label + '=' + String(v));
  }
  return parts.length ? action.name + ' · ' + parts.join(' · ') : action.name;
}

/**
 * 前端步骤 → 生成器入参。
 *
 * 元素定位值优先用「当前页面元素」的最新值：用户可能刚在页面元素表里改了定位方式，
 * 步骤里存的快照会过期，生成出旧定位器。
 */
export function toGeneratorSteps(steps: BricksStep[], elements: any[]): any[] {
  const list = Array.isArray(elements) ? elements : [];
  return (steps || []).map((s) => {
    const name = String((s.params && s.params.el) || '').trim();
    const hit = name ? list.find((e) => e && String(e.name || '').trim() === name) : null;
    return {
      actionId: s.actionId,
      params: Object.assign({}, s.params),
      elementMode: hit ? hit.mode || 'css' : s.elementMode,
      elementSelector: hit ? hit.selector : s.elementSelector
    };
  });
}

/** 元素下拉选项：只列填了名字的行，标签带上定位方式 */
export function elementOptions(elements: any[]): { value: string; label: string }[] {
  return (elements || [])
    .filter((e) => e && String(e.name || '').trim())
    .map((e) => {
      const name = String(e.name).trim();
      return { value: name, label: name + ' · ' + String(e.mode || 'css') };
    });
}

/** POM 模式的展示文案（生成器只认 none / generated / existing 三个值） */
export const POM_MODE_OPTIONS = [
  { value: 'none', label: '不使用' },
  { value: 'generated', label: '用本页生成的' },
  { value: 'existing', label: '用已有类' }
];