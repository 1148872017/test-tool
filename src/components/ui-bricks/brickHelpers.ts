/**
 * 积木面板的纯函数小工具（无 React、无 antd）。
 *
 * 放在这里而不是塞进 BricksPanel.tsx：
 * 摘要文本、默认参数、元素快照这些逻辑要能被测试直接跑，不用起组件。
 */
import { actionById } from '../../../shared/uiActions';
import { LOCATOR_MODES, normalizeLocatorMode } from '../../../shared/locatorModes';

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

/**
 * POM 模式的展示文案（生成器只认 none / generated / existing 三个值）
 *
 * v0.63 改口径：
 *   · 第三项「用已有类」→ **「选择已有类」**：它下面紧跟着一个类名输入框 + 「选文件」，
 *     叫「选择」才和实际交互对得上；
 *   · 第一项保留「不使用」，但配 tooltip 说明它到底意味着什么
 *     （定位器内联写在方法体里，不是「什么都不生成」）。
 */
export const POM_MODE_OPTIONS = [
  { value: 'none', label: '不使用' },
  { value: 'generated', label: '用本页生成的' },
  { value: 'existing', label: '选择已有类' }
];

/** 三种模式的解释（挂在单选组标题的 tooltip / 说明行上，别让用户猜） */
export const POM_MODE_HINTS: Record<string, string> = {
  none: '不使用页面对象：定位器直接写在方法体里（page.locator(...)），适合一两步的小流程',
  generated: '用本页生成的：先生成页面对象类，方法体里调用 loginPage.usernameInput()',
  existing: '选择已有类：你项目里已经写好的页面对象类，选文件或填类名，方法体里直接用它'
};

/* ============================================================
 * 「N 个元素」的 hover 提示
 * ============================================================ */

/**
 * 定位方式的中文短名：CSS / XPath / Role / Label / …
 *
 * 模式清单只有一份 —— shared/locatorModes.js 的 LOCATOR_MODES，这里**不复制那个数组**，
 * 只补 4 个按单词拆 / 按缩写写的特殊情况，其余按「首字母大写」推出来。
 * 好处：v0.45 的定位方式以后再加一种，这里不用跟改，也不会出现两处漂移
 * （之前「定位方式」下拉就因为写了两份映射而不同步过）。
 */
const MODE_SHORT_OVERRIDE: Record<string, string> = {
  css: 'CSS',
  xpath: 'XPath',
  alttext: 'AltText',
  testid: 'TestId'
};

/** 单个定位方式的短名：脏值走 normalizeLocatorMode 兜底成 CSS */
export function locatorModeShort(mode: any): string {
  const m = normalizeLocatorMode(mode);
  return MODE_SHORT_OVERRIDE[m] || m.charAt(0).toUpperCase() + m.slice(1);
}

/**
 * 全部定位方式的中文短名（顺序就是 LOCATOR_MODES 的顺序）。
 * tooltip / 自检都用它 —— 模式清单永远只有 LOCATOR_MODES 一份。
 */
export function locatorModeShorts(): { mode: string; short: string }[] {
  return LOCATOR_MODES.map((m) => ({ mode: m, short: locatorModeShort(m) }));
}

/** tooltip 最多列几个元素，超出的折叠成「…还有 N 个」（页面上十几个元素就够长了） */
export const ELEMENTS_TIP_LIMIT = 15;

/**
 * 「N 个元素」tooltip 的内容：每行一个元素，格式 `名称 · 定位方式`。
 *
 * 只认填了名字的行（和积木区 / 生成器同一口径，空行给了也只是噪音）。
 * 超过 limit 个时最后加一行「…还有 N 个」，否则 hover 一片糊屏。
 */
export function elementsTipLines(elements: any[], limit: number = ELEMENTS_TIP_LIMIT): string[] {
  const list = (elements || []).filter((e) => e && String(e.name || '').trim());
  const max = Math.max(1, Math.floor(Number(limit)) || ELEMENTS_TIP_LIMIT);
  const lines = list
    .slice(0, max)
    .map((e) => String(e.name).trim() + ' · ' + locatorModeShort(e.mode));
  if (list.length > max) lines.push('…还有 ' + (list.length - max) + ' 个');
  return lines;
}

/* ============================================================
 * 流程模板（flows 集合）的读写
 * ============================================================ */

/** POM 模式（和生成器 / 单选框共用同一组值） */
export type PomMode = 'none' | 'generated' | 'existing';

/** 脏值兜底成「不使用」：流程记录可能是手改过 / 老版本写的 */
export function normalizePomMode(value: any): PomMode {
  const v = String(value === undefined || value === null ? '' : value).trim();
  return POM_MODE_OPTIONS.some((o) => o.value === v) ? (v as PomMode) : 'none';
}

/** flows 记录的 data 形状（和 shared/collections.js 的 flows 字段一一对应） */
export type FlowRecordData = {
  name: string;
  pageId: string;
  pageName: string;
  /** 结构化步骤，存 JSON 字符串 */
  steps: string;
  pomMode: string;
  pomClass: string;
  pomVar: string;
  note: string;
};

/** 保存流程时的默认名称：登录页 → 登录页流程-1125（月日，方便同一天存多条） */
export function defaultFlowName(pageName: string, date?: Date): string {
  const d = date instanceof Date ? date : new Date();
  const base = String(pageName || '').trim() || '未命名页面';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return base + '流程-' + mm + dd;
}

/**
 * 当前拼装状态 → 一条 flows 记录的 data。
 *
 * steps 里**不存列表 key**：key 只是前端 React 列表的身份证，存下来会让
 * 「载入两次」出现重复 key；载入时重新发号（见 parseFlowSteps）。
 */
export function flowRecordData(o: {
  name: string;
  note?: string;
  pageId?: string;
  pageName?: string;
  steps?: BricksStep[];
  pomMode?: any;
  pomClass?: string;
  pomVar?: string;
}): FlowRecordData {
  const steps = (o.steps || []).map((s) => ({
    actionId: s.actionId,
    params: Object.assign({}, s.params || {}),
    elementMode: s.elementMode,
    elementSelector: s.elementSelector
  }));
  return {
    name: String(o.name || '').trim(),
    pageId: String(o.pageId || ''),
    pageName: String(o.pageName || ''),
    steps: JSON.stringify(steps),
    pomMode: normalizePomMode(o.pomMode),
    pomClass: String(o.pomClass || ''),
    pomVar: String(o.pomVar || ''),
    note: String(o.note || '')
  };
}

/**
 * flows 记录的 steps → 面板步骤。
 *
 * JSON 坏了 / 动作已删除 → 直接跳过那一条，绝不抛异常（否则整个面板白屏）。
 */
export function parseFlowSteps(raw: any): BricksStep[] {
  let list: any = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: BricksStep[] = [];
  for (const item of list) {
    const actionId = String((item && item.actionId) || '').trim();
    if (!actionId || !actionById(actionId)) continue;
    out.push({
      // 载入时重新发号：同一份流程载入两次也不会撞 key
      key: 'f' + out.length + '_' + actionId,
      actionId,
      params: Object.assign({}, (item && item.params) || {}),
      elementMode: item && item.elementMode,
      elementSelector: item && item.elementSelector
    });
  }
  return out;
}

/** flows 记录的 POM 配置（缺字段时给能直接用的默认值） */
export function flowPom(data: any): { pomMode: PomMode; pomClass: string; pomVar: string } {
  const d = data || {};
  return {
    pomMode: normalizePomMode(d.pomMode),
    pomClass: String(d.pomClass || ''),
    pomVar: String(d.pomVar || '')
  };
}