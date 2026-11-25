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

/** 删除一个字符串选项前，用它数一下「还有多少条记录在用」 */
type UsageProbe = {
  collection: string;
  field: string;
  /** 提示文案：n 是正在用这个值的记录数 */
  text: (n: number) => string;
};

/**
 * 选项配置：环境 / 角色·权限 / 标签 / 接口模块 / 页面项目。
 * 环境的 value 是存进记录里的东西，只允许改显示名；新增项用显示名当 value。
 *
 * 接口模块和页面项目是「字符串选项集」：下拉候选 + 手输新值都算数，
 * 这里管的是候选列表本身 —— 删除 / 改名都不会改已有记录。
 */
export default function OptionEditor() {
  const [env, setEnv] = useState<EnvItem[]>([]);
  const [role, setRole] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [newEnv, setNewEnv] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newTag, setNewTag] = useState('');
  const [newModule, setNewModule] = useState('');
  const [newProject, setNewProject] = useState('');
  const [busy, setBusy] = useState('');

  const applyAll = async () => {
    const o = await loadOptions(true);
    setEnv((o.env || []) as EnvItem[]);
    setRole(o.role || []);
    setTags(o.tags || []);
    setModules(o.module || []);
    setProjects(o.project || []);
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

  /**
   * 数一下有多少条记录还在用这个值。
   * 只读：删选项时用来提示，绝不回头改用户的记录。
   */
  const countUsage = async (collection: string, field: string, value: string) => {
    try {
      const rows: any[] = (await api.records(collection)) || [];
      let n = 0;
      for (const r of rows) {
        const data = (r && r.data) || {};
        const raw = data[field];
        const v = raw === undefined || raw === null ? '' : String(raw);
        if (v.trim() === value) n++;
      }
      return n;
    } catch (e) {
      return 0;
    }
  };

  /**
   * 删除一个字符串选项。
   *
   * 只从选项集里移除，**不碰任何记录**：已经在用这个值的接口 / 页面保持原样，
   * 只是下拉里不再出现（值本身照常显示）。有记录在用时给个 toast 说清楚，
   * 否则用户会以为「删了选项 = 清空了字段」。
   */
  const removeStringOption = async (
    list: string[],
    setList: (v: string[]) => void,
    value: string,
    probe: UsageProbe
  ) => {
    setList(list.filter((x) => x !== value));
    const n = await countUsage(probe.collection, probe.field, value);
    if (n > 0) toast(probe.text(n), 'warning');
  };

  /**
   * 字符串选项集的通用管理区：一行一个（复用 opt-row），可改名、可删除，
   * 保存按钮按选项集各自 loading。接口模块 / 页面项目共用这段渲染。
   */
  const renderStringGroup = (cfg: {
    key: string;
    title: string;
    list: string[];
    setList: (v: string[]) => void;
    newValue: string;
    setNewValue: (v: string) => void;
    placeholder: string;
    emptyHint: string;
    probe: UsageProbe;
  }) => (
    <div className="opt-group">
      <div className="opt-group-head">
        <span>
          {cfg.title} <span className="muted">（{cfg.list.length}）</span>
        </span>
        <Button
          size="small"
          type="primary"
          ghost
          loading={busy === cfg.key}
          onClick={() => save(cfg.key, cfg.list, cfg.title)}
        >
          保存
        </Button>
      </div>
      {cfg.list.map((item, i) => (
        <div className="opt-row" key={i}>
          <Input
            value={item}
            onChange={(e) => {
              const next = cfg.list.slice();
              next[i] = e.target.value;
              cfg.setList(next);
            }}
            style={{ width: 240 }}
          />
          <Button
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => removeStringOption(cfg.list, cfg.setList, item, cfg.probe)}
          />
        </div>
      ))}
      {!cfg.list.length ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {cfg.emptyHint}
        </div>
      ) : null}
      <div className="opt-row">
        <Input
          value={cfg.newValue}
          placeholder={cfg.placeholder}
          style={{ width: 240 }}
          onChange={(e) => cfg.setNewValue(e.target.value)}
          onPressEnter={() => addString(cfg.list, cfg.setList, cfg.newValue, () => cfg.setNewValue(''))}
        />
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => addString(cfg.list, cfg.setList, cfg.newValue, () => cfg.setNewValue(''))}
        >
          添加
        </Button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        新增 / 编辑记录时手输的名字会自动收进来；改名等于换一个新值，已经在用的记录不会被改（仍显示原来的名字）
      </div>
    </div>
  );

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

      {/* 接口模块：接口记录里的「模块 / 目录」 */}
      {renderStringGroup({
        key: 'module',
        title: '接口模块',
        list: modules,
        setList: setModules,
        newValue: newModule,
        setNewValue: setNewModule,
        placeholder: '新增模块，如：订单 / 退款',
        emptyHint: '还没有模块，新增 / 编辑接口时手输的模块名会自动收进来',
        probe: {
          collection: 'apis',
          field: 'module',
          // 用户最怕「删了选项 = 清空字段」：明确说记录不会被改
          text: (n: number) => `有 ${n} 条接口用了这个模块，删除选项不会改它们的值`
        }
      })}

      {/* 页面项目：页面元素里的「所属项目」 */}
      {renderStringGroup({
        key: 'project',
        title: '页面项目',
        list: projects,
        setList: setProjects,
        newValue: newProject,
        setNewValue: setNewProject,
        placeholder: '新增项目，如：OTA-automation',
        emptyHint: '还没有项目，新增 / 编辑页面元素时手输的项目名会自动收进来',
        probe: {
          collection: 'pages',
          field: 'project',
          text: (n: number) => `有 ${n} 个页面用了这个项目，删除选项不会改它们的值`
        }
      })}
    </div>
  );
}