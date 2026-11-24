/**
 * 渲染进程访问 Electron 主进程的唯一入口。
 *
 * 为什么用 Proxy 惰性取 window.api，而不是 `const api = window.api`：
 *   1. 模块顶层直接取值，一旦 preload 失效（asar 漏文件 / 沙箱策略变化），
 *      拿到的是 undefined，之后每个调用点都以
 *      「Cannot read properties of undefined (reading 'xxx')」炸掉 ——
 *      报错位置和真实原因（预加载没注入）完全对不上，用户只能重启；
 *   2. 顶层直接 throw 更糟：React 还没挂载就抛，整窗白屏，
 *      ErrorBoundary 也接不住（边界只能接渲染阶段的错）。
 *
 * 现在的行为：模块加载永远成功，页面照常渲染；缺失时每个方法返回的 Promise
 * 都 reject 一个 ApiUnavailableError，由调用方 / ErrorBoundary 给出明确文案。
 */

/** 预加载脚本没注入时的错误：名字固定，便于 ErrorBoundary 给专属文案 */
export class ApiUnavailableError extends Error {
  constructor(prop: string) {
    super('Electron 预加载脚本没有注入（window.api 不存在），无法调用 ' + prop);
    this.name = 'ApiUnavailableError';
  }
}

/** 判定是否为「预加载缺失」错误（跨打包副本时 instanceof 会失效，用名字兜底） */
export function isApiUnavailableError(e: any): boolean {
  return !!e && (e instanceof ApiUnavailableError || e.name === 'ApiUnavailableError');
}

/** 每次都现取：预览模式先装 mock 再 mount，所以不能在模块加载时把值缓存下来 */
function readRaw(): any {
  if (typeof window === 'undefined') return undefined;
  return (window as any).api;
}

/** 缺失时返回的占位方法：调用即得到 rejected Promise */
function makeUnavailable(prop: string): (...args: any[]) => Promise<never> {
  return function unavailableMethod() {
    return Promise.reject(new ApiUnavailableError(prop));
  };
}

/**
 * 不会被当成「业务方法」的属性名。
 *
 * then / catch / finally：api 若被 async 函数返回或 await，
 *   会先读 then 判断是否 thenable；返回函数会导致误判成 thenable 并触发未处理拒绝。
 * toJSON / inspect / constructor：序列化与调试器会摸这些属性。
 */
const SKIP_PROPS = new Set(['then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor']);

const api: any = new Proxy(Object.create(null), {
  get(_target, prop) {
    // Symbol（如 Symbol.toStringTag / Symbol.iterator）交给引擎默认行为
    if (typeof prop === 'symbol') return undefined;

    const raw = readRaw();
    if (raw) {
      const value = raw[prop];
      // 方法绑定到真实对象上，避免调用方拿到的 this 是 Proxy
      return typeof value === 'function' ? value.bind(raw) : value;
    }

    if (SKIP_PROPS.has(prop)) return undefined;
    return makeUnavailable(prop);
  },

  has(_target, prop) {
    const raw = readRaw();
    return !!raw && prop in raw;
  }
});

export default api;
