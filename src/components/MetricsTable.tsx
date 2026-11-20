import React from 'react';

type Props = {
  /** 记录数据（runs 的 data） */
  data: any;
};

/**
 * 压测指标表格（横向 2 行 N 列）。
 *
 * 第一行是指标名，第二行是值——比纵向「一行一个指标」紧凑得多，
 * 8 个指标一行就能看完，像压测报告的摘要。
 *
 * 接口测试用「通过 / 失败」两个字段，也走这个组件（自动判断）。
 */
export default function MetricsTable({ data }: Props) {
  const isPerf = data.kind === 'perf';

  const cols: { label: string; value: React.ReactNode }[] = [];

  if (isPerf) {
    if (data.concurrency !== undefined && data.concurrency !== '') {
      cols.push({ label: '并发', value: String(data.concurrency) });
    }
    if (data.duration) cols.push({ label: '时长', value: String(data.duration) });
    if (data.tps !== undefined && data.tps !== '') {
      cols.push({ label: 'TPS / 吞吐', value: String(data.tps) });
    }
    if (data.p90 !== undefined && data.p90 !== '') {
      cols.push({ label: 'P90 (ms)', value: String(data.p90) });
    }
    if (data.p95 !== undefined && data.p95 !== '') {
      cols.push({ label: 'P95 (ms)', value: String(data.p95) });
    }
    if (data.p99 !== undefined && data.p99 !== '') {
      cols.push({ label: 'P99 (ms)', value: String(data.p99) });
    }
    if (data.errRate !== undefined && data.errRate !== '') {
      const n = Number(data.errRate);
      cols.push({
        label: '错误率',
        value: <span style={{ color: n > 0 ? '#e5534b' : '#2e9e5b' }}>{n}%</span>
      });
    }
    if (data.samples !== undefined && data.samples !== '') {
      cols.push({ label: '样本数', value: String(data.samples) });
    }
  } else {
    if (data.passCount !== undefined && data.passCount !== '') {
      cols.push({ label: '通过', value: <span style={{ color: '#2e9e5b' }}>{String(data.passCount)}</span> });
    }
    if (data.failCount !== undefined && data.failCount !== '') {
      const n = Number(data.failCount);
      cols.push({
        label: '失败',
        value: <span style={{ color: n > 0 ? '#e5534b' : '#2e9e5b' }}>{String(data.failCount)}</span>
      });
    }
  }

  if (!cols.length) return <span className="muted">—</span>;

  return (
    <table className="jmx-table metrics-table">
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          {cols.map((c, i) => (
            <td key={i} className="mono">
              {c.value}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
