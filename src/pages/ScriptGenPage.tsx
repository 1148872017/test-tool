import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, InputNumber, Select, Alert, Space, Segmented, Checkbox } from 'antd';
import {
  PlayCircleOutlined,
  SaveOutlined,
  CopyOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  WarningOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

type Tab = 'jmx' | 'sql';

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

  /* ============ MySQL SQL ============ */
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
        onError
      });
      if (!res.ok) {
        toast(res.message || '生成失败', 'error');
        return;
      }
      setJmxCode(res.xml);
      setJmxFile(res.filename);
      toast('生成成功');
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
        onError
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
            { label: 'MySQL 快照 / 清理', value: 'sql' }
          ]}
        />
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

            <Space size={6} wrap style={{ marginTop: 8 }}>
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
            <pre className="scriptgen-code mono">{jmxCode || '选好接口和参数，点「生成预览」'}</pre>
          </div>
        </div>
      ) : null}

      {/* ============ MySQL SQL ============ */}
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
            <pre className="scriptgen-code mono">{sqlCode || '填好参数，点「生成 SQL」'}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}