'use strict';
/**
 * ipc-runner.js —— 代码调试（运行器 + 单文件调试 + 项目扫描）域的 IPC。
 * 从 main.js 搬迁而来，通道名/参数/返回值与搬迁前完全一致。
 *
 * 跑代码时输出通过事件流式推给渲染进程：
 *   runner:output  { runId, stream: 'stdout'|'stderr', text }
 *   runner:exit    { runId, code, signal, duration, timedOut, timeoutMs, phase }
 *
 * 两种跑法：
 *   1. 运行器（runnerKey）：Groovy / Python / pytest / Maven —— 配置在 shared/runners.js
 *   2. 单文件调试（lang）：javascript / python / java —— 计划由 shared/codelab.js 生成
 *
 * 为什么单文件调试要单独一条路：
 *   Java 是**两步**（javac 编译 → java 运行），编译失败必须停下，
 *   否则 java 报 "class not found"，用户会去查类名，其实问题在编译。
 *   这套「语言 → 文件 + 步骤」的逻辑抽在 shared/codelab.js 里（纯函数，可单测）。
 */
const runner = require('../runner');
const projects = require('../projects');
const { RUNNERS, listRunners } = require('../../shared/runners');
const codelab = require('../../shared/codelab');
const { acceptScanRoot } = require('../shared-helpers');

/**
 * 正在跑的单文件调试任务：runId → { stepId }
 *
 * 为什么要这张表：一段 Java 是「javac 步骤 + java 步骤」两次 spawn，
 * 而 runner:run 返回给前端的是**整段任务的 runId**。
 * 前端点「取消」时拿的是这个 id，得靠它找到当前那一步的真实进程 id 才能杀。
 */
const planRuns = new Map();

/** 单文件调试的任务序号（runId 的一部分，避免同一毫秒撞名） */
let planSeq = 0;

