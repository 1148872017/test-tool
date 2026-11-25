import React from 'react';
import { Input, InputNumber, Modal, Select, Switch, Tag } from 'antd';
import { elementOptions, locatorModeShort } from './brickHelpers';
import ElementCountTip from './ElementCountTip';

/**
 * 点积木后弹出的小面板：按动作的 params 定义自动出控件。
 *
 * 刻意不写 hooks（所有状态都由 BricksPanel 持有）：
 * 这样测试可以直接把组件函数当纯函数调用，不需要额外的渲染运行时。
 */
type Props = {
  open: boolean;
  /** 当前要填参数的动作（uiActions.js 里的一条） */
  action: any;
  params: Record<string, any>;
  /** 当前页面的元素集合：element 类型的下拉只从这里选 */
  elements: any[];
  /** 没选页面时元素下拉要给出「先在上面选页面」的提示 */
  pageId: string;
  editing: boolean;
  error: string;
  onChange: (key: string, value: any, element?: any) => void;
  onCancel: () => void;
  onOk: () => void;
};

const LABEL: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#4a5165',
  marginBottom: 3
};

export default function ActionParamModal(props: Props) {
  const { open, action, params, elements, pageId, editing, error, onChange, onCancel, onOk } = props;
  if (!action) return null;

  return (
    <Modal
      open={open}
      title={(editing ? '修改积木：' : '添加积木：') + action.name}
      okText={editing ? '保存修改' : '加这一步'}
      cancelText="取消"
      onOk={onOk}
      onCancel={onCancel}
      width={480}
    >
      {action.desc ? (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {action.desc}
        </div>
      ) : null}

      {(action.params || []).map((p: any) => {
        const raw = params ? params[p.key] : undefined;
        const label = (
          <div style={LABEL}>
            {p.label || p.key}
            {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
          </div>
        );

        if (p.type === 'element') {
          const pickedName = String(raw || '').trim();
          const picked = (elements || []).find((e) => e && String(e.name || '').trim() === pickedName);
          const filled = (elements || []).filter((e) => e && String(e.name || '').trim()).length;
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              {/*
                标签上带元素个数，hover 直接列出「名称 · 定位方式」——
                和积木区「N 个元素」Tag 同一份提示，用户不用退出去看页面元素页。
              */}
              <ElementCountTip elements={elements}>
                <div style={LABEL}>
                  {p.label || p.key}
                  {p.required ? <span style={{ color: '#cf1322' }}> *</span> : null}
                  {filled ? (
                    <span
                      className="muted"
                      style={{ fontWeight: 400, marginLeft: 6, fontSize: 11.5 }}
                    >
                      {'（' + filled + ' 个元素）'}
                    </span>
                  ) : null}
                </div>
              </ElementCountTip>
              {!pageId ? (
                <div style={{ fontSize: 12, color: '#d46b08', marginBottom: 4 }}>
                  先在上面选页面，元素下拉才有内容
                </div>
              ) : null}
              <Select
                style={{ width: '100%' }}
                value={pickedName || undefined}
                disabled={!pageId}
                placeholder={pageId ? '从当前页面的元素里选' : '先在上面选页面'}
                showSearch
                optionFilterProp="label"
                options={elementOptions(elements)}
                onChange={(v) =>
                  onChange(
                    p.key,
                    v,
                    (elements || []).find((e) => e && String(e.name || '').trim() === String(v))
                  )
                }
              />
              {picked ? (
                <div style={{ marginTop: 4 }}>
                  <Tag color="blue">{'定位方式：' + locatorModeShort(picked.mode)}</Tag>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {String(picked.selector || '')}
                  </span>
                </div>
              ) : null}
            </div>
          );
        }

        if (p.type === 'number') {
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              {label}
              <InputNumber
                style={{ width: 160 }}
                value={raw === '' || raw === undefined || raw === null ? undefined : Number(raw)}
                placeholder={p.placeholder || String(p.default === undefined ? '' : p.default)}
                onChange={(v) => onChange(p.key, v)}
              />
            </div>
          );
        }

        if (p.type === 'boolean') {
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              {label}
              <Switch checked={!!raw} onChange={(v) => onChange(p.key, v)} />
            </div>
          );
        }

        if (p.type === 'select') {
          return (
            <div key={p.key} style={{ marginBottom: 10 }}>
              {label}
              <Select
                style={{ width: '100%' }}
                value={raw === undefined || raw === null || raw === '' ? undefined : raw}
                placeholder={p.placeholder || '选一个值'}
                options={p.options || []}
                onChange={(v) => onChange(p.key, v)}
              />
            </div>
          );
        }

        return (
          <div key={p.key} style={{ marginBottom: 10 }}>
            {label}
            <Input
              value={raw === undefined || raw === null ? '' : String(raw)}
              placeholder={p.placeholder || ''}
              allowClear
              onChange={(e) => onChange(p.key, e.target.value)}
            />
          </div>
        );
      })}

      {error ? (
        <div style={{ color: '#cf1322', fontSize: 12, marginTop: 4 }}>{error}</div>
      ) : null}
    </Modal>
  );
}