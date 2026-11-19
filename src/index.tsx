import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { themeConfig } from './theme';

dayjs.locale('zh-cn');

/** 移除启动骨架屏（index.html 里的 #boot） */
function hideBoot() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 220);
}

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <ConfigProvider locale={zhCN} theme={themeConfig}>
    <AntApp>
      <App />
    </AntApp>
  </ConfigProvider>
);

// 等首帧渲染完再移除，避免闪一下白屏
requestAnimationFrame(() => requestAnimationFrame(hideBoot));
