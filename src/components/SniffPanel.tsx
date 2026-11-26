import React from 'react';
import { Button, Select, Tag, Tooltip } from 'antd';
import {
  AimOutlined,
  CloseOutlined,
  PauseCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  RightOutlined,
  StepForwardOutlined,
  StopOutlined
} from '@ant-design/icons';

/**
 * 页面元素「实时校验」面板。
 *
 * ============================================================
 * 产品口径（用户 2026-11-25 定死的，别改）
 * ============================================================
 * 这个面板**只报事实**：
 *   「已在页面上高亮：xxx」「匹配到 3 个，框的是第 1 个」「当前没找到这个元素」
 *   「元素当前不可见（虚线红框）」「元素在 iframe 里，这一版不高亮」
 *   「元素在 shadow DOM 里，这一版不高亮」
 * 一个字都不许说「成功 / 失败 / 正确 / 通过」——
 * 定位器对不对是人的判断，工具只负责把页面上发生了什么原样说出来。
 *
 * ============================================================
 * 进度不进台账
 * ============================================================
 * 「第 i / N 个」这类进度只活在这个组件的内存里：
 * 不保存记录、不调 saveRecord、不写回 elements 字段。
 * 关掉面板 = 这一轮结束。
 *
 * 样式全部内联：styles.css 在别的 agent 手上，不碰（免得两边改同一处）。
 */

/** 会话处在哪一步（和台账无关） */
export type SniffPhase = 'idle' | 'starting' | 'ready' | 'ended';

/** 一句话事实 + 色调（ok 只是「有东西被框出来了」，不是「成功」） */
export type SniffFacts = { lines: string[]; tone: 'ok' | 'warn' | 'muted' };

export type SniffTarget = { name: string; mode: string; selector: string };

/**
 * 校验用哪个浏览器（v0.56，bugC）。
 *
 *   auto   —— 跟随系统默认浏览器（后端自己判断，用户默认 Chrome 就拉 Chrome）
 *   edge   —— 强制 Edge
 *   chrome —— 强制 Chrome
 *
 * 这三项要和后端 `{ browser: 'auto'|'edge'|'chrome' }` 的入参完全一致，别自己加值。
 */
export type SniffBrowser = 'auto' | 'edge' | 'chrome';

/** 下拉选项：顺序固定「跟随系统 → Edge → Chrome」，默认值永远是 auto */
export const SNIFF_BROWSER_OPTIONS: { value: SniffBrowser; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'edge', label: 'Edge' },
  { value: 'chrome', label: 'Chrome' }
];

export type SniffPanelProps = {
  /** 状态机当前阶段 */
  phase: SniffPhase;
  /** 正在等后端回包 */
  busy: boolean;
  /** 后端最近一次的返回体（统一契约），没有就 null */
  resp: any;
  /** ok:false 时的 message 原文（照抄，不改写） */
  error: string;
  /** 是否「按顺序校验」模式 */
  sequential: boolean;
  /** 顺序模式下的第几个（1 起） */
  index: number;
  /** 顺序模式下的总行数 */
  total: number;
  currentName: string;
  currentModeLabel: string;
  currentSelector: string;
  /** 这一轮被跳过的元素名（只在内存里） */
  skipped: string[];
  /** 当前记录的页面地址 */
  url: string;
  /** 用户选的浏览器（auto / edge / chrome）；受控值，由调用方存 localStorage */
  browser: SniffBrowser;
  /** 切换浏览器；会话已存在时调用方会给 browserNotice，本组件只负责显示 */
  onBrowserChange: (b: SniffBrowser) => void;
  /** 「已切换，重新点校验生效」这类提示（可为空） */
  browserNotice?: string;
  onClose: () => void;
  onHighlight: () => void;
  onReopen: () => void;
  onStopBrowser: () => void;
  onNext: () => void;
  onRepeat: () => void;
  onSkip: () => void;
  onStopSeq: () => void;
  onRestart: () => void;
};

/**
 * 把后端返回的「事实」翻成面板文案。
 *
 * 优先级（从「根本没法高亮」到「框出来了」）：
 *   shadow DOM → iframe → 没找到 → 高亮了（1 个 / 多个）
 * 「元素当前不可见」是**附加**事实：能框出来但看不到，两句话一起说。
 *
 * 纯函数，方便在 node 里直接断言文案（别在 JSX 里现拼字符串）。
 */
