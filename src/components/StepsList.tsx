import React from 'react';

/**
 * Allure 测试步骤列表。
 *
 * 数据来自后端 electron/allure.js 的 parseAllureDir：
 *   steps          —— 递归解析好的步骤树（steps 里还有 steps）
 *   stepSummary    —— 整棵树的统计，前端直接用，不再自己数
 *   firstFailedStep—— 第一个失败/异常步骤的名字，用来「一眼定位」
 *
 * 展示优先级：失败/异常步骤要抢眼（红色左条 + 加粗 + 红字），
 * 通过的步骤收敛成灰色，别让 30 个 ✅ 把那条 ❌ 淹没。
 */

/** 一个步骤节点（与后端 parseStep 的输出一一对应） */
export type AllureStep = {
  name: string;
  status: string;
  /** 这一层自己的耗时（毫秒，缺 start/stop 时后端给 0） */
  duration: number;
  /** 递归子步骤 */
  steps: AllureStep[];
  /** 这一步的附件（断言常把实际响应贴在这一步上） */
  attachments: StepAttachment[];
};

export type StepAttachment = {
  name: string;
  source: string;
  type: string;
};

/** 步骤统计 */
export type StepSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  broken: number;
};

type Props = {
  steps?: AllureStep[] | null;
  summary?: StepSummary | null;
  /** 后端算好的首个失败步骤名（列表里也用它，这里做二次强调） */
  firstFailedStep?: string;
  /** 步骤树被截断了吗（超大步骤树，后端最多留 200 个节点） */
  truncated?: boolean;
  truncatedReason?: string;
};

/** 步骤状态 → 符号 / 颜色 / 是否要醒目 */
const stepMeta = (s: string) => {
  if (s === 'failed') {
    return { mark: '❌', color: '#c9372f', bg: '#fff5f5', bar: '#e5534b', loud: true };
  }
  if (s === 'broken') {
    return { mark: '⚠️', color: '#a8690a', bg: '#fffaf0', bar: '#f5a623', loud: true };
  }
  if (s === 'skipped') {
    return { mark: '⏭️', color: '#8a90a2', bg: 'transparent', bar: 'transparent', loud: false };
  }
  // 通过：灰一点，不抢焦点
  if (s === 'passed' || !s) {
    return { mark: '✅', color: '#7d8497', bg: 'transparent', bar: 'transparent', loud: false };
  }
  // 报告里状态缺失/认不出来的步骤：不确定就别画成「通过」
  return { mark: '❔', color: '#8a90a2', bg: 'transparent', bar: 'transparent', loud: false };
};

