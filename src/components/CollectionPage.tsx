import React, { useEffect, useMemo, useState } from 'react';
import { Table, Input, Button, Tag, Popconfirm, Segmented, Select, Dropdown } from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  CopyOutlined,
  EditOutlined,
  DeleteOutlined,
  StarFilled,
  GlobalOutlined,
  DownloadOutlined,
  UploadOutlined,
  InboxOutlined,
  TagOutlined,
  CloudDownloadOutlined,
  BarChartOutlined,
  DownOutlined,
  ImportOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { buildCurl, fmtTime } from '../utils';
import RecordForm from './RecordForm';
import RecordDetail from './RecordDetail';
import VarFillModal from './VarFillModal';
import SyncResultModal from './SyncResultModal';
import ChangeImpactModal from './ChangeImpactModal';
import ImportReportModal from './ImportReportModal';
import CurlImportModal from './CurlImportModal';
import { asArray, fieldOptions, getOptionsSync, loadOptions, OptionsMap } from '../options';

type Props = {
  conf: any;
  onCounts: () => void;
  /** 从用例抽屉跳过来时带上要打开的记录 id */
  openRecordId?: string;
  onOpenedRecord?: () => void;
  /** 变更影响面里点用例 → 跳到用例详情 */
  onOpenCase?: (filePath: string, caseTitle: string) => void;
  /** 接口详情里「记一笔」→ 跳到这里，表单预填好这次要记的执行 */
  logFor?: any;
  onLoggedRun?: () => void;
  onLogRun?: (record: any) => void;
};

