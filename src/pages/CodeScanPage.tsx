import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Tag, Alert, Space, Empty, Segmented, Progress, Tooltip, Select, Checkbox } from 'antd';
import {
  FolderOpenOutlined,
  ReloadOutlined,
  SafetyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  FileSearchOutlined,
  AppstoreOutlined,
  ApartmentOutlined,
  FilterOutlined
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
  ruleId?: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  hint: string;
  file: string;
  line: number;
  snippet: string;
};

/** 规则表条目（codescan:rules 返回） */
type ScanRule = {
  id: string;
  pack: 'audit' | 'coverage';
  category: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  desc: string;
};

/** 严重程度 → 颜色 + 文案 */
const sevMeta = (s: string) => {
  if (s === 'high') return { color: 'red', label: '高' };
  if (s === 'medium') return { color: 'orange', label: '中' };
  return { color: 'default', label: '低' };
};

/** 规则分类 → 展示名 + 排序（和 electron/scan-rules.js 的 category 对应） */
const CATEGORY_META: Record<string, { label: string; order: number }> = {
  ui: { label: 'UI 自动化反模式', order: 0 },
  secret: { label: '硬编码敏感信息', order: 1 },
  assert: { label: '断言质量', order: 2 },
  coverage: { label: '覆盖取数', order: 3 }
};

