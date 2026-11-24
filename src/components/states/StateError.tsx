import React, { useState } from 'react';
import { Button } from 'antd';
import { CloseCircleOutlined, DownOutlined, RightOutlined } from '@ant-design/icons';

/**
 * 就地错误条（不是空状态）。
 *
 * 和 StateEmpty 的分工：
 *   StateEmpty  → 这一块**本来就没有东西**（首次进入 / 筛不出来 / 目录没配）
 *   StateError  → 这一块**有旧东西，但这次没成功**：错误条压在上面，旧结果原样留着，
 *                 用户不会因为一次失败就丢掉上下文（P5：失败不要清屏）。
 *
 * 所以它必须做两件事，缺一件都会让用户困惑：
 *   1. 说清「下面看到的是上次的结果」—— 否则旧数据会被当成本次结果（v0.41.2 的老 bug 就是这个）
 *   2. 给「重试」，并且把原始错误折叠在「详情」里（默认不挡视线，排查时又有据可查）
 *
 * 样式在 styles.css 的 .state-error（左红 3px + #fff8f7 底）。
 */

export interface StateErrorProps {
  /** 一句话说清「这次没成功」 */
  message?: string;
  /** 折叠里的原始错误 / 后端 message / 排查线索 */
  detail?: string;
  /** 重试 */
  onRetry?: () => void;
  retryLabel?: string;
  /** 旧结果的时间说明，例如「下面还是 12:03 的结果」 */
  staleLabel?: React.ReactNode;
  style?: React.CSSProperties;
}

export default function StateError({
  message,
  detail,
  onRetry,
  retryLabel,
  staleLabel,
  style
}: StateErrorProps) {
  const [open, setOpen] = useState(false);

  return (
    <div role="alert" className="state-error" style={style}>
      <div className="state-error-head">
        <CloseCircleOutlined className="state-error-icon" />
        <span className="state-error-msg">{message || '这次没成功'}</span>
        {staleLabel ? <span className="state-error-stale">{staleLabel}</span> : null}
        <span className="state-error-spacer" />
        {onRetry ? (
          <Button size="small" type="primary" onClick={onRetry}>
            {retryLabel || '重试'}
          </Button>
        ) : null}
        {detail ? (
          <Button
            size="small"
            type="text"
            icon={open ? <DownOutlined /> : <RightOutlined />}
            onClick={() => setOpen((v) => !v)}
          >
            详情
          </Button>
        ) : null}
      </div>

      {detail && open ? <div className="state-error-detail mono">{detail}</div> : null}
    </div>
  );
}