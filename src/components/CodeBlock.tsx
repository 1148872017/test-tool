import React, { useCallback, useMemo, useState } from 'react';
import { Button } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { highlight, detectLang, normalizeLang, countLines, limitTokens } from '../../shared/codeHighlight.js';

/**
 * 统一的代码展示组件（全站代码块都走这一个）。
 *
 * ============================================================
 * 为什么要统一
 * ============================================================
 * 之前每个页面各写各的：代码生成是 `.codegen-code`、脚本生成是 `.scriptgen-code`、
 * 模板抽屉是 `.tpl-code`（还写死了深色底）、JSON 预览是裸 `<pre className="mono">`。
 * 结果是「同一个东西在四个地方长得不一样」，而且除了模板抽屉都没有行号。
 *
 * ============================================================
 * 结构：行号槽 + 一段**带真换行**的代码文本
 * ============================================================
 * 没有做成「一行一个 <div>」，因为那样拖选复制会丢空行：
 *   实测「aaa / 空行 / ccc」三个块 div 复制出来是 "aaa\r\nccc"，
 *   空行被浏览器吞掉 —— 粘回 IDE 就是一段被合起来的代码。
 * 现在的结构是：
 *   .code-block-inner
 *     ├─ .code-block-gutter（1..N，user-select:none，横向滚动时 sticky 贴左）
 *     └─ .code-block-code  （token span + 源码里的真实 \n）
 * 空行就是两个连续的 \n，复制/粘贴天然无损；行号槽不进选区，
 * 复制出来的只有代码本身。（行高两列一致，所以行号与代码严格对齐；
 * 代码列 `white-space: pre` 不折行，一行源码 = 一行视觉行。）
 *
 * ============================================================
 * 几条不能丢的行为（改之前先看）
 * ============================================================
 * 1. **主题跟随**：颜色只取 styles.css 的 CSS 变量（--panel / --bg-subtle / --line-soft /
 *    --text / --muted / --text-3 / --primary-text）。5 套主题换的是 accent 色，
 *    所以这里绝不能写死背景色（原来 `.tpl-code` 的 #1e2233 就是反例：切主题、
 *    切到浅色界面里都是一块黑，跟周围不搭）。
 * 2. **超长折叠**：超过 COLLAPSE_AT 行先只渲染前面一段（顺带把 DOM 节点数压住），
 *    点「展开全部」才全渲染；但「复制」始终复制**完整**源码，不是折叠后的。
 * 3. **空内容不抛错**：`code` 为空时显示占位文案，而不是渲染一个空框。
 *
 * 性能：高亮在 useMemo 里做，只依赖 code / lang。50~60 KB 的 jmx 实测 ~8ms
 * （见 scripts/test-code-highlight.cjs 的性能用例）。
 */

/** 超过这么多行先折叠（避免一次往 DOM 里塞几万个 span） */
const COLLAPSE_AT = 400;

/** 语言徽标文案（认不出来的不显示徽标） */
const LANG_LABEL: Record<string, string> = {
  java: 'Java',
  groovy: 'Groovy',
  python: 'Python',
  json: 'JSON',
  xml: 'XML',
  sql: 'SQL',
  bash: 'Shell',
  powershell: 'PowerShell',
  plain: '纯文本'
};

type Token = { type: string; text: string };

export type CodeBlockProps = {
  /** 源码（原样展示，不做 trim —— 缩进是代码的一部分） */
  code: string;
  /** 语言：java / python / json / xml / sql / bash / powershell / groovy / plain；省略则自动识别 */
  lang?: string;
  /** 显示行号（默认 true） */
  showLineNumbers?: boolean;
  /** 代码区最大高度（px 或 CSS 值；传 'none' 表示跟着父容器撑满） */
  maxHeight?: number | string;
  /** 显示「复制」按钮（默认 true；页面已有复制按钮时传 false，别出两个） */
  copyable?: boolean;
  /** 头部标题（传了才显示头栏；不传时头栏只放语言徽标 / 复制） */
  title?: string;
  /** 额外类名（页面里用来让代码块撑满面板） */
  className?: string;
  /** 空内容占位文案 */
  emptyText?: string;
};

