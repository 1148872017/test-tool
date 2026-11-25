import React from 'react';
import { Tooltip } from 'antd';
import { elementsTipLines } from './brickHelpers';

/**
 * 给「N 个元素」加 hover 提示：每行一个元素，格式 `名称 · 定位方式`。
 *
 * 用户原话：「积木库选定页面元素后，【n个元素】可以增加hover提示」。
 * 光看「4 个元素」不知道到底是哪 4 个，得回头翻「页面元素」页 —— 所以直接列出来。
 *
 * 为什么 title 传 React 节点而不是字符串：
 *   antd Tooltip 默认 `white-space: nowrap`，字符串里的 \n 根本不换行，
 *   会挤成一长条。这里一个元素一个 div，天然一行一个；
 *   外面再留 pre-line，万一以后改成字符串也能换行。
 *
 * 没有元素（没选页面 / 页面里一行都没填名字）时**不包 Tooltip**：
 * 空提示框比没有提示更让人困惑。
 */
type Props = {
  /** 当前页面的元素（只认填了名字的） */
  elements: any[];
  children: React.ReactNode;
};

export default function ElementCountTip({ elements, children }: Props) {
  const lines = elementsTipLines(elements);
  if (!lines.length) return <>{children}</>;

  const title = (
    <div style={{ whiteSpace: 'pre-line', lineHeight: 1.7, fontSize: 12 }}>
      {lines.map((line, i) => (
        <div key={i} className="mono">
          {line}
        </div>
      ))}
    </div>
  );

  return (
    <Tooltip title={title} placement="bottomLeft" styles={{ root: { maxWidth: 320 } }}>
      {children}
    </Tooltip>
  );
}