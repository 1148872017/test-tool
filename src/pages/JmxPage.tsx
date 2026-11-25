import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Table, Input, Button, Tag, Drawer, Segmented, Tooltip, Alert, Modal } from 'antd';
import {
  ReloadOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  FolderOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  CopyOutlined,
  RocketOutlined,
  CodeOutlined,
  RedoOutlined,
  EditOutlined,
  SaveOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import ScriptTemplatesDrawer from '../components/ScriptTemplatesDrawer';
import StateEmpty from '../components/states/StateEmpty';
import StateError from '../components/states/StateError';
import LoadingRows from '../components/states/LoadingRows';
import { buildHandoff, plainDomain, setJmxHandoff } from '../features/jmx/handoff';
import type { JmxSource } from '../features/jmx/handoff';
import { buildHayIndex, jmxHay, matchHay, normalizeKeyword, readHay } from '../utils/searchIndex';

/** 每页条数（分页受控 + 页码收敛共用） */
const PAGE_SIZE = 50;

/**
 * 扫描结果槽位：data = 上一次成功的结果，error = 这一次没成功。
 * 失败时只记错误、不清 data（CodeScanPage 的「失败不清屏」slot 模式）。
 */
type ScanSlot = { data: any; error: string; detail: string; at: number };

const LEVEL_ICON: Record<string, any> = {
  error: <CloseCircleOutlined style={{ color: '#e5534b' }} />,
  warn: <WarningOutlined style={{ color: '#f5a623' }} />,
  info: <InfoCircleOutlined style={{ color: 'var(--text-3)' }} />,
  ok: <CheckCircleOutlined style={{ color: '#3fbf7f' }} />
};

const LEVEL_TEXT: Record<string, string> = { error: '有问题', warn: '待完善', info: '提示', ok: '正常' };

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 文件大小：详情抽屉头部展示（字节数太抽象） */
const fmtSize = (n: number) => {
  const b = Number(n) || 0;
  if (b <= 0) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
};

/** 数值展示：null / 空串统一显示「—」（jmx 里没配的项就是空串） */
const showNum = (v: any, suffix = '') => (v === null || v === undefined || v === '' ? '—' : String(v) + suffix);

/* ============================================================
 * L2 局部编辑（会写回文件）
 *
 * 契约（后端照此实现，前端不参与改写）：
 *   jmx:detail → editable { stamp, groups:[{index,type,name,numThreads,rampUp,loops}],
 *                           assertions:[{index,name,testField,value}] }
 *   · type ∈ thread / setup / teardown；groups 现在三类线程组都进来（以前只有字面量 ThreadGroup），
 *     index 是全文顺序下三类合起来的序号（scan 的 threadGroups 也是同一个顺序）。
 *   值可能是空串 = 这个 prop 不在文件里 → 输入框 disabled + 提示「文件里没有这一项」
 *   jmx:writeback({ file, stamp, edits:[{kind,type?,index,field,value,name?}] })
 *   · thread 类改动总是带 type：后端会核对类型一致，防止 index 漂移改错行；
 *   · 值区间：numThreads 1..1000000、rampUp 0..1000000、loops -1（永久循环）或 1..1000000；
 *   · 成功返回 pruned:number（本次清理掉的旧备份份数，保留最近 10 份）。
 * ============================================================ */

/** 线程组行里可改的三个数字字段（顺序就是界面上的列顺序） */
const EDIT_NUM_FIELDS: { key: string; label: string }[] = [
  { key: 'numThreads', label: '线程数' },
  { key: 'rampUp', label: '爬坡秒' },
  { key: 'loops', label: '循环次数' }
];

/**
 * 线程组类型徽标（editable.groups[].type）。
 *
 * 以前 editable 里只有字面量 ThreadGroup，SetupThreadGroup / PostThreadGroup 根本不可编辑；
 * 现在三类都进来，靠徽标区分，否则用户分不清「这条是普通线程组还是 setUp/tearDown」。
 * type 缺失（老后端）按 thread 显示，不做假报错。
 */
const EDIT_TG_BADGE: Record<string, { label: string; color: string }> = {
  thread: { label: '线程组', color: 'blue' },
  setup: { label: '前置', color: 'gold' },
  teardown: { label: '后置', color: 'default' }
};

const tgBadgeOf = (type: any) => EDIT_TG_BADGE[String(type == null ? '' : type)] || EDIT_TG_BADGE.thread;

/** 确认框里 from → to 的中文字段名 */
const EDIT_FIELD_LABEL: Record<string, string> = {
  numThreads: '线程数',
  rampUp: '爬坡秒',
  loops: '循环次数',
  value: '值'
};

/** 写回失败按 error code 给不同标题；STALE 的文案是契约里点名的 */
const EDIT_ERROR_TITLE: Record<string, string> = {
  STALE: '文件已被外部改动，请重新加载详情',
  NOT_EDITABLE: '这些项不能改',
  BAD_VALUE: '有几个值不合法',
  WRITE_FAILED: '写入文件失败',
  OUTSIDE_ROOT: '文件不在 jmx 目录内，已拒绝写入',
  BAD_PATH: '文件路径不合法',
  NO_SUCH_TARGET: '文件里找不到要改的位置'
};

type EditChange = { kind: 'thread' | 'assertion'; index: number; field: string; from: string; to: string };
type EditFail = { code: string; message: string };

const editKey = (kind: string, index: number, field: string) => kind + ':' + index + ':' + field;
const textOf = (v: any) => (v === null || v === undefined ? '' : String(v));

const EDIT_GRID = 'minmax(100px, 1fr) 72px 72px 132px';
const EDIT_ASSERT_GRID = 'minmax(120px, 1fr) 100px 132px';
const editGridRow: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  alignItems: 'center',
  padding: '3px 6px',
  borderRadius: 6
};
const editGridHead: React.CSSProperties = {
  ...editGridRow,
  fontSize: 11,
  color: 'var(--text-3)',
  paddingBottom: 2
};

/**
 * 局部编辑的输入框。
 *
 * 「文件里没有这一项」的分支**不传 value**（等同于 undefined）：
 * 传受控 value="" 会让 antd 吞掉 placeholder（踩坑 #6），
 * 用户就只看到一个空白框，不知道为什么不能填。
 *
 * 可编辑分支同理：用户把值清空时 value 传 undefined，
 * 这样 loops 的「-1 = 永久循环」提示才会重新显示出来，而不是留一个空白框。
 */
