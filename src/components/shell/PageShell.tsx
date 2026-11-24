import React from 'react';

/**
 * 列表页五区骨架。
 *
 * 为什么要有这个组件：
 *   改造前 `.main` 自己滚、`.panel` 里又滚一层，两个滚动容器叠在一起，
 *   表格滚下去表头就跟着走；筛选条和统计卡也随页面滚走。
 *   现在只保留 `.pg-body` 一个滚动区：
 *
 *     Z1 页头   .pg-head     44px，无底色
 *     Z2 工具条 .pg-bar      40px，白底 + 下边线
 *     Z3 内容   .pg-body     1fr，★唯一滚动区★
 *     Z4 结果   .pg-dock     可选，40%，独立滚动（详情/对比类结果）
 *     Z5 状态栏 .pg-status   26px，--bg-subtle
 *
 *   页面不需要自己写 flex/高度，只要把内容塞进对应插槽。
 *
 * 注意：`.pg-body` 是唯一滚动区后，antd <Table> 必须开 sticky 才能固定表头。
 * 见 CollectionPage 里 `sticky={{ offsetHeader: 0 }}` 旁的实测说明。
 */

export interface PageShellProps {
  title: React.ReactNode;
  desc?: React.ReactNode;
  /** 页头计数（「5 条」）；0 也会显示，undefined 不占位 */
  count?: number;
  /** 页头右上，通常 1 个 primary + 1 个「⋯」 */
  actions?: React.ReactNode;
  /** 工具条（筛选 / 搜索） */
  bar?: React.ReactNode;
  /** 可选结果区：给详情、对比、日志这类需要独立滚动的区域 */
  dock?: React.ReactNode;
  /** 状态栏 */
  status?: React.ReactNode;
  /** true = 内容区吃满并内部滚动（列表页用） */
  fill?: boolean;
  children: React.ReactNode;
}

export default function PageShell({
  title,
  desc,
  count,
  actions,
  bar,
  dock,
  status,
  fill,
  children
}: PageShellProps) {
  return (
    <div className={'pg' + (fill ? ' pg--fill' : '')}>
      <header className="pg-head">
        <div className="pg-head-main">
          <div className="pg-title">
            <span className="pg-title-text">{title}</span>
            {count !== undefined ? <span className="pg-count">{count} 条</span> : null}
          </div>
          {desc ? <div className="pg-desc">{desc}</div> : null}
        </div>
        {actions ? <div className="pg-actions">{actions}</div> : null}
      </header>

      <section className="pg-surface">
        {bar ? <div className="pg-bar">{bar}</div> : null}
        <div className="pg-body">{children}</div>
        {dock ? <div className="pg-dock">{dock}</div> : null}
        {status ? <div className="pg-status">{status}</div> : null}
      </section>
    </div>
  );
}