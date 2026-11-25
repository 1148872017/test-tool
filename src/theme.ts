/**
 * antd 主题 token（跟随皮肤主题色现算）。
 *
 * 为什么从「常量」改成「函数」：
 *   主题色是用户在设置里选的（shared/themes.js 里 5 种），而 antd 组件的颜色
 *   默认全部来自 token。token 写死成紫色常量时，切主题只改了 CSS 变量 ——
 *   自己写的 .nav-item.active 变了，但 Button / Select / DatePicker / Table
 *   选中行依旧是紫色（实测 bug 就是这样来的）。所以这里按当前主题色现算一份
 *   token，由 App.tsx 用 useMemo 缓存后交给 ConfigProvider。
 *
 * 文字色和 styles.css 的 CSS 变量必须对齐，否则同一段文字在
 * 「自己写的 div」和「antd 组件」里颜色不一样（踩过：表格头比正文浅一档）。
 *   --text    → colorText
 *   --muted   → colorTextSecondary / 表格头
 *   --text-3  → colorTextTertiary（时间、计数、占位、状态栏）
 */
import { getTheme, DEFAULT_THEME } from '../shared/themes';

/** 皮肤主题色三档（和 shared/themes.js 里每一项一一对应） */
export type SkinColors = {
  /** 填充色：按钮底、色块（固定配白字） */
  primary: string;
  /** 文字色：链接、选中的导航项（固定压浅底） */
  primaryText: string;
  /** 浅底色：选中项背景、标签底 */
  soft: string;
};

/** #rrggbb → [r, g, b]；解析不了返回 null（调用方自己兜底，不抛） */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] → #rrggbb（夹到 0~255） */
function toHex(rgb: number[]): string {
  return (
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * 主题色按比例压到白底上。
 *
 * ratio = 0 纯白、1 纯主题色；表格 hover 行、下拉选中项这类「浅底」
 * 都必须由当前主题色算出来，否则切主题时它们还是紫色。
 */
export function mixWithWhite(hex: string, ratio: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const p = Math.max(0, Math.min(1, ratio));
  return toHex(rgb.map((v) => 255 - (255 - v) * p));
}

/** 主题色 + 透明度（box-shadow / 聚焦光晕用：hex 写不出 alpha） */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return 'rgba(0, 0, 0, ' + alpha + ')';
  const a = Math.max(0, Math.min(1, alpha));
  return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + a + ')';
}

/**
 * 按当前主题色生成 antd ThemeConfig。
 *
 * @param primary     填充色（colorPrimary / colorInfo）
 * @param primaryText 文字色（colorLink），不传时退化成 primary
 *
 * 只把「紫色硬编码」换成参数，其余 token（字号、圆角、边框灰、状态色）保持原值：
 * 它们和主题色无关，跟着变会让整站色彩乱套。
 */
export function buildThemeConfig(primary: string, primaryText: string = primary) {
  const link = primaryText || primary;
  return {
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorLink: link,
      colorLinkHover: primary,
      colorLinkActive: link,
      colorSuccess: '#1fa97a',
      colorWarning: '#e8a33d',
      colorError: '#e5534b',
      borderRadius: 8,
      fontFamily: "'Segoe UI', 'Microsoft YaHei', -apple-system, system-ui, sans-serif",
      colorText: '#1f2430',
      colorTextSecondary: '#5a6275',
      colorTextTertiary: '#666e80',
      colorBorder: '#e3e6f0',
      colorBorderSecondary: '#eef0f7',
      colorBgLayout: '#f4f5fa',
      controlHeight: 32,
      fontSize: 13
    },
    components: {
      Table: {
        headerBg: '#fafbfe',
        headerColor: '#5a6275',
        headerSplitColor: 'transparent',
        // 列表 hover 行：原来是写死的 #f8f7ff（紫），必须跟着主题色走
        rowHoverBg: mixWithWhite(primary, 0.04),
        cellPaddingBlock: 9,
        cellPaddingInline: 12,
        borderColor: '#f0f2f8',
        fontSize: 13
      },
      // 主按钮投影：紫色光晕同样要跟主题色
      Button: { defaultShadow: 'none', primaryShadow: '0 2px 6px ' + withAlpha(primary, 0.25) },
      Modal: { borderRadiusLG: 14 },
      Drawer: { paddingLG: 20 },
      Tag: { borderRadiusSM: 4, defaultBg: '#f1f2f9' },
      // 输入框聚焦光晕
      Input: { activeShadow: '0 0 0 3px ' + withAlpha(primary, 0.1) },
      // 下拉框选中项底色：原来是写死的 #f1eeff（紫）
      Select: { optionSelectedBg: mixWithWhite(primary, 0.1) },
      Segmented: { itemSelectedBg: '#ffffff' },
      Popconfirm: { zIndexPopup: 1400 }
    }
  };
}

/**
 * 默认 token（紫）。
 *
 * 保留这个常量导出是给「拿不到用户设置」的场景兜底（也避免其他引用处报错），
 * 颜色取自 shared/themes.js 的默认主题，不在这里再写一份十六进制。
 */
const DEFAULT_SKIN: SkinColors = getTheme(DEFAULT_THEME);
export const themeConfig = buildThemeConfig(DEFAULT_SKIN.primary, DEFAULT_SKIN.primaryText);