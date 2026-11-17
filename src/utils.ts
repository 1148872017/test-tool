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

/**
 * 整条记录转成便于粘贴的文本。
 * linkMap 是「关联记录 id → 可读标签」，缺省时保留原始 id（老调用方兼容）。
 */
export function recordToText(rec: any, conf: any, linkMap: Record<string, string> = {}): string {
  const d = rec.data || {};
  const lines: string[] = [`【${conf.name}】${rec.title}`];
  for (const f of conf.fields) {
    if (f.key === conf.titleField) continue;
    const v = d[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    const label = (x: any) => (f.options || []).find((o: any) => o.value === x)?.label || String(x);
    const text =
      f.type === 'link'
        ? linkMap[String(v)] || String(v)
        : Array.isArray(v)
        ? v.map(label).join(' / ')
        : f.type === 'select'
        ? label(v)
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