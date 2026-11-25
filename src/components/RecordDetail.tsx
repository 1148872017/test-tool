import React, { useEffect, useState } from 'react';
import { Drawer, Button, Tag, Space, Popconfirm, Select } from 'antd';
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
import AccountsEditor from './AccountsEditor';
import { caseKey, knownCaseKeys, loadCaseIndex } from '../caseIndex';
import { matchOnlyFor, recentForApi, resultTone, runLine } from '../../shared/runs';
import { RUN_KIND_OPTIONS } from '../../shared/collections';
import VarFillModal from './VarFillModal';
import CaseLinkModal from './CaseLinkModal';
import ErrorBoundary from './feedback/ErrorBoundary';
import StateEmpty from './states/StateEmpty';
import { asArray, fieldOptions, getOptionsSync, loadOptions, OptionsMap } from '../options';
import { parseElements, normalizeMode, type PageElement } from './PageElementsEditor';

marked.setOptions({ gfm: true, breaks: true });

/**
 * 「定位方式」的短标签。
 *
 * css 是老记录的缺省值（serialize 时根本不写进 JSON），用户看定位值就能认出来，
 * 所以不显示标签；其余 8 种是 Playwright 的语义化定位（getByRole / getByTestId …），
 * 必须给个标签，否则 `button:登录` 这种值在表格里看起来像写错的 CSS。
 */
const MODE_SHORT_LABEL: Record<string, string> = {
  xpath: 'XPath',
  role: 'Role',
  label: 'Label',
  placeholder: 'Placeholder',
  text: 'Text',
  alttext: 'AltText',
  title: 'Title',
  testid: 'TestId'
};

/**
 * 一行的定位方式标签：css → 空串（不显示），其余 → Role / TestId 这种短名。
 * 认不出的脏 mode 走 normalizeMode 兜底成 css，也就是不显示标签。
 */
export function elementModeTag(mode: any): string {
  const m = normalizeMode(mode);
  return m === 'css' ? '' : MODE_SHORT_LABEL[m] || m;
}

/** 定位值 + 方式标签（复制成文本时写成 `[Role] button:登录`，不然方式丢了就认不出是语义化定位） */
export function elementLocatorText(el: PageElement): string {
  const tag = elementModeTag(el.mode);
  const sel = String(el.selector || '').trim() || '-';
  return tag ? `[${tag}] ${sel}` : sel;
}

/**
 * 元素定位器 → 可粘贴的纯文本。
 *
 * 用制表符分隔（不是 markdown 表格）：用户要的是能直接粘进用例文档 / Excel / 聊天窗口的文本，
 * 粘到哪里都不会变形，也不是给程序解析的 JSON。
 */
