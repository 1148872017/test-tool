/**
 * 接口积木面板的纯函数小工具（无 React、无 antd）。
 *
 * 放在这里而不是塞进 ApiBricksPanel.tsx：
 * 摘要文本、默认参数、变量表、flows 记录读写这些逻辑要能被测试直接跑，不用起组件。
 */
import { actionById, isIdentifier } from '../../../shared/apiActions';

/** 一条已选步骤（前端态）：比生成器入参多一个列表 key */
export type ApiBricksStep = {
  key: string;
  actionId: string;
  /** call 步骤里除了 apiId/as，还带接口快照：apiName/method/path/headers/body */
  params: Record<string, any>;
};

/** 一个「前面步骤已产生」的变量（供「从哪个响应」下拉 / 插入变量用） */
export type FlowVar = {
  name: string;
  /** 第几步产生的（1 开始） */
  fromStep: number;
  /** response = 调用接口拿到的响应；value = 提取 / 设置的普通变量 */
  type: string;
  /** 人看的补充说明：`POST /api/login` 或动作名 */
  detail: string;
};

/** 新步骤的默认参数：有 default 用 default，其余空串 */
export function stepDefaults(action: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of (action && action.params) || []) {
    if (p.default !== undefined) out[p.key] = p.default;
    else out[p.key] = '';
  }
  return out;
}

/** 一行摘要（步骤列表里显示）：接口步骤要一眼看出「哪个接口、存成什么」 */
export function summarizeStep(step: ApiBricksStep): string {
  const action = actionById(step.actionId);
  if (!action) return '未知动作：' + step.actionId;
  const p = (step && step.params) || {};
  const text = (v: any) => String(v === undefined || v === null ? '' : v).trim();

  switch (step.actionId) {
    case 'call': {
      const method = text(p.method).toUpperCase();
      const path = text(p.path);
      const as = text(p.as);
      if (!path) return '调用接口 · 还没选接口';
      return method + ' ' + path + (as ? ' → ' + as : '');
    }
    case 'extract-json':
      return '提取 · ' + (text(p.path) || 'JSONPath?') + (text(p.as) ? ' → ' + text(p.as) : '');
    case 'extract-regex':
      return '提取（正则）' + (text(p.as) ? ' → ' + text(p.as) : '');
    case 'assert-status':
      return '断言状态码 · ' + (text(p.code) || '?');
    case 'assert-json':
      return '断言 · ' + (text(p.path) || 'JSONPath?') + ' == ' + (text(p.value) || '?');
    case 'assert-time':
      return '断言响应时间 · ' + (text(p.ms) || '?') + 'ms';
    case 'set-var':
      return '设置变量 · ' + (text(p.name) || '?');
    default:
      return action.name;
  }
}

/** 前端步骤 → 生成器入参（去掉列表 key，只留动作 + 参数） */
export function toGeneratorSteps(steps: ApiBricksStep[]): any[] {
  return (steps || []).map((s) => ({
    actionId: s.actionId,
    params: Object.assign({}, s.params || {})
  }));
}

/**
 * 前 N 步已经产生了哪些变量（默认全部）。
 *
 * 「从哪个响应」下拉 / 「插入变量」都只认这个函数的结果 —— 保证 UI 里能选的，
 * 正好是生成器认的（生成器遇到未定义变量会警告，UI 干脆不给选）。
 */
export function collectVariables(steps: ApiBricksStep[], upto?: number): FlowVar[] {
  const list = steps || [];
  const limit = upto === undefined ? list.length : Math.max(0, Math.min(upto, list.length));
  const out: FlowVar[] = [];
  for (let i = 0; i < limit; i++) {
    const step = list[i];
    if (!step) continue;
    const p = step.params || {};
    const name = (v: any) => String(v === undefined || v === null ? '' : v).trim();
    if (step.actionId === 'call') {
      const n = name(p.as);
      if (n) {
        const detail = [name(p.method).toUpperCase(), name(p.path)].filter(Boolean).join(' ');
        out.push({ name: n, fromStep: i + 1, type: 'response', detail });
      }
    } else if (step.actionId.indexOf('extract-') === 0) {
      const n = name(p.as);
      const action = actionById(step.actionId);
      if (n) out.push({ name: n, fromStep: i + 1, type: 'value', detail: action ? action.name : '提取' });
    } else if (step.actionId === 'set-var') {
      const n = name(p.name);
      if (n) out.push({ name: n, fromStep: i + 1, type: 'value', detail: '设置变量' });
    }
  }
  return out;
}

/** 「从哪个响应」下拉的选项：名字 + 第几步 + 接口，光看名字不知道是谁 */
export function variableOptions(vars: FlowVar[]): { value: string; label: string }[] {
  return (vars || []).map((v) => ({
    value: v.name,
    label: v.name + '（第 ' + v.fromStep + ' 步' + (v.detail ? ' · ' + v.detail : '') + '）'
  }));
}

/**
 * 把 `${变量}` 插到光标处（拿不到光标就接在末尾）。
 * 抽成纯函数是为了能单测：UI 里光标从 antd Input 的 ref 读，测试里直接给位置。
 */
