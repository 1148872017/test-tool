import React, { useEffect, useRef, useState } from 'react';
import { App as AntApp, Spin } from 'antd';
import api from './api';
import { bindMessage } from './msg';
import Sidebar from './components/Sidebar';
import LockScreen from './components/LockScreen';
import CollectionPage from './components/CollectionPage';
import JsonTool from './pages/JsonTool';
import DataTool from './pages/DataTool';
import Toolbox from './pages/Toolbox';
import CodeRunnerPage from './pages/CodeRunnerPage';
import SettingsPage from './pages/SettingsPage';
import CasePage from './pages/CasePage';
import JmxPage from './pages/JmxPage';
import KnowledgePage from './pages/KnowledgePage';
import NotesPage from './pages/NotesPage';
import { COLLECTIONS } from '../shared/collections';

export default function App() {
  const { message } = AntApp.useApp();
  const [boot, setBoot] = useState<any>(null);
  const [locked, setLocked] = useState(true);
  const [route, setRoute] = useState<any>({ type: 'collection', key: 'sites' });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const lastActive = useRef(Date.now());

  useEffect(() => {
    bindMessage(message);
  }, [message]);

  useEffect(() => {
    api
      .init()
      .then((info: any) => {
        setBoot(info);
        setLocked(!!info.locked);
      })
      .catch((e: any) => {
        setBoot({ error: (e && e.message) || String(e) });
      });
  }, []);

  const refreshCounts = () => {
    api
      .counts()
      .then(setCounts)
      .catch(() => {});
  };

  useEffect(() => {
    if (boot && !locked) refreshCounts();
  }, [boot, locked, route]);

  // 表单控件（input / textarea）会吞掉滚轮事件，指针停在输入框上时整页滚不动。
// 控件自己没有滚动余量时，把滚轮转给主滚动区。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
      const el = t as HTMLInputElement;
      if (el.scrollHeight > el.clientHeight + 1) return; // 控件自己能滚就不抢
      const main = document.querySelector('.main') as HTMLElement | null;
      if (!main || main.scrollHeight <= main.clientHeight) return;
      main.scrollTop += e.deltaY;
      e.preventDefault();
    };
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);

  // 闲置自动锁定
  useEffect(() => {
    if (!boot || !boot.settings) return;
    const minutes = Number(boot.settings.autoLockMinutes || 0);
    if (!minutes) return;
    const bump = () => {
      lastActive.current = Date.now();
    };
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel'];
    events.forEach((name) => window.addEventListener(name, bump, { passive: true }));
    const timer = setInterval(() => {
      if (!boot.settings.hasPin) return;
      if (Date.now() - lastActive.current > minutes * 60000) {
        api.lock().then(() => setLocked(true));
      }
    }, 15000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, bump));
      clearInterval(timer);
    };
  }, [boot]);

  const onUnlock = async (pin: string) => {
    const res = await api.unlock(pin);
    if (res && res.ok) {
      setLocked(false);
      lastActive.current = Date.now();
      return true;
    }
    return false;
  };

  const doLock = async () => {
    await api.lock();
    setLocked(true);
  };

  /** 用例抽屉里点接口 → 跳到「接口记录」并把那条记录打开 */
  const openApiRecord = (apiId: string) => {
    if (!apiId) return;
    setRoute({ type: 'collection', key: 'apis', openId: apiId });
  };

  /** 变更影响面里点用例 → 跳到「测试用例」并把那条用例打开（软键：文件 + 标题） */
  const openCaseRecord = (filePath: string, caseTitle: string) => {
    if (!filePath || !caseTitle) return;
    setRoute({ type: 'cases', openCase: { filePath, caseTitle } });
  };

  /** 接口详情里点「记一笔」→ 跳到「测试执行」并预填好接口和环境 */
  const logRunForApi = (record: any) => {
    if (!record || !record.id) return;
    setRoute({
      type: 'collection',
      key: 'runs',
      logFor: {
        apiRef: record.id,
        name: record.title ? record.title + ' · ' : '',
        env: (record.data && record.data.env) || 'test',
        ranAt: Date.now()
      }
    });
  };

  if (!boot) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (boot.error) {
    return <div style={{ padding: 40, color: '#e5534b' }}>启动失败：{boot.error}</div>;
  }

  if (locked) {
    return <LockScreen hasPin={!!boot.settings.hasPin} onUnlock={onUnlock} />;
  }

  const conf = route.type === 'collection' ? COLLECTIONS.find((c: any) => c.key === route.key) : null;

  return (
    <div className="app">
      <Sidebar route={route} onNavigate={setRoute} counts={counts} onLock={doLock} />
      <main className="main">
        {conf ? (
          <CollectionPage
            key={conf.key}
            conf={conf}
            onCounts={refreshCounts}
            openRecordId={route.openId}
            onOpenedRecord={() => setRoute((r: any) => ({ ...r, openId: undefined }))}
            onOpenCase={openCaseRecord}
            onLogRun={logRunForApi}
            logFor={route.logFor}
            onLoggedRun={() => setRoute((r: any) => ({ ...r, logFor: undefined }))}
          />
        ) : null}
        {route.type === 'cases' ? (
          <CasePage
            onOpenApi={openApiRecord}
            openCase={route.openCase}
            onOpenedCase={() => setRoute((r: any) => ({ ...r, openCase: undefined }))}
          />
        ) : null}
        {route.type === 'jmx' ? <JmxPage /> : null}
        {route.type === 'kb' ? <KnowledgePage /> : null}
        {route.type === 'notes' ? <NotesPage /> : null}
        {route.type === 'tool' && route.key === 'json' ? <JsonTool /> : null}
        {route.type === 'tool' && route.key === 'data' ? <DataTool /> : null}
        {route.type === 'tool' && route.key === 'toolbox' ? <Toolbox /> : null}
        {route.type === 'tool' && route.key === 'runner' ? <CodeRunnerPage /> : null}
        {route.type === 'settings' ? (
          <SettingsPage
            boot={boot}
            onChanged={() =>
              api.init().then((info: any) => {
                setBoot(info);
                setCounts({});
                refreshCounts();
              })
            }
          />
        ) : null}
      </main>
    </div>
  );
}