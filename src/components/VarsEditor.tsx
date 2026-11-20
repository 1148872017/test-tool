import React, { useMemo } from 'react';
import { Input, Button } from 'antd';
import { PlusOutlined, DeleteOutlined, ImportOutlined } from '@ant-design/icons';
import { toast } from '../msg';

type Row = { name: string; value: string; desc: string };

type Props = {
  /** 存储值：JSON 字符串 `[{name,value,desc}]`，或旧的纯文本格式 */
  value: string;
  onChange: (next: string) => void;
  /** 只读模式（详情页展示用） */
  readOnly?: boolean;
  /** SQL 原文，用来「从 SQL 提取」变量 */
  sqlText?: string;
};

/**
 * 变量说明表格（可编辑）。
 *
 * 存储格式：JSON 字符串 `[{"name":"orderNo","value":"","desc":"订单号"}]`
 * 兼容旧格式：纯文本 `{{orderNo}} = 订单号；{{today}} = 今天`
 *   → 解析成 [{name:'orderNo', value:'', desc:'订单号'}, ...]
 */
export function parseVars(raw: string): Row[] {
  const text = String(raw || '').trim();
  if (!text) return [];

  // 新格式：JSON 数组
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        return arr
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({
            name: String(x.name || ''),
            value: String(x.value || ''),
            desc: String(x.desc || '')
          }));
      }
    } catch (e) {
      /* 不是合法 JSON，走旧格式 */
    }
  }

  // 旧格式：`{{a}} = 说明；{{b}} = 说明2`
  const rows: Row[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}\s*=\s*([^；;\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    rows.push({ name: m[1].trim(), value: '', desc: m[2].trim() });
  }
  // 兜底：只有 `{{a}}` 没有 `=` 的，也收进来
  if (!rows.length) {
    const re2 = /\{\{\s*([^{}]+?)\s*\}\}/g;
    const seen = new Set<string>();
    while ((m = re2.exec(text))) {
      const n = m[1].trim();
      if (!seen.has(n)) {
        seen.add(n);
        rows.push({ name: n, value: '', desc: '' });
      }
    }
  }
  return rows;
}

/**
 * 序列化成存储格式。
 *
 * **不做任何过滤**——用户点「添加变量」时新行是全空的，
 * 过滤掉会导致「点了没反应」（行加不进去）。
 * 空行留着，用户接着填就行；保存时后端也不介意。
 */
export function serializeVars(rows: Row[]): string {
  if (!rows.length) return '';
  return JSON.stringify(rows);
}

export default function VarsEditor({ value, onChange, readOnly, sqlText }: Props) {
  const rows = useMemo(() => parseVars(value), [value]);

  const update = (next: Row[]) => onChange(serializeVars(next));

  const setCell = (i: number, key: keyof Row, v: string) => {
    const next = rows.slice();
    next[i] = Object.assign({}, next[i], { [key]: v });
    update(next);
  };

  const addRow = () => update(rows.concat([{ name: '', value: '', desc: '' }]));

  const removeRow = (i: number) => update(rows.filter((_, idx) => idx !== i));

  /** 从 SQL 里提取 {{var}}，补进表格（已有的保留说明） */
  const extractFromSql = () => {
    const text = String(sqlText || '');
    const found: string[] = [];
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const n = m[1].trim();
      if (n && !found.includes(n)) found.push(n);
    }
    if (!found.length) {
      return { added: 0, total: 0 };
    }
    const existing = new Map(rows.map((r) => [r.name, r]));
    const next = found.map((n) => existing.get(n) || { name: n, value: '', desc: '' });
    // 保留用户手动加的、SQL 里没有的行
    for (const r of rows) {
      if (r.name && !found.includes(r.name)) next.push(r);
    }
    update(next);
    return { added: found.filter((n) => !existing.has(n)).length, total: found.length };
  };

  if (readOnly) {
    if (!rows.length) return <span className="muted">—</span>;
    return (
      <table className="jmx-table">
        <thead>
          <tr>
            <th>变量名</th>
            <th>值</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono">{r.name || '—'}</td>
              <td className="mono">{r.value || '—'}</td>
              <td className="muted">{r.desc || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="vars-editor">
      <table className="jmx-table vars-table">
        <thead>
          <tr>
            <th style={{ width: '28%' }}>变量名</th>
            <th style={{ width: '24%' }}>值（可选）</th>
            <th>说明</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <Input
                  size="small"
                  value={r.name}
                  placeholder="orderNo"
                  onChange={(e) => setCell(i, 'name', e.target.value)}
                />
              </td>
              <td>
                <Input
                  size="small"
                  value={r.value}
                  placeholder="默认值"
                  onChange={(e) => setCell(i, 'value', e.target.value)}
                />
              </td>
              <td>
                <Input
                  size="small"
                  value={r.desc}
                  placeholder="订单号"
                  onChange={(e) => setCell(i, 'desc', e.target.value)}
                />
              </td>
              <td>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => removeRow(i)}
                />
              </td>
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td colSpan={4} className="muted" style={{ fontSize: 12, padding: '8px 10px' }}>
                还没有变量。点下面「添加变量」，或在 SQL 里写 {'{{orderNo}}'} 后点「从 SQL 提取」
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
        <Button size="small" type="link" icon={<PlusOutlined />} onClick={addRow}>
          添加变量
        </Button>
        {sqlText !== undefined ? (
          <Button
            size="small"
            type="link"
            icon={<ImportOutlined />}
            onClick={() => {
              const r = extractFromSql();
              if (!r.total) {
                toast('SQL 里没有 {{变量}} 占位符', 'warning');
              } else {
                toast(`从 SQL 提取 ${r.total} 个变量${r.added ? `（新增 ${r.added} 个）` : ''}`);
              }
            }}
          >
            从 SQL 提取
          </Button>
        ) : null}
      </div>
    </div>
  );
}
