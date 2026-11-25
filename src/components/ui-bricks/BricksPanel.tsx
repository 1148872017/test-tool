import React, { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Radio, Select, Space, Tag } from 'antd';
import {
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DeleteOutlined,
  CopyOutlined,
  ClearOutlined
} from '@ant-design/icons';
import { UI_ACTIONS, UI_ACTION_CATEGORIES, actionById } from '../../../shared/uiActions';
import { generateSteps, pomClassNameFromPage } from '../../../shared/uiStepGen';
import {
  POM_MODE_OPTIONS,
  elementOptions,
  stepDefaults,
  summarizeStep,
  toGeneratorSteps,
  type BricksStep
} from './brickHelpers';
import ActionParamModal from './ActionParamModal';

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
  const { pages, pageId, onSelectPage, pageName, pageUrl, className, elements, lang, onCopy } = props;

  const [steps, setSteps] = useState<BricksStep[]>([]);
  const [pomMode, setPomMode] = useState<'none' | 'generated' | 'existing'>('none');
  /** 「用已有类」时用户填的类名（generated 模式的类名自动推，不落这里） */
  const [pomClass, setPomClass] = useState('');
  const [pomVar, setPomVar] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [dragIdx, setDragIdx] = useState(-1);
  /** null = 跟着生成器走；字符串 = 用户手改过（步骤一变就重置） */
  const [manual, setManual] = useState<string | null>(null);

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
          <Tag color="blue">{elList.length + ' 个元素'}</Tag>
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
      </div>

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
    </div>
  );
}