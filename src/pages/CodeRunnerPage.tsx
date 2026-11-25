import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Button, Alert, Space, Modal, InputNumber, Input, Dropdown } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  ClearOutlined,
  CopyOutlined,
  FolderOpenOutlined,
  ReadOutlined,
  ImportOutlined,
  DownOutlined,
  ReloadOutlined,
  SettingOutlined,
  ProfileOutlined,
  CloseOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { CODE_LANGS, DEFAULT_TIMEOUT_MS, clampTimeout } from '../../shared/codelab';
import { RUN_KIND_OPTIONS, RUN_RESULT_OPTIONS, ENV_OPTIONS } from '../../shared/collections';
import { buildLedgerDraft } from '../features/runner/runLedger';
import {
  TEMPLATES as SCRIPT_TEMPLATES,
  CATEGORY_MAP,
  GROOVY_CATEGORIES,
  templateSnippet,
  insertCodeAtCursor
} from '../../shared/scriptTemplates';
import ScriptTemplatesDrawer from '../components/ScriptTemplatesDrawer';
import { createLineBuffer, DEFAULT_LINE_CAP } from '../features/runner/lineBuffer';
import type { RunnerLine } from '../features/runner/lineBuffer';
import OutputConsole from '../features/runner/OutputConsole';
import { useHotkeys } from '../hooks/useHotkeys';

type Runner = {
  key: string;
  label: string;
  desc: string;
  ext: string | null;
  needs: string[];
  /** 有值 = 单文件调试（javascript / python / java），执行计划在主进程按语言生成 */
  lang?: string;
};

type Project = {
  name: string;
  dir: string;
  type: string;
  frameworks: { key: string; label: string; color: string }[];
  isTest: boolean;
};

/** 输出批量刷进 state 的间隔（毫秒）：每来一行 setState 会把界面拖死 */
const FLUSH_INTERVAL = 100;

/** 单文件调试的运行环境（runner:detect 的返回） */
type Detect = {
  node: { ok: boolean; path: string; viaElectron?: boolean };
  python: { ok: boolean; path: string };
  /** java 和 javac 必须分开：只装 JRE 时 java 有、javac 没有 */
  java: { ok: boolean; java: string; javac: string };
  supported: string[];
};

/** 各运行器的代码模板 */
const TEMPLATES: Record<string, string> = {
  groovy: `// JMeter JSR223 脚本调试
// prev = 上一个采样器的结果（这里用 mock 数据模拟）
String code = prev.getResponseCode();
log.info("状态码：" + code);

// 断言
if (!"200".equals(code)) {
  AssertionResult.setFailure(true);
  AssertionResult.setFailureMessage("状态码不是 200，实际是：" + code);
} else {
  AssertionResult.setFailure(false);
  log.info("断言通过");
}
`,
  python: `# Python 脚本调试
print("Hello from Python")

# 试试 requests
try:
    import requests
    print("requests 已安装")
except ImportError:
    print("requests 未安装")
`,
  pytest: `# pytest 用例调试
import pytest


def test_add():
    assert 1 + 1 == 2


def test_fail():
    assert 1 + 1 == 3, "故意失败，看输出"
`,
  maven: `// Maven 项目不需要写代码
// 选项目 + 测试类，点「运行」即可
// 例如：项目 OTA-automation，测试类 LoginTest
// 等价于：mvn test -Dtest=LoginTest
`
};

/** 单文件调试语言的模板（模板本身定义在 shared/codelab.js，和运行计划放一起） */
const LANG_TEMPLATES: Record<string, string> = CODE_LANGS.reduce((acc: Record<string, string>, l: any) => {
  acc[l.key] = l.template || '';
  return acc;
}, {});

/** 环境名 → 中文 */
const ENV_LABEL: Record<string, string> = {
  node: 'Node.js',
  python: 'Python',
  java: 'Java（JDK）',
  javac: 'javac（JDK 里的编译器）',
  mvn: 'Maven',
  jmeter: 'JMeter'
};

/**
 * 环境名 → 可操作提示。
 *
 * 只写「缺少环境」没用，用户不知道下一步干什么，所以每条都要给出
 * 装什么 / 去哪儿指定路径。
 */
const ENV_HINT: Record<string, string> = {
  node: '请安装 Node.js（或改用正式版，应用自带 Node 也能跑）',
  python: '请安装 Python 3.10+，或在「设置 → 开发环境」里指定 python.exe',
  java: '请安装 JDK 17+（Maven 用 JAVA_HOME 找 JDK）',
  javac: '只有 JRE 跑不了 javac —— 需要 JDK 不是 JRE，装完 JDK 后把 JAVA_HOME 指过去',
  mvn: '请安装 Maven 3.8+',
  jmeter: '请在「设置 → 压测」里配置 JMeter 路径'
};

/**
 * 超时档位。
 *
 * 为什么给固定档位还留自定义：常见脚本 5~15 秒就够，
 * 但第一次跑 Maven/JDK 冷启动会慢，所以给到 60 秒；
 * 真需要更久的（比如等了很久的接口）就得自己填，
 * 不过主进程会把它钳在 [1, 60] 秒内 —— 前端只是「表达意愿」。
 */
