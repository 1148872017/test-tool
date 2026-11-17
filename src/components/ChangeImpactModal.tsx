import React from 'react';
import { Modal, Button, Tag } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';

type Props = {
  data: any;
  open: boolean;
  onClose: () => void;
  onOpenCase?: (filePath: string, caseTitle: string) => void;
};

const fmtTime = (ms: number) => {
  const d = new Date(Number(ms) || 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 变更影响面：接口结构变了 → 哪些已关联的用例可能需要重跑。
 * 只给线索，不当工单：没有关联用例的接口就写「还没挂用例」，不催。
 */
export default function ChangeImpactModal({ data, open, onClose, onOpenCase }: Props) {
  const changed: any[] = (data && data.changed) || [];
  const affected = data && typeof data.affectedCases === 'number' ? data.affectedCases : 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={640}
      title="接口变了，这些用例可能要重跑"
      footer={[
        <Button key="ok" type="primary" onClick={onClose}>
          知道了
        </Button>
      ]}
    >
      {!changed.length ? (
        <div className="muted">上次同步没有内容变更。</div>
      ) : (
        <>
          <div className="impact-lead">
            {data && data.at ? <span className="muted">{fmtTime(data.at)} 同步后，</span> : null}
            <b>{changed.length}</b> 个接口的内容变了
            {affected ? (
              <>
                ，其中 <b>{affected}</b> 条已关联用例可能需要重跑
              </>
            ) : (
              <>，但这些接口都还没挂用例</>
            )}
          </div>

          <div className="impact-list">
            {changed.map((c: any) => (
              <div className="impact-api" key={c.apiId}>
                <div className="impact-head">
                  <span className="impact-name">{c.name || c.url || '（未命名）'}</span>
                  {c.method ? <Tag bordered={false}>{c.method}</Tag> : null}
                  <span className="impact-url mono" title={c.url}>
                    {c.url}
                  </span>
                </div>
                <div className="change-tags">
                  {(c.changes || []).map((x: any) => (
                    <Tag key={x.kind + (x.detail || '')} bordered={false} className="change-tag" title={x.detail || ''}>
                      {x.label}
                    </Tag>
                  ))}
                </div>
                {c.cases && c.cases.length ? (
                  <div className="impact-cases">
                    {c.cases.map((k: any) => (
                      <div
                        className="impact-case"
                        key={k.filePath + '\u0001' + k.caseTitle}
                        onClick={() => {
                          if (onOpenCase) onOpenCase(k.filePath, k.caseTitle);
                          onClose();
                        }}
                      >
                        <FileTextOutlined className="impact-case-icon" />
                        <span className="impact-case-title">{k.caseTitle}</span>
                        <span className="impact-case-file muted mono">{k.filePath}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="impact-empty muted">还没挂用例 —— 想管起来就去这条接口的详情里「关联用例」</div>
                )}
              </div>
            ))}
          </div>

          <div className="impact-note muted">
            只比结构：参数、请求体、响应体的增删和类型变化。描述文案改了不算变更（那是噪音）。
          </div>
        </>
      )}
    </Modal>
  );
}