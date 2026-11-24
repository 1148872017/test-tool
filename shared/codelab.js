'use strict';
/**
 * 代码调试的纯逻辑 —— 超时钳制 / 语言→运行计划 / Java 类名 / 进程树 kill 参数。
 *
 * 为什么抽出来（全部是纯函数，不碰 fs、不碰 electron）：
 *   1. 超时钳制最容易写错：前端传个 999999 或 "abc"，主进程不能照单全收；
 *   2. Java 是两步（javac → java），文件名必须等于 public class 名，
 *      编译失败还继续跑会报 "class not found"，把用户带沟里；
 *   3. Windows 上 child.kill() 杀不掉孙子进程（java 启动的进程树），
 *      必须 taskkill /T /F，参数拼错就杀不干净。
 *   这些规则脱离 fs/electron 也能断言，所以放在 shared/ 里给单测和主进程共用。
 */

/** 默认超时：15 秒（够跑完一段调试脚本，又不会让人干等） */
const DEFAULT_TIMEOUT_MS = 15000;
/** 上限：60 秒（再长就该用正式运行器，不该在调试页里等） */
const MAX_TIMEOUT_MS = 60000;
/** 下限：1 秒（小于 1 秒基本是误传，编译器/解释器启动都不够） */
const MIN_TIMEOUT_MS = 1000;

/** 支持的单文件语言 */
const SUPPORTED = ['javascript', 'python', 'java'];

/**
 * 单文件调试的语言清单（前端「运行器」下拉里的「单文件调试」一组）。
 *
 * 和 shared/runners.js 的 RUNNERS 分开：
 *   RUNNERS 是「框架级运行器」（Groovy 走 JMeter、pytest、Maven 项目），
 *   这里是「一段代码直接跑」，两者的 needs / 执行方式都不一样。
 *   混在一张表里会让「4 个运行器」这类既有断言和语义都变味。
 */
const CODE_LANGS = [
  {
    key: 'javascript',
    lang: 'javascript',
    label: 'JavaScript（Node）',
    desc: '用本机 Node 直接跑一段 .js，不需要项目',
    ext: '.js',
    needs: ['node'],
    template: `// JavaScript 调试：直接跑，输出走标准输出
console.log('Hello from Node', process.version);

const nums = [1, 2, 3, 4];
const sum = nums.reduce((a, b) => a + b, 0);
console.log('合计：', sum);

// 断言失败要退出码非 0，调试时看得出来
if (sum !== 10) {
  console.error('断言失败：合计应为 10，实际', sum);
  process.exit(1);
}
console.log('断言通过');
`
  },
  {
    key: 'java',
    lang: 'java',
    label: 'Java（单文件）',
    desc: 'javac 编译 + java 运行；类名自动按 public class 取名',
    ext: '.java',
    needs: ['java', 'javac'],
    template: `/**
 * Java 单文件调试。
 *
 * 注意：文件名必须和 public class 名一致（这里会写成 Main.java），
 * 所以类名要么保持 Main，要么改成你想要的类名——程序会自动跟着改。
 */
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello from Java " + System.getProperty("java.version"));

        int sum = 0;
        for (int i = 1; i <= 4; i++) {
            sum += i;
        }
        if (sum != 10) {
            System.err.println("断言失败：合计应为 10，实际 " + sum);
            System.exit(1);
        }
        System.out.println("断言通过，合计 " + sum);
    }
}
`
  }
];

/**
 * 把超时钳到 [1000, 60000]。
 *
 * 规则（前端传什么都别信）：
 *   - 非数字 / NaN / Infinity / undefined / null → 回落 15000
 *   - 0 和负数 → 当作「没传」，回落 15000
 *   - 大于 0 的合法数字 → 夹到 [1000, 60000]（500 抬到 1000，99999 压到 60000）
 *
 * @param {*} ms 前端传来的超时（毫秒）
 * @returns {number} 钳制后的毫秒数
 */
