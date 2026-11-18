import React from 'react';
import { SettingOutlined, LockOutlined, ThunderboltFilled } from '@ant-design/icons';
import Icon from '../icons';
import { COLLECTIONS, TOOLS } from '../../shared/collections';

type Props = {
  route: any;
  onNavigate: (route: any) => void;
  counts: Record<string, number>;
  onLock: () => void;
};

export default function Sidebar({ route, onNavigate, counts, onLock }: Props) {
  const caseItem = { key: 'cases', name: '测试用例', icon: 'ProfileOutlined', isCase: true };
  const jmxItem = { key: 'jmx', name: '压测脚本', icon: 'DashboardOutlined', isJmx: true };
  const kbItem = { key: 'kb', name: '知识库', icon: 'BookOutlined', isKb: true };
  const notesItem = { key: 'notes', name: '测试笔记', icon: 'FileTextOutlined', isNotes: true };
  const groups = [
    { label: '密码库', items: COLLECTIONS.filter((c: any) => c.group === '密码库') },
    {
      label: '记录',
      items: [caseItem, ...COLLECTIONS.filter((c: any) => c.group === '记录'), jmxItem, kbItem, notesItem]
    },
    { label: '工具', items: TOOLS.map((t: any) => ({ key: t.key, name: t.name, icon: t.icon, isTool: true })) }
  ];

  const isActive = (item: any) => {
    if (item.isTool) return route.type === 'tool' && route.key === item.key;
    if (item.isCase) return route.type === 'cases';
    if (item.isJmx) return route.type === 'jmx';
    if (item.isKb) return route.type === 'kb';
    if (item.isNotes) return route.type === 'notes';
    return route.type === 'collection' && route.key === item.key;
  };

  const go = (item: any) => {
    if (item.isTool) onNavigate({ type: 'tool', key: item.key });
    else if (item.isCase) onNavigate({ type: 'cases' });
    else if (item.isJmx) onNavigate({ type: 'jmx' });
    else if (item.isKb) onNavigate({ type: 'kb' });
    else if (item.isNotes) onNavigate({ type: 'notes' });
    else onNavigate({ type: 'collection', key: item.key });
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <ThunderboltFilled />
        </div>
        <div className="brand-text">
          <b>测试工作台</b>
          <span>本地 · 加密存储</span>
        </div>
      </div>

      <nav className="nav">
        {groups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((item: any) => (
              <div
                key={item.key}
                className={'nav-item' + (isActive(item) ? ' active' : '')}
                onClick={() => go(item)}
              >
                <span className="nav-icon">
                  <Icon name={item.icon} />
                </span>
                <span className="nav-name">{item.name}</span>
                {!item.isTool && !item.isCase && !item.isJmx && !item.isKb && !item.isNotes && counts[item.key] ? (
                  <span className="nav-count">{counts[item.key]}</span>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          className="foot-btn"
          onClick={() => onNavigate({ type: 'settings' })}
          style={route.type === 'settings' ? { background: '#efecff', color: '#5443d6' } : undefined}
        >
          <SettingOutlined /> 设置
        </button>
        <button className="foot-btn" onClick={onLock}>
          <LockOutlined /> 锁定
        </button>
      </div>
    </aside>
  );
}