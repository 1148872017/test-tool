import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Tag, Alert, Space, Empty, Segmented, Progress, Tooltip } from 'antd';
import {
  FolderOpenOutlined,
  ReloadOutlined,
  SafetyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  FileSearchOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

type CoverageItem = {
  id: string;
  name: string;
  method: string;
  url: string;
  module: string;
  hits: number;
  files: string[];
};

type Issue = {
  rule: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  hint: string;
  file: string;
  line: number;
  snippet: string;
};

/** 严重程度 → 颜色 + 文案 */
const sevMeta = (s: string) => {
  if (s === 'high') return { color: 'red', label: '高' };
  if (s === 'medium') return { color: 'orange', label: '中' };
  return { color: 'default', label: '低' };
};

export default function CodeScanPage() {
  const [root, setRoot] = useState('');
  const [view, setView] = useState<'coverage' | 'hardcoded'>('coverage');
  const [busy, setBusy] = useState(false);

  // 覆盖矩阵
  const [cov, setCov] = useState<any>(null);

  // 硬编码
  const [scan, setScan] = useState<any>(null);
  const [sevFilter, setSevFilter] = useState('');

  /* ---------- 覆盖矩阵 ---------- */
  const doCoverage = async () => {
    setBusy(true);
    try {
      const res = await api.codescanCoverage(root || undefined);
      if (!res.ok) {
        toast(res.message || '扫描失败', 'error');
        return;
      }
      setCov(res);
      setView('coverage');
      toast(`扫描 ${res.scannedFiles} 个文件，覆盖 ${res.covered}/${res.total}`);
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 硬编码 ---------- */
  const doHardcoded = async () => {
    setBusy(true);
    try {
      const res = await api.codescanHardcoded(root || undefined);
      if (!res.ok) {
        toast(res.message || '扫描失败', 'error');
        return;
      }
      setScan(res);
      setView('hardcoded');
      toast(`扫描 ${res.scannedFiles} 个文件，发现 ${res.summary.total} 个问题`);
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 选目录 ---------- */
  const doPick = async () => {
    try {
      const res = await api.codescanPickDir();
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '选择失败', 'error');
        return;
      }
      setRoot(res.dir);
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /* ---------- 过滤问题 ---------- */
  const filteredIssues = useMemo(() => {
    if (!scan) return [];
    if (!sevFilter) return scan.issues;
    return scan.issues.filter((it: Issue) => it.severity === sevFilter);
  }, [scan, sevFilter]);

  const covPct = cov && cov.total ? Math.round((cov.covered / cov.total) * 100) : 0;

  return (
    <div className="codescan-page">
      {/* 顶部 */}
      <div className="codescan-bar">
        <Space size={8} wrap>
          <span className="muted">代码目录</span>
          <Input
            size="small"
            style={{ width: 380 }}
            value={root}
            placeholder="留空 = 用「设置 → 开发环境」里的项目目录"
            onChange={(e) => setRoot(e.target.value)}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPick}>
            选目录
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<FileSearchOutlined />}
            onClick={doCoverage}
            loading={busy}
          >
            覆盖矩阵
          </Button>
          <Button size="small" icon={<SafetyOutlined />} onClick={doHardcoded} loading={busy}>
            硬编码检查
          </Button>
        </Space>
      </div>

      {/* 视图切换 */}
      {cov || scan ? (
        <div className="codescan-view-bar">
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as any)}
            options={[
              { label: `覆盖矩阵${cov ? ` (${cov.covered}/${cov.total})` : ''}`, value: 'coverage' },
              { label: `硬编码${scan ? ` (${scan.summary.total})` : ''}`, value: 'hardcoded' }
            ]}
          />
        </div>
      ) : null}

      {/* 覆盖矩阵 */}
      {view === 'coverage' ? (
        !cov ? (
          <div className="codescan-empty">
            <Empty description="点「覆盖矩阵」扫描接口覆盖情况" />
          </div>
        ) : (
          <>
            <div className="cov-summary">
              <div className="cov-stat">
                <div className="cov-stat-value">{cov.total}</div>
                <div className="cov-stat-label">接口总数</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat-value" style={{ color: '#2e9e5b' }}>
                  {cov.covered}
                </div>
                <div className="cov-stat-label">已覆盖</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat-value" style={{ color: '#e5534b' }}>
                  {cov.uncovered.length}
                </div>
                <div className="cov-stat-label">未覆盖</div>
              </div>
              <div className="cov-stat" style={{ flex: 2 }}>
                <Progress
                  percent={covPct}
                  size="small"
                  strokeColor={covPct >= 80 ? '#2e9e5b' : covPct >= 50 ? '#f5a623' : '#e5534b'}
                />
                <div className="cov-stat-label">覆盖率（扫描 {cov.scannedFiles} 个文件）</div>
              </div>
            </div>

            {cov.uncovered.length ? (
              <>
                <div className="cov-section-title">
                  <CloseCircleOutlined style={{ color: '#e5534b' }} /> 未覆盖（{cov.uncovered.length}）
                </div>
                <div className="cov-list">
                  {cov.uncovered.map((u: CoverageItem) => (
                    <div className="cov-row cov-row-miss" key={u.id}>
                      <Tag color="blue">{u.method}</Tag>
                      <span className="mono cov-url">{u.url}</span>
                      <span className="cov-name muted">{u.name}</span>
                      {u.module ? <Tag>{u.module}</Tag> : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {cov.coveredList.length ? (
              <>
                <div className="cov-section-title" style={{ marginTop: 12 }}>
                  <CheckCircleOutlined style={{ color: '#2e9e5b' }} /> 已覆盖（{cov.coveredList.length}）
                </div>
                <div className="cov-list">
                  {cov.coveredList.map((c: CoverageItem) => (
                    <div className="cov-row" key={c.id}>
                      <Tag color="blue">{c.method}</Tag>
                      <span className="mono cov-url">{c.url}</span>
                      <span className="cov-name muted">{c.name}</span>
                      <Tag color="green">{c.hits} 处</Tag>
                      {c.files.length ? (
                        <Tooltip title={c.files.join('\n')}>
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {c.files[0].split(/[\\/]/).pop()}
                            {c.files.length > 1 ? ` +${c.files.length - 1}` : ''}
                          </span>
                        </Tooltip>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )
      ) : null}

      {/* 硬编码 */}
      {view === 'hardcoded' ? (
        !scan ? (
          <div className="codescan-empty">
            <Empty description="点「硬编码检查」扫描代码问题" />
          </div>
        ) : (
          <>
            <div className="cov-summary">
              <div className="cov-stat">
                <div className="cov-stat-value" style={{ color: '#e5534b' }}>
                  {scan.summary.high}
                </div>
                <div className="cov-stat-label">高危</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat-value" style={{ color: '#f5a623' }}>
                  {scan.summary.medium}
                </div>
                <div className="cov-stat-label">中危</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat-value">{scan.summary.low}</div>
                <div className="cov-stat-label">低危</div>
              </div>
              <div className="cov-stat" style={{ flex: 2 }}>
                <div className="cov-stat-value">{scan.summary.total}</div>
                <div className="cov-stat-label">问题总数（扫描 {scan.scannedFiles} 个文件）</div>
              </div>
            </div>

            <div className="codescan-filter">
              <Segmented
                size="small"
                value={sevFilter}
                onChange={(v) => setSevFilter(v as string)}
                options={[
                  { label: `全部 (${scan.summary.total})`, value: '' },
                  { label: `高危 (${scan.summary.high})`, value: 'high' },
                  { label: `中危 (${scan.summary.medium})`, value: 'medium' },
                  { label: `低危 (${scan.summary.low})`, value: 'low' }
                ]}
              />
            </div>

            {!filteredIssues.length ? (
              <Alert type="success" showIcon message="没有发现问题" />
            ) : (
              <div className="issue-list">
                {filteredIssues.map((it: Issue, i: number) => {
                  const m = sevMeta(it.severity);
                  return (
                    <div className="issue-row" key={i}>
                      <Tag color={m.color}>{m.label}</Tag>
                      <span className="issue-label">{it.label}</span>
                      <span className="issue-file mono muted">
                        {it.file.split(/[\\/]/).slice(-2).join('/')}:{it.line}
                      </span>
                      <div className="issue-snippet mono">{it.snippet}</div>
                      <div className="issue-hint muted">{it.hint}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )
      ) : null}
    </div>
  );
}