/** token → React 节点；plain 直接出文本，少一层 span */
function renderTokens(tokens: Token[]): React.ReactNode {
  return tokens.map((t, i) =>
    t.type === 'plain' ? (
      <React.Fragment key={i}>{t.text}</React.Fragment>
    ) : (
      <span key={i} className={'code-block-tok is-' + t.type}>
        {t.text}
      </span>
    )
  );
}

export default function CodeBlock({
  code,
  lang,
  showLineNumbers = true,
  maxHeight,
  copyable = true,
  title,
  className,
  emptyText
}: CodeBlockProps) {
  const text = code == null ? '' : String(code);
  const [expanded, setExpanded] = useState(false);

  // 语言：没传就自动识别；识别不出来（plain）就不显示徽标
  const langKey = useMemo(() => {
    const key = normalizeLang(lang);
    return key === 'auto' ? detectLang(text) : key;
  }, [lang, text]);

  const tokens = useMemo(() => highlight(text, langKey), [text, langKey]);
  const totalLines = useMemo(() => countLines(tokens), [tokens]);

  // 源码变了（切生成目标 / 重新生成）就回到折叠态，别把「上一次展开过」记到新内容上
  React.useEffect(() => {
    setExpanded(false);
  }, [text]);

  const collapsed = !expanded && totalLines > COLLAPSE_AT;
  const shownTokens = useMemo(
    () => (collapsed ? limitTokens(tokens, COLLAPSE_AT) : tokens),
    [collapsed, tokens]
  );
  const shownLines = collapsed ? COLLAPSE_AT : totalLines;

  const copy = useCallback(async () => {
    if (!text) {
      toast('这里没有可复制的内容', 'warning');
      return;
    }
    try {
      // 走现有剪贴板通道（Electron 主进程，secret=false 表示不进密码库那种加密轨）
      await api.copy(text, false);
      toast('已复制');
    } catch (e: any) {
      toast('复制失败：' + (e && e.message ? e.message : e), 'error');
    }
  }, [text]);

  const label = LANG_LABEL[langKey] || '';
  const showBar = !!title || copyable;
  const bodyStyle = maxHeight === undefined ? undefined : { maxHeight };
  const cls = 'code-block is-hl' + (className ? ' ' + className : '');

  // 行号：一次算好，避免每行渲染时再算
  const gutter = useMemo(() => {
    if (!showLineNumbers) return null;
    const nums: React.ReactNode[] = new Array(shownLines);
    for (let i = 0; i < shownLines; i += 1) {
      nums[i] = (
        <div className="code-block-ln" key={i}>
          {i + 1}
        </div>
      );
    }
    return (
      <div className="code-block-gutter" aria-hidden="true">
        {nums}
      </div>
    );
  }, [showLineNumbers, shownLines]);

  return (
    <div className={cls} role="group" aria-label={title || '代码块'}>
      {showBar ? (
        <div className="code-block-bar">
          {title ? (
            <span className="code-block-bar-title" title={title}>
              {title}
            </span>
          ) : null}
          {label && langKey !== 'plain' ? <span className="code-block-bar-lang">{label}</span> : null}
          {copyable ? (
            <Button
              className="code-block-copy"
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={copy}
              aria-label={title ? '复制 ' + title : '复制代码'}
            >
              复制
            </Button>
          ) : null}
        </div>
      ) : null}

      {text ? (
        <div className="code-block-body" style={bodyStyle}>
          <div className="code-block-inner">
            {gutter}
            <code className="code-block-code">{renderTokens(shownTokens)}</code>
          </div>
        </div>
      ) : (
        <div className="code-block-empty">{emptyText || '（空）'}</div>
      )}

      {totalLines > COLLAPSE_AT ? (
        <div className="code-block-more">
          {collapsed ? (
            <span className="code-block-more-hint">只渲染了前 {COLLAPSE_AT} 行（复制仍是完整代码）</span>
          ) : null}
          <Button type="link" size="small" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `展开全部（共 ${totalLines} 行）`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
