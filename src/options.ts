import api from './api';
import { OPTION_SETS } from '../shared/collections';

/** 选项集：环境是有 value/label/color 的对象，角色、标签、模块、项目就是字符串 */
export type EnvItem = { value: string; label: string; color?: string };
export type OptionsMap = {
  env: EnvItem[];
  role: string[];
  tags: string[];
  /** 接口模块 / 目录 */
  module: string[];
  /** 页面所属项目 */
  project: string[];
};

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
 *
 * 这里按 OPTION_SETS 的 key 逐个取，不再写死 env/role/tags ——
 * 加一个选项集只改 shared/collections.js，读配置这条链路不用跟着改。
 */
export async function loadOptions(force = false): Promise<OptionsMap> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;
  const p = (async () => {
    try {
      const v: any = await api.getOptions();
      const d = defaults();
      const next: any = {};
      for (const key of Object.keys(OPTION_SETS)) {
        const saved = v ? v[key] : undefined;
        // 环境有默认项：存成空数组时退回默认（老行为，环境不能被清空）；
        // 其余集合允许是空数组 —— 用户就是想一个都不留也得听他的
        if (key === 'env') next[key] = Array.isArray(saved) && saved.length ? saved : d[key];
        else next[key] = Array.isArray(saved) ? saved : d[key];
      }
      cache = next as OptionsMap;
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

/**
 * 表单里「新值自动进选项集」之后同步进程内缓存。
 *
 * 不这么做的话，别的表单 / 详情页还拿着旧列表，下次得重启才看得到新选项。
 * cache 还没建过就什么都不用做：下次 loadOptions 会从主进程拿真数据。
 */
export function mergeOptionCache(key: string, items: any[]) {
  if (!cache) return;
  cache = { ...cache, [key]: items } as OptionsMap;
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

/**
 * 把「当前值」补进下拉候选。
 *
 * 老记录的模块 / 项目是自由文本，可能压根不在选项集里。
 * 不补进来的话用户一打开编辑框，选中的值在候选里找不到，看起来像丢了。
 * 只影响显示，不写盘。
 */
export function withCurrentOption(candidates: any[], value: any): any[] {
  const raw = String(value === undefined || value === null ? '' : value);
  const cur = raw.trim();
  if (!cur) return candidates;
  if (candidates.some((o: any) => String((o && o.value) === undefined ? '' : o.value).trim() === cur)) return candidates;
  return [{ value: raw, label: raw }, ...candidates];
}

/**
 * 选项集里追加一个值。
 *
 * 给「可选择 + 可新建」用：用户输入的新值不在选项集里时，下次得能从下拉里选到。
 * @returns 新的整个列表；值已存在 / 为空时返回 null（调用方据此跳过保存）
 */
export function appendOptionValue(list: any[] | undefined, value: string): any[] | null {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return null;
  const arr = Array.isArray(list) ? list : [];
  const isObject = arr.some((it) => !!it && typeof it === 'object');
  const has = arr.some((it) => {
    const v = it && typeof it === 'object' ? it.value !== undefined ? it.value : it.label : it;
    return String(v === undefined || v === null ? '' : v) === s;
  });
  if (has) return null;
  // 环境那种对象列表：补成同构的对象，别把 value/label/color 结构打坏
  return isObject ? [...arr, { value: s, label: s, color: 'default' }] : [...arr, s];
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
