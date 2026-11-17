import React, { useMemo, useState } from 'react';
import { Modal, Input, Button } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { extractVars, fillVars } from '../utils';

type Props = {
  open: boolean;
  text: string;
  title?: string;
  onClose: () => void;
};

export default function VarFillModal({ open, text, title, onClose }: Props) {
  const vars = useMemo(() => extractVars(text), [text]);
  const [values, setValues] = useState<Record<string, string>>({});

  const copy = async () => {
    const filled = fillVars(text, values);
    await api.copy(filled, false);
    toast('已复制（变量已替换）');
    onClose();
  };

  return (
    <Modal
      open={open}
      title={title || '填充变量'}
      onCancel={onClose}
      width={560}
      footer={[
        <Button key="raw" onClick={async () => { await api.copy(text, false); toast('已复制原文'); onClose(); }}>
          复制原文
        </Button>,
        <Button key="ok" type="primary" icon={<CopyOutlined />} onClick={copy}>
          替换并复制
        </Button>
      ]}
    >
      {vars.length === 0 ? (
        <div className="muted">这段内容里没有 {'{{变量}}'}，可以直接复制。</div>
      ) : (
        <div>
          <div className="muted" style={{ marginBottom: 12 }}>
            检测到 {vars.length} 个变量，留空则保留原样。
          </div>
          {vars.map((name) => (
            <div key={name} style={{ marginBottom: 12 }}>
              <div className="kv-label mono">{'{{' + name + '}}'}</div>
              <Input
                value={values[name] || ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
                placeholder={'填写 ' + name + ' 的值'}
              />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}