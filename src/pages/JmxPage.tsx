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
  CodeOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import ScriptTemplatesDrawer from '../components/ScriptTemplatesDrawer';

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

export default function JmxPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');
  const [dirFilter, setDirFilter] = useState('');
  const [detail, setDetail] = useState<any>(null);
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
              onRow={(f: any) => ({ onClick: () => setDetail(f), style: { cursor: 'pointer' } })}
            />
          </div>
        </div>
      </div>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
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
            {detail.parseError ? (
              <Alert type="error" showIcon message="解析失败" description={detail.parseError} style={{ marginBottom: 14 }} />
            ) : null}

            {detail.health.issues.length ? (
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
              <Alert type="success" showIcon message="没有发现问题" style={{ marginBottom: 14 }} />
            )}

            {detail.threadGroups.length ? (
              <section className="jmx-section">
                <h4>线程组（{detail.threadGroups.length}）</h4>
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
                    {detail.threadGroups.map((t: any, i: number) => (
                      <tr key={i}>
                        <td>{t.name}</td>
                        <td className="muted">{TG_TYPE_LABEL[t.type] || t.type}</td>
                        <td>{t.numThreads || '—'}</td>
                        <td>{t.rampUp ? t.rampUp + 's' : '—'}</td>
                        <td>{t.duration ? t.duration + 's' : '—'}</td>
                        <td>{t.loops || '—'}</td>
                        <td>{t.enabled ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            {detail.samplers.length ? (
              <section className="jmx-section">
                <h4>采样器（{detail.samplers.length}）</h4>
                <div className="jmx-samplers">
                  {detail.samplers.map((s: any, i: number) => (
                    <div className={'jmx-sampler' + (s.enabled ? '' : ' jmx-sampler-off')} key={i}>
                      <Tag color={s.method === 'GET' ? 'green' : s.method === 'POST' ? 'blue' : 'purple'}>
                        {s.method}
                      </Tag>
                      <span className="jmx-sampler-path mono">{s.path || '(继承默认值)'}</span>
                      <span className="jmx-sampler-name muted">{s.name}</span>
                      {!s.enabled ? <Tag>禁用</Tag> : null}
                    </div>
                  ))}
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
                <h4>断言</h4>
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

            {detail.placeholders.length ? (
              <section className="jmx-section">
                <h4>占位符（{detail.placeholders.length}）</h4>
                <div className="jmx-placeholders">
                  {detail.placeholders.map((p: string) => (
                    <Tag key={p} className="mono">
                      {'${' + p + '}'}
                    </Tag>
                  ))}
                </div>
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
          </div>
        ) : null}
      </Drawer>

      <ScriptTemplatesDrawer open={tplOpen} onClose={() => setTplOpen(false)} />
    </div>
  );
}
