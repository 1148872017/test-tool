import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ReloadOutlined, Table, Input, Button, Tag, Popconfirm, Segmented, Select, Dropdown, Modal, Tooltip } from 'antd';
import type { InputRef } from 'antd';
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
  MoreOutlined,
  ImportOutlined,
  FileTextOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { buildCurl, fmtTime, recordToText } from '../utils';
import RecordForm from './RecordForm';
import RecordDetail from './RecordDetail';
import VarFillModal from './VarFillModal';
import SyncResultModal from './SyncResultModal';
import ChangeImpactModal from './ChangeImpactModal';
import ImportReportModal from './ImportReportModal';
import CurlImportModal from './CurlImportModal';
import PageShell from './shell/PageShell';
import { parseAccounts, AccountRow } from './AccountsEditor';
import { ROLE_OPTIONS } from '../../shared/collections';
import { asArray, fieldOptions, getOptionsSync, loadOptions, OptionsMap } from '../options';
import { capabilitiesOf, hasHeaderAction, HeaderAction } from '../features/collections/capabilities';

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


/**
 * 把 data 转成可搜索文本，**排除密码字段**。
 *
 * 为什么需要：前端有一层本地过滤（filtered），
 * 直接 JSON.stringify(data) 会把密码拼进去 → 搜密码明文能命中。
 *
 * 排除规则和 store.js 的 searchableDataExpr 保持一致：
 *   - 顶层 secret 字段（type === 'secret'）→ 排除
 *   - 嵌套路径（accounts[].password）→ 整个数组字段排除
 */
function searchableText(data: any): string {
  const out: any = {};
  for (const k of Object.keys(data || {})) {
    let v = data[k];

    // 关键：accounts 存的是 **JSON 字符串**（不是数组），
    // 要先 parse 再处理，否则整个字符串（含密码）会被拼进搜索文本。
    if (typeof v === 'string' && v.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) v = parsed;
      } catch (e) {
        /* 不是 JSON，保持原样 */
      }
    }

    // 账号数组：只保留非密码字段
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      out[k] = v.map((item: any) => {
        const copy: any = {};
        for (const ik of Object.keys(item || {})) {
          if (ik === 'password' || ik === 'secret' || ik === 'token') continue;
          copy[ik] = item[ik];
        }
        return copy;
      });
      continue;
    }

    // 顶层密码类字段
    if (k === 'password' || k === 'secret' || k === 'token') continue;
    out[k] = v;
  }
  return JSON.stringify(out);
}

/**
 * 页头「⋯」菜单的动作元数据。
 *
 * 注意：这里只有「怎么显示」，没有「哪个集合支持」——
 * 后者在 shared/collections.js 的 capabilities.headerActions 里。
 */
