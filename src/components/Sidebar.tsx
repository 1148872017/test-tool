import React from 'react';
import { SettingOutlined, LockOutlined } from '@ant-design/icons';
import Icon from '../icons';
import { BRAND_ICON } from '../assets/brand';
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
  /**
   * 侧栏分组：按「测试工作流」排序。
   *
   *   资产   → 网站/账号、接口记录、SQL 片段、测试执行（存什么）
   *   索引   → 测试用例、压测脚本、知识库、测试笔记（读什么）
   *   自动化 → 代码生成、代码调试、代码体检、报告分析（写/跑/查）
   *   辅助   → 测试数据、JSON 工具、工具箱（日常小工具）
   */
  const groups = [
    { label: '资产', items: COLLECTIONS.filter((c: any) => c.group === '资产') },
    { label: '索引', items: [caseItem, jmxItem, kbItem, notesItem] },
    {
      label: '自动化',
      items: TOOLS.filter((t: any) => t.group === '自动化').map((t: any) => ({
        key: t.key,
        name: t.name,
        icon: t.icon,
        isTool: true
      }))
    },
    {
      label: '辅助',
      items: TOOLS.filter((t: any) => t.group === '辅助').map((t: any) => ({
        key: t.key,
        name: t.name,
        icon: t.icon,
        isTool: true
      }))
    }
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
        {/* 品牌图标：用户提供的立绘（裁成正方形 + 内联 base64） */}
        <div className="brand-mark">
          <img src={BRAND_ICON} alt="" className="brand-mark-img" />
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