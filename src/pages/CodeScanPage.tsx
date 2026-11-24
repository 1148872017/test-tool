import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Tag, Alert, Space, Empty, Segmented, Progress, Tooltip } from 'antd';
import {
  FolderOpenOutlined,
  ReloadOutlined,
  SafetyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  FileSearchOutlined,
  AppstoreOutlined,
  ApartmentOutlined
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
  const [view, setView] = useState<'coverage' | 'hardcoded' | 'deps'>('coverage');
  /** 依赖检查结果 */
  const [deps, setDeps] = useState<any>(null);
  /** 覆盖矩阵的对象：接口 / 页面 */
  const [covKind, setCovKind] = useState<'api' | 'page'>('api');
  const [busy, setBusy] = useState(false);

  // 覆盖矩阵
  const [cov, setCov] = useState<any>(null);

  // 硬编码
  const [scan, setScan] = useState<any>(null);
  const [sevFilter, setSevFilter] = useState('');

  /* ---------- 覆盖矩阵 ---------- */
  const doCoverage = async (kind?: 'api' | 'page') => {
    const k = kind || covKind;
    setCovKind(k);

    /**
     * **先切视图，再发请求**。
     *
     * 原来的顺序是「请求成功才切视图」，结果：
     *   点接口覆盖（成功）→ 点硬编码（成功）→ 再点接口覆盖（**失败**）
     *   → 视图停在硬编码上，用户看到的是硬编码结果，以为"结果乱串"。
     *
     * 正确语义：点哪个按钮就看哪个视图，成功就填数据、失败就显示错误。
     */
    setView('coverage');
    setBusy(true);
    try {
      const res = await api.codescanCoverage(root || undefined, k);
      if (!res.ok) {
        toast(res.message || '扫描失败', 'error');
        setCov(null); // 清掉旧结果，别让人误以为这是本次的
        return;
      }
      setCov(res);
      const label = k === 'page' ? '页面' : '接口';
      toast(`${label}覆盖：${res.covered}/${res.total}（扫描 ${res.scannedFiles} 个文件）`);
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
      setCov(null);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 硬编码 ---------- */
  const doHardcoded = async () => {
    setView('hardcoded'); // 先切视图（理由见 doCoverage）
    setBusy(true);
    try {
      const res = await api.codescanHardcoded(root || undefined);
      if (!res.ok) {
        toast(res.message || '扫描失败', 'error');
        setScan(null);
        return;
      }
      setScan(res);
      toast(`扫描 ${res.scannedFiles} 个文件，发现 ${res.summary.total} 个问题`);
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
      setScan(null);
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 依赖检查 ---------- */
  const doDeps = async () => {
    setView('deps'); // 先切视图（理由见 doCoverage）
    setBusy(true);
    try {
      const res = await api.codescanDeps(root || undefined);
      if (!res.ok) {
        toast(res.message || '检查失败', 'error');
        setDeps(null);
        return;
      }
      setDeps(res);
      if (res.message) toast(res.message, 'info');
      else toast(`检查 ${res.poms} 个 pom + ${res.reqs} 个 requirements，发现 ${res.summary.total} 个问题`);
    } catch (e: any) {
      toast('检查失败：' + (e && e.message ? e.message : e), 'error');
      setDeps(null);
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
          {/* 四个检查项各做什么，光看按钮名不够清楚（用户要求加提示） */}
          <Tooltip
            title={
              <div style={{ lineHeight: 1.7 }}>
                <div>扫代码里的<b>接口请求路径</b>，和「接口记录」对比</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  · 左边清单 = 接口记录里同步的接口
                  <br />· 右边实现 = 代码里的 .get/post("...") / requests.xxx()
                  <br />· 标红 = 文档有但代码没测到的「漏网之鱼」
                </div>
              </div>
            }
          >
            <Button
              size="small"
              type={covKind === 'api' ? 'primary' : 'default'}
              icon={<FileSearchOutlined />}
              onClick={() => doCoverage('api')}
              loading={busy}
            >
              接口覆盖
            </Button>
          </Tooltip>

          <Tooltip
            title={
              <div style={{ lineHeight: 1.7 }}>
                <div>扫代码里的<b>页面跳转</b>，和「页面元素」对比</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  · 左边清单 = 页面元素里维护的页面
                  <br />· 右边实现 = 代码里的 page.goto/navigate("...")
                  <br />· 标红 = 清单里有但没写自动化脚本的页面
                </div>
              </div>
            }
          >
            <Button
              size="small"
              type={covKind === 'page' ? 'primary' : 'default'}
              icon={<AppstoreOutlined />}
              onClick={() => doCoverage('page')}
              loading={busy}
            >
              页面覆盖
            </Button>
          </Tooltip>

          <Tooltip
            title={
              <div style={{ lineHeight: 1.7 }}>
                <div>扫<b>代码里的坏味道</b>，按严重程度分级</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  · 高危：硬编码密码 / Token
                  <br />· 中危：硬编码 URL / Thread.sleep / 断言过弱（只校验状态码）
                  <br />· 低危：绝对 XPath / 深层 CSS 选择器
                </div>
              </div>
            }
          >
            <Button size="small" icon={<SafetyOutlined />} onClick={doHardcoded} loading={busy}>
              硬编码检查
            </Button>
          </Tooltip>

          <Tooltip
            title={
              <div style={{ lineHeight: 1.7 }}>
                <div>扫 <b>pom.xml / requirements.txt</b> 的依赖冲突</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  · 同一声明出现多次
                  <br />· 同一依赖写了不同版本
                  <br />· version 里的占位符没定义
                  <br />· 不做传递依赖分析（用 mvn dependency:tree 更准）
                </div>
              </div>
            }
          >
            <Button size="small" icon={<ApartmentOutlined />} onClick={doDeps} loading={busy}>
              依赖检查
            </Button>
          </Tooltip>
        </Space>
      </div>

      {/* 视图切换 */}
      {cov || scan || deps ? (
        <div className="codescan-view-bar">
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as any)}
            options={[
              {
                label: `${covKind === 'page' ? '页面' : '接口'}覆盖${cov && cov.kind === covKind ? ` (${cov.covered}/${cov.total})` : ''}`,
                value: 'coverage'
              },
              { label: `硬编码${scan ? ` (${scan.summary.total})` : ''}`, value: 'hardcoded' },
              { label: `依赖${deps ? ` (${deps.summary.total})` : ''}`, value: 'deps' }
            ]}
          />
        </div>
      ) : null}

      {/* 覆盖矩阵 */}
      {view === 'coverage' ? (
        !cov ? (
          <div className="codescan-empty">
            <Empty description="点「接口覆盖」或「页面覆盖」开始扫描" />
          </div>
        ) : (
          <>
            <div className="cov-summary">
              <div className="cov-stat">
                <div className="cov-stat-value">{cov.total}</div>
                <div className="cov-stat-label">{covKind === 'page' ? '页面总数' : '接口总数'}</div>
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
                      {u.method ? <Tag color="blue">{u.method}</Tag> : null}
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
                      {c.method ? <Tag color="blue">{c.method}</Tag> : null}
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

      {/* 依赖检查 */}
      {view === 'deps' ? (
        !deps ? (
          <div className="codescan-empty">
            <Empty description="点「依赖检查」扫描 pom.xml / requirements.txt" />
          </div>
        ) : (
          <>
            <div className="cov-summary">
              <div className="cov-stat">
                <div className="cov-stat-value" style={{ color: '#e5534b' }}>
                  {deps.summary.high || 0}
                </div>
                <div className="cov-stat-label">高危</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat-value" style={{ color: '#f5a623' }}>
                  {deps.summary.medium || 0}
                </div>
                <div className="cov-stat-label">中危</div>
              </div>
              <div className="cov-stat">
                <div className="cov-stat-value">{deps.summary.total}</div>
                <div className="cov-stat-label">问题总数</div>
              </div>
              <div className="cov-stat" style={{ flex: 2 }}>
                <div className="cov-stat-value">{deps.poms + deps.reqs}</div>
                <div className="cov-stat-label">
                  扫描文件（{deps.poms} 个 pom.xml + {deps.reqs} 个 requirements）
                </div>
              </div>
            </div>

            {deps.message ? <Alert type="info" showIcon message={deps.message} /> : null}

            {!deps.issues.length ? (
              <Alert type="success" showIcon message="没有发现问题" />
            ) : (
              <div className="issue-list">
                {deps.issues.map((it: any, i: number) => {
                  const m = sevMeta(it.severity);
                  return (
                    <div className="issue-row" key={i}>
                      <Tag color={m.color}>{m.label}</Tag>
                      <span className="issue-label">{it.title}</span>
                      <span className="issue-file mono muted">{it.file}</span>
                      <div className="issue-snippet mono">{it.detail}</div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="muted" style={{ fontSize: 11.5 }}>
              只查「同一声明重复 / 版本不一致 / 占位符没定义」，不做传递依赖分析（用 mvn dependency:tree 更准）。
            </div>
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
