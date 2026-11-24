import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Input, Button, Alert, Tag, Space } from 'antd';
import { ImportOutlined, WarningOutlined } from '@ant-design/icons';
import { parseCurl } from '../../shared/curl.js';

type Props = {
  open: boolean;
  onClose: () => void;
  /** 解析成功后回调，把结果交给 RecordForm 预填 */
  onImport: (parsed: any) => void;
};

const PLACEHOLDER = `curl 'https://api.example.com/v1/user' \\
  -H 'Content-Type: application/json' \\
  -d '{"id":1}'`;

export default function CurlImportModal({ open, onClose, onImport }: Props) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<any>(null);

  // 打开时清空
  useEffect(() => {
    if (open) {
      setText('');
      setParsed(null);
    }
  }, [open]);

  // 防抖解析
  useEffect(() => {
    if (!open) return;
    if (!text.trim()) {
      setParsed(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        setParsed(parseCurl(text));
      } catch (e: any) {
        setParsed({ ok: false, message: '解析出错：' + (e && e.message ? e.message : e) });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [text, open]);

  const warnings = (parsed && parsed.warnings) || [];
  const canImport = !!parsed && parsed.ok;

  const doImport = () => {
    if (!canImport) return;
    onImport(parsed);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="粘贴 cURL 导入"
      onCancel={onClose}
      width={720}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" icon={<ImportOutlined />} disabled={!canImport} onClick={doImport}>
            导入并填写表单
          </Button>
        </Space>
      }
    >
      <div className="curl-import">
        <div className="curl-hint">
          从 Chrome DevTools（右键 → Copy as cURL）、Postman（Code → cURL）、Apifox 复制的命令都可以粘贴。
        </div>

        <Input.TextArea
          className="mono"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
        />

        {parsed && !parsed.ok ? (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 12 }}
            message="解析失败"
            description={parsed.message}
          />
        ) : null}

        {canImport ? (
          <div className="curl-preview">
            <div className="curl-preview-title">解析结果</div>

            <div className="curl-row">
              <span className="curl-label">方法</span>
              <Tag color="blue">{parsed.method}</Tag>
            </div>

            <div className="curl-row">
              <span className="curl-label">URL</span>
              <span className="mono curl-value">{parsed.url || '（未解析出）'}</span>
            </div>

            <div className="curl-row">
              <span className="curl-label">名称</span>
              <span className="curl-value">{parsed.name || '（未解析出）'}</span>
            </div>

            <div className="curl-row">
              <span className="curl-label">请求头</span>
              <span className="curl-value">
                {parsed.headers ? `${parsed.headers.split('\n').length} 个` : '无'}
              </span>
            </div>

            <div className="curl-row">
              <span className="curl-label">请求体</span>
              <span className="curl-value">
                {parsed.body ? (
                  <>
                    <Tag>{parsed.bodyType}</Tag>
                    {parsed.body.length} 字符
                  </>
                ) : (
                  '无'
                )}
              </span>
            </div>

            {warnings.length ? (
              <Alert
                type="warning"
                showIcon
                icon={<WarningOutlined />}
                style={{ marginTop: 12 }}
                message={`有 ${warnings.length} 条提示`}
                description={
                  <ol className="curl-warn-list">
                    {warnings.map((w: any, i: number) => (
                      <li key={i}>{w.text}</li>
                    ))}
                  </ol>
                }
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
