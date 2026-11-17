import React, { useEffect, useState } from 'react';
import { Button, Input, Select, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { invalidateOptions, loadOptions } from '../options';

const COLORS = [
  { value: 'green', label: '绿' },
  { value: 'gold', label: '黄' },
  { value: 'red', label: '红' },
  { value: 'blue', label: '蓝' },
  { value: 'purple', label: '紫' },
  { value: 'default', label: '灰' }
];

type EnvItem = { value: string; label: string; color?: string };

/**
 * 选项配置：环境 / 角色·权限 / 标签。
 * 环境的 value 是存进记录里的东西，只允许改显示名；新增项用显示名当 value。
 */
export default function OptionEditor() {
  const [env, setEnv] = useState<EnvItem[]>([]);
  const [role, setRole] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [newEnv, setNewEnv] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState('');

  const applyAll = async () => {
    const o = await loadOptions(true);
    setEnv((o.env || []) as EnvItem[]);
    setRole(o.role || []);
    setTags(o.tags || []);
  };

  useEffect(() => {
    applyAll().catch(() => {});
  }, []);

  const save = async (key: string, items: any[], label: string) => {
    setBusy(key);
    try {
      await api.saveOptions(key, items);
      invalidateOptions();
      await applyAll();
      toast(label + '已保存');
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy('');
    }
  };

  const addEnv = () => {
    const label = newEnv.trim();
    if (!label) return;
    if (env.some((x) => x.label === label || x.value === label)) {
      toast('已经有这个环境了', 'warning');
      return;
    }
    // value 用显示名：中文也没问题，筛选/关联都是按字符串比
    setEnv([...env, { value: label, label, color: 'default' }]);
    setNewEnv('');
  };

  const addString = (list: string[], setList: (v: string[]) => void, value: string, clear: () => void) => {
    const s = value.trim();
    if (!s) return;
    if (list.indexOf(s) >= 0) {
      toast('已经有这一项了', 'warning');
      return;
    }
    setList([...list, s]);
    clear();
  };

  return (
    <div>
      {/* 环境 */}
      <div className="opt-group">
        <div className="opt-group-head">
          <span>
            环境 <span className="muted">（{env.length}）</span>
          </span>
          <Button size="small" type="primary" ghost loading={busy === 'env'} onClick={() => save('env', env, '环境')}>
            保存
          </Button>
        </div>
        {env.map((item, i) => (
          <div className="opt-row" key={item.value}>
            <Input
              value={item.label}
              onChange={(e) => {
                const next = env.slice();
                next[i] = { ...item, label: e.target.value };
                setEnv(next);
              }}
              style={{ width: 200 }}
            />
            <Select
              size="small"
              value={item.color || 'default'}
              options={COLORS}
              onChange={(c) => {
                const next = env.slice();
                next[i] = { ...item, color: c };
                setEnv(next);
              }}
              style={{ width: 84 }}
            />
            <span className="opt-value mono muted" title="存进记录里的值，改显示名不影响它">
              {item.value}
            </span>
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              onClick={() => setEnv(env.filter((_, j) => j !== i))}
            />
          </div>
        ))}
        <div className="opt-row">
          <Input
            value={newEnv}
            placeholder="新增环境名称"
            style={{ width: 200 }}
            onChange={(e) => setNewEnv(e.target.value)}
            onPressEnter={addEnv}
          />
          <Button size="small" icon={<PlusOutlined />} onClick={addEnv}>
            添加
          </Button>
        </div>
      </div>

      {/* 角色 / 权限 */}
      <div className="opt-group">
        <div className="opt-group-head">
          <span>
            角色 / 权限 <span className="muted">（{role.length}）</span>
          </span>
          <Button size="small" type="primary" ghost loading={busy === 'role'} onClick={() => save('role', role, '角色')}>
            保存
          </Button>
        </div>
        <div className="opt-tags">
          {role.map((r, i) => (
            <Tag
              key={r}
              closable
              onClose={(e) => {
                e.preventDefault();
                setRole(role.filter((_, j) => j !== i));
              }}
            >
              {r}
            </Tag>
          ))}
          {!role.length ? <span className="muted" style={{ fontSize: 12 }}>还没有，新增记录时用过的角色会自动收进来</span> : null}
        </div>
        <div className="opt-row">
          <Input
            value={newRole}
            placeholder="新增角色，如：超管 / 只读"
            style={{ width: 240 }}
            onChange={(e) => setNewRole(e.target.value)}
            onPressEnter={() => addString(role, setRole, newRole, () => setNewRole(''))}
          />
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => addString(role, setRole, newRole, () => setNewRole(''))}
          >
            添加
          </Button>
        </div>
      </div>

      {/* 标签 */}
      <div className="opt-group">
        <div className="opt-group-head">
          <span>
            标签 <span className="muted">（{tags.length}）</span>
          </span>
          <Button size="small" type="primary" ghost loading={busy === 'tags'} onClick={() => save('tags', tags, '标签')}>
            保存
          </Button>
        </div>
        <div className="opt-tags">
          {tags.map((t, i) => (
            <Tag
              key={t}
              closable
              onClose={(e) => {
                e.preventDefault();
                setTags(tags.filter((_, j) => j !== i));
              }}
            >
              {t}
            </Tag>
          ))}
          {!tags.length ? <span className="muted" style={{ fontSize: 12 }}>还没有标签</span> : null}
        </div>
        <div className="opt-row">
          <Input
            value={newTag}
            placeholder="新增标签"
            style={{ width: 240 }}
            onChange={(e) => setNewTag(e.target.value)}
            onPressEnter={() => addString(tags, setTags, newTag, () => setNewTag(''))}
          />
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => addString(tags, setTags, newTag, () => setNewTag(''))}
          >
            添加
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          新增/编辑记录时手输的标签会自动加到这里，下次直接选
        </div>
      </div>
    </div>
  );
}
