import React, { useMemo, useState } from 'react';
import { Segmented, Button, Tooltip } from 'antd';
import { toTable } from '../../shared/jsonTable.js';

type Props = {
  /** 字段名（headers / body） */
  fieldKey: string;
  /** 字段原文 */
  raw: string;
};

/** 折叠阈值：超过这么多行就折叠 */
const COLLAPSE_AT = 5;

/**
 * JSON / 表格 双视图。
 *
 * - headers：按行 + 冒号解析成键值对
 * - body：JSON.parse 后转表格（非 JSON 不提供表格视图）
 * - 表格只读，编辑还是切回 JSON
 * - 超过 5 行折叠，可展开
 */
export default function JsonTableToggle({ fieldKey, raw }: Props) {
  const table = useMemo(() => toTable(fieldKey, raw), [fieldKey, raw]);
  const [view, setView] = useState<'table' | 'json'>(table.canTable ? 'table' : 'json');
  const [expanded, setExpanded] = useState(false);

  // 不能表格化：直接显示原文
  if (!table.canTable) {
    return (
      <div className="code-block">
        <pre className="mono">{String(raw)}</pre>
      </div>
    );
  }

  const rows = expanded ? table.rows : table.rows.slice(0, COLLAPSE_AT);
  const needCollapse = table.total > COLLAPSE_AT;

  return (
    <div className="json-table-wrap">
      <div className="json-table-head">
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as 'table' | 'json')}
          options={[
            { label: '表格', value: 'table' },
            { label: 'JSON', value: 'json' }
          ]}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {table.total} 行
        </span>
      </div>

      {view === 'table' ? (
        <>
          <div className="json-table">
            <div className="json-table-row json-table-header">
              <div className="json-table-key">参数名</div>
              <div className="json-table-value">参数值</div>
            </div>
            {rows.map((r: any, i: number) => (
              <div className="json-table-row" key={i}>
                <div className="json-table-key mono" title={r.key}>
                  {r.key}
                </div>
                <div className="json-table-value">
                  {r.complex ? (
                    <Tooltip title={<pre className="json-table-tip mono">{r.title}</pre>} placement="left">
                      <span className="json-table-complex">{r.value}</span>
                    </Tooltip>
                  ) : (
                    <span className="mono" title={r.title}>
                      {r.value}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {needCollapse ? (
            <div className="json-table-more">
              <Button type="link" size="small" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起' : `展开全部（共 ${table.total} 行）`}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="code-block">
          <pre className="mono">{String(raw)}</pre>
        </div>
      )}
    </div>
  );
}
