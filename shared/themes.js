'use strict';
/**
 * 皮肤主题色定义。
 *
 * 每个主题提供三个变量：
 *   primary      主色（按钮、选中态、链接）
 *   primaryDeep  深色（hover、强调）
 *   primarySoft  浅色（背景、标签底）
 *
 * 只改这三个变量，其余颜色（文字、边框、背景）保持不变，
 * 这样换主题不会破坏可读性。
 */

const THEMES = [
  {
    key: 'purple',
    name: '紫',
    primary: '#6c5ce7',
    primaryDeep: '#5443d6',
    primarySoft: '#efecff'
  },
  {
    key: 'blue',
    name: '蓝',
    primary: '#2f80ed',
    primaryDeep: '#1c60c4',
    primarySoft: '#e8f1fd'
  },
  {
    key: 'cyan',
    name: '青',
    primary: '#00a8a8',
    primaryDeep: '#008080',
    primarySoft: '#e0f5f5'
  },
  {
    key: 'green',
    name: '绿',
    primary: '#27ae60',
    primaryDeep: '#1e8449',
    primarySoft: '#e6f7ed'
  },
  {
    key: 'orange',
    name: '橙',
    primary: '#f2994a',
    primaryDeep: '#d97b2b',
    primarySoft: '#fdf0e3'
  },
  {
    key: 'red',
    name: '红',
    primary: '#eb5757',
    primaryDeep: '#c73e3e',
    primarySoft: '#fdeaea'
  },
  {
    key: 'gray',
    name: '灰',
    primary: '#5a6072',
    primaryDeep: '#3f4453',
    primarySoft: '#eef0f4'
  }
];

const THEME_MAP = THEMES.reduce((acc, t) => {
  acc[t.key] = t;
  return acc;
}, {});

/** 默认主题 */
const DEFAULT_THEME = 'purple';

/** 取主题（找不到返回默认） */
function getTheme(key) {
  return THEME_MAP[key] || THEME_MAP[DEFAULT_THEME];
}

module.exports = { THEMES, THEME_MAP, DEFAULT_THEME, getTheme };
