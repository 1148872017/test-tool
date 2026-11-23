import React, { useMemo } from 'react';
import { Input, Button, Select, Tag, Tooltip, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, CopyOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { ROLE_OPTIONS } from '../../shared/collections';
import { toast } from '../msg';

export type AccountRow = {
  label: string;
  account: string;
  password: string;
  role: string[];
  isDefault: boolean;
  note: string;
};

type Props = {
  /** 存储值：JSON 字符串 `[{label,account,password,role,isDefault,note}]` */
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
};

/** 解析存储值 */
export function parseAccounts(raw: string): AccountRow[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        label: String(x.label || ''),
        account: String(x.account || ''),
        password: String(x.password || ''),
        role: Array.isArray(x.role) ? x.role.map(String) : [],
        isDefault: !!x.isDefault,
        note: String(x.note || '')
      }));
  } catch (e) {
    return [];
  }
}

/** 序列化 */
export function serializeAccounts(rows: AccountRow[]): string {
  if (!rows.length) return '';
  return JSON.stringify(rows);
}

/** 角色 → 显示标签（显式表达，如「商家」「用户」） */
function RoleTags({ role }: { role: string[] }) {
  if (!role || !role.length) return <span className="muted">—</span>;
  return (
    <span className="role-tags">
      {role.map((v) => {
        const opt = ROLE_OPTIONS.find((o: any) => o.value === v);
        return (
          <Tag key={v} color={opt && opt.color ? opt.color : 'default'} style={{ margin: '0 4px 0 0' }}>
            {opt ? opt.label : v}
          </Tag>
        );
      })}
    </span>
  );
}

export default function AccountsEditor({ value, onChange, readOnly }: Props) {
  const rows = useMemo(() => parseAccounts(value), [value]);

  const update = (next: AccountRow[]) => onChange(serializeAccounts(next));

  const setCell = (i: number, key: keyof AccountRow, v: any) => {
    const next = rows.slice();
    next[i] = Object.assign({}, next[i], { [key]: v });
    update(next);
  };

  /** 设为默认（互斥：只能有一个） */
  const setDefault = (i: number) => {
    const next = rows.map((r, idx) => Object.assign({}, r, { isDefault: idx === i }));
    update(next);
  };

  const addRow = () => {
    // 第一条自动设为默认
    const isFirst = rows.length === 0;
    update(rows.concat([{ label: '', account: '', password: '', role: [], isDefault: isFirst, note: '' }]));
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    // 删掉的是默认账号 → 把第一条设为默认
    if (rows[i].isDefault && next.length) next[0] = Object.assign({}, next[0], { isDefault: true });
    update(next);
  };

  const copyPassword = async (pwd: string) => {
    if (!pwd) {
      toast('这个账号没填密码', 'warning');
      return;
    }
    await (window as any).api.copy(pwd, true);
    toast('密码已复制，30 秒后自动清空');
  };

  // 只读：表格展示
  if (readOnly) {
    if (!rows.length) return <span className="muted">—</span>;
    return (
      <table className="jmx-table accounts-table">
        <thead>
          <tr>
            <th style={{ width: '18%' }}>用途</th>
            <th style={{ width: '22%' }}>账号</th>
            <th style={{ width: '20%' }}>角色</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                {r.isDefault ? (
                  <Tooltip title="默认账号（一键启动时用这个）">
                    <StarFilled style={{ color: '#f5a623', marginRight: 4 }} />
                  </Tooltip>
                ) : null}
                {r.label || <span className="muted">—</span>}
              </td>
              <td className="mono">
                {r.account || '—'}
                {r.password ? (
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    title="复制密码"
                    onClick={() => copyPassword(r.password)}
                    style={{ marginLeft: 4 }}
                  />
                ) : null}
              </td>
              <td>
                <RoleTags role={r.role} />
              </td>
              <td className="muted">{r.note || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // 编辑：卡片式（每行一个账号，字段多，表格塞不下）
  return (
    <div className="accounts-editor">
      {rows.map((r, i) => (
        <div className="account-card" key={i}>
          <div className="account-card-head">
            <Checkbox
              checked={r.isDefault}
              onChange={() => setDefault(i)}
              disabled={r.isDefault}
            >
              {r.isDefault ? (
                <span style={{ color: '#f5a623' }}>
                  <StarFilled /> 默认账号
                </span>
              ) : (
                <span className="muted">设为默认</span>
              )}
            </Checkbox>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeRow(i)}
            />
          </div>

          <div className="account-card-body">
            <div className="account-field">
              <label>用途</label>
              <Input
                size="small"
                value={r.label}
                placeholder="如：管理员 / 商家 / 普通用户"
                onChange={(e) => setCell(i, 'label', e.target.value)}
              />
            </div>
            <div className="account-field">
              <label>账号</label>
              <Input
                size="small"
                value={r.account}
                placeholder="登录账号"
                onChange={(e) => setCell(i, 'account', e.target.value)}
              />
            </div>
            <div className="account-field">
              <label>密码</label>
              <Input.Password
                size="small"
                value={r.password}
                placeholder="登录密码"
                onChange={(e) => setCell(i, 'password', e.target.value)}
              />
            </div>
            <div className="account-field account-field-wide">
              <label>角色</label>
              <Select
                size="small"
                mode="multiple"
                value={r.role}
                placeholder="可多选，选项在「设置 → 选项配置」里维护"
                options={ROLE_OPTIONS.map((o: any) => ({ value: o.value, label: o.label }))}
                onChange={(v) => setCell(i, 'role', v)}
                style={{ width: '100%' }}
              />
            </div>
            <div className="account-field account-field-wide">
              <label>备注</label>
              <Input
                size="small"
                value={r.note}
                placeholder="限制、注意事项…"
                onChange={(e) => setCell(i, 'note', e.target.value)}
              />
            </div>
          </div>
        </div>
      ))}

      {!rows.length ? (
        <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
          还没有账号。点下面「添加账号」，一个站点可以有多个账号（管理员 / 商家 / 普通用户…）
        </div>
      ) : null}

      <Button size="small" type="link" icon={<PlusOutlined />} onClick={addRow}>
        添加账号
      </Button>
    </div>
  );
}
