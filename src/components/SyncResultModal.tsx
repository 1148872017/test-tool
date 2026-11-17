import React from 'react';
import { Modal, Button, Tag } from 'antd';
import { WarningOutlined } from '@ant-design/icons';

type Props = { result: any; onClose: () => void; onShowImpact?: () => void };

/**
 * 同步结果摘要卡片。
 * 只报数，不报错：缺描述是常态（Apifox 里本来就没写），用灰字说明就行，不上红色。
 */
export default function SyncResultModal({ result, onClose, onShowImpact }: Props) {
  if (!result) return null;
  const s = result.stats || {};
  const doc = result.doc || {};
  const file = String(result.file || '').split(/[\\/]/).pop() || 'openapi.json';
  const changed = s.changed || 0;
  const affected = s.affectedCases || 0;

  const cells = [
    { label: '新增', value: s.added || 0, tone: 'new' },
    { label: '更新', value: s.updated || 0, tone: '' },
    { label: '跳过', value: s.skipped || 0, tone: '' },
    { label: '缺描述', value: s.missingDesc || 0, tone: 'dim' }
  ];

  return (
    <Modal
      open
      onCancel={onClose}
      width={540}
      title="同步完成"
      footer={[
        <Button key="ok" type="primary" onClick={onClose}>
          知道了
        </Button>
      ]}
    >
      <div className="sync-src">
        <div className="sync-file mono" title={result.file}>
          {file}
        </div>
        <div className="sync-doc muted">
          {doc.title || '未命名项目'}
          {doc.version ? ` · v${doc.version}` : ''}
          {doc.baseUrl ? ` · ${doc.baseUrl}` : ''}
        </div>
      </div>

      <div className="sync-grid">
        {cells.map((c) => (
          <div className={'sync-cell' + (c.tone ? ' is-' + c.tone : '')} key={c.label}>
            <div className="sync-num">{c.value}</div>
            <div className="sync-label">{c.label}</div>
          </div>
        ))}
      </div>

      {changed ? (
        <div className="sync-change">
          <div className="sync-change-head">
            <WarningOutlined className="sync-change-icon" />
            <span>
              <b>{changed}</b> 个接口的内容变了，影响 <b>{affected}</b> 条已关联用例
            </span>
          </div>
          <div className="sync-change-tags">
            {(s.changedList || []).slice(0, 3).map((c: any) => (
              <span className="sync-change-item" key={c.apiId}>
                <span className="sync-change-name">{c.name || c.url}</span>
                {(c.changes || []).slice(0, 3).map((x: any) => (
                  <Tag key={x.kind} bordered={false} className="change-tag">
                    {x.label}
                  </Tag>
                ))}
              </span>
            ))}
            {changed > 3 ? <span className="muted">…等 {changed} 个</span> : null}
          </div>
          {onShowImpact ? (
            <Button size="small" onClick={onShowImpact}>
              看待回归的用例
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="sync-note muted">接口内容没有实质变化（描述文案不算）</div>
      )}

      {result.dup || s.dupInBatch ? (
        <div className="sync-note muted">文件里有 {(result.dup || 0) + (s.dupInBatch || 0)} 条重复（同方法同地址），只留了一条</div>
      ) : null}
      {s.invalid ? <div className="sync-note muted">{s.invalid} 条缺 method/url，已跳过</div> : null}
      <div className="sync-note muted">
        只覆盖 Apifox 来的字段；你的「我的备注」、标签、收藏、Headers / Body 都没动。同一个文件再同步一次不会造重复记录。
      </div>
    </Modal>
  );
}