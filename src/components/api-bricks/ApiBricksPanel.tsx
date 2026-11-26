import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Select, Space, Tag } from 'antd';
import {
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
  CopyOutlined,
  ClearOutlined,
  SaveOutlined
} from '@ant-design/icons';
import { API_ACTIONS, API_ACTION_CATEGORIES, actionById } from '../../../shared/apiActions';
import { generateApiFlow } from '../../../shared/apiFlowGen';
import {
  apiFlowRecordData,
  apiFlowsOnly,
  collectVariables,
  defaultApiFlowName,
  parseApiFlowSteps,
  stepDefaults,
  summarizeStep,
  toGeneratorSteps,
  type ApiBricksStep
} from './apiBrickHelpers';
import ApiActionParamModal from './ApiActionParamModal';
import SaveApiFlowModal from './SaveApiFlowModal';

/**
 * 统一的代码块（高亮 + 行号），同 BricksPanel 的做法：
 * 用受保护的 require，测试的 require 桩里没有它，静态 import 会在载入阶段崩。
 */
let CodeBlockLazy: any = null;
try {
  CodeBlockLazy = require('../CodeBlock').default;
} catch (e) {
  CodeBlockLazy = null;
}

/**
 * 「接口流程（积木）」面板（三栏：积木库 / 已选步骤 / 生成结果）。
 *
 * ============================================================
 * 定位
 * ============================================================
 * 和 ui-bricks/BricksPanel.tsx 是**同构**的两块面板，但原子完全不同：
 *   UI 积木的原子是「页面元素 + 动作」，接口积木的原子是
 *   「接口快照 + 响应变量」—— 所以这里是另一套动作库（apiActions.js）、
 *   另一套生成器（apiFlowGen.js），只共用「三栏 + 状态提升 + flows 存档」的模式。
 *
 * 产物同样是一段**真实可编辑的代码**：右边 textarea 实时出方法体，可以直接改、直接复制。
 * 生成逻辑全在 shared/apiFlowGen.js（纯函数），这里只负责状态和交互，
 * 所以「预览」和「真代码」不会各写一套。
 */
type Props = {
  /** apis 集合：`apiRecord` 参数的下拉从这里出 */
  apis: any[];
  /** 当前生成目标的语言（java-restassured → java，python-pytest → python） */
  lang: 'java' | 'python';
  /** flows 集合的记录：面板自己按 kind === 'api' 过滤 */
  flows?: any[];
  /** v0.63：从「流程模板」跳过来时带的流程 id，挂载后自动载入 */
  openFlowId?: string;
  /** 复制走调用方的剪贴板（组件自己不做副作用） */
  onCopy?: (text: string) => void;
  /** 保存到文件（v0.60）：传出去的是带 import 的完整文本，调用方负责选目录 / 写盘 / toast */
  onSave?: (text: string) => void;
  /** 保存为流程：调用方负责写 flows 记录；返回 false = 没存上 */
  onSaveFlow?: (data: any) => Promise<boolean> | boolean;
  /** 保存 / 载入的结果提示（调用方接 toast） */
  onNotify?: (message: string, level?: 'success' | 'warning' | 'error') => void;
  /** 切走再切回来时恢复上次的步骤（切换视图会卸载本面板） */
  initialState?: any;
  /** 每次变化都回报给调用方（配合 initialState 做跨视图保留） */
  onStateChange?: (state: { steps: ApiBricksStep[]; baseUrl: string; testName: string }) => void;
};

type Draft = {
  actionId: string;
  params: Record<string, any>;
  editingIndex: number;
  key?: string;
};

/** 「结果」栏的头部样式（和 ui-bricks 面板保持一致） */
const PANE_HEAD: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 10px',
  background: '#f7f8fc',
  borderBottom: '1px solid var(--line-soft)',
  fontSize: 12.5,
  fontWeight: 600,
  color: '#4a5165'
};

