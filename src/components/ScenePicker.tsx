import React, { useEffect, useMemo, useState } from 'react';
import { AutoComplete, Input, Tag, Button, Tooltip } from 'antd';
import { FileTextOutlined, ReloadOutlined } from '@ant-design/icons';
import api from '../api';

type Props = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** 只读模式（详情页展示用）：不显示输入框，只显示值 + 关联状态 */
  readOnly?: boolean;
};

/**
 * 场景 / 脚本 选择器。
 *
 * 两种来源：
 *   - **手填**：Apifox 测试场景名、临时脚本名
 *   - **从 jmx 索引选**：已导入的压测脚本（只读索引，不在数据库里）
 *
 * 交互：AutoComplete，输入时同时过滤 jmx 文件名；选中后填进输入框。
 * 如果填的值正好匹配某个 jmx 文件，旁边显示「已关联脚本」标签。
 */
export default function ScenePicker({ value, onChange, placeholder, readOnly }: Props) {
  const [jmxFiles, setJmxFiles] = useState<{ name: string; relPath: string; samplers: number }[]>([]);
  const [loading, setLoading] = useState(false);

  const loadJmx = async () => {
    setLoading(true);
    try {
      const res = await api.jmxScan();
      const files = (res && res.files) || [];
      setJmxFiles(
        files.map((f: any) => ({
          name: f.file || f.name || '',
          relPath: f.relPath || f.file || '',
          samplers: (f.samplers || []).length
        }))
      );
    } catch (e) {
      /* 扫描失败不影响手填 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJmx();
  }, []);

  const options = useMemo(() => {
    const kw = String(value || '').trim().toLowerCase();
    return jmxFiles
      .filter((f) => !kw || f.name.toLowerCase().includes(kw) || f.relPath.toLowerCase().includes(kw))
      .map((f) => ({
        value: f.name,
        label: (
          <div className="scene-option">
            <FileTextOutlined style={{ color: '#6c5ce7', marginRight: 6 }} />
            <span className="mono">{f.name}</span>
            <span className="muted" style={{ marginLeft: 8, fontSize: 11.5 }}>
              {f.samplers} 个采样器
            </span>
          </div>
        )
      }));
  }, [jmxFiles, value]);

  /** 当前值是否匹配某个 jmx 文件 */
  const matched = jmxFiles.find((f) => f.name === value);

  // 只读：只显示值和关联状态
  if (readOnly) {
    if (!value) return <span className="muted">—</span>;
    return (
      <span>
        <span className="mono">{value}</span>
        {matched ? (
          <Tag color="purple" style={{ marginLeft: 8 }}>
            已关联脚本 · {matched.samplers} 个采样器
          </Tag>
        ) : null}
      </span>
    );
  }

  return (
    <div className="scene-picker">
      <AutoComplete
        style={{ width: '100%' }}
        value={value}
        onChange={(v) => onChange(v)}
        options={options}
        placeholder={placeholder || 'Apifox 测试场景名，或从下面选已导入的 jmx'}
        allowClear
        notFoundContent={
          jmxFiles.length ? (
            <span className="muted" style={{ fontSize: 12, padding: 6 }}>
              没有匹配的 jmx 脚本，可以直接手填
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12, padding: 6 }}>
              还没导入 jmx 脚本（去「压测脚本」页配目录）
            </span>
          )
        }
      >
        <Input />
      </AutoComplete>

      <div className="scene-hint">
        {matched ? (
          <Tag color="purple" style={{ margin: 0 }}>
            已关联脚本 · {matched.samplers} 个采样器
          </Tag>
        ) : (
          <span className="muted" style={{ fontSize: 11.5 }}>
            手填场景名，或从下拉里选已导入的 jmx
          </span>
        )}
        <Tooltip title="重新扫描 jmx 目录">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={loadJmx}
            style={{ marginLeft: 6 }}
          />
        </Tooltip>
      </div>
    </div>
  );
}