function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  if (n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (n > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.round(n);
}

/**
 * taskkill 参数（Windows 杀整棵进程树）。
 *
 * 为什么必须 /T：`child.kill()` 只杀直接子进程，
 * java / mvn 自己还会 fork 孙子进程，父进程没了孙子还在，
 * 端口被占、文件锁住，下一次运行直接失败。/T 才是连树一起杀。
 *
 * @param {number|string} pid 进程号
 * @returns {string[]} ['/PID','1234','/T','/F']，pid 非法时返回空数组（调用方跳过）
 */
function buildTaskkillArgs(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return [];
  return ['/PID', String(Math.trunc(p)), '/T', '/F'];
}

/**
 * 去掉 Java 代码里的注释与字符串字面量。
 *
 * 为什么需要：注释里写「// public class Foo 已废弃」或者字符串里写
 * "public class Bar"，正则直接扫会把它们当成真正的类声明，
 * 文件名就取错了——javac 立刻报「类 X 是公共的，应在 X.java 中声明」。
 * 所以先过一遍词法扫描，把注释和字符串抹成空格（保留换行，行号不变）。
 *
 * @param {string} code
 * @returns {string} 抹掉注释/字符串后的代码
 */
function stripJavaNoise(code) {
  const src = String(code == null ? '' : code);
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';

    // 行注释：// 到行尾
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    // 块注释：/* ... */（未闭合也要吃掉，避免后面的内容被当成代码）
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    // 字符串 / 字符字面量：里面的内容不算代码
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        // 转义：\" 不结束字符串
        if (src[i] === '\\' && i + 1 < n) {
          out += ' ';
          i++;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * 从 Java 代码里找「文件名该叫什么」。
 *
 * 优先 public class（Java 规定 public 类名必须等于文件名），
 * 其次任意 class，都没有就兜底 Main（比如一段只有方法的片段）。
 *
 * @param {string} code
 * @returns {string} 类名（一定是合法 Java 标识符）
 */
function javaClassName(code) {
  const text = stripJavaNoise(code);

  // public class Foo / public final class Foo / public abstract class Foo
  const pub = /public\s+(?:(?:final|abstract|strictfp)\s+)*class\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (pub) return pub[1];

  // 任意 class Bar（含内部类、非 public 类）
  const any = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (any) return any[1];

  return 'Main';
}

/**
 * 语言 + 代码 + 运行时 → 运行计划（写什么文件、跑什么命令）。
 *
 * runtime 就用 detectRuntimes() 的返回结构（`{node:{path},python:{path},java:{java,javac}}`），
 * 这样主进程不用再做一层转换。
 *
 * @param {{lang:string, code:string, dir:string, runtime?:object}} input
 * @returns {{lang:string, files:{name:string,content:string}[], steps:{cmd:string,args:string[],cwd:string,env?:object}[], className:string}}
 * @throws {Error} 语言不支持 / 缺运行时（中文错误，直接给用户看）
 */
function buildRunPlan(input) {
  const { lang, code, dir, runtime } = input || {};
  const l = String(lang || '').toLowerCase();
  if (!SUPPORTED.includes(l)) throw new Error('不支持的语言：' + (lang === undefined ? '(空)' : lang));

  const src = String(code == null ? '' : code);
  const rt = runtime || {};
  const cwd = String(dir || '');

  if (l === 'javascript') {
    const node = rt.node || {};
    if (!node.ok || !node.path) throw new Error('没有找到 Node 运行时，请安装 Node.js 后重试');
    return {
      lang: l,
      className: '',
      files: [{ name: 'main.js', content: src }],
      steps: [
        {
          cmd: node.path,
          args: ['main.js'],
          cwd,
          // 没有独立 Node 时用应用自带的 Electron 当 Node 跑
          env: node.viaElectron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
        }
      ]
    };
  }

  if (l === 'python') {
    const py = rt.python || {};
    if (!py.ok || !py.path) throw new Error('没有找到 Python，请安装或在设置里指定');
    return {
      lang: l,
      className: '',
      files: [{ name: 'main.py', content: src }],
      // -u 关掉输出缓冲：不然 print 的输出要等进程结束才一次性出来，调试时等于没有流式
      steps: [{ cmd: py.path, args: ['-u', 'main.py'], cwd }]
    };
  }

  // java：先查 javac 再查 java —— 只装 JRE 时先提示「需要 JDK 不是 JRE」，
  // 而不是含糊地报「找不到 java」（JRE 其实有 java，误导点就在这里）
  const javaRt = rt.java || {};
  if (!javaRt.javac) throw new Error('没有找到 javac（只装 JRE 不行，需要 JDK）');
  if (!javaRt.java) throw new Error('没有找到 java（JDK 里的 bin/java 也找不到）');

  const className = javaClassName(src);
  const file = className + '.java';
  return {
    lang: l,
    className,
    files: [{ name: file, content: src }],
    steps: [
      { cmd: javaRt.javac, args: [file], cwd },
      // classpath 用当前目录：编译产物就在这里，不写 -cp . 有的环境找不到类
      { cmd: javaRt.java, args: ['-cp', '.', className], cwd }
    ]
  };
}

/**
 * 拆分「编译步骤」与「运行步骤」。
 *
 * Java 两步时：compile = [javac]，run = [java]；
 * 单步时（js/python）：compile = []，run = [那一步]。
 * 主进程必须**编译成功才继续跑**，否则 javac 报错后 java 报 "class not found"，
 * 用户会去查类名/包名，其实问题在编译。
 *
 * @param {{steps?:{cmd:string,args:string[]}[]}} plan
 * @returns {{compile:object[], run:object[]}}
 */
function splitSteps(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) return { compile: [], run: [] };
  return { compile: steps.slice(0, steps.length - 1), run: steps.slice(steps.length - 1) };
}

/**
 * 命令行展示文本（输出面板里回显「跑的是什么」）。
 *
 * 只留命令名（去掉目录和 .exe/.cmd 后缀）：
 *   D:\jdk-17\bin\javac.exe → javac
 * 用户要认的是「跑的是哪条命令」，不是一长串安装路径。
 *
 * @param {{cmd:string, args:string[]}} step
 * @returns {string} 形如 `javac Main.java`
 */
function stepCommandLine(step) {
  const s = step || {};
  const args = Array.isArray(s.args) ? s.args : [];
  const cmd = String(s.cmd || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|com)$/i, '');
  return [cmd].concat(args).join(' ');
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SUPPORTED,
  CODE_LANGS,
  clampTimeout,
  buildTaskkillArgs,
  stripJavaNoise,
  javaClassName,
  buildRunPlan,
  splitSteps,
  stepCommandLine
};