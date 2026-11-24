/**
 * 统一三态组件（空 / 无匹配 / 失败）的出口。
 *
 * 页面里两种写法都可以：
 *   import { StateEmpty } from '../components/states';
 *   import StateEmpty from '../components/states/StateEmpty';
 */
export { default as StateEmpty, DEFAULT_ACTION_LABEL } from './StateEmpty';
export type { StateEmptyProps, StateEmptyAction, StateKind } from './StateEmpty';
export { default as StateError } from './StateError';
export type { StateErrorProps } from './StateError';
export { default as LoadingRows } from './LoadingRows';
export type { LoadingRowsProps } from './LoadingRows';