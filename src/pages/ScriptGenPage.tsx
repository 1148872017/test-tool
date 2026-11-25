import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Select, Alert, Space, Segmented, Checkbox, Tag } from 'antd';
import {
  PlayCircleOutlined,
  SaveOutlined,
  CopyOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  WarningOutlined,
  ReadOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import StateEmpty from '../components/states/StateEmpty';
import ScriptTemplatesDrawer from '../components/ScriptTemplatesDrawer';

type Tab = 'jmx' | 'sql';

/**
 * 附加 JSR223 代码。
 *
 * 为什么这里要能做（v0.44.0 用户反馈「JMeter 脚本无法编辑断言」）：
 *   之前生成器只会写死「响应断言-状态码200」和「持续时间断言」，
 *   用户想加一条业务断言只能生成完再去 JMeter GUI 里手工拖一个元件。
 *   现在把脚本模板里的 Groovy 直接带进生成流程，生成出来就是能跑的脚本。
 *
 * type 与 shared/jmxgen.js 的 extraElements.type 一一对应：
 *   assertion = JSR223 断言 / pre = JSR223 前置处理器 / post = JSR223 后置处理器
 */
type ExtraType = 'assertion' | 'pre' | 'post';

type ExtraElement = {
  /** 行键：删中间一行时不让后面的输入框错位复用 */
  id: number;
  type: ExtraType;
  code: string;
  /** 来源模板名（写进 jmx 的 testname，JMeter 树里好认；手填的为空） */
  name?: string;
};

/** 附加代码行自增 id（只在前端当 React key） */
let extraSeq = 0;

const EXTRA_OPTIONS = [
  { value: 'pre', label: '前置处理' },
  { value: 'assertion', label: '断言' },
  { value: 'post', label: '后置处理' }
];

/** MySQL 表操作 */
type TableOp = {
  name: string;
  mode: 'delete' | 'truncate' | 'drop';
  where: string;
};

export default function ScriptGenPage() {
  const [tab, setTab] = useState<Tab>('jmx');

  /* ============ JMeter 脚本 ============ */
  const [apis, setApis] = useState<any[]>([]);
  const [apiIds, setApiIds] = useState<string[]>([]);
  const [planName, setPlanName] = useState('压测计划');
  const [threads, setThreads] = useState(10);
  const [rampUp, setRampUp] = useState(2);
  const [loops, setLoops] = useState(5);
  const [duration, setDuration] = useState(0);
  const [rtLimit, setRtLimit] = useState(500);
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState('');
  const [onError, setOnError] = useState('continue');
  const [jmxCode, setJmxCode] = useState('');
  const [jmxFile, setJmxFile] = useState('');
  /** 生成时用的 JMeter 版本（从设置里的 jmeterPath 读） */
  const [jmeterVersion, setJmeterVersion] = useState('');
  /** CSV 参数化 */
  const [csvEnabled, setCsvEnabled] = useState(false);
  const [csvFile, setCsvFile] = useState('data.csv');
  const [csvVars, setCsvVars] = useState('userName,mobile');
  const [csvRecycle, setCsvRecycle] = useState(true);
  const [csvStopThread, setCsvStopThread] = useState(false);
  const [csvIgnoreFirst, setCsvIgnoreFirst] = useState(false);

  /** 脚本模板抽屉 */
  const [tplOpen, setTplOpen] = useState(false);
  /** 附加 JSR223 代码（从模板带过来，或自己粘） */
  const [extraElements, setExtraElements] = useState<ExtraElement[]>([]);

  /* ============ 数据库 SQL（MySQL / SQLite）============ */
  const [sqlMode, setSqlMode] = useState<'snapshot' | 'cleanup' | 'restore'>('snapshot');
  const [dialect, setDialect] = useState<'mysql' | 'sqlite'>('mysql');
  const [database, setDatabase] = useState('test_db');
  const [snapMode, setSnapMode] = useState<'table' | 'dump'>('table');
  const [snapTables, setSnapTables] = useState('');
  const [tableOps, setTableOps] = useState<TableOp[]>([{ name: '', mode: 'delete', where: '' }]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [restorePairs, setRestorePairs] = useState([{ table: '', backup: '', mode: 'truncate-insert' }]);
  const [sqlCode, setSqlCode] = useState('');

  const [busy, setBusy] = useState(false);

  /* ---------- 初始化：加载接口列表 ---------- */
  useEffect(() => {
    (async () => {
      try {
        const rows = await api.records('apis');
        setApis(rows || []);
      } catch (e) {
        /* ignore */
      }
    })();
  }, []);

  /** 组装 CSV 参数（没启用就返回 undefined，jmxgen 会跳过） */
  const buildCsv = () => {
    if (!csvEnabled) return undefined;
    return {
      fileName: csvFile,
      variableNames: csvVars,
      recycle: csvRecycle,
      stopThread: csvStopThread,
      ignoreFirstLine: csvIgnoreFirst
    };
  };

  /**
   * 组装附加代码。
   * 空行（点了「添加」还没粘代码）直接过滤，别在 jmx 里留空脚本元件。
   */
  const buildExtras = () =>
    extraElements
      .filter((e) => e.code.trim())
      .map((e) => ({ type: e.type, code: e.code, name: e.name || '' }));

  /* ---------- 附加代码增删改 ---------- */
  const addExtra = () => setExtraElements((prev) => prev.concat([{ id: ++extraSeq, type: 'assertion', code: '' }]));
  const removeExtra = (id: number) => setExtraElements((prev) => prev.filter((e) => e.id !== id));
  const setExtra = (id: number, patch: Partial<Omit<ExtraElement, 'id'>>) =>
    setExtraElements((prev) => prev.map((e) => (e.id === id ? Object.assign({}, e, patch) : e)));

  /** 模板抽屉「填入附加代码」：占位符已按模板默认值填好，生成即可跑 */
  const pickTemplate = (item: { type: ExtraType; code: string; name: string }) => {
    setExtraElements((prev) => prev.concat([{ id: ++extraSeq, type: item.type, code: item.code, name: item.name }]));
    toast('已填入附加代码（' + (item.type === 'assertion' ? '断言' : item.type === 'pre' ? '前置处理' : '后置处理') + '），点「生成预览」写进 jmx');
  };

  /* ---------- 生成 jmx ---------- */
  const doGenJmx = async () => {
    if (!apiIds.length) {
      toast('至少选一个接口', 'warning');
      return;
    }
    setBusy(true);
    try {
      const res = await api.jmxgenPreview({
        apiIds,
        name: planName,
        threads,
        rampUp,
        loops,
        duration,
        rtLimit,
        domain,
        port,
        onError,
        csv: buildCsv(),
        extraElements: buildExtras()
      });
      if (!res.ok) {
        toast(res.message || '生成失败', 'error');
        return;
      }
      setJmxCode(res.xml);
      setJmxFile(res.filename);
      if (res.jmeterVersion) setJmeterVersion(String(res.jmeterVersion));
      toast(`生成成功（JMeter ${res.jmeterVersion || '5.6.3'}）`);
    } catch (e: any) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 保存 jmx ---------- */
  const doSaveJmx = async () => {
    if (!jmxCode) {
      toast('先生成', 'warning');
      return;
    }
    setBusy(true);
    try {
      const res = await api.jmxgenSave({
        apiIds,
        name: planName,
        threads,
        rampUp,
        loops,
        duration,
        rtLimit,
        domain,
        port,
        onError,
        csv: buildCsv(),
        extraElements: buildExtras()
      });
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '保存失败', 'error');
        return;
      }
      toast('已保存：' + res.file);
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 生成 SQL ---------- */
  const doGenSql = async () => {
    setBusy(true);
    try {
      let res;
      if (sqlMode === 'snapshot') {
        const tables = snapTables
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        res = await api.sqlgenSnapshot({ database, tables, mode: snapMode, dialect });
      } else if (sqlMode === 'cleanup') {
        res = await api.sqlgenCleanup({ database, tables: tableOps, confirm: confirmClear, dialect });
      } else {
        res = await api.sqlgenRestore({ database, pairs: restorePairs, dialect });
      }

      if (!res.ok) {
        toast(res.message || '生成失败', 'error');
        setSqlCode('');
        return;
      }
      setSqlCode(res.sql);
      toast('生成成功');
    } catch (e: any) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async (text: string) => {
    if (!text) {
      toast('先生成', 'warning');
      return;
    }
    await api.copy(text, false);
    toast('已复制');
  };

  /* ---------- 表操作增删 ---------- */
  const addOp = () => setTableOps((prev) => prev.concat([{ name: '', mode: 'delete', where: '' }]));
  const removeOp = (i: number) => setTableOps((prev) => prev.filter((_, idx) => idx !== i));
  const setOp = (i: number, key: keyof TableOp, v: any) => {
    setTableOps((prev) => {
      const next = prev.slice();
      next[i] = Object.assign({}, next[i], { [key]: v });
      return next;
    });
  };

  const addPair = () => setRestorePairs((prev) => prev.concat([{ table: '', backup: '', mode: 'truncate-insert' }]));
  const removePair = (i: number) => setRestorePairs((prev) => prev.filter((_, idx) => idx !== i));
  const setPair = (i: number, key: string, v: any) => {
    setRestorePairs((prev) => {
      const next = prev.slice();
      next[i] = Object.assign({}, next[i], { [key]: v });
      return next;
    });
  };

  /* ---------- 是否用了危险操作 ---------- */
  const hasDanger = useMemo(
    () => tableOps.some((o) => o.name && (o.mode === 'truncate' || o.mode === 'drop')),
    [tableOps]
  );

  return (
    <div className="scriptgen-page">
      <div className="scriptgen-bar">
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { label: 'JMeter 脚本', value: 'jmx' },
            { label: '数据库快照 / 清理', value: 'sql' }
          ]}
        />
        {/*
         * 为什么「压测脚本」和「脚本生成」不合并（用户问过）：
         *   两者的输入不一样——「压测脚本」读的是磁盘上**已有的** .jmx（索引、健康检查、
         *   启动 JMeter），「脚本生成」是从接口记录**产出新的** .jmx（选接口、设线程、
         *   附加断言）。合并后一个页面里既有「扫描文件」又有「生成文件」，
         *   顶部还得再放一层数据源切换，比现在两页更绕。这里用一句说明代替合并。
         */}
        <span className="muted" style={{ fontSize: 12 }}>
          「压测脚本」页看的是你已经有的 .jmx 脚本；这里生成的是新的 jmx 文件。
        </span>
      </div>

      {/* ============ JMeter 脚本 ============ */}
      {tab === 'jmx' ? (
        <div className="scriptgen-body">
          <div className="scriptgen-form">
            <div className="scriptgen-field">
              <label>接口</label>
              <Select
                mode="multiple"
                size="small"
                style={{ width: '100%' }}
                value={apiIds}
                onChange={setApiIds}
                placeholder={apis.length ? '选一个或多个接口（按选择顺序执行）' : '还没有接口记录'}
                showSearch
                optionFilterProp="label"
                options={apis.map((a) => ({
                  value: a.id,
                  label: `${a.data.method} ${a.data.url} · ${a.title}`
                }))}
              />
            </div>

            <div className="scriptgen-field">
              <label>测试计划名</label>
              <Input size="small" value={planName} onChange={(e) => setPlanName(e.target.value)} />
            </div>

            <div className="scriptgen-row">
              <div className="scriptgen-field">
                <label>线程数</label>
                <InputNumber size="small" min={1} max={10000} value={threads} onChange={(v) => setThreads(Number(v) || 1)} style={{ width: '100%' }} />
              </div>
              <div className="scriptgen-field">
                <label>Ramp-Up（秒）</label>
                <InputNumber size="small" min={0} max={3600} value={rampUp} onChange={(v) => setRampUp(Number(v) || 0)} style={{ width: '100%' }} />
              </div>
            </div>

            <div className="scriptgen-row">
              <div className="scriptgen-field">
                <label>循环次数</label>
                <InputNumber
                  size="small"
                  min={1}
                  max={1000000}
                  value={loops}
                  disabled={duration > 0}
                  onChange={(v) => setLoops(Number(v) || 1)}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="scriptgen-field">
                <label>持续时长（秒，0=按循环）</label>
                <InputNumber size="small" min={0} max={86400} value={duration} onChange={(v) => setDuration(Number(v) || 0)} style={{ width: '100%' }} />
              </div>
            </div>

            <div className="scriptgen-row">
              <div className="scriptgen-field">
                <label>RT 上限（毫秒，0=不生成断言）</label>
                <InputNumber size="small" min={0} max={600000} value={rtLimit} onChange={(v) => setRtLimit(Number(v) || 0)} style={{ width: '100%' }} />
              </div>
              <div className="scriptgen-field">
                <label>出错时</label>
                <Select
                  size="small"
                  value={onError}
                  onChange={setOnError}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'continue', label: '继续' },
                    { value: 'startnextloop', label: '开始下次循环' },
                    { value: 'stopthread', label: '停止线程' }
                  ]}
                />
              </div>
            </div>

            <div className="scriptgen-row">
              <div className="scriptgen-field">
                <label>域名（空=从接口取）</label>
                <Input size="small" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="自动" />
              </div>
              <div className="scriptgen-field">
                <label>端口（空=从接口取）</label>
                <Input size="small" value={port} onChange={(e) => setPort(e.target.value)} placeholder="自动" />
              </div>
            </div>

            {/* CSV 参数化（规划要求「参数化配置」） */}
            <div className="scriptgen-field">
              <label>
                <Checkbox checked={csvEnabled} onChange={(e) => setCsvEnabled(e.target.checked)}>
                  启用 CSV 参数化（CSV Data Set Config）
                </Checkbox>
              </label>
            </div>

            {csvEnabled ? (
              <>
                <div className="scriptgen-row">
                  <div className="scriptgen-field">
                    <label>CSV 文件（相对 jmx 所在目录）</label>
                    <Input size="small" value={csvFile} onChange={(e) => setCsvFile(e.target.value)} />
                  </div>
                  <div className="scriptgen-field">
                    <label>变量名（逗号分隔）</label>
                    <Input
                      size="small"
                      value={csvVars}
                      placeholder="userName,mobile"
                      onChange={(e) => setCsvVars(e.target.value)}
                    />
                  </div>
                </div>
                <div className="scriptgen-field">
                  <Space size={12} wrap>
                    <Checkbox checked={csvRecycle} onChange={(e) => setCsvRecycle(e.target.checked)}>
                      读完循环（recycle）
                    </Checkbox>
                    <Checkbox checked={csvStopThread} onChange={(e) => setCsvStopThread(e.target.checked)}>
                      读完停止线程
                    </Checkbox>
                    <Checkbox checked={csvIgnoreFirst} onChange={(e) => setCsvIgnoreFirst(e.target.checked)}>
                      忽略首行（表头）
                    </Checkbox>
                  </Space>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {/* 用 {'...'} 包起来，否则 esbuild 会把这里当插值 */}
                  {'CSV 里每行一条数据，请求里用 ${变量名} 引用（如 ${userName}）'}
                </div>
              </>
            ) : null}

            {/* 附加代码：把脚本模板里的断言 / 提取代码直接生成进 jmx（不用生成完再去 GUI 里拖元件） */}
            <div className="scriptgen-field">
              <label>附加代码（JSR223，可选）</label>
              {extraElements.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {extraElements.map((e) => (
                    <div
                      key={e.id}
                      style={{
                        border: '1px solid var(--line-soft)',
                        borderRadius: 6,
                        padding: 6,
                        background: '#fff'
                      }}
                    >
                      <Space size={6} style={{ width: '100%', justifyContent: 'space-between' }}>
                        <Space size={6}>
                          <Select
                            size="small"
                            value={e.type}
                            onChange={(v) => setExtra(e.id, { type: v })}
                            style={{ width: 108 }}
                            options={EXTRA_OPTIONS}
                          />
                          {e.name ? (
                            <Tag style={{ fontSize: 11, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {e.name}
                            </Tag>
                          ) : null}
                        </Space>
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => removeExtra(e.id)}
                          aria-label={'删除附加代码 ' + (e.name || e.type)}
                        />
                      </Space>
                      <Input.TextArea
                        size="small"
                        className="mono"
                        value={e.code}
                        autoSize={{ minRows: 2, maxRows: 8 }}
                        placeholder={'// 从「脚本模板」带过来，或直接粘 Groovy 代码'}
                        onChange={(ev) => setExtra(e.id, { code: ev.target.value, name: '' })}
                        style={{ marginTop: 6 }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>
                  还没有附加代码。点「脚本模板」挑一条断言/提取模板 → 「填入附加代码」，就会写进生成的 jmx。
                </div>
              )}
              <Space size={6} style={{ marginTop: 2 }}>
                <Button size="small" type="link" icon={<PlusOutlined />} onClick={addExtra}>
                  添加附加代码
                </Button>
                <Button size="small" type="link" icon={<ReadOutlined />} onClick={() => setTplOpen(true)}>
                  从模板选
                </Button>
              </Space>
            </div>

            <div className="scriptgen-field">
              <label>JMeter 版本</label>
              <div className="muted" style={{ fontSize: 12 }}>
                {jmeterVersion ? (
                  <>
                    <Tag color="green" style={{ marginRight: 6 }}>
                      {jmeterVersion}
                    </Tag>
                    （已写入脚本，打开不会提示版本不一致）
                  </>
                ) : (
                  '生成时自动从「设置 → 压测」的 JMeter 路径读取'
                )}
              </div>
            </div>

            <Space size={6} wrap style={{ marginTop: 8 }}>
              {/* 脚本模板入口：断言/提取代码的现成写法，选中可一键填进上面的附加代码 */}
              <Button size="small" icon={<ReadOutlined />} onClick={() => setTplOpen(true)}>
                脚本模板
              </Button>
              <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={doGenJmx} loading={busy}>
                生成预览
              </Button>
              <Button size="small" icon={<SaveOutlined />} onClick={doSaveJmx} disabled={!jmxCode}>
                保存为 .jmx
              </Button>
              <Button size="small" icon={<CopyOutlined />} onClick={() => doCopy(jmxCode)} disabled={!jmxCode}>
                复制
              </Button>
            </Space>
          </div>

          <div className="scriptgen-output">
            <div className="scriptgen-output-head">
              <span>{jmxFile || 'jmx 预览'}</span>
              {jmxCode ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {jmxCode.split('\n').length} 行
                </span>
              ) : null}
            </div>
            {jmxCode ? (
              <pre className="scriptgen-code mono">{jmxCode}</pre>
            ) : (
              <StateEmpty
                kind="no-data"
                object="JMX 脚本"
                desc="选好接口和参数，点「生成预览」；生成的脚本可直接用 JMeter 打开"
                action={{ label: '生成预览', onClick: doGenJmx }}
              />
            )}
          </div>
        </div>
      ) : null}

      {/* ============ 数据库 SQL（MySQL / SQLite） ============ */}
      {tab === 'sql' ? (
        <div className="scriptgen-body">
          <div className="scriptgen-form">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 10 }}
              message="只生成 SQL，不连数据库、不执行"
              description={
                dialect === 'sqlite'
                  ? '复制到你的 SQLite 客户端（DB Browser / DBeaver / 命令行）执行。平台不保存任何连接信息。'
                  : '复制到你的 MySQL 客户端执行。平台不保存数据库密码。'
              }
            />

            <div className="scriptgen-field">
              <label>数据库类型</label>
              <Segmented
                size="small"
                value={dialect}
                onChange={(v) => {
                  setDialect(v as 'mysql' | 'sqlite');
                  setSqlCode('');
                }}
                options={[
                  { label: 'MySQL', value: 'mysql' },
                  { label: 'SQLite', value: 'sqlite' }
                ]}
              />
            </div>

            <div className="scriptgen-field">
              <label>{dialect === 'sqlite' ? '库文件名（用于注释，SQLite 一个文件就是一个库）' : '库名'}</label>
              <Input
                size="small"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder={dialect === 'sqlite' ? 'test_db（会当成 test_db.db）' : 'test_db'}
              />
            </div>

            <div className="scriptgen-field">
              <label>操作</label>
              <Segmented
                size="small"
                value={sqlMode}
                onChange={(v) => {
                  setSqlMode(v as any);
                  setSqlCode('');
                }}
                options={[
                  { label: '快照', value: 'snapshot' },
                  { label: '清理', value: 'cleanup' },
                  { label: '还原', value: 'restore' }
                ]}
              />
            </div>

            {/* 快照 */}
            {sqlMode === 'snapshot' ? (
              <>
                <div className="scriptgen-field">
                  <label>方式</label>
                  <Segmented
                    size="small"
                    value={snapMode}
                    onChange={(v) => setSnapMode(v as any)}
                    options={[
                      { label: '建备份表', value: 'table' },
                      { label: dialect === 'sqlite' ? 'sqlite3 导出命令' : 'mysqldump 命令', value: 'dump' }
                    ]}
                  />
                </div>
                <div className="scriptgen-field">
                  <label>表名（逗号或空格分隔）</label>
                  <Input.TextArea
                    size="small"
                    rows={3}
                    value={snapTables}
                    onChange={(e) => setSnapTables(e.target.value)}
                    placeholder="t_order, t_user, t_product"
                  />
                </div>
              </>
            ) : null}

            {/* 清理 */}
            {sqlMode === 'cleanup' ? (
              <>
                <div className="scriptgen-field">
                  <label>表与操作</label>
                  <table className="jmx-table scriptgen-table">
                    <thead>
                      <tr>
                        <th style={{ width: '28%' }}>表名</th>
                        <th style={{ width: '20%' }}>方式</th>
                        <th>条件（DELETE 用）</th>
                        <th style={{ width: 32 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {tableOps.map((o, i) => (
                        <tr key={i}>
                          <td>
                            <Input size="small" value={o.name} placeholder="t_order" onChange={(e) => setOp(i, 'name', e.target.value)} />
                          </td>
                          <td>
                            <Select
                              size="small"
                              value={o.mode}
                              onChange={(v) => setOp(i, 'mode', v)}
                              style={{ width: '100%' }}
                              options={[
                                { value: 'delete', label: 'DELETE' },
                                { value: 'truncate', label: dialect === 'sqlite' ? '清空(无TRUNCATE)' : 'TRUNCATE' },
                                { value: 'drop', label: 'DROP' }
                              ]}
                            />
                          </td>
                          <td>
                            <Input
                              size="small"
                              value={o.where}
                              disabled={o.mode !== 'delete'}
                              placeholder="create_time < '2026-01-01'"
                              onChange={(e) => setOp(i, 'where', e.target.value)}
                            />
                          </td>
                          <td>
                            <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeOp(i)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Button size="small" type="link" icon={<PlusOutlined />} onClick={addOp}>
                    添加表
                  </Button>
                </div>

                {hasDanger ? (
                  <Alert
                    type="warning"
                    showIcon
                    icon={<WarningOutlined />}
                    style={{ marginBottom: 8 }}
                    message={dialect === 'sqlite' ? '有清空表 / DROP 操作，会整表清空' : '有 TRUNCATE / DROP 操作，会整表清空'}
                    description={
                      <Checkbox checked={confirmClear} onChange={(e) => setConfirmClear(e.target.checked)}>
                        我确认这是测试库，可以整表清空
                      </Checkbox>
                    }
                  />
                ) : null}
              </>
            ) : null}

            {/* 还原 */}
            {sqlMode === 'restore' ? (
              <div className="scriptgen-field">
                <label>还原对（原表 ← 备份表）</label>
                <table className="jmx-table scriptgen-table">
                  <thead>
                    <tr>
                      <th style={{ width: '26%' }}>原表</th>
                      <th style={{ width: '34%' }}>备份表</th>
                      <th style={{ width: '22%' }}>方式</th>
                      <th style={{ width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {restorePairs.map((p, i) => (
                      <tr key={i}>
                        <td>
                          <Input size="small" value={p.table} placeholder="t_order" onChange={(e) => setPair(i, 'table', e.target.value)} />
                        </td>
                        <td>
                          <Input size="small" value={p.backup} placeholder="bak_t_order_20261124_113000" onChange={(e) => setPair(i, 'backup', e.target.value)} />
                        </td>
                        <td>
                          <Select
                            size="small"
                            value={p.mode}
                            onChange={(v) => setPair(i, 'mode', v)}
                            style={{ width: '100%' }}
                            options={[
                              { value: 'truncate-insert', label: '先清空再灌' },
                              { value: 'replace', label: 'REPLACE 覆盖' },
                              { value: 'insert', label: 'INSERT 追加' }
                            ]}
                          />
                        </td>
                        <td>
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removePair(i)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Button size="small" type="link" icon={<PlusOutlined />} onClick={addPair}>
                  添加一组
                </Button>
              </div>
            ) : null}

            <Space size={6} wrap style={{ marginTop: 8 }}>
              <Button type="primary" size="small" icon={<DatabaseOutlined />} onClick={doGenSql} loading={busy}>
                生成 SQL
              </Button>
              <Button size="small" icon={<CopyOutlined />} onClick={() => doCopy(sqlCode)} disabled={!sqlCode}>
                复制
              </Button>
            </Space>
          </div>

          <div className="scriptgen-output">
            <div className="scriptgen-output-head">
              <span>SQL 预览</span>
              {sqlCode ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  {sqlCode.split('\n').length} 行
                </span>
              ) : null}
            </div>
            {sqlCode ? (
              <pre className="scriptgen-code mono">{sqlCode}</pre>
            ) : (
              <StateEmpty
                kind="no-data"
                object="SQL 脚本"
                desc="填好库名、表和参数，点「生成 SQL」；只是生成语句，不会连库执行"
                action={{ label: '生成 SQL', onClick: doGenSql }}
              />
            )}
          </div>
        </div>
      ) : null}

      {/*
       * 脚本模板抽屉（和「压测脚本」页共用同一个组件）。
       * 传了 onPick 之后，JMeter 模板上会多一个「填入附加代码」按钮，
       * 这就是「无法编辑断言」那条需求的落地方式：模板 → 附加代码 → 生成进 jmx。
       */}
      <ScriptTemplatesDrawer
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        onPick={pickTemplate}
      />
    </div>
  );
}