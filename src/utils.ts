import dayjs from 'dayjs';
import { ENV_OPTIONS, METHOD_OPTIONS } from '../shared/collections';

export function fmtTime(ts: number, full = false): string {
  if (!ts) return '-';
  return dayjs(ts).format(full ? 'YYYY-MM-DD HH:mm:ss' : 'MM-DD HH:mm');
}

export function dayjsValue(v: string) {
  return v ? dayjs(v) : null;
}

export function envOf(value: string) {
  return ENV_OPTIONS.find((e: any) => e.value === value) || null;
}

export function methodOf(value: string) {
  return METHOD_OPTIONS.find((e: any) => e.value === value) || null;
}

/** 风险标签 → AntD 颜色（兼容 [高风险] 与 [🔴高] 两种历史写法） */
export function riskTone(risk: string) {
  if (!risk) return '';
  if (risk.indexOf('🔴') >= 0 || risk.indexOf('高') >= 0) return 'red';
  if (risk.indexOf('🟡') >= 0 || risk.indexOf('中') >= 0) return 'gold';
  if (risk.indexOf('🟢') >= 0 || risk.indexOf('低') >= 0) return 'green';
  return '';
}

/** 把接口记录拼成可直接粘贴执行的 cURL */
export function buildCurl(rec: any): string {
  const d = rec.data || {};
  const method = String(d.method || 'GET').toUpperCase();
  const url = String(d.url || '');
  if (!url) return '';
  const parts = [`curl -X ${method} '${url}'`];
  const headers = String(d.headers || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of headers) {
    const idx = h.indexOf(':');
    if (idx > 0) {
      parts.push(`-H '${h.slice(0, idx).trim()}: ${h.slice(idx + 1).trim()}'`);
    }
  }
  const body = String(d.body || '').trim();
  if (body && method !== 'GET') {
    parts.push(`--data-raw '${body.replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(' \\\n  ');
}

/** 取出 SQL / Body 里的 {{变量}} */
export function extractVars(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || '')))) {
    const name = m[1];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function fillVars(text: string, map: Record<string, string>): string {
  return String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name) => {
    const v = map[name];
    return v === undefined || v === '' ? all : v;
  });
}

/* ------------------------------------------------------------------ *
 * SQL 片段：把选中的一段文字变成 {{变量}}
 *
 * 纯函数，单独放在这里是为了能单测（scripts/test-recycle.cjs）。
 * 组件那边只负责「记住选区和选中时的文字」「弹框改名」「写回 data」。
 * ------------------------------------------------------------------ */

/** 变量行（和 VarsEditor 的存储格式一致） */
export type VarRow = { name: string; value: string; desc: string };

/** 变换失败的原因：没选中 / 正文变了 / 已经是变量 */
export type ConvertReason = 'empty' | 'changed' | 'already';

export type ConvertResult = {
  ok: boolean;
  reason?: ConvertReason;
  /** 替换后的正文（失败时原样返回） */
  text: string;
  /** 替换后的光标位置（落在 }} 后面；失败时停在选区起点） */
  cursor: number;
  /** 变量名（失败时可能为空串；already 时是里面那个名字） */
  varName: string;
  /** 追加变量后的变量表（失败时原样返回） */
  vars: VarRow[];
};

/** 合法的变量名：字母/数字/下划线/点/横线，且不以数字开头 */
export const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** 数字占比：'SO20261124001' 这种一长串数字的是单号，不是变量名 */
function digitRatio(s: string): number {
  const text = String(s || '');
  if (!text.length) return 1;
  let n = 0;
  for (const ch of text) if (ch >= '0' && ch <= '9') n++;
  return n / text.length;
}

function normalizeVars(list: any): VarRow[] {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ name: String(x.name || ''), value: String(x.value || ''), desc: String(x.desc || '') }));
}

/**
 * 猜一个没被占用的变量名。
 *
 *   'orderNo'       → orderNo（是英文标识符，直接用）
 *   'SO20261124001' → var1（虽然字面上也符合「字母开头」，但那是单号不是名字 ——
 *                     数字占比超过一半就当成值，不硬拿来当变量名）
 *   已存在 orderNo  → orderNo2 / orderNo3…
 *   已存在 var1     → var2
 */
export function suggestVarName(selected: string, existingVars: any = []): string {
  const used = new Set(normalizeVars(existingVars).map((v) => v.name.trim()).filter(Boolean));
  const raw = String(selected === undefined || selected === null ? '' : selected).trim();
  const looksLikeName = VAR_NAME_PATTERN.test(raw) && digitRatio(raw) <= 0.5;

  // 不像变量名（中文、纯数字、带空格、一长串数字的单号…）→ var 打头，从 1 数
  if (!looksLikeName) {
    let n = 1;
    while (used.has('var' + n)) n++;
    return 'var' + n;
  }
  if (!used.has(raw)) return raw;
  let n = 2;
  while (used.has(raw + n)) n++;
  return raw + n;
}

/**
 * 把 text[start, end) 换成 {{变量名}}，同时往变量表里追加一条定义。
 *
 * @param text         正文
 * @param start        选区起点
 * @param end          选区终点
 * @param existingVars 已有变量（[{name,value,desc}]）
 * @param expected     点按钮那一刻「原文里选中的那段」。传了就做防错位校验：
 *                     正文已经变了（用户又敲了字/换了选区）就返回 reason='changed'，
 *                     别按旧坐标去替换，否则会切错地方。
 * @param preferredName 用户在弹框里改过的名字；不传就自动猜
 */
export function convertSelectionToVar(
  text: string,
  start: number,
  end: number,
  existingVars: any = [],
  expected?: string,
  preferredName?: string
): ConvertResult {
  const src = text === undefined || text === null ? '' : String(text);
  const vars = normalizeVars(existingVars);

  // 坐标夹到正文范围内：textarea 的 selectionStart 偶尔会比 value 长（受控组件时序）
  const from = Math.max(0, Math.min(src.length, Number(start) || 0));
  const to = Math.max(from, Math.min(src.length, Number(end) || 0));
  const selected = src.slice(from, to);

  const fail = (reason: ConvertReason, varName = ''): ConvertResult => ({
    ok: false,
    reason,
    text: src,
    cursor: from,
    varName,
    vars
  });

  if (!selected.trim()) return fail('empty');

  // 幂等：选中的本来就是 {{xxx}}，不再包一层
  const already = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(selected.trim());
  if (already) return fail('already', already[1]);

  // 防错位：当时选中的文字和现在这段必须一致
  if (expected !== undefined && expected !== null && expected !== selected) return fail('changed');

  const name = String(preferredName || '').trim() || suggestVarName(selected, vars);
  const replacement = `{{${name}}}`;
  const next = src.slice(0, from) + replacement + src.slice(to);
  return {
    ok: true,
    text: next,
    // 光标落在 }} 后面，接着往下写
    cursor: from + replacement.length,
    varName: name,
    vars: vars.concat([{ name, value: '', desc: '' }])
  };
}

/**
 * 整条记录转成便于粘贴的文本。
 * linkMap 是「关联记录 id → 可读标签」，缺省时保留原始 id（老调用方兼容）。
 */
export function recordToText(rec: any, conf: any, linkMap: Record<string, string> = {}): string {
  const d = rec.data || {};
  const lines: string[] = [`【${conf.name}】${rec.title}`];

  /** options 里的 label */
  const label = (f: any, x: any) => (f.options || []).find((o: any) => o.value === x)?.label || String(x);

  /**
   * 账号列表 → 人话。
   *
   * 存的是 JSON 字符串，直接 String() 出来是一串 [{"label":"管理员",...}]，
   * 粘给人看很丑（用户要求「账号：123 密码：456」这种）。
   */
  const fmtAccounts = (raw: any): string => {
    let list: any[] = [];
    try {
      list = JSON.parse(String(raw || '[]'));
    } catch (e) {
      return String(raw || '');
    }
    if (!Array.isArray(list) || !list.length) return '';
    return list
      .filter((a) => a && (a.account || a.label))
      .map((a) => {
        const head = String(a.label || '账号');
        const acc = String(a.account || '—');
        const pwd = a.password ? `  密码：${a.password}` : '';
        const role = Array.isArray(a.role) && a.role.length ? `  角色：${a.role.join('/')}` : '';
        const def = a.isDefault ? '（默认）' : '';
        const note = a.note ? `  备注：${a.note}` : '';
        return `  ${head}${def}：账号 ${acc}${pwd}${role}${note}`;
      })
      .join('\n');
  };

  /**
   * 变量表 → 人话（同理，存的是 JSON）。
   */
  const fmtVars = (raw: any): string => {
    let list: any[] = [];
    try {
      list = JSON.parse(String(raw || '[]'));
    } catch (e) {
      return String(raw || '');
    }
    if (!Array.isArray(list) || !list.length) return '';
    return list
      .filter((v) => v && v.name)
      .map((v) => {
        const val = v.value ? ` = ${v.value}` : '';
        const desc = v.desc ? `   // ${v.desc}` : '';
        return `  {{${v.name}}}${val}${desc}`;
      })
      .join('\n');
  };

  for (const f of conf.fields) {
    if (f.key === conf.titleField) continue;
    const v = d[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;

    // 账号列表：多行展开
    if (f.type === 'accounts') {
      const txt = fmtAccounts(v);
      if (txt) lines.push(`${f.label}:\n${txt}`);
      continue;
    }

    // 变量表：多行展开
    if (f.type === 'vars') {
      const txt = fmtVars(v);
      if (txt) lines.push(`${f.label}:\n${txt}`);
      continue;
    }

    // 指标表 / 场景：存的是 JSON，尽量给个可读形式
    if (f.type === 'metrics' || f.type === 'scene') {
      try {
        const obj = typeof v === 'string' ? JSON.parse(v) : v;
        lines.push(`${f.label}: ${JSON.stringify(obj)}`);
      } catch (e) {
        lines.push(`${f.label}: ${String(v)}`);
      }
      continue;
    }

    const text =
      f.type === 'link'
        ? linkMap[String(v)] || String(v)
        : Array.isArray(v)
        ? v.map((x: any) => label(f, x)).join(' / ')
        : f.type === 'select'
        ? label(f, v)
        : String(v);
    lines.push(`${f.label}: ${text}`);
  }

  if (rec.tags && rec.tags.length) lines.push(`标签: ${rec.tags.join(', ')}`);
  return lines.join('\n');
}

