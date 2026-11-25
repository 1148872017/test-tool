import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Space, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { LOCATOR_MODES, previewLocatorCode } from '../../shared/locatorModes';
import api from '../api';
import SniffPanel, { type SniffPhase, type SniffTarget } from './SniffPanel';

/**
 * 定位方式。
 *
 * css 是缺省值：老记录的 elements 里没有 mode 字段，一律当 css（不做「/ 开头就是 xpath」那种推断）。
 * 其余 8 种是 Playwright 1.27+ 的语义化定位，抗 DOM 结构变化，比 CSS 稳。
 */
export type LocatorMode =
  | 'css'
  | 'xpath'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'alttext'
  | 'title'
  | 'testid';

/** 一个页面元素 */
export type PageElement = {
  name: string;
  /** 定位方式，缺省 = 'css' */
  mode?: LocatorMode;
  selector: string;
  desc: string;
};

/** 下拉显示名（顺序由 shared/locatorModes.js 的 LOCATOR_MODES 决定） */
const MODE_LABEL: Record<string, string> = {
  css: 'CSS 选择器',
  xpath: 'XPath',
  role: 'Role（角色）',
  label: 'Label（表单标签）',
  placeholder: 'Placeholder（占位文字）',
  text: 'Text（可见文本）',
  alttext: 'AltText（图片描述）',
  title: 'Title（title 属性）',
  testid: 'TestId（data-testid）'
};

/**
 * 「定位方式」下拉选项。
 *
 * 顺序是产品硬要求：CSS 第一（老数据默认值），TestId 最后
 * （实战里前端页面写 data-testid 的太少）。
 * 这里不自己排顺序，直接跟着 LOCATOR_MODES 走，避免两处漂移。
 */
export const LOCATOR_MODE_OPTIONS: { value: LocatorMode; label: string }[] = LOCATOR_MODES.map((m) => ({
  value: m as LocatorMode,
  label: MODE_LABEL[m] || m
}));

/** 每种定位方式的「定位值」填法（placeholder） */
export const LOCATOR_MODE_PLACEHOLDER: Record<LocatorMode, string> = {
  css: '#username 或 .btn-primary',
  // 提示用户别写 xpath=，生成时会自动补
  xpath: '//div[@id="x"]',
  role: 'button:登录（角色:可访问名称）',
  label: '用户名',
  placeholder: '请输入密码',
  text: '提交',
  alttext: 'logo',
  title: '提示文字',
  testid: 'submit'
};

/** 定位方式兜底：没填 / 认不出的脏值一律 css */
export function normalizeMode(mode: any): LocatorMode {
  const v = String(mode === undefined || mode === null ? '' : mode)
    .trim()
    .toLowerCase();
  return LOCATOR_MODES.indexOf(v) >= 0 ? (v as LocatorMode) : 'css';
}

/**
 * 这个定位值看起来像 XPath 吗？（以 / 或 // 开头）
 *
 * 只用来给一条橙色提示，**绝不自动改**用户的定位方式 ——
 * 提示是建议，改不改由用户自己决定（有人的 CSS 选择器里确实会带奇怪的写法）。
 */
export function looksLikeXPath(selector: any): boolean {
  const s = String(selector === undefined || selector === null ? '' : selector).trim();
  return s.startsWith('/');
}

/**
 * 解析 elements 字段。
 *
 * 兼容两种格式：
 *   1. JSON 数组：[{"name":"usernameInput","selector":"#username","desc":"用户名"}]
 *      （带定位方式时才有 mode 字段，css 是缺省值不写进 JSON）
 *   2. 多行文本（旧格式）：usernameInput = #username
 * 空行和残缺行直接跳过，不报错。
 */
export function parseElements(raw: any): PageElement[] {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return [];

  // 先试 JSON
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({
            name: String(x.name || '').trim(),
            // 老记录没有 mode → css（不推断）
            mode: normalizeMode(x.mode),
            selector: String(x.selector || '').trim(),
            desc: String(x.desc || '').trim()
          }));
      }
    } catch (e) {
      /* 落到文本解析 */
    }
  }

  // 文本格式：每行 "name = selector"（等号也支持中文冒号 / 冒号）
  const out: PageElement[] = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out.push({
      name: t.slice(0, i).trim(),
      mode: 'css',
      selector: t.slice(i + 1).trim(),
      desc: ''
    });
  }
  return out;
}