const TIMEOUT_PRESETS = [
  { value: '5000', label: '5 秒' },
  { value: '10000', label: '10 秒' },
  { value: '15000', label: '15 秒' },
  { value: '30000', label: '30 秒' },
  { value: '60000', label: '60 秒' },
  { value: 'custom', label: '自定义' }
];

/** 提示条自动关闭时间（毫秒） */
const TIP_DURATION = 30000;

/**
 * 「记入执行账本」可以选的类型。
 *
 * 压测（perf）不在里面：代码调试就是跑一段代码/一个测试类，和压测指标
 * （并发 / TPS / P90）不是一回事，硬记成压测会把账本搅浑。
 */
const LEDGER_KINDS = RUN_KIND_OPTIONS.filter((o: any) => o.value !== 'perf');

/**
 * 模板分类 → 这个分类的脚本在 JMeter 里挂到哪个元件。
 *
 * 下拉分组用它做副标题：用户看到「断言 · JSR223 断言」就知道自己会在
 * JMeter 里找什么东西，而不是只看到库里自己的分类名。
 */
const GROUP_ELEMENT: Record<string, string> = {
  assert: 'JSR223 断言',
  extract: 'JSR223 后置处理器',
  generate: 'JSR223 前置处理器',
  crypto: 'JSR223 前置处理器',
  flow: 'JSR223 前置处理器 + If 控制器'
};

/** 代码调试页的模板库说明：调试页跑通 ≠ 断言生效，这句话必须出现在入口边上 */
const DRAWER_FOOTER_HINT =
  '点「插入到光标处」把代码插进编辑器（占位符已填默认值，注释保留）。' +
  '注意：本页只是用 groovy 跑一遍语法，断言/提取器真正生效要挂到 JMeter 的采样器上。';

/** 路径太长时只显示末尾两段，完整路径放 title 里（悬停能看全） */
function shortPath(p: string) {
  const s = String(p || '');
  if (!s) return '';
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return s;
  return '…/' + parts.slice(-2).join('/');
}

