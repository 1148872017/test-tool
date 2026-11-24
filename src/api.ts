/**
 * 渲染进程 API 入口（保持 20+ 处 `import api from '../api'` 零改动）。
 *
 * 实现在 ./platform/api：那边用 Proxy 惰性取 window.api，
 * 预加载缺失时按方法返回 rejected Promise，而不是在模块顶层抛异常。
 *
 * 这里**不能**再 import ./mockApi：那份内存实现只在 index.preview.tsx 入口安装。
 * esbuild 对带顶层副作用的模块不做摇树，只要 `import './mockApi'` 这条边存在，
 * 整个 mock（含种子账号密码）就会被打进 dist/app.js —— 正是本次要根除的问题。
 */
export { default, ApiUnavailableError, isApiUnavailableError } from './platform/api';

export type RecordItem = {
  id: string;
  collection: string;
  title: string;
  data: Record<string, any>;
  tags: string[];
  favorite: boolean;
  created_at: number;
  updated_at: number;
};

export type BootInfo = {
  locked: boolean;
  version: string;
  dataDir: string;
  encryptionAvailable: boolean;
  settings: { autoLockMinutes: number; clipboardClearSeconds: number; hasPin: boolean };
};
