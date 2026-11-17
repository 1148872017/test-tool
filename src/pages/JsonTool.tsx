import React, { useState } from 'react';
import { Input, Button, Space, Alert, Tag } from 'antd';
import { CopyOutlined, FormatPainterOutlined, CompressOutlined, CheckCircleOutlined, ClearOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

export default function JsonTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  const run = (mode: string) => {
    setError('');
    const text = input;
    if (!text.trim()) {
      toast('先粘贴点内容', 'warning');
      return;
    }
    try {
      if (mode === 'format') {
        setOutput(JSON.stringify(JSON.parse(text), null, 2));
      } else if (mode === 'minify') {
        setOutput(JSON.stringify(JSON.parse(text)));
      } else if (mode === 'check') {
        JSON.parse(text);
        toast('JSON 合法 ✓');
      } else if (mode === 'escape') {
        setOutput(JSON.stringify(text).slice(1, -1));
      } else if (mode === 'unescape') {
        const trimmed = text.replace(/^"|"$/g, '');
        setOutput(JSON.parse('"' + trimmed.replace(/"/g, '\\"') + '"'));
      }
    } catch (e: any) {
      setError('处理失败：' + (e && e.message ? e.message : e));
    }
  };

  const copyOut = async () => {
    if (!output) {
      toast('输出为空', 'warning');
      return;
    }
    await api.copy(output, false);
    toast('已复制');
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">JSON 转化</div>
          <div className="page-desc">格式化、压缩、转义、合法性校验，不会上传任何内容</div>
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <Space wrap>
          <Button type="primary" icon={<FormatPainterOutlined />} onClick={() => run('format')}>
            格式化
          </Button>
          <Button icon={<CompressOutlined />} onClick={() => run('minify')}>
            压缩
          </Button>
          <Button icon={<CheckCircleOutlined />} onClick={() => run('check')}>
            校验
          </Button>
          <Button onClick={() => run('escape')}>转义为字符串</Button>
          <Button onClick={() => run('unescape')}>去转义</Button>
          <Button icon={<ClearOutlined />} onClick={() => { setInput(''); setOutput(''); setError(''); }}>
            清空
          </Button>
        </Space>
      </div>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      <div className="tool-grid">
        <div className="tool-card">
          <div className="tool-card-title">
            输入
            <Tag style={{ marginLeft: 'auto', fontSize: 11 }}>{input.length} 字符</Tag>
          </div>
          <Input.TextArea
            className="code-area"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoSize={{ minRows: 18, maxRows: 30 }}
            placeholder='{"orderNo": "SO202610280001", "amount": 99.9}'
          />
        </div>
        <div className="tool-card">
          <div className="tool-card-title">
            输出
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Tag style={{ fontSize: 11 }}>{output.length} 字符</Tag>
              <Button size="small" icon={<CopyOutlined />} onClick={copyOut}>
                复制
              </Button>
            </span>
          </div>
          <Input.TextArea
            className="code-area"
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            autoSize={{ minRows: 18, maxRows: 30 }}
            placeholder="结果会出现在这里"
          />
        </div>
      </div>
    </div>
  );
}