/** 毫秒 → 120ms / 1.3s（步骤耗时都很短，不做分钟级） */
const fmtStepMs = (n: number) => {
  const ms = Number(n);
  if (!ms || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/** 递归找第一个失败/异常节点（先序，和法后端一致） */
const findFirstFailed = (list: AllureStep[]): AllureStep | null => {
  for (const st of list || []) {
    if (!st) continue;
    if (st.status === 'failed' || st.status === 'broken') return st;
    const kid = findFirstFailed(st.steps || []);
    if (kid) return kid;
  }
  return null;
};

/** 后端没给 stepSummary 时的兜底统计（保证标题行的数字不会变成空） */
const countSteps = (list: AllureStep[]): StepSummary => {
  const s: StepSummary = { total: 0, passed: 0, failed: 0, skipped: 0, broken: 0 };
  const walk = (arr: AllureStep[]) => {
    for (const st of arr || []) {
      if (!st) continue;
      s.total++;
      if (st.status === 'passed') s.passed++;
      else if (st.status === 'failed') s.failed++;
      else if (st.status === 'skipped') s.skipped++;
      else if (st.status === 'broken') s.broken++;
      walk(st.steps || []);
    }
  };
  walk(list);
  return s;
};

/** 单个步骤 + 它的子步骤（递归；缩进按层级递增） */
function StepNode({ step, depth, target }: { step: AllureStep; depth: number; target: AllureStep | null }) {
  const m = stepMeta(step.status);
  const here = target === step;
  const indent = 8 + depth * 18;
  const slow = step.duration > 1000;

  return (
    <>
      <div
        className={'allure-step-row' + (here ? ' is-failed' : '')}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          padding: '3px 10px 3px ' + indent + 'px',
          borderLeft: '3px solid ' + m.bar,
          background: m.bg,
          color: m.color,
          fontSize: 12.5,
          fontWeight: m.loud ? 600 : 400,
          lineHeight: 1.75
        }}
      >
        <span className="allure-step-mark" style={{ flex: '0 0 auto' }}>
          {m.mark}
        </span>
        <span
          className="allure-step-name"
          style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all' }}
          title={step.name}
        >
          {step.name || '(未命名步骤)'}
        </span>
        {here ? (
          <span
            className="allure-step-here"
            style={{ flex: '0 0 auto', fontSize: 11.5, color: '#c9372f', fontWeight: 600 }}
          >
            ← 挂在这里
          </span>
        ) : null}
        <span
          className="allure-step-dur"
          style={{
            flex: '0 0 auto',
            fontSize: 11.5,
            color: slow ? '#f5a623' : '#a3a9ba',
            fontWeight: slow ? 600 : 400
          }}
          title={'耗时 ' + fmtStepMs(step.duration)}
        >
          {fmtStepMs(step.duration)}
        </span>
      </div>

      {/* 有附件的步骤：附件名缩进挂在步骤下面（附件的实体文件在 source 里） */}
      {(step.attachments || []).map((a, i) => (
        <div
          key={'att' + i}
          className="allure-step-attachment"
          style={{ paddingLeft: indent + 22, fontSize: 11.5, color: '#8a90a2', lineHeight: 1.8 }}
          title={a.source || ''}
        >
          └─ 附件：{a.name || a.source || '(未命名附件)'}
        </div>
      ))}

      {(step.steps || []).map((kid, i) => (
        <StepNode key={i} step={kid} depth={depth + 1} target={target} />
      ))}
    </>
  );
}

export default function StepsList({ steps, summary, firstFailedStep, truncated, truncatedReason }: Props) {
  const list = Array.isArray(steps) ? steps : [];

  // 没有步骤：只给一句兜底，**不渲染空列表头**
  if (!list.length) {
    return (
      <div className="allure-steps-empty" style={{ padding: '6px 0', fontSize: 12.5, color: '#8a90a2' }}>
        这个用例没有记录步骤
      </div>
    );
  }

  const s = summary || countSteps(list);
  const total = s.total || countSteps(list).total;
  const target = findFirstFailed(list);

  return (
    <div className="allure-steps" style={{ margin: '6px 0 2px' }}>
      <div className="allure-steps-head" style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span className="allure-steps-title" style={{ fontSize: 12.5, fontWeight: 600, color: '#3a4055' }}>
          测试步骤
        </span>
        <span className="allure-steps-count" style={{ fontSize: 12, color: '#8a90a2' }}>
          （{total} 个
          {s.failed ? '，' + s.failed + ' 个失败' : ''}
          {s.broken ? '，' + s.broken + ' 个异常' : ''}）
        </span>
        {firstFailedStep ? (
          <span className="allure-steps-first" style={{ fontSize: 11.5, color: '#c9372f' }}>
            首个失败：{firstFailedStep}
          </span>
        ) : null}
        {truncated ? (
          <span className="allure-steps-truncated-tag" style={{ fontSize: 11.5, color: '#a8690a' }}>
            步骤已截断
          </span>
        ) : null}
      </div>

      <div
        className="allure-steps-body"
        style={{ border: '1px solid #eceef5', borderRadius: 6, background: '#fcfcfe', padding: '4px 0' }}
      >
        {list.map((st, i) => (
          <StepNode key={i} step={st} depth={0} target={target} />
        ))}
      </div>

      {truncated && truncatedReason ? (
        <div className="allure-steps-truncated" style={{ fontSize: 11.5, color: '#a8690a', paddingTop: 4 }}>
          {truncatedReason}
        </div>
      ) : null}
    </div>
  );
}