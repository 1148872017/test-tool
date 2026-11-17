import api from './api';
import { OPTION_SETS } from '../shared/collections';

/** 选项集：环境是有 value/label/color 的对象，角色和标签就是字符串 */
export type EnvItem = { value: string; label: string; color?: string };
export type OptionsMap = { env: EnvItem[]; role: string[]; tags: string[] };

function defaults(): OptionsMap {
  const out: any = {};
  for (const key of Object.keys(OPTION_SETS)) {
    out[key] = ((OPTION_SETS as any)[key].defaults || []).slice();
  }
  return out as OptionsMap;
}

let cache: OptionsMap | null = null;
let inflight: Promise<OptionsMap> | null = null;

/** 同步取（组件首次渲染就能用，避免下拉闪一下空） */
export function getOptionsSync(): OptionsMap {
  return cache || defaults();
}

/**
 * 读一次配置，进程内缓存。
 * 设置页改完要 invalidateOptions()，否则表单还拿着老列表。
 */
export async function loadOptions(force = false): Promise<OptionsMap> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;
  const p = (async () => {
    try {
      const v: any = await api.getOptions();
      const d = defaults();
      cache = {
        env: Array.isArray(v && v.env) && v.env.length ? v.env : d.env,
        role: Array.isArray(v && v.role) ? v.role : d.role,
        tags: Array.isArray(v && v.tags) ? v.tags : d.tags
      };
    } catch (e) {
      cache = defaults();
    } finally {
      inflight = null;
    }
    return cache as OptionsMap;
  })();
  inflight = p;
  return p;
}

export function invalidateOptions() {
  cache = null;
}

/** 字段当前可用的选项：有 optionsKey 就走配置（运行时可变），否则用字段自带的静态 options */
export function fieldOptions(f: any, opts: OptionsMap): any[] {
  if (!f || !f.optionsKey) return (f && f.options) || [];
  const list: any[] = (opts as any)[f.optionsKey] || [];
  if (!list.length) return f.options || [];
  return list.map((it: any) =>
    typeof it === 'string' ? { value: it, label: it } : { value: it.value, label: it.label, color: it.color }
  );
}

/** 值统一成数组：老数据/老导出文件里可能是字符串 */
export function asArray(v: any): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x === undefined || x === null ? '' : x).trim())
      .filter(Boolean);
  }
  if (v === undefined || v === null) return [];
  const s = String(v).trim();
  return s ? [s] : [];
}

export function labelOf(value: string, f: any, opts: OptionsMap): string {
  const hit = fieldOptions(f, opts).find((o: any) => o.value === value);
  return hit ? hit.label || value : value;
}
