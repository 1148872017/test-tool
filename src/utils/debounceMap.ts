/**
 * 每个字段各自独立的 debounce 保存器（纯逻辑，不依赖 React，可直接单测）。
 *
 * 为什么要有这个东西（踩坑 #100 的第二次修复）：
 *   设置页有 8 个目录输入框，原来是共用**一个** useRef 计时器：
 *
 *     if (dirSaveTimer.current) clearTimeout(dirSaveTimer.current);
 *     dirSaveTimer.current = setTimeout(() => save({ [key]: value }), 600);
 *
 *   在「用例目录」敲完路径后 600ms 内又去改「压测目录」，
 *   前一个字段的计时器就被 clearTimeout 掉了 —— 那个 key 的值永远不落库，
 *   界面上没有任何提示。这就是「填了目录切页面再回来变空」的真凶
 *   （v0.41.2 只补了初始化，没修这个）。
 *
 * 现在的做法：每个字段一个计时器 + 一个待保存值，各算各的，互不影响。
 *   - save(key, value)   记下待保存值，并把该字段的计时器重新计时
 *   - flushOne(key)      立刻发出这个字段（计时器还在也先清掉，保证只发一次）
 *   - flushAll()         立刻发出全部待保存字段（卸载 / 关窗口 / 失焦时兜底）
 *   - pendingCount()     还有几个字段没落库
 */

/** 保存函数：接收一个「字段名 → 值」的补丁，和设置页的 saveSettings 同签名 */
export type DebounceSaveFn = (patch: Record<string, string>) => unknown;

export type DebouncedSaver = {
  /** 记下一个字段的最新输入，delayMs 后自动发出 */
  save: (key: string, value: string) => void;
  /** 立刻发出单个字段；真的发出了返回 true */
  flushOne: (key: string) => boolean;
  /** 立刻发出全部待保存字段；返回发出的字段数 */
  flushAll: () => number;
  /** 这个字段还有没有没落库的输入 */
  hasPending: (key: string) => boolean;
  /** 还有几个字段没落库 */
  pendingCount: () => number;
  /** 有哪些字段没落库（调试 / 测试用） */
  pendingKeys: () => string[];
  /** 先 flush 再丢弃内部状态（组件卸载后的清理用） */
  dispose: () => void;
};

/** 兼容浏览器（number）和 Node（Timeout 对象）两种 setTimeout 返回值 */
type Timer = ReturnType<typeof setTimeout>;

export function createDebouncedSaver(saveFn: DebounceSaveFn, delayMs = 600): DebouncedSaver {
  // 每个字段自己的计时器：key 是字段名（如 casesDir），不是下标
  const timers = new Map<string, Timer>();
  // 每个字段的最新待保存值
  const pending = new Map<string, string>();

  /** 清掉某个字段的计时器（没挂计时器就什么都不做） */
  const clearTimer = (key: string) => {
    const t = timers.get(key);
    if (t) {
      clearTimeout(t);
      timers.delete(key);
    }
  };

  /** 立刻发出单个字段：先停表，再取值，取完立刻从 pending 删掉（避免重复发） */
  const flushOne = (key: string) => {
    clearTimer(key);
    if (!pending.has(key)) return false;
    const value = pending.get(key) as string;
    pending.delete(key);
    try {
      saveFn({ [key]: value });
    } catch (e) {
      // 单个字段保存失败不能连累其它字段：外面还有别的字段等着 flush，
      // 这里吞掉异常，让 flushAll 能把剩下的都发出去（失败本身由 saveFn 自己提示）
    }
    return true;
  };

  /** 立刻发出全部待保存字段（先拍快照，flushOne 会改 Map，边遍历边删会漏） */
  const flushAll = () => {
    let sent = 0;
    for (const key of [...pending.keys()]) {
      if (flushOne(key)) sent++;
    }
    // 防御：万一有计时器还挂着但已经没有待保存值，也清掉，不留悬空计时器
    for (const key of [...timers.keys()]) clearTimer(key);
    return sent;
  };

  /** 记下输入并重新计时（同一个字段连改多次只发最后一次） */
  const save = (key: string, value: string) => {
    if (!key) return;
    pending.set(key, value);
    // 只重置这个字段自己的计时器，别的字段完全不受影响 —— 这就是本模块存在的理由
    clearTimer(key);
    timers.set(
      key,
      setTimeout(() => {
        flushOne(key);
      }, delayMs)
    );
  };

  return {
    save,
    flushOne,
    flushAll,
    hasPending: (key: string) => pending.has(key),
    pendingCount: () => pending.size,
    pendingKeys: () => [...pending.keys()],
    dispose: () => {
      flushAll();
      timers.clear();
      pending.clear();
    }
  };
}