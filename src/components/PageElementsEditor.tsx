import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Space, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { LOCATOR_MODES, previewLocatorCode } from '../../shared/locatorModes';

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

type Props = {
  value: any;
  onChange: (next: string) => void;
  placeholder?: string;
};

/**
 * 页面元素编辑器：表格形式维护「名称 + 定位方式 + 定位值 + 说明」。
 *
 * 规划要求「在平台里**可视化**维护页面元素名称和定位器」，
 * 所以不能用 textarea 让用户手写，得是表格。
 */
export default function PageElementsEditor({ value, onChange, placeholder }: Props) {
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
      <table className="jmx-table pe-table">
        <thead>
          <tr>
            <th style={{ width: '22%' }}>名称</th>
            <th style={{ width: 130 }}>定位方式</th>
            <th style={{ width: '30%' }}>定位值</th>
            <th>说明</th>
            <th style={{ width: 34 }} />
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
                <td>
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
    </div>
  );
}