import React, { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Radio, Select, Space, Tag } from 'antd';
import {
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
  CopyOutlined,
  ClearOutlined,
  SaveOutlined
} from '@ant-design/icons';
import { UI_ACTIONS, UI_ACTION_CATEGORIES, actionById } from '../../../shared/uiActions';
import { generateSteps, pomClassNameFromPage } from '../../../shared/uiStepGen';
import {
  POM_MODE_OPTIONS,
  defaultFlowName,
  elementOptions,
  flowPom,
  flowRecordData,
  normalizePomMode,
  parseFlowSteps,
  stepDefaults,
  summarizeStep,
  toGeneratorSteps,
  type BricksStep,
  type PomMode
} from './brickHelpers';
import ActionParamModal from './ActionParamModal';
import ElementCountTip from './ElementCountTip';
import SaveFlowModal from './SaveFlowModal';

/**
 * 「积木式动作拼装」面板（三栏：积木库 / 已选步骤 / 生成结果）。
 *
 * ============================================================
 * 定位
 * ============================================================
 * 这里不是低代码平台，产物就是一段**真实可编辑的代码**：
 *   - 左边点积木 → 小面板填参数 → 中间多一步
 *   - 中间可拖动 / 上下移 / 删除
 *   - 右边 textarea 实时出方法体，可以直接改、直接复制进 IDEA
 *
 * 生成逻辑全在 shared/uiStepGen.js（纯函数），这里只负责状态和交互，
 * 所以「预览」和「真代码」不会各写一套。
 */
type Props = {
  /** 「页面元素」集合里的全部页面 */
  pages: any[];
  /** 当前选中的页面 id（和左侧页面对象类视图共用同一份状态） */
  pageId: string;
  onSelectPage: (id: string) => void;
  pageName: string;
  pageUrl: string;
  /** 工具条上的「类名」：填了就优先拿它推 POM 类名（和 POM 类生成的取名规则一致） */
  className?: string;
  /** 当前页面的元素（只有填了名字的行有效） */
  elements: any[];
  lang: 'java' | 'python';
  /** 复制走调用方的剪贴板（渲染进程的 api.copy），组件自己不做副作用 */
  onCopy?: (text: string) => void;
  /**
   * 保存到文件（v0.60）：传出去的是带 import 的完整文本，
   * 调用方负责弹目录选择 / 写盘 / toast —— 组件自己不碰 api。
   */
  onSave?: (text: string) => void;
  /** 「流程模板」集合的记录：工具条「载入流程」下拉从这里出 */
  flows?: any[];
  /**
   * 保存为流程：调用方负责写 flows 记录（组件不碰 api / toast，测试才好跑）。
   * 返回 false = 没存上，面板据此不关弹窗。
   */
  onSaveFlow?: (data: any) => Promise<boolean> | boolean;
  /** 保存 / 载入的结果提示（调用方接 toast）；组件自己不做副作用 */
  onNotify?: (message: string, level?: 'success' | 'warning' | 'error') => void;
  /**
   * 「用本页生成的」：这个页面的 POM 类在**本次会话**里是否已经生成过。
   * 平台不存生成的代码，所以只能靠调用方记住「点过页面对象类的生成预览」。
   */
  pomReady?: boolean;
  /** 点「去生成页面对象类」：调用方切到 POM 视图并顺手生成 */
  onGoGeneratePom?: () => void;
  /** 切走再切回来时恢复上次的步骤 / POM 配置（切换视图会卸载本面板） */
  initialState?: any;
  /** 每次步骤或 POM 配置变化都回报给调用方（配合 initialState 做跨视图保留） */
  onStateChange?: (state: {
    steps: BricksStep[];
    pomMode: PomMode;
    pomClass: string;
    pomVar: string;
  }) => void;
};

type Draft = {
  actionId: string;
  params: Record<string, any>;
  editingIndex: number;
  elementMode?: string;
  elementSelector?: string;
  key?: string;
};

/** 三栏里「结果」那一栏的头部样式 */
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

