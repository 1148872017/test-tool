import React, { useMemo, useState } from 'react';
import { Modal, Input, Button, Alert } from 'antd';
import { CopyOutlined, CheckCircleOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { extractVars, fillVars } from '../utils';
import { parseVars } from './VarsEditor';

type Props = {
  open: boolean;
  /** 原始文本（含 {{var}} 占位符） */
  text: string;
  title?: string;
  /** 变量说明（JSON 字符串或旧文本格式），用来预填默认值和说明 */
  varsRaw?: string;
  onClose: () => void;
};

/**
 * 变量填充弹窗。
 *
 * 两个视图：
 *   - 上方：变量输入表格（变量名 / 值 / 说明），值可编辑
 *   - 下方：拼接后的完整预览，**变量位置标红**（未填的）或标绿（已填的）
 */
export default function VarFillModal({ open, text, title, varsRaw, onClose }: Props) {
  const varNames = useMemo(() => extractVars(text), [text]);
  const meta = useMemo(() => {
    const rows = parseVars(varsRaw || '');
    const map: Record<string, { value: string; desc: string }> = {};
    for (const r of rows) map[r.name] = { value: r.value, desc: r.desc };
    return map;
  }, [varsRaw]);

  const [values, setValues] = useState<Record<string, string>>({});
  /** 第一个变量位置的 ref，弹窗打开后滚到它 */
  const firstVarRef = React.useRef<HTMLSpanElement | null>(null);
  const previewRef = React.useRef<HTMLPreElement | null>(null);

  // 打开时用 varsRaw 里的默认值预填
  React.useEffect(() => {
    if (!open) return;
    const init: Record<string, string> = {};
    for (const n of varNames) {
      init[n] = (meta[n] && meta[n].value) || '';
    }
    setValues(init);
  }, [open, varNames, meta]);

  // 打开后把预览框滚到第一个变量（代码可能很长，变量在下面看不到）
  React.useEffect(() => {
    if (!open) return;
    // 等 DOM 渲染完再滚
    const timer = setTimeout(() => {
      const el = firstVarRef.current;
      const box = previewRef.current;
      if (!el || !box) return;
      // 让变量出现在预览框上方 1/3 处，而不是贴顶
      const top = el.offsetTop - box.clientHeight / 3;
      box.scrollTop = Math.max(0, top);
    }, 120);
    return () => clearTimeout(timer);
  }, [open, text]);

  const filled = useMemo(() => fillVars(text, values), [text, values]);

  /** 未填的变量数 */
  const missing = varNames.filter((n) => !values[n]).length;

  const copy = async () => {
    await api.copy(filled, false);
    toast('已复制（变量已替换）');
    onClose();
  };

  /** 把预览文本按 {{var}} 切段，标出变量位置 */
  const renderPreview = () => {
    const parts: React.ReactNode[] = [];
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    let firstVarDone = false;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(<span key={`t${i++}`}>{text.slice(last, m.index)}</span>);
      const name = m[1];
      const v = values[name];
      const isFilled = v !== undefined && v !== '';
      // 第一个变量挂 ref，弹窗打开后滚到它
      const isFirst = !firstVarDone;
      if (isFirst) firstVarDone = true;
      parts.push(
        <span
          key={`v${i++}`}
          ref={isFirst ? firstVarRef : undefined}
          className={isFilled ? 'var-chip filled' : 'var-chip missing'}
        >
          {isFilled ? v : `{{${name}}}`}
        </span>
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(<span key={`t${i++}`}>{text.slice(last)}</span>);
    return parts;
  };

  return (
    <Modal
      open={open}
      title={title || '填充变量'}
      onCancel={onClose}
      width={720}
      footer={[
        <Button
          key="raw"
          onClick={async () => {
            await api.copy(text, false);
            toast('已复制原文');
            onClose();
          }}
        >
          复制原文
        </Button>,
        <Button key="ok" type="primary" icon={<CopyOutlined />} onClick={copy}>
          替换并复制
        </Button>
      ]}
    >
      {varNames.length === 0 ? (
        <Alert type="info" showIcon message="这段文本里没有 {{变量}} 占位符，可以直接复制。" />
      ) : (
        <>
          <div className="var-fill-head">
            <span>
              共 <b>{varNames.length}</b> 个变量
              {missing ? (
                <span style={{ color: '#e5534b', marginLeft: 8 }}>
                  {missing} 个未填
                </span>
              ) : (
                <span style={{ color: '#2e9e5b', marginLeft: 8 }}>
                  <CheckCircleOutlined /> 全部已填
                </span>
              )}
            </span>
          </div>

          <table className="jmx-table vars-table">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>变量名</th>
                <th style={{ width: '32%' }}>值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {varNames.map((n) => (
                <tr key={n}>
                  <td className="mono">
                    <span className="var-name-chip">{`{{${n}}}`}</span>
                  </td>
                  <td>
                    <Input
                      size="small"
                      value={values[n] || ''}
                      placeholder={(meta[n] && meta[n].value) || '填值'}
                      onChange={(e) => setValues((prev) => Object.assign({}, prev, { [n]: e.target.value }))}
                    />
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {(meta[n] && meta[n].desc) || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="var-preview-head">拼接后预览</div>
          <pre className="var-preview mono" ref={previewRef}>{renderPreview()}</pre>
        </>
      )}
    </Modal>
  );
}
