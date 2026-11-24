import React, { useEffect, useState } from 'react';
import { Button } from 'antd';
import {
  InboxOutlined,
  SearchOutlined,
  DisconnectOutlined,
  DownOutlined,
  RightOutlined
} from '@ant-design/icons';

/**
 * 统一空状态：**一种成因一句话 + 永远有一个下一步按钮**。
 *
 * 为什么要有这个组件：
 *   改造前有 4 套写法（.empty-state / antd <Empty> / .empty-tip / .tag-empty），
 *   最要命的是绝大多数只是「一个图标 + 一句没有数据」——
 *   用户看完仍然不知道下一步该点哪儿（P5：空状态必须给出路，不能是死胡同）。
 *
 * 三种成因分开，是因为「为什么空」决定了「下一步做什么」：
 *   no-data   还没有数据      → 下一步是「新增 / 开始扫描」这类从零开始的动作
 *   no-match  筛选没命中      → 下一步是「清空筛选」，不是去新增（数据其实在）
 *   failed     读取失败        → 下一步是「去设置里配 / 重试」，还能展开看原始错误
 *
 * 样式在 styles.css 的 .state-empty / .state-page；组件只负责结构。
 * 不在组件里 import 独立 css：build.mjs 只 copy src/styles.css，
 * 另出的 css 不会被 index.html 引用（等于样式静默丢失）。
 */

export type StateKind = 'no-data' | 'no-match' | 'failed';

export interface StateEmptyAction {
  /** 按钮文案；不给就按 kind 用默认文案（见 DEFAULT_ACTION_LABEL） */
  label?: string;
  onClick: () => void;
  /** 是否主按钮；默认 no-data / failed 是，no-match 不是（清空筛选不是主路径） */
  primary?: boolean;
}

export interface StateEmptyProps {
  /** 三种成因：没有数据 / 搜不到 / 读失败 */
  kind: StateKind;
  title?: React.ReactNode; // 不给就用 kind 的默认文案
  desc?: React.ReactNode;
  action?: StateEmptyAction;
  secondary?: { label: string; onClick: () => void };
  /** 尺寸：page = 占满内容区，inline = 卡片内 */
  size?: 'page' | 'inline';
  /** no-data / failed 的「{对象}」，用来拼默认标题：还没有{对象} / 没读到{对象} */
  object?: string;
  /** no-match 的「{关键词}」：没有匹配「{关键词}」的记录 */
  keyword?: string;
  /** failed：可展开的原始错误 / 排查线索（不给就不显示「详情」） */
  detail?: React.ReactNode;
  /** 换图标（默认按 kind 给） */
  icon?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/** 三态的默认「下一步」文案：页面不给 action.label 时用它 */
export const DEFAULT_ACTION_LABEL: Record<StateKind, string> = {
  'no-data': '+ 新增',
  'no-match': '清空筛选',
  failed: '去设置里配'
};

/**
 * 是否开发期。
 *
 * 用 try/catch 包住：打包脚本会 --define 掉 process.env.NODE_ENV，
 * 而万一在没有 define 的环境（比如别的 bundler）跑，裸的 process 会直接 ReferenceError。
 */
const IS_DEV = (() => {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch (e) {
    return false;
  }
})();

/** 默认标题：把「为什么没有」直接写进标题，而不是只放一句「暂无数据」 */
function defaultTitle(kind: StateKind, object?: string, keyword?: string): string {
  if (kind === 'no-data') return '还没有' + (object || '内容');
  if (kind === 'no-match') return keyword ? '没有匹配「' + keyword + '」的记录' : '没有匹配的记录';
  return '没读到' + (object || '数据');
}

function defaultIcon(kind: StateKind): React.ReactNode {
  if (kind === 'no-match') return <SearchOutlined />;
  if (kind === 'failed') return <DisconnectOutlined />;
  return <InboxOutlined />;
}

export default function StateEmpty({
  kind,
  title,
  desc,
  action,
  secondary,
  size = 'inline',
  object,
  keyword,
  detail,
  icon,
  className,
  style
}: StateEmptyProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const isPage = size === 'page';

  /**
   * 没给动作时提醒开发：三态的原则是「永远有一个下一步按钮」。
   * 只开发期喊一嗓子，线上不打扰用户。
   */
  useEffect(() => {
    if (!action && IS_DEV) {
      // eslint-disable-next-line no-console
      console.warn('[StateEmpty] kind=' + kind + ' 没有传 action：空状态必须给用户一个下一步');
    }
  }, [action, kind]);

  const primary = action ? (action.primary !== undefined ? action.primary : kind !== 'no-match') : false;
  const actionLabel = (action && action.label) || DEFAULT_ACTION_LABEL[kind];

  return (
    <div
      className={'state-empty' + (isPage ? ' state-page' : ' state-inline') + (className ? ' ' + className : '')}
      style={style}
    >
      <div className={'state-empty-icon' + (kind === 'failed' ? ' is-failed' : '')}>{icon || defaultIcon(kind)}</div>

      <div className="state-empty-title">{title || defaultTitle(kind, object, keyword)}</div>

      {desc ? <div className="state-empty-desc">{desc}</div> : null}

      {action || secondary || detail ? (
        <div className="state-empty-actions">
          {action ? (
            <Button
              type={primary ? 'primary' : 'default'}
              size={isPage ? 'middle' : 'small'}
              onClick={action.onClick}
            >
              {actionLabel}
            </Button>
          ) : null}
          {secondary ? (
            <Button size={isPage ? 'middle' : 'small'} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          ) : null}
          {detail ? (
            <Button
              type="text"
              size={isPage ? 'middle' : 'small'}
              icon={detailOpen ? <DownOutlined /> : <RightOutlined />}
              onClick={() => setDetailOpen((v) => !v)}
            >
              详情
            </Button>
          ) : null}
        </div>
      ) : null}

      {detail && detailOpen ? <div className="state-empty-detail mono">{detail}</div> : null}
    </div>
  );
}