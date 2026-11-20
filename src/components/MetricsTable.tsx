import React from 'react';

type Props = {
  /** 记录数据（runs 的 data） */
  data: any;
};

/**
 * 压测指标表格。
 *
 * 把「并发 / 时长 / TPS / P90 / P95 / P99 / 错误率 / 样本数」聚合成一张表，
 * 比一行一个字段紧凑得多（8 个字段 = 8 行，表格只要 4 行）。
 *
 * 接口测试用「通过 / 失败」两个字段，也走这个组件（自动判断）。
 */
export default function MetricsTable({ data }: Props) {
  const isPerf = data.kind === 'perf';

  const rows: { label: string; value: React.ReactNode }[] = [];

  if (isPerf) {
    if (data.concurrency !== undefined && data.concurrency !== '') {
      rows.push({ label: '并发', value: String(data.concurrency) });
    }
    if (data.duration) rows.push({ label: '时长', value: String(data.duration) });
    if (data.tps !== undefined && data.tps !== '') {
      rows.push({ label: 'TPS / 吞吐', value: String(data.tps) });
    }
    // 分位三个放一行
    const pct = [];
    if (data.p90 !== undefined && data.p90 !== '') pct.push(`P90 ${data.p90}ms`);
    if (data.p95 !== undefined && data.p95 !== '') pct.push(`P95 ${data.p95}ms`);
    if (data.p99 !== undefined && data.p99 !== '') pct.push(`P99 ${data.p99}ms`);
    if (pct.length) rows.push({ label: '分位', value: pct.join(' · ') });

    if (data.errRate !== undefined && data.errRate !== '') {
      const n = Number(data.errRate);
      rows.push({
        label: '错误率',
        value: (
          <span style={{ color: n > 0 ? '#e5534b' : '#2e9e5b' }}>
            {n}%
          </span>
        )
      });
    }
    if (data.samples !== undefined && data.samples !== '') {
      rows.push({ label: '样本数', value: String(data.samples) });
    }
  } else {
    // 接口测试
    if (data.passCount !== undefined && data.passCount !== '') {
      rows.push({ label: '通过', value: <span style={{ color: '#2e9e5b' }}>{String(data.passCount)}</span> });
    }
    if (data.failCount !== undefined && data.failCount !== '') {
      const n = Number(data.failCount);
      rows.push({
        label: '失败',
        value: <span style={{ color: n > 0 ? '#e5534b' : '#2e9e5b' }}>{String(data.failCount)}</span>
      });
    }
  }

  if (!rows.length) return <span className="muted">—</span>;

  return (
    <table className="jmx-table metrics-table">
      <thead>
        <tr>
          <th style={{ width: '34%' }}>指标</th>
          <th>值</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="muted">{r.label}</td>
            <td className="mono">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