function register(deps) {
  const { handle, dialog, shell, app, fs, path, getWindow, getSettings, assertUnlocked, assertPathIn, rememberPicked } = deps;

  /**
   * 探测单文件调试需要的运行时。
   *
   * 和 runner:list 的 env 分开的原因：那边的 java 只回答「有没有 java」；
   * 这边必须把 **java 和 javac 分开报** —— 只装 JRE 时 java 有、javac 没有，
   * 界面上要能直接看出来「需要 JDK 不是 JRE」，而不是等用户点了运行才报错。
   */
  function detectRuntimes() {
    const settings = getSettings();
    const isWin = process.platform === 'win32';
    const exists = (p) => {
      try {
        return !!p && fs.existsSync(p);
      } catch (e) {
        return false;
      }
    };
    const binOf = (home, name) => (home ? path.join(home, 'bin', isWin ? name + '.exe' : name) : '');

    // Node：优先 PATH 里的真 Node；没有就用应用自带的 Electron（挂 ELECTRON_RUN_AS_NODE=1 当 Node 跑）
    const nodeFromPath = runner.detect('node');
    const node = nodeFromPath
      ? { ok: true, path: nodeFromPath, viaElectron: false }
      : { ok: !!process.execPath, path: process.execPath || '', viaElectron: true };

    // Python：设置页手动指定的优先（用户装了非标准路径的 Python）
    const manualPython = String(settings.pythonPath || '').trim();
    const pythonPath =
      manualPython && exists(manualPython) ? manualPython : runner.detect('python') || runner.detect('python3');

    // Java：和 Maven 一致用 JAVA_HOME 那套（detectJavaHome 会挑最合适的 JDK）
    const javaHome = String(settings.javaHome || '').trim() || runner.detectJavaHome();
    const javaFromHome = binOf(javaHome, 'java');
    const javacFromHome = binOf(javaHome, 'javac');
    const javaExe = runner.detect('java') || (exists(javaFromHome) ? javaFromHome : '');
    const javacExe = runner.detect('javac') || (exists(javacFromHome) ? javacFromHome : '');

    return {
      node,
      python: { ok: !!pythonPath, path: pythonPath || '' },
      // java.ok 要求两个都在：只有 JRE 时 java.ok = false，界面据此灰掉 Java
      java: { ok: !!javaExe && !!javacExe, java: javaExe || '', javac: javacExe || '' },
      supported: codelab.SUPPORTED.slice()
    };
  }

  /** 往渲染进程推事件（窗口关了就静默丢弃） */
  function sendToWindow(channel, data) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }

  /**
   * 单文件调试：按运行计划跑。
   *
   * 返回得很早（只把 runId 和命令给前端），真正的执行在后台推进，
   * 输出/结束都走事件 —— 和原来的 runner:run 行为一致，
   * 这样「取消」按钮在长脚本里仍然可用。
   */
  function startLanguageRun(lang, payload, timeoutMs) {
    const code = String(payload.code === undefined || payload.code === null ? '' : payload.code);
    if (!code.trim()) return { ok: false, message: '代码是空的，写点东西再点运行' };

    const runtime = detectRuntimes();
    let plan;
    try {
      plan = codelab.buildRunPlan({ lang, code, dir: '', runtime });
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }

    // 临时目录：一次运行一个，退出时删（class 文件跟着一起清）
    const dir = path.join(app.getPath('temp'), 'test-tool-codelab', 'run-' + Date.now() + '-' + ++planSeq);
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of plan.files) fs.writeFileSync(path.join(dir, f.name), f.content, 'utf8');
    } catch (err) {
      return { ok: false, message: '准备临时目录失败：' + String((err && err.message) || err) };
    }
    // cwd 用真实目录（纯函数里不知道 tmp 在哪）
    for (const step of plan.steps) step.cwd = dir;

    const runId = 'codelab-' + Date.now() + '-' + planSeq;
    const started = Date.now();
    const deadline = started + timeoutMs;
    const entry = { stepId: '', canceled: false };
    planRuns.set(runId, entry);

    const send = (channel, data) => sendToWindow(channel, Object.assign({ runId }, data));

    const finish = (result) => {
      planRuns.delete(runId);
      send(
        'runner:exit',
        Object.assign({ timeoutMs: timeoutMs, phase: 'run', canceled: entry.canceled }, result)
      );
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        /* 删不掉就算了，系统临时目录会自己清 */
      }
    };

    /** 跑一步：复用 runner.run（spawn + 解码 + 超时杀进程树都在里面） */
    const execStep = (step) =>
      new Promise((resolve) => {
        const id = runner.run({
          cmd: step.cmd,
          args: step.args,
          cwd: step.cwd,
          env: step.env,
          // 剩余预算：Java 两步共享同一个超时，编译吃掉的要从运行里扣
          timeout: Math.max(1, deadline - Date.now()),
          onData: (chunk) => send('runner:output', chunk),
          onExit: (result) => resolve(result)
        });
        entry.stepId = id;
      });

    const steps = codelab.splitSteps(plan);

    // 后台推进，不阻塞 IPC 返回
    (async () => {
      // ---- 1. 编译（只有 Java 有这一步）----
      for (const step of steps.compile) {
        send('runner:output', { stream: 'stdout', text: '$ ' + codelab.stepCommandLine(step) + '\n' });
        if (deadline - Date.now() <= 0) {
          finish({ code: -1, signal: null, duration: Date.now() - started, timedOut: true, phase: 'compile' });
          return;
        }
        const r = await execStep(step);
        if (entry.canceled) {
          finish({ code: r.code, signal: r.signal, duration: Date.now() - started, timedOut: false, phase: 'compile', message: '已取消' });
          return;
        }
        if (r.timedOut) {
          finish({ code: r.code, signal: r.signal, duration: Date.now() - started, timedOut: true, phase: 'compile' });
          return;
        }
        if (r.code !== 0) {
          // 关键：编译不过就**不再运行**，否则只会看到 "class not found"
          send('runner:output', {
            stream: 'stderr',
            text: '\n[编译失败，已停止运行] javac 报错说明代码本身有问题；继续跑只会得到 "class not found"，所以这里不再执行。\n'
          });
          finish({
            code: r.code,
            signal: r.signal,
            duration: Date.now() - started,
            timedOut: false,
            phase: 'compile',
            message: '编译失败（退出码 ' + r.code + '），已停止运行'
          });
          return;
        }
      }

      // ---- 2. 运行 ----
      let last = { code: 0, signal: null, timedOut: false };
      for (const step of steps.run) {
        send('runner:output', { stream: 'stdout', text: '$ ' + codelab.stepCommandLine(step) + '\n' });
        if (deadline - Date.now() <= 0) {
          finish({ code: -1, signal: null, duration: Date.now() - started, timedOut: true, phase: 'run' });
          return;
        }
        last = await execStep(step);
        if (entry.canceled) {
          finish({ code: last.code, signal: last.signal, duration: Date.now() - started, timedOut: false, phase: 'run', message: '已取消' });
          return;
        }
        if (last.timedOut) {
          finish({ code: last.code, signal: last.signal, duration: Date.now() - started, timedOut: true, phase: 'run' });
          return;
        }
        if (last.code !== 0 || last.error) {
          finish({
            code: last.code,
            signal: last.signal,
            duration: Date.now() - started,
            timedOut: false,
            phase: 'run',
            message: last.error ? String(last.error) : ''
          });
          return;
        }
      }

      finish({ code: last.code, signal: last.signal, duration: Date.now() - started, timedOut: false, phase: 'run' });
    })().catch((err) => {
      finish({
        code: -1,
        signal: null,
        duration: Date.now() - started,
        timedOut: false,
        phase: 'run',
        message: '运行失败：' + String((err && err.message) || err)
      });
    });

    return {
      ok: true,
      runId,
      lang: plan.lang,
      cmd: plan.steps[0].cmd,
      args: plan.steps[0].args,
      cwd: dir,
      file: plan.files[0] ? plan.files[0].name : '',
      className: plan.className,
      steps: plan.steps.length,
      timeoutMs
    };
  }

  /** 运行器列表 + 完整环境状态（给前端下拉和状态面板） */
  handle('runner:list', async () => {
    assertUnlocked();
    const settings = getSettings();
    const env = runner.detectAll();
    // JMeter 路径从 settings 取（detectAll 里没有）
    env.jmeter = settings.jmeterPath || '';
    return {
      ok: true,
      runners: listRunners(),
      env,
      // 多版本列表（设置页下拉用）
      jdks: runner.listJdks(),
      pythons: runner.listPythons(),
      // 手动指定的路径（空 = 自动）
      manual: {
        javaHome: settings.javaHome || '',
        pythonPath: settings.pythonPath || '',
        mvnPath: settings.mvnPath || ''
      }
    };
  });

  /**
   * 单文件调试的运行环境（Node / Python / Java+javac）。
   *
   * 每次调用都重新探测（不缓存）：用户可能刚装完 JDK 就回来点「重新检测」。
   */
  handle('runner:detect', async () => {
    assertUnlocked();
    return detectRuntimes();
  });

  /** 打开 Playwright 浏览器缓存目录 */
  handle('runner:openBrowserDir', async () => {
    assertUnlocked();
    const pw = runner.detectPlaywrightBrowsers();
    if (!pw.dir) return { ok: false, message: '找不到缓存目录' };
    try {
      fs.mkdirSync(pw.dir, { recursive: true });
      await shell.openPath(pw.dir);
      return { ok: true, dir: pw.dir };
    } catch (e) {
      return { ok: false, message: String(e && e.message) };
    }
  });

  /** 扫描代码项目目录 */
  handle('projects:scan', async (e, { root } = {}) => {
    assertUnlocked();
    const settings = getSettings();
    const dir = (root && String(root).trim()) || settings.projectDir || '';
    // 扫描根守卫 + 记进会话白名单（v0.50.0 的 P0 修复，见 ipc-knowledge.js kb:scan）
    const badSeed = acceptScanRoot(dir);
    if (badSeed) return badSeed;
    return projects.scanProjects(dir);
  });

  /** 列出某个 Maven 项目的测试类 */
  handle('projects:testClasses', async (e, { dir } = {}) => {
    assertUnlocked();
    const d = String(dir || '').trim();
    if (!d) return { ok: false, classes: [], message: '缺少项目目录' };
    /**
     * 入参守卫（v0.50.0）：dir 是渲染进程给的路径，要读目录结构。
     * 正常流程不会踩到：下拉里的项目来自 projects:scan（已进白名单）
     * 或 projects:pickDir（选过即记）。越界回 OUTSIDE_ROOT，并保住 classes 字段形状。
     */
    const bad = assertPathIn(d);
    if (bad) return Object.assign({ classes: [] }, bad);
    return { ok: true, classes: projects.listTestClasses(d) };
  });

  /** 选项目目录 */
  handle('projects:pickDir', async () => {
    assertUnlocked();
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: '选择代码项目目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    // 这个目录不一定写进 settings，记进会话白名单（随后 projects:scan/testClasses 用它）
    rememberPicked(picked.filePaths[0]);
    return { ok: true, dir: picked.filePaths[0] };
  });

  /**
   * 跑代码。
   *
   * payload 有两种形态：
   *
   *   A. 单文件调试（lang 有值）
   *      lang        javascript / python / java
   *      code        代码内容
   *      timeout     超时（前端给 5000~60000，**主进程必须再钳一次**）
   *
   *   B. 运行器（runnerKey 有值，老路子）
   *      runnerKey   运行器（groovy / python / pytest / maven）
   *      code        代码内容（临时文件模式）
   *      file        已有文件路径（可选，优先用这个）
   *      projectDir  项目目录（maven 用）
   *      testClass   测试类名（maven 用）
   *      timeout     超时（同样会被钳）
   *
   * 输出通过 runner:output 事件流式推送，结束时推 runner:exit。
   */
  handle('runner:run', async (e, payload = {}) => {
    assertUnlocked();

    // 前端传什么都别信：0 / -1 / "abc" / 999999 都要落在 [1000, 60000]
    const timeoutMs = codelab.clampTimeout(payload.timeout);

    const lang = String(payload.lang || '').trim().toLowerCase();
    if (lang) return startLanguageRun(lang, payload, timeoutMs);

    const settings = getSettings();
    const key = String(payload.runnerKey || '').trim();
    const conf = RUNNERS[key];
    if (!conf) return { ok: false, message: '不认识的运行器：' + key };

    const env = runner.detectAll();
    // JMeter 路径从 settings 取
    // 注意：字段名是 jmeterPath（不是 jmeterDir）
    env.jmeter = settings.jmeterPath || '';

    // 手动指定的路径优先（设置 → 开发环境）
    if (settings.pythonPath) env.python = settings.pythonPath;
    if (settings.mvnPath) env.mvn = settings.mvnPath;

    // Maven 用 JAVA_HOME 决定 JDK 版本（不是 PATH 里的 java）。
    // 优先级：手动指定 > 按 pom.xml 版本自动选
    const projectDir = String(payload.projectDir || '').trim();
    if (settings.javaHome) {
      env.javaHome = settings.javaHome;
    } else if (key === 'maven' && projectDir) {
      const want = runner.readJavaVersion(projectDir);
      env.javaHome = runner.detectJavaHome(want);
    }

    // 代码内容 → 临时文件
    let file = String(payload.file || '').trim();
    let tmpFile = '';
    if (!file && payload.code) {
      const ext = conf.ext || '.txt';
      const tmpDir = path.join(app.getPath('temp'), 'test-tool-runner');
      fs.mkdirSync(tmpDir, { recursive: true });
      tmpFile = path.join(tmpDir, `run-${Date.now()}${ext}`);
      fs.writeFileSync(tmpFile, String(payload.code), 'utf8');
      file = tmpFile;
    }
    if (!file && conf.ext) {
      return { ok: false, message: '没有代码内容' };
    }

    const ctx = {
      java: env.java,
      python: env.python,
      mvn: env.mvn,
      jmeter: env.jmeter,
      projectDir: String(payload.projectDir || '').trim(),
      testClass: String(payload.testClass || '').trim(),
      file
    };

    const built = conf.build(ctx);
    if (built.error) {
      if (tmpFile) fs.rmSync(tmpFile, { force: true });
      return { ok: false, message: built.error };
    }

    // 先占位 runId，runner.run 内部会生成真正的 id
    let realRunId = '';
    realRunId = runner.run({
      cmd: built.cmd,
      args: built.args,
      cwd: built.cwd,
      // Maven 需要 JAVA_HOME 才能用对的 JDK
      env: env.javaHome ? { JAVA_HOME: env.javaHome } : undefined,
      timeout: timeoutMs,
      onData: (chunk) => {
        sendToWindow('runner:output', { runId: realRunId, ...chunk });
      },
      onExit: (result) => {
        sendToWindow('runner:exit', { runId: realRunId, ...result, timeoutMs, phase: 'run' });
        if (tmpFile) {
          try {
            fs.rmSync(tmpFile, { force: true });
          } catch (err) {
            /* ignore */
          }
        }
      }
    });

    return { ok: true, runId: realRunId, cmd: built.cmd, args: built.args, cwd: built.cwd, timeoutMs };
  });

  /** 取消正在跑的任务 */
  handle('runner:cancel', async (e, { runId } = {}) => {
    assertUnlocked();
    const id = String(runId || '');
    if (!id) return { ok: false };

    // 运行器模式：runId 就是进程 id
    if (runner.cancel(id)) return { ok: true };

    // 单文件调试：runId 是整段任务的 id，真正在跑的是「当前那一步」
    const entry = planRuns.get(id);
    if (entry && entry.stepId) {
      entry.canceled = true;
      return { ok: runner.cancel(entry.stepId) };
    }
    return { ok: false };
  });
}

module.exports = { register };