import React from 'react';
import { Input, Modal } from 'antd';

/**
 * 「保存为流程」弹窗。
 *
 * 只收两样东西：流程名 + 备注。步骤 / POM 配置 / 页面都是当前拼装状态的快照，
 * 由积木区自己写进 flows 记录 —— 让用户手填 JSON 是反人类的。
 *
 * 和 ActionParamModal 一样刻意不写 hooks（状态在 BricksPanel 手里），
 * 这样测试可以直接把组件函数当纯函数调用。
 */
type Props = {
  open: boolean;
  name: string;
  note: string;
  /** 当前要保存几步（弹窗里说清楚「存的是什么」） */
  stepCount: number;
  error: string;
  onNameChange: (v: string) => void;
  onNoteChange: (v: string) => void;
  onCancel: () => void;
  onOk: () => void;
};

const LABEL: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#4a5165',
  marginBottom: 3
};

export default function SaveFlowModal(props: Props) {
  const { open, name, note, stepCount, error, onNameChange, onNoteChange, onCancel, onOk } = props;

  return (
    <Modal
      open={open}
      title="保存为流程"
      okText="保存"
      cancelText="取消"
      onOk={onOk}
      onCancel={onCancel}
      width={480}
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
        {'把当前 ' +
          stepCount +
          ' 步连同页面、POM 配置一起存进「流程模板」，下次用工具条上的「载入流程」直接接着拼。'}
      </div>

      <div style={LABEL}>
        流程名<span style={{ color: '#cf1322' }}> *</span>
      </div>
      <Input
        value={name}
        placeholder="如：登录页流程-1125"
        allowClear
        onChange={(e) => onNameChange(e.target.value)}
        onPressEnter={onOk}
      />

      <div style={{ ...LABEL, marginTop: 10 }}>备注</div>
      <Input.TextArea
        value={note}
        rows={3}
        placeholder="这个流程测什么、前置条件、跑的时候要注意什么…（选填）"
        onChange={(e) => onNoteChange(e.target.value)}
      />

      {error ? (
        <div style={{ color: '#cf1322', fontSize: 12, marginTop: 6 }}>{error}</div>
      ) : null}
    </Modal>
  );
}