/** 序列化成 JSON（保存用） */
export function serializeElements(list: PageElement[]): string {
  const clean = list
    .filter((x) => String(x.name || '').trim())
    .map((x) => {
      const mode = normalizeMode(x.mode);
      const row: any = { name: String(x.name).trim() };
      // css 是缺省值：不写进 JSON，老记录和新记录格式保持一致，一眼看不出差别
      if (mode !== 'css') row.mode = mode;
      row.selector = String(x.selector || '').trim();
      row.desc = String(x.desc || '').trim();
      return row;
    });
  if (!clean.length) return '';
  return JSON.stringify(clean);
}

/** 保存前丢掉完全空的行（编辑路径不过滤，保存时才过滤） */
export function dropEmptyElements(raw: any): string {
  return serializeElements(parseElements(raw));
}

/** 一行空白草稿（新增记录时至少给一行可填） */
export function blankRow(): PageElement {
  return { name: '', selector: '', desc: '' };
}

/**
 * 外部 value → 编辑行。
 *
 * 抽成纯函数有两个原因：
 *   1. 组件里要「首次挂载」和「外部值变化」都用它，逻辑只留一份；
 *   2. 可以在 node 里直接单测（这条正是会丢数据的那条路径）。
 *
 * 空值兜底一行空行：新增记录时表格不能是空的。
 */
export function initialRows(value: any): PageElement[] {
  const parsed = parseElements(value);
  return parsed.length ? parsed : [blankRow()];
}

/**
 * 外部 value 要不要回填到表格？
 *
 * 自己 commit 出去的值会被父组件原样传回来（受控组件的回声），
 * 这种回声不能回填，否则刚输入的内容会被旧值冲掉、光标也会跳。
 */
export function shouldAdoptIncoming(incoming: any, lastEmitted: string): boolean {
  const s = String(incoming === undefined || incoming === null ? '' : incoming);
  return s !== lastEmitted;
}

/** 预览行 / 提示行的统一样式（不用改 styles.css，就地内联，避免和别人的样式改动打架） */
const PREVIEW_STYLE: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '15px',
  marginTop: 2,
  color: 'var(--text-3)',
  wordBreak: 'break-all'
};
const XPATH_HINT_STYLE: React.CSSProperties = {
  fontSize: 11,
  lineHeight: '15px',
  marginTop: 2,
  // antd 的 orange-7，白底对比度 4.6:1，比 #fa8c16 看得清
  color: '#d46b08'
};

/** 顶部工具条（「按顺序校验」）的排版；样式内联，不动 styles.css */
const SNIFF_BAR_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 6
};

/**
 * 实时校验的会话状态。
 *
 * **只活在组件内存里**：不写回 elements、不 saveRecord、不改台账。
 * 关掉面板或者组件卸载（关表单）这一轮就结束 —— 这是产品口径，
 * 不要「顺手」把它持久化，否则下一轮会看到上次的残留进度。
 */
type SniffSession = {
  open: boolean;
  phase: SniffPhase;
  busy: boolean;
  /** 后端最近一次的统一返回体（面板只照它说事实） */
  resp: any;
  /** ok:false 时的 message 原文 */
  error: string;
  /** true = 「按顺序校验」这一轮 */
  seq: boolean;
  /** 当前盯着的元素 */
  target: SniffTarget | null;
  /** 顺序模式下的第几个（1 起） */
  index: number;
  total: number;
  /** 这一轮跳过的元素名（内存里，用于结束时给个交代） */
  skipped: string[];
};

const SNIFF_IDLE: SniffSession = {
  open: false,
  phase: 'idle',
  busy: false,
  resp: null,
  error: '',
  seq: false,
  target: null,
  index: 0,
  total: 0,
  skipped: []
};

/**
 * 统一返回体 → 面板该处在哪个状态。规则只写这一处（纯函数，好断言）：
 *
 *   ok:false 且浏览器没跑（启动失败：找不到浏览器 / url 不是 http(s)、预览模式不支持）
 *     → 未启动 + message 原文；
 *   ok:false 但浏览器还在跑（比如这一次高亮没成功）
 *     → 保持已就绪 + message 原文；
 *   ok:true 且 running:false（用户把浏览器窗口关了 / 重启了应用）
 *     → 会话已结束，可重新开始；
 *   其余 → 已就绪。
 *
 * 注意这里**不改写 message**：后端说什么就显示什么。
 */
