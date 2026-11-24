import React, { useEffect, useMemo, useState } from 'react';
import { Button, Select, Tag, Alert, Space, Empty, Tooltip, Segmented } from 'antd';
import {
  FolderOpenOutlined,
  ReloadOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  ThunderboltOutlined,
  BugOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

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

export default function ReportPage() {
  const [dirs, setDirs] = useState<string[]>([]);
  const [dir, setDir] = useState('');
  const [loading, setLoading] = useState(false);

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

  /* ---------- 扫描 ---------- */
  const doScan = async () => {
    setLoading(true);
    try {
      const res = await api.allureScan();
      if (!res.ok) {
        toast(res.message || '扫描失败', 'warning');
        setDirs([]);
        return;
      }
      setDirs(res.dirs || []);
      if (res.dirs && res.dirs.length && !dir) setDir(res.dirs[0]);
      toast(`找到 ${(res.dirs || []).length} 个 allure-results`);
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  /* ---------- 解析 ---------- */
  const doParse = async (d?: string) => {
    const target = d || dir;
    if (!target) {
      toast('先选一个 allure-results 目录', 'warning');
      return;
    }
    setLoading(true);
    try {
      const res = await api.allureParse(target);
      if (!res.ok) {
        toast(res.message || '解析失败', 'error');
        return;
      }
      setTests(res.tests || []);
      setSummary(res.summary);
      setClusters(res.clusters || []);
      setView('clusters');
      toast(`解析完成：${res.summary.total} 个用例`);
    } catch (e: any) {
      toast('解析失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
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
          <Button size="small" icon={<ReloadOutlined />} onClick={doScan} loading={loading}>
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
            loading={loading}
            disabled={!dir}
          >
            解析
          </Button>
        </Space>
      </div>

      {!tests.length ? (
        <div className="report-empty">
          <Empty
            description={
              <span>
                还没有解析结果
                <br />
                <span className="muted" style={{ fontSize: 12 }}>
                  点「扫描」找项目里的 allure-results，或「选目录」手动指定
                </span>
              </span>
            }
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
                onChange={setStatusFilter}
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

          {/* 用例列表 */}
          {view === 'tests' ? (
            <div className="report-tests">
              {filteredTests.map((t) => {
                const m = statusMeta(t.status);
                return (
                  <div className="report-test-row" key={t.id}>
                    <span className="report-test-icon" style={{ color: m.color }}>
                      {m.icon}
                    </span>
                    <span className="report-test-name">{t.name}</span>
                    <span className="report-test-class muted mono">{t.testClass}</span>
                    <span className="report-test-dur muted">{fmtMs(t.duration)}</span>
                    {t.message ? (
                      <Tooltip title={t.message}>
                        <span className="report-test-msg muted">{t.message.split('\n')[0]}</span>
                      </Tooltip>
                    ) : null}
                  </div>
                );
              })}
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
    </div>
  );
}
