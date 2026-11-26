import React from 'react';
import { AutoComplete, Input, InputNumber, Modal, Select, Tag } from 'antd';
import { msHint } from '../../../shared/uiActions';
import { apiOptions, apiSnapshot, identOk, insertVarToken, variableOptions, type FlowVar } from './apiBrickHelpers';

/**
 * 点积木后弹出的参数面板：按动作的 params 定义自动出控件。
 *
 * 和 ui-bricks/ActionParamModal.tsx 同一套路（状态全在面板手里、这里只渲染），
 * 但多了两个接口特有的控件：
 *   apiRecord → 从 apis 集合选接口，选中瞬间把 method/path/headers/body 存成快照
 *   ident     → 变量名；`from` 类参数给「前面步骤已产生的变量」下拉
 *   文本参数旁挂「插入变量 ▾」，点了把 `${变量}` 插到光标处
 */
type Props = {
  open: boolean;
  /** 当前要填参数的动作（apiActions.js 里的一条） */
  action: any;
  params: Record<string, any>;
  /** apis 集合：apiRecord 参数的下拉从这里出 */
  apis: any[];
  /** 前面步骤已产生的变量：`from` 参数与「插入变量」只列这些 */
  vars: FlowVar[];
  editing: boolean;
  error: string;
  /** snapshot 只在选了接口时给（带上 method/path/headers/body） */
  onChange: (key: string, value: any, snapshot?: Record<string, any>) => void;
  onCancel: () => void;
  onOk: () => void;
};

const LABEL: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#4a5165',
  marginBottom: 3
};

const HINT: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.6,
  marginTop: 3,
  color: '#8a90a2'
};

const WARN: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.6,
  marginTop: 3,
  color: '#d46b08'
};