export function describeResult(res: any): SniffFacts {
  if (!res || typeof res !== 'object') return { lines: [], tone: 'muted' };

  const found = Number(res.found || 0);
  const name = String(res.name || '');

  if (String(res.reason || '') === 'shadow-dom') {
    return { lines: ['元素在 shadow DOM 里，这一版不高亮'], tone: 'warn' };
  }
  if (res.inIframe) {
    return { lines: ['元素在 iframe 里，这一版不高亮'], tone: 'warn' };
  }
  if (!found) {
    return { lines: ['当前没找到这个元素'], tone: 'warn' };
  }

  const lines = [found === 1 ? '已在页面上高亮：' + name : '匹配到 ' + found + ' 个，框的是第 1 个'];
  // 严格比 false：status 之类的返回里没有 visible 字段，别当成「不可见」
  if (res.visible === false) lines.push('元素当前不可见（虚线红框）');
  return { lines, tone: 'ok' };
}

/** 状态机的四句话（用户指定的措辞） */
export function phaseLabel(phase: SniffPhase): string {
  if (phase === 'starting') return '正在启动浏览器…';
  if (phase === 'ready') return '已就绪';
  if (phase === 'ended') return '会话已结束，可重新开始';
  return '未启动';
}

/** 用的是哪个浏览器（后端只回 edge / chrome） */
export function browserLabel(browser: any): string {
  const b = String(browser || '').toLowerCase();
  if (b === 'edge') return 'Edge';
  if (b === 'chrome') return 'Chrome';
  return '';
}

const CARD: React.CSSProperties = {
  position: 'fixed',
  right: 24,
  bottom: 24,
  width: 380,
  maxWidth: 'calc(100vw - 48px)',
  zIndex: 1200,
  background: '#fff',
  border: '1px solid #d9d9d9',
  borderRadius: 10,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
  padding: '10px 12px 12px',
  fontSize: 12
};
const HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 4
};
const TARGET: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--text-2)',
  wordBreak: 'break-all'
};
const FACT: React.CSSProperties = {
  fontSize: 13,
  lineHeight: '20px',
  fontWeight: 600,
  marginTop: 6
};
const ERROR: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  marginTop: 6,
  color: '#cf1322',
  wordBreak: 'break-all'
};
const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  marginTop: 8
};
const MUTED: React.CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--text-3)' };

/**
 * 面板本体：纯展示 + 回调，所有状态由 PageElementsEditor 持有。
 * 这样「进度只存组件内存」这件事只有一个源头。
 */