export default function CollectionPage({
  conf,
  onCounts,
  openRecordId,
  onOpenedRecord,
  onOpenCase,
  logFor,
  onLoggedRun,
  onLogRun
}: Props) {
  const [all, setAll] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formRecord, setFormRecord] = useState<any>(null);
  // cURL 导入：解析结果作为表单预填值
  const [curlOpen, setCurlOpen] = useState(false);
  const [formPrefill, setFormPrefill] = useState<any>(null);
  const [formWarnings, setFormWarnings] = useState<any[]>([]);
  const [varTarget, setVarTarget] = useState<any>(null);
  const [linkMap, setLinkMap] = useState<Record<string, string>>({});
  const [envFilter, setEnvFilter] = useState('');
  const [openCopy, setOpenCopy] = useState(true);
  const [tagFilter, setTagFilter] = useState('');
  const [sortKey, setSortKey] = useState('updated_desc');
  const [busyIO, setBusyIO] = useState(false);
  // 分页受控：换标签 / 搜索 / 换集合要回第 1 页，别停在上一个列表的第 n 页
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<any>(null);
  // 上次同步的变更清单（关掉卡片后还能从页头重新打开）
  const [impact, setImpact] = useState<any>(null);
  const [opts, setOpts] = useState<OptionsMap>(getOptionsSync());
  const [reportOpen, setReportOpen] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const rows = await api.records(conf.key);
      setAll(rows);
    } catch (e: any) {
      toast('加载失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setKeyword('');
    setFavOnly(false);
    setEnvFilter('');
    setTagFilter('');
    setSortKey('updated_desc');
    setDetail(null);
    setAll([]);
    loadAll();
    api
      .settings()
      .then((s: any) => setOpenCopy(!s || s.openCopyPassword !== false))
      .catch(() => {});
    const linkFields = conf.fields.filter((f: any) => f.type === 'link' && f.linkTo);
    if (linkFields.length) {
      // 环境已经是账号自己的字段了，这里只解析成名称，别重复显示
      Promise.all(
        linkFields.map(async (f: any) => {
          const rows = await api.records(f.linkTo).catch(() => []);
          return rows.map((r: any) => [r.id, r.title] as [string, string]);
        })
      )
        .then((groups: any[][]) => setLinkMap(Object.fromEntries(groups.flat())))
        .catch(() => {});
    }
  }, [conf.key]);

  // 选项配置（环境 / 角色）随时可能在设置页被改过，进集合就取一次
  useEffect(() => {
    loadOptions().then(setOpts).catch(() => {});
  }, [conf.key]);

  // 从接口详情点「记一笔」进来：直接开一张预填好的新表单（还没 id，保存就是新增）
  useEffect(() => {
    if (!logFor) return;
    setFormRecord({ collection: conf.key, data: logFor, tags: [], favorite: false });
    setFormOpen(true);
    if (onLoggedRun) onLoggedRun();
  }, [logFor]);

  // 接口记录页：读上次同步的变更，页头给个入口（有变更才有，没变更不占地方）
  useEffect(() => {
    if (conf.sync !== 'openapi') return;
    api
      .lastSyncChanges()
      .then((v: any) => setImpact(v && v.changed && v.changed.length ? v : null))
      .catch(() => {});
  }, [conf.key]);

  // 从用例抽屉点接口跳过来：列表到齐后直接把那条记录打开
  useEffect(() => {
    if (!openRecordId) return;
    const hit = all.find((r: any) => r.id === openRecordId);
    if (hit) {
      setDetail(hit);
      if (onOpenedRecord) onOpenedRecord();
    }
  }, [openRecordId, all]);

  const favoriteCount = useMemo(() => all.filter((r) => r.favorite).length, [all]);
  const weekCount = useMemo(() => all.filter((r) => Date.now() - r.created_at < 7 * 86400000).length, [all]);
  const noFav = !!conf.noFavorite;
  const opensInBrowser = (conf.actions || []).indexOf('open') >= 0;
  const openField = conf.openField || 'url';

  const filterOptions = useMemo(() => {
    if (!conf.filterField) return [];
    const f = conf.fields.find((x: any) => x.key === conf.filterField);
    if (!f) return [];
    const list = fieldOptions(f, opts);
    return list.map((o: any) => ({ label: o.label, value: o.value }));
  }, [conf, opts]);

  const tagList = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of all) for (const t of r.tags || []) map.set(t, (map.get(t) || 0) + 1);
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }, [all]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let rows = all;
    if (favOnly && !noFav) rows = rows.filter((r) => r.favorite);
    if (tagFilter) rows = rows.filter((r) => (r.tags || []).indexOf(tagFilter) >= 0);
    if (conf.filterField && envFilter) {
      // 环境可能是多选（数组），命中任意一个就算
      rows = rows.filter((r) => {
        const v = (r.data || {})[conf.filterField];
        return Array.isArray(v) ? v.indexOf(envFilter) >= 0 : v === envFilter;
      });
    }
    if (kw) {
      rows = rows.filter((r) => {
        const hay = [r.title || '', (r.tags || []).join(','), JSON.stringify(r.data || {})].join(' ').toLowerCase();
        return hay.includes(kw);
      });
    }
    const sorted = rows.slice();
    if (sortKey === 'updated_asc') sorted.sort((a, b) => a.updated_at - b.updated_at);
    else if (sortKey === 'title_asc') sorted.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
    else if (sortKey === 'title_desc') sorted.sort((a, b) => String(b.title).localeCompare(String(a.title), 'zh-Hans-CN'));
    else sorted.sort((a, b) => b.updated_at - a.updated_at);
    return sorted;
  }, [all, keyword, favOnly, envFilter, tagFilter, sortKey, conf, noFav]);

  // 换集合 / 改筛选 / 改排序 → 回第 1 页
  useEffect(() => {
    setPage(1);
  }, [conf.key, keyword, favOnly, envFilter, tagFilter, sortKey, all]);

  const doExport = async () => {
    setBusyIO(true);
    try {
      const res = await api.exportData(true, conf.key);
      if (res && res.ok) toast(`已导出 ${res.count} 条${res.file ? '：' + res.file : ''}`);
      else if (res && res.message) toast(res.message, 'warning');
    } catch (e: any) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusyIO(false);
    }
  };

  const doImport = async () => {
    setBusyIO(true);
    try {
      const res = await api.importData(conf.key);
      if (res && res.ok) {
        toast(`已导入 ${res.imported} 条${res.skipped ? `（跳过 ${res.skipped} 条）` : ''}`);
        await loadAll();
        onCounts();
      } else if (res && res.message) {
        toast(res.message, 'warning');
      }
    } catch (e: any) {
      toast('导入失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusyIO(false);
    }
  };

  /** 从 Apifox 导出的 openapi.json 同步接口镜像（幂等，重复点不会造重复记录） */
  const doSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncOpenApi();
      if (!res || res.canceled) return;
      if (!res.ok) {
        toast(res.message || '同步失败', 'error');
        return;
      }
      setSyncResult(res);
      const st = (res && res.stats) || {};
      setImpact(st.changed ? { at: st.at, changed: st.changedList || [], affectedCases: st.affectedCases || 0 } : null);
      await loadAll();
      onCounts();
    } catch (e: any) {
      toast('同步失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setSyncing(false);
    }
  };

  const openCreate = () => {
    setFormRecord(null);
    setFormPrefill(null);
    setFormWarnings([]);
    setFormOpen(true);
  };

  /** cURL 解析完成 → 关弹窗，用解析结果预填表单 */
  const onCurlImport = (parsed: any) => {
    setFormRecord(null);
    setFormPrefill({
      name: parsed.name || '',
      method: parsed.method || 'GET',
      url: parsed.url || '',
      headers: parsed.headers || '',
      body: parsed.body || '',
      source: 'cURL 导入'
    });
    setFormWarnings(parsed.warnings || []);
    setFormOpen(true);
  };

  /**
   * 导入压测报告 → 预填一张 runs 表单（还没 id，保存就是新增）。
   * 只填能自动算的指标，结论留空让用户写。
   */
  const importReport = (report: any) => {
    const name = (report.name || '压测').replace(/[\\/]/g, '');
    const durationText = report.durationS ? `${Math.round(report.durationS)}s` : '';
    const data: any = {
      name: `${name} · ${report.samples} 样本`,
      kind: 'perf',
      result: report.fails > 0 ? 'bad' : 'ok',
      ranAt: report.mtime || Date.now(),
      scene: name,
      concurrency: report.concurrency || '',
      duration: durationText,
      tps: report.tps ? Math.round(report.tps * 100) / 100 : '',
      p90: report.p90 === null || report.p90 === undefined ? '' : Math.round(report.p90),
      p95: report.p95 === null || report.p95 === undefined ? '' : Math.round(report.p95),
      p99: report.p99 === null || report.p99 === undefined ? '' : Math.round(report.p99),
      errRate: Math.round((report.errRate || 0) * 100) / 100,
      samples: report.samples || '',
      reportDir: report.dir || '',
      report: report.files && report.files.htmlIndex ? report.files.htmlIndex : '',
      conclusion: ''
    };
    setFormRecord({ collection: conf.key, data, tags: [], favorite: false });
    setReportOpen(false);
    setFormOpen(true);
  };

  const copy = async (text: string, secret = false, label = '已复制') => {
    if (!text) {
      toast('没有内容可复制', 'warning');
      return;
    }
    await api.copy(String(text), secret);
    toast(label);
  };

  const quickCopy = async (r: any) => {
    const d = r.data || {};
    if (conf.key === 'sites' || conf.key === 'accounts') {
      if (d.password) return copy(d.password, true, '密码已复制，30 秒后自动清空');
      if (d.account) return copy(d.account, false, '账号已复制');
      toast('这条记录没有账号或密码', 'warning');
      return;
    }
    if (conf.key === 'sqls') {
      setVarTarget(r);
      return;
    }
    if (conf.key === 'apis') return copy(buildCurl(r), false, 'cURL 已复制');
    if (conf.key === 'notes') return copy(d.content || '', false, '正文已复制');
  };

  /**
   * 用系统默认浏览器打开。
   * 浏览器不允许外部程序往页面里打字，所以这里退一步：
   * 打开的同时把密码复制到剪贴板，切过去 Ctrl+V 就行。
   */
  const openSite = async (r: any) => {
    const url = String((r.data || {})[openField] || '').trim();
    if (!url) {
      toast('这条记录没有填地址', 'warning');
      return;
    }
    const pwd = (r.data || {}).password;
    try {
      await api.openUrl(url);
    } catch (e: any) {
      toast('打开失败：' + (e && e.message ? e.message : e), 'error');
      return;
    }
    if (pwd && openCopy) {
      await api.copy(String(pwd), true);
      toast('已用浏览器打开，密码已复制 —— 切过去 Ctrl+V');
    } else {
      toast('已用浏览器打开');
    }
  };

  const remove = async (r: any) => {
    try {
      await api.removeRecord(r.id);
      toast('已删除');
      if (detail && detail.id === r.id) setDetail(null);
      await loadAll();
      onCounts();
    } catch (e: any) {
      toast('删除失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const renderListField = (f: any, value: any) => {
    if (value === undefined || value === null || value === '') return <span className="muted">—</span>;
    if (Array.isArray(value) || f.type === 'multiselect') {
      const arr = asArray(value);
      if (!arr.length) return <span className="muted">—</span>;
      return (
        <span className="multi-cell">
          {arr.map((v) => {
            const hit = fieldOptions(f, opts).find((o: any) => o.value === v);
            return (
              <Tag key={v} color={hit && hit.color ? hit.color : 'default'} style={{ marginInlineEnd: 4 }}>
                {hit ? hit.label || v : v}
              </Tag>
            );
          })}
        </span>
      );
    }
    if (f.type === 'select') {
      const opt = fieldOptions(f, opts).find((o: any) => o.value === value);
      return <Tag color={opt ? opt.color : 'default'}>{opt ? opt.label || value : value}</Tag>;
    }
    if (f.type === 'url') return <span className="ellipsis mono muted">{String(value)}</span>;
    if (f.type === 'secret') return <span className="mono muted">••••••</span>;
    if (f.type === 'datetime') return <span className="muted">{fmtTime(Number(value), true)}</span>;
    if (f.type === 'link') return <span className="ellipsis">{linkMap[String(value)] || '（已删除）'}</span>;
    return <span className="ellipsis">{String(value)}</span>;
  };

  const titleLabel = (conf.fields.find((f: any) => f.key === conf.titleField) || {}).label || '名称';

  // 列宽：首列固定 50%，剩余 50% 按权重分给 listFields + 更新时间 + 操作
  const FIELD_WEIGHT: Record<string, number> = {
    method: 0.7,
    env: 1,
    account: 1.1,
    role: 1.05,
    db: 1.4,
    url: 2,
    apiRef: 1.5,
    kind: 0.9,
    result: 0.8,
    ranAt: 1.3
  };
  const listMeta = conf.listFields
    .map((key: string) => ({ key, f: conf.fields.find((x: any) => x.key === key), weight: FIELD_WEIGHT[key] || 1 }))
    .filter((x: any) => x.f);
  const hasList = listMeta.length > 0;
  const titleWidth = hasList ? '50%' : '64%';
  const restPct = hasList ? 50 : 36;
  const totalWeight = listMeta.reduce((s: number, x: any) => s + x.weight, 0) + 1.1 + 1.1;
  const pct = (w: number) => `${((restPct * w) / totalWeight).toFixed(2)}%`;

  const columns: any[] = [
    {
      title: titleLabel,
      dataIndex: 'title',
      key: 'title',
      width: titleWidth,
      ellipsis: true,
      render: (text: string, r: any) => (
        <div className="title-cell">
          {!noFav && r.favorite ? <StarFilled style={{ color: '#f5b301', fontSize: 12, flex: '0 0 auto' }} /> : null}
          <span className="t" title={text}>
            {text}
          </span>
          {(r.tags || []).map((t: string) => (
            <Tag key={t} style={{ fontSize: 11, marginInlineEnd: 0 }}>
              {t}
            </Tag>
          ))}
        </div>
      )
    },
    ...listMeta.map(({ key, f, weight }: any) => ({
      title: f.label,
      dataIndex: ['data', key],
      key,
      width: pct(weight),
      ellipsis: true,
      render: (value: any) => renderListField(f, value)
    })),
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: pct(1.1),
      render: (v: number) => <span className="muted">{fmtTime(v)}</span>
    },
    {
      title: '',
      key: 'op',
      width: pct(1.1),
      render: (_: any, r: any) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {opensInBrowser ? (
            <Button
              type="text"
              size="small"
              icon={<GlobalOutlined />}
              title="用默认浏览器打开"
              onClick={() => openSite(r)}
            />
          ) : null}
          <Button type="text" size="small" icon={<CopyOutlined />} title="复制" onClick={() => quickCopy(r)} />
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            title="编辑"
            onClick={() => {
              setFormRecord(r);
              setFormOpen(true);
            }}
          />
          <Popconfirm title="删除这条记录？" okText="删除" cancelText="取消" onConfirm={() => remove(r)}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除" />
          </Popconfirm>
        </div>
      )
    }
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">
            {conf.name}
            <span style={{ fontSize: 12, color: '#9aa1b4', fontWeight: 400, marginLeft: 2 }}>{all.length} 条</span>
          </div>
          <div className="page-desc">{conf.desc}</div>
        </div>
        <div className="page-head-right">
          {conf.key === 'runs' ? (
            <Button icon={<BarChartOutlined />} onClick={() => setReportOpen(true)}>
              导入压测报告
            </Button>
          ) : null}
          {impact && impact.changed && impact.changed.length ? (
            <Button type="link" size="small" className="impact-entry" onClick={() => setImpactOpen(true)}>
              上次同步变更 · {impact.changed.length}
            </Button>
          ) : null}
          <Button icon={<UploadOutlined />} onClick={doImport} loading={busyIO}>
            导入备份
          </Button>
          <Button icon={<DownloadOutlined />} onClick={doExport} loading={busyIO}>
            导出
          </Button>
          <Button icon={<ReloadOutlined />} onClick={loadAll}>
            刷新
          </Button>
          {conf.sync === 'openapi' || conf.key === 'apis' ? (
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'manual', label: '手动新增', icon: <PlusOutlined /> },
                  { key: 'curl', label: '粘贴 cURL 导入', icon: <ImportOutlined /> },
                  ...(conf.sync === 'openapi'
                    ? [{ key: 'apifox', label: '从 Apifox 同步', icon: <CloudDownloadOutlined /> }]
                    : [])
                ],
                onClick: ({ key }) => {
                  if (key === 'manual') openCreate();
                  else if (key === 'curl') setCurlOpen(true);
                  else if (key === 'apifox') doSync();
                }
              }}
            >
              <Button type="primary" icon={<PlusOutlined />} loading={syncing}>
                新增 <DownOutlined style={{ fontSize: 10, marginLeft: 2 }} />
              </Button>
            </Dropdown>
          ) : (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增
            </Button>
          )}
        </div>
      </div>

      <div className="page-with-aside">
        <aside className="tag-panel">
          <div className="tag-panel-head">
            <span>
              <TagOutlined /> 标签
            </span>
            <span className="tag-panel-count">{tagList.length}</span>
          </div>
          <div
            className={'tag-item' + (tagFilter === '' && !(favOnly && !noFav) ? ' active' : '')}
            onClick={() => {
              setTagFilter('');
              setFavOnly(false);
            }}
          >
            <span className="tag-dot" />
            <span className="tag-name">全部</span>
            <span className="tag-count">{all.length}</span>
          </div>
          {!noFav ? (
            <div
              className={'tag-item' + (favOnly ? ' active' : '')}
              onClick={() => {
                setFavOnly(!favOnly);
                setTagFilter('');
              }}
              title="只看收藏"
            >
              <span className="tag-dot" style={{ background: '#f5b301' }} />
              <span className="tag-name">收藏</span>
              <span className="tag-count">{favoriteCount}</span>
            </div>
          ) : null}
          <div className="tag-divider" />
          {tagList.length ? (
            tagList.map((t) => (
              <div
                key={t.name}
                className={'tag-item' + (tagFilter === t.name ? ' active' : '')}
                title={t.name}
                onClick={() => {
                  setTagFilter(tagFilter === t.name ? '' : t.name);
                  setFavOnly(false);
                }}
              >
                <span className="tag-dot" />
                <span className="tag-name">{t.name}</span>
                <span className="tag-count">{t.count}</span>
              </div>
            ))
          ) : (
            <div className="tag-empty">暂无标签</div>
          )}
        </aside>

        <div className="page-main">
          <div className="stats">
        <div className="stat">
          <div className="stat-label">全部</div>
          <div className="stat-value">{all.length}</div>
        </div>
        {!noFav ? (
          <div
            className={'stat clickable' + (favOnly ? ' active' : '')}
            onClick={() => setFavOnly((v) => !v)}
            title="点击只看收藏"
          >
            <div className="stat-label">收藏</div>
            <div className="stat-value">{favoriteCount}</div>
          </div>
        ) : null}
        <div className="stat">
          <div className="stat-label">本周新增</div>
          <div className="stat-value">{weekCount}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          {filterOptions.length ? (
            <Segmented
              size="small"
              value={envFilter || 'all'}
              onChange={(v) => setEnvFilter(v === 'all' ? '' : String(v))}
              options={[{ label: '全部环境', value: 'all' }, ...filterOptions]}
            />
          ) : null}
          <Input
            allowClear
            style={{ width: 260 }}
            prefix={<SearchOutlined style={{ color: '#9aa1b4' }} />}
            placeholder="搜索标题、内容、标签"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>
            {filtered.length} / {all.length} 条
          </span>
          <Select
            size="small"
            value={sortKey}
            onChange={setSortKey}
            style={{ width: 132 }}
            options={[
              { value: 'updated_desc', label: '最近修改' },
              { value: 'updated_asc', label: '最早修改' },
              { value: 'title_asc', label: '名称 A→Z' },
              { value: 'title_desc', label: '名称 Z→A' }
            ]}
          />
        </div>
        <Table
          dataSource={filtered}
          columns={columns}
          rowKey="id"
          size="middle"
          tableLayout="fixed"
          loading={loading}
          showSorterTooltip={false}
          pagination={{
            pageSize: 50,
            current: Math.min(page, Math.max(1, Math.ceil(filtered.length / 50))),
            onChange: setPage,
            hideOnSinglePage: true,
            showSizeChanger: false,
            size: 'small'
          }}
          locale={{
            emptyText: (
              <div className="empty-state">
                <div className="empty-icon">
                  <InboxOutlined />
                </div>
                <div className="empty-title">{keyword || tagFilter ? '没有匹配的记录' : `还没有${conf.name}记录`}</div>
                <div className="empty-desc">
                  {keyword || tagFilter ? '换个关键词，或点左侧「全部」清空筛选' : '点下面按钮录入第一条，之后就能一键复制/打开'}
                </div>
                {!keyword && !tagFilter ? (
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                    新增
                  </Button>
                ) : null}
              </div>
            )
          }}
          onRow={(r) => ({
            onClick: () => setDetail(r),
            style: { cursor: 'pointer' }
          })}
        />
      </div>
        </div>
      </div>

      <RecordDetail
        record={detail}
        conf={conf}
        linkMap={linkMap}
        onClose={() => setDetail(null)}
        onEdit={() => {
          setFormRecord(detail);
          setFormOpen(true);
        }}
        onDeleted={() => {
          setDetail(null);
          loadAll();
          onCounts();
        }}
        onLogRun={(rec: any) => onLogRun && onLogRun(rec)}
      />

      <RecordForm
        open={formOpen}
        conf={conf}
        record={formRecord}
        prefill={formPrefill}
        warnings={formWarnings}
        onClose={() => setFormOpen(false)}
        onSaved={(saved: any) => {
          loadAll();
          onCounts();
          if (detail && saved && detail.id === saved.id) setDetail(saved);
        }}
      />

      <VarFillModal
        open={!!varTarget}
        text={varTarget && varTarget.data ? String(varTarget.data.sql || '') : ''}
        title="填充变量并复制 SQL"
        onClose={() => setVarTarget(null)}
      />

      <SyncResultModal
        result={syncResult}
        onClose={() => setSyncResult(null)}
        onShowImpact={
          impact && impact.changed && impact.changed.length
            ? () => {
                setSyncResult(null);
                setImpactOpen(true);
              }
            : undefined
        }
      />

      <ChangeImpactModal data={impact} open={impactOpen} onClose={() => setImpactOpen(false)} onOpenCase={onOpenCase} />

      {conf.key === 'runs' ? (
        <ImportReportModal open={reportOpen} onClose={() => setReportOpen(false)} onImport={importReport} />
      ) : null}

      <CurlImportModal open={curlOpen} onClose={() => setCurlOpen(false)} onImport={onCurlImport} />
    </div>
  );
}