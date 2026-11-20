import React, { useEffect, useState } from 'react';
import { Drawer, Button, Tag, Space, Popconfirm } from 'antd';
import {
  CopyOutlined,
  EditOutlined,
  DeleteOutlined,
  ExportOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  StarFilled,
  LinkOutlined,
  FileTextOutlined,
  CloseOutlined
} from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import api from '../api';
import { toast } from '../msg';
import { buildCurl, fmtTime, recordToText } from '../utils';
import JsonTableToggle from './JsonTableToggle';
import VarsEditor from './VarsEditor';
import MetricsTable from './MetricsTable';
import ScenePicker from './ScenePicker';
import { caseKey, knownCaseKeys, loadCaseIndex } from '../caseIndex';
import { matchOnlyFor, recentForApi, resultTone, runLine } from '../../shared/runs';
import VarFillModal from './VarFillModal';
import CaseLinkModal from './CaseLinkModal';
import { asArray, fieldOptions, getOptionsSync, loadOptions, OptionsMap } from '../options';

marked.setOptions({ gfm: true, breaks: true });

type Props = {
  record: any;
  conf: any;
  linkMap: Record<string, string>;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
  onLogRun?: (record: any) => void;
};

export default function RecordDetail({ record, conf, linkMap, onClose, onEdit, onDeleted, onLogRun }: Props) {
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [varOpen, setVarOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linkRows, setLinkRows] = useState<any[]>([]);
  const [staleIds, setStaleIds] = useState<number[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  // 这个接口最近跑过的几次（接口测试 / 压测都算一个「执行」）
  const [runs, setRuns] = useState<any[]>([]);
  const [opts, setOpts] = useState<OptionsMap>(getOptionsSync());

  const isApis = conf.key === 'apis';
  const recordId = record ? record.id : '';

  useEffect(() => {
    loadOptions().then(setOpts).catch(() => {});
  }, []);

  /** 读这个接口挂的用例；顺带标出目录里已经找不到的（用例改名/删除），只做灰字，不报警 */
  const reloadLinks = async () => {
    if (!isApis || !recordId) return;
    try {
      const rows = (await api.linksForApi(recordId)) || [];
      setLinkRows(rows);
      try {
        const known = knownCaseKeys(await loadCaseIndex());
        setStaleIds(
          known ? rows.filter((r: any) => !known.has(caseKey(r.file_path, r.case_title))).map((r: any) => r.id) : []
        );
      } catch (e) {
        setStaleIds([]);
      }
    } catch (e) {
      /* 关联读不到不影响详情本体 */
    }
  };

  useEffect(() => {
    if (isApis && recordId) reloadLinks();
  }, [isApis, recordId]);

  /** 读最近执行：读不到就当没有，不影响详情本体 */
  useEffect(() => {
    let alive = true;
    if (!isApis || !recordId) {
      setRuns([]);
      return () => {
        alive = false;
      };
    }
    api
      .records('runs')
      .then((rows: any[]) => {
        if (alive) setRuns(recentForApi(rows, recordId, 3));
      })
      .catch(() => {
        if (alive) setRuns([]);
      });
    return () => {
      alive = false;
    };
  }, [isApis, recordId]);

  const removeLink = async (row: any) => {
    try {
      await api.linkRemove(row.id);
      setLinkRows((prev) => prev.filter((r) => r.id !== row.id));
      setStaleIds((prev) => prev.filter((id) => id !== row.id));
    } catch (e: any) {
      toast('取消关联失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const cleanStale = async () => {
    const ids = staleIds.slice();
    if (!ids.length) return;
    try {
      for (const id of ids) await api.linkRemove(id);
      setLinkRows((prev) => prev.filter((r) => ids.indexOf(r.id) < 0));
      setStaleIds([]);
      toast(`已清理 ${ids.length} 条失效关联`);
    } catch (e: any) {
      toast('清理失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  if (!record) return null;
  const data = record.data || {};

  // 关联字段：把 id 换成「名称 · 环境」；目标记录被删了就给个明确提示，别露 id
  const links: Record<string, string> = { ...linkMap };
  for (const f of conf.fields) {
    if (f.type !== 'link') continue;
    const id = data[f.key];
    if (id && !links[id]) links[id] = '（关联记录已删除）';
  }

  const copy = async (text: string, secret = false, label = '已复制') => {
    if (!text) {
      toast('没有内容可复制', 'warning');
      return;
    }
    await api.copy(String(text), secret);
    toast(label);
  };

  /** 打开站点；浏览器不允许程序填表，那就顺手把密码放剪贴板 */
  const openInBrowser = async () => {
    const url = String(data.url || '').trim();
    if (!url) {
      toast('这条记录没有填地址', 'warning');
      return;
    }
    await api.openUrl(url);
    try {
      const s = await api.settings();
      if (data.password && (!s || s.openCopyPassword !== false)) {
        await api.copy(String(data.password), true);
        toast('已用浏览器打开，密码已复制 —— 切过去 Ctrl+V');
        return;
      }
    } catch (e) {
      /* 忽略设置读取失败 */
    }
    toast('已用浏览器打开');
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.removeRecord(record.id);
      toast('已删除');
      onDeleted();
    } catch (e: any) {
      toast('删除失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const renderValue = (f: any) => {
    const raw = data[f.key];
    if (raw === undefined || raw === null || raw === '') {
      // 「我的备注」是整个镜像模块最值钱的字段，空着就给一句灰字指路（不是警告）
      if (f.key === 'myNote') {
        return <span className="muted">还没写 —— 点「编辑」在「我的备注」里填，同步永不覆盖</span>;
      }
      return <span className="muted">—</span>;
    }

    switch (f.type) {
      case 'secret':
        return (
          <Space size={2}>
            <span className="mono">{showSecret[f.key] ? raw : '••••••••'}</span>
            <Button
              type="text"
              size="small"
              icon={showSecret[f.key] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() => setShowSecret((prev) => ({ ...prev, [f.key]: !prev[f.key] }))}
            />
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(raw, true, '已复制，30 秒后自动清空剪贴板')} />
          </Space>
        );
      case 'select': {
        const opt = fieldOptions(f, opts).find((o: any) => o.value === raw);
        return <Tag color={opt ? opt.color : 'default'}>{opt ? opt.label : raw}</Tag>;
      }
      case 'multiselect': {
        const arr = asArray(raw);
        if (!arr.length) return <span className="muted">—</span>;
        return (
          <span className="multi-cell">
            {arr.map((v) => {
              const opt = fieldOptions(f, opts).find((o: any) => o.value === v);
              return (
                <Tag key={v} color={opt && opt.color ? opt.color : 'default'}>
                  {opt ? opt.label || v : v}
                </Tag>
              );
            })}
          </span>
        );
      }
      case 'link':
        return links[raw] ? <span>{links[raw]}</span> : <span className="muted">（关联记录已删除）</span>;
      case 'url':
        return (
          <Space size={2}>
            <a onClick={() => api.openUrl(raw)}>{raw}</a>
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(raw, false, '地址已复制')} />
          </Space>
        );
      case 'markdown':
        return (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(String(marked.parse(String(raw)))) }}
          />
        );
      case 'datetime':
        return <span className="muted">{fmtTime(Number(raw), true)}</span>;
      case 'change': {
        // 上次同步的结构变化（参数 / 请求体 / 响应体），描述文案改了不算
        let parsed: any = null;
        try {
          parsed = JSON.parse(String(raw));
        } catch (e) {
          parsed = null;
        }
        if (!parsed || !Array.isArray(parsed.changes) || !parsed.changes.length) return <span className="muted">—</span>;
        return (
          <div className="change-block">
            <div className="change-tags">
              {parsed.changes.map((c: any) => (
                <Tag key={c.kind + (c.detail || '')} bordered={false} className="change-tag" title={c.detail || ''}>
                  {c.label}
                </Tag>
              ))}
            </div>
            {parsed.at ? <span className="muted change-at">{fmtTime(Number(parsed.at), true)}</span> : null}
          </div>
        );
      }
      case 'code':
        // headers / body / paramTable / respExample 提供「表格 / JSON」切换
        if (['headers', 'body', 'paramTable', 'respExample'].includes(f.key)) {
          return <JsonTableToggle fieldKey={f.key} raw={String(raw)} />;
        }
        return (
          <div className="code-block">
            <pre className="mono">{String(raw)}</pre>
          </div>
        );
      case 'scene':
        return <ScenePicker value={String(raw)} onChange={() => {}} readOnly />;
      case 'metrics':
        return <MetricsTable data={data} />;
      case 'vars':
        return <VarsEditor value={String(raw)} onChange={() => {}} readOnly />;
      case 'textarea':
        return <div className="multiline">{String(raw)}</div>;
      default:
        // 标了 copyable 的普通字段（如「账号」）给个和密码同款的复制按钮
        return f.copyable ? (
          <Space size={2}>
            <span>{String(raw)}</span>
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(String(raw), false, `${f.label}已复制`)} />
          </Space>
        ) : (
          <span>{String(raw)}</span>
        );
    }
  };

  return (
    <Drawer
      open={!!record}
      onClose={onClose}
      width={560}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{record.title}</span>
          {isApis && data.source === 'openapi' ? (
            <Tag color="blue" style={{ fontSize: 11 }} title="从 Apifox 导出文件同步来的">
              Apifox
            </Tag>
          ) : null}
          {!conf.noFavorite && record.favorite ? <StarFilled style={{ color: '#f5b301', fontSize: 12 }} /> : null}
          {(record.tags || []).map((t: string) => (
            <Tag key={t} style={{ fontSize: 11 }}>
              {t}
            </Tag>
          ))}
        </div>
      }
      extra={
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
            编辑
          </Button>
          <Popconfirm title="删除这条记录？" okText="删除" cancelText="取消" onConfirm={remove}>
            <Button size="small" danger icon={<DeleteOutlined />} loading={deleting} />
          </Popconfirm>
        </Space>
      }
    >
      <div className="detail-actions">
        {conf.actions && conf.actions.includes('open') && data.url ? (
          <Button size="small" icon={<ExportOutlined />} onClick={openInBrowser}>
            打开地址
          </Button>
        ) : null}
        {conf.key === 'apis' ? (
          <Button size="small" icon={<CopyOutlined />} onClick={() => copy(buildCurl(record), false, 'cURL 已复制')}>
            复制 cURL
          </Button>
        ) : null}
        {conf.key === 'sqls' ? (
          <Button size="small" icon={<CopyOutlined />} onClick={() => setVarOpen(true)}>
            填充变量并复制
          </Button>
        ) : null}
        <Button size="small" icon={<CopyOutlined />} onClick={() => copy(recordToText(record, conf, links), true, '整条已复制')}>
          复制整条
        </Button>
      </div>

      {conf.fields
        .filter((f: any) => !f.hideInDetail)
        .filter((f: any) => matchOnlyFor(f, data.kind))
        .filter((f: any) => {
          // 虚拟字段（metrics / vars 等）不存数据，不能按 data[f.key] 判空
          if (f.type === 'metrics') return true;
          return !(f.hideEmpty && (data[f.key] === undefined || data[f.key] === null || data[f.key] === ''));
        })
        .map((f: any) => (
          <div className="field-row" key={f.key}>
            <div className="field-label">{f.label}</div>
            <div className="field-value">{renderValue(f)}</div>
          </div>
        ))}

      <div className="field-row">
        <div className="field-label">更新于</div>
        <div className="field-value muted" style={{ fontSize: 12.5 }}>
          {fmtTime(record.updated_at, true)}
        </div>
      </div>

      {isApis ? (
        <div className="run-panel">
          <div className="run-panel-head">
            <span className="run-panel-title">最近执行{runs.length ? ` · ${runs.length} 次` : ''}</span>
            <span className="spacer" />
            {onLogRun ? (
              <Button type="link" size="small" onClick={() => onLogRun(record)}>
                记一笔
              </Button>
            ) : null}
          </div>
          {runs.length ? (
            <div className="run-list">
              {runs.map((r: any) => {
                const kind = r.data.kind === 'perf' ? '压测' : '接口测试';
                const line = runLine(r.data);
                const at = r.data.ranAt || r.updated_at;
                return (
                  <div className="run-item" key={r.id}>
                    <span className={'run-dot tone-' + resultTone(r.data.result)} />
                    <span className="run-kind">{kind}</span>
                    <span className="run-line" title={line || r.title}>
                      {line || r.title}
                    </span>
                    {r.data.report ? (
                      <Button type="text" size="small" icon={<LinkOutlined />} title="打开报告" onClick={() => api.openUrl(String(r.data.report))} />
                    ) : null}
                    <span className="run-at muted">{fmtTime(Number(at), true)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="run-empty muted">还没跑过 —— 在 Apifox 跑完记一笔，以后就能在这看到它挂没挂</div>
          )}
        </div>
      ) : null}

      {isApis ? (
        <div className="link-panel">
          <div className="link-panel-head">
            <Button size="small" icon={<LinkOutlined />} onClick={() => setLinkOpen(true)}>
              关联用例{linkRows.length ? ` [${linkRows.length}]` : ''}
            </Button>
            <span className="spacer" />
            {staleIds.length ? (
              <Button type="link" size="small" onClick={cleanStale}>
                清理 {staleIds.length} 条失效
              </Button>
            ) : null}
          </div>
          {linkRows.length ? (
            <div className="link-list">
              {linkRows.map((row: any) => {
                const stale = staleIds.indexOf(row.id) >= 0;
                return (
                  <div className="link-item" key={row.id}>
                    <FileTextOutlined className="link-item-icon" />
                    <span className={'link-title' + (stale ? ' is-stale' : '')} title={row.case_title}>
                      {row.case_title}
                    </span>
                    <span className="link-file muted" title={row.file_path}>
                      {stale ? '已失效 · ' : ''}
                      {row.file_path}
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      title="取消关联"
                      onClick={() => removeLink(row)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="link-empty muted">还没关联 —— 只挂会反复测、又容易变的接口就行</div>
          )}
        </div>
      ) : null}

      <CaseLinkModal open={linkOpen} record={record} onClose={() => setLinkOpen(false)} onSaved={() => reloadLinks()} />

      <VarFillModal open={varOpen} text={String(data.sql || '')} title="填充变量并复制 SQL" onClose={() => setVarOpen(false)} />
    </Drawer>
  );
}