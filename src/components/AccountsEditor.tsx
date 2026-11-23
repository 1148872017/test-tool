import React, { useEffect, useMemo, useState } from 'react';
import { Input, Button, Select, Tag, Tooltip, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, CopyOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { fieldOptions, getOptionsSync, loadOptions, OptionsMap } from '../options';
import { toast } from '../msg';

export type AccountRow = {
  label: string;
  account: string;
  password: string;
  role: string[];
  isDefault: boolean;
  note: string;
  /** 标签（和 note 二选一：填了标签就不填备注，反之亦然） */
  tags: string[];
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
        note: String(x.note || ''),
        tags: Array.isArray(x.tags) ? x.tags.map(String) : []
      }));
  } catch (e) {
    return [];
  }
}

/**
 * 序列化（**编辑时用，不过滤空行**）。
 *
 * 为什么不过滤：用户点「添加账号」时新行是全空的，
 * 过滤掉会导致「点了没反应」（行加不进去）—— 这个坑踩过两次（§11.2.6 #63 / #75）。
 *
 * 空账号的清理放在**保存时**（见 dropEmptyAccounts）。
 */
export function serializeAccounts(rows: AccountRow[]): string {
  if (!rows.length) return '';
  // 保证有且只有一个默认账号
  const out = rows.map((r) => Object.assign({}, r));
  const hasDefault = out.some((r) => r.isDefault);
  if (!hasDefault) out[0].isDefault = true;
  let seen = false;
  for (const r of out) {
    if (r.isDefault) {
      if (seen) r.isDefault = false;
      else seen = true;
    }
  }
  return JSON.stringify(out);
}

/**
 * 保存前清理：丢掉完全空的账号（label/account/password/role/note 全空）。
 * 只过滤「全空」的，填了任意一项就保留（用户可能只填了备注）。
 */
export function dropEmptyAccounts(raw: string): string {
  const rows = parseAccounts(raw);
  const clean = rows.filter(
    (r) =>
      String(r.label || '').trim() ||
      String(r.account || '').trim() ||
      String(r.password || '').trim() ||
      (Array.isArray(r.role) && r.role.length) ||
      (Array.isArray(r.tags) && r.tags.length) ||
      String(r.note || '').trim()
  );
  if (!clean.length) return '';
  return serializeAccounts(clean);
}

/** 角色 → 显示标签（显式表达，如「商家」「用户」） */
function RoleTags({ role, opts }: { role: string[]; opts: OptionsMap }) {
  if (!role || !role.length) return <span className="muted">—</span>;
  // 角色选项在「设置 → 选项配置」里维护，通过 fieldOptions 读
  const roleField = { key: 'role', optionsKey: 'role' };
  const list = fieldOptions(roleField as any, opts);
  return (
    <span className="role-tags">
      {role.map((v) => {
        const opt = list.find((o: any) => o.value === v);
        return (
          <Tag key={v} color={opt && opt.color ? opt.color : 'default'} style={{ margin: '0 4px 0 0' }}>
            {opt ? opt.label || v : v}
          </Tag>
        );
      })}
    </span>
  );
}

export default function AccountsEditor({ value, onChange, readOnly }: Props) {
  const rows = useMemo(() => parseAccounts(value), [value]);
  // 角色选项从配置读（设置 → 选项配置）
  const [opts, setOpts] = useState<OptionsMap>(getOptionsSync());
  useEffect(() => {
    loadOptions().then(setOpts).catch(() => {});
  }, []);
  const roleOptions = fieldOptions({ key: 'role', optionsKey: 'role' } as any, opts).map((o: any) => ({
    value: o.value,
    label: o.label || o.value
  }));
  // 标签选项（设置 → 选项配置里的 tags）
  const tagOptions = fieldOptions({ key: 'tags', optionsKey: 'tags' } as any, opts).map((o: any) => ({
    value: o.value,
    label: o.label || o.value
  }));

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
    update(rows.concat([{ label: '', account: '', password: '', role: [], isDefault: isFirst, note: '', tags: [] }]));
    toast('已添加一个账号，填完记得点「保存」');
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    // 删掉的是默认账号 → 把第一条设为默认
    if (rows[i].isDefault && next.length) next[0] = Object.assign({}, next[0], { isDefault: true });
    update(next);
    toast('已删除该账号，记得点「保存」');
  };

  const copyPassword = async (pwd: string) => {
    if (!pwd) {
      toast('这个账号没填密码', 'warning');
      return;
    }
    await (window as any).api.copy(pwd, true);
    toast('密码已复制，30 秒后自动清空');
  };

  // 只读：6 列表格（用途 / 账号 / 密码 / 角色 / 备注 / 默认）
  if (readOnly) {
    if (!rows.length) return <span className="muted">—</span>;
    return (
      <table className="jmx-table accounts-table">
        <thead>
          <tr>
            <th style={{ width: '16%' }}>用途</th>
            <th style={{ width: '18%' }}>账号</th>
            <th style={{ width: '10%' }}>密码</th>
            <th style={{ width: '22%' }}>角色</th>
            <th>备注 / 标签</th>
            <th style={{ width: '8%' }}>默认</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.label || <span className="muted">—</span>}</td>
              <td className="mono">{r.account || '—'}</td>
              <td>
                {r.password ? (
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    title="复制密码"
                    onClick={() => copyPassword(r.password)}
                  />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <RoleTags role={r.role} opts={opts} />
              </td>
              <td className="muted">
                {r.note ? (
                  r.note
                ) : r.tags && r.tags.length ? (
                  <span className="role-tags">
                    {r.tags.map((t) => (
                      <Tag key={t} style={{ margin: '0 4px 0 0' }}>
                        {t}
                      </Tag>
                    ))}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {r.isDefault ? (
                  <Tooltip title="默认账号（一键启动时用这个）">
                    <StarFilled style={{ color: '#f5a623' }} />
                  </Tooltip>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
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
                options={roleOptions}
                onChange={(v) => setCell(i, 'role', v)}
                style={{ width: '100%' }}
              />
            </div>
            <div className="account-field account-field-wide">
              <label>备注 / 标签</label>
              {/* 二选一：填了备注就不能选标签，选了标签就不能填备注 */}
              <div className="note-tag-row">
                <Input
                  size="small"
                  value={r.note}
                  placeholder="限制、注意事项…"
                  disabled={r.tags.length > 0}
                  onChange={(e) => setCell(i, 'note', e.target.value)}
                  style={{ flex: 1 }}
                />
                <Select
                  size="small"
                  mode="tags"
                  value={r.tags}
                  placeholder="或选标签"
                  disabled={String(r.note || '').trim().length > 0}
                  options={tagOptions}
                  onChange={(v) => setCell(i, 'tags', v)}
                  style={{ flex: 1 }}
                />
              </div>
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
