'use strict';
/**
 * 皮肤主题色定义（5 种）。
 *
 * 每个主题提供三个颜色：
 *   primary      填充色（按钮底、选中块、色块）—— 一定配白字使用
 *   primaryText  文字色（链接、选中的导航项、强调文字）—— 一定压在浅底上使用
 *   soft         浅底色（选中项背景、标签底）
 *
 * 为什么要拆 primary / primaryText 两档：
 *   同一个色相，「能当按钮底（配白字 ≥4.5:1）」和「能当文字（压白底 ≥4.5:1）」
 *   要求的明度并不完全一样。只留一档时，要么按钮白字发灰，要么链接看不清。
 *   拆开后两个用途各自达标，色相不变。
 *
 * 为什么只有 5 种：
 *   原来的 cyan（#00a8a8，2.93:1）和 orange（#f2994a，2.23:1）在白底上
 *   既不能当文字（<4.5），也不能当按钮底（白字 2.2-2.9:1），
 *   属于「选了就必然看不清」的选项，所以直接下线。
 */

const THEMES = [
  {
    key: 'purple',
    name: '紫',
    primary: '#6c5ce7',
    primaryText: '#5443d6',
    soft: '#efecff'
  },
  {
    key: 'blue',
    name: '蓝',
    primary: '#1a6bc4',
    primaryText: '#12559e',
    soft: '#e8f1fd'
  },
  {
    key: 'green',
    name: '绿',
    primary: '#1a7f4b',
    primaryText: '#14643b',
    soft: '#e6f7ed'
  },
  {
    key: 'red',
    name: '红',
    primary: '#cc3636',
    primaryText: '#a82a2a',
    soft: '#fdeaea'
  },
  {
    key: 'gray',
    name: '灰',
    primary: '#5a6072',
    primaryText: '#3f4453',
    soft: '#eef0f4'
  }
];

const THEME_MAP = THEMES.reduce((acc, t) => {
  acc[t.key] = t;
  return acc;
}, {});

/**
 * 下线主题的迁移表。
 *
 * 老配置里存着 themeColor: 'cyan' / 'orange'，直接按 key 找不到会掉到默认紫色，
 * 用户的感受是「我的配色突然变紫了」。所以按色相就近迁移：
 *   cyan   → blue（都是冷色）
 *   orange → red（都是暖色）
 */
const THEME_ALIAS = {
  cyan: 'blue',
  orange: 'red'
};

/** 默认主题 */
const DEFAULT_THEME = 'purple';

/** 取主题（先查迁移表，找不到返回默认） */
function getTheme(key) {
  const mapped = Object.prototype.hasOwnProperty.call(THEME_ALIAS, key) ? THEME_ALIAS[key] : key;
  return THEME_MAP[mapped] || THEME_MAP[DEFAULT_THEME];
}

module.exports = { THEMES, THEME_MAP, THEME_ALIAS, DEFAULT_THEME, getTheme };