export function settleSniff(res: any, prev: SniffPhase): { phase: SniffPhase; resp: any; error: string } {
  const r = res && typeof res === 'object' ? res : {};
  const failed = r.ok === false;
  const running = !!r.running;
  const message = failed ? String(r.message || '（后端没有给出原因）') : '';

  if (failed) {
    if (running) return { phase: prev === 'starting' ? 'ready' : prev === 'idle' ? 'idle' : 'ready', resp: r, error: message };
    // 起不来就是没起来；高亮阶段回来说「没在跑」说明窗口已经被关了
    return { phase: prev === 'starting' || prev === 'idle' ? 'idle' : 'ended', resp: r, error: message };
  }
  if (!running) return { phase: prev === 'starting' ? 'idle' : 'ended', resp: r, error: '' };
  return { phase: 'ready', resp: r, error: '' };
}

type Props = {
  value: any;
  onChange: (next: string) => void;
  placeholder?: string;
  /**
   * 当前记录的页面地址（页面记录里的 url 字段）。
   * 实时校验要用它起浏览器；没传就说明调用方没接进来，面板会明说「还没有页面地址」。
   */
  pageUrl?: string;
};

/**
 * 页面元素编辑器：表格形式维护「名称 + 定位方式 + 定位值 + 说明」。
 *
 * 规划要求「在平台里**可视化**维护页面元素名称和定位器」，
 * 所以不能用 textarea 让用户手写，得是表格。
 */
