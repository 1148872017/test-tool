import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Table, Input, Button, Tag, Drawer, Segmented, Select, Empty, Tooltip } from 'antd';
import {
  ReloadOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  CopyOutlined,
  FolderOutlined,
  CloseOutlined,
  ArrowRightOutlined,
  RightOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { loadCaseIndex } from '../caseIndex';
import { buildCaseTree, inScope } from '../../shared/caseTree';
import { methodOf, riskTone } from '../utils';
import StateEmpty from '../components/states/StateEmpty';
import StateError from '../components/states/StateError';
import LoadingRows from '../components/states/LoadingRows';
import { caseHay, matchHay, normalizeKeyword } from '../utils/searchIndex';

/** 每页条数（分页受控，页码收敛时也用这个数） */
const PAGE_SIZE = 50;

/**
 * 一行的搜索索引载体。
 *
 * 为什么不把 `_hay` 挂在 item / file 上：
 *   这两个对象来自 loadCaseIndex 的缓存（已知用例集合、关联软键都读它），
 *   往里塞派生字段会被别的调用方当成数据。包装对象是一次性的，
 *   只喂给 Table 的 dataSource，天然进不了任何 payload / 导出。
 */
type CaseRow = { item: CaseItem; file: CaseFile; _hay: string };

/** 三态 + 「失败不清屏」的槽位（和 CodeScanPage 的 Slot 同一个模式） */
type CaseSlot = { data: any; error: string; detail: string; at: number };

type CaseItem = {
  kind: string;
  id: string;
  index: number;
  module: string;
  branch: string;
  title: string;
  risk: string;
  type: string;
  corePath: boolean;
  tags: string[];
  pre: { depth: number; text: string }[];
  steps: { depth: number; text: string }[];
  expects: { depth: number; text: string }[];
  notes: { depth: number; text: string }[];
  checklist: { depth: number; text: string; done?: boolean }[];
  chainMeta: string[];
  assertions: { dim: string; text: string }[];
  covers: string[];
  line: number;
};

type CaseFile = {
  relPath: string;
  name: string;
  dir: string;
  fullPath: string;
  title: string;
  meta: string[];
  kind: string;
  cases: CaseItem[];
  mtime: number;
  size: number;
};

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

type Props = {
  onOpenApi?: (apiId: string) => void;
  /** 从「变更影响面」跳过来：按软键（文件 + 标题）直接打开这条用例 */
  openCase?: { filePath: string; caseTitle: string } | null;
  onOpenedCase?: () => void;
};

export default function CasePage({ onOpenApi, openCase, onOpenedCase }: Props) {
  /**
   * 索引结果放在槽位里：data 是「上一次成功的结果」，error 是「这一次没成功」。
   * 失败时只记错误、**不清 data** —— 一次目录抖动不该把用户正在看的用例列表清空
   * （CodeScanPage 的「失败不清屏」slot 模式）。
   */
  const [slot, setSlot] = useState<CaseSlot>({ data: null, error: '', detail: '', at: 0 });
  // 立刻解构出来：下面 effect 的依赖数组在渲染期求值，晚声明会撞上 TDZ
  const data = slot.data;
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  // 二级目录 = 单个用例文件（值存 relPath，唯一）；点了文件就只看这个文件
  const [fileFilter, setFileFilter] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [riskFilter, setRiskFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [detail, setDetail] = useState<{ file: CaseFile; item: CaseItem } | null>(null);
  const [caseLinks, setCaseLinks] = useState<any[]>([]);
  const [apiMap, setApiMap] = useState<Record<string, any>>({});
  const [apiReady, setApiReady] = useState(false);
  // 分页受控：换目录/改筛选要回到第 1 页，否则「需求 A 翻到第 2 页 → 切需求 B」会停在空白或错位的页
  const [page, setPage] = useState(1);

  const load = async (force = false) => {
    setLoading(true);
    try {
      const res = await loadCaseIndex(force);
      if (res && res.error) {
        // 目录没配 / 不存在：保留上一次的索引，只压一条错误说明（重新扫描会把缓存清掉）
        setSlot((prev) => ({ data: prev.data, error: String(res.error), detail: '', at: Date.now() }));
        toast(res.error, 'warning');
      } else {
        setSlot({ data: res, error: '', detail: '', at: Date.now() });
      }
    } catch (e: any) {
      const msg = e && e.message ? e.message : e;
      setSlot((prev) => ({
        data: prev.data,
        error: '扫描失败：' + msg,
        detail: e && e.stack ? String(e.stack) : String(msg),
        at: Date.now()
      }));
      toast('扫描失败：' + msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // 换目录 / 改筛选 / 重新扫描 → 回第 1 页（分页受控，不靠 antd 自己记）
  useEffect(() => {
    setPage(1);
  }, [dirFilter, fileFilter, riskFilter, kindFilter, keyword, data]);

  // 选中的目录自动展开（不然点了目录看不到它下面的文件）
  useEffect(() => {
    if (!dirFilter) return;
    setExpanded((prev) => (prev.indexOf(dirFilter) >= 0 ? prev : prev.concat([dirFilter])));
  }, [dirFilter]);

  // 从变更影响面跳过来：索引到齐后按软键打开那条用例（找不到就给一句灰字，不当错误报）
  useEffect(() => {
    if (!openCase || !data) return;
    const file = (data.files || []).find((f: CaseFile) => f.relPath === openCase.filePath);
    const item = file ? (file.cases || []).find((c: CaseItem) => c.title === openCase.caseTitle) : null;
    if (file && item) setDetail({ file, item });
    else toast('这条用例已经不在了（可能被改名或删除）', 'warning');
    if (onOpenedCase) onOpenedCase();
  }, [openCase, data]);

  // 打开详情时读这条用例挂的接口（关联是按 文件+标题 回找的软键）
  const detailKey = detail ? detail.file.relPath + '\u0001' + detail.item.title : '';
  useEffect(() => {
    if (!detail) {
      setCaseLinks([]);
      return;
    }
    let alive = true;
    api
      .linksForCase(detail.file.relPath, detail.item.title)
      .then((rows: any[]) => {
        if (alive) setCaseLinks(rows || []);
      })
      .catch(() => {});
    if (!apiReady) {
      api
        .records('apis')
        .then((rows: any[]) => {
          if (!alive) return;
          const map: Record<string, any> = {};
          for (const r of rows || []) map[r.id] = r;
          setApiMap(map);
          setApiReady(true);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [detailKey]);

  const removeCaseLink = async (row: any) => {
    try {
      await api.linkRemove(row.id);
      setCaseLinks((prev) => prev.filter((r) => r.id !== row.id));
    } catch (e: any) {
      toast('取消关联失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  // 必须 memo：写成 `data && data.files ? data.files : []` 时每次渲染都是新数组，
  // 下面算 _hay 的 useMemo 就会每次按键都重算一遍（等于没优化）
  const files: CaseFile[] = useMemo(() => (data && data.files ? data.files : []), [data]);

  /**
   * 平铺 + **扫描时算一次 hay**。
   *
   * 这几千条用例的 hay 只在索引换掉时重算（一次 load），按键时只做 indexOf。
   */
  const flat = useMemo(() => {
    const out: CaseRow[] = [];
    for (const f of files) {
      for (const c of f.cases) out.push({ item: c, file: f, _hay: caseHay(c, f) });
    }
    return out;
  }, [files]);

  const dirs = useMemo(() => buildCaseTree(files), [files]);

  /**
   * 搜索关键词走 deferred：输入框的值（keyword）立刻更新，筛选用的值慢一拍。
   * 大列表里这样输入框不会因为同步过滤而卡顿（React 18 的并发渲染）。
   */
  const deferredKeyword = useDeferredValue(keyword);
  const kw = normalizeKeyword(deferredKeyword);
  /** 输入框已经变了、筛选还没跟上：给用户一个「正在筛」的即时反馈 */
  const searching = keyword !== deferredKeyword;

  const filtered = useMemo(() => {
    return flat.filter(({ item, file, _hay }) => {
      if (!inScope(file, dirFilter, fileFilter)) return false;
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
      if (riskFilter === 'smoke' && item.tags.indexOf('冒烟') < 0) return false;
      if (riskFilter === 'core' && !item.corePath) return false;
      if (riskFilter === 'high' && riskTone(item.risk) !== 'red') return false;
      return matchHay(_hay, kw);
    });
  }, [flat, kw, dirFilter, fileFilter, riskFilter, kindFilter]);

  const columns: any[] = [
    {
      title: '用例',
      dataIndex: 'title',
      width: '44%',
      render: (_: any, row: any) => {
        const c: CaseItem = row.item;
        // 一行装不下就靠 hover 补：标题 + 覆盖规则都在 title 里，不再靠换行撑高行
        const hover = [c.title]
          .concat(c.covers.length ? ['覆盖规则：' + c.covers.join('、')] : [])
          .join('\n');
        return (
          <div className="case-title-cell" title={hover}>
            {c.corePath ? (
              <Tooltip title="核心路径">
                <span className="case-core">🛤️</span>
              </Tooltip>
            ) : null}
            <span className="case-title">{c.title}</span>
            <span className="case-title-tags">
              {c.kind === 'chain' ? <Tag color="purple">{c.id}</Tag> : null}
              {c.risk ? <Tag color={riskTone(c.risk)}>{c.risk}</Tag> : null}
              {c.type ? <Tag>{c.type}</Tag> : null}
              {c.tags.indexOf('冒烟') >= 0 && c.type !== '冒烟' ? <Tag color="blue">冒烟</Tag> : null}
              {c.covers.slice(0, 4).map((r) => (
                <Tag key={r} className="case-cover-tag">
                  {r}
                </Tag>
              ))}
              {c.covers.length > 4 ? <span className="case-more">+{c.covers.length - 4}</span> : null}
            </span>
          </div>
        );
      }
    },
    {
      title: '模块 / 分支',
      dataIndex: 'module',
      width: '22%',
      render: (_: any, row: any) => {
        const c: CaseItem = row.item;
        if (c.kind === 'chain') return <span className="muted">回归链路</span>;
        return (
          <div className="case-module-cell" title={[c.module || '—'].concat(c.branch ? [c.branch] : []).join(' / ')}>
            <span className="case-module">{c.module || '—'}</span>
            {c.branch ? <span className="case-branch">{c.branch}</span> : null}
          </div>
        );
      }
    },
    {
      title: '断言迹',
      dataIndex: 'assertions',
      width: '18%',
      render: (_: any, row: any) => {
        const c: CaseItem = row.item;
        if (!c.assertions.length) return <span className="muted">—</span>;
        return (
          <div className="case-assert-cell">
            {c.assertions.map((a, i) => (
              <Tag key={i} color={a.dim === 'API' ? 'geekblue' : a.dim === 'DB' ? 'cyan' : 'default'}>
                {a.dim || '断言'}
              </Tag>
            ))}
          </div>
        );
      }
    },
    {
      title: '文件',
      dataIndex: 'file',
      width: '16%',
      render: (_: any, row: any) => (
        /*
         * 时间戳不进列表：它是「几乎不变的次要信息」，常显会让每一行都变成两行高
         * （74px 行高就是这么来的）。改成 hover 看，抽屉里也给了一份完整路径 + 修改时间。
         */
        <span className="case-file-name" title={row.file.relPath + '\n修改于 ' + fmtTime(row.file.mtime)}>
          {String(row.file.name || '').replace(/\.md$/i, '')}
        </span>
      )
    }
  ];

  const openFile = async (path: string) => {
    const res = await api.caseOpen(path);
    if (res && res.ok === false && res.message) toast(res.message, 'warning');
  };

  const openDir = () => {
    if (!data || !data.root) return;
    api.caseReveal(data.root).catch(() => {});
  };

  const copyCase = async (file: CaseFile, c: CaseItem) => {
    const lines: string[] = [];
    lines.push(`### ${c.title}`);
    if (c.module) lines.push(`模块：${c.module}${c.branch ? ' / ' + c.branch : ''}`);
    if (c.pre.length) lines.push('前置：\n' + c.pre.map((x) => '- ' + x.text).join('\n'));
    if (c.steps.length) lines.push('操作：\n' + c.steps.map((x, i) => `${i + 1}. ${x.text}`).join('\n'));
    if (c.expects.length) lines.push('预期：\n' + c.expects.map((x) => '- ' + x.text).join('\n'));
    if (c.assertions.length)
      lines.push('断言迹：' + c.assertions.map((a) => `${a.dim}:${a.text}`).join(' ｜ '));
    lines.push(`来源：${file.relPath}`);
    await api.copy(lines.join('\n\n'));
    toast('用例已复制');
  };

  /** 任何筛选生效中（空状态据此区分「没数据」和「筛不出来」） */
  const hasAnyFilter = !!(keyword || dirFilter || fileFilter || riskFilter !== 'all' || kindFilter !== 'all');

  /** 空状态里的下一步：清空筛选（数据其实在，别引导用户去重新扫描） */
  const clearFilters = () => {
    setKeyword('');
    setDirFilter('');
    setFileFilter('');
    setRiskFilter('all');
    setKindFilter('all');
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">测试用例</div>
          <div className="page-desc">
            只读索引：直接读你的 markdown（{data && data.root ? data.root : '未配置目录'}），不写回任何文件
          </div>
        </div>
        <div className="page-head-right">
          <Button icon={<FolderOpenOutlined />} onClick={openDir}>
            打开目录
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => load(true)} loading={loading}>
            重新扫描
          </Button>
        </div>
      </div>

      <div className="page-with-aside">
        <aside className="tag-panel dir-tree">
          <div className="tag-panel-head">
            <span>
              <FolderOutlined /> 目录
            </span>
            <span className="tag-panel-count">{dirs.length}</span>
          </div>
          <div
            className={'tag-item' + (dirFilter === '' && !fileFilter ? ' active' : '')}
            onClick={() => {
              setDirFilter('');
              setFileFilter('');
            }}
          >
            <span className="tag-dot" />
            <span className="tag-name">全部</span>
            <span className="tag-count">{data ? data.totalCases : 0}</span>
          </div>
          <div className="tag-divider" />
          {dirs.map((d) => {
            const open = expanded.indexOf(d.name) >= 0;
            return (
              <div key={d.name}>
                <div
                  className={'tag-item' + (dirFilter === d.name && !fileFilter ? ' active' : '')}
                  title={d.name}
                  onClick={() => {
                    setDirFilter(dirFilter === d.name && !fileFilter ? '' : d.name);
                    setFileFilter('');
                    setExpanded((prev) => (prev.indexOf(d.name) >= 0 ? prev : prev.concat([d.name])));
                  }}
                >
                  <span
                    className={'tag-caret' + (open ? ' open' : '')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((prev) => (prev.indexOf(d.name) >= 0 ? prev.filter((x) => x !== d.name) : prev.concat([d.name])));
                    }}
                  >
                    <RightOutlined />
                  </span>
                  <span className="tag-name">{d.name}</span>
                  <span className="tag-count">{d.count}</span>
                </div>
                {open
                  ? d.files.map((f) => (
                      <div
                        key={f.relPath}
                        className={'tag-item sub' + (fileFilter === f.relPath ? ' active' : '')}
                        title={f.relPath}
                        onClick={() => {
                          setDirFilter(d.name);
                          setFileFilter(fileFilter === f.relPath ? '' : f.relPath);
                        }}
                      >
                        <span className="tag-name sub-name">{f.name}</span>
                        <span className="tag-count">{f.count}</span>
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
          {!dirs.length && !loading ? <div className="tag-empty">没有找到用例</div> : null}
        </aside>

        <div className="page-main">
          <div className="panel">
            <div className="panel-head panel-head-wrap">
              <Segmented
                size="small"
                value={riskFilter}
                onChange={(v) => setRiskFilter(String(v))}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '冒烟', value: 'smoke' },
                  { label: '核心路径', value: 'core' },
                  { label: '高风险', value: 'high' }
                ]}
              />
              <Input
                allowClear
                style={{ width: 300 }}
                prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
                placeholder="搜标题、步骤、预期、规则号"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <Select
                size="small"
                value={kindFilter}
                onChange={setKindFilter}
                style={{ width: 118 }}
                options={[
                  { value: 'all', label: '全部格式' },
                  { value: 'standard', label: '标准 TC' },
                  { value: 'chain', label: '回归链路' }
                ]}
              />
              <span className="spacer" />
              {/* 输入框已变、筛选还没跟上时给个即时反馈（useDeferredValue 的代价要可见） */}
              {searching ? <span className="panel-searching">筛选中…</span> : null}
              {/* white-space:nowrap：窄窗口下别把「123 / 4567 条」折成两行把工具条撑高 */}
              <span className="muted panel-count">
                {filtered.length} / {data ? data.totalCases : 0} 条
              </span>
            </div>
            {/*
              失败不清屏：data 还在（上一次成功的结果）就只压一条错误条，
              告诉用户「下面这堆是上次的」；没有旧结果才走 failed 空状态。
            */}
            {slot.error && data ? (
              <div className="panel-slot-error">
                <StateError
                  message={slot.error}
                  detail={slot.detail || undefined}
                  staleLabel={slot.at ? '下面还是上次扫描的结果' : ''}
                  onRetry={() => load(true)}
                  retryLabel="重新扫描"
                />
              </div>
            ) : null}
            <Table
              className="case-table"
              dataSource={filtered}
              columns={columns}
              rowKey={(row: any) => row.file.relPath + '#' + row.item.index}
              size="small"
              tableLayout="fixed"
              /*
                行高从 74px 降到 38px 量级：
                  size="small"（单元格上下 8px）+ 四个列都改成单行（标题和标签同一行、模块和分支同一行、
                  文件名不再挂时间戳）+ scroll.x 给表格一个保底宽度，窄窗口横向滚而不是把列压成两行。
                触发重扫/失败时只在「已有数据」上盖一层 loading，没数据时用骨架行（不闪、不跳）。
              */
              scroll={{ x: 720 }}
              loading={loading && filtered.length > 0}
              showSorterTooltip={false}
              pagination={{
                pageSize: PAGE_SIZE,
                current: Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))),
                onChange: setPage,
                hideOnSinglePage: true,
                showSizeChanger: false,
                size: 'small'
              }}
              locale={{
                emptyText: loading ? (
                  <LoadingRows rows={6} bordered={false} label="正在扫描用例目录" />
                ) : slot.error ? (
                  <StateEmpty
                    size="page"
                    kind="failed"
                    object="用例索引"
                    desc="目录没配、路径写错或没有读权限都可能读不到：到「设置 → 用例目录」改一下，或者先换个目录"
                    detail={slot.detail || slot.error}
                    action={{ label: '重新扫描', onClick: () => load(true) }}
                    secondary={{ label: '打开目录', onClick: openDir }}
                  />
                ) : hasAnyFilter ? (
                  <StateEmpty
                    size="page"
                    kind="no-match"
                    keyword={keyword.trim()}
                    desc="数据还在，只是被关键词 / 目录 / 风险 / 格式筛掉了"
                    action={{ label: '清空筛选', onClick: clearFilters }}
                  />
                ) : (
                  <StateEmpty
                    size="page"
                    kind="no-data"
                    object="用例文件"
                    desc="把 markdown 用例放到这个目录下，点「重新扫描」就能建索引（只读，不写回任何文件）"
                    action={{ label: '重新扫描', onClick: () => load(true) }}
                    secondary={{ label: '打开目录', onClick: openDir }}
                  />
                )
              }}
              onRow={(row: any) => ({
                onClick: () => setDetail({ file: row.file, item: row.item }),
                style: { cursor: 'pointer' }
              })}
            />
          </div>
        </div>
      </div>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={720}
        title={
          detail ? (
            <div className="case-drawer-title">
              <span>{detail.item.title}</span>
              <span className="case-drawer-tags">
                {detail.item.risk ? <Tag color={riskTone(detail.item.risk)}>{detail.item.risk}</Tag> : null}
                {detail.item.type ? <Tag>{detail.item.type}</Tag> : null}
                {detail.item.corePath ? <Tag color="purple">核心路径</Tag> : null}
              </span>
            </div>
          ) : (
            ''
          )
        }
        extra={
          detail ? (
            <div className="drawer-extra">
              <Button size="small" icon={<CopyOutlined />} onClick={() => copyCase(detail.file, detail.item)}>
                复制用例
              </Button>
              <Button size="small" icon={<FileTextOutlined />} onClick={() => openFile(detail.file.fullPath)}>
                打开源文件
              </Button>
            </div>
          ) : null
        }
      >
        {detail ? (
          <div className="case-detail">
            <div className="case-detail-meta">
              <div>
                <span className="muted">模块</span>
                <span>
                  {detail.item.kind === 'chain' ? '回归链路' : detail.item.module || '—'}
                  {detail.item.branch ? ' / ' + detail.item.branch : ''}
                </span>
              </div>
              <div>
                <span className="muted">文件</span>
                <a onClick={() => openFile(detail.file.fullPath)}>{detail.file.relPath}</a>
                <span className="muted">
                  {' · 第 ' + detail.item.line + ' 行 · 修改于 ' + fmtTime(detail.file.mtime)}
                </span>
              </div>
              {detail.item.covers.length ? (
                <div>
                  <span className="muted">覆盖规则</span>
                  <span>{detail.item.covers.join('、')}</span>
                </div>
              ) : null}
              {detail.item.chainMeta.length ? (
                <div>
                  <span className="muted">链路说明</span>
                  <span>{detail.item.chainMeta.join(' ')}</span>
                </div>
              ) : null}
            </div>

            {detail.item.pre.length ? (
              <section className="case-section">
                <h4>前置</h4>
                <ul className="case-list">
                  {detail.item.pre.map((x, i) => (
                    <li key={i} style={{ marginLeft: (x.depth - 1) * 14 }}>
                      {x.text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {detail.item.steps.length ? (
              <section className="case-section">
                <h4>操作</h4>
                <ol className="case-list">
                  {detail.item.steps.map((x, i) => (
                    <li key={i}>{x.text}</li>
                  ))}
                </ol>
              </section>
            ) : null}

            {detail.item.expects.length ? (
              <section className="case-section">
                <h4>预期</h4>
                <ul className="case-list">
                  {detail.item.expects.map((x, i) => (
                    <li key={i} style={{ marginLeft: Math.max(0, (x.depth - 1) * 14) }}>
                      {x.text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {detail.item.assertions.length ? (
              <section className="case-section">
                <h4>三维断言迹</h4>
                <div className="assert-list">
                  {detail.item.assertions.map((a, i) => (
                    <div className="assert-row" key={i}>
                      <Tag color={a.dim === 'API' ? 'geekblue' : a.dim === 'DB' ? 'cyan' : 'purple'}>
                        {a.dim || '断言'}
                      </Tag>
                      <span>{a.text}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {detail.item.notes.length ? (
              <section className="case-section">
                <h4>备注</h4>
                <ul className="case-list">
                  {detail.item.notes.map((x, i) => (
                    <li key={i}>{x.text}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {detail.item.checklist.length ? (
              <section className="case-section">
                <h4>检查项</h4>
                <ul className="case-list">
                  {detail.item.checklist.map((x, i) => (
                    <li key={i}>
                      <span className="case-check">{x.done ? '☑' : '☐'}</span>
                      {x.text}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="case-section">
              <h4>关联接口{caseLinks.length ? ` (${caseLinks.length})` : ''}</h4>
              {caseLinks.length ? (
                <div className="api-link-list">
                  {caseLinks.map((l: any) => {
                    const rec = apiReady ? apiMap[l.api_id] : null;
                    if (apiReady && !rec) {
                      return (
                        <div className="api-link-row" key={l.id}>
                          <span className="api-link-stale">已失效（接口记录已删除）</span>
                          <Button type="text" size="small" icon={<CloseOutlined />} title="清理" onClick={() => removeCaseLink(l)} />
                        </div>
                      );
                    }
                    const m = methodOf(rec && rec.data ? String(rec.data.method || '') : '');
                    return (
                      <div
                        className="api-link-row"
                        key={l.id}
                        title="点开跳到这条接口记录"
                        onClick={() => rec && onOpenApi && onOpenApi(rec.id)}
                      >
                        <Tag color={m ? m.color : 'default'} className="api-method-tag">
                          {m ? m.label : 'API'}
                        </Tag>
                        <span className="api-link-name">{rec ? rec.title : '…'}</span>
                        <span className="api-link-url muted mono">{rec ? String((rec.data || {}).url || '') : ''}</span>
                        <Button
                          type="text"
                          size="small"
                          icon={<CloseOutlined />}
                          title="取消关联"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeCaseLink(l);
                          }}
                        />
                        <ArrowRightOutlined className="api-link-go" />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="link-empty muted">— 在接口记录详情里点「关联用例」就能挂上，没挂也不影响</div>
              )}
            </section>

            {!detail.item.pre.length &&
            !detail.item.steps.length &&
            !detail.item.expects.length &&
            !detail.item.assertions.length ? (
              <Empty description="这条用例没解析出结构化内容，点右上角打开源文件看原文" />
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}