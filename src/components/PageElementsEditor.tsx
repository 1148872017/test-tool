import React, { useMemo, useState } from 'react';
import { Button, Input, Space, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';

/** 一个页面元素 */
export type PageElement = { name: string; selector: string; desc: string };

/**
 * 解析 elements 字段。
 *
 * 兼容两种格式：
 *   1. JSON 数组：[{"name":"usernameInput","selector":"#username","desc":"用户名"}]
 *   2. 多行文本（旧格式）：usernameInput = #username
 * 空行和残缺行直接跳过，不报错。
 */
export function parseElements(raw: any): PageElement[] {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return [];

  // 先试 JSON
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({
            name: String(x.name || ''),
            selector: String(x.selector || ''),
            desc: String(x.desc || '')
          }));
      }
    } catch (e) {
      /* 落到文本解析 */
    }
  }

  // 文本格式：每行 "name = selector"（等号也支持中文冒号 / 冒号）
  const out: PageElement[] = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out.push({
      name: t.slice(0, i).trim(),
      selector: t.slice(i + 1).trim(),
      desc: ''
    });
  }
  return out;
}

/** 序列化成 JSON（保存用） */
export function serializeElements(list: PageElement[]): string {
  const clean = list
    .filter((x) => String(x.name || '').trim())
    .map((x) => ({
      name: String(x.name).trim(),
      selector: String(x.selector || '').trim(),
      desc: String(x.desc || '').trim()
    }));
  if (!clean.length) return '';
  return JSON.stringify(clean);
}

/** 保存前丢掉完全空的行（编辑路径不过滤，保存时才过滤） */
export function dropEmptyElements(raw: any): string {
  return serializeElements(parseElements(raw));
}

type Props = {
  value: any;
  onChange: (next: string) => void;
  placeholder?: string;
};

/**
 * 页面元素编辑器：表格形式维护「名称 + 定位器 + 说明」。
 *
 * 规划要求「在平台里**可视化**维护页面元素名称和定位器」，
 * 所以不能用 textarea 让用户手写，得是表格。
 */
export default function PageElementsEditor({ value, onChange, placeholder }: Props) {
  /**
   * 内部维护草稿，避免「边输边序列化」导致光标跳动。
   * 每次改动：更新草稿 + 通知上层（序列化后的字符串）。
   */
  const initial = useMemo(() => parseElements(value), []);
  const [rows, setRows] = useState<PageElement[]>(initial.length ? initial : [{ name: '', selector: '', desc: '' }]);

  const commit = (next: PageElement[]) => {
    setRows(next);
    onChange(serializeElements(next));
  };

  const setRow = (i: number, key: keyof PageElement, v: string) => {
    const next = rows.slice();
    next[i] = Object.assign({}, next[i], { [key]: v });
    commit(next);
  };

  const addRow = () => commit(rows.concat([{ name: '', selector: '', desc: '' }]));

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    commit(next.length ? next : [{ name: '', selector: '', desc: '' }]);
  };

  const filled = rows.filter((r) => r.name.trim()).length;

  return (
    <div className="page-elements-editor">
      <table className="jmx-table pe-table">
        <thead>
          <tr>
            <th style={{ width: '26%' }}>名称</th>
            <th style={{ width: '38%' }}>定位器</th>
            <th>说明</th>
            <th style={{ width: 34 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <Input
                  size="small"
                  className="mono"
                  value={r.name}
                  placeholder="usernameInput"
                  onChange={(e) => setRow(i, 'name', e.target.value)}
                />
              </td>
              <td>
                <Input
                  size="small"
                  className="mono"
                  value={r.selector}
                  placeholder="#username / [data-testid=xxx]"
                  onChange={(e) => setRow(i, 'selector', e.target.value)}
                />
              </td>
              <td>
                <Input
                  size="small"
                  value={r.desc}
                  placeholder="用户名输入框"
                  onChange={(e) => setRow(i, 'desc', e.target.value)}
                />
              </td>
              <td>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => removeRow(i)}
                  title="删除这行"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Space size={8} style={{ marginTop: 6 }}>
        <Button size="small" type="link" icon={<PlusOutlined />} onClick={addRow}>
          添加元素
        </Button>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {filled ? `${filled} 个元素` : placeholder || '至少填一个'}
        </span>
        <Tag style={{ fontSize: 11 }}>定位器优先用 data-testid</Tag>
      </Space>
    </div>
  );
}