const HEADER_ACTION_META: Record<HeaderAction, { label: string; icon: React.ReactNode }> = {
  importData: { label: '导入备份', icon: <UploadOutlined /> },
  importTemplate: { label: '下载模板', icon: <FileTextOutlined /> },
  exportData: { label: '导出', icon: <DownloadOutlined /> },
  refresh: { label: '刷新', icon: <ReloadOutlined /> },
  importReport: { label: '导入压测报告', icon: <BarChartOutlined /> },
  importCurl: { label: '粘贴 cURL 导入', icon: <ImportOutlined /> },
  syncOpenApi: { label: '从 Apifox 同步', icon: <CloudDownloadOutlined /> },
  impact: { label: '上次同步变更', icon: <CloudDownloadOutlined /> }
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 时间戳 → HH:mm（状态栏「上次同步 12:03」） */
function clockText(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

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
  // 每次打开表单 +1，配合 key 强制重挂载（清掉上次的残留状态）
  const [formSeq, setFormSeq] = useState(0);
  // cURL 导入：解析结果作为表单预填值
  const [curlOpen, setCurlOpen] = useState(false);
  // 一键启动时选账号（多个账号且没设默认）
  const [accountPicker, setAccountPicker] = useState<{
    accounts: AccountRow[];
    resolve: (a: AccountRow | null) => void;
  } | null>(null);
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
  /** 左侧标签栏可折叠（窄窗口时把 176px 让给表格） */
  const [asideOpen, setAsideOpen] = useState(true);
  const searchRef = useRef<InputRef>(null);

  const caps = useMemo(() => capabilitiesOf(conf), [conf]);

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

  /**
   * 清空所有筛选（空状态里的「清空筛选」按钮用）。
   *
   * 原来空状态只有一句「换个关键词，或点左侧「全部」清空筛选」——
   * 让用户自己去找，而且「全部」在左侧标签栏第一项，不好找。
   * 空状态必须自带下一步按钮（三态组件的设计原则）。
   */
  const clearAllFilters = () => {
    setKeyword('');
    setFavOnly(false);
    setEnvFilter('');
    setTagFilter('');
  };

  /** 当前是否有任何筛选条件生效 */
  const hasAnyFilter = !!(keyword || favOnly || envFilter || tagFilter);

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
    setFormSeq((n) => n + 1);
    setFormOpen(true);
    if (onLoggedRun) onLoggedRun();
  }, [logFor]);

  // 接口记录页：读上次同步的变更，页头给个入口（有变更才有，没变更不占地方）
  useEffect(() => {
    if (caps.sync !== 'openapi') return;
    api
      .lastSyncChanges()
      .then((v: any) => setImpact(v && v.changed && v.changed.length ? v : null))
      .catch(() => {});
  }, [conf.key, caps.sync]);

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
  /**
   * 上次同步时间：同步结果里的 at 优先；没有就看记录上的 syncedAt。
   * 只用来显示，不参与任何同步判断。
   */
  const lastSyncAt = useMemo(() => {
    const list: number[] = [];
    if (impact && impact.at) list.push(Number(impact.at));
    for (const r of all) {
      const v = Number((r.data || {}).syncedAt || 0);
      if (v) list.push(v);
    }
    return list.length ? Math.max.apply(null, list) : 0;
  }, [all, impact]);
  // 全部能力都从 capabilities 读：页面里不再按集合 key 写分支
  const noFav = !caps.favorite;
  const opensInBrowser = !!caps.open;

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
        // 搜索范围：标题 + 标签 + data（**排除密码字段**）
        // 后端 SQL 已经排除了，但前端还有一层本地过滤，这里也要排除，
        // 否则搜密码明文照样能命中（JSON.stringify 会把密码拼进去）。
        const hay = [r.title || '', (r.tags || []).join(','), searchableText(r.data || {})]
          .join(' ')
          .toLowerCase();
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
      /**
       * 集合页导出默认**不含密码明文**。
       *
       * 为什么要改（原来传的是 true）：
       *   导出后用户很可能直接发给别人 / 传网盘，
       *   里面带着 DPAPI 解出来的原始密码——静默泄露。
       *   需要密码时去「设置 → 数据与备份 → 导出含密码」，
       *   那里有明确的二次确认。
       */
      const res = await api.exportData(false, conf.key);
      if (res && res.ok) toast(`已导出 ${res.count} 条${res.file ? '：' + res.file : ''}`);
      else if (res && res.message) toast(res.message, 'warning');
    } catch (e: any) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusyIO(false);
    }
  };

  /**
   * 下载「导入模板」：这个集合的一条字段齐全的示例记录。
   *
   * 为什么放在导入按钮旁边：用户点导入前最常问的就是
   * 「文件长什么样、字段叫什么」。给一条能直接导入的样例，
   * 比让他去翻文档快得多（模板由主进程按 shared/collections.js 生成，
   * 集合加字段模板会自动跟着变）。
   */
  const doTemplate = async () => {
    setBusyIO(true);
    try {
      const res = await api.importTemplate(conf.key);
      if (res && res.ok) {
        const name = res.file ? String(res.file).split(/[\\/]/).pop() : '';
        toast(name ? `模板已保存：${name}` : '模板已保存');
      } else if (res && res.canceled) {
        /* 用户自己在保存框点了取消，不用打扰 */
      } else if (res && res.message) {
        toast(res.message, 'warning');
      }
    } catch (e: any) {
      toast('下载模板失败：' + (e && e.message ? e.message : e), 'error');
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
    setFormSeq((n) => n + 1);
    setFormOpen(true);
  };

  /**
   * 快捷键（状态栏有提示，所以必须真的能用）：
   *   Ctrl/⌘ + N 新增
   *   /          聚焦搜索（输入框里按 / 不抢）
   *   Esc        关闭详情抽屉
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openCreate();
        return;
      }
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape' && detail) {
        setDetail(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

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
    setFormSeq((n) => n + 1);
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
    setFormSeq((n) => n + 1);
    setFormOpen(true);
  };

  /**
   * 页头「⋯」菜单：动作集合与顺序完全由 capabilities.headerActions 决定。
   * 处理函数按动作 key 分发，不判断集合 key。
   */
  const runHeaderAction = (key: string) => {
    if (key === 'importData') doImport();
    else if (key === 'importTemplate') doTemplate();
    else if (key === 'exportData') doExport();
    else if (key === 'refresh') loadAll();
    else if (key === 'importReport') setReportOpen(true);
    else if (key === 'importCurl') setCurlOpen(true);
    else if (key === 'syncOpenApi') doSync();
    else if (key === 'impact') setImpactOpen(true);
  };

  /** 菜单项说明：保留原来 hover 提示里的「导什么 / 什么格式 / 会不会覆盖」 */
  const headerActionDesc = (action: HeaderAction): React.ReactNode => {
    if (action === 'importData') {
      return (
        <>
          <div>
            从 JSON 备份文件<b>合并</b>记录到「{conf.name}」
          </div>
          <div className="pg-menu-desc">
            · 只认 .json（集合级导入不支持整库 .db）
            <br />· 已有的 id 会更新，不会重复
            <br />· 标签和选项一起带过来
          </div>
        </>
      );
    }
    if (action === 'importTemplate') {
      return (
        <>
          <div>
            下载「{conf.name}」的<b>导入模板</b>（一条字段齐全的示例记录）
          </div>
          <div className="pg-menu-desc">
            · 格式和「导出」完全一致，能<b>直接导入</b>
            <br />· 照着把示例值改成你自己的，再点「导入备份」
            <br />· 集合加字段后模板会自动跟着变
          </div>
        </>
      );
    }
    if (action === 'exportData') {
      return (
        <>
          <div>
            把「{conf.name}」的 <b>{all.length} 条</b>记录导出成 JSON 文件
          </div>
          <div className="pg-menu-desc">
            · 含数据、标签、收藏状态
            <br />· <b>不含密码明文</b>（要带密码请去设置页「导出含密码」）
            <br />· 存到桌面，文件名带集合名和日期
          </div>
        </>
      );
    }
    if (action === 'importReport') return <div>选 JMeter 报告目录，自动填一条压测记录</div>;
    if (action === 'importCurl') return <div>粘贴 cURL，解析后预填接口表单</div>;
    if (action === 'syncOpenApi') return <div>从 Apifox 导出的 openapi.json 同步接口镜像（幂等）</div>;
    if (action === 'impact') return <div>看上次同步改了哪些接口、影响哪些用例</div>;
    return <div>重新读取列表</div>;
  };

  const headerMenuItems = caps.headerActions
    .filter((action) => action !== 'impact' || !!(impact && impact.changed && impact.changed.length))
    .map((action) => {
      const meta = HEADER_ACTION_META[action];
      const ioBusy = action === 'importData' || action === 'importTemplate' || action === 'exportData';
      return {
        key: action,
        icon: meta.icon,
        disabled: (ioBusy && busyIO) || (action === 'syncOpenApi' && syncing),
        label: (
          <div className="pg-menu-item">
            <div className="pg-menu-title">
              {meta.label}
              {action === 'impact' && impact ? ` · ${impact.changed.length}` : ''}
              {action === 'syncOpenApi' && syncing ? '（同步中…）' : ''}
            </div>
            <div className="pg-menu-help">{headerActionDesc(action)}</div>
          </div>
        )
      };
    });

  const copy = async (text: string, secret = false, label = '已复制') => {
    if (!text) {
      toast('没有内容可复制', 'warning');
      return;
    }
    await api.copy(String(text), secret);
    toast(label);
  };

  /**
   * 列表行内「复制」：行为由 capabilities.copyKinds[0] 决定。
   *
   * accounts → 优先默认账号密码（30 秒后自动清空）
   * sql      → 打开变量填充弹窗
   * curl     → 生成 cURL
   * text     → 整条记录转人话文本
   *
   * 加新格式只需要在 shared/collections.js 里写明，页面不用改。
   */
  const quickCopy = async (r: any) => {
    const d = r.data || {};
    const kind = caps.copyKinds[0] || 'text';

    if (kind === 'accounts') {
      // 账号在 accounts 数组里：优先默认账号，其次第一个
      const list = parseAccounts(String(d.accounts || ''));
      if (!list.length) {
        toast('这个站点还没记账号', 'warning');
        return;
      }
      const target = list.find((a) => a.isDefault) || list[0];
      if (target.password) return copy(target.password, true, '密码已复制，30 秒后自动清空');
      if (target.account) return copy(target.account, false, '账号已复制');
      toast('这个账号没填账号或密码', 'warning');
      return;
    }
    if (kind === 'sql') {
      setVarTarget(r);
      return;
    }
    if (kind === 'curl') return copy(buildCurl(r), false, 'cURL 已复制');
    return copy(recordToText(r, conf, linkMap), false, '整条已复制');
  };

  /**
   * 用系统默认浏览器打开。
   * 浏览器不允许外部程序往页面里打字，所以这里退一步：
   * 打开的同时把密码复制到剪贴板，切过去 Ctrl+V 就行。
   *
   * 账号选择逻辑：
   *   1. 有 isDefault 的账号 → 用它
   *   2. 只有一个账号 → 自动用
   *   3. 多个且没默认 → 弹窗选
   *   4. 没有账号 → 只打开 URL
   */
  const openSite = async (r: any) => {
    const url = String((r.data || {})[caps.open || 'url'] || '').trim();
    if (!url) {
      toast('这条记录没有填地址', 'warning');
      return;
    }

    const accounts = parseAccounts(String((r.data || {}).accounts || ''));

    // 没有账号：只打开
    if (!accounts.length) {
      try {
        await api.openUrl(url);
        toast('已用浏览器打开（这个站点还没记账号）');
      } catch (e: any) {
        toast('打开失败：' + (e && e.message ? e.message : e), 'error');
      }
      return;
    }

    // 选账号：默认 → 唯一 → 弹窗
    let target = accounts.find((a) => a.isDefault);
    if (!target && accounts.length === 1) target = accounts[0];

    if (!target) {
      // 多个且没默认 → 弹窗选
      target = await pickAccount(accounts);
      if (!target) return; // 用户取消
    }

    try {
      await api.openUrl(url);
    } catch (e: any) {
      toast('打开失败：' + (e && e.message ? e.message : e), 'error');
      return;
    }

    if (target.password && openCopy) {
      await api.copy(target.password, true);
      const who = target.label || target.account || '账号';
      toast(`已打开，${who} 的密码已复制 —— 切过去 Ctrl+V`);
    } else {
      toast('已用浏览器打开');
    }
  };

  /** 弹窗选账号（多个账号且没设默认时） */
  const pickAccount = (accounts: AccountRow[]): Promise<AccountRow | null> =>
    new Promise((resolve) => {
      setAccountPicker({ accounts, resolve });
    });

  /** 删除 = 移入回收站（软删除），之后还能在「回收站」里恢复 */
  const remove = async (r: any) => {
    try {
      await api.removeRecord(r.id);
      toast('已移入回收站');
      if (detail && detail.id === r.id) setDetail(null);
      await loadAll();
      onCounts();
    } catch (e: any) {
      toast('移入回收站失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const renderListField = (f: any, value: any) => {

  // 账号列表：列表页只显示默认账号 + 「+N」提示（完整列表在详情里看）
  if (f.type === 'accounts') {
    const list = parseAccounts(String(value || ''));
    if (!list.length) return <span className="muted">—</span>;
    const def = list.find((a) => a.isDefault) || list[0];
    const more = list.length - 1;
    // 完整信息放 Tooltip，列表里单行省略（内容长时不换行撑高行）
    const tip = [
      def.label ? `用途：${def.label}` : '',
      `账号：${def.account || '—'}`,
      def.role && def.role.length ? `角色：${def.role.join('、')}` : '',
      more > 0 ? `另有 ${more} 个账号，点开详情查看` : ''
    ]
      .filter(Boolean)
      .join('\n');
    return (
      <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
        <span className="account-cell">
          <span className="account-cell-main">
            {def.label ? <span className="account-cell-label">{def.label}</span> : null}
            <span className="mono account-cell-account">{def.account || '—'}</span>
          </span>
          {more > 0 ? <span className="account-cell-more">+{more}</span> : null}
        </span>
      </Tooltip>
    );
  }
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
    accounts: 2.2,   // 账号列内容长（用途 + 账号 + 角色），给更多空间
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
  // 名称列宽度来自 capabilities.titleWidthPct。
  // 迁移注脚：旧实现写的是 conf.key === 'sites' ? 32 : 50；
  // 现在站点（账号列内容长）在 shared/collections.js 里配 32，组件不再认识集合名。
  const titlePct = !hasList ? 64 : caps.titleWidthPct;
  const titleWidth = `${titlePct}%`;
  const restPct = hasList ? 100 - titlePct : 36;
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
              setFormSeq((n) => n + 1);
    setFormOpen(true);
            }}
          />
          <Popconfirm
            title="移入回收站？"
            description="之后可以在回收站里恢复"
            okText="移入回收站"
            cancelText="取消"
            onConfirm={() => remove(r)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} title="移入回收站" />
          </Popconfirm>
        </div>
      )
    }
  ];

  return (
    <>
      <PageShell
      title={conf.name}
      desc={conf.desc}
      count={all.length}
      fill
      actions={
        <>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增
          </Button>
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            menu={{ items: headerMenuItems, onClick: ({ key }) => runHeaderAction(key) }}
          >
            <Button icon={<MoreOutlined />} aria-label="更多操作" title="更多操作" />
          </Dropdown>
        </>
      }
      bar={
        <>
          <Button
            type="text"
            size="small"
            className="pg-aside-toggle"
            icon={asideOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            title={asideOpen ? '收起标签栏' : '展开标签栏'}
            onClick={() => setAsideOpen((v) => !v)}
          />

          <button
            type="button"
            className={'pg-chip' + (!favOnly && !tagFilter ? ' active' : '')}
            onClick={() => {
              setFavOnly(false);
              setTagFilter('');
            }}
          >
            全部 <b>{all.length}</b>
          </button>
          {!noFav ? (
            <button
              type="button"
              className={'pg-chip' + (favOnly ? ' active' : '')}
              title="只看收藏"
              onClick={() => {
                setFavOnly((v) => !v);
                setTagFilter('');
              }}
            >
              收藏 <b>{favoriteCount}</b>
            </button>
          ) : null}

          {filterOptions.length ? (
            <Segmented
              size="small"
              value={envFilter || 'all'}
              onChange={(v) => setEnvFilter(v === 'all' ? '' : String(v))}
              options={[{ label: '全部环境', value: 'all' }, ...filterOptions]}
            />
          ) : null}

          {tagList.length ? (
            <Select
              size="small"
              allowClear
              className="pg-tag-filter"
              value={tagFilter || undefined}
              placeholder="标签"
              onChange={(v) => {
                setTagFilter(v ? String(v) : '');
                setFavOnly(false);
              }}
              options={tagList.map((t) => ({ value: t.name, label: `${t.name}（${t.count}）` }))}
            />
          ) : null}

          <span className="pg-bar-spacer" />

          <Input
            ref={searchRef}
            allowClear
            className="pg-search"
            prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
            placeholder="搜索标题、内容、标签"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            size="small"
            className="pg-sort"
            value={sortKey}
            onChange={setSortKey}
            options={[
              { value: 'updated_desc', label: '最近修改' },
              { value: 'updated_asc', label: '最早修改' },
              { value: 'title_asc', label: '名称 A→Z' },
              { value: 'title_desc', label: '名称 Z→A' }
            ]}
          />
        </>
      }
      status={
        <>
          <span>共 {all.length} 条</span>
          {filtered.length !== all.length ? <span>当前 {filtered.length} 条</span> : null}
          <span className="pg-status-sep">·</span>
          <span>本周新增 {weekCount}</span>
          <span className="pg-status-sep">·</span>
          <span>上次同步 {lastSyncAt ? clockText(lastSyncAt) : '—'}</span>
          <span className="pg-status-spacer" />
          <span className="pg-status-keys">Ctrl+N 新增 · / 搜索 · Esc 关闭详情</span>
        </>
      }
    >
      <div className={'collection-body' + (asideOpen ? '' : ' collection-body--folded')}>
        {asideOpen ? (
          <aside className="tag-panel collection-aside">
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
        ) : null}

        <div className="collection-main">
          {/*
            固定表头的实测结论：
              `.pg-body` 是唯一滚动容器，antd 的 `sticky={{ offsetHeader: 0 }}`
              会把手势列（而不是整张表）钉在滚动区顶部，正好覆盖在 .pg-bar 下方；
              而 `scroll={{ y }}` 会给表格再套一层内部滚动，表头是保住了，
              但筛选条 / 状态栏又会被拆成第二个滚动上下文——正是这次要消灭的。
              所以这里用 sticky 属性 + 作用域 CSS（.pg-body .ant-table-thead th）兜底背景。
          */}
          <Table
            className="collection-table"
            dataSource={filtered}
            columns={columns}
            rowKey="id"
            size="middle"
            tableLayout="fixed"
            loading={loading}
            sticky={{ offsetHeader: 0 }}
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
                  <div className="empty-title">
                    {hasAnyFilter ? '没有匹配的记录' : `还没有${conf.name}记录`}
                  </div>
                  <div className="empty-desc">
                    {hasAnyFilter
                      ? '换个关键词，或者清掉当前的筛选条件'
                      : '点下面按钮录入第一条，之后就能一键复制/打开'}
                  </div>
                  {/*
                    空状态必须自带下一步动作（三态组件的设计原则）：
                      有筛选 → 「清空筛选」
                      没数据 → 「新增」
                  */}
                  {hasAnyFilter ? (
                    <Button icon={<ReloadOutlined />} onClick={clearAllFilters}>
                      清空筛选
                    </Button>
                  ) : (
                    <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                      新增
                    </Button>
                  )}
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
      </PageShell>

      <RecordDetail
        record={detail}
        conf={conf}
        linkMap={linkMap}
        onClose={() => setDetail(null)}
        onEdit={() => {
          setFormRecord(detail);
          setFormSeq((n) => n + 1);
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
        // key 用「记录 id + 打开次数」：每次打开都强制重挂载，
        // 避免上次编辑残留（比如加了账号没保存，下次打开还在）
        key={`${formRecord && formRecord.id ? formRecord.id : 'new'}-${formSeq}`}
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
        varsRaw={varTarget && varTarget.data ? String(varTarget.data.vars || '') : ''}
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

      {hasHeaderAction(caps, 'importReport') ? (
        <ImportReportModal open={reportOpen} onClose={() => setReportOpen(false)} onImport={importReport} />
      ) : null}

      <CurlImportModal open={curlOpen} onClose={() => setCurlOpen(false)} onImport={onCurlImport} />

      {/* 一键启动：多个账号且没设默认时，选一个 */}
      <Modal
        open={!!accountPicker}
        title="用哪个账号登录？"
        footer={null}
        onCancel={() => {
          if (accountPicker) accountPicker.resolve(null);
          setAccountPicker(null);
        }}
        width={480}
      >
        <div className="account-picker">
          {(accountPicker ? accountPicker.accounts : []).map((a, i) => (
            <div
              key={i}
              className="account-picker-item"
              onClick={() => {
                if (accountPicker) accountPicker.resolve(a);
                setAccountPicker(null);
              }}
            >
              <div className="account-picker-main">
                <span className="account-picker-label">{a.label || a.account || '未命名'}</span>
                {a.role && a.role.length ? (
                  <span className="role-tags" style={{ marginLeft: 8 }}>
                    {a.role.map((v) => {
                      const opt = ROLE_OPTIONS.find((o: any) => o.value === v);
                      return (
                        <Tag key={v} color={opt && opt.color ? opt.color : 'default'} style={{ margin: '0 4px 0 0' }}>
                          {opt ? opt.label : v}
                        </Tag>
                      );
                    })}
                  </span>
                ) : null}
              </div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                {a.account || '—'}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}