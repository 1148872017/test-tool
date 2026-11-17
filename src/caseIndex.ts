/**
 * 用例索引的内存缓存。
 *
 * 扫描一次目录要读上百个 md，用例页、接口详情、关联弹窗都要用同一份结果，
 * 所以在渲染进程里缓存住，避免每开一个抽屉就重扫一次。
 */
import api from './api';

let cache: any = null;
let pending: Promise<any> | null = null;

/** 关联软键：文件相对路径 + 用例标题（与 store 的 case_api_links 保持一致） */
export function caseKey(filePath: string, title: string): string {
  return String(filePath || '') + '\u0001' + String(title || '');
}

/** force=true 时强制重扫（用例页的「重新扫描」） */
export function loadCaseIndex(force = false): Promise<any> {
  if (force) {
    cache = null;
    pending = null;
  }
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = api
      .caseScan()
      .then((res: any) => {
        cache = res;
        return res;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export function cachedCaseIndex(): any {
  return cache;
}

/** 索引里所有用例的软键集合；扫描失败返回 null（调用方据此跳过「失效」判断） */
export function knownCaseKeys(index: any): Set<string> | null {
  if (!index || index.error || !Array.isArray(index.files)) return null;
  const out = new Set<string>();
  for (const f of index.files) {
    for (const c of f.cases || []) out.add(caseKey(f.relPath, c.title));
  }
  return out;
}

/**
 * 平铺成可勾选的候选行。
 * 同文件同标题的用例在关联表里是同一个软键（唯一索引 file_path+case_title+api_id），
 * 所以这里按软键去重，并用 dup 标出「这个标题在文件里出现了几次」，不偷偷藏掉。
 */
export function flattenCases(index: any): any[] {
  const out: any[] = [];
  const byKey = new Map<string, any>();
  if (!index || !Array.isArray(index.files)) return out;
  for (const f of index.files) {
    for (const c of f.cases || []) {
      const key = caseKey(f.relPath, c.title);
      const hit = byKey.get(key);
      if (hit) {
        hit.dup += 1;
        continue;
      }
      const row = {
        key,
        relPath: f.relPath,
        fileName: String(f.name || '').replace(/\.md$/i, ''),
        dir: f.dir || '',
        item: c,
        dup: 1
      };
      byKey.set(key, row);
      out.push(row);
    }
  }
  return out;
}