export function hasSecretValue(rec: any, conf: any): boolean {
  const d = rec.data || {};
  return conf.fields.some((f: any) => f.type === 'secret' && d[f.key]);
}

/* ------------------------------------------------------------------ *
 * 回收站
 * ------------------------------------------------------------------ */

/**
 * 回收站保留天数。
 * 必须和主进程的 store.TRASH_RETENTION_DAYS 保持一致 ——
 * 界面上写「30 天后自动清除」，真清理却按别的天数来，就是骗人。
 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * 距离自动清除还剩几天。
 *
 * 向上取整：刚删的显示「30 天」，剩 20.3 天显示「21 天」。
 * 不用 Math.floor —— 剩 0.4 天时会显示「0 天后清除」，用户以为马上就没了。
 */
export function trashDaysLeft(deletedAt: number, now: number = Date.now()): number {
  if (!deletedAt) return TRASH_RETENTION_DAYS;
  const left = TRASH_RETENTION_DAYS - (now - deletedAt) / 86400000;
  return Math.max(0, Math.ceil(left));
}

/** 时间偏移单位 */
export const TIME_UNITS = [
  { value: 'second', label: '秒', ms: 1000 },
  { value: 'minute', label: '分钟', ms: 60000 },
  { value: 'hour', label: '小时', ms: 3600000 },
  { value: 'day', label: '天', ms: 86400000 },
  { value: 'week', label: '周', ms: 604800000 }
];

/** 毫秒差 → 「1 天 2 小时 3 分 4 秒」 */
export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const parts: string[] = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分`);
  if (seconds || !parts.length) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}