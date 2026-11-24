/**
 * 运行输出环形缓冲（纯函数，可在 Node 里直接单测）。
 *
 * ============================================================
 * 为什么需要它
 * ============================================================
 * 原来 CodeRunnerPage 用 `setLines(prev => prev.concat([...]))` 无上限收集输出：
 *   - 跑一次 Maven 构建，几万行输出 = 几万个 state 对象常驻内存；
 *   - 每来一行 setState 一次 → 整个输出列表全量重渲染；
 *   - 渲染完还要 `scrollTop = scrollHeight` 强制重排一次。
 * 结果是「跑得越久越卡」，最后界面直接假死。
 *
 * 现在：输出先进这个环形缓冲，超出 cap 就丢最旧的（并记账），
 * 页面每 100ms 只从缓冲里取一次快照，渲染成本从「行数」变成「10 次/秒」。
 *
 * 设计取舍：
 *   1. 环形数组 + 头指针，push / 取快照都是 O(cap)，push 不搬数组；
 *   2. id 自增且**清空后也不回退** —— React 的 key 用 id，
 *      回退会让「清空再跑」的两批行撞 key，复用错节点；
 *   3. dropped() 是累计值：丢了多少行必须如实告诉用户，
 *      不能让人以为控制台里的就是全部输出。
 */

/** 控制台里的一行（一段子进程输出块，可能自带换行） */
export interface RunnerLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

/** 建议上限：2000 行足够看清一次构建的报错上下文，又不至于拖垮渲染 */
export const DEFAULT_LINE_CAP = 2000;

export interface LineBuffer {
  /** 追加一行；超过 cap 时丢掉最旧的一行 */
  push(stream: 'stdout' | 'stderr', text: string): void;
  /** 按时间顺序取当前快照（新数组，改它不影响缓冲） */
  lines(): RunnerLine[];
  /** 累计被丢掉的行数 */
  dropped(): number;
  /** 清空缓冲（含丢弃计数），但 id 继续往上走 */
  clear(): void;
}

export function createLineBuffer(cap: number): LineBuffer {
  // cap 非法（0 / 负数 / NaN / Infinity）时退化成 1，保证构造过程不会抛
  const n = Math.floor(Number(cap));
  const capacity = Number.isFinite(n) && n >= 1 ? n : 1;

  const ring: RunnerLine[] = new Array(capacity);
  /** 最旧一行在 ring 里的下标 */
  let start = 0;
  /** 当前有效行数 */
  let count = 0;
  /** 自增行 id：从 1 开始，clear 之后继续往上走 */
  let nextId = 0;
  let droppedCount = 0;

  function push(stream: 'stdout' | 'stderr', text: string): void {
    const line: RunnerLine = { id: ++nextId, stream, text: String(text) };
    if (count < capacity) {
      ring[(start + count) % capacity] = line;
      count += 1;
      return;
    }
    // 满了：覆盖最旧的一格，头指针后移一位（新行正好落进刚空出来的位置）
    ring[start] = line;
    start = (start + 1) % capacity;
    droppedCount += 1;
  }

  function lines(): RunnerLine[] {
    const out: RunnerLine[] = new Array(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = ring[(start + i) % capacity];
    }
    return out;
  }

  function dropped(): number {
    return droppedCount;
  }

  function clear(): void {
    ring.fill(undefined as any);
    start = 0;
    count = 0;
    droppedCount = 0;
  }

  return { push, lines, dropped, clear };
}