function EditCell({ value, missing, numeric, ariaLabel, placeholder, title, onChange }: {
  value: string;
  missing: boolean;
  numeric: boolean;
  ariaLabel: string;
  /** 覆盖默认提示（loops 用「-1 = 永久循环」，其它数字字段仍是「数字」） */
  placeholder?: string;
  title?: string;
  onChange: (v: string) => void;
}) {
  if (missing) {
    return (
      <Input
        size="small"
        disabled
        aria-label={ariaLabel}
        placeholder="文件里没有这一项"
        title="文件里没有这一项（jmx 里没有这个 prop，界面不会替你新建）"
      />
    );
  }
  return (
    <Input
      size="small"
      aria-label={ariaLabel}
      inputMode={numeric ? 'numeric' : undefined}
      placeholder={placeholder || (numeric ? '数字' : '值')}
      title={title || placeholder || undefined}
      value={value === '' ? undefined : value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * 元件类型 → 中文名。
 *
 * 注意：详情里**仍然显示原始 testclass**（JSR223Assertion / ResponseAssertion…），
 * 中文名只当提示 —— 用户要验证「我加的断言进没进 jmx」，看的就是 JMeter 里那个类名。
 */
const ELEMENT_LABEL: Record<string, string> = {
  JSR223Assertion: 'JSR223 断言',
  JSR223PreProcessor: 'JSR223 前置处理器',
  JSR223PostProcessor: 'JSR223 后置处理器',
  JSR223Sampler: 'JSR223 采样器',
  JSR223Timer: 'JSR223 定时器',
  ResponseAssertion: '响应断言',
  DurationAssertion: '持续时间断言',
  BeanShellAssertion: 'BeanShell 断言',
  BeanShellPreProcessor: 'BeanShell 前置处理器',
  BeanShellPostProcessor: 'BeanShell 后置处理器',
  JSONPathAssertion: 'JSONPath 断言',
  SizeAssertion: '大小断言',
  XPathAssertion: 'XPath 断言',
  XPath2Assertion: 'XPath2 断言',
  JSONPostProcessor: 'JSON 提取器',
  CSVDataSet: 'CSV 数据源',
  HeaderManager: 'HTTP 信息头管理器',
  ConfigTestElement: 'HTTP 请求默认值',
  Arguments: '用户定义变量',
  CookieManager: 'HTTP Cookie 管理器',
  CacheManager: 'HTTP 缓存管理器',
  ConstantTimer: '固定定时器',
  SyncTimer: '同步定时器',
  UniformRandomTimer: '均匀随机定时器',
  GaussianRandomTimer: '高斯随机定时器'
};

const elementLabel = (type: string) => ELEMENT_LABEL[type] || type;

/** JSR223 / BeanShell 这类「脚本元件」用紫色，普通断言蓝色，其余灰色 */
const elementColor = (type: string) => {
  if (/^JSR223/.test(type) || /^BeanShell/.test(type)) return 'purple';
  if (type === 'ResponseAssertion' || type === 'DurationAssertion') return 'blue';
  if (type === 'CSVDataSet') return 'green';
  return 'default';
};

/**
 * 采样器下挂的元件（断言 / 前置 / 后置 / 定时器）一行。
 *
 * 这就是「L1 只读详情」的核心：能把 JSR223Assertion 这类元件按采样器列出来，
 * 用户生成完脚本后可以在这里确认「我加的断言真的进 jmx 了」。
 * 标签上直接写 testclass（不做中文替换），因为 JMeter GUI 里看到的就是这个名字。
 */
function AttachLine({ label, list }: { label: string; list: any[] }) {
  if (!list || !list.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 3 }}>
      <span className="muted" style={{ fontSize: 12, minWidth: 32 }}>
        {label}
      </span>
      {list.map((a: any, i: number) => (
        <Tag
          key={i}
          color={elementColor(a.type)}
          style={{ marginInlineEnd: 0, fontSize: 11 }}
          title={[elementLabel(a.type), a.name, a.language ? '语言：' + a.language : '', a.scriptPreview || '']
            .filter(Boolean)
            .join('\n')}
        >
          {a.type}
          {a.name ? ' · ' + a.name : ''}
          {a.enabled === false ? '（禁用）' : ''}
        </Tag>
      ))}
    </div>
  );
}

const TG_TYPE_LABEL: Record<string, string> = { thread: '线程组', setup: 'setUp', teardown: 'tearDown' };

/** 监听器类型：guiclass 是稳定的，testname 会被用户改 */
const LISTENER_KIND: Record<string, string> = {
  ViewResultsFullVisualizer: '察看结果树',
  StatVisualizer: '聚合报告',
  SummaryReport: '汇总报告',
  GraphVisualizer: '图形结果',
  RespTimeGraphVisualizer: '响应时间图',
  SimpleDataWriter: '简单数据写入器',
  BackendListenerGui: '后端监听器'
};

const LISTENER_COLOR: Record<string, string> = {
  ViewResultsFullVisualizer: 'blue',
  StatVisualizer: 'purple',
  SummaryReport: 'purple',
  GraphVisualizer: 'cyan',
  RespTimeGraphVisualizer: 'cyan',
  SimpleDataWriter: 'gold',
  BackendListenerGui: 'green'
};

const listenerKindOf = (l: any) => LISTENER_KIND[l.guiClass] || l.name || '监听器';

type JmxPageProps = {
  /**
   * 路由跳转（App.tsx 的 setRoute）。
   * 只用于「基于这个重新生成」→ 跳到「脚本生成」页；
   * 不传也能正常用（预览/单测里没有路由）。
   */
  onNavigate?: (route: any) => void;
};

export default function JmxPage({ onNavigate }: JmxPageProps = {}) {
  const [slot, setSlot] = useState<ScanSlot>({ data: null, error: '', detail: '', at: 0 });
  // 立刻解构：下面 effect 的依赖数组在渲染期求值，晚声明会撞 TDZ
  const data = slot.data;
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');
  const [dirFilter, setDirFilter] = useState('');
  // 分页受控：换目录/改筛选回第 1 页，数据变少只夹紧不归零
  const [page, setPage] = useState(1);
  /** 当前打开的行（来自 scan，健康检查结果直接复用，不重复算） */
  const [detail, setDetail] = useState<any>(null);
  /** jmx:detail 的解析结果（按需解析：点开一行才读一次文件） */
  const [info, setInfo] = useState<any>(null);
  const [infoError, setInfoError] = useState('');
  const [infoLoading, setInfoLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  /** 局部编辑：默认折叠（只读优先），展开后才显示输入框 */
  const [editOpen, setEditOpen] = useState(false);
  /** 草稿：key = kind:index:field → 输入框当前值；没碰过的字段不在里面 */
  const [editDraft, setEditDraft] = useState<Record<string, string>>({});
  const [editFail, setEditFail] = useState<EditFail | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.jmxScan();
      if (res && res.error) {
        // 目录没配 / 不存在：保留上一次的扫描结果，只压一条错误说明
        setSlot((prev) => ({ data: prev.data, error: String(res.error), detail: '', at: Date.now() }));
        toast(res.error, 'warning');
        return;
      }
      setSlot({ data: res, error: '', detail: '', at: Date.now() });
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

  // 必须 memo：每次渲染都造新数组会让下面的 hay 索引每次按键都重建
  const files = useMemo(() => (data && data.files ? data.files : []), [data]);

  const dirs = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) {
      const key = f.dir || '（根目录）';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [files]);

  /** 扫描时算一次 hay，按键只做 indexOf（和 CasePage / CollectionPage 同一套） */
  const hayIndex = useMemo(
    () => buildHayIndex(files, (f: any) => String(f && f.relPath ? f.relPath : ''), (f: any) => jmxHay(f)),
    [files]
  );

  const deferredKeyword = useDeferredValue(keyword);
  const kw = normalizeKeyword(deferredKeyword);
  const searching = keyword !== deferredKeyword;

  const filtered = useMemo(() => {
    return files.filter((f: any) => {
      if (dirFilter && (f.dir || '（根目录）') !== dirFilter) return false;
      if (levelFilter !== 'all' && (f.health || {}).level !== levelFilter) return false;
      return matchHay(readHay(hayIndex, f.relPath), kw);
    });
  }, [files, kw, levelFilter, dirFilter, hayIndex]);

  // 换目录 / 改筛选 → 回第 1 页
  useEffect(() => {
    setPage(1);
  }, [dirFilter, levelFilter, kw]);

  // 数据变少（目录里删了脚本）→ 只夹紧页码，不归零
  useEffect(() => {
    const max = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    setPage((p) => (p > max ? max : p));
  }, [filtered.length]);

  const openGui = async (f: any) => {
    const res = await api.jmxOpenGui(f.fullPath);
    if (res && res.ok) {
      toast('已用 JMeter 打开，稍等界面加载');
    } else {
      showLaunchError(res);
    }
  };

  const launchJmeter = async () => {
    setLaunching(true);
    try {
      const res = await api.jmxLaunch();
      if (res && res.ok) toast('JMeter 已启动，用 File → Open 选脚本');
      else showLaunchError(res);
    } catch (e: any) {
      toast('启动失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLaunching(false);
    }
  };

  /** 启动失败时给可操作的提示，而不是把 spawn EINVAL 这种原始错误甩给用户 */
  const showLaunchError = (res: any) => {
    const code = (res && res.code) || '';
    const msg = (res && res.message) || '';
    if (code === 'JMETER_NOT_FOUND') {
      toast('没找到 JMeter —— 请到「设置 → 压测」里指定 bin\\jmeter.bat', 'error');
      return;
    }
    if (code === 'JMX_NOT_FOUND' || code === 'NO_FILE') {
      toast(msg || '脚本文件不存在', 'error');
      return;
    }
    if (code === 'EINVAL') {
      toast('启动失败：JMeter 路径可能含特殊字符，请到设置里重新选择 jmeter.bat', 'error');
      return;
    }
    if (code === 'ENOENT') {
      toast('启动失败：找不到 jmeter.bat，请到设置里重新指定', 'error');
      return;
    }
    if (code === 'EACCES') {
      toast('启动失败：没有执行权限，请检查 jmeter.bat 所在目录', 'error');
      return;
    }
    toast(msg || '启动 JMeter 失败', 'error');
  };

  const openDir = async () => {
    const root = data && data.root;
    if (!root) return;
    const res = await api.jmxReveal(root);
    if (res && res.ok === false && res.message) toast(res.message, 'warning');
  };

  /** 空状态里的下一步：清空筛选（脚本其实在列表里） */
  const clearFilters = () => {
    setKeyword('');
    setDirFilter('');
    setLevelFilter('all');
  };

  const copySummary = async (f: any) => {
    const lines = [`【${f.file}】JMeter ${f.jmeterVersion || '?'}`];
    for (const t of f.threadGroups) {
      lines.push(`线程组 ${t.name}：${t.numThreads} 线程 / ramp ${t.rampUp}s${t.enabled ? '' : '（禁用）'}`);
    }
    for (const s of f.samplers) {
      lines.push(`  ${s.method} ${s.path || '(继承默认值)'}  ${s.name}`);
    }
    if (f.csvs.length) lines.push('CSV：' + f.csvs.map((c) => c.filename).join('、'));
    if (f.health.issues.length) {
      lines.push('问题：');
      for (const i of f.health.issues) lines.push(`  [${i.level}] ${i.title}`);
    }
    await api.copy(lines.join('\n'));
    toast('已复制脚本摘要');
  };

  /**
   * 拉单文件详情：打开抽屉 / 写回成功后刷新 / STALE 后重新加载，共用这一条。
   *
   * 每次成功都清空编辑草稿：editable 里的 stamp 和字段值就是新基线，
   * 留着旧草稿会显示「已改 N 项」，但那些改动其实已经写进文件了。
   */
  const loadInfo = async (file: string) => {
    setInfoLoading(true);
    setInfoError('');
    setEditDraft({});
    setEditFail(null);
    try {
      const res = await api.jmxDetail(file);
      if (res && res.ok) setInfo(res);
      else setInfoError((res && (res.message || res.code)) || '解析详情失败');
    } catch (e: any) {
      setInfoError('读取详情失败：' + (e && e.message ? e.message : e));
    } finally {
      setInfoLoading(false);
    }
  };

  /**
   * 打开详情抽屉。
   *
   * 为什么要两次数据：
   *   1) 行数据来自 jmx:scan —— 健康检查已经算好，详情页直接复用（不重复算）；
   *   2) jmx:detail 是「点开才解析单文件」—— 目录里几千个 jmx 时，
   *      列表不该为了一次详情把每个文件都深读一遍。
   * 先挂行数据，详情到了再补；详情失败也不影响看健康检查。
   */
  const openDetail = async (f: any) => {
    setDetail(f);
    setInfo(null);
    setInfoError('');
    setEditOpen(false); // 换文件回到「只读优先」的默认姿态
    await loadInfo(f.fullPath);
  };

  /** STALE 后的「重新加载」：重拉同一条详情，拿到新的 stamp */
  const reloadInfo = () => {
    if (!detail) return;
    loadInfo(detail.fullPath);
  };

  const closeDetail = () => {
    setDetail(null);
    setInfo(null);
    setInfoError('');
    setInfoLoading(false);
    setEditOpen(false);
    setEditDraft({});
    setEditFail(null);
  };

  /* ---------------- 局部编辑（L2）：基线 / 草稿 / 差异 ---------------- */

  /** 可编辑基线：后端没返回 editable 时整块退化成说明（不能假装能改） */
  const editSource = info && info.editable ? info.editable : null;
  const editGroups: any[] = editSource && Array.isArray(editSource.groups) ? editSource.groups : [];
  const editAssertions: any[] = editSource && Array.isArray(editSource.assertions) ? editSource.assertions : [];

  const setEditValue = (kind: string, index: number, field: string, v: string) => {
    const k = editKey(kind, index, field);
    setEditDraft((prev) => ({ ...prev, [k]: v }));
  };

  const editValueOf = (kind: string, index: number, field: string, fallback: string) => {
    const k = editKey(kind, index, field);
    return editDraft[k] !== undefined ? editDraft[k] : fallback;
  };

  /**
   * 草稿与基线的差异。
   * 值为空串 = 文件里没有这一项（输入框已禁用），不参与 diff；
   * 只和基线不同的才算「改过」，用来标黄点 / 决定按钮能不能点。
   */
  const editChanges = useMemo<EditChange[]>(() => {
    if (!editSource) return [];
    const out: EditChange[] = [];
    for (const g of editGroups) {
      for (const f of EDIT_NUM_FIELDS) {
        const from = textOf(g[f.key]);
        if (from === '') continue;
        const cur = editDraft[editKey('thread', g.index, f.key)];
        if (cur === undefined) continue;
        const to = String(cur).trim();
        if (to !== from) out.push({ kind: 'thread', index: g.index, field: f.key, from, to });
      }
    }
    for (const a of editAssertions) {
      const from = textOf(a.value);
      if (from === '') continue;
      const cur = editDraft[editKey('assertion', a.index, 'value')];
      if (cur === undefined) continue;
      const to = String(cur).trim();
      if (to !== from) out.push({ kind: 'assertion', index: a.index, field: 'value', from, to });
    }
    return out;
  }, [editSource, editGroups, editAssertions, editDraft]);

  /** 改过的行（黄点 + 行底色） */
  const touchedRows = useMemo(() => {
    const set = new Set<string>();
    for (const c of editChanges) set.add(c.kind + ':' + c.index);
    return set;
  }, [editChanges]);

  /** 目标名字（来自后端 editable）；后端写回时用它核对 index 没漂移 */
  const editTargetName = (kind: string, index: number) => {
    const list = kind === 'thread' ? editGroups : editAssertions;
    const hit = list.find((x: any) => Number(x.index) === Number(index));
    return hit && hit.name ? String(hit.name) : '';
  };

  /** 线程组类型（来自 editable）；老后端没有这个字段就按普通线程组（thread） */
  const threadGroupTypeOf = (index: number) => {
    const hit = editGroups.find((x: any) => Number(x.index) === Number(index));
    return hit && hit.type ? String(hit.type) : 'thread';
  };

  const editNameOf = (kind: string, index: number) => editTargetName(kind, index) || '第 ' + (Number(index) + 1) + ' 个';

  /** 确认框里的一行：「线程组「用户模块」线程数 10 → 20」 */
  const describeChange = (c: EditChange) => {
    const label = EDIT_FIELD_LABEL[c.field] || c.field;
    const name = editNameOf(c.kind, c.index);
    if (c.kind === 'thread') {
      return '线程组「' + name + '」' + label + ' ' + (c.from || '（空）') + ' → ' + (c.to || '（空）');
    }
    return '断言「' + name + '」' + label + ' ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to);
  };

  /**
   * 写回后同步左侧列表：用 changes + editable 就地打回 scan 的那一行。
   *
   * 为什么优先就地更新而不是重扫：
   *   1) 重扫要整目录深读，几十上百个 jmx 时又慢又可能让列表顺序变化（视觉跳动）；
   *   2) 用户可能正带着关键词 / 目录筛选、停在某一页，重扫会让人怀疑「我筛的东西没了」；
   *   3) 这次写回只动了几个数字，scan 那行的 numThreads / rampUp / loops 就是这几个数字，
   *      没必要为三个数字重读整个目录。
   * 只有映射对不上（行不在当前扫描结果里、同名线程组有多条无法定位）才降级成静默重扫。
   *
   * 返回 true = 已就地更新；false = 调用方走静默重扫兜底。
   */
  const patchScanRow = (fullPath: string, changes: EditChange[], editable: any): boolean => {
    const row = files.find((f: any) => f && f.fullPath === fullPath);
    if (!row) return false;
    const groups: any[] = editable && Array.isArray(editable.groups) ? editable.groups : editGroups;
    const tgList: any[] = Array.isArray(row.threadGroups) ? row.threadGroups : [];
    const next = tgList.map((t: any) => ({ ...t }));
    for (const c of changes) {
      // 断言值不出现在列表列里（列表只显示线程数/健康度），不用改 scan 行
      if (c.kind !== 'thread') continue;
      const g = groups.find((x: any) => Number(x.index) === Number(c.index));
      if (!g) return false;
      const name = String(g.name == null ? '' : g.name).trim();
      const type = String(g.type == null ? '' : g.type) || 'thread';
      /**
       * 契约：editable.index 是全文顺序下三类线程组合起来的序号，
       * scan 的 threadGroups 也是同一个顺序 —— 先按 index 位置认，**名字对得上才敢改**。
       */
      let pos = -1;
      if (next[c.index] && name && String(next[c.index].name || '').trim() === name) pos = c.index;
      if (pos < 0) {
        // 位置对不上：退一步按「同名 + 同类型」找唯一一条；找不到或多条同名就放弃（不猜）
        const hits: number[] = [];
        next.forEach((t: any, i: number) => {
          if (String(t.name || '').trim() === name && String(t.type || 'thread') === type) hits.push(i);
        });
        if (hits.length !== 1) return false;
        pos = hits[0];
      }
      next[pos] = { ...next[pos], [c.field]: c.to };
    }
    setSlot((prev) => {
      if (!prev.data || !Array.isArray(prev.data.files)) return prev;
      return {
        ...prev,
        data: {
          ...prev.data,
          files: prev.data.files.map((f: any) => (f && f.fullPath === fullPath ? { ...f, threadGroups: next } : f))
        }
      };
    });
    // 抽屉里「详情没读回来时退回 scan 结构」用的那份行数据也一起换，免得关掉编辑又看到旧数字
    setDetail((d: any) => (d && d.fullPath === fullPath ? { ...d, threadGroups: next } : d));
    return true;
  };

  /**
   * 降级路径：静默重扫。
   *
   * 不 loading（不盖遮罩）、不 toast（写回本身已经成功了，重扫失败只是列表暂时旧值）；
   * 筛选（keyword / dirFilter / levelFilter）和页码都是独立 state，重扫不动它们，
   * 表格也不换 key，滚动位置自然留在原地 —— 用户不会觉得「页面被重置了」。
   */
  const rescanSilently = async () => {
    try {
      const res = await api.jmxScan();
      if (res && !res.error) setSlot({ data: res, error: '', detail: '', at: Date.now() });
    } catch (e) {
      /* 静默：写回已成功，列表旧值不影响正确性 */
    }
  };

  /**
   * 真正执行写回。失败不抛（Modal.confirm 的 onOk 抛错会卡住弹窗），
   * 而是落到 editFail 里按 error code 给不同文案。
   */
  const doWriteback = async (changes: EditChange[]) => {
    if (!detail || !editSource) return;
    setSaving(true);
    setEditFail(null);
    try {
      const res = await api.jmxWriteback({
        file: detail.fullPath,
        stamp: editSource.stamp,
        edits: changes.map((c) => {
          const edit: any = { kind: c.kind, index: c.index, field: c.field, value: c.to };
          // 线程组必传 type（后端据此核对 index 没漂移，setup/teardown 对不上会直接拒绝）；
          // 断言没有 type 概念，不传。
          if (c.kind === 'thread') edit.type = threadGroupTypeOf(c.index);
          // 可选 name（后端支持）：详情打开后索引万一漂移，后端能直接回 NO_SUCH_TARGET，而不是改错行
          const nm = editTargetName(c.kind, c.index);
          if (nm) edit.name = nm;
          return edit;
        })
      });
      if (res && res.ok) {
        const backup = String(res.backup || '');
        const backupName = backup.split(/[\\/]/).pop() || '';
        // pruned = 本次清理掉的旧备份份数（后端只保留最近 10 份 .bak）
        const pruned = Number(res.pruned) || 0;
        toast(
          '已写回 ' +
            changes.length +
            ' 项' +
            (backupName ? '，备份：' + backupName : '') +
            (pruned > 0 ? '；已清理 ' + pruned + ' 份旧备份（保留最近 10 份）' : '')
        );
        // 先用返回值顶一下（重拉失败时仍有新基线），再按契约重新拉一次 detail
        if (res.editable) setInfo((prev: any) => (prev ? { ...prev, editable: res.editable } : prev));
        // 左侧列表的线程数也要跟着变：先就地打补丁，映射对不上才静默重扫（不丢筛选/分页/滚动）
        if (!patchScanRow(detail.fullPath, changes, res.editable)) await rescanSilently();
        await loadInfo(detail.fullPath);
        return;
      }
      setEditFail({
        code: (res && res.code) || 'WRITE_FAILED',
        message: (res && res.message) || '后端没有给出失败原因'
      });
    } catch (e: any) {
      setEditFail({ code: 'WRITE_FAILED', message: '写回失败：' + (e && e.message ? e.message : e) });
    } finally {
      setSaving(false);
    }
  };

  /** 保存前必过确认框：列全 from → to，并说明会生成 .bak 备份 */
  const confirmWriteback = () => {
    if (!detail || !editSource || !editChanges.length) return;
    const changes = editChanges;
    Modal.confirm({
      title: '保存并写回 jmx 文件',
      width: 560,
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ marginBottom: 6 }}>将改 {changes.length} 项：</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 8 }}>
            {changes.map((c, i) => (
              <div key={i} className="mono" style={{ fontSize: 12, lineHeight: 1.9 }}>
                {describeChange(c)}
              </div>
            ))}
          </div>
          <div style={{ color: '#8a90a2', fontSize: 12, lineHeight: 1.8 }}>
            会先在同目录生成 .bak 备份（自动保留最近 10 份，更旧的会清掉）。
            <br />
            只改上面列出的字段，其它内容（注释 / 缩进 / 其它元件）原样保留。
          </div>
        </div>
      ),
      okText: '保存并写回',
      cancelText: '取消',
      onOk: () => doWriteback(changes)
    });
  };

  /**
   * 「基于这个重新生成」：把源脚本的线程数 / Ramp-Up / 循环 / 域名 / 端口 / 协议带到「脚本生成」页。
   *
   * 为什么一定要带端口：shared/jmxgen.js:349-350 里 domain 和 port 是**两个独立来源**
   *   （opts.domain || first.domain、opts.port || first.port），只带域名的话，
   *   端口会退回「第一个选中接口的 URL 端口」—— 源脚本跑 8443、新脚本打 8080，还很难发现。
   *
   * 为什么域名/端口/协议要取**同一条**来源：
   *   `f.defaults` 是 HTTP 请求默认值（所有采样器继承的那条），`f.samplers` 是各采样器自己的。
   *   分开去两处找会拼出「host 取默认值 + port 取采样器」的混搭。
   *   顺序：默认值里第一条有域名的 → 否则第一个有域名的采样器；两组都自带宽高。
   *
   * 交接用模块级槽位（features/jmx/handoff.ts），不动 App.tsx 的路由结构。
   */
  const httpSourceOf = (f: any): JmxSource => {
    const defaults = f && Array.isArray(f.defaults) ? f.defaults : [];
    const d = defaults.find((x: any) => plainDomain(x && x.domain));
    if (d) return { domain: d.domain, port: d.port, protocol: d.protocol };
    const samplers = f && Array.isArray(f.samplers) ? f.samplers : [];
    const s = samplers.find((x: any) => plainDomain(x && x.domain));
    return s ? { domain: s.domain, port: s.port, protocol: s.protocol } : {};
  };

  const regenerateFrom = (f: any) => {
    const src = info && info.threadGroups ? info : f || {};
    setJmxHandoff(buildHandoff((f && f.file) || src.file || '', src, httpSourceOf(f)));
    if (onNavigate) {
      toast('已带过线程数 / Ramp-Up / 循环 / 域名 / 端口，到「脚本生成」页接着改');
      onNavigate({ type: 'tool', key: 'scriptgen' });
    } else {
      toast('已带过线程数 / Ramp-Up / 循环 / 域名 / 端口（当前环境没有路由，无法跳转）', 'warning');
    }
  };

  const columns: any[] = [
    {
      title: '脚本',
      dataIndex: 'file',
      width: '34%',
      render: (_: any, f: any) => (
        <div className="jmx-name-cell">
          <div className="jmx-name-line">
            {LEVEL_ICON[f.health.level]}
            <span className="jmx-name">{f.file}</span>
          </div>
          <div className="jmx-name-meta">
            <Tag className="jmx-tag">JMeter {f.jmeterVersion || '?'}</Tag>
            <Tag className="jmx-tag">{f.threadGroups.length} 线程组</Tag>
            <Tag className="jmx-tag">{f.samplers.length} 采样器</Tag>
            {f.csvs.length ? <Tag className="jmx-tag">{f.csvs.length} CSV</Tag> : null}
          </div>
        </div>
      )
    },
    {
      title: '线程组',
      dataIndex: 'threadGroups',
      width: '26%',
      render: (_: any, f: any) => {
        const enabled = f.threadGroups.filter((t: any) => t.enabled);
        if (!f.threadGroups.length) return <span className="muted">—</span>;
        return (
          <div className="jmx-tg-cell">
            {enabled.slice(0, 2).map((t: any) => (
              <div key={t.name} className="jmx-tg-line">
                <span className="jmx-tg-name">{t.name}</span>
                <span className="muted">{t.numThreads} 线程</span>
              </div>
            ))}
            {f.threadGroups.length > enabled.length ? (
              <div className="muted" style={{ fontSize: 11 }}>
                另有 {f.threadGroups.length - enabled.length} 个未启用
              </div>
            ) : null}
          </div>
        );
      }
    },
    {
      title: '健康',
      dataIndex: 'health',
      width: '22%',
      render: (_: any, f: any) => {
        const issues = f.health.issues || [];
        if (!issues.length) return <Tag color="green">正常</Tag>;
        const worst = issues[0];
        return (
          <div className="jmx-health-cell">
            <Tag color={f.health.level === 'error' ? 'red' : f.health.level === 'warn' ? 'gold' : 'default'}>
              {LEVEL_TEXT[f.health.level] || f.health.level}
            </Tag>
            <span className="jmx-health-title" title={issues.map((i: any) => i.title).join('\n')}>
              {worst.title}
            </span>
          </div>
        );
      }
    },
    {
      title: '修改时间',
      dataIndex: 'mtime',
      width: '12%',
      render: (v: number) => <span className="muted">{fmtTime(v)}</span>
    },
    {
      title: '',
      key: 'op',
      width: '6%',
      render: (_: any, f: any) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="用 JMeter 打开编辑">
            <Button type="text" size="small" icon={<PlayCircleOutlined />} onClick={() => openGui(f)} />
          </Tooltip>
        </div>
      )
    }
  ];

  const jmeter = data && data.jmeter ? data.jmeter : null;

  /**
   * 详情抽屉的展示数据。
   *
   * info（jmx:detail）到了就用它 —— 断言/前后置已按采样器归位；
   * 还没到（或单文件解析失败）就退回 scan 的结构，至少能看线程组和健康检查。
   */
  const summary =
    info && info.summary
      ? info.summary
      : {
          threadGroups: detail && detail.threadGroups ? detail.threadGroups.length : 0,
          samplers: detail && detail.samplers ? detail.samplers.length : 0,
          assertions:
            detail && detail.responseAssertions
              ? detail.responseAssertions.length + detail.durationAssertions.length + detail.beanShell.assert.length
              : 0,
          configs: detail && detail.csvs ? detail.csvs.length : 0
        };
  const samplerList = info ? info.samplers || [] : detail && detail.samplers ? detail.samplers : [];
  const tgList = info && info.threadGroups ? info.threadGroups : detail && detail.threadGroups ? detail.threadGroups : [];
  const configList = info ? info.configs || [] : [];
  const varList: string[] = info ? info.variables || [] : detail && detail.placeholders ? detail.placeholders : [];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">压测脚本</div>
          <div className="page-desc">
            只读索引 jmx（{data && data.root ? data.root : '未配置目录'}），解析线程组 / 采样器 / CSV / 断言；默认只读，局部编辑要显式展开 + 确认才写回
          </div>
        </div>
        <div className="page-head-right">
          <Button
            type="primary"
            icon={<RocketOutlined />}
            onClick={launchJmeter}
            loading={launching}
            disabled={!!(jmeter && !jmeter.found)}
          >
            启动 JMeter
          </Button>
          <Button icon={<CodeOutlined />} onClick={() => setTplOpen(true)}>
            脚本模板
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={openDir}>
            打开目录
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            重新扫描
          </Button>
        </div>
      </div>

      {jmeter && !jmeter.found ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="没找到 JMeter"
          description="到「设置 → 压测」里指定 jmeter.bat 路径，之后就能在列表里一键打开脚本编辑。"
        />
      ) : null}

      <div className="page-with-aside">
        <aside className="tag-panel">
          <div className="tag-panel-head">
            <span>
              <FolderOutlined /> 目录
            </span>
            <span className="tag-panel-count">{dirs.length}</span>
          </div>
          <div className={'tag-item' + (dirFilter === '' ? ' active' : '')} onClick={() => setDirFilter('')}>
            <span className="tag-dot" />
            <span className="tag-name">全部</span>
            <span className="tag-count">{files.length}</span>
          </div>
          <div className="tag-divider" />
          {dirs.map(([name, count]) => (
            <div
              key={name}
              className={'tag-item' + (dirFilter === name ? ' active' : '')}
              title={name}
              onClick={() => setDirFilter(dirFilter === name ? '' : name)}
            >
              <span className="tag-dot" />
              <span className="tag-name">{name}</span>
              <span className="tag-count">{count}</span>
            </div>
          ))}
          {!dirs.length && !loading ? <div className="tag-empty">没有找到 jmx</div> : null}
        </aside>

        <div className="page-main">
          <div className="panel">
            <div className="panel-head panel-head-wrap">
              <Segmented
                size="small"
                value={levelFilter}
                onChange={(v) => setLevelFilter(String(v))}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '有问题', value: 'error' },
                  { label: '待完善', value: 'warn' },
                  { label: '正常', value: 'ok' }
                ]}
              />
              <Input
                allowClear
                style={{ width: 240 }}
                prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
                placeholder="搜文件名、线程组、接口路径、CSV"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <span className="spacer" />
              {searching ? <span className="panel-searching">筛选中…</span> : null}
              <span className="muted panel-count">
                {filtered.length} / {files.length} 个脚本
              </span>
            </div>
            {/*
              失败不清屏：还有上一次的扫描结果就只压一条错误条，说明「下面是上次的」；
              完全没有数据才走 failed 空状态（同 CodeScanPage）。
            */}
            {slot.error && data ? (
              <div className="panel-slot-error">
                <StateError
                  message={slot.error}
                  detail={slot.detail || undefined}
                  staleLabel={slot.at ? '下面还是上次扫描的结果' : ''}
                  onRetry={load}
                  retryLabel="重新扫描"
                />
              </div>
            ) : null}
            <Table
              dataSource={filtered}
              columns={columns}
              rowKey="relPath"
              size="middle"
              tableLayout="fixed"
              /* 有数据时盖遮罩（不清屏），没数据时用骨架行（不闪） */
              loading={loading && filtered.length > 0}
              pagination={{
                pageSize: PAGE_SIZE,
                // 受控分页：数据变少时只是夹紧显示页码，state 由上面的收敛效应收拾
                current: Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))),
                onChange: setPage,
                hideOnSinglePage: true,
                showSizeChanger: false,
                size: 'small'
              }}
              locale={{
                // 三态收口：加载 → 骨架行；读失败 → 带「重新扫描」；有筛选 → 无匹配；否则 → 没数据
                emptyText: loading ? (
                  <LoadingRows rows={6} bordered={false} label="正在扫描 jmx 目录" />
                ) : slot.error ? (
                  <StateEmpty
                    size="page"
                    kind="failed"
                    object="jmx 索引"
                    desc="目录没配、路径写错或没有读权限都可能读不到：到「设置 → 压测」改成你的 jmx 目录，或者先换个目录"
                    detail={slot.detail || slot.error}
                    action={{ label: '重新扫描', onClick: load }}
                    secondary={{ label: '打开目录', onClick: openDir }}
                  />
                ) : keyword || dirFilter || levelFilter !== 'all' ? (
                  <StateEmpty
                    size="page"
                    kind="no-match"
                    keyword={keyword.trim()}
                    desc="脚本还在，只是被关键词 / 目录 / 健康度筛掉了"
                    action={{ label: '清空筛选', onClick: clearFilters }}
                  />
                ) : (
                  <StateEmpty
                    size="page"
                    kind="no-data"
                    object="jmx 脚本"
                    desc="把 jmx 脚本放到这个目录下，点「重新扫描」就能解析线程组 / 采样器 / CSV / 断言（默认只读，不会自动改文件）"
                    action={{ label: '重新扫描', onClick: load }}
                    secondary={{ label: '打开目录', onClick: openDir }}
                  />
                )
              }}
              onRow={(f: any) => ({ onClick: () => openDetail(f), style: { cursor: 'pointer' } })}
            />
          </div>
        </div>
      </div>

      {/*
        详情抽屉：宽度保留 760 而不是 480 —— 里面除了概览还有线程组/采样器表格，
        480 会把「名称/类型/线程数/Ramp/持续/循环/状态」挤成两行，反而看不清。
      */}
      <Drawer
        open={!!detail}
        onClose={closeDetail}
        width={760}
        title={
          detail ? (
            <div className="jmx-drawer-title">
              <span>{detail.file}</span>
              <Tag>JMeter {detail.jmeterVersion || '?'}</Tag>
            </div>
          ) : (
            ''
          )
        }
        extra={
          detail ? (
            <div className="drawer-extra">
              {/* 互跳：带着线程数/rampUp/循环/域名去「脚本生成」页重新生成 */}
              <Button size="small" icon={<RedoOutlined />} onClick={() => regenerateFrom(detail)}>
                基于这个重新生成
              </Button>
              <Button size="small" icon={<CopyOutlined />} onClick={() => copySummary(detail)}>
                复制摘要
              </Button>
              <Button size="small" icon={<FileTextOutlined />} onClick={() => api.jmxOpenFile(detail.fullPath)}>
                打开文件
              </Button>
              <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => openGui(detail)}>
                用 JMeter 编辑
              </Button>
            </div>
          ) : null
        }
      >
        {detail ? (
          <div className="jmx-detail">
            {/* 头部信息：大小 · 修改时间（文件大小来自 jmx:detail，退回 scan 的 size） */}
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              {fmtSize((info && info.size) || detail.size)} · 修改于{' '}
              {fmtTime((info && info.modifiedAt) || detail.mtime)}
            </div>

            {detail.parseError ? (
              <Alert type="error" showIcon message="解析失败" description={detail.parseError} style={{ marginBottom: 14 }} />
            ) : null}
            {infoError ? (
              <Alert
                type="warning"
                showIcon
                message="详情读取失败"
                description={infoError + '（下面仍显示扫描时的结构）'}
                style={{ marginBottom: 14 }}
              />
            ) : null}
            {infoLoading ? (
              <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                正在解析文件…
              </div>
            ) : null}

            {/* 概览：一眼看清规模（数字都来自 jmx:detail 的 summary） */}
            <section className="jmx-section">
              <h4>概览</h4>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 20px', fontSize: 13 }}>
                <span>
                  <b style={{ fontSize: 16 }}>{summary.threadGroups}</b> 个线程组
                </span>
                <span>
                  <b style={{ fontSize: 16 }}>{summary.samplers}</b> 个采样器
                </span>
                <span>
                  <b style={{ fontSize: 16 }}>{summary.assertions}</b> 个断言
                </span>
                <span>
                  <b style={{ fontSize: 16 }}>{summary.configs}</b> 个配置
                </span>
              </div>
              {info && info.testPlan ? (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  测试计划：{info.testPlan.name || '（未命名）'}
                </div>
              ) : null}
            </section>

            {/*
              局部编辑（L2）：默认折叠 —— 详情页的主姿态仍是「只读」，
              展开后才出现输入框；保存前还要过一道 from → to 的确认框。
            */}
            <section className="jmx-section">
              <h4>局部编辑（会写回文件）</h4>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Button size="small" icon={<EditOutlined />} onClick={() => setEditOpen((v) => !v)}>
                  {editOpen ? '收起编辑' : '展开编辑'}
                </Button>
                {!editOpen ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    默认折叠：只读优先；展开后可改线程组数值和断言期望值，保存前会先确认
                  </span>
                ) : null}
                {editOpen && editChanges.length ? (
                  <span style={{ fontSize: 12, color: '#b7791f' }}>已改 {editChanges.length} 项（未保存）</span>
                ) : null}
                {editOpen ? (
                  <Button size="small" icon={<ReloadOutlined />} loading={infoLoading} onClick={reloadInfo} style={{ marginInlineStart: 'auto' }}>
                    重新加载详情
                  </Button>
                ) : null}
              </div>

              {editOpen ? (
                <div style={{ marginTop: 10 }}>
                  {!editSource ? (
                    <Alert
                      type="info"
                      showIcon
                      message="后端没有返回可编辑字段"
                      description="jmx:detail 需要带 editable（stamp / groups / assertions）才能局部编辑；先升级后端再试。"
                    />
                  ) : (
                    <>
                      <div className="muted" style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.7 }}>
                        线程数 1..1000000、爬坡秒 0..1000000、循环次数 -1（永久循环）或 1..1000000；
                        前置 / 后置线程组也能改。禁用框表示文件里没有这一项（界面不会替你新建），
                        填错会被后端逐条拒绝，不会写坏文件。
                      </div>

                      {!editGroups.length && !editAssertions.length ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          这个文件里没有能局部编辑的线程组 / 断言。
                        </div>
                      ) : null}

                      {editGroups.length ? (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ ...editGridHead, gridTemplateColumns: EDIT_GRID }}>
                            <span>线程组</span>
                            {EDIT_NUM_FIELDS.map((f) => (
                              <span key={f.key}>{f.label}</span>
                            ))}
                          </div>
                          {editGroups.map((g: any) => {
                            const isTouched = touchedRows.has('thread:' + g.index);
                            const badge = tgBadgeOf(g.type);
                            const groupName = g.name || '（未命名线程组）';
                            return (
                              <div
                                key={'g' + g.index}
                                style={{
                                  ...editGridRow,
                                  gridTemplateColumns: EDIT_GRID,
                                  background: isTouched ? 'rgba(245, 166, 35, 0.10)' : undefined
                                }}
                              >
                                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                  <span
                                    title={isTouched ? '这一行改过（还没保存）' : ''}
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: '50%',
                                      flex: '0 0 auto',
                                      background: isTouched ? '#f5a623' : 'transparent'
                                    }}
                                  />
                                  {/* 类型徽标：线程组 / 前置(setUp) / 后置(tearDown)，以前后两类根本不出现在这里 */}
                                  <Tag
                                    color={badge.color}
                                    style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 5, flex: '0 0 auto' }}
                                    title={'类型：' + badge.label + '（' + String(g.type || 'thread') + '）'}
                                  >
                                    {badge.label}
                                  </Tag>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(g.name || '')}>
                                    {groupName}
                                  </span>
                                </span>
                                {EDIT_NUM_FIELDS.map((f) => {
                                  const from = textOf(g[f.key]);
                                  return (
                                    <EditCell
                                      key={f.key}
                                      value={editValueOf('thread', g.index, f.key, from)}
                                      missing={from === ''}
                                      numeric
                                      placeholder={f.key === 'loops' ? '-1 = 永久循环' : undefined}
                                      title={f.key === 'loops' ? '循环次数：-1 = 永久循环（不按次数停），或 1..1000000' : undefined}
                                      ariaLabel={badge.label + ' ' + groupName + ' ' + f.label}
                                      onChange={(v) => setEditValue('thread', g.index, f.key, v)}
                                    />
                                  );
                                })}
                              </div>
                            );
                          })}
                          <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.6 }}>
                            循环次数填 -1 = 永久循环（JMeter 里不按次数停，靠调度器或手动停止）；爬坡秒可以填 0。
                          </div>
                        </div>
                      ) : null}

                      {editAssertions.length ? (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ ...editGridHead, gridTemplateColumns: EDIT_ASSERT_GRID }}>
                            <span>断言</span>
                            <span>匹配字段</span>
                            <span>期望值</span>
                          </div>
                          {editAssertions.map((a: any) => {
                            const isTouched = touchedRows.has('assertion:' + a.index);
                            const from = textOf(a.value);
                            return (
                              <div
                                key={'a' + a.index}
                                style={{
                                  ...editGridRow,
                                  gridTemplateColumns: EDIT_ASSERT_GRID,
                                  background: isTouched ? 'rgba(245, 166, 35, 0.10)' : undefined
                                }}
                              >
                                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                  <span
                                    title={isTouched ? '这一行改过（还没保存）' : ''}
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: '50%',
                                      flex: '0 0 auto',
                                      background: isTouched ? '#f5a623' : 'transparent'
                                    }}
                                  />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(a.name || '')}>
                                    {a.name || '（未命名断言）'}
                                  </span>
                                </span>
                                <span
                                  className="muted mono"
                                  style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  title={String(a.testField || '')}
                                >
                                  {a.testField || '—'}
                                </span>
                                <EditCell
                                  value={editValueOf('assertion', a.index, 'value', from)}
                                  missing={from === ''}
                                  numeric={false}
                                  ariaLabel={(a.name || '断言') + ' 期望值'}
                                  onChange={(v) => setEditValue('assertion', a.index, 'value', v)}
                                />
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flexWrap: 'wrap',
                          marginTop: 10,
                          paddingTop: 10,
                          borderTop: '1px solid var(--line)'
                        }}
                      >
                        <Button
                          type="primary"
                          size="small"
                          icon={<SaveOutlined />}
                          loading={saving}
                          disabled={!editChanges.length || saving}
                          onClick={confirmWriteback}
                        >
                          保存并写回
                        </Button>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {editChanges.length ? '将改 ' + editChanges.length + ' 项' : '还没有改动'}
                        </span>
                        {editChanges.length ? (
                          <Button size="small" onClick={() => setEditDraft({})}>
                            撤销改动
                          </Button>
                        ) : null}
                      </div>

                      {editFail ? (
                        <Alert
                          style={{ marginTop: 10 }}
                          type="error"
                          showIcon
                          message={EDIT_ERROR_TITLE[editFail.code] || '写回失败'}
                          description={
                            <div style={{ fontSize: 12.5 }}>
                              {String(editFail.message || '')
                                .split('\n')
                                .filter(Boolean)
                                .map((line, i) => (
                                  <div key={i} style={{ lineHeight: 1.8 }}>
                                    {line}
                                  </div>
                                ))}
                              {editFail.code === 'STALE' ? (
                                <div style={{ marginTop: 8 }}>
                                  <Button size="small" icon={<ReloadOutlined />} loading={infoLoading} onClick={reloadInfo}>
                                    重新加载
                                  </Button>
                                </div>
                              ) : null}
                              {editFail.code === 'WRITE_FAILED' ? (
                                <div style={{ marginTop: 6, color: '#8a90a2' }}>
                                  请检查文件是否只读、是否被其它程序占用，以及该目录有没有写权限。
                                </div>
                              ) : null}
                            </div>
                          }
                        />
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </section>

            {tgList.length ? (
              <section className="jmx-section">
                <h4>线程组（{tgList.length}）</h4>
                <table className="jmx-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>线程数</th>
                      <th>Ramp</th>
                      <th>持续</th>
                      <th>循环</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(tgList || []).map((t: any, i: number) => (
                      <tr key={i}>
                        <td>{t.name}</td>
                        <td className="muted">{TG_TYPE_LABEL[t.type] || t.type || '—'}</td>
                        <td>{showNum(t.numThreads)}</td>
                        <td>{showNum(t.rampUp, 's')}</td>
                        <td>{showNum(t.duration, 's')}</td>
                        <td>{showNum(t.loops)}</td>
                        <td>{t.enabled ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            {samplerList.length ? (
              <section className="jmx-section">
                <h4>采样器（{samplerList.length}）</h4>
                <div className="jmx-samplers">
                  {samplerList.map((s: any, i: number) => {
                    const attachCount =
                      (s.assertions ? s.assertions.length : 0) +
                      (s.preProcessors ? s.preProcessors.length : 0) +
                      (s.postProcessors ? s.postProcessors.length : 0) +
                      (s.timers ? s.timers.length : 0);
                    return (
                      <div className={'jmx-sampler' + (s.enabled ? '' : ' jmx-sampler-off')} key={i} style={{ display: 'block' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Tag color={s.method === 'GET' ? 'green' : s.method === 'POST' ? 'blue' : 'purple'}>
                            {s.method}
                          </Tag>
                          <span className="jmx-sampler-path mono">{s.path || '(继承默认值)'}</span>
                          <span className="jmx-sampler-name muted">{s.name}</span>
                          {attachCount ? (
                            <Tag style={{ fontSize: 11 }}>{attachCount} 个附加元件</Tag>
                          ) : (
                            <span className="muted" style={{ fontSize: 11 }}>
                              无附加元件
                            </span>
                          )}
                          {!s.enabled ? <Tag>禁用</Tag> : null}
                        </div>
                        {/* 断言 / 前后置 / 定时器：按采样器列出，类型原样展示 */}
                        <AttachLine label="断言" list={s.assertions || []} />
                        <AttachLine label="前置" list={s.preProcessors || []} />
                        <AttachLine label="后置" list={s.postProcessors || []} />
                        <AttachLine label="定时" list={s.timers || []} />
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {configList.length ? (
              <section className="jmx-section">
                <h4>配置元件（{configList.length}）</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {configList.map((c: any, i: number) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                      <Tag color={elementColor(c.type)} style={{ marginInlineEnd: 0, fontSize: 11 }} title={elementLabel(c.type)}>
                        {c.type}
                      </Tag>
                      <span>{c.name}</span>
                      {c.scope ? <span className="muted">挂在 {c.scope}</span> : <span className="muted">测试计划级</span>}
                      {c.enabled === false ? <Tag>禁用</Tag> : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {varList.length ? (
              <section className="jmx-section">
                <h4>变量（{varList.length}）</h4>
                <div className="jmx-placeholders">
                  {varList.map((p: string) => (
                    <Tag key={p} className="mono">
                      {'${' + p + '}'}
                    </Tag>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {'从脚本内容里抽出来的 ${...} 引用（${__P(...)} 这类函数不算变量，已排除）'}
                </div>
              </section>
            ) : null}

            {detail.defaults.length ? (
              <section className="jmx-section">
                <h4>HTTP 请求默认值</h4>
                {detail.defaults.map((d: any, i: number) => (
                  <div className="jmx-kv" key={i}>
                    <span className="muted">domain</span>
                    <span className="mono">{d.domain || '—'}</span>
                    <span className="muted">port</span>
                    <span className="mono">{d.port || '—'}</span>
                    <span className="muted">协议</span>
                    <span className="mono">{d.protocol || '—'}</span>
                  </div>
                ))}
              </section>
            ) : null}

            {detail.csvs.length ? (
              <section className="jmx-section">
                <h4>CSV 数据源（{detail.csvs.length}）</h4>
                {detail.csvs.map((c: any, i: number) => (
                  <div className="jmx-csv" key={i}>
                    <div className="jmx-csv-head">
                      <span className="mono">{c.filename || '(未设置)'}</span>
                      {!c.enabled ? <Tag>禁用</Tag> : null}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      变量 {c.variableNames || '—'} · 分隔符 {c.delimiter || '—'} · {c.shareMode || '—'}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {detail.variables.length ? (
              <section className="jmx-section">
                <h4>用户定义变量</h4>
                <table className="jmx-table">
                  <thead>
                    <tr>
                      <th>变量名</th>
                      <th>值</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.variables.flatMap((v: any) =>
                      v.vars.map((x: any, i: number) => (
                        <tr key={v.name + i}>
                          <td className="mono">{x.name}</td>
                          <td className="mono">{x.value || '—'}</td>
                          <td className="muted">{x.desc || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </section>
            ) : null}

            {detail.headers.length ? (
              <section className="jmx-section">
                <h4>HTTP 信息头</h4>
                {detail.headers.map((h: any, i: number) => (
                  <div className="jmx-kv" key={i}>
                    {h.headers.map((x: any, j: number) => (
                      <React.Fragment key={j}>
                        <span className="muted mono">{x.name}</span>
                        <span className="mono">{x.value}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ))}
              </section>
            ) : null}

            {detail.responseAssertions.length || detail.durationAssertions.length || detail.beanShell.assert.length ? (
              <section className="jmx-section">
                <h4>断言细节</h4>
                {detail.responseAssertions.map((a: any, i: number) => (
                  <div className="jmx-kv" key={'r' + i}>
                    <span className="muted">响应断言</span>
                    <span>
                      {a.field} · {a.matchRule} · {a.patterns.join(' / ')}
                    </span>
                  </div>
                ))}
                {detail.durationAssertions.map((a: any, i: number) => (
                  <div className="jmx-kv" key={'d' + i}>
                    <span className="muted">持续时间断言</span>
                    <span>{a.duration} ms</span>
                  </div>
                ))}
                {detail.beanShell.assert.map((a: any, i: number) => (
                  <div className="jmx-kv" key={'b' + i}>
                    <span className="muted">BeanShell 断言</span>
                    <span>{a.name}</span>
                  </div>
                ))}
              </section>
            ) : null}

            {detail.syncTimers.length ? (
              <section className="jmx-section">
                <h4>集合点（同步定时器）</h4>
                {detail.syncTimers.map((t: any, i: number) => (
                  <div className="jmx-kv" key={i}>
                    <span className="muted">集合人数</span>
                    <span>{t.groupSize || '—'}</span>
                    <span className="muted">超时</span>
                    <span>{t.timeout ? t.timeout + ' ms' : '—'}</span>
                  </div>
                ))}
              </section>
            ) : null}

            {detail.listeners.length ? (
              <section className="jmx-section">
                <h4>监听器（{detail.listeners.length}）</h4>
                <div className="jmx-listeners">
                  {detail.listeners.map((l: any, i: number) => (
                    <div className={'jmx-listener' + (l.enabled ? '' : ' jmx-listener-off')} key={i}>
                      <Tag color={LISTENER_COLOR[l.guiClass] || 'default'}>{listenerKindOf(l)}</Tag>
                      <span className="jmx-listener-scope">
                        {l.scope ? (
                          <>
                            挂在 <b>{l.scope}</b>
                          </>
                        ) : (
                          <span className="muted">测试计划级</span>
                        )}
                      </span>
                      {l.name !== listenerKindOf(l) ? <span className="muted jmx-listener-name">{l.name}</span> : null}
                      {!l.enabled ? <Tag>禁用</Tag> : null}
                    </div>
                  ))}
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  同名监听器靠「挂在谁下面」区分；JMeter 里也是按这个层级显示的
                </div>
              </section>
            ) : null}

            {/*
              健康检查放最后：直接复用 jmx:scan 算好的结果（detail.health），
              这里**不重新解析** —— 一个文件只算一次，避免详情页和列表结论不一致。
            */}
            {detail.health && detail.health.issues.length ? (
              <section className="jmx-section">
                <h4>健康检查</h4>
                <div className="jmx-issues">
                  {detail.health.issues.map((i: any, idx: number) => (
                    <div className={`jmx-issue jmx-issue-${i.level}`} key={idx}>
                      {LEVEL_ICON[i.level]}
                      <div>
                        <div className="jmx-issue-title">{i.title}</div>
                        {i.detail ? <div className="jmx-issue-detail">{i.detail}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <Alert type="success" showIcon message="健康检查没有发现问题" style={{ marginBottom: 14 }} />
            )}
          </div>
        ) : null}
      </Drawer>

      <ScriptTemplatesDrawer open={tplOpen} onClose={() => setTplOpen(false)} />
    </div>
  );
}
