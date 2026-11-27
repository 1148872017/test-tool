import React, { useState } from 'react';
import { Modal, Button, Tag, Collapse } from 'antd';
import { WarningOutlined } from '@ant-design/icons';

type Props = { result: any; onClose: () => void; onShowImpact?: () => void };

/**
 * 同步结果摘要卡片。
 * 只报数，不报错：缺描述是常态（Apifox 里本来就没写），用灰字说明就行，不上红色。
 */
export default function SyncResultModal({ result, onClose, onShowImpact }: Props) {
  /**
   * 明细默认收起。
   * 为什么收起：卡片第一眼该给结论（4 个数字 + 影响面），
   * 「为什么跳过」是追问时才看的细节，默认铺开会把影响面挤下去。
   */
  const [skipOpen, setSkipOpen] = useState(false);
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

  /**
   * 没写进库的条目明细（接口名 + method/url + 原因）。
   *
   * 为什么加：原来只有「跳过 2」这样的数字，用户不知道跳过了哪两条、为什么跳过，
   * 只能回库里去猜 —— 和 v0.69 修的「忽略 N 行」是同一类信息不透明。
   * skippedList 是后端截断过的（最多 8 条），skippedListTotal 才是总数，
   * 两者不一致时用「还有 N 条」补齐，避免以为就这几条。
   */
  const skipList: any[] = Array.isArray(s.skippedList) ? s.skippedList : [];
  const skipTotal = Number(s.skippedListTotal || skipList.length || 0);
  const skipMore = Math.max(0, skipTotal - skipList.length);

  const skipRows = skipList.map((it: any, i: number) => {
    const name = String((it && it.name) || '').trim();
    const method = String((it && it.method) || '').trim();
    const url = String((it && it.url) || '').trim();
    return (
      <div
        key={i}
        style={{ padding: '5px 0', borderTop: i ? '1px dashed var(--line-soft, #eef0f6)' : undefined }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span
            title={name}
            style={{
              fontSize: 12.5,
              color: 'var(--text-2)',
              maxWidth: 170,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: '0 1 auto'
            }}
          >
            {name || '（无名称）'}
          </span>
          <span
            className="mono"
            title={(method + ' ' + url).trim()}
            style={{
              fontSize: 11.5,
              color: 'var(--text-3)',
              flex: '1 1 0',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {method || '—'} {url || '（无 url）'}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 1 }}>
          {String((it && it.reason) || '')}
        </div>
      </div>
    );
  });

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

      {/* 明细：谁能告诉我「跳过 2」跳的是哪两条 —— 就在这里。仍是灰字，不是报错。 */}
      {skipTotal ? (
        <Collapse
          ghost
          size="small"
          activeKey={skipOpen ? ['skip'] : []}
          onChange={(keys) => setSkipOpen((Array.isArray(keys) ? keys : [keys]).indexOf('skip') >= 0)}
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'skip',
              label: (
                <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                  没写进库的 {skipTotal} 条
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}> · 点开看是哪几条、为什么</span>
                </span>
              ),
              children: (
                // 8 条明细最多占 200px，超了自己滚 —— 别把「知道了」按钮顶出屏幕
                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {skipRows}
                  {skipMore ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 5, lineHeight: 1.6 }}>
                      还有 {skipMore} 条没列出来（一次只展示前 {skipList.length} 条，免得把卡片撑爆）。
                    </div>
                  ) : null}
                </div>
              )
            }
          ]}
        />
      ) : null}

      <div className="sync-note muted">
        只覆盖 Apifox 来的字段；你的「我的备注」、标签、收藏、Headers / Body 都没动。同一个文件再同步一次不会造重复记录。
      </div>
    </Modal>
  );
}
