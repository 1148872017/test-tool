import React, { useEffect, useMemo, useState } from 'react';
import { Table, Input, Button, Tag, Drawer, Segmented, Tooltip, Alert } from 'antd';
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
  RedoOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import ScriptTemplatesDrawer from '../components/ScriptTemplatesDrawer';
import { buildHandoff, setJmxHandoff } from '../features/jmx/handoff';

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
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');
  const [dirFilter, setDirFilter] = useState('');
  /** 当前打开的行（来自 scan，健康检查结果直接复用，不重复算） */
  const [detail, setDetail] = useState<any>(null);
  /** jmx:detail 的解析结果（按需解析：点开一行才读一次文件） */
  const [info, setInfo] = useState<any>(null);
  const [infoError, setInfoError] = useState('');
  const [infoLoading, setInfoLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.jmxScan();
      setData(res);
      if (res && res.error) toast(res.error, 'warning');
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const files = data && data.files ? data.files : [];

  const dirs = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) {
      const key = f.dir || '（根目录）';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [files]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return files.filter((f) => {
      if (dirFilter && (f.dir || '（根目录）') !== dirFilter) return false;
      if (levelFilter !== 'all' && f.health.level !== levelFilter) return false;
      if (!kw) return true;
      const hay = [
        f.file,
        f.testPlanName,
        f.jmeterVersion,
        f.threadGroups.map((t) => t.name).join(' '),
        f.samplers.map((s) => s.name + ' ' + s.path).join(' '),
        f.csvs.map((c) => c.filename).join(' '),
        f.placeholders.join(' ')
      ]
        .join(' ')
        .toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }, [files, keyword, levelFilter, dirFilter]);

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
    setInfoLoading(true);
    try {
      const res = await api.jmxDetail(f.fullPath);
      if (res && res.ok) setInfo(res);
      else setInfoError((res && (res.message || res.code)) || '解析详情失败');
    } catch (e: any) {
      setInfoError('读取详情失败：' + (e && e.message ? e.message : e));
    } finally {
      setInfoLoading(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setInfo(null);
    setInfoError('');
    setInfoLoading(false);
  };

  /**
   * 「基于这个重新生成」：把源脚本的线程数 / Ramp-Up / 循环 / 域名带到「脚本生成」页。
   *
   * 只带这 4 个（值最确定、收益最高）：接口要重新选，断言/CSV 由生成页自己组，
   * 全量预填反而会把用户在源脚本里的手工改动当成「标准答案」。
   * 交接用模块级变量（features/jmx/handoff.ts），不动 App.tsx 的路由结构。
   */
  const regenerateFrom = (f: any) => {
    const domain = (f && f.defaults && f.defaults[0] && f.defaults[0].domain) || '';
    const src = info && info.threadGroups ? info : f || {};
    setJmxHandoff(buildHandoff((f && f.file) || src.file || '', src, { domain }));
    if (onNavigate) {
      toast('已带过线程数 / Ramp-Up / 循环 / 域名，到「脚本生成」页接着改');
      onNavigate({ type: 'tool', key: 'scriptgen' });
    } else {
      toast('已带过线程数 / Ramp-Up / 循环 / 域名（当前环境没有路由，无法跳转）', 'warning');
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
            只读索引 jmx（{data && data.root ? data.root : '未配置目录'}），解析线程组 / 采样器 / CSV / 断言，不修改文件
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
            <div className="panel-head">
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
              <span className="muted" style={{ fontSize: 12 }}>
                {filtered.length} / {files.length} 个脚本
              </span>
            </div>
            <Table
              dataSource={filtered}
              columns={columns}
              rowKey="relPath"
              size="middle"
              tableLayout="fixed"
              loading={loading}
              pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
              locale={{
                emptyText: (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <FileTextOutlined />
                    </div>
                    <div className="empty-title">
                      {data && data.error ? data.error : keyword || dirFilter ? '没有匹配的脚本' : '目录里还没有 jmx'}
                    </div>
                    <div className="empty-desc">
                      {data && data.error
                        ? '到「设置 → 压测」里改成你的 jmx 目录，再点重新扫描'
                        : keyword || dirFilter
                        ? '换个关键词，或点左侧「全部」清空筛选'
                        : '把 jmx 脚本放到这个目录下，点右上角「重新扫描」'}
                    </div>
                  </div>
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