export function insertVarToken(text: string, name: string, caret?: number): string {
  const src = String(text === undefined || text === null ? '' : text);
  const token = '${' + String(name === undefined || name === null ? '' : name).trim() + '}';
  let pos = typeof caret === 'number' && Number.isFinite(caret) ? Math.floor(caret) : src.length;
  if (pos < 0) pos = 0;
  if (pos > src.length) pos = src.length;
  return src.slice(0, pos) + token + src.slice(pos);
}

/* ============================================================
 * apis 集合 → 接口下拉 / 接口快照
 * ============================================================ */

/** 接口下拉选项：`POST /api/login · 登录`（和左侧「接口记录」下拉一个写法） */
export function apiOptions(apis: any[]): { value: string; label: string }[] {
  return (apis || [])
    .filter((a) => a && a.id)
    .map((a) => {
      const d = a.data || {};
      const method = String(d.method || '').toUpperCase();
      const url = String(d.url || '');
      const title = String(a.title || d.name || '');
      return { value: String(a.id), label: (method + ' ' + url + (title ? ' · ' + title : '')).trim() };
    });
}

/** 接口记录里的 headers 是多行字符串（`K: V`），快照统一存成 [{k,v}] */
export function parseHeaderLines(raw: any): { k: string; v: string }[] {
  if (Array.isArray(raw)) {
    return raw
      .map((h) => ({
        k: String((h && (h.k || h.name)) === undefined ? '' : (h && (h.k || h.name))).trim(),
        v: String((h && (h.v || h.value)) === undefined ? '' : (h && (h.v || h.value)))
      }))
      .filter((h) => h.k);
  }
  return String(raw === undefined || raw === null ? '' : raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return i < 0 ? { k: l, v: '' } : { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() };
    })
    .filter((h) => h.k);
}

/**
 * 选接口那一刻抄下来的**快照**。
 *
 * 为什么存快照、不实时读 apis：流程是「上次拼好的东西」，接口记录今天改路径、
 * 明天删掉，已经存下的流程不该跟着烂。快照就是当时的真相。
 */
export function apiSnapshot(record: any): Record<string, any> {
  const d = (record && record.data) || {};
  return {
    apiId: String((record && record.id) || ''),
    apiName: String(d.name || (record && record.title) || '').trim(),
    method: String(d.method || 'GET').toUpperCase(),
    path: String(d.url || '').trim(),
    headers: parseHeaderLines(d.headers),
    body: String(d.body === undefined || d.body === null ? '' : d.body)
  };
}

/* ============================================================
 * flows 集合：ui / api 两种流程
 * ============================================================ */

/** 老记录没有 kind —— 一律当 UI 流程（v0.49 之前只有 UI 积木） */
export function flowKindOf(flow: any): 'ui' | 'api' {
  const d = (flow && flow.data) || {};
  return String(d.kind || '').trim().toLowerCase() === 'api' ? 'api' : 'ui';
}

/** 接口积木的「载入流程」只列 kind === 'api' 的 */
export function apiFlowsOnly(flows: any[]): any[] {
  return (flows || []).filter((f) => f && f.id && flowKindOf(f) === 'api');
}

/** 保存流程时的默认名称：接口流程-1125（月日，方便同一天存多条） */
export function defaultApiFlowName(date?: Date): string {
  const d = date instanceof Date ? date : new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return '接口流程-' + mm + dd;
}

export type ApiFlowRecordData = {
  name: string;
  kind: string;
  baseUrl: string;
  testName: string;
  steps: string;
  note: string;
};

/**
 * 当前拼装状态 → 一条 flows 记录的 data。
 *
 * kind 固定写 'api'：UI 积木的「载入流程」靠这个字段把自己那份过滤掉，
 * 两边共用 flows 集合但互不串台。baseUrl 也存下来 —— 它不属于任何一步，
 * 但生成结果的 URL 前缀靠它。
 */
export function apiFlowRecordData(o: {
  name: string;
  note?: string;
  baseUrl?: string;
  testName?: string;
  steps?: ApiBricksStep[];
}): ApiFlowRecordData {
  const steps = (o.steps || []).map((s) => ({
    actionId: s.actionId,
    params: Object.assign({}, s.params || {})
  }));
  return {
    name: String(o.name || '').trim(),
    kind: 'api',
    baseUrl: String(o.baseUrl || '').trim(),
    testName: String(o.testName || '').trim(),
    steps: JSON.stringify(steps),
    note: String(o.note || '')
  };
}

/** flows 记录的 steps → 面板步骤（坏 JSON / 动作已删除 → 跳过那一条，绝不抛） */
export function parseApiFlowSteps(raw: any): ApiBricksStep[] {
  let list: any = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: ApiBricksStep[] = [];
  for (const item of list) {
    const actionId = String((item && item.actionId) || '').trim();
    if (!actionId || !actionById(actionId)) continue;
    out.push({
      // 载入时重新发号：同一份流程载入两次也不会撞 key
      key: 'f' + out.length + '_' + actionId,
      actionId,
      params: Object.assign({}, (item && item.params) || {})
    });
  }
  return out;
}

/** 变量名是否合法（和生成器同一套规则，输入框边敲边提示） */
export function identOk(name: any): boolean {
  return isIdentifier(name);
}