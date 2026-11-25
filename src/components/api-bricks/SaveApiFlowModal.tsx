import React from 'react';
import { Input, Modal } from 'antd';

/**
 * 「保存为流程」弹窗（接口版）。
 *
 * 只收两样东西：流程名 + 备注。步骤 / BaseUrl / 测试方法名都是当前拼装状态的快照，
 * 由积木区自己写进 flows 记录（kind: 'api'）。
 *
 * 和 ui-bricks/SaveFlowModal.tsx 一样刻意不写 hooks（状态在面板手里），
 * 这样测试可以直接把组件函数当纯函数调用。
 */
type Props = {
  open: boolean;
  name: string;
  note: string;
  /** 当前要保存几步（弹窗里说清楚「存的是什么」） */
  stepCount: number;
  /** BaseUrl 不是步骤，但存进流程后会影响生成结果，弹窗里提示一下 */
  baseUrl: string;
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

export default function SaveApiFlowModal(props: Props) {
  const { open, name, note, stepCount, baseUrl, error, onNameChange, onNoteChange, onCancel, onOk } =
    props;

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
          ' 步连同 BaseUrl' +
          (baseUrl ? '（' + baseUrl + '）' : '') +
          ' 一起存进「流程模板」，下次用工具条上的「载入流程」直接接着拼。'}
      </div>

      <div style={LABEL}>
        流程名<span style={{ color: '#cf1322' }}> *</span>
      </div>
      <Input
        value={name}
        placeholder="如：接口流程-1125"
        allowClear
        onChange={(e) => onNameChange(e.target.value)}
        onPressEnter={onOk}
      />

      <div style={{ ...LABEL, marginTop: 10 }}>备注</div>
      <Input.TextArea
        value={note}
        rows={3}
        placeholder="这条流程测什么、前置条件、跑的时候要注意什么…（选填）"
        onChange={(e) => onNoteChange(e.target.value)}
      />

      {error ? (
        <div style={{ color: '#cf1322', fontSize: 12, marginTop: 6 }}>{error}</div>
      ) : null}
    </Modal>
  );
}