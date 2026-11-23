import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Button, Input, Tag, Alert, Tooltip, Space } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  ClearOutlined,
  CopyOutlined,
  FolderOpenOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

type Runner = {
  key: string;
  label: string;
  desc: string;
  ext: string | null;
  needs: string[];
};

type Project = {
  name: string;
  dir: string;
  type: string;
  frameworks: { key: string; label: string; color: string }[];
  isTest: boolean;
};

type OutputLine = { stream: 'stdout' | 'stderr'; text: string };

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

export default function CodeRunner() {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [env, setEnv] = useState<any>({});
  const [runnerKey, setRunnerKey] = useState('groovy');
  const [code, setCode] = useState(TEMPLATES.groovy);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDir, setProjectDir] = useState('');
  const [testClasses, setTestClasses] = useState<string[]>([]);
  const [testClass, setTestClass] = useState('');

  const [lines, setLines] = useState<OutputLine[]>([]);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState('');
  const [result, setResult] = useState<any>(null);

  const outputRef = useRef<HTMLDivElement | null>(null);

  const currentRunner = useMemo(() => runners.find((r) => r.key === runnerKey), [runners, runnerKey]);
  const isMaven = runnerKey === 'maven';

  /* ---------- 初始化：加载运行器 + 扫描项目 ---------- */
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
  }, []);

  /* ---------- 订阅输出 ---------- */
  useEffect(() => {
    const offOut = api.onRunnerOutput((d: any) => {
      setLines((prev) => prev.concat([{ stream: d.stream, text: d.text }]));
    });
    const offExit = api.onRunnerExit((d: any) => {
      setRunning(false);
      setResult(d);
      if (d.timedOut) toast('运行超时，已强制结束', 'warning');
      else if (d.code === 0) toast('运行成功');
      else toast(`运行结束（退出码 ${d.code}）`, 'warning');
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

  /* ---------- 切运行器：换模板 ---------- */
  const changeRunner = (key: string) => {
    setRunnerKey(key);
    setCode(TEMPLATES[key] || '');
    setLines([]);
    setResult(null);
  };

  /* ---------- 选项目：加载测试类 ---------- */
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
    setLines([]);
    setResult(null);
    setRunning(true);
    try {
      const res = await api.runnerRun({
        runnerKey,
        code: isMaven ? '' : code,
        projectDir: isMaven ? projectDir : '',
        testClass: isMaven ? testClass : ''
      });
      if (!res.ok) {
        setRunning(false);
        toast(res.message || '运行失败', 'error');
        return;
      }
      setRunId(res.runId);
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

  /* ---------- 环境检查 ---------- */
  const missingEnv = useMemo(() => {
    if (!currentRunner) return [];
    const map: Record<string, string> = { java: 'Java', python: 'Python', mvn: 'Maven', jmeter: 'JMeter' };
    return (currentRunner.needs || []).filter((n) => !env[n]).map((n) => map[n] || n);
  }, [currentRunner, env]);

  return (
    <div className="code-runner">
      {/* 顶部：运行器 + 项目选择 */}
      <div className="runner-bar">
        <Space size={8} wrap>
          <span className="muted">运行器</span>
          <Select
            size="small"
            value={runnerKey}
            onChange={changeRunner}
            options={runners.map((r) => ({ value: r.key, label: r.label }))}
            style={{ width: 180 }}
          />

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

      {currentRunner ? (
        <div className="runner-desc muted">{currentRunner.desc}</div>
      ) : null}

      {missingEnv.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`缺少环境：${missingEnv.join('、')}`}
          description="请先安装，或在「设置」里配置路径。"
        />
      ) : null}

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
        <span>输出</span>
        {result ? (
          <span className="muted" style={{ fontSize: 12 }}>
            退出码 {result.code} · 耗时 {(result.duration / 1000).toFixed(1)}s
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
