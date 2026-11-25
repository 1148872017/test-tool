import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Select, Tag, Alert, Space, Tooltip, Segmented, Modal, Pagination } from 'antd';
import {
  FolderOpenOutlined,
  ReloadOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  ThunderboltOutlined,
  BugOutlined,
  AimOutlined,
  CopyOutlined,
  RightOutlined,
  DownOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import StateEmpty from '../components/states/StateEmpty';
import StepsList, { AllureStep, StepSummary } from '../components/StepsList';
import AllureArchive from '../components/AllureArchive';
import CodeBlock from '../components/CodeBlock';
import { useAllureHandoff } from '../features/allure/handoff';

type Test = {
  id: string;
  name: string;
  fullName: string;
  status: string;
  message: string;
  trace: string;
  suite: string;
  testClass: string;
  testMethod: string;
  feature: string;
  severity: string;
  duration: number;
  attachments: { name: string; source: string; type: string }[];
  /** 测试步骤（递归解析好的树，可能为空数组） */
  steps?: AllureStep[];
  /** 步骤统计（后端算好，含嵌套） */
  stepSummary?: StepSummary;
  /** 第一个失败/异常步骤的名字（没有就是空串） */
  firstFailedStep?: string;
  /** 步骤树是否被截断（单用例上限 200 个节点） */
  stepsTruncated?: boolean;
  stepsTruncatedReason?: string;
};

type Cluster = {
  key: string;
  pattern: string;
  count: number;
  tests: any[];
  sample: string;
};

type FlakyItem = {
  fullName: string;
  name: string;
  history: string[];
  flaky: boolean;
};

/** 状态 → 图标 + 颜色 */
const statusMeta = (s: string) => {
  if (s === 'passed') return { icon: <CheckCircleOutlined />, color: '#2e9e5b', label: '通过' };
  if (s === 'failed') return { icon: <CloseCircleOutlined />, color: '#e5534b', label: '失败' };
  if (s === 'broken') return { icon: <WarningOutlined />, color: '#f5a623', label: '异常' };
  if (s === 'skipped') return { icon: <MinusCircleOutlined />, color: '#8a90a2', label: '跳过' };
  return { icon: <MinusCircleOutlined />, color: '#8a90a2', label: s };
};

/** 毫秒 → 人类可读 */
const fmtMs = (n: number) => {
  if (!n) return '0ms';
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`;
};

/* ==================================================================== *
 * 在项目中定位（失败用例 → 源码文件）
 *
 * 能做到什么、不能做到什么（别把它做成假绿）：
 *   能：让主进程扫「代码项目目录」，把 Allure 的 testClass 映射到源文件，
 *       再在系统文件管理器里选中它（离线、不装任何东西）。
 *   不能：Electron 没有「选中第 N 行」的能力，平台也不装编辑器插件。
 *       所以行号从 Allure 的**失败堆栈**里取（真实信息，不猜），
 *       复制成「文件:行」交给用户粘到 IDE 里；界面上明写「只到文件」。
 * ==================================================================== */

/** 每页多少条：原来全量渲染，几千条用例一进来就卡 */
const PAGE_SIZE = 50;

/** 只有「没通过」的用例才需要定位源码 */
const isFailedLike = (s: string) => s === 'failed' || s === 'broken';

/** 路径太长只显示末尾两段（完整路径放 title） */
function shortFile(p: string): string {
  const s = String(p || '');
  if (!s) return '';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return s;
  return '…/' + parts.slice(-2).join('/');
}

/**
 * 从失败堆栈里取行号。
 *
 * 支持两种真实格式：
 *   Java  ：at com.demo.LoginApiTest.testEmpty(LoginApiTest.java:42)
 *   Python：File "D:/proj/tests/test_login.py", line 42, in test_ok
 *
 * 优先取「和这条用例同类/同文件」的那一帧；一帧都对不上就退回第一帧
 * （Java）/ 最后一帧（Python，traceback 的最内层才是真正失败处）。
 * 完全取不到返回 0 —— 界面照实说「只到文件」，不编一个行号。
 */
function lineFromTrace(trace: string, testClass: string, fileName: string): number {
  const text = String(trace || '');
  if (!text) return 0;
  const simple = String(testClass || '').split('.').filter(Boolean).pop() || '';
  const stem = String(fileName || '').replace(/\.[a-z]+$/i, '');

  // ---- Java ----
  const javaRe = /at\s+([\w.$]+)\s*\(([\w$]+\.java):(\d+)\)/g;
  let m: RegExpExecArray | null = null;
  let javaFirst = 0;
  while ((m = javaRe.exec(text)) !== null) {
    const line = Number(m[3]) || 0;
    if (!line) continue;
    if (!javaFirst) javaFirst = line;
    const cls = String(m[1] || '').split('.').pop() || '';
    if (simple && cls === simple) return line;
    if (stem && String(m[2] || '').replace(/\.java$/i, '') === stem) return line;
  }

  // ---- Python：取最后一个 .py 帧 ----
  const pyRe = /File\s+"([^"]+\.py)",\s+line\s+(\d+)/g;
  let pyLine = 0;
  while ((m = pyRe.exec(text)) !== null) {
    const line = Number(m[2]) || 0;
    if (line) pyLine = line;
  }
  if (pyLine) return pyLine;

  return javaFirst;
}

/** 定位结果里的一个候选文件 */
type LocateMatch = {
  className: string;
  fqcn: string;
  package: string;
  lang: string;
  file: string;
  /** 从堆栈里取到的行号，0 = 没有 */
  line?: number;
};

export default function ReportPage({ onNavigate }: { onNavigate?: (route: any) => void } = {}) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [dir, setDir] = useState('');
  /**
   * 扫描 / 解析各一个 busy 态。
   *
   * 原来共用一个 loading：交接进来时（测试执行点「关联报告」）doParse 立刻发起，
   * 同时 useEffect 里的 doScan 也在跑，两个请求并发、按钮 loading 互相盖掉，
   * 而且谁后回来谁生效 —— 旧结果能盖掉新结果。现在拆开 + 加请求序号（见下）。
   */
  const [scanning, setScanning] = useState(false);
  const [parsing, setParsing] = useState(false);
  /** 请求序号：响应回来时只认最新那一次，过期响应直接丢 */
  const scanSeq = useRef(0);
  const parseSeq = useRef(0);

  const [tests, setTests] = useState<Test[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);

  // Flaky
  const [flakyDirs, setFlakyDirs] = useState<string[]>([]);
  const [flaky, setFlaky] = useState<FlakyItem[]>([]);
  const [flakyBusy, setFlakyBusy] = useState(false);

  // 视图
  const [view, setView] = useState<'tests' | 'clusters' | 'flaky'>('clusters');
  const [statusFilter, setStatusFilter] = useState('');
  // 展开的用例详情（同一时间只展开一个，避免一屏全是细节）
  const [openId, setOpenId] = useState('');

  // 列表分页（50 条/页）
  const [page, setPage] = useState(1);

  // 在项目中定位：正在定位哪条用例、已经定位到的源码、多候选时的选择弹窗
  const [locating, setLocating] = useState('');
  const [located, setLocated] = useState<Record<string, { file: string; line: number }>>({});
  const [picker, setPicker] = useState<{ testId: string; testClass: string; matches: LocateMatch[] } | null>(null);

  /* ---------- 扫描 ---------- */
  const doScan = async () => {
    const seq = scanSeq.current + 1;
    scanSeq.current = seq;
    setScanning(true);
    try {
      const res = await api.allureScan();
      // 期间又点了一次扫描：这份结果作废，别去覆盖新的一次
      if (seq !== scanSeq.current) return;
      if (!res.ok) {
        toast(res.message || '扫描失败', 'warning');
        setDirs([]);
        return;
      }
      setDirs(res.dirs || []);
      if (res.dirs && res.dirs.length) setDir((cur: string) => cur || res.dirs[0]);
      toast(`找到 ${(res.dirs || []).length} 个 allure-results`);
    } catch (e: any) {
      if (seq !== scanSeq.current) return;
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (seq === scanSeq.current) setScanning(false);
    }
  };

  /* ---------- 从「测试执行」跳过来时，自动填目录并解析 ---------- */
  /**
   * 交接槽：测试执行页点「关联报告」时，把 reportDir 放进来。
   * 这里挂载时取一次（取完即清空），自动设目录 + 解析。
   */
  useAllureHandoff((d: string) => {
    setDir(d);
    setDirs((prev: string[]) => (prev.includes(d) ? prev : prev.concat([d])));
    doParse(d);
  });

  /* ---------- 解析 ---------- */
  const doParse = async (d?: string) => {
    const target = d || dir;
    if (!target) {
      toast('先选一个 allure-results 目录', 'warning');
      return;
    }
    const seq = parseSeq.current + 1;
    parseSeq.current = seq;
    setParsing(true);
    try {
      const res = await api.allureParse(target);
      /**
       * 连续点「解析」/ 快速切换目录时，先发的请求可能后回来。
       * 只认最后发出去那一次的结果，旧的直接丢 —— 否则界面会被旧报告盖掉，
       * 用户以为「解析出来的是这个目录」，实际看到的是上一个。
       */
      if (seq !== parseSeq.current) return;
      if (!res.ok) {
        toast(res.message || '解析失败', 'error');
        return;
      }
      setTests(res.tests || []);
      setSummary(res.summary);
      setClusters(res.clusters || []);
      // 换目录后旧的展开项已经不在了，顺手收掉
      setOpenId('');
      setView('clusters');
      setPage(1);
      setLocated({});
      toast(`解析完成：${res.summary ? res.summary.total : 0} 个用例`);
    } catch (e: any) {
      if (seq !== parseSeq.current) return;
      toast('解析失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (seq === parseSeq.current) setParsing(false);
    }
  };

  /* ---------- 在项目中定位（失败用例 → 源码文件） ---------- */
  /** 在文件管理器里选中文件 + 把「文件:行」复制到剪贴板 */
  const revealFound = async (testId: string, hit: LocateMatch) => {
    const line = Number(hit.line) || 0;
    let revealed = false;
    try {
      const res = await api.projectsReveal(hit.file);
      if (res && res.ok) revealed = true;
      else toast((res && res.message) || '打开文件位置失败', 'error');
    } catch (e: any) {
      toast('打开文件位置失败：' + (e && e.message ? e.message : e), 'error');
    }
    if (!revealed) return;
    try {
      await api.copy(line ? hit.file + ':' + line : hit.file, false);
    } catch (e) {
      /* 复制失败不影响「已经定位到文件」这件事，下面照样告诉用户 */
    }
    setLocated((prev) => Object.assign({}, prev, { [testId]: { file: hit.file, line } }));
    setPicker(null);
    toast(
      line
        ? '已在文件管理器选中源文件，并复制「文件:行」（平台只到文件，行号拿去 IDE 里跳）'
        : '已在文件管理器选中源文件（只到文件：堆栈里没有行号）'
    );
  };

  const copyLocated = async (testId: string) => {
    const hit = located[testId];
    if (!hit) return;
    try {
      await api.copy(hit.line ? hit.file + ':' + hit.line : hit.file, false);
      toast(hit.line ? '已复制「文件:行」' : '已复制文件路径（这条用例堆栈里没有行号）');
    } catch (e: any) {
      toast('复制失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /**
   * 点「在项目中定位」：主进程扫代码项目目录，把 testClass 映射到源文件。
   * 多个同名类（不同包）时弹窗让用户选，不替他猜。
   */
  const doLocate = async (t: Test) => {
    const cls = String(t.testClass || '').trim();
    if (!cls) {
      toast('这条用例没有 testClass 标签，定位不了源码', 'warning');
      return;
    }
    setLocating(t.id);
    try {
      const res = await api.projectsLocateTest({ testClass: cls });
      if (!res || !res.ok) {
        toast((res && res.message) || '定位失败', 'error');
        return;
      }
      const matches: LocateMatch[] = (res.matches || []).map((m: any) =>
        Object.assign({}, m, { line: lineFromTrace(t.trace, cls, m.className) })
      );
      if (!matches.length) {
        const scanned = (res.scanned || []).length;
        toast(
          '项目里没找到 ' + cls + '（扫了 ' + scanned + ' 个工程；只认 Maven 的 src/test/java 和 pytest 的 test_*.py）',
          'warning'
        );
        return;
      }
      if (matches.length > 1) {
        setPicker({ testId: t.id, testClass: cls, matches });
        return;
      }
      await revealFound(t.id, matches[0]);
    } catch (e: any) {
      toast('定位失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLocating('');
    }
  };

  /* ---------- 选目录 ---------- */
  const doPick = async () => {
    try {
      const res = await api.allurePickDir();
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '选择失败', 'error');
        return;
      }
      setDir(res.dir);
      setDirs((prev) => (prev.includes(res.dir) ? prev : prev.concat([res.dir])));
      await doParse(res.dir);
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /* ---------- Flaky 追踪 ---------- */
  const doFlaky = async () => {
    if (flakyDirs.length < 2) {
      toast('至少选 2 次执行记录才能比对', 'warning');
      return;
    }
    setFlakyBusy(true);
    try {
      const res = await api.allureFlaky(flakyDirs);
      if (!res.ok) {
        toast(res.message || '比对失败', 'error');
        return;
      }
      setFlaky(res.flaky || []);
      setView('flaky');
      toast(`比对 ${res.runs} 次执行，发现 ${(res.flaky || []).length} 个不稳定用例`);
    } catch (e: any) {
      toast('比对失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setFlakyBusy(false);
    }
  };

  /* ---------- 过滤后的用例 ---------- */
  const filteredTests = useMemo(() => {
    if (!statusFilter) return tests;
    return tests.filter((t) => t.status === statusFilter);
  }, [tests, statusFilter]);

  /* ---------- 分页（50 条/页） ---------- */
  const pageCount = Math.max(1, Math.ceil(filteredTests.length / PAGE_SIZE));
  const pagedTests = useMemo(() => {
    const start = (Math.max(1, page) - 1) * PAGE_SIZE;
    return filteredTests.slice(start, start + PAGE_SIZE);
  }, [filteredTests, page]);

  // 过滤条件变了 / 总数变少，页码越界就把它拉回最后一页（否则会白屏一页）
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  /* ---------- 首次自动扫描 ---------- */
  useEffect(() => {
    doScan();
  }, []);

  return (
    <div className="report-page">
      {/* 顶部：目录选择 */}
      <div className="report-bar">
        <Space size={8} wrap>
          <span className="muted">allure-results</span>
          <Select
            size="small"
            style={{ width: 380 }}
            value={dir}
            onChange={(v) => {
              setDir(v);
              doParse(v);
            }}
            placeholder={dirs.length ? '选一个目录' : '点「扫描」或「选目录」'}
            options={dirs.map((d) => ({ value: d, label: d }))}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={doScan} loading={scanning}>
            扫描
          </Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPick}>
            选目录
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => doParse()}
            loading={parsing}
            disabled={!dir}
          >
            解析
          </Button>
          {/* 归档到「测试执行」——对齐压测那个 ImportReportModal */}
          <AllureArchive dir={dir} summary={summary} onNavigate={onNavigate} />
        </Space>
      </div>

      {!tests.length ? (
        <div className="report-empty">
          <StateEmpty
            size="page"
            kind="no-data"
            object="解析结果"
            desc="点「扫描」找项目里的 allure-results，或「选目录」手动指定"
            action={{ label: '扫描项目', onClick: doScan }}
            secondary={{ label: '选目录', onClick: doPick }}
          />
        </div>
      ) : (
        <>
          {/* 汇总 */}
          <div className="report-summary">
            <div className="report-stat">
              <div className="report-stat-value">{summary.total}</div>
              <div className="report-stat-label">总数</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-value" style={{ color: '#2e9e5b' }}>
                {summary.passed}
              </div>
              <div className="report-stat-label">通过</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-value" style={{ color: '#e5534b' }}>
                {summary.failed}
              </div>
              <div className="report-stat-label">失败</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-value" style={{ color: '#f5a623' }}>
                {summary.broken}
              </div>
              <div className="report-stat-label">异常</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-value">{fmtMs(summary.duration)}</div>
              <div className="report-stat-label">总耗时</div>
            </div>
            <div className="report-stat">
              <div className="report-stat-value">
                {summary.total ? Math.round((summary.passed / summary.total) * 100) : 0}%
              </div>
              <div className="report-stat-label">通过率</div>
            </div>
          </div>

          {/* 视图切换 */}
          <div className="report-view-bar">
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as any)}
              options={[
                { label: `失败聚类 (${clusters.length})`, value: 'clusters' },
                { label: `用例 (${tests.length})`, value: 'tests' },
                { label: `Flaky (${flaky.length})`, value: 'flaky' }
              ]}
            />
            {view === 'tests' ? (
              <Select
                size="small"
                style={{ width: 120 }}
                value={statusFilter}
                onChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
                options={[
                  { value: '', label: '全部状态' },
                  { value: 'passed', label: '通过' },
                  { value: 'failed', label: '失败' },
                  { value: 'broken', label: '异常' },
                  { value: 'skipped', label: '跳过' }
                ]}
              />
            ) : null}
          </div>

          {/* 失败聚类 */}
          {view === 'clusters' ? (
            <div className="report-clusters">
              {!clusters.length ? (
                <Alert type="success" showIcon message="没有失败用例" />
              ) : (
                clusters.map((c, i) => (
                  <div className="cluster-card" key={i}>
                    <div className="cluster-head">
                      <Tag color="red">{c.count} 个用例</Tag>
                      <span className="cluster-pattern mono">{c.pattern}</span>
                    </div>
                    <div className="cluster-sample muted">{c.sample}</div>
                    <details className="cluster-details">
                      <summary>展开 {c.count} 个用例</summary>
                      <ul>
                        {c.tests.map((t: any) => (
                          <li key={t.id}>
                            <Tag color={t.status === 'broken' ? 'orange' : 'red'} style={{ marginRight: 6 }}>
                              {t.status === 'broken' ? '异常' : '失败'}
                            </Tag>
                            {t.name}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {/* 用例列表（50 条/页，分页见列表下方） */}
          {view === 'tests' ? (
            <div className="report-tests">
              {pagedTests.map((t) => {
                const m = statusMeta(t.status);
                const open = openId === t.id;
                return (
                  // 用 Fragment 而不是再包一层 div：.report-test-row 的
                  // border-bottom / :last-child 分隔线规则要维持原样
                  <React.Fragment key={t.id}>
                    {/* 整行可点：展开「用例详情」，失败用例点开就能看到挂在哪一步 */}
                    <div
                      className={'report-test-row' + (open ? ' is-open' : '')}
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      title={open ? '收起用例详情' : '展开用例详情（步骤 / 失败信息）'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setOpenId(open ? '' : t.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setOpenId(open ? '' : t.id);
                        }
                      }}
                    >
                      <span className="report-test-toggle" style={{ flex: '0 0 auto', fontSize: 10, color: '#9aa0b4' }}>
                        {open ? <DownOutlined /> : <RightOutlined />}
                      </span>
                      <span className="report-test-icon" style={{ color: m.color }}>
                        {m.icon}
                      </span>
                      <span className="report-test-name">{t.name}</span>
                      {/* 「挂在哪一步」列：扫一眼就知道问题位置，不用点进去 */}
                      {t.firstFailedStep ? (
                        <Tooltip title={'挂在这一步：' + t.firstFailedStep}>
                          <span
                            className="report-test-step"
                            style={{
                              flex: '0 1 auto',
                              minWidth: 0,
                              maxWidth: 200,
                              fontSize: 12,
                              color: '#c9372f',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            挂在：{t.firstFailedStep}
                          </span>
                        </Tooltip>
                      ) : null}
                      <span className="report-test-class muted mono">{t.testClass}</span>
                      <span className="report-test-dur muted">{fmtMs(t.duration)}</span>
                      {/*
                        失败 / 异常用例行内直接给「定位」：不用先展开就能跳源码。
                        行本身可点（展开详情），所以这里必须 stopPropagation。
                      */}
                      {isFailedLike(t.status) ? (
                        <Tooltip title="在项目中定位这条用例的源文件">
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label="在项目中定位源文件"
                            className="report-test-locate"
                            style={{
                              flex: '0 0 auto',
                              display: 'inline-flex',
                              alignItems: 'center',
                              fontSize: 12,
                              color: 'var(--primary-text)',
                              cursor: 'pointer'
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              void doLocate(t);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                void doLocate(t);
                              }
                            }}
                          >
                            {locating === t.id ? '定位中…' : <AimOutlined />}
                          </span>
                        </Tooltip>
                      ) : null}
                      {t.message ? (
                        <Tooltip title={t.message}>
                          <span className="report-test-msg muted">{t.message.split('\n')[0]}</span>
                        </Tooltip>
                      ) : null}
                    </div>

                    {/* 用例详情：步骤 → 失败信息 → trace */}
                    {open ? (
                      <div
                        className="report-test-detail"
                        style={{
                          padding: '4px 14px 12px 34px',
                          background: '#fbfbfd',
                          borderBottom: '1px solid #f4f5fa'
                        }}
                      >
                        <div className="report-detail-head" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className="report-detail-label" style={{ fontSize: 11.5, color: '#8a90a2' }}>
                            用例详情
                          </span>
                          <span className="report-detail-name" style={{ fontSize: 13, fontWeight: 600, color: '#3a4055' }}>
                            {t.name}
                          </span>
                          <Tag
                            color={
                              t.status === 'passed'
                                ? 'green'
                                : t.status === 'failed'
                                  ? 'red'
                                  : t.status === 'broken'
                                    ? 'orange'
                                    : 'default'
                            }
                          >
                            {m.label}
                          </Tag>
                          {/* 失败用例的「在项目中定位」：定位后按钮留在原地，方便再复制一次 */}
                          {isFailedLike(t.status) ? (
                            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                              <Button
                                size="small"
                                icon={<AimOutlined />}
                                loading={locating === t.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void doLocate(t);
                                }}
                              >
                                在项目中定位
                              </Button>
                              {located[t.id] ? (
                                <Button
                                  size="small"
                                  icon={<CopyOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void copyLocated(t.id);
                                  }}
                                >
                                  复制文件:行
                                </Button>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                        <div className="report-detail-meta muted" style={{ fontSize: 12, marginTop: 2 }}>
                          {[t.suite, t.feature, fmtMs(t.duration)].filter(Boolean).join(' · ')}
                        </div>

                        {/* 定位结果：路径 + 行号（行号来自失败堆栈，不猜） */}
                        {located[t.id] ? (
                          <div
                            className="report-detail-src muted"
                            style={{ fontSize: 12, marginTop: 4 }}
                            title={located[t.id].file}
                          >
                            源码：<span className="mono">{shortFile(located[t.id].file)}</span>
                            {located[t.id].line ? <span className="mono">:{located[t.id].line}</span> : null}
                            <span style={{ marginLeft: 6 }}>
                              {located[t.id].line
                                ? '（只到文件：已在文件管理器选中，「文件:行」已复制，粘到 IDE 里能跳）'
                                : '（只到文件：这条用例的堆栈里没有行号）'}
                            </span>
                          </div>
                        ) : null}

                        <StepsList
                          steps={t.steps}
                          summary={t.stepSummary}
                          firstFailedStep={t.firstFailedStep}
                          truncated={t.stepsTruncated}
                          truncatedReason={t.stepsTruncatedReason}
                        />

                        {t.message || t.trace ? (
                          <div className="report-detail-fail" style={{ marginTop: 6 }}>
                            <div className="report-detail-fail-title" style={{ fontSize: 12.5, fontWeight: 600, color: '#3a4055' }}>
                              失败信息
                            </div>
                            {t.message ? (
                              <div
                                className="report-detail-msg"
                                style={{
                                  fontSize: 12.5,
                                  color: '#c9372f',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-all',
                                  margin: '4px 0'
                                }}
                              >
                                {t.message}
                              </div>
                            ) : null}
                            {t.trace ? (
                              <details className="report-detail-trace">
                                <summary style={{ fontSize: 12, color: 'var(--primary)', cursor: 'pointer' }}>
                                  展开 trace
                                </summary>
                                {/*
                                  堆栈：统一代码块（行号 + 语法高亮）。语言自动识别 ——
                                  Java 堆栈会被认成 java，其它语言的堆栈退化成纯文本，不会染色出错。
                                */}
                                <div style={{ marginTop: 6 }}>
                                  <CodeBlock code={t.trace} copyable={false} maxHeight={220} />
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </React.Fragment>
                );
              })}
              {/*
                分页：原来全量渲染，几千条用例一次性进 DOM，点开/展开都卡。
                只在超过一页时出现，避免小报告多一条没用的控件。
              */}
              {filteredTests.length > PAGE_SIZE ? (
                <div
                  className="report-pager"
                  style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '8px 2px' }}
                >
                  <Pagination
                    size="small"
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={filteredTests.length}
                    showSizeChanger={false}
                    onChange={setPage}
                    showTotal={(total) => '共 ' + total + ' 条 / ' + PAGE_SIZE + ' 条每页'}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Flaky */}
          {view === 'flaky' ? (
            <div className="report-flaky">
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                message="Flaky 追踪需要多次执行记录"
                description={
                  <div>
                    <div style={{ marginBottom: 6 }}>
                      选 2 个以上 allure-results 目录（不同时间的执行），比对同一用例的通过/失败。
                    </div>
                    <Space size={6} wrap>
                      <Select
                        size="small"
                        mode="multiple"
                        style={{ minWidth: 400 }}
                        value={flakyDirs}
                        onChange={setFlakyDirs}
                        placeholder="选多个 allure-results 目录"
                        options={dirs.map((d) => ({ value: d, label: d }))}
                      />
                      <Button
                        size="small"
                        type="primary"
                        icon={<BugOutlined />}
                        onClick={doFlaky}
                        loading={flakyBusy}
                        disabled={flakyDirs.length < 2}
                      >
                        比对
                      </Button>
                    </Space>
                  </div>
                }
              />

              {flaky.length ? (
                flaky.map((f, i) => (
                  <div className="flaky-row" key={i}>
                    <div className="flaky-name">{f.name}</div>
                    <div className="flaky-history">
                      {f.history.map((s, j) => {
                        const m = statusMeta(s);
                        return (
                          <Tooltip key={j} title={m.label}>
                            <span className="flaky-dot" style={{ background: m.color }} />
                          </Tooltip>
                        );
                      })}
                    </div>
                    <Tag color="orange">不稳定</Tag>
                  </div>
                ))
              ) : (
                <div className="muted" style={{ padding: 12 }}>
                  还没有比对结果。选 2 个以上目录后点「比对」。
                </div>
              )}
            </div>
          ) : null}
        </>
      )}

      {/*
        多个同名测试类（不同包）时让用户自己选。
        不替他挑「第一个」：挑错了定位到另一个包的同名类，比不定位更浪费排查时间。
      */}
      <Modal
        open={!!picker}
        title="选一个源文件"
        onCancel={() => setPicker(null)}
        footer={
          <Button onClick={() => setPicker(null)}>取消</Button>
        }
        width={640}
      >
        {picker ? (
          <div>
            <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
              「{picker.testClass}」在项目里对上 {picker.matches.length} 个文件，选一个定位（只在文件管理器里选中，不会改文件）：
            </div>
            {picker.matches.map((mm, i) => (
              <div
                key={i}
                style={{
                  border: '1px solid #eceef5',
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 8,
                  cursor: 'pointer'
                }}
                role="button"
                tabIndex={0}
                onClick={() => {
                  void revealFound(picker.testId, mm);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void revealFound(picker.testId, mm);
                  }
                }}
              >
                <div className="mono" style={{ fontSize: 12.5, color: '#3a4055' }}>
                  {mm.fqcn || mm.className}
                  {mm.line ? <span className="muted"> : {mm.line}</span> : null}
                </div>
                <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2, wordBreak: 'break-all' }}>
                  {mm.file}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
