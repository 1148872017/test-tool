import { useEffect, useRef } from 'react';

/**
 * 极简全局快捷键 hook。
 *
 * ============================================================
 * 为什么要 hook
 * ============================================================
 * 改之前全 src 只有 1 处 onKeyDown（代码编辑器的 Ctrl+Enter），
 * 而且它绑在 textarea 上，焦点不在编辑器里就失效；
 * 焦点在别处时连「Esc 取消运行」都按不出来。
 *
 * 这里统一挂 window 上的 keydown，用「组合键字符串 → 处理函数」描述，
 * 各页面只声明自己的快捷键，不关心事件生命周期。
 *
 * 约定：
 *   - 键名大小写不敏感，`Esc` / `Escape`、`Space` / ` ` 等都认；
 *   - 修饰键按「严格相等」匹配：`Ctrl+Enter` 不会被 `Ctrl+Shift+Enter` 触发；
 *   - `Mod` = Windows/Linux 的 Ctrl 或 macOS 的 Cmd（跨平台写法）；
 *   - 命中后 preventDefault，避免 Ctrl+Enter 在 textarea 里再插一个换行。
 *
 * 不做的事（刻意留白）：不做按键序列、不做输入框豁免判断 —— 单键（比如 Esc）
 * 本来就应该在输入框里也能用，Ctrl+Enter 也不是打字键。
 */

export type HotkeyHandler = (e: KeyboardEvent) => void;

/** 组合键 → 处理函数，例如 { 'Ctrl+Enter': run, Escape: cancel } */
export type HotkeyMap = Record<string, HotkeyHandler | null | undefined>;

/** 键名别名（统一转小写后比对） */
const KEY_ALIAS: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  return: 'enter',
  enter: 'enter',
  space: ' ',
  spacebar: ' ',
  tab: 'tab',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  ins: 'insert',
  plus: '+'
};

function normalizeKey(raw: string): string {
  const s = String(raw || '').trim();
  const lower = s.toLowerCase();
  // 单字符（字母/数字/符号）按原样小写比对；e.key 的字母在按住 Shift 时是大写
  return KEY_ALIAS[lower] || lower;
}

export type ParsedCombo = {
  ctrl: boolean;
  /** Mod：Ctrl 或 Cmd（二者任一即可） */
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

/**
 * 解析 `Ctrl+Shift+K` 这种描述。纯函数，便于单测。
 * 无法识别的片段按普通键处理（比如 `?`、`/`）。
 */
export function parseCombo(combo: string): ParsedCombo {
  const out: ParsedCombo = { ctrl: false, mod: false, alt: false, shift: false, key: '' };
  // 加号本身用别名 Plus 表示（例如 Ctrl+Plus），所以直接按 + 切分即可
  const parts = String(combo || '').split('+');

  for (const part of parts) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    if (p === 'ctrl' || p === 'control') out.ctrl = true;
    else if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super') out.mod = true;
    else if (p === 'mod') out.mod = true;
    else if (p === 'alt' || p === 'option') out.alt = true;
    else if (p === 'shift') out.shift = true;
    else out.key = normalizeKey(part);
  }
  return out;
}

/**
 * 判断一次键盘事件是否命中组合键。纯函数，便于单测。
 * 修饰键严格相等：多按了 Shift 就不算命中，少按了更不算。
 */
export function matchesHotkey(e: KeyboardEvent | any, combo: string): boolean {
  if (!e) return false;
  const want = parseCombo(combo);
  if (!want.key) return false;

  const ctrl = !!e.ctrlKey;
  const meta = !!e.metaKey;
  const alt = !!e.altKey;
  const shift = !!e.shiftKey;

  // Ctrl 与 Mod 分开判断：写了 Mod 就 Ctrl/Cmd 任一都行，写了 Ctrl 就只认 Ctrl。
  // 没写主修饰键时，按了 Ctrl/Cmd 也不算命中（否则 Esc 会被 Ctrl+Esc 误触发）。
  if (want.ctrl) {
    if (!ctrl) return false;
  } else if (want.mod) {
    if (!(ctrl || meta)) return false;
  } else if (ctrl || meta) {
    return false;
  }

  if (want.alt !== alt) return false;
  if (want.shift !== shift) return false;

  return normalizeKey(e.key) === want.key;
}

/**
 * 挂一个 window 级 keydown 监听。
 * @param map 组合键 → 处理函数（每次渲染用最新的一份，避免闭包拿到旧 state）
 * @param enabled false 时完全不挂监听
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const latest = useRef<HotkeyMap>(map);
  latest.current = map;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    const onKeyDown = (e: KeyboardEvent) => {
      const entries = Object.entries(latest.current || {});
      for (const [combo, handler] of entries) {
        if (typeof handler !== 'function') continue;
        if (!matchesHotkey(e, combo)) continue;
        e.preventDefault();
        handler(e);
        return;
      }
    };

    // 捕获阶段监听：输入框 / Select 自己 onKeyDown 里 stopPropagation 也拦不住全局快捷键。
    // Esc 先过我们这层、再交给 antd 关下拉（preventDefault 不阻断冒泡，两边都能工作）。
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}

export default useHotkeys;