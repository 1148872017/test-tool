'use strict';

/**
 * 测试执行（接口测试 / 压测）的展示逻辑，纯函数，node 里直接测。
 *
 * 数据落在 runs 集合里，一条 = 一次跑批。这里只做三件事：
 * 1. 这个字段在这一类执行里该不该显示（onlyFor）
 * 2. 一次执行压成一行摘要（接口详情里空间小，只能放一行）
 * 3. 某个接口最近跑过哪几次
 */

/** 字段是否适用于当前类型（没写 onlyFor 的字段一律显示） */
function matchOnlyFor(field, kind) {
  if (!field || !field.onlyFor) return true;
  const want = field.onlyFor.kind;
  if (!want) return true;
  return String(kind || '') === String(want);
}

/** 只留当前类型该显示的字段 */
function visibleFields(fields, kind) {
  return (Array.isArray(fields) ? fields : []).filter((f) => matchOnlyFor(f, kind));
}

function num(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 一次执行 → 一行摘要。
 * 接口测试：12 通过 / 1 失败
 * 压测：10 并发 · 60s · 320 TPS · P95 180ms · 错 0.2%
 * 缺的指标跳过，不硬凑「—」，宁短不长。
 */
function runLine(data) {
  const d = data || {};
  const parts = [];
  if (String(d.kind || 'api') === 'perf') {
    const c = num(d.concurrency);
    if (c !== null) parts.push(c + ' 并发');
    if (d.duration) parts.push(String(d.duration));
    const tps = num(d.tps);
    if (tps !== null) parts.push(tps + ' TPS');
    const p95 = num(d.p95);
    if (p95 !== null) parts.push('P95 ' + p95 + 'ms');
    const err = num(d.errRate);
    if (err !== null) parts.push('错 ' + err + '%');  } else {
    const pass = num(d.passCount);
    const fail = num(d.failCount);
    if (pass !== null) parts.push(pass + ' 通过');
    if (fail !== null) parts.push(fail + ' 失败');
  }
  return parts.join(' · ');
}

/** 结果 → 颜色（绿 / 红 / 灰），列表小圆点用 */
function resultTone(result) {
  if (result === 'ok') return 'green';
  if (result === 'bad') return 'red';
  return 'default';
}

/**
 * 某个接口最近跑过的执行（新的在前）。
 * 时间优先取 ranAt，没填就退回记录更新时间，免得手填漏了就排到最后。
 */
function recentForApi(runs, apiId, limit) {
  const max = num(limit) === null ? 3 : num(limit);
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r && r.data && apiId && r.data.apiRef === apiId);
  list.sort((a, b) => {
    const ta = num(a.data.ranAt) || a.updated_at || 0;
    const tb = num(b.data.ranAt) || b.updated_at || 0;
    return tb - ta;
  });
  return list.slice(0, max);
}

module.exports = { matchOnlyFor, visibleFields, runLine, resultTone, recentForApi };