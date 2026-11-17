import { installMockIfNeeded } from './mockApi';

// 浏览器预览：没有 Electron 注入的 window.api 时，先装一个内存实现
installMockIfNeeded();

const api = (window as any).api;

export default api;

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