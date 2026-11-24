import React, { useEffect, useRef, useState } from 'react';
import { App as AntApp, Spin } from 'antd';
import api from './api';
import { bindMessage } from './msg';
import Sidebar from './components/Sidebar';
import LockScreen from './components/LockScreen';
import ErrorBoundary from './components/feedback/ErrorBoundary';
import CollectionPage from './components/CollectionPage';
import JsonTool from './pages/JsonTool';
import DataTool from './pages/DataTool';
import Toolbox from './pages/Toolbox';
import CodeRunnerPage from './pages/CodeRunnerPage';
import CodegenPage from './pages/CodegenPage';
import ReportPage from './pages/ReportPage';
import CodeScanPage from './pages/CodeScanPage';
import ScriptGenPage from './pages/ScriptGenPage';
import SettingsPage from './pages/SettingsPage';
import { getTheme } from '../shared/themes';
import CasePage from './pages/CasePage';
import JmxPage from './pages/JmxPage';
import KnowledgePage from './pages/KnowledgePage';
import NotesPage from './pages/NotesPage';
import TrashPage from './pages/TrashPage';
import { COLLECTIONS } from '../shared/collections';

/**
 * 应用皮肤：只注入主题色。
 *
 * 全部走 CSS 变量，不改 CSS 文件：
 *   --primary       填充色（按钮底、色块，固定配白字）
 *   --primary-text  文字色（链接、选中的导航项、强调文字）
 *   --primary-soft  浅底色（选中项背景、标签底）
 *
 * 背景图 / 背景蒙版 / 面板透明度 / 文字深浅三档已经下线：
 * 页面回到纯色底，文字对比度靠 token 保证，不再需要在运行时
 * 打阴影、改 --text、改 --muted 去补救。
 */
function useSkin(settings: any) {
  React.useEffect(() => {
    const t = getTheme(settings && settings.themeColor);
    const root = document.documentElement;
    root.style.setProperty('--primary', t.primary);
    root.style.setProperty('--primary-text', t.primaryText);
    root.style.setProperty('--primary-soft', t.soft);
  }, [settings && settings.themeColor]);
}

export default function App() {
  const { message } = AntApp.useApp();
  const [boot, setBoot] = useState<any>(null);
  // 应用皮肤（只主题色）
  useSkin(boot && boot.settings);
  const [locked, setLocked] = useState(true);
  const [route, setRoute] = useState<any>({ type: 'collection', key: 'sites' });
  const [counts, setCounts] = useState<Record<string, number>>({});
  /** 回收站角标：单独取，不进 counts（counts 的 key 就是集合 key） */
  const [trashCount, setTrashCount] = useState(0);
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
    // 回收站条数单独取：counts 的每个 key 都对应一个集合，混进去会把
    // 「清除数据后所有集合都为空」这类判断搞乱
    const trashCountFn = (api as any).trashCount;
    if (typeof trashCountFn === 'function') {
      trashCountFn()
        .then((n: number) => setTrashCount(Number(n) || 0))
        .catch(() => {});
    }
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

  /**
   * 路由标识，给 ErrorBoundary 当 key 用。
   * collection / tool 必须带上具体 key：否则在「接口记录」崩了之后切到「SQL 片段」，
   * key 没变化，兜底状态不会重置，用户会以为整个工具都坏了。
   */
  const routeKey =
    route.type === 'collection'
      ? 'collection:' + route.key
      : route.type === 'tool'
        ? 'tool:' + route.key
        : String(route.type);

  return (
    <div className="app">
      <Sidebar route={route} onNavigate={setRoute} counts={counts} onLock={doLock} trashCount={trashCount} />
      {/*
        shell 接线：只有集合页走 PageShell（.main 不再滚动，.pg-body 是唯一滚动区）。
        其他页面继续用 .main 自身滚动，CSS 里按 .main--collection 作用域区分。
      */}
      <main className={'main' + (conf ? ' main--collection' : '')}>
        {/*
          路由级兜底：只包主内容区，侧栏留在外面 —— 一个页面 render 抛错只换掉这一块，
          导航还能用。key 用 routeKey，切换路由时边界整体重建、兜底状态清空，
          用户切走再切回来自动恢复，不必重启。
        */}
        <ErrorBoundary key={routeKey} scope={routeKey}>
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
        {/* 回收站：常规列表看不到的已删除记录在这里恢复 / 彻底删除 */}
        {route.type === 'trash' ? <TrashPage onChanged={refreshCounts} /> : null}
        {route.type === 'tool' && route.key === 'json' ? <JsonTool /> : null}
        {route.type === 'tool' && route.key === 'data' ? <DataTool /> : null}
        {route.type === 'tool' && route.key === 'toolbox' ? <Toolbox /> : null}
        {route.type === 'tool' && route.key === 'runner' ? <CodeRunnerPage /> : null}
        {route.type === 'tool' && route.key === 'codegen' ? <CodegenPage /> : null}
        {route.type === 'tool' && route.key === 'report' ? <ReportPage /> : null}
        {route.type === 'tool' && route.key === 'codescan' ? <CodeScanPage /> : null}
        {route.type === 'tool' && route.key === 'scriptgen' ? <ScriptGenPage /> : null}
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
        </ErrorBoundary>
      </main>
    </div>
  );
}