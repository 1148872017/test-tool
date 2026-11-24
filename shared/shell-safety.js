'use strict';
/**
 * shell-safety.js —— 拼进命令行之前先过一遍白名单。
 *
 * ============================================================
 * 为什么要有这一层
 * ============================================================
 * 老实现（v0.42.0）：
 *   1. shared/runners.js 把测试类名直接拼成 `-Dtest=` + ctx.testClass；
 *   2. electron/runner.js 对 .cmd/.bat 用 `shell: true` 启动。
 * Node 在 shell 模式下**不转义参数**（它只是把 argv 用空格拼起来丢给
 * cmd.exe / sh），于是
 *   testClass = `Foo & calc`
 * 会变成两条命令：`mvn -q test -Dtest=Foo` 和 `calc`。实测可执行任意命令。
 *
 * 修法两层，缺一不可：
 *   - **结构层**：不再 shell:true，改成
 *     `cmd.exe /d /s /c ""C:\a b\mvn.cmd" "-q" "test""`（见 buildCmdExeInvocation），
 *     参数由我们逐个加引号组成 argv，cmd.exe 拿到的是一条**已定型**的命令行；
 *   - **校验层**：本文件。testClass 只认类名字符，路径不许出现会被 cmd 解释的字符。
 *     即便将来有人又改回 shell:true，非法串也进不来。
 *
 * 约定：校验函数**不抛异常**，返回 `{ ok: true, value }` 或
 * `{ ok: false, code, message }` —— 调用方要把 message 原样回给界面，
 * 抛出去会被 IPC 包成 "Error invoking remote method"，用户看不懂。
 */

/**
 * Maven `-Dtest` 只接受类名/方法名：字母或 _ / $ 开头，
 * 后面只允许字母数字、下划线、`.`（包名分隔）、`$`（内部类）、`#`（方法）。
 *
 * 明确禁止：空格、`/`、`&`、`|`、`"`、`;`、`>`、`<`、`%`、`!`。
 */
const TEST_CLASS_RE = /^[A-Za-z_$][\w.$#]*$/;

/**
 * 会被 cmd.exe（或 sh）解释的字符。
 *
 * 为什么允许空格和圆括号：
 *   `C:\Program Files (x86)`、`D:\My Project` 是常见合法目录；
 *   去掉 shell 之后参数是 argv、每个都带引号，空格本身没有危险。
 * 为什么不放 `*` `?`：
 *   Windows 文件名里本来就不允许它们，出现在入参里只可能是注入尝试。
 */
const UNSAFE_PATH_RE = /[\0-\x1f"&|<>^%!`*?\r\n]/;

/**
 * 校验 Maven 测试类名。
 * 空串是合法状态（= 跑全部用例），跟老行为一致。
 *
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, code: string, message: string}}
 */
function assertTestClass(value) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) return { ok: true, value: '' };
  if (v.length > 512) {
    return { ok: false, code: 'BAD_TEST_CLASS', message: '测试类名太长了（超过 512 字符）' };
  }
  if (!TEST_CLASS_RE.test(v)) {
    return {
      ok: false,
      code: 'BAD_TEST_CLASS',
      message: '测试类名不合法，只允许字母数字下划线和 . $ #'
    };
  }
  return { ok: true, value: v };
}

/**
 * 校验会被拼进命令行的路径（jmx 脚本、项目目录、脚本文件…）。
 *
 * @param {unknown} value
 * @param {string} label 提示语里的字段中文名，例如「项目目录」
 * @returns {{ok: true, value: string} | {ok: false, code: string, message: string}}
 */
function assertCommandPath(value, label) {
  const tag = label || '路径';
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (!v) return { ok: true, value: '' };
  if (v.length > 4096) {
    return { ok: false, code: 'BAD_PATH', message: '「' + tag + '」太长（超过 4096 字符）' };
  }
  if (UNSAFE_PATH_RE.test(v)) {
    return {
      ok: false,
      code: 'BAD_PATH',
      message: '「' + tag + '」里含有会被命令行解释的字符（& | < > ^ % ! " * ?），已拒绝执行'
    };
  }
  return { ok: true, value: v };
}

/** cmd.exe 的绝对路径（拿不到就用 PATH 里的 cmd.exe） */
function comspec() {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.comspec) return process.env.comspec;
  } catch (e) {
    /* 浏览器打包场景没有 process，忽略 */
  }
  return 'cmd.exe';
}

/**
 * 把一个参数安全地放进 cmd.exe 命令行。
 *
 * 引号 / 换行没法在 cmd 的引号内表达，直接拒绝 —— 正常路径里不会有它们。
 * @param {unknown} value
 * @returns {string} 带引号的参数
 */
function quoteWinArg(value) {
  const s = String(value === undefined || value === null ? '' : value);
  if (/["\r\n\0]/.test(s)) {
    throw new Error('参数里不能有引号或换行：' + s.slice(0, 80));
  }
  return '"' + s + '"';
}

/**
 * 构造「用 cmd.exe 执行 .cmd/.bat」的 spawn 参数。
 *
 * 为什么不是 shell:true：见文件头。
 * 为什么是这一串：Windows 上要让 cmd.exe 既认带空格的程序路径、
 * 又不把参数里的 `&` 当成命令分隔符，实测（2026-11 本机验证）只有
 * 「整条命令再包一层引号 + windowsVerbatimArguments」这种写法同时满足：
 *
 *   cmd.exe /d /s /c ""C:\a b\x.cmd" "-t" "D:\x.jmx""
 *
 * 实测结论（探针 scripts 里没有保留，结论记在这）：
 *   - 形态「/c "cmd" "-t" ...」（不包外壳引号）→ 路径带空格时整条命令找不到；
 *   - 形态「/c "cmd" args」+ 逐项引号 → 正常；
 *   - 传入 `Foo & echo INJECTED` → 原样进 %1，不会被当成第二条命令。
 *
 * @param {string} cmd 可执行文件（.cmd / .bat）
 * @param {string[]} [args]
 * @returns {{file: string, args: string[], windowsVerbatimArguments: boolean}}
 */
function buildCmdExeInvocation(cmd, args) {
  const line = [quoteWinArg(cmd)]
    .concat((args || []).map((a) => quoteWinArg(a)))
    .join(' ');
  return {
    file: comspec(),
    // /d 跳过 AutoRun、/s 让 cmd 只剥最外层引号、/c 执行完退出
    args: ['/d', '/s', '/c', '"' + line + '"'],
    windowsVerbatimArguments: true
  };
}

module.exports = {
  TEST_CLASS_RE,
  UNSAFE_PATH_RE,
  assertTestClass,
  assertCommandPath,
  quoteWinArg,
  buildCmdExeInvocation
};