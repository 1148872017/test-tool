import React from 'react';

/**
 * 骨架行：列表加载中的占位。
 *
 * 为什么不用裸 <Spin>：
 *   转圈会把整块内容顶掉，加载完再撑开 → 高度跳一下，视觉上「闪」。
 *   骨架行按**真实行高**铺好，加载结束时高度不变，页面不跳。
 *
 * 默认行高 38px：和 antd Table size="middle" 的行高一致，
 * 也接近 .cov-row / .issue-row 的视觉高度，所以列表场景可以直接顶上去。
 *
 * 样式在 styles.css 的 .loading-rows / .loading-row / .loading-bar；
 * 组件只保留两个动态值：行高（CSS 变量）和每行占位块宽度。
 */

export interface LoadingRowsProps {
  /** 行数，默认 6 */
  rows?: number;
  /** 每行占位块的宽度（px 或百分比字符串），默认按表格列宽给一组 */
  widths?: (number | string)[];
  /** 行高，默认 38（和表格行一致） */
  rowHeight?: number;
  /** 外层是否要卡片边框；放在已有面板里时传 false */
  bordered?: boolean;
  /** 屏幕阅读器文案 */
  label?: string;
  style?: React.CSSProperties;
}

const DEFAULT_WIDTHS: (number | string)[] = [44, '32%', '26%', '14%'];

export default function LoadingRows({
  rows = 6,
  widths = DEFAULT_WIDTHS,
  rowHeight = 38,
  bordered = true,
  label = '正在加载',
  style
}: LoadingRowsProps) {
  /** 默认 38px 由 styles.css 提供；只有调用方显式改行高时才写内联 */
  const customHeight = rowHeight !== 38 ? { height: rowHeight, minHeight: rowHeight } : undefined;

  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={'loading-rows' + (bordered ? '' : ' is-borderless')}
      style={style}
    >
      {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
        <div key={i} className="loading-row" style={customHeight}>
          {widths.map((w, j) => (
            <div
              key={j}
              className={'loading-bar' + ((i + j) % 3 === 0 ? ' is-alt' : '')}
              style={{ width: w }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}