export default function CodeRunnerPage() {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [env, setEnv] = useState<any>({});
  const [detect, setDetect] = useState<Detect | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [runnerKey, setRunnerKey] = useState('groovy');
  const [code, setCode] = useState(TEMPLATES.groovy);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDir, setProjectDir] = useState('');
  const [testClasses, setTestClasses] = useState<string[]>([]);
  const [testClass, setTestClass] = useState('');

  // 超时：预设档位 + 自定义秒数
  const [timeoutPreset, setTimeoutPreset] = useState(String(DEFAULT_TIMEOUT_MS));
  const [customSeconds, setCustomSeconds] = useState(DEFAULT_TIMEOUT_MS / 1000);

  /**
   * 控制台里**显示**的行（来自环形缓冲的快照，最多 DEFAULT_LINE_CAP 行）。
   * 真正的数据在环形缓冲里，state 只是 100ms 一次的快照。
   */
  const [output, setOutput] = useState<RunnerLine[]>([]);
  /** 环形缓冲丢掉的行数（累计），> 0 时控制台置顶提示 */
  const [droppedLines, setDroppedLines] = useState(0);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState('');
  const [result, setResult] = useState<any>(null);
  /** 单文件调试时生成的文件名（Main.java / main.py…），显示在输出栏上 */
  const [runFile, setRunFile] = useState('');

  // 首次进入的引导弹窗
  const [guideOpen, setGuideOpen] = useState(false);
  // 「记入执行账本」（写一条 runs 记录：测试执行里能看到这次跑批）
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerDraft, setLedgerDraft] = useState<any>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  // 环境提示条（可手动关闭 / 30s 自动关）
  const [tipVisible, setTipVisible] = useState(false);
  const [tipPct, setTipPct] = useState(100);
  const tipTimer = useRef<any>(null);

  // 模板：下拉「导入模板」+ 完整模板库抽屉
  const [tplOpen, setTplOpen] = useState(false);
  /** 光标位置要靠它，插入模板时必须拿到真实的 selectionStart */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const outputRef = useRef<HTMLDivElement | null>(null);
  /**
   * 输出先进这里（无上限会吃光内存），页面只按 100ms 的节奏取快照。
   * 用 useState 的惰性初始化拿到一个跨渲染稳定的实例（比 useRef(createLineBuffer())
   * 好：后者每次渲染都会白建一个 2000 槽的空数组）。
   */
  const [buffer] = useState(() => createLineBuffer(DEFAULT_LINE_CAP));
  const flushTimer = useRef<any>(null);

  /** 把缓冲当前内容刷进 state（同时把「丢了多少行」带出去，保证不假装完整） */
  const flushOutput = React.useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    setOutput(buffer.lines());
    setDroppedLines(buffer.dropped());
  }, [buffer]);

  /** 清空输出：缓冲、待刷计时器、界面状态一起归零 */
  const resetOutput = React.useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    buffer.clear();
    setOutput([]);
    setDroppedLines(0);
  }, [buffer]);

  /** 下拉里的全部选项：单文件调试语言 + 项目/框架运行器 */
  const allRunners = useMemo<Runner[]>(() => {
    const langs: Runner[] = CODE_LANGS.map((l: any) => ({
      key: l.key,
      label: l.label,
      desc: l.desc,
      ext: l.ext,
      needs: l.needs,
      lang: l.lang
    }));
    return langs.concat(runners);
  }, [runners]);

  const currentRunner = useMemo(() => allRunners.find((r) => r.key === runnerKey), [allRunners, runnerKey]);
  const isMaven = runnerKey === 'maven';
  const isLangMode = !!(currentRunner && currentRunner.lang);
  /**
   * 只有 Groovy（JMeter）模式才有模板导入。
   * Maven / pytest / JavaScript 那些不是 JSR223 脚本，塞 JMeter 模板进去没意义。
   */
  const isGroovy = runnerKey === 'groovy';

  /** 实际生效的超时（毫秒）：前端算一遍只为显示，主进程还会再钳一次 */
  const timeoutMs = useMemo(() => {
    const seconds = timeoutPreset === 'custom' ? Number(customSeconds) || 0 : Number(timeoutPreset) / 1000;
    return clampTimeout(seconds * 1000);
  }, [timeoutPreset, customSeconds]);

  /**
   * 合并两处环境信息：
   *   runner:list 的 env 有 java/python/mvn/jmeter；
   *   runner:detect 更细（node、javac 单独报）。
   * 缺哪个就把它置空 —— missingEnv 靠「空 = 缺」判断。
   */
  const mergedEnv = useMemo(() => {
    if (!detect) return env;
    return Object.assign({}, env, {
      node: detect.node && detect.node.ok ? detect.node.path || '内置 Node' : '',
      python: detect.python && detect.python.ok ? detect.python.path : env.python || '',
      java: detect.java && detect.java.java ? detect.java.java : env.java || '',
      javac: detect.java ? detect.java.javac || '' : ''
    });
  }, [env, detect]);

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    (async () => {
      try {
        const res = await api.runnerList();
        setRunners(res.runners || []);
        setEnv(res.env || {});
      } catch (e: any) {
        toast('加载运行器失败：' + (e && e.message ? e.message : e), 'error');
      }
      try {
        const res = await api.projectsScan();
        setProjects(res.projects || []);
      } catch (e) {
        /* 扫描失败不影响手写代码 */
      }
    })();

    refreshDetect();

    // 首次进入：弹引导（localStorage 记一次）
    try {
      if (!localStorage.getItem('runner-guide-seen')) {
        setGuideOpen(true);
      }
    } catch (e) {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 重新探测运行环境（用户可能刚装完 JDK 就回来点） */
  async function refreshDetect() {
    const fn = (api as any).runnerDetect;
    if (typeof fn !== 'function') return; // 老版本没有这个通道，退化成只显示 runner:list 的环境
    setDetecting(true);
    try {
      const res = await fn();
      setDetect(res || null);
    } catch (e: any) {
      toast('环境检测失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setDetecting(false);
    }
  }

  /* ---------- 订阅输出 ---------- */
  useEffect(() => {
    /**
     * 输出回调**只往环形缓冲里塞**，不直接 setState。
     *
     * 计数器场景：Maven 构建一次能吐几万行，原来每行一次 setState，
     * 每行都要全列表 reconcile + 强制 scrollTop 重排，界面直接卡死。
     * 现在 100ms 合并一批，渲染次数从「行数」降到「10 次/秒」。
     */
    const offOut = api.onRunnerOutput((d: any) => {
      buffer.push(d && d.stream === 'stderr' ? 'stderr' : 'stdout', d && d.text != null ? d.text : '');
      if (flushTimer.current) return; // 这一批已经有计时器了
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        flushOutput();
      }, FLUSH_INTERVAL);
    });
    const offExit = api.onRunnerExit((d: any) => {
      // 退出前把最后一批刷出来，否则最后几行输出会丢
      flushOutput();
      setRunning(false);
      setResult(d);

      // 超时提示要写清「多少秒」——只说「超时了」用户没法判断是不是设太短
      const secs = d && d.timeoutMs ? Math.round(Number(d.timeoutMs) / 1000) : 0;
      if (d && d.canceled) {
        toast('已取消');
      } else if (d && d.timedOut) {
        toast(secs ? `执行超过 ${secs} 秒已终止` : '执行超时，已终止', 'warning');
      } else if (d && d.phase === 'compile' && d.code !== 0) {
        toast((d && d.message) || `编译失败（退出码 ${d.code}），已停止运行`, 'warning');
      } else if (d && d.code === 0) {
        toast('运行成功');
      } else if (d && (d.code === null || d.code === undefined)) {
        toast('运行已终止');
      } else {
        toast(`运行结束（退出码 ${d.code}）`, 'warning');
      }
    });
    return () => {
      offOut && offOut();
      offExit && offExit();
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, [flushOutput]);

  /* ---------- 输出自动滚到底 ---------- */
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  /* ---------- 环境缺失 → 显示提示条 + 30s 倒计时 ---------- */
  const missingEnv = useMemo(() => {
    if (!currentRunner) return [];
    return (currentRunner.needs || []).filter((n) => !mergedEnv[n]);
  }, [currentRunner, mergedEnv]);

  useEffect(() => {
    if (!missingEnv.length) {
      setTipVisible(false);
      return;
    }
    setTipVisible(true);
    setTipPct(100);
    if (tipTimer.current) clearInterval(tipTimer.current);
    const started = Date.now();
    tipTimer.current = setInterval(() => {
      const elapsed = Date.now() - started;
      const pct = Math.max(0, 100 - (elapsed / TIP_DURATION) * 100);
      setTipPct(pct);
      if (pct <= 0) {
        clearInterval(tipTimer.current);
        setTipVisible(false);
      }
    }, 100);
    return () => {
      if (tipTimer.current) clearInterval(tipTimer.current);
    };
  }, [missingEnv]);

  const closeTip = () => {
    if (tipTimer.current) clearInterval(tipTimer.current);
    setTipVisible(false);
  };

  /* ---------- 切运行器 ---------- */
  const changeRunner = (key: string) => {
    setRunnerKey(key);
    setCode(TEMPLATES[key] !== undefined ? TEMPLATES[key] : LANG_TEMPLATES[key] || '');
    resetOutput();
    setResult(null);
    setRunFile('');
    /**
     * Maven 是「整项目跑批」，冷启动 + surefire 起引擎动辄几十秒，
     * 15 秒默认档必超时。切过去时把超时抬到上限（60 秒），
     * 让用户拿到这个模式能给的最长预算。
     */
    if (key === 'maven' && timeoutPreset !== 'custom') setTimeoutPreset('60000');
  };

  /* ---------- 选项目 ---------- */
  const changeProject = async (dir: string) => {
    setProjectDir(dir);
    setTestClass('');
    setTestClasses([]);
    if (!dir) return;
    try {
      const res = await api.projectsTestClasses(dir);
      setTestClasses(res.classes || []);
    } catch (e) {
      /* ignore */
    }
  };

  /* ---------- 运行 ---------- */
  const doRun = async () => {
    if (running) return;
    if (missingEnv.length) {
      const what = missingEnv.map((n) => ENV_LABEL[n] || n).join('、');
      const how = missingEnv.map((n) => ENV_HINT[n]).filter(Boolean).join('；');
      toast(`缺少运行时：${what} —— ${how}`, 'error');
      return;
    }
    resetOutput();
    setResult(null);
    setRunFile('');
    setRunning(true);
    try {
      const payload: any = { timeout: timeoutMs };
      if (isLangMode) {
        // 单文件调试：只给语言和代码，命令由主进程按语言生成（Java 是两步）
        payload.lang = currentRunner && currentRunner.lang;
        payload.code = code;
      } else {
        payload.runnerKey = runnerKey;
        payload.code = isMaven ? '' : code;
        payload.projectDir = isMaven ? projectDir : '';
        payload.testClass = isMaven ? testClass : '';
      }
      const res = await api.runnerRun(payload);
      if (!res.ok) {
        setRunning(false);
        toast(res.message || '运行失败', 'error');
        return;
      }
      setRunId(res.runId);
      if (res.file) setRunFile(res.file);
    } catch (e: any) {
      setRunning(false);
      toast('运行失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doCancel = async () => {
    if (!runId) return;
    await api.runnerCancel(runId);
    setRunning(false);
    toast('已取消');
  };

  const doClear = () => {
    resetOutput();
    setResult(null);
  };

  const doCopy = async () => {
    // 直接取缓冲快照：还没到 100ms 刷新的那几行也要复制到
    const snapshot = buffer.lines();
    const dropped = buffer.dropped();
    await api.copy(snapshot.map((l) => l.text).join(''), false);
    // 丢过行就明说，别让用户以为复制到的是完整输出
    toast(dropped ? `输出已复制（共 ${snapshot.length} 行，前面 ${dropped} 行已丢弃）` : '输出已复制');
  };

  /* ---------- 记入执行账本（写一条 runs 记录） ---------- */
  /**
   * 开弹窗：把这次运行的退出码 / 耗时 / 用例统计读出来预填。
   *
   * 数据来源都是真的：
   *   - 退出码、耗时、超时/取消 → runner:exit 的事件体（result）
   *   - 通过/失败数 → 控制台输出里的 Maven/pytest 汇总行（认不出就留空）
   *   - 类型（接口/UI）→ 按代码和输出里的迹象猜一个，弹窗里能改
   */
  const openLedger = () => {
    if (!result) {
      toast('先跑一次，拿到退出码再记账', 'warning');
      return;
    }
    const text = buffer.lines().map((l) => l.text).join('');
    setLedgerDraft(
      buildLedgerDraft({
        runnerLabel: (currentRunner && currentRunner.label) || runnerKey,
        code: isMaven ? '' : code,
        output: text,
        result
      })
    );
    setLedgerOpen(true);
  };

  /** 改通过/失败数时顺手把「结果」对齐，避免出现「失败 2 条但结果是正常」 */
  const updateLedgerCount = (key: 'passCount' | 'failCount', value: any) => {
    setLedgerDraft((cur: any) => {
      if (!cur) return cur;
      const raw = value === null || value === undefined || value === '' ? null : Number(value);
      const next = Object.assign({}, cur, { [key]: raw === null || Number.isNaN(raw) ? null : raw });
      const fail = Number(next.failCount) || 0;
      const pass = Number(next.passCount) || 0;
      if (fail > 0) next.result = 'bad';
      else if (pass > 0) next.result = 'ok';
      return next;
    });
  };

  const saveLedger = async () => {
    if (!ledgerDraft) return;
    const name = String(ledgerDraft.name || '').trim();
    if (!name) {
      toast('先给这条记录起个标题', 'warning');
      return;
    }
    setLedgerBusy(true);
    try {
      const data: any = {
        name,
        kind: ledgerDraft.kind,
        result: ledgerDraft.result,
        ranAt: Date.now(),
        env: ledgerDraft.env || 'test',
        conclusion: String(ledgerDraft.conclusion || '').trim()
      };
      // 认不出统计时 passCount / failCount 是 null → 不写这两个键，
      // 免得账本里出现「0 通过 0 失败」这种像是统计过的假数据
      if (ledgerDraft.passCount !== null && ledgerDraft.passCount !== undefined) {
        data.passCount = Number(ledgerDraft.passCount) || 0;
      }
      if (ledgerDraft.failCount !== null && ledgerDraft.failCount !== undefined) {
        data.failCount = Number(ledgerDraft.failCount) || 0;
      }
      const saved = await api.saveRecord({ collection: 'runs', data, tags: [], favorite: false });
      if (!saved || !saved.id) {
        toast('没写进账本（没拿到记录 id）', 'error');
        return;
      }
      setLedgerOpen(false);
      toast('已记入执行账本：' + name);
    } catch (e: any) {
      toast('记入失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLedgerBusy(false);
    }
  };

  const closeGuide = () => {
    setGuideOpen(false);
    try {
      localStorage.setItem('runner-guide-seen', '1');
    } catch (e) {
      /* ignore */
    }
  };

  /* ---------- 模板：插入到光标处 ---------- */
  /**
   * 把一条模板插进编辑器。
   *
   * 为什么不替换：用户常常是「已经写了两行，再补一段断言」，
   * 直接覆盖会把已写的代码吃掉，所以一律插入。
   *
   * 真正的字符串拼接在 shared/scriptTemplates.js 的 insertCodeAtCursor 里
   * （纯函数，能单测）；这里只负责拿光标位置 + 把光标放回插入内容末尾。
   */
  const insertTemplate = (tpl: { id?: string; category?: string; name?: string; code: string; vars?: any[] }) => {
    const snippet = templateSnippet(tpl);
    if (!snippet) return;
    const ta = textareaRef.current;
    if (!ta) {
      // 编辑器还没挂上（比如刚切到 Maven）：退化成「追加到现有内容末尾」
      setCode((cur) => insertCodeAtCursor(cur, snippet).text);
      toast(`已插入模板：${tpl.name || '模板'}`);
      return;
    }
    const res = insertCodeAtCursor(code, snippet, ta.selectionStart, ta.selectionEnd);
    setCode(res.text);
    // 光标落到插入内容末尾，下一步接着写；等一帧让受控 textarea 先把新值渲染出来
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(res.cursor, res.cursor);
    });
    toast(`已插入模板：${tpl.name || '模板'}`);
  };

  /** 下拉里选了一个模板 id → 找到模板 → 插入 */
  const pickTemplateById = (id: string) => {
    const tpl = SCRIPT_TEMPLATES.find((t) => t.id === id);
    if (tpl) insertTemplate(tpl);
  };

  /**
   * 「导入模板」下拉菜单的分组项。
   *
   * 数据全部来自 shared/scriptTemplates.js（按 GROOVY_CATEGORIES 过滤，
   * 顺序也按它走：断言排第一，因为这是最常插的一类）。
   * 这里不另写一份模板清单 —— 改了模板库，下拉和抽屉必须同时变。
   * 用 Dropdown 而不是 Select：Select 选完会留在选中态，
   * 同一个模板想连插两次就点不动了；菜单每次点都触发一次。
   */
  const templateMenuItems = useMemo(() => {
    return GROOVY_CATEGORIES.map((key) => {
      const cat = CATEGORY_MAP[key];
      return {
        type: 'group' as const,
        label: `${cat ? cat.name : key} · ${GROUP_ELEMENT[key] || 'JSR223'}`,
        children: SCRIPT_TEMPLATES.filter((t) => t.category === key).map((t) => ({
          key: t.id,
          label: t.name
        }))
      };
    }).filter((g) => g.children.length > 0);
  }, []);

  /* ---------- 快捷键 ---------- */
  /**
   * 快捷键统一走 useHotkeys（挂着 window 上，焦点在页面任何位置都生效）：
   * Ctrl+Enter 运行、Esc 取消。原来 textarea 自己的 onKeyDown 已经去掉，
   * 否则在编辑器里按 Ctrl+Enter 会被「局部 + 全局」各触发一次。
   */
  useHotkeys({
    'Ctrl+Enter': () => {
      void doRun();
    },
    Escape: () => {
      if (running) void doCancel();
    }
  });

  /** 下拉分组：单文件调试 / 项目·框架运行器（缺运行时的选项直接灰掉） */
  const runnerOptions = useMemo(() => {
    const build = (title: string, list: Runner[]) => ({
      label: title,
      options: list.map((r) => ({
        value: r.key,
        label: r.label,
        disabled: (r.needs || []).some((n) => !mergedEnv[n])
      }))
    });
    return [build('单文件调试', allRunners.filter((r) => !!r.lang)), build('项目 / 框架运行器', allRunners.filter((r) => !r.lang))];
  }, [allRunners, mergedEnv]);

  const nodeOk = !!(detect && detect.node && detect.node.ok);
  const pythonOk = !!(detect && detect.python && detect.python.ok);
  const javaOk = !!(detect && detect.java && detect.java.java);
  const javacOk = !!(detect && detect.java && detect.java.javac);
  const nodePath = detect && detect.node ? detect.node.path : '';
  const pythonPath = detect && detect.python ? detect.python.path : '';
  const javaPath = detect && detect.java ? detect.java.java : '';
  const javacPath = detect && detect.java ? detect.java.javac : '';
  /** 还没拿到检测结果时别急着说「未找到」（旧版本 / 预览模式会误导） */
  const missText = detect ? '未找到' : '检测中…';

  return (
    <div className="code-runner">
      {/* 首次引导弹窗 */}
      <Modal
        open={guideOpen}
        title="先配置开发环境"
        onCancel={closeGuide}
        footer={[
          <Button key="ok" type="primary" onClick={closeGuide}>
            知道了
          </Button>
        ]}
        width={520}
      >
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <p>
            「代码调试」需要本机已安装 <b>JDK</b> / <b>Python</b> / <b>Maven</b>（按你要用的运行器）。
          </p>
          <p>
            <b>平台只检测，不下载、不安装</b>——不会修改你的系统环境，卸载时也不会删除它们。
          </p>
          <p>
            建议先去 <b>设置 → 开发环境</b> 看一眼检测结果，缺什么装什么。
          </p>
        </div>
      </Modal>

      {/*
        运行环境状态：绿点 = 可用，灰点 = 缺失。
        java 和 javac 分两行显示 —— 只装 JRE 时 java 是绿的、javac 是灰的，
        用户一眼就能看出「需要 JDK 不是 JRE」，而不是等运行时才看到 class not found。
      */}
      <div className="env-strip">
        <span className="env-strip-label muted">运行环境</span>

        <span className="env-chip" title={nodePath || '没有找到 Node.js'}>
          <i className={'env-dot' + (nodeOk ? ' env-dot-ok' : '')} />
          <span>Node.js</span>
          <span className="env-path muted">
            {nodeOk ? (detect && detect.node.viaElectron ? '应用内置 Node' : shortPath(nodePath)) : missText}
          </span>
        </span>

        <span className="env-chip" title={pythonPath || '没有找到 Python'}>
          <i className={'env-dot' + (pythonOk ? ' env-dot-ok' : '')} />
          <span>Python</span>
          <span className="env-path muted">{pythonOk ? shortPath(pythonPath) : missText}</span>
        </span>

        <span className="env-chip env-chip-col" title={'java：' + (javaPath || '未找到') + '\njavac：' + (javacPath || '未找到')}>
          <span className="env-io">
            <i className={'env-dot' + (javaOk ? ' env-dot-ok' : '')} />
            <span>java</span>
            <span className="env-path muted">{javaOk ? shortPath(javaPath) : missText}</span>
          </span>
          <span className="env-io">
            <i className={'env-dot' + (javacOk ? ' env-dot-ok' : javaOk ? ' env-dot-warn' : '')} />
            <span>javac</span>
            <span className="env-path muted">
              {javacOk ? shortPath(javacPath) : javaOk ? '未找到（需要 JDK 不是 JRE）' : missText}
            </span>
          </span>
        </span>

        <Button size="small" type="link" icon={<ReloadOutlined />} onClick={refreshDetect} loading={detecting}>
          重新检测
        </Button>
      </div>

      {/* 环境提示条（30s 倒计时绿条） */}
      {tipVisible && missingEnv.length ? (
        <div className="env-tip">
          <div className="env-tip-body">
            <span className="env-tip-icon">!</span>
            <span className="env-tip-text">
              缺少环境：<b>{missingEnv.map((n) => ENV_LABEL[n] || n).join('、')}</b>
              <span className="muted" style={{ marginLeft: 8 }}>
                {missingEnv.map((n) => ENV_HINT[n]).filter(Boolean).join('；')}
              </span>
            </span>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={closeTip}
              className="env-tip-close"
              aria-label="关闭环境提示"
            />
          </div>
          {/* 底部自动缩减的绿色粗线 */}
          <div className="env-tip-bar" style={{ width: `${tipPct}%` }} />
        </div>
      ) : null}

      {/* 顶部：运行器 + 超时 + 项目选择 */}
      <div className="runner-bar">
        <Space size={8} wrap>
          <span className="muted">运行器</span>
          <Select
            size="small"
            value={runnerKey}
            onChange={changeRunner}
            options={runnerOptions}
            style={{ width: 190 }}
          />

          <span className="muted">超时</span>
          <Select
            size="small"
            value={timeoutPreset}
            onChange={setTimeoutPreset}
            options={TIMEOUT_PRESETS}
            style={{ width: 96 }}
          />
          {timeoutPreset === 'custom' ? (
            <InputNumber
              size="small"
              min={1}
              max={60}
              step={1}
              value={customSeconds}
              onChange={(v) => setCustomSeconds(Number(v) || 0)}
              addonAfter="秒"
              style={{ width: 110 }}
            />
          ) : null}
          {timeoutPreset === 'custom' && timeoutMs !== Number(customSeconds) * 1000 ? (
            <span className="muted" style={{ fontSize: 12 }}>
              已按 {Math.round(timeoutMs / 1000)} 秒执行（允许 1~60 秒）
            </span>
          ) : null}

          {isMaven ? (
            <>
              <span className="muted">项目</span>
              <Select
                size="small"
                value={projectDir}
                onChange={changeProject}
                placeholder="选项目"
                style={{ width: 200 }}
                options={projects.map((p) => ({
                  value: p.dir,
                  label: (
                    <span>
                      {p.name}
                      {p.frameworks.length ? (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                          {p.frameworks.map((f) => f.label).join(' · ')}
                        </span>
                      ) : null}
                    </span>
                  )
                }))}
              />
              <span className="muted">测试类</span>
              <Select
                size="small"
                value={testClass}
                onChange={setTestClass}
                placeholder={testClasses.length ? '选测试类（可空=全部）' : '先选项目'}
                style={{ width: 200 }}
                allowClear
                options={testClasses.map((c) => ({ value: c, label: c }))}
              />
            </>
          ) : null}

          {isGroovy ? (
            /*
             * 只有 Groovy（JMeter）模式才出现：
             * 「导入模板」解决「快速插一段断言」，旁边的按钮进完整模板库看说明和坑。
             * 两者读的是同一份 shared/scriptTemplates.js。
             */
            <>
              <Dropdown
                trigger={['click']}
                menu={{ items: templateMenuItems, onClick: ({ key }) => pickTemplateById(key) }}
              >
                <Button size="small" icon={<ImportOutlined />}>
                  导入模板 <DownOutlined />
                </Button>
              </Dropdown>
              <Button size="small" icon={<ReadOutlined />} onClick={() => setTplOpen(true)}>
                完整模板库
              </Button>
            </>
          ) : null}

          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            onClick={doRun}
            loading={running}
            disabled={running}
          >
            运行
          </Button>
          {running ? (
            <Button size="small" danger icon={<StopOutlined />} onClick={doCancel}>
              取消
            </Button>
          ) : null}
          <Button size="small" icon={<ClearOutlined />} onClick={doClear}>
            清空
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={doCopy} disabled={!output.length}>
            复制输出
          </Button>
          {/*
            「记入执行账本」：跑完才可点。
            和「压测报告 → 测试执行」「Allure 归档 → 测试执行」同一条流水账，
            避免「接口/压测能留痕、代码调试跑完什么都不留」的不对称。
          */}
          <Button
            size="small"
            icon={<ProfileOutlined />}
            onClick={openLedger}
            disabled={!result}
            title={result ? '把这次运行的退出码/耗时/失败数记进「测试执行」' : '先跑一次再记账'}
          >
            记入执行账本
          </Button>
        </Space>
      </div>

      {currentRunner ? <div className="runner-desc muted">{currentRunner.desc}</div> : null}

      {/* 代码编辑器 */}
      {!isMaven ? (
        <textarea
          ref={textareaRef}
          className="runner-editor mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          placeholder={isGroovy ? '在这里写代码，Ctrl+Enter 运行；右上角「导入模板」可插入现成断言/提取器' : '在这里写代码，Ctrl+Enter 运行'}
          aria-label="代码编辑器，Ctrl+Enter 运行"
          aria-keyshortcuts="Control+Enter"
        />
      ) : (
        <div className="runner-maven-hint">
          <Alert
            type="info"
            showIcon
            message="Maven 项目不需要写代码"
            description={
              <span>
                选项目 + 测试类，点「运行」即可。等价于 <code>mvn test -Dtest=测试类</code>
                {projectDir ? null : '（不选测试类 = 跑全部）'}
              </span>
            }
          />
        </div>
      )}

      {/* 输出面板 */}
      <div className="runner-output-head">
        <span>
          输出
          {runFile ? (
            <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>
              {runFile}
            </span>
          ) : null}
        </span>
        {result ? (
          <span className="muted" style={{ fontSize: 12 }}>
            退出码 {result.code === null || result.code === undefined ? '—' : result.code} · 耗时{' '}
            {(result.duration / 1000).toFixed(1)}s
            {result.phase === 'compile' ? ' · 编译阶段' : ''}
            {result.timedOut ? ' · 超时' : ''}
          </span>
        ) : null}
      </div>
      {/*
        输出交给 OutputConsole 渲染（React.memo；行按自增 id 做 key，
        环形缓冲从头部丢行也不会让整列表错位）。
      */}
      {/*
        控制台：role=log 让读屏软件知道这是追加型日志；aria-live=off 是刻意的 ——
        一次构建几千行，逐行播报会把读屏软件淹掉，需要时可自己去读。
      */}
      <div
        className="runner-output mono"
        ref={outputRef}
        role="log"
        aria-label="运行输出"
        aria-live="off"
      >
        <OutputConsole lines={output} running={running} dropped={droppedLines} />
      </div>

      {/*
        完整模板库（和脚本生成页共用同一个抽屉，数据同一份）。
        只是交出去的回调不一样：那边是「填入附加代码 → 生成进 jmx」，
        这边是 onPickTemplate → 插入到编辑器光标处。
      */}
      <ScriptTemplatesDrawer
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        onPickTemplate={insertTemplate}
        pickLabel="插入到光标处"
        footerHint={DRAWER_FOOTER_HINT}
      />

      {/* 记入执行账本：退出码 / 耗时 / 失败数已预填，其余可改 */}
      <Modal
        open={ledgerOpen}
        title="记入执行账本（测试执行）"
        onCancel={() => setLedgerOpen(false)}
        width={560}
        footer={
          <Space>
            <Button onClick={() => setLedgerOpen(false)}>取消</Button>
            <Button type="primary" loading={ledgerBusy} onClick={saveLedger} disabled={!ledgerDraft}>
              记入
            </Button>
          </Space>
        }
      >
        {ledgerDraft ? (
          <>
            <div className="muted" style={{ marginBottom: 12, fontSize: 12, lineHeight: 1.8 }}>
              退出码 / 耗时 / 失败数已从这次运行里预填（退出码和耗时写进「结论」，
              因为账本里这两个字段只给压测用）。输出里认不出用例统计时，通过/失败数留空，请自己填。
            </div>

            <div style={{ marginBottom: 10 }}>
              <div className="muted" style={{ marginBottom: 4 }}>
                标题
              </div>
              <Input
                value={ledgerDraft.name}
                maxLength={80}
                onChange={(e) => setLedgerDraft(Object.assign({}, ledgerDraft, { name: e.target.value }))}
                placeholder="如：登录接口冒烟-1125"
              />
            </div>

            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  类型
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={ledgerDraft.kind}
                  onChange={(v) => setLedgerDraft(Object.assign({}, ledgerDraft, { kind: v }))}
                  options={LEDGER_KINDS.map((o: any) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  结果
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={ledgerDraft.result}
                  onChange={(v) => setLedgerDraft(Object.assign({}, ledgerDraft, { result: v }))}
                  options={RUN_RESULT_OPTIONS.map((o: any) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  环境
                </div>
                <Select
                  style={{ width: '100%' }}
                  value={ledgerDraft.env}
                  onChange={(v) => setLedgerDraft(Object.assign({}, ledgerDraft, { env: v }))}
                  options={ENV_OPTIONS.map((o: any) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  通过
                </div>
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  value={ledgerDraft.passCount === null ? undefined : ledgerDraft.passCount}
                  onChange={(v) => updateLedgerCount('passCount', v)}
                  placeholder="认不出就留空"
                />
              </div>
              <div style={{ flex: '1 1 0' }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  失败
                </div>
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  value={ledgerDraft.failCount === null ? undefined : ledgerDraft.failCount}
                  onChange={(v) => updateLedgerCount('failCount', v)}
                  placeholder="退出码非 0 时自己填"
                />
              </div>
            </div>

            <div>
              <div className="muted" style={{ marginBottom: 4 }}>
                结论（退出码 / 耗时已经写在这里）
              </div>
              <Input.TextArea
                rows={3}
                value={ledgerDraft.conclusion}
                onChange={(e) => setLedgerDraft(Object.assign({}, ledgerDraft, { conclusion: e.target.value }))}
              />
            </div>

            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              类型是按代码/输出里有没有 playwright、selenium 之类的迹象猜的，别当真，按实际改。
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}