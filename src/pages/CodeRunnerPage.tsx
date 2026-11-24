import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Button, Alert, Space, Modal, InputNumber } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  ClearOutlined,
  CopyOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SettingOutlined,
  CloseOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { CODE_LANGS, DEFAULT_TIMEOUT_MS, clampTimeout } from '../../shared/codelab';

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

type OutputLine = { stream: 'stdout' | 'stderr'; text: string };

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

  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState('');
  const [result, setResult] = useState<any>(null);
  /** 单文件调试时生成的文件名（Main.java / main.py…），显示在输出栏上 */
  const [runFile, setRunFile] = useState('');

  // 首次进入的引导弹窗
  const [guideOpen, setGuideOpen] = useState(false);
  // 环境提示条（可手动关闭 / 30s 自动关）
  const [tipVisible, setTipVisible] = useState(false);
  const [tipPct, setTipPct] = useState(100);
  const tipTimer = useRef<any>(null);

  const outputRef = useRef<HTMLDivElement | null>(null);

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
    const offOut = api.onRunnerOutput((d: any) => {
      setLines((prev) => prev.concat([{ stream: d.stream, text: d.text }]));
    });
    const offExit = api.onRunnerExit((d: any) => {
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
    };
  }, []);

  /* ---------- 输出自动滚到底 ---------- */
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

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
    setLines([]);
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
    setLines([]);
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
    setLines([]);
    setResult(null);
  };

  const doCopy = async () => {
    const text = lines.map((l) => l.text).join('');
    await api.copy(text, false);
    toast('输出已复制');
  };

  const closeGuide = () => {
    setGuideOpen(false);
    try {
      localStorage.setItem('runner-guide-seen', '1');
    } catch (e) {
      /* ignore */
    }
  };

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
            <span className="muted" style={{ fontSize: 11.5 }}>
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
          <Button size="small" icon={<CopyOutlined />} onClick={doCopy} disabled={!lines.length}>
            复制输出
          </Button>
        </Space>
      </div>

      {currentRunner ? <div className="runner-desc muted">{currentRunner.desc}</div> : null}

      {/* 代码编辑器 */}
      {!isMaven ? (
        <textarea
          className="runner-editor mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          placeholder="在这里写代码，Ctrl+Enter 运行"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              doRun();
            }
          }}
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
            <span className="muted" style={{ fontSize: 11.5, fontWeight: 400, marginLeft: 8 }}>
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
      <div className="runner-output mono" ref={outputRef}>
        {lines.length ? (
          lines.map((l, i) => (
            <span key={i} className={l.stream === 'stderr' ? 'runner-line-err' : ''}>
              {l.text}
            </span>
          ))
        ) : (
          <span className="muted">{running ? '运行中…' : '点「运行」看输出'}</span>
        )}
      </div>
    </div>
  );
}