export function elementsToText(raw: any): string {
  const rows = parseElements(raw);
  if (!rows.length) return '';
  return [['名称', '定位值', '说明'].join('\t')]
    .concat(
      rows.map((el) =>
        [
          String(el.name || '').trim() || '-',
          elementLocatorText(el),
          String(el.desc || '').trim() || '-'
        ].join('\t')
      )
    )
    .join('\n');
}

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
  /** 复制整条的格式：详情（人话）/ JSON / cURL（只有接口记录有） */
  const [copyFormat, setCopyFormat] = useState<'text' | 'json' | 'curl'>('text');
  const [varOpen, setVarOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linkRows, setLinkRows] = useState<any[]>([]);
  const [staleIds, setStaleIds] = useState<number[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  // 这个接口最近跑过的几次（接口测试 / 压测都算一个「执行」）
  const [runs, setRuns] = useState<any[]>([]);
  const [opts, setOpts] = useState<OptionsMap>(getOptionsSync());

  const isApis = conf.key === 'apis';

  /**
   * 按当前格式复制整条。
   *
   * 三种格式的用途不同（用户反馈原来只有一种，粘出来是 JSON，不好读）：
   *   text → 给人看的（账号按「账号：xxx 密码：yyy」展开）
   *   json → 给程序/接口调试用（完整原始数据）
   *   curl → 只有接口记录有，直接粘终端能跑
   */
  const copyAsFormat = async () => {
    const d = record.data || {};
    if (copyFormat === 'json') {
      await copy(JSON.stringify(d, null, 2), true, 'JSON 已复制');
      return;
    }
    if (copyFormat === 'curl') {
      await copy(buildCurl(record), false, 'cURL 已复制');
      return;
    }
    await copy(recordToText(record, conf, links), true, '整条已复制');
  };
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

  /** 删除 = 移入回收站（软删除）：说清楚「还能找回」，别让人以为数据没了 */
  const remove = async () => {
    setDeleting(true);
    try {
      await api.removeRecord(record.id);
      toast('已移入回收站');
      onDeleted();
    } catch (e: any) {
      toast('移入回收站失败：' + (e && e.message ? e.message : e), 'error');
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
      case 'accounts':
        return <AccountsEditor value={String(raw)} onChange={() => {}} readOnly />;
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

  /**
   * 「元素定位器」字段：只读的 3 列表格（名称 / 定位值 / 说明）。
   *
   * 原来走 default 分支的 `String(raw)`，把整个 JSON 数组甩成一行：
   * `[{"name":"usernameInput","selector":"#username","desc":"用户名输入框"},…]`
   * 名字和定位值挤在一起，对不上号。现在按元素一行渲染。
   *
   * 用原生 table + 已有的 .jmx-table 样式，不上 antd Table：
   *   抽屉只有 560px，antd Table 自带的边框 / 分页 / 空态插图在这里纯属占地方；
   *   而且 .field-value 是 pre-wrap（会把单元格的空白撑开），原生 table 更好控。
   */
  const renderElements = (f: any, raw: any) => {
    // 复用 PageElementsEditor 的 parseElements：JSON 数组 / 老的「name = selector」多行文本都认
    const rows = parseElements(raw);
    const head = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: rows.length ? 6 : 0 }}>
        <span className="field-label" style={{ flex: 'none', paddingTop: 0 }}>
          {f.label}
          {rows.length ? `（${rows.length} 个）` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {/* 表格上方的复制：复制的是可粘贴的纯文本（制表符分隔），不是 markdown 表格 */}
        {rows.length ? (
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            title="复制成可直接粘贴的文本（制表符分隔）"
            onClick={() => copy(elementsToText(raw), false, '元素定位器已复制')}
          >
            复制
          </Button>
        ) : null}
      </div>
    );

    // 没有元素时只给一个「无」，不渲染空表格（用户明确要求）
    if (!rows.length) {
      return (
        <div className="field-row" key={f.key} style={{ display: 'block' }}>
          {head}
          <span className="muted">无</span>
        </div>
      );
    }

    return (
      <div className="field-row" key={f.key} style={{ display: 'block' }}>
        {head}
        <table className="jmx-table elements-table" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: '32%' }}>名称</th>
              <th style={{ width: '40%' }}>定位值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((el, i) => {
              const tag = elementModeTag(el.mode);
              return (
                <tr key={i}>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
                    {String(el.name || '').trim() || <span className="muted">-</span>}
                  </td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
                    {/* 语义化定位（mode ≠ css）给个小标签，一眼看出不是 CSS 选择器 */}
                    {tag ? (
                      <Tag bordered={false} color="blue" style={{ marginInlineEnd: 4, fontSize: 11 }} title="语义化定位（不是 CSS 选择器）">
                        {tag}
                      </Tag>
                    ) : null}
                    {String(el.selector || '').trim() || <span className="muted">-</span>}
                  </td>
                  <td style={{ wordBreak: 'break-all' }}>{String(el.desc || '').trim() || <span className="muted">-</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
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
          <Popconfirm
            title="移入回收站？"
            description="之后可以在回收站里恢复"
            okText="移入回收站"
            cancelText="取消"
            onConfirm={remove}
          >
            <Button size="small" danger icon={<DeleteOutlined />} title="移入回收站" loading={deleting} />
          </Popconfirm>
        </Space>
      }
    >
      {/*
        详情体单独包一层错误边界：一条脏数据（比如某字段是意料之外的结构）
        不该把整个集合页顶掉 —— React 18 里没人接的 render 异常会卸载整棵树，
        用户看到的是整窗白屏。这里兜住之后，抽屉里给一句人话 + 重试/关闭，
        列表和其它功能照常用。key 用记录 id：换一条记录会自动重建边界。
      */}
      <ErrorBoundary
        key={recordId || 'none'}
        scope={'record-detail:' + (conf && conf.key ? conf.key : '')}
        fallback={(err: Error, reset: () => void) => (
          <div className="detail-broken">
            <StateEmpty
              kind="failed"
              object="这条记录"
              title="这条记录渲染失败了"
              desc="数据没丢，只是某个字段的格式不对。其他记录不受影响：换一条看，或者先去编辑里把那个字段清掉。"
              detail={String((err && err.message) || err)}
              action={{ label: '重试', onClick: reset }}
              secondary={{ label: '关闭详情', onClick: onClose }}
            />
          </div>
        )}
      >
        <div className="detail-actions">
        {conf.actions && conf.actions.includes('open') && data.url ? (
          <Button size="small" icon={<ExportOutlined />} onClick={openInBrowser}>
            打开地址
          </Button>
        ) : null}
        {/* 原来这里有独立的「复制 cURL」按钮，已经并进下面的格式下拉了 */}
        {conf.key === 'sqls' ? (
          <Button size="small" icon={<CopyOutlined />} onClick={() => setVarOpen(true)}>
            填充变量并复制
          </Button>
        ) : null}
        {/* 复制整条：先选格式再复制（用户要求加下拉） */}
        <Space.Compact size="small">
          <Select
            size="small"
            value={copyFormat}
            onChange={(v) => setCopyFormat(v as any)}
            style={{ width: 120 }}
            options={[
              { value: 'text', label: '整条详情' },
              { value: 'json', label: 'JSON' },
              ...(isApis ? [{ value: 'curl', label: 'cURL' }] : [])
            ]}
          />
          <Button icon={<CopyOutlined />} onClick={copyAsFormat}>
            复制
          </Button>
        </Space.Compact>
      </div>

      {conf.fields
        .filter((f: any) => !f.hideInDetail)
        .filter((f: any) => matchOnlyFor(f, data.kind))
        .filter((f: any) => {
          // 虚拟字段（metrics / vars 等）不存数据，不能按 data[f.key] 判空
          if (f.type === 'metrics') return true;
          return !(f.hideEmpty && (data[f.key] === undefined || data[f.key] === null || data[f.key] === ''));
        })
        .map((f: any) =>
          // 元素定位器自己撑满整行（3 列表格塞进 74px 标签右边会挤成一条），其余的照常左标签右值
          f.type === 'elements' ? (
            renderElements(f, data[f.key])
          ) : (
            <div className="field-row" key={f.key}>
              <div className="field-label">{f.label}</div>
              <div className="field-value">{renderValue(f)}</div>
            </div>
          )
        )}

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
                // 类型标签统一从 RUN_KIND_OPTIONS 取：加了 ui 之后不能再按
                // 「perf / 其它」二分（否则 UI 测试的执行会被标成接口测试）
                const kindOpt = RUN_KIND_OPTIONS.find((o: any) => o.value === r.data.kind);
                const kind = kindOpt ? kindOpt.label : '接口测试';
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
      </ErrorBoundary>
    </Drawer>
  );
}