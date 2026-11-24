import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { themeConfig } from './theme';
import ErrorBoundary from './components/feedback/ErrorBoundary';

dayjs.locale('zh-cn');

/** 移除启动骨架屏（index.html 里的 #boot） */
function hideBoot() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 220);
}

/**
 * 挂载应用（正式入口与预览入口共用）。
 *
 * 两个入口的差别只有「装不装 mock」：
 *   正式  src/index.tsx        → 不装，预加载缺失时由 ApiUnavailableError 明确报错
 *   预览  src/index.preview.tsx → 先 installMockIfNeeded() 再 mount()
 * 这样 dist/app.js 里不会出现任何 mock 代码（esbuild 不做副作用摇树）。
 */
export function mount() {
  const container = document.getElementById('root');
  if (!container) {
    // index.html 结构不对是构建事故，直接抛比静默白屏好排查
    throw new Error('index.html 里找不到 #root 挂载点');
  }

  const root = createRoot(container);
  root.render(
    <ErrorBoundary scope="app">
      <ConfigProvider locale={zhCN} theme={themeConfig}>
        <AntApp>
          <App />
        </AntApp>
      </ConfigProvider>
    </ErrorBoundary>
  );

  // 等首帧渲染完再移除，避免闪一下白屏
  requestAnimationFrame(() => requestAnimationFrame(hideBoot));
}

export default mount;
