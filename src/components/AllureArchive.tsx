/**
 * 「归档到执行记录」按钮 + 弹窗（Allure 报告分析页工具条用）。
 *
 * 为什么单独一个组件，而不是直接塞进 ReportPage.tsx：
 *   1. ReportPage 同时在改「步骤展示」，两边都改同一个文件必然打架；
 *      把按钮 + 弹窗 + 归档逻辑收在这一个文件里，接入只需要一行 JSX。
 *   2. 归档这件事和后端 allure:archive 是一对，测试可以只读本文件断言
 *      「按钮在、预填在、摘要口径在」，不受报告页其它改动的干扰。
 *
 * 接入方式（ReportPage 工具条那一行 Space 里加一行）：
 *
 *   <AllureArchive dir={dir} summary={summary} onNavigate={onNavigate} />
 *
 * 其中 onNavigate 由 App.tsx 传进 ReportPage（和 v0.45 的 JmxPage / ScriptGenPage 一致）。
 */
import React, { useMemo, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space } from 'antd';
import { FileDoneOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { ENV_OPTIONS, RUN_KIND_OPTIONS } from '../../shared/collections';

/**
 * 归档时可以选的类型：Allure 报告既可能是接口（REST Assured / pytest），
 * 也可能是 UI（Playwright / Selenium）。以前主进程写死 api，UI 报告就记错账
 * （见 electron/ipc/ipc-allure.js 的 resolveArchiveKind）。
 * 压测（perf）不在这里：压测走「导入压测报告」，指标字段完全不同。
 */
const ARCHIVE_KINDS = RUN_KIND_OPTIONS.filter((o: any) => o.value !== 'perf');

type Props = {
  /** 当前解析的报告目录；空 = 还没选目录，按钮不可用 */
  dir: string;
  /** allure:parse 返回的 summary（total / passed / failed / broken / skipped / duration） */
  summary: any;
  /** 页面互跳：归档成功后的「去『测试执行』页查看」 */
  onNavigate?: (route: any) => void;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 默认标题：「Allure 归档-11-25 09:40」（和主进程的兜底名保持同一格式） */
function defaultName(now: Date): string {
  return (
    'Allure 归档-' +
    pad2(now.getMonth() + 1) +
    '-' +
    pad2(now.getDate()) +
    ' ' +
    pad2(now.getHours()) +
    ':' +
    pad2(now.getMinutes())
  );
}

/** 毫秒 → 人类可读（和报告页汇总卡同一套写法） */
function fmtMs(n: number): string {
  if (!n) return '0ms';
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m${Math.round((n % 60000) / 1000)}s`;
}

export default function AllureArchive({ dir, summary, onNavigate }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [env, setEnv] = useState('test');
  /** 账本类型：接口测试 / UI 测试（默认 api，和旧行为一致） */
  const [kind, setKind] = useState('api');
  const [note, setNote] = useState('');
  /** 归档成功后的结果（非空 = 弹窗切成「已完成」状态，显示去测试执行的链接） */
  const [done, setDone] = useState<any>(null);

  /**
   * 统计口径必须和报告页汇总卡一致：
   *   failed 同时包含 failed 和 broken（broken 也是「没通过」），skipped 单列。
   */
  const counts = useMemo(() => {
    const s = summary || {};
    const total = Number(s.total) || 0;
    const passed = Number(s.passed) || 0;
    const failed = (Number(s.failed) || 0) + (Number(s.broken) || 0);
    const skipped = Number(s.skipped) || 0;
    return { total, passed, failed, skipped, duration: Number(s.duration) || 0 };
  }, [summary]);

  const canArchive = !!dir && counts.total > 0;

  const openModal = () => {
    if (!canArchive) {
      toast('先解析出一份 Allure 报告再归档', 'warning');
      return;
    }
    setName(defaultName(new Date()));
    setEnv('test');
    setKind('api');
    setNote('');
    setDone(null);
    setOpen(true);
  };

  const doArchive = async () => {
    setBusy(true);
    try {
      const res = await api.allureArchive({
        dir,
        name: name.trim(),
        kind,
        env,
        note: note.trim(),
        passCount: counts.passed,
        failCount: counts.failed,
        total: counts.total,
        duration: counts.duration
      });
      if (!res || !res.ok) {
        toast((res && res.message) || '归档失败', 'error');
        return;
      }
      setDone(res);
      // 重复归档不拦人（runs 是流水账），但要明说这次是新建的一条
      if (res.duplicated) {
        toast(`已归档（这个目录之前归档过 ${res.duplicates} 次，这次新增一条）`, 'warning');
      } else {
        toast('已归档，去「测试执行」页查看');
      }
    } catch (e: any) {
      toast('归档失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const gotoRuns = () => {
    setOpen(false);
    if (onNavigate) onNavigate({ type: 'collection', key: 'runs' });
  };

  return (
    <>
      <Button
        size="small"
        icon={<FileDoneOutlined />}
        onClick={openModal}
        disabled={!canArchive}
        title={canArchive ? '把这次解析结果记进「测试执行」' : '先解析一份 Allure 报告'}
      >
        归档到执行记录
      </Button>

      <Modal
        open={open}
        title="归档到「测试执行」"
        onCancel={() => setOpen(false)}
        width={520}
        footer={
          done ? (
            <Space>
              <Button onClick={() => setOpen(false)}>关闭</Button>
              <Button type="primary" onClick={gotoRuns}>
                去「测试执行」页查看
              </Button>
            </Space>
          ) : (
            <Space>
              <Button onClick={() => setOpen(false)}>取消</Button>
              <Button type="primary" loading={busy} onClick={doArchive}>
                确定归档
              </Button>
            </Space>
          )
        }
      >
        {done ? (
          <Alert
            type={done.result === 'bad' ? 'warning' : 'success'}
            showIcon
            message={done.result === 'bad' ? '已归档（有失败用例）' : '已归档'}
            description={
              <div>
                <div>
                  已写入「测试执行」：{done.name}
                  {done.id ? <span className="muted">（{done.id}）</span> : null}
                </div>
                {done.duplicated ? (
                  <div className="muted" style={{ marginTop: 4 }}>
                    这个报告目录之前已归档过 {done.duplicates} 次，本次是新增的一条（同一跑批可能想记不同结论）。
                  </div>
                ) : null}
                <div className="muted" style={{ marginTop: 4 }}>
                  报告目录已记在记录里，之后点「测试执行」列表的 📄 图标能回到这份报告。
                </div>
              </div>
            }
            action={
              <Button type="link" size="small" onClick={gotoRuns}>
                去查看
              </Button>
            }
          />
        ) : (
          <>
            <div className="muted" style={{ marginBottom: 12 }}>
              {counts.total} 个用例，{counts.passed} 通过 / {counts.failed} 失败 / {counts.skipped} 跳过 · 总耗时{' '}
              {fmtMs(counts.duration)}
            </div>
            <div style={{ marginBottom: 10 }}>
              <div className="muted" style={{ marginBottom: 4 }}>
                标题
              </div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：登录回归-1125" maxLength={80} />
            </div>
            <div style={{ marginBottom: 10, display: 'flex', gap: 10 }}>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  类型
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={kind}
                  onChange={setKind}
                  options={ARCHIVE_KINDS.map((o: any) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  环境
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={env}
                  onChange={setEnv}
                  options={ENV_OPTIONS.map((o: any) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>
            <div>
              <div className="muted" style={{ marginBottom: 4 }}>
                备注（会写进记录的「结论」）
              </div>
              <Input.TextArea
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="如：失败都是环境超时，已确认与本次改动无关"
              />
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              报告目录：<span className="mono">{dir}</span>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}