export default function CodeScanPage() {
  const [root, setRoot] = useState('');
  const [view, setView] = useState<'coverage' | 'hardcoded' | 'deps'>('coverage');
  /** 依赖检查结果 */
  const [deps, setDeps] = useState<any>(null);
  /** 覆盖矩阵的对象：接口 / 页面 */
  const [covKind, setCovKind] = useState<'api' | 'page'>('api');
  /** 覆盖矩阵的范围筛选：只对比选中的模块（空 = 全部） */
  const [modules, setModules] = useState<{ name: string; count: number }[]>([]);
  const [pickedModules, setPickedModules] = useState<string[]>([]);
  const [noModuleCount, setNoModuleCount] = useState(0);
  const [busy, setBusy] = useState(false);

  /** 规则表 + 勾选状态（默认全选） */
  const [rules, setRules] = useState<ScanRule[]>([]);
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesError, setRulesError] = useState('');

  // 覆盖矩阵
  const [cov, setCov] = useState<any>(null);

  // 硬编码
  const [scan, setScan] = useState<any>(null);
  const [sevFilter, setSevFilter] = useState('');

  /* ---------- 规则表 ---------- */
  const loadRules = async () => {
    try {
      // 老 preload / 预览模式可能还没有这个通道：读不到就退回「全部规则」，不要挡住扫描
      const fn = (api as any).codescanRules;
      if (typeof fn !== 'function') {
        setRulesError('当前环境没有规则表通道（codescan:rules），扫描时按全部规则执行');
        return;
      }
      const res = await fn();
      const list: ScanRule[] = (res && res.rules) || [];
      if (!list.length) {
        setRulesError('规则表为空，扫描时按全部规则执行');
        return;
      }
      setRules(list);
      setRuleIds(list.map((r) => r.id));
      setRulesError('');
    } catch (e: any) {
      setRulesError('规则表读取失败，扫描时按全部规则执行');
    }
  };

  /** 本次要跑的规则 id；规则表没加载到时返回 undefined（= 后端默认全跑） */
  const idsForPack = (pack: 'audit' | 'coverage'): string[] | undefined => {
    if (!rules.length) return undefined;
    return ruleIds.filter((id) => {
      const r = rules.find((x) => x.id === id);
      return !!r && r.pack === pack;
    });
  };

  const toggleRule = (id: string) => {
    setRuleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /** 按 category 分组（面板展示用） */
  const ruleGroups = useMemo(() => {
    const map = new Map<string, ScanRule[]>();
    for (const r of rules) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)!.push(r);
    }
    return [...map.entries()]
      .map(([category, list]) => ({
        category,
        label: (CATEGORY_META[category] || { label: category }).label,
        order: (CATEGORY_META[category] || { order: 9 }).order,
        rules: list
      }))
      .sort((a, b) => a.order - b.order);
  }, [rules]);

  /* ---------- 模块列表（给范围筛选用）---------- */
  const loadModules = async (kind: 'api' | 'page') => {
    try {
      const res = await api.codescanModules(kind);
      if (res && res.ok) {
        setModules(res.modules || []);
        setNoModuleCount(Number(res.noModule) || 0);
      }
    } catch (e) {
      setModules([]);
    }
  };

  /* ---------- 覆盖矩阵 ---------- */
  const doCoverage = async (kind?: 'api' | 'page') => {
    const k = kind || covKind;
    if (k !== covKind) {
      setPickedModules([]);
      loadModules(k);
    }
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

    // 一条取数规则都没勾 → 扫了也是空结果，直接拦下来（别让人以为「代码里没请求」）
    const covIds = idsForPack('coverage');
    if (covIds && !covIds.length) {
      toast('至少勾一条「覆盖取数」规则，否则扫了也是空结果', 'error');
      return;
    }

    setBusy(true);
    try {
      const res = await api.codescanCoverage(root || undefined, k, pickedModules, covIds);
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

  /* ---------- 代码体检（原「硬编码检查」）---------- */
  const doHardcoded = async () => {
    setView('hardcoded'); // 先切视图（理由见 doCoverage）

    const auditIds = idsForPack('audit');
    if (auditIds && !auditIds.length) {
      toast('至少勾一条规则，否则扫了也是空结果', 'error');
      return;
    }

    setBusy(true);
    try {
      const res = await api.codescanHardcoded(root || undefined, auditIds);
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

  /* 首次进入加载接口模块列表 + 规则表 */
  React.useEffect(() => {
    loadModules('api');
    loadRules();
  }, []);

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
          {/*
            四个检查项的提示：**一句话说清「扫什么、和什么比」**
            （用户要求简洁直白，不要小字长说明）
          */}
          <Tooltip title="代码里真正调用了哪些接口 vs 接口记录，找出没测到的">
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

          <Tooltip title="代码里真正跳转了哪些页面 vs 页面元素，找出没测到的">
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

          <Tooltip title="密码/Token/URL 写死、脆弱定位、弱断言 —— 按规则表逐条查，按高中低危分级">
            <Button size="small" icon={<SafetyOutlined />} onClick={doHardcoded} loading={busy}>
              代码体检
            </Button>
          </Tooltip>

          <Tooltip title="pom.xml / requirements.txt 的版本冲突、重复声明、占位符没定义">
            <Button size="small" icon={<ApartmentOutlined />} onClick={doDeps} loading={busy}>
              依赖检查
            </Button>
          </Tooltip>

          {/* 规则勾选入口：默认全选，缩起来不挡视线 */}
          <Button
            size="small"
            icon={<FilterOutlined />}
            type={rulesOpen ? 'primary' : 'default'}
            onClick={() => setRulesOpen((v) => !v)}
          >
            规则{rules.length ? ` ${ruleIds.length}/${rules.length}` : ''}
          </Button>
        </Space>
      </div>

      {/* 规则勾选面板 */}
      {rulesOpen ? (
        <div className="rule-panel">
          <Alert
            type="info"
            showIcon
            message="启发式检查，不是语法树分析：可能误报，也会漏报"
            description="规则都是正则 + 条件判断，命中只代表「这里值得看一眼」；确认是误报就取消勾选这类规则再扫。"
          />
          {rulesError ? <Alert type="warning" showIcon message={rulesError} /> : null}

          <div className="rule-panel-head">
            <span className="muted" style={{ fontSize: 11.5 }}>
              已勾选 {ruleIds.length} / {rules.length} 条
              {rules.length ? `（代码体检 ${idsForPack('audit')?.length || 0} 条 · 覆盖取数 ${idsForPack('coverage')?.length || 0} 条）` : ''}
            </span>
            <Space size={6}>
              <Button size="small" onClick={() => setRuleIds(rules.map((r) => r.id))}>
                全选
              </Button>
              <Button size="small" onClick={() => setRuleIds([])}>
                全不选
              </Button>
            </Space>
          </div>

          <div className="rule-groups">
            {ruleGroups.map((g) => (
              <div className="rule-group" key={g.category}>
                <div className="rule-group-title">
                  {g.label} <span className="muted">({g.rules.length})</span>
                </div>
                {g.rules.map((r) => {
                  const m = sevMeta(r.severity);
                  return (
                    <div className="rule-row" key={r.id}>
                      <Checkbox checked={ruleIds.includes(r.id)} onChange={() => toggleRule(r.id)}>
                        <span className="rule-title">{r.title}</span>
                      </Checkbox>
                      <Tag color={m.color} className="rule-sev">
                        {m.label}
                      </Tag>
                      {r.pack === 'coverage' ? <Tag className="rule-pack">覆盖取数</Tag> : null}
                      <Tooltip title={r.desc}>
                        <span className="rule-desc muted">{r.desc}</span>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}

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
              { label: `代码体检${scan ? ` (${scan.summary.total})` : ''}`, value: 'hardcoded' },
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
            {/* 范围筛选：只对比「本项目相关」的模块，避免全公司文档混进来 */}
            {modules.length ? (
              <div className="cov-scope">
                <span className="muted" style={{ fontSize: 12 }}>
                  {covKind === 'page' ? '项目' : '模块'}范围
                </span>
                <Select
                  mode="multiple"
                  size="small"
                  allowClear
                  style={{ minWidth: 280, maxWidth: 620 }}
                  value={pickedModules}
                  onChange={setPickedModules}
                  placeholder="全部（不筛选）— 选几个只对比这些"
                  options={modules.map((m) => ({
                    value: m.name,
                    label: `${m.name}（${m.count}）`
                  }))}
                  maxTagCount="responsive"
                />
                {pickedModules.length ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      setPickedModules([]);
                      doCoverage(covKind);
                    }}
                  >
                    清除筛选并重扫
                  </Button>
                ) : (
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    接口记录里可能包含全公司文档，只选本项目负责的模块更准
                    {noModuleCount ? `（另有 ${noModuleCount} 条没标模块）` : ''}
                  </span>
                )}
              </div>
            ) : null}

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

      {/* 代码体检 */}
      {view === 'hardcoded' ? (
        !scan ? (
          <div className="codescan-empty">
            <Empty description="点「代码体检」按勾选的规则扫代码问题" />
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
                <div className="cov-stat-label">
                  问题总数（扫描 {scan.scannedFiles} 个文件
                  {Array.isArray(scan.rulesRun) ? ` · ${scan.rulesRun.length} 条规则` : ''}）
                </div>
              </div>
            </div>

            {/* 截断必须说清楚：为什么少、少在哪 —— 不能让人以为这就是全部 */}
            {scan.truncated ? (
              <Alert
                type="warning"
                showIcon
                message={'结果被截断：' + (scan.truncatedReason || '达到扫描上限')}
                description="命中数可能偏少。可以少勾几条规则、缩小目录，或分批扫。"
              />
            ) : null}

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
              {scan.suppressed ? (
                <span className="muted" style={{ fontSize: 11.5 }}>
                  另有 {scan.suppressed} 条同类命中未展示（每规则每文件最多 3 条）
                </span>
              ) : null}
            </div>

            {!filteredIssues.length ? (
              scan.summary.total === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message="勾选的规则一条都没命中"
                  description="注意这是启发式检查：没命中不等于没问题。规则只看正则能识别到的写法，漏报是常态。"
                />
              ) : (
                <Alert type="success" showIcon message="当前严重程度筛选下没有条目" />
              )
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