export default function BricksPanel(props: Props) {
  const {
    pages,
    pageId,
    onSelectPage,
    pageName,
    pageUrl,
    className,
    elements,
    lang,
    onCopy,
    onSave,
    flows,
    onSaveFlow,
    onNotify,
    pomReady,
    onGoGeneratePom,
    initialState,
    onStateChange
  } = props;

  /**
   * 初始状态：默认空，但支持从 initialState 恢复。
   * 为什么要这个 —— 切到「页面对象类」再切回来会卸载本面板，
   * 用户辛苦拼的 5 步会当场消失（「去生成页面对象类」按钮正好会触发切换）。
   */
  const boot = initialState || {};

  const [steps, setSteps] = useState<BricksStep[]>(() =>
    Array.isArray(boot.steps) ? boot.steps : []
  );
  const [pomMode, setPomMode] = useState<PomMode>(() => normalizePomMode(boot.pomMode));
  /** 「用已有类」时用户填的类名（generated 模式的类名自动推，不落这里） */
  const [pomClass, setPomClass] = useState(() => String(boot.pomClass || ''));
  const [pomVar, setPomVar] = useState(() => String(boot.pomVar || ''));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [dragIdx, setDragIdx] = useState(-1);
  /** null = 跟着生成器走；字符串 = 用户手改过（步骤一变就重置） */
  const [manual, setManual] = useState<string | null>(null);
  /** 「保存为流程」弹窗 */
  const [saveOpen, setSaveOpen] = useState(false);
  const [flowName, setFlowName] = useState('');
  const [flowNote, setFlowNote] = useState('');
  const [flowError, setFlowError] = useState('');
  /** 保存 / 载入之后的一行结果（「已载入 5 步」/「关联页面已删除…」） */
  const [flowHint, setFlowHint] = useState('');
  /** hint 是警告还是成功（决定 Tag 颜色） */
  const [flowWarn, setFlowWarn] = useState(false);

  /** 只认填了名字的元素：空行给出去会变成 `loginPage.()` */
  const elList = useMemo(
    () => (elements || []).filter((e) => e && String(e.name || '').trim()),
    [elements]
  );

  /** 「用本页生成的」自动类名：和 POM 类生成 / 生成器里用的是同一个函数 */
  const autoClass = pomClassNameFromPage(pageName, pageUrl, className);
  const effectiveClass = pomMode === 'existing' ? pomClass : autoClass;

  /**
   * 实时预览：步骤 / POM 模式 / 语言任意一项变了立刻重算。
   * 元素定位用「当前页面元素」的最新值（toGeneratorSteps 会覆盖步骤里的快照）。
   */
  const gen = useMemo(
    () =>
      generateSteps({
        steps: toGeneratorSteps(steps, elList),
        lang,
        pomMode,
        pomClass: effectiveClass,
        pomVar,
        pageName,
        pageUrl,
        className
      } as any),
    [steps, elList, lang, pomMode, effectiveClass, pomVar, pageName, pageUrl, className]
  );

  // 代码变了就把手改的内容交还给生成器（否则用户改一次，后面所有步骤都停在旧文本上）
  useEffect(() => {
    setManual(null);
  }, [gen.code]);

  const shown = manual === null ? gen.code : manual;
  const copyText = gen.imports.length ? gen.imports.join('\n') + '\n\n' + shown : shown;

  /* ---------------- 流程模板：保存 / 载入 ---------------- */

  /** 「流程模板」集合里的记录（没传给就当空表，下拉显示「还没有」） */
  const flowList = Array.isArray(flows) ? flows : [];
  const flowOptions = flowList.map((f: any) => {
    const d = (f && f.data) || {};
    const label = String(d.name || (f && f.title) || '').trim() || '(未命名流程)';
    return { value: f.id, label: d.pageName ? label + ' · ' + d.pageName : label };
  });

  const notify = (message: string, level?: 'success' | 'warning' | 'error') => {
    if (onNotify) onNotify(message, level);
  };

  /** 打开保存弹窗：名字先按「页面名 + 月日」填好，用户回车就能存 */
  const openSave = () => {
    setFlowName(defaultFlowName(pageName));
    setFlowNote('');
    setFlowError('');
    setSaveOpen(true);
  };

  /** 保存：把当前步骤 + POM 配置交给调用方写 flows 记录 */
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
    const data = flowRecordData({
      name,
      note: flowNote,
      pageId,
      pageName,
      steps,
      pomMode,
      // 自动类名也存下来：流程模板列表 / 详情里能直接看到这套流程用的是哪个类
      pomClass: pomMode === 'existing' ? pomClass : pomMode === 'generated' ? autoClass : '',
      pomVar
    });
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

  /**
   * 载入流程：恢复步骤 + POM 配置 + 页面选择。
   *
   * 页面还在就自动选中（元素从页面来）；页面被删了只提示、不清空步骤 ——
   * 步骤里带着选元素时的定位快照，换个页面重选元素仍能接着用。
   */
  const loadFlow = (id: string) => {
    const rec = flowList.find((f: any) => f && f.id === id);
    if (!rec) return;
    const data = rec.data || {};
    const restored = parseFlowSteps(data.steps);
    if (!restored.length) {
      setFlowWarn(true);
      setFlowHint('这条流程里没有能用的步骤（可能已被删干净）');
      return;
    }
    setSteps(restored);
    setManual(null);
    setDraft(null);
    const pom = flowPom(data);
    setPomMode(pom.pomMode);
    setPomClass(pom.pomClass);
    setPomVar(pom.pomVar);

    const pid = String(data.pageId || '').trim();
    const hit = pid ? pages.find((p: any) => p && p.id === pid) : null;
    const name = String(data.name || (rec && rec.title) || '').trim();
    if (hit) {
      if (pid !== pageId) onSelectPage(pid);
      setFlowWarn(false);
      setFlowHint('已载入「' + name + '」：' + restored.length + ' 步');
      notify('已载入流程「' + name + '」（' + restored.length + ' 步）', 'success');
    } else {
      setFlowWarn(true);
      setFlowHint('已载入「' + name + '」，但关联页面已删除，元素需要重选');
      notify('关联页面已删除，元素需要重选', 'warning');
    }
  };

  // 步骤 / POM 配置变了就回报（调用方用它做跨视图保留）
  useEffect(() => {
    if (onStateChange) onStateChange({ steps, pomMode, pomClass, pomVar });
  }, [steps, pomMode, pomClass, pomVar]);

  /* ---------------- 步骤增删改移 ---------------- */
  const openNew = (action: any) => {
    setDraft({
      actionId: action.id,
      params: stepDefaults(action),
      editingIndex: -1
    });
    setError('');
  };

  const openEdit = (step: BricksStep, index: number) => {
    setDraft({
      actionId: step.actionId,
      params: Object.assign({}, step.params),
      editingIndex: index,
      elementMode: step.elementMode,
      elementSelector: step.elementSelector,
      key: step.key
    });
    setError('');
  };

  const patchDraft = (key: string, value: any, element?: any) => {
    setDraft((d) => {
      if (!d) return d;
      const next: Draft = Object.assign({}, d, {
        params: Object.assign({}, d.params, { [key]: value })
      });
      if (element) {
        next.elementMode = element.mode || 'css';
        next.elementSelector = element.selector || '';
      }
      return next;
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
    const step: BricksStep = {
      key:
        draft.key ||
        's' + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 6),
      actionId: draft.actionId,
      params: Object.assign({}, draft.params),
      elementMode: draft.elementMode,
      elementSelector: draft.elementSelector
    };
    setSteps((prev) =>
      draft.editingIndex >= 0
        ? prev.map((s, i) => (i === draft.editingIndex ? step : s))
        : prev.concat([step])
    );
    setDraft(null);
    setError('');
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

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

  /**
   * v0.60：「保存到文件」。
   * 以前积木视图只有「复制」——用户拼完还要自己新建文件粘进去，等于白拼。
   * 传出去的是**带 import 的完整文本**（和复制一样），落盘后就是一个能编译的文件。
   */
  const doSave = () => {
    if (!copyText) return;
    if (onSave) onSave(copyText);
  };

  const draftAction = draft ? actionById(draft.actionId) : null;
  const pomModeLabel =
    (POM_MODE_OPTIONS.find((m) => m.value === pomMode) || { label: '不使用' }).label;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
      {/* ---------- 设置条：页面 / POM / 变量 ---------- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="muted">页面</span>
        <Select
          size="small"
          style={{ width: 240 }}
          value={pageId || undefined}
          onChange={(v) => onSelectPage(v ? String(v) : '')}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={pages.length ? '选一个页面（元素从这来）' : '还没有页面（去「页面元素」新增）'}
          options={pages.map((p) => ({
            value: p.id,
            label: `${(p.data && p.data.name) || ''} · ${(p.data && p.data.url) || ''}`
          }))}
        />
        {pageId ? (
          /*
           * 「（N 个元素）」上给 hover 提示：每行一个元素（名称 · 定位方式）。
           * 光看数字不知道是哪几个，得回头翻「页面元素」页 —— 用户明确提过这个痛点。
           * 元素为空时 ElementCountTip 不包 Tooltip（空提示框更让人困惑）。
           */
          <ElementCountTip elements={elList}>
            <Tag color="blue">{elList.length + ' 个元素'}</Tag>
          </ElementCountTip>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            先选页面，元素下拉才有内容
          </span>
        )}

        <span className="muted" style={{ marginLeft: 6 }}>
          POM
        </span>
        <Radio.Group
          size="small"
          optionType="button"
          buttonStyle="solid"
          value={pomMode}
          options={POM_MODE_OPTIONS}
          onChange={(e) => setPomMode(e.target.value)}
        />
        {pomMode === 'generated' ? (
          <Tag color="geekblue">{'自动类名：' + autoClass}</Tag>
        ) : null}
        {pomMode === 'existing' ? (
          <Input
            size="small"
            style={{ width: 200 }}
            value={pomClass}
            onChange={(e) => setPomClass(e.target.value)}
            placeholder="已有页面对象类名，如 MyLoginPage"
            allowClear
          />
        ) : null}
        {pomMode !== 'none' ? (
          <>
            <span className="muted">变量</span>
            <Input
              size="small"
              style={{ width: 130 }}
              value={pomVar}
              onChange={(e) => setPomVar(e.target.value)}
              placeholder={lang === 'python' ? 'login_page' : 'loginPage'}
              allowClear
            />
          </>
        ) : null}

        {/* 「流程模板」：保存 / 载入。放在工具条最右边，拼完随手存 */}
        <Space size={6} style={{ marginLeft: 'auto' }}>
          <Button
            size="small"
            icon={<SaveOutlined />}
            disabled={!steps.length}
            title={steps.length ? '把当前步骤存成流程模板，下次直接载入' : '先拼两步再保存'}
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

      {/* ---------- 「用本页生成的」：产物在哪 / 先做什么 ---------- */}
      {pomMode === 'generated' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '6px 10px',
            borderRadius: 8,
            background: pomReady ? '#f6ffed' : '#fffbe6',
            border: '1px solid ' + (pomReady ? '#b7eb8f' : '#ffe58f')
          }}
        >
          <span style={{ fontSize: 12.5, color: pomReady ? '#237804' : '#ad6800' }}>
            {(pomReady ? '✅ 类名 ' : '⚠ 类名 ') +
              autoClass +
              (pomReady ? ' 已生成过（存到你的项目里了）' : ' 还没生成')}
          </span>
          {pomReady ? (
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              onClick={() => (onGoGeneratePom ? onGoGeneratePom() : undefined)}
            >
              先看页面对象类 →
            </Button>
          ) : (
            <Button
              size="small"
              type="primary"
              ghost
              onClick={() => (onGoGeneratePom ? onGoGeneratePom() : undefined)}
            >
              去生成页面对象类 →
            </Button>
          )}
          <span className="muted" style={{ fontSize: 11.5, width: '100%', lineHeight: 1.7 }}>
            {'① 先在「页面对象类」生成 POM 类（存到你的项目里）　② 再回来用积木拼方法体 —— 方法体里只调用这个类，不会自动建文件'}
          </span>
        </div>
      ) : null}

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
          gridTemplateColumns: '200px minmax(220px, 320px) minmax(0, 1fr)',
          gap: 10,
          flex: 1,
          minHeight: 0
        }}
      >
        {/* 积木库 */}
        <div className="codegen-source" style={{ gap: 2 }}>
          <div className="codegen-label">积木库</div>
          {UI_ACTION_CATEGORIES.map((cat) => {
            // 分类顺序由 UI_ACTION_CATEGORIES 决定，动作只按 category 过滤
            const list = UI_ACTIONS.filter((a) => a.category === cat.key);
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
            <span>{'生成结果（' + (lang === 'python' ? 'Python' : 'Java') + '）'}</span>
            <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
              {pomModeLabel}
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
            <span className="muted" style={{ fontSize: 11.5 }}>
              {shown ? shown.split('\n').length + ' 行' : '还没有代码'}
            </span>
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
        <ActionParamModal
          open
          action={draftAction}
          params={draft.params}
          elements={elList}
          pageId={pageId}
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
        <SaveFlowModal
          open
          name={flowName}
          note={flowNote}
          stepCount={steps.length}
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