export default function ApiActionParamModal(props: Props) {
  const { open, action, params, apis, vars, editing, error, onChange, onCancel, onOk } = props;

  /**
   * 「插入变量」要插到光标处，所以得摸到真实 input。
   * 拿不到（测试里的假组件 / 还没聚焦）就退回「接在末尾」，不报错。
   */
  const inputRefs = React.useRef<Record<string, any>>({});

  if (!action) return null;

  const varOpts = variableOptions(vars);
  const pickApi = (id: string) => {
    const hit = (apis || []).find((a: any) => a && a.id === id);
    onChange('apiId', id, hit ? apiSnapshot(hit) : undefined);
  };

  const doInsertVar = (key: string, name: string) => {
    const cur = String(params && params[key] !== undefined && params[key] !== null ? params[key] : '');
    const inst = inputRefs.current[key];
    const dom = inst && (inst.input || inst.resizableTextArea || inst);
    let caret: number | undefined;
    try {
      if (dom && typeof dom.selectionStart === 'number') caret = dom.selectionStart;
    } catch (e) {
      caret = undefined;
    }
    onChange(key, insertVarToken(cur, name, caret));
  };

  /** 文本框 + 「插入变量」下拉（没有可用变量时不渲染那个下拉） */
  const textField = (p: any) => {
    const raw = params ? params[p.key] : undefined;
    return (
      <div key={p.key} style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={LABEL}>
            {p.label || p.key}
            {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
          </div>
          {varOpts.length ? (
            <Select
              size="small"
              // 不设 value：这是「动作」下拉不是「状态」下拉，选完仍显示 placeholder
              value={undefined}
              style={{ width: 150 }}
              placeholder="插入变量"
              showSearch
              optionFilterProp="label"
              options={varOpts}
              onChange={(v: any) => (v ? doInsertVar(p.key, String(v)) : undefined)}
            />
          ) : null}
        </div>
        <Input
          ref={(el: any) => {
            inputRefs.current[p.key] = el;
          }}
          value={raw === undefined || raw === null ? '' : String(raw)}
          placeholder={p.placeholder || (p.default === undefined ? '' : String(p.default))}
          allowClear
          onChange={(e) => onChange(p.key, e.target.value)}
        />
        {varOpts.length ? (
          <div style={HINT}>{'可嵌 ${变量} 引用前面步骤的结果；也可以点右上角「插入变量」'}</div>
        ) : null}
      </div>
    );
  };

  return (
    <Modal
      open={open}
      title={(editing ? '修改积木：' : '添加积木：') + action.name}
      okText={editing ? '保存修改' : '加这一步'}
      cancelText="取消"
      onOk={onOk}
      onCancel={onCancel}
      width={520}
    >
      {action.desc ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {action.desc}
        </div>
      ) : null}

      {(action.params || []).map((p: any) => {
        const raw = params ? params[p.key] : undefined;

        /* ---------- 接口记录（选中即存快照） ---------- */
        if (p.type === 'apiRecord') {
          const picked = String(raw || '').trim();
          const hit = (apis || []).find((a: any) => a && a.id === picked);
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              <div style={LABEL}>
                {p.label || p.key}
                {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
              </div>
              <Select
                style={{ width: '100%' }}
                value={picked || undefined}
                placeholder={apis && apis.length ? '从接口记录里选一个' : '还没有接口记录（去「接口记录」新增）'}
                showSearch
                optionFilterProp="label"
                options={apiOptions(apis)}
                onChange={(v: any) => pickApi(String(v))}
              />
              {hit ? (
                <div style={{ marginTop: 4 }}>
                  <Tag color="blue">{String((hit.data || {}).method || '').toUpperCase()}</Tag>
                  <span className="mono" style={{ fontSize: 11.5 }}>
                    {String((hit.data || {}).url || '')}
                  </span>
                </div>
              ) : null}
              {picked && !hit ? (
                <div style={WARN}>{'接口记录已删除，但步骤里的快照还在，生成结果不受影响'}</div>
              ) : null}
              <div style={HINT}>
                {'选中的瞬间会把 method / path / headers / body 抄进这一步（快照），之后接口记录改了也不影响已存的流程'}
              </div>
            </div>
          );
        }

        /* ---------- 变量名 ---------- */
        if (p.type === 'ident') {
          const value = String(raw === undefined || raw === null ? '' : raw).trim();
          /* `from` = 读前面步骤的变量：给下拉，省得手打错名字 */
          if (p.key === 'from') {
            return (
              <div key={p.key} style={{ marginBottom: 10 }}>
                <div style={LABEL}>
                  {p.label || p.key}
                  {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
                </div>
                <AutoComplete
                  style={{ width: '100%' }}
                  value={raw === undefined || raw === null ? '' : String(raw)}
                  placeholder={varOpts.length ? '选前面步骤产生的变量' : '前面还没有产生变量的步骤'}
                  options={varOpts}
                  onChange={(v: any) => onChange(p.key, v)}
                />
                <div style={HINT}>
                  {varOpts.length
                    ? '只列前面步骤已产生的变量（后面的步骤还没跑，取不到）'
                    : '先加一步「调用接口」，这里才有东西可选'}
                </div>
              </div>
            );
          }
          const bad = value !== '' && !identOk(value);
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              <div style={LABEL}>
                {p.label || p.key}
                {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
              </div>
              <Input
                value={raw === undefined || raw === null ? '' : String(raw)}
                placeholder={p.placeholder || (p.default === undefined ? '' : String(p.default))}
                allowClear
                status={bad ? 'error' : undefined}
                onChange={(e) => onChange(p.key, e.target.value)}
              />
              {bad ? (
                <div style={WARN}>{'变量名只能用字母 / 数字 / 下划线，且不能数字开头（Java 和 Python 都认的写法）'}</div>
              ) : (
                <div style={HINT}>{'后面用它提取 / 断言'}</div>
              )}
            </div>
          );
        }

        /* ---------- 数字 ---------- */
        if (p.type === 'number') {
          // v0.61：毫秒类参数给个灰字换算（`2000` → `= 2 秒`），和 UI 积木保持一致
          const hint = /ms/i.test(p.key) || /毫秒/.test(String(p.label || '')) ? msHint(raw) : '';
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              <div style={LABEL}>
                {p.label || p.key}
                {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <InputNumber
                  style={{ width: 180 }}
                  value={raw === '' || raw === undefined || raw === null ? undefined : Number(raw)}
                  placeholder={p.placeholder || String(p.default === undefined ? '' : p.default)}
                  onChange={(v: any) => onChange(p.key, v)}
                />
                {hint ? (
                  <span style={{ fontSize: 11.5, color: '#8a90a2' }}>{hint}</span>
                ) : null}
              </div>
            </div>
          );
        }

        /* ---------- 文本（含断言期望值这种字面量） ---------- */
        return textField(p);
      })}

      {error ? (
        <div style={{ color: '#cf1322', fontSize: 12, marginTop: 4 }}>{error}</div>
      ) : null}
    </Modal>
  );
}