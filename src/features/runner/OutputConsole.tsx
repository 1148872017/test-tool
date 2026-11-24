import React from 'react';
import type { RunnerLine } from './lineBuffer';

/**
 * 输出控制台。
 *
 * ============================================================
 * 为什么要单独抽组件 + memo
 * ============================================================
 * 一次构建几万行输出，代码改成 100ms 批处理之后，仍然会出现
 * 「每批 2000 行整列表 re-render」。这里做两层减法：
 *
 *   1. 外层 memo：lines 引用没变（比如只是 running 变了）就整块跳过；
 *   2. 每行再 memo：缓冲里的 RunnerLine 对象是稳定的（只有新行才是新对象），
 *      所以一批里真正需要渲染的只是「新增的那几行」，
 *      老行直接命中 memo，不重建 vnode。
 *
 * key 用 line.id（自增），不用数组下标 —— 环形缓冲会从头丢行，
 * 下标会整体前移，用下标当 key 会让 React 把每一行都当成新行重排。
 */
const Line = React.memo(function Line({ line }: { line: RunnerLine }) {
  return <span className={line.stream === 'stderr' ? 'runner-line-err' : ''}>{line.text}</span>;
});

type Props = {
  /** 环形缓冲的快照（最多 cap 行） */
  lines: RunnerLine[];
  running: boolean;
  /** 被丢掉的旧行数；> 0 时置顶提示，绝不假装输出完整 */
  dropped: number;
};

function OutputConsoleImpl({ lines, running, dropped }: Props) {
  return (
    <>
      {dropped > 0 ? (
        // sticky：滚动看历史输出时这行提示也跟着走，不会被滚没
        <span
          style={{
            position: 'sticky',
            top: 0,
            display: 'block',
            margin: '-4px 0 6px',
            padding: '2px 8px',
            borderRadius: 4,
            background: '#3a2c14',
            color: '#ffb74d',
            fontSize: 12
          }}
        >
          已丢弃前 {dropped} 行（只保留最近 {lines.length} 行，复制输出也只会复制这些）
        </span>
      ) : null}

      {lines.length ? (
        lines.map((line) => <Line key={line.id} line={line} />)
      ) : (
        <span className="muted">{running ? '运行中…' : '点「运行」看输出'}</span>
      )}
    </>
  );
}

const OutputConsole = React.memo(OutputConsoleImpl);

export default OutputConsole;