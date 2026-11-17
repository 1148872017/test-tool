import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { themeConfig } from './theme';

dayjs.locale('zh-cn');

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <ConfigProvider locale={zhCN} theme={themeConfig}>
    <AntApp>
      <App />
    </AntApp>
  </ConfigProvider>
);