export default function PageElementsEditor({ value, onChange, placeholder, pageUrl }: Props) {
  /**
   * 内部维护草稿，避免「边输边序列化」导致光标跳动。
   * 每次改动：更新草稿 + 通知上层（序列化后的字符串）。
   *
   * 坑（Bug A，会丢数据）：
   *   编辑已有记录时，elements 字段是**异步**加载的 —— 组件首次挂载时 value 还是空串。
   *   旧实现用 `useMemo(() => parseElements(value), [])` + `useState(initial)` 只取一次，
   *   于是外部值到达后表格仍是那一行空行；用户一保存，serializeElements 过滤空行 → 空串 → 库里被清空。
   *
   * 现在：惰性初始化（首帧 value 已有值就直接用）+ useEffect 在外部值变化时回填，
   * 并用 lastEmitted 忽略「自己刚发出去的那个值」的回声。
   */
  const [rows, setRows] = useState<PageElement[]>(() => initialRows(value));

  /** 当前聚焦的「定位值」行（-1 = 没聚焦）。只影响预览行显不显示 */
  const [focusRow, setFocusRow] = useState<number>(-1);

  /** 最近一次自己 commit 出去的字符串，用来识别父组件的回声 */
  const lastEmitted = useRef<string>('');

  /* ============================================================
   * 实时校验（sniff:start / sniff:highlight / sniff:reopen / sniff:stop）
   *
   * 五个通道的统一返回体：
   *   { ok, running, browser:'edge'|'chrome', url, name, mode, selector,
   *     found, total, visible, inIframe, reason:'not-found'|'in-iframe'|'shadow-dom'|'', message }
   *
   * 面板只报事实（「已在页面上高亮：xxx」「当前没找到这个元素」…），
   * 不说成功/失败 —— 判断权在人的眼睛上。
   * ============================================================ */
  const [sniff, setSniff] = useState<SniffSession>(() => SNIFF_IDLE);

  /** 卸载时要不要顺手关浏览器：面板开着就说明这一轮还没收尾 */
  const sniffOpen = useRef<boolean>(false);

  useEffect(() => {
    sniffOpen.current = sniff.open;
  }, [sniff.open]);

  const patchSniff = (patch: Partial<SniffSession>) => {
    setSniff((prev) => Object.assign({}, prev, patch));
  };

  /**
   * 统一调用入口：后端契约是「永远 resolve 一个统一返回体」。
   * 万一通道不存在 / 主进程抛错，这里也折成同形状的 { ok:false, message }，
   * 面板就不会因为一个 TypeError 白屏。
   */
  const request = async (method: string, payload?: any): Promise<any> => {
    try {
      const fn = (api as any)[method];
      if (typeof fn !== 'function') return { ok: false, message: '当前环境没有 ' + method + '（浏览器预览不支持实时校验）' };
      const raw = await fn(payload);
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e: any) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  };

  /** 拿回包后统一落状态（用函数式更新，免得 await 期间面板已经切到别的阶段） */
  const applyResponse = (res: any, extra?: Partial<SniffSession>) => {
    setSniff((prev) => Object.assign({}, prev, { busy: false }, extra || {}, settleSniff(res, prev.phase)));
  };

  /**
   * 「这一页的元素行」= 有名字的行（和保存口径一致：serializeElements 也是按名字过滤）。
   * 每次点击都重新算：用户可能正在改名字/加行，进度不该跟错位。
   */
  const sniffQueue = (): SniffTarget[] =>
    rows
      .map((r) => ({
        name: String(r.name || '').trim(),
        mode: normalizeMode(r.mode) as string,
        selector: String(r.selector || '').trim()
      }))
      .filter((x) => x.name);

  /** 起一次校验（单行「▶ 校验」和顺序模式的每一行都走这里） */
  const startAt = async (target: SniffTarget, next: Partial<SniffSession>) => {
    const url = String(pageUrl || '').trim();
    patchSniff(Object.assign({ open: true, target, busy: false, resp: null, error: '' }, next));
    if (!url) {
      patchSniff({ phase: 'idle', error: '这条记录还没有页面地址（url），先填上再校验' });
      return;
    }
    if (!target.name) {
      patchSniff({ phase: 'idle', error: '这一行还没有元素名称，先补上再校验' });
      return;
    }
    if (!target.selector) {
      patchSniff({ phase: 'idle', error: '这一行还没有定位值，先补上再校验' });
      return;
    }
    patchSniff({ phase: 'starting', busy: true });
    const res = await request('sniffStart', { url, name: target.name, mode: target.mode, selector: target.selector });
    applyResponse(res);
  };

  /** 单行「▶ 校验」：只校验这一行，不进入顺序模式 */
  const verifyRow = (i: number) => {
    const r = rows[i];
    if (!r) return;
    const name = String(r.name || '').trim();
    const selector = String(r.selector || '').trim();
    const q = sniffQueue();
    const at = q.findIndex((x) => x.name === name && x.selector === selector);
    startAt({ name, mode: normalizeMode(r.mode) as string, selector }, {
      seq: false,
      index: at >= 0 ? at + 1 : 1,
      total: q.length,
      skipped: []
    });
  };

  /** 顶部工具条：「按顺序校验」——从第一行开始逐行高亮 */
  const startSequence = () => {
    const q = sniffQueue();
    if (!q.length) {
      patchSniff(Object.assign({}, SNIFF_IDLE, { open: true, error: '这一页还没有填名称的元素行，没法按顺序校验' }));
      return;
    }
    startAt(q[0], { seq: true, index: 1, total: q.length, skipped: [] });
  };

  /** 下一个：高亮下一行（index 是 1 起，正好等于下一行的 0 起下标） */
  const seqNext = () => {
    const q = sniffQueue();
    if (sniff.index >= q.length) return;
    startAt(q[sniff.index], { seq: true, index: sniff.index + 1, total: q.length });
  };

  /** 重复当前：对当前这一行再发一次 highlight（不重新导航，只看它还在不在） */
  const seqRepeat = () => {
    const t = sniff.target;
    if (!t) return;
    patchSniff({ busy: true, error: '' });
    request('sniffHighlight', { name: t.name, mode: t.mode, selector: t.selector }).then((res) => applyResponse(res));
  };

  /** 跳过：这一行不看，记进「已跳过」并直接高亮下一行 */
  const seqSkip = () => {
    const q = sniffQueue();
    const name = sniff.target ? sniff.target.name : '';
    const skipped = name ? sniff.skipped.concat([name]) : sniff.skipped;
    if (sniff.index >= q.length) {
      patchSniff({ skipped });
      return;
    }
    startAt(q[sniff.index], { seq: true, index: sniff.index + 1, total: q.length, skipped });
  };

  /** 停止：结束「按顺序」这一轮，浏览器不关（还留着「重新高亮 / 关闭浏览器」） */
  const seqStop = () => patchSniff({ seq: false });

  const reopenPage = async () => {
    const url = String(pageUrl || '').trim();
    if (!url) {
      patchSniff({ error: '这条记录还没有页面地址（url），没法重新打开' });
      return;
    }
    patchSniff({ busy: true, error: '' });
    const res = await request('sniffReopen', url);
    applyResponse(res);
  };

  const stopBrowser = async () => {
    patchSniff({ busy: true, error: '' });
    const res = await request('sniffStop');
    const stillRunning = !!(res && res.ok !== false && res.running);
    patchSniff({
      busy: false,
      phase: 'idle',
      seq: false,
      resp: res,
      error: stillRunning ? String(res.message || '浏览器没有关掉') : ''
    });
  };

  /** 浏览器被关掉 / 应用重启后再来一次 */
  const sniffRestart = () => {
    if (!sniff.target) {
      startSequence();
      return;
    }
    startAt(sniff.target, {
      seq: sniff.seq,
      index: sniff.index || 1,
      total: sniff.total || 1,
      skipped: sniff.skipped
    });
  };

  /** 关面板 = 结束这一轮；面板没了就没有控制入口，浏览器一并关掉 */
  const closeSniff = () => {
    sniffOpen.current = false;
    patchSniff(Object.assign({}, SNIFF_IDLE));
    request('sniffStop');
  };

  // 面板开着且已就绪时定期问一次：用户把浏览器窗口关了 / 重启了应用会回 running:false，
  // 面板要切到「会话已结束，可重新开始」。
  useEffect(() => {
    if (!sniff.open || sniff.phase !== 'ready') return undefined;
    let alive = true;
    const timer = setInterval(() => {
      request('sniffStatus').then((res) => {
        if (!alive) return;
        if (res && res.ok !== false && res.running === false) {
          setSniff((prev) => (prev.phase === 'ready' ? Object.assign({}, prev, { phase: 'ended', busy: false }) : prev));
        }
      });
    }, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sniff.open, sniff.phase]);

  // 卸载（关表单 / 关详情）也算这一轮结束，别把浏览器窗口留在那儿没人管
  useEffect(
    () => () => {
      if (!sniffOpen.current) return;
      sniffOpen.current = false;
      try {
        const fn = (api as any).sniffStop;
        if (typeof fn === 'function') Promise.resolve(fn()).catch(() => {});
      } catch (e) {
        /* 预览/测试桩里没有这个方法，忽略 */
      }
    },
    []
  );

  // 外部 value 变了（且不是自己刚发出去的那个值）才回填
  useEffect(() => {
    const incoming = String(value === undefined || value === null ? '' : value);
    if (!shouldAdoptIncoming(incoming, lastEmitted.current)) return; // 自己发的，忽略
    setRows(initialRows(incoming));
  }, [value]);

  const commit = (next: PageElement[]) => {
    setRows(next);
    const s = serializeElements(next);
    lastEmitted.current = s; // 关键：记下自己发出去的值，上面的 effect 才不会把刚输入的内容冲掉
    onChange(s);
  };

  const setRow = (i: number, key: keyof PageElement, v: any) => {
    const next = rows.slice();
    next[i] = Object.assign({}, next[i], { [key]: v });
    commit(next);
  };

  const addRow = () => commit(rows.concat([blankRow()]));

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    commit(next.length ? next : [blankRow()]);
    // 删行后下标会错位，聚焦预览直接清掉，免得预览跑到别的行上
    setFocusRow(-1);
  };

  const filled = rows.filter((r) => r.name.trim()).length;

  return (
    <div className="page-elements-editor">
      {/* 顶部工具条：按顺序逐行高亮（进度只在内存里） */}
      <div className="pe-sniff-bar" style={SNIFF_BAR_STYLE}>
        <Button size="small" onClick={startSequence} disabled={sniff.busy}>
          ▶ 按顺序校验
        </Button>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          从第一行开始逐行高亮；进度只在界面里，不写进台账
        </span>
        {String(pageUrl || '').trim() ? null : (
          <Tag color="orange" style={{ fontSize: 11 }}>
            这条记录还没填页面地址（url）
          </Tag>
        )}
      </div>

      <table className="jmx-table pe-table">
        <thead>
          <tr>
            <th style={{ width: '20%' }}>名称</th>
            <th style={{ width: 112 }}>定位方式</th>
            <th style={{ width: '26%' }}>定位值</th>
            <th>说明</th>
            {/* 行右端的「▶ 校验」；宽度压到最小，免得把说明列挤没 */}
            <th style={{ width: 42 }} />
            <th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const mode = normalizeMode(r.mode);
            // 编辑器里没有语言上下文，按 Java 语法预览（CodegenPage 会按当前生成目标预览）
            const preview = previewLocatorCode(mode, r.selector, 'java');
            // 聚焦或已填内容才显示预览，否则每行两栏会把表格挤得很长
            const showPreview = focusRow === i || String(r.selector || '').trim() !== '';
            return (
              <tr key={i}>
                <td>
                  <Input
                    size="small"
                    className="mono"
                    value={r.name}
                    placeholder="usernameInput"
                    onChange={(e) => setRow(i, 'name', e.target.value)}
                  />
                </td>
                <td>
                  <Select
                    size="small"
                    className="pe-mode-select"
                    style={{ width: '100%' }}
                    value={mode}
                    options={LOCATOR_MODE_OPTIONS}
                    onChange={(v) => setRow(i, 'mode', v)}
                  />
                </td>
                <td>
                  <Input
                    size="small"
                    className="mono"
                    value={r.selector}
                    placeholder={LOCATOR_MODE_PLACEHOLDER[mode]}
                    onChange={(e) => setRow(i, 'selector', e.target.value)}
                    onFocus={() => setFocusRow(i)}
                    onBlur={() => setFocusRow(-1)}
                  />
                  {mode === 'css' && looksLikeXPath(r.selector) ? (
                    <div className="pe-el-xpath-hint" style={XPATH_HINT_STYLE}>
                      ⚠ 看起来像 XPath，建议把定位方式改成 XPath
                    </div>
                  ) : null}
                  {showPreview ? (
                    <div className="pe-el-preview mono" style={PREVIEW_STYLE}>
                      {'→ ' + (preview || '（等待输入）')}
                    </div>
                  ) : null}
                </td>
                <td>
                  <Input
                    size="small"
                    value={r.desc}
                    placeholder="用户名输入框"
                    onChange={(e) => setRow(i, 'desc', e.target.value)}
                  />
                </td>
                <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {/* 行右端的小按钮：只校验这一行（把这一行的 name / mode / selector 和页面 url 发过去） */}
                  <Button
                    type="link"
                    size="small"
                    style={{ paddingInline: 0, fontSize: 11 }}
                    disabled={sniff.busy}
                    onClick={() => verifyRow(i)}
                    title="在浏览器里高亮这一行的元素"
                  >
                    ▶ 校验
                  </Button>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeRow(i)}
                    title="删除这行"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Space size={8} style={{ marginTop: 6 }}>
        <Button size="small" type="link" icon={<PlusOutlined />} onClick={addRow}>
          添加元素
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          {filled ? `${filled} 个元素` : placeholder || '至少填一个'}
        </span>
        <Tag style={{ fontSize: 11 }}>优先用语义化定位（Role / Label / Text），data-testid 垫底</Tag>
      </Space>

      {/* 校验面板：只报事实，进度不落库 */}
      {sniff.open ? (
        <SniffPanel
          phase={sniff.phase}
          busy={sniff.busy}
          resp={sniff.resp}
          error={sniff.error}
          sequential={sniff.seq}
          index={sniff.index}
          total={sniff.total}
          currentName={sniff.target ? sniff.target.name : ''}
          currentModeLabel={sniff.target ? MODE_LABEL[sniff.target.mode] || sniff.target.mode : ''}
          currentSelector={sniff.target ? sniff.target.selector : ''}
          skipped={sniff.skipped}
          url={String(pageUrl || '').trim()}
          onClose={closeSniff}
          onHighlight={() => {
            if (sniff.target) seqRepeat();
          }}
          onReopen={reopenPage}
          onStopBrowser={stopBrowser}
          onNext={seqNext}
          onRepeat={seqRepeat}
          onSkip={seqSkip}
          onStopSeq={seqStop}
          onRestart={sniffRestart}
        />
      ) : null}
    </div>
  );
}