export default function ApiBricksPanel(props: Props) {
  const { apis, lang, flows, openFlowId, onCopy, onSave, onSaveFlow, onNotify, initialState, onStateChange } = props;

  /**
   * 初始状态：默认空，但支持从 initialState 恢复 ——
   * 切到「接口测试类骨架」再切回来会卸载本面板，拼好的 5 步不能当场消失。
   */
  const boot = initialState || {};

  const [steps, setSteps] = useState<ApiBricksStep[]>(() =>
    Array.isArray(boot.steps) ? boot.steps : []
  );
  const [baseUrl, setBaseUrl] = useState(() => String(boot.baseUrl || ''));
  const [testName, setTestName] = useState(() => String(boot.testName || ''));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [dragIdx, setDragIdx] = useState(-1);
  /** null = 跟着生成器走；字符串 = 用户手改过（步骤一变就重置） */
  const [manual, setManual] = useState<string | null>(null);
  /** v0.62：默认高亮块，点「编辑」切 textarea（和 UI 积木面板保持一致） */
  const [editing, setEditing] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [flowName, setFlowName] = useState('');
  const [flowNote, setFlowNote] = useState('');
  const [flowError, setFlowError] = useState('');
  const [flowHint, setFlowHint] = useState('');
  const [flowWarn, setFlowWarn] = useState(false);

  /** 全部可用变量（提取 / 断言 / 插入变量的下拉都从这里出） */
  const allVars = useMemo(() => collectVariables(steps), [steps]);

  /** 实时预览：步骤 / 语言 / BaseUrl / 方法名任意一项变了立刻重算 */
  const gen = useMemo(
    () =>
      generateApiFlow({
        steps: toGeneratorSteps(steps),
        lang,
        baseUrl,
        testName
      }),
    [steps, lang, baseUrl, testName]
  );

  // 代码变了就把手改的内容交还给生成器（否则用户改一次，后面所有步骤都停在旧文本上）
  useEffect(() => {
    setManual(null);
  }, [gen.code]);

  const shown = manual === null ? gen.code : manual;
  const copyText = gen.imports.length ? gen.imports.join('\n') + '\n\n' + shown : shown;


  /* ---------------- 流程模板：保存 / 载入 ---------------- */

  const flowList = apiFlowsOnly(flows);
  const flowOptions = flowList.map((f: any) => {
    const d = (f && f.data) || {};
    const label = String(d.name || (f && f.title) || '').trim() || '(未命名流程)';
    return { value: f.id, label: d.baseUrl ? label + ' · ' + d.baseUrl : label };
  });

  const notify = (message: string, level?: 'success' | 'warning' | 'error') => {
    if (onNotify) onNotify(message, level);
  };

  const openSave = () => {
    setFlowName(defaultApiFlowName());
    setFlowNote('');
    setFlowError('');
    setSaveOpen(true);
  };

  const doSaveFlow = async () => {
    const name = String(flowName || '').trim();
    if (!name) {
      setFlowError('流程名不能为空');
      return;
    }
    if (!steps.length) {
      setFlowError('还没有步骤，先拼两步再存');
      return;
    }
    const data = apiFlowRecordData({ name, note: flowNote, baseUrl, testName, steps });
    let ok = false;
    if (onSaveFlow) {
      try {
        ok = (await onSaveFlow(data)) !== false;
      } catch (e) {
        ok = false;
      }
    }
    if (!ok) {
      setFlowError('没存上：详见上方提示');
      return;
    }
    setSaveOpen(false);
    setFlowName('');
    setFlowNote('');
    setFlowError('');
    setFlowWarn(false);
    setFlowHint('已保存流程「' + name + '」');
    notify('已保存，去侧栏「流程模板」查看', 'success');
  };

  /** 载入流程：恢复步骤 + BaseUrl + 方法名（接口快照跟着 steps 一起回来的） */
  const loadFlow = (id: string) => {
    const rec = flowList.find((f: any) => f && f.id === id);
    if (!rec) return;
    const data = rec.data || {};
    const restored = parseApiFlowSteps(data.steps);
    if (!restored.length) {
      setFlowWarn(true);
      setFlowHint('这条流程里没有能用的步骤（可能已被删干净）');
      return;
    }
    const name = String(data.name || (rec && rec.title) || '').trim();
    setSteps(restored);
    setManual(null);
    setDraft(null);
    setBaseUrl(String(data.baseUrl || ''));
    setTestName(String(data.testName || ''));
    setFlowWarn(false);
    setFlowHint('已载入「' + name + '」：' + restored.length + ' 步');
    notify('已载入流程「' + name + '」（' + restored.length + ' 步）', 'success');
  };

  // 步骤 / BaseUrl / 方法名变了就回报（调用方用它做跨视图保留）
  useEffect(() => {
    if (onStateChange) onStateChange({ steps, baseUrl, testName });
  }, [steps, baseUrl, testName]);

  /** v0.63：从「流程模板」跳过来时自动载入那一条（只生效一次，见 UI 侧同一段注释） */
  const appliedOpenFlow = useRef(false);
  useEffect(() => {
    if (appliedOpenFlow.current || !openFlowId) return;
    const rec = flowList.find((f: any) => f && String(f.id) === String(openFlowId));
    if (!rec) return;
    appliedOpenFlow.current = true;
    loadFlow(String(openFlowId));
  }, [openFlowId, flowList]);

  /* ---------------- 步骤增删改移 ---------------- */

  const openNew = (action: any) => {
    setDraft({ actionId: action.id, params: stepDefaults(action), editingIndex: -1 });
    setError('');
  };

  const openEdit = (step: ApiBricksStep, index: number) => {
    setDraft({
      actionId: step.actionId,
      params: Object.assign({}, step.params),
      editingIndex: index,
      key: step.key
    });
    setError('');
  };

  /** snapshot 只在 apiRecord 参数上给（选接口时把 method/path/headers/body 一起写进来） */
  const patchDraft = (key: string, value: any, snapshot?: Record<string, any>) => {
    setDraft((d) => {
      if (!d) return d;
      const params = Object.assign({}, d.params, { [key]: value });
      if (snapshot) {
        for (const k of Object.keys(snapshot)) params[k] = snapshot[k];
        /*
         * 选了新接口 → 响应变量名顺手起一个不重名的（resp2、resp3…）。
         * 只在「还没填 / 撞名」时动它：用户自己起过名字就不该被改掉。
         */
        const used = new Set(
          collectVariables(steps, d.editingIndex >= 0 ? d.editingIndex : steps.length).map((v) => v.name)
        );
        const cur = String(params.as === undefined || params.as === null ? '' : params.as).trim();
        if (!cur || used.has(cur)) {
          let n = 1;
          while (used.has('resp' + n)) n += 1;
          params.as = 'resp' + n;
        }
      }
      return Object.assign({}, d, { params });
    });
  };

  const confirmDraft = () => {
    if (!draft) return;
    const action = actionById(draft.actionId);
    if (!action) return;
    const missing = (action.params || []).filter(
      (p: any) =>
        p.required &&
        (draft.params[p.key] === undefined ||
          draft.params[p.key] === null ||
          String(draft.params[p.key]).trim() === '')
    );
    if (missing.length) {
      setError('还差：' + missing.map((p: any) => p.label || p.key).join('、'));
      return;
    }
    const step: ApiBricksStep = {
      key:
        draft.key ||
        's' + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 6),
      actionId: draft.actionId,
      params: Object.assign({}, draft.params)
    };
    setSteps((prev) =>
      draft.editingIndex >= 0
        ? prev.map((s, i) => (i === draft.editingIndex ? step : s))
        : prev.concat([step])
    );
    setDraft(null);
    setError('');
  };

  const removeStep = (index: number) => setSteps((prev) => prev.filter((_, i) => i !== index));

  const moveStep = (index: number, delta: number) => {
    setSteps((prev) => {
      const j = index + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[index];
      next[index] = next[j];
      next[j] = tmp;
      return next;
    });
  };

  /** 拖拽换位：从 from 挪到 to（HTML5 原生拖放，不引第三方库） */
  const dropAt = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setSteps((prev) => {
      if (from >= prev.length || to >= prev.length) return prev;
      const next = prev.slice();
      const moved = next.splice(from, 1)[0];
      next.splice(to, 0, moved);
      return next;
    });
  };

  const clearAll = () => {
    setSteps([]);
    setManual(null);
    setDraft(null);
    setError('');
  };

  const doCopy = () => {
    if (!copyText) return;
    if (onCopy) onCopy(copyText);
  };

  /** v0.60：保存到文件（带 import 的完整文本交给调用方写盘） */
  const doSave = () => {
    if (!copyText) return;
    if (onSave) onSave(copyText);
  };

  const draftAction = draft ? actionById(draft.actionId) : null;
  /** 「从哪个响应」/「插入变量」只列**这一步之前**产生的变量 */
  const draftVars = draft
    ? collectVariables(steps, draft.editingIndex >= 0 ? draft.editingIndex : steps.length)
    : allVars;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
      {/* ---------- 设置条：BaseUrl / 方法名 / 保存载入 ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="muted">BaseUrl</span>
        <Input
          size="small"
          style={{ width: 260 }}
          value={baseUrl}
          placeholder="http://localhost:8080（留空就写相对路径）"
          allowClear
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <span className="muted">方法名</span>
        <Input
          size="small"
          style={{ width: 180 }}
          value={testName}
          placeholder={lang === 'python' ? 'test_flow' : 'testFlow'}
          allowClear
          onChange={(e) => setTestName(e.target.value)}
        />
        {allVars.length ? (
          <Tag color="blue">
            {'可用变量 ' + allVars.length + ' 个：' + allVars.map((v) => v.name).join('、')}
          </Tag>
        ) : null}

        <Space size={6} style={{ marginLeft: 'auto' }}>
          <Button
            size="small"
            icon={<SaveOutlined />}
            disabled={!steps.length}
            title={steps.length ? '把当前步骤存成接口流程，下次直接载入' : '先拼两步再保存'}
            onClick={openSave}
          >
            保存为流程
          </Button>
          <Select
            size="small"
            style={{ width: 200 }}
            // 不设 value：这是「动作」下拉不是「状态」下拉，选完仍显示 placeholder
            value={undefined}
            disabled={!flowOptions.length}
            showSearch
            optionFilterProp="label"
            placeholder={flowOptions.length ? '载入流程' : '载入流程（还没有）'}
            options={flowOptions}
            onChange={(v) => (v ? loadFlow(String(v)) : undefined)}
          />
        </Space>
      </div>

      {/* ---------- 流程模板的结果一行（保存 / 载入之后） ---------- */}
      {flowHint ? (
        <div style={{ fontSize: 12 }}>
          <Tag color={flowWarn ? 'orange' : 'green'}>{flowHint}</Tag>
        </div>
      ) : null}

      {/* ---------- 三栏 ---------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '200px minmax(220px, 340px) minmax(0, 1fr)',
          gap: 10,
          flex: 1,
          minHeight: 0
        }}
      >
        {/* 积木库 */}
        <div className="codegen-source" style={{ gap: 2 }}>
          <div className="codegen-label">积木库</div>
          {API_ACTION_CATEGORIES.map((cat) => {
            // 分类顺序由 API_ACTION_CATEGORIES 决定，动作只按 category 过滤
            const list = API_ACTIONS.filter((a) => a.category === cat.key);
            return (
              <div key={cat.key} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#4a515f', margin: '4px 0' }}>
                  {cat.label}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {list.map((a: any) => (
                    <Button
                      key={a.id}
                      size="small"
                      icon={<PlusOutlined />}
                      title={a.desc}
                      onClick={() => openNew(a)}
                    >
                      {a.name}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* 已选步骤 */}
        <div className="codegen-source" style={{ gap: 4 }}>
          <div className="codegen-label">{'已选步骤（' + steps.length + '）'}</div>
          {steps.length ? (
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
              {steps.map((s, i) => (
                <div
                  key={s.key}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    dropAt(dragIdx, i);
                    setDragIdx(-1);
                  }}
                  onClick={() => openEdit(s, i)}
                  title="点击修改参数；按住可拖动排序"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 4px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: dragIdx === i ? '#eef4ff' : 'transparent',
                    border: '1px solid transparent'
                  }}
                >
                  <span className="muted" style={{ fontSize: 11, width: 16 }}>
                    {i + 1}.
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {summarizeStep(s)}
                  </span>
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowUpOutlined />}
                    disabled={i === 0}
                    title="上移"
                    onClick={(e) => {
                      e.stopPropagation();
                      moveStep(i, -1);
                    }}
                  />
                  <Button
                    size="small"
                    type="text"
                    icon={<ArrowDownOutlined />}
                    disabled={i === steps.length - 1}
                    title="下移"
                    onClick={(e) => {
                      e.stopPropagation();
                      moveStep(i, 1);
                    }}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeStep(i);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <Empty
              description="点左边积木加一步"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ marginTop: 24 }}
            />
          )}
          <Button size="small" onClick={clearAll} disabled={!steps.length}>
            清空
          </Button>
        </div>

        {/* 生成结果 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            border: '1px solid var(--line-soft)',
            borderRadius: 8,
            overflow: 'hidden'
          }}
        >
          <div style={PANE_HEAD}>
            <span>{'生成结果（' + (lang === 'python' ? 'Python · pytest + requests' : 'Java · REST Assured') + '）'}</span>
            <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
              {gen.variables.length + ' 个变量'}
            </span>
          </div>

          {gen.imports.length ? (
            <div
              style={{
                padding: '6px 10px',
                background: '#fbfcff',
                borderBottom: '1px solid var(--line-soft)'
              }}
            >
              <div style={{ fontSize: 11, color: '#8a90a2', marginBottom: 2 }}>
                {'需要的 import（' + gen.imports.length + '）：'}
              </div>
              <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', lineHeight: 1.6 }}>
                {gen.imports.join('\n')}
              </div>
            </div>
          ) : null}

          {gen.warnings.length ? (
            <div
              style={{
                padding: '6px 10px',
                background: '#fff8e6',
                borderBottom: '1px solid #ffe7ba'
              }}
            >
              {gen.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 12, color: '#d46b08', lineHeight: 1.6 }}>
                  {'⚠ ' + w}
                </div>
              ))}
            </div>
          ) : null}

          {editing || !CodeBlockLazy ? (
            <textarea
              className="mono"
              value={shown}
              spellCheck={false}
              onChange={(e) => setManual(e.target.value)}
              placeholder="拼好步骤后，方法体会实时出现在这里；也可以直接手改"
              style={{
                flex: 1,
                minHeight: 120,
                border: 'none',
                outline: 'none',
                resize: 'none',
                padding: '10px 12px',
                fontSize: 12.5,
                lineHeight: 1.7,
                background: '#fff',
                whiteSpace: 'pre'
              }}
            />
          ) : shown ? (
            <div style={{ flex: 1, minHeight: 120, overflow: 'auto', background: '#fff' }}>
              <CodeBlockLazy
                code={shown}
                lang={lang === 'python' ? 'python' : 'java'}
                copyable={false}
                maxHeight="none"
              />
            </div>
          ) : (
            <div className="muted" style={{ padding: '16px 12px', fontSize: 12.5 }}>
              拼好步骤后，方法体会实时出现在这里
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              borderTop: '1px solid var(--line-soft)',
              background: '#fafbfe'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {shown ? shown.split('\n').length + ' 行' : '还没有代码'}
              </span>
              {CodeBlockLazy && shown ? (
                <Button size="small" type="link" style={{ fontSize: 11.5 }} onClick={() => setEditing(!editing)}>
                  {editing ? '看高亮' : '编辑'}
                </Button>
              ) : null}
            </div>
            <Space size={6}>
              <Button size="small" type="primary" ghost icon={<SaveOutlined />} disabled={!copyText} onClick={doSave}>
                保存到文件
              </Button>
              <Button size="small" icon={<CopyOutlined />} disabled={!copyText} onClick={doCopy}>
                复制
              </Button>
              <Button
                size="small"
                icon={<ClearOutlined />}
                disabled={!steps.length && !shown}
                onClick={clearAll}
              >
                清空
              </Button>
            </Space>
          </div>
        </div>
      </div>

      {draft ? (
        <ApiActionParamModal
          open
          action={draftAction}
          params={draft.params}
          apis={apis}
          vars={draftVars}
          editing={draft.editingIndex >= 0}
          error={error}
          onChange={patchDraft}
          onCancel={() => {
            setDraft(null);
            setError('');
          }}
          onOk={confirmDraft}
        />
      ) : null}

      {saveOpen ? (
        <SaveApiFlowModal
          open
          name={flowName}
          note={flowNote}
          stepCount={steps.length}
          baseUrl={baseUrl}
          error={flowError}
          onNameChange={setFlowName}
          onNoteChange={setFlowNote}
          onCancel={() => {
            setSaveOpen(false);
            setFlowError('');
          }}
          onOk={doSaveFlow}
        />
      ) : null}
    </div>
  );
}