export default function SniffPanel(props: SniffPanelProps) {
  const {
    phase,
    busy,
    resp,
    error,
    sequential,
    index,
    total,
    currentName,
    currentModeLabel,
    currentSelector,
    skipped,
    url,
    // 属性名 browser 和「实际用的是哪个浏览器」重名，解构时改个名，别把两者搞混
    browser: browserChoice,
    browserNotice
  } = props;

  const facts = describeResult(resp);
  /**
   * 实际用的是哪个浏览器：只在「已就绪」时显示 —— 会话结束后窗口已经没了，
   * 再挂个 Chrome 标签等于在说假话。
   * browserChosen 是后端回的「这次按哪个选择起的」（auto 就写明是跟随系统）。
   */
  const actualBrowser = phase === 'ready' ? browserLabel(resp && resp.browser) : '';
  const chosen = String((resp && resp.browserChosen) || '').toLowerCase();
  const browserText = actualBrowser ? actualBrowser + (chosen === 'auto' ? '（跟随系统）' : '') : '';
  const running = phase === 'ready';
  /** 未启动 / 已结束才给「重新开始」（启动中给会误导成“又点了一次”） */
  const canRestart = phase === 'idle' || phase === 'ended';
  const lastOne = sequential && total > 0 && index >= total;

  const phaseColor = running ? 'green' : phase === 'starting' ? 'blue' : phase === 'ended' ? 'orange' : 'default';

  return (
    <div style={CARD} data-sniff-panel="1" role="dialog" aria-label="页面元素实时校验">
      <div style={HEAD}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>元素校验</span>
        <Tag color={phaseColor} style={{ marginInlineEnd: 0 }}>
          {phaseLabel(phase)}
        </Tag>
        {sequential && total > 0 ? (
          <Tag style={{ marginInlineEnd: 0 }}>
            {'第 '}
            {index}
            {' / '}
            {total}
            {' 个'}
          </Tag>
        ) : null}
        {browserText ? (
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
            {browserText}
          </Tag>
        ) : null}
        <span style={{ flex: 1 }} />
        <Tooltip title="关闭面板（这一轮结束，浏览器一并关掉）">
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={props.onClose} aria-label="关闭面板" />
        </Tooltip>
      </div>

      {url ? (
        <div style={MUTED} title={url}>
          {'页面：'}
          {url}
        </div>
      ) : error ? null : (
        <div style={{ ...MUTED, color: '#d46b08' }}>这条记录还没有页面地址（url），校验没有可用入口</div>
      )}

      {currentName ? (
        <div style={TARGET}>
          {'目标：'}
          <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>{currentName}</span>
          {'　'}
          {currentModeLabel ? currentModeLabel + ' · ' : ''}
          {currentSelector || '（定位值为空）'}
        </div>
      ) : null}

      {/*
        浏览器选择（bugC）：默认「跟随系统」，后端按 chrome/edge 落地。
        值永远不是空串（auto / edge / chrome），所以不存在 antd 受控空值吞 placeholder 的坑。
        会话已经起来了也不打断它：换浏览器等于换进程，只提示「重新点校验生效」。
      */}
      <div style={ROW}>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>浏览器</span>
        <Select
          size="small"
          style={{ width: 116 }}
          value={browserChoice}
          options={SNIFF_BROWSER_OPTIONS}
          onChange={(v) => props.onBrowserChange(v as SniffBrowser)}
          disabled={busy && phase === 'starting'}
          aria-label="校验用哪个浏览器"
          popupMatchSelectWidth={false}
        />
        {browserNotice ? (
          <span style={{ fontSize: 11, lineHeight: '16px', color: '#d46b08' }}>{browserNotice}</span>
        ) : null}
      </div>

      {phase === 'starting' ? <div style={{ ...FACT, fontWeight: 400 }}>正在启动浏览器，稍等…</div> : null}

      {error ? (
        <div style={ERROR} role="alert">
          {error}
        </div>
      ) : null}

      {/*
        事实只在「已就绪」时展示。
        会话已经结束（running:false）时，后端回包里的 found 不是这一次的结论，
        摆出来会被读成「当前没找到这个元素」——那就不是事实了，宁可不显示。
      */}
      {!error && phase === 'ready' && facts.lines.length ? (
        <div style={{ ...FACT, color: facts.tone === 'ok' ? '#1f1f1f' : '#ad6800' }}>
          {facts.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}

      {sequential && skipped.length ? <div style={MUTED}>{'已跳过：' + skipped.join('、')}</div> : null}

      {sequential && lastOne && running ? <div style={MUTED}>已是最后一行</div> : null}

      {running ? (
        <>
          <div style={ROW}>
            <Button size="small" icon={<AimOutlined />} loading={busy} onClick={props.onHighlight}>
              重新高亮
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={props.onReopen}>
              重新打开页面
            </Button>
          </div>
          {sequential ? (
            <div style={ROW}>
              <Button
                size="small"
                type="primary"
                ghost
                icon={<RightOutlined />}
                loading={busy}
                disabled={lastOne}
                onClick={props.onNext}
              >
                下一个
              </Button>
              <Button size="small" icon={<RedoOutlined />} loading={busy} disabled={!currentName} onClick={props.onRepeat}>
                重复当前
              </Button>
              <Button size="small" icon={<StepForwardOutlined />} disabled={lastOne} onClick={props.onSkip}>
                跳过
              </Button>
              <Button size="small" icon={<PauseCircleOutlined />} onClick={props.onStopSeq}>
                停止
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {/*
        bugA：「结束校验」在**任何阶段**都要在（启动中除外 —— 正在拉进程时点它容易留下半截会话）。
        未启动 / 出错 / 会话已结束时浏览器可能还在后台跑，这里是没有面板控制入口前唯一的关闭按钮。
        调用方（PageElementsEditor / DetailElementSniff）都保证点了会先 sniffStop 再收面板。

        v0.57 布局：按钮单独钉在**右下角**，左边的说明文字用 flex:1 + minWidth:0 自己换行/省略，
        不会因为底部文字变长把按钮挤走（全屏/非全屏、窄抽屉都成立）。
      */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 6 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {canRestart ? (
            <div>
              <Button size="small" type="primary" loading={busy} disabled={busy} onClick={props.onRestart}>
                重新开始
              </Button>
            </div>
          ) : null}
          <div style={{ ...MUTED, fontSize: 11, lineHeight: '15px' }}>
            进度只在界面内存里，关掉面板即结束，不会写进台账
          </div>
        </div>
        <div style={{ flexShrink: 0, marginLeft: 'auto' }}>
          <Tooltip title="关掉这次拉起的浏览器进程，并收起这个面板">
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              onClick={props.onStopBrowser}
              disabled={busy && phase === 'starting'}
            >
              结束校验
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}