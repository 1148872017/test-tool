import React from 'react';
import { isApiUnavailableError } from '../../platform/api';

/**
 * 出错兜底边界。
 *
 * 为什么必须有：
 *   全项目原先 0 个 componentDidCatch。React 18 里 render 阶段抛出的异常没人接，
 *   会把整棵树卸载 —— 一个页面读到不存在的字段（record.data.xxx），
 *   用户看到的就是整窗白屏，只能杀进程重启。
 *
 * 设计要点：
 *   1. 默认兜底不依赖 antd：Provider / 主题 / 弹层自己挂了也要能显示，纯内联样式；
 *   2. ApiUnavailableError 单独给文案：用户该做的是重装或查杀软，不是点重试；
 *   3. scope 只做标识，不参与逻辑，上报时可以按区域聚合；
 *   4. reset() 只清自身状态；父组件用 key={routeKey} 让路由切换时边界重建，
 *      「切走再切回来」即可自动恢复。
 */

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** 出错区域标识：'app' | 'shell' | route key，用于兜底文案与上报维度 */
  scope: string;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: React.ErrorInfo | null;
  /** 复制按钮的瞬时反馈：'' 无 / ok 已复制 / fail 复制失败 */
  copyState: '' | 'ok' | 'fail';
}

/** 兜底 UI 的内联样式（不依赖 styles.css，样式表本身出错时也要能显示） */
const s: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '32px 24px',
    boxSizing: 'border-box',
    background: '#f4f5fa',
    overflow: 'auto'
  },
  card: {
    width: '100%',
    maxWidth: 640,
    background: '#ffffff',
    border: '1px solid #e3e6f0',
    borderRadius: 14,
    padding: '26px 28px 22px',
    boxShadow: '0 10px 28px rgba(31, 36, 48, 0.07)'
  },
  badge: {
    display: 'inline-block',
    fontSize: 12,
    lineHeight: '20px',
    padding: '0 8px',
    borderRadius: 4,
    color: '#e5534b',
    background: '#fdeceb',
    fontWeight: 600
  },
  title: {
    margin: '10px 0 6px',
    fontSize: 18,
    fontWeight: 600,
    color: '#1f2430',
    letterSpacing: 0.2
  },
  hint: {
    margin: '0 0 14px',
    fontSize: 13,
    lineHeight: 1.7,
    color: '#6b7284'
  },
  scope: {
    margin: '0 0 10px',
    fontSize: 12,
    color: 'var(--text-3)'
  },
  summary: {
    margin: '0 0 16px',
    padding: '10px 12px',
    borderRadius: 8,
    background: '#f7f8fc',
    border: '1px solid #eef0f7',
    fontFamily: "'Consolas', 'Courier New', monospace",
    fontSize: 12.5,
    lineHeight: 1.6,
    color: '#c0392b',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 132,
    overflow: 'auto'
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  btnPrimary: {
    height: 32,
    padding: '0 16px',
    borderRadius: 8,
    border: '1px solid #6c5ce7',
    background: '#6c5ce7',
    color: '#ffffff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer'
  },
  btn: {
    height: 32,
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid #e3e6f0',
    background: '#ffffff',
    color: '#1f2430',
    fontSize: 13,
    cursor: 'pointer'
  },
  feedback: { fontSize: 12, color: 'var(--text-3)', marginLeft: 2 },
  feedbackFail: { fontSize: 12, color: '#e5534b', marginLeft: 2 },
  details: { marginTop: 16, fontSize: 12.5, color: '#6b7284' },
  pre: {
    margin: '8px 0 0',
    padding: 12,
    borderRadius: 8,
    background: '#f7f8fc',
    border: '1px solid #eef0f7',
    fontFamily: "'Consolas', 'Courier New', monospace",
    fontSize: 12,
    lineHeight: 1.6,
    color: '#3d4353',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 260,
    overflow: 'auto'
  }
};

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null, copyState: '' };

  /** 组件是否还在树上：复制是异步的，回来后不能再 setState */
  private alive = true;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 完整堆栈留给控制台 / 用户点「复制详情」带走
    console.error('[ErrorBoundary] 区域 ' + this.props.scope + ' 渲染失败：', error, info);
    this.setState({ info });
    if (this.props.onError) {
      try {
        this.props.onError(error, info);
      } catch (e) {
        // 上报本身出错不能再往上抛，否则兜底也跟着炸
        console.error('[ErrorBoundary] onError 回调抛错：', e);
      }
    }
  }

  componentWillUnmount() {
    this.alive = false;
  }

  /** 只清自己的状态：真正的根因（父级数据）修好后，子组件会重新挂载 */
  private reset = () => {
    this.setState({ error: null, info: null, copyState: '' });
  };

  private reload = () => {
    window.location.reload();
  };

  /** 汇总一份可直接贴进工单的文本 */
  private buildDetail(): string {
    const { error, info } = this.state;
    return [
      '区域: ' + this.props.scope,
      '名称: ' + (error ? error.name : ''),
      '信息: ' + (error ? error.message : ''),
      '时间: ' + new Date().toISOString(),
      '页面: ' + (typeof location !== 'undefined' ? location.href : ''),
      '环境: ' + (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
      '',
      '错误堆栈:',
      (error && error.stack) || '(无)',
      '',
      '组件栈:',
      (info && info.componentStack) || '(无)'
    ].join('\n');
  }

  /** 写剪贴板：优先 navigator.clipboard，失败退回 textarea + execCommand */
  private async writeClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // 沙箱 / 权限拒绝，继续走兜底方案
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  private copyDetail = async () => {
    const ok = await this.writeClipboard(this.buildDetail());
    if (!this.alive) return;
    this.setState({ copyState: ok ? 'ok' : 'fail' });
    window.setTimeout(() => {
      if (this.alive) this.setState({ copyState: '' });
    }, 3000);
  };

  /** 默认兜底 UI：标题 + 摘要 + 重试 / 复制详情 / 重载整窗 */
  private renderDefault(error: Error) {
    const apiMissing = isApiUnavailableError(error);
    const title = apiMissing ? 'Electron 预加载脚本没加载' : '这块界面渲染失败了';
    const hint = apiMissing
      ? 'Electron 预加载脚本没加载，请重装或检查杀软拦截。当前页面拿不到本地数据，点「重试」一般不会恢复。'
      : '其他功能可能还能用：切换到左侧别的菜单再切回来，这个页面会自动重建恢复；如果一直失败，点「重载整窗」。';
    const { copyState } = this.state;

    return (
      <div role="alert" style={s.wrap} data-scope={this.props.scope}>
        <div style={s.card}>
          <span style={s.badge}>出错了</span>
          <div style={s.title}>{title}</div>
          <p style={s.hint}>{hint}</p>
          <p style={s.scope}>{'出错区域：' + this.props.scope}</p>
          <div style={s.summary}>{error.name + ': ' + (error.message || '（没有错误信息）')}</div>

          <div style={s.row}>
            <button type="button" style={s.btnPrimary} onClick={this.reset}>
              重试
            </button>
            <button type="button" style={s.btn} onClick={this.copyDetail}>
              复制详情
            </button>
            <button type="button" style={s.btn} onClick={this.reload}>
              重载整窗
            </button>
            {copyState === 'ok' ? <span style={s.feedback}>已复制到剪贴板</span> : null}
            {copyState === 'fail' ? (
              <span style={s.feedbackFail}>复制失败，请展开下方详情手动选中</span>
            ) : null}
          </div>

          <details style={s.details}>
            <summary style={{ cursor: 'pointer' }}>查看技术细节</summary>
            <pre style={s.pre}>{this.buildDetail()}</pre>
          </details>
        </div>
      </div>
    );
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      try {
        const node = this.props.fallback(error, this.reset);
        if (node !== undefined && node !== null) return node;
      } catch (e) {
        // 自定义兜底自己抛错：退回默认兜底，绝不让它再冒到整棵树
        console.error('[ErrorBoundary] 自定义兜底渲染失败，改用默认兜底：', e);
      }
    }

    return this.renderDefault(error);
  }
}
