import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Input, Table, Tag, Button, Empty, Spin, Tooltip } from 'antd';
import { SearchOutlined, ReloadOutlined, FileTextOutlined, PlusOutlined } from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { caseKey, flattenCases, knownCaseKeys, loadCaseIndex } from '../caseIndex';
import { suggestCases } from '../../shared/suggest';
import { methodOf, riskTone } from '../utils';

type Props = {
  open: boolean;
  record: any;
  onClose: () => void;
  onSaved?: (count: number) => void;
};

/**
 * 「关联用例」弹窗：搜标题 → 多选 → 保存。
 * 顶部给几个灰字候选（按接口名称/模块/描述/URL 猜的），点了才勾上；
 * 猜不出来就什么都不显示，不塞噪音、不算待办。
 */
export default function CaseLinkModal({ open, record, onClose, onSaved }: Props) {
  const [index, setIndex] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [staleCount, setStaleCount] = useState(0);
  const [saving, setSaving] = useState(false);
  // 分页受控：换搜索词或重开弹窗都回第 1 页
  const [page, setPage] = useState(1);

  const recordId = record ? record.id : '';

  useEffect(() => {
    if (!open || !recordId) return;
    let alive = true;
    setLoading(true);
    setKeyword('');
    Promise.all([loadCaseIndex().catch(() => null), api.linksForApi(recordId).catch(() => [])])
      .then(([idx, rows]: [any, any[]]) => {
        if (!alive) return;
        setIndex(idx);
        const known = knownCaseKeys(idx);
        const all = (rows || []).map((r: any) => caseKey(r.file_path, r.case_title));
        if (known) {
          // 只认还在目录里的；找不到的（用例改名/删除）保存时会一并清掉
          setSelected(Array.from(new Set(all.filter((k: string) => known.has(k)))));
          setStaleCount(all.filter((k: string) => !known.has(k)).length);
        } else {
          setSelected(Array.from(new Set(all)));
          setStaleCount(0);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, recordId]);

  const rows = useMemo(() => flattenCases(index), [index]);

  // 换搜索词 / 重新打开弹窗 → 回第 1 页
  useEffect(() => {
    setPage(1);
  }, [open, recordId, keyword]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter((r: any) => {
      const c = r.item;
      const hay = [c.title, c.module, c.branch, c.id, r.relPath, c.covers.join(' ')].join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }, [rows, keyword]);

  // 灰字候选：按接口名称/模块/描述/URL 猜几条相关用例（已勾上的不再出现）
  const suggestions = useMemo(() => {
    if (!open || !record || !rows.length) return [];
    const flat = rows.map((r: any) => ({
      key: r.key,
      filePath: r.relPath,
      title: r.item.title,
      module: r.item.module,
      branch: r.item.branch
    }));
    return suggestCases(record.data, flat, { exclude: selected, limit: 5 });
  }, [open, record, rows, selected]);

  const save = async () => {
    if (!recordId) return;
    setSaving(true);
    try {
      const byKey = new Map(rows.map((r: any) => [r.key, r]));
      const targets = selected
        .map((k) => {
          const r: any = byKey.get(k);
          if (!r) return null;
          return { filePath: r.relPath, caseTitle: r.item.title, caseIndex: r.item.index };
        })
        .filter(Boolean);
      const res = await api.linkSave(recordId, targets);
      toast(res && res.count ? `已关联 ${res.count} 条用例` : '已取消全部关联');
      if (onSaved) onSaved(res ? res.count : 0);
      onClose();
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const method = methodOf((record && record.data ? record.data.method : '') || '');
  const scanFailed = !!(index && index.error);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={860}
      title={record ? `关联用例 · ${record.title}` : '关联用例'}
      okText={saving ? '保存中…' : '保存'}
      cancelText="取消"
      confirmLoading={saving}
      onOk={save}
      okButtonProps={{ disabled: loading || scanFailed }}
    >
      <div className="link-modal-head">
        {method ? (
          <Tag color={method.color} className="api-method-tag">
            {method.label}
          </Tag>
        ) : null}
        <span className="mono muted ellipsis">{record && record.data ? String(record.data.url || '') : ''}</span>
      </div>

      <div className="link-modal-bar">
        <Input
          allowClear
          size="small"
          style={{ width: 280 }}
          prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
          placeholder="搜用例标题、模块、文件名"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => {
            setLoading(true);
            loadCaseIndex(true)
              .then((idx: any) => setIndex(idx))
              .catch(() => toast('扫描失败', 'error'))
              .finally(() => setLoading(false));
          }}
        >
          重新扫描
        </Button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          已选 {selected.length} 条 · 共 {rows.length} 条
        </span>
      </div>

      {!loading && suggestions.length ? (
        <div className="link-suggest">
          <span className="link-suggest-label">可能是</span>
          {suggestions.map((s: any) => (
            <Tooltip key={s.key} title={`命中：${s.hits.join('、')}｜${s.filePath}`}>
              <span
                className="link-suggest-item"
                onClick={() => setSelected((prev) => (prev.indexOf(s.key) >= 0 ? prev : prev.concat([s.key])))}
              >
                {s.title}
                <PlusOutlined className="link-suggest-plus" />
              </span>
            </Tooltip>
          ))}
          <span className="link-suggest-note">按接口名称 / 模块 / 路径猜的，点了才勾上</span>
        </div>
      ) : null}

      {loading ? (
        <div className="link-modal-loading">
          <Spin />
        </div>
      ) : scanFailed ? (
        <Empty description={index.error || '没读到用例目录，先到「设置」里配一下'} />
      ) : !rows.length ? (
        <Empty description="用例目录里还没有用例" />
      ) : (
        <Table
          dataSource={filtered}
          rowKey="key"
          size="small"
          tableLayout="fixed"
          pagination={{
            pageSize: 8,
            current: Math.min(page, Math.max(1, Math.ceil(filtered.length / 8))),
            onChange: setPage,
            hideOnSinglePage: true,
            size: 'small',
            showSizeChanger: false
          }}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
            preserveSelectedRowKeys: true
          }}
          onRow={(r: any) => ({
            onClick: (e: any) => {
              // 点复选框/全选时别再走一遍行点击，否则会来回抵消
              const t = e && e.target;
              if (t && t.closest && (t.closest('.ant-table-selection-column') || t.closest('label') || t.closest('input'))) return;
              setSelected((prev) => (prev.indexOf(r.key) >= 0 ? prev.filter((k) => k !== r.key) : prev.concat([r.key])));
            },
            style: { cursor: 'pointer' }
          })}
          columns={[
            {
              title: '用例',
              dataIndex: ['item', 'title'],
              ellipsis: true,
              render: (_: any, r: any) => (
                <div className="link-modal-case">
                  <span className="link-modal-case-title" title={r.item.title}>
                    {r.item.title}
                  </span>
                  {r.item.risk ? (
                    <Tag color={riskTone(r.item.risk)} style={{ marginInlineEnd: 0 }}>
                      {r.item.risk}
                    </Tag>
                  ) : null}
                  {r.item.type ? <Tag style={{ marginInlineEnd: 0 }}>{r.item.type}</Tag> : null}
                  {r.dup > 1 ? (
                    <Tag style={{ marginInlineEnd: 0 }} color="default">
                      同标题 {r.dup} 条
                    </Tag>
                  ) : null}
                </div>
              )
            },
            {
              title: '模块 / 分支',
              width: 210,
              ellipsis: true,
              render: (_: any, r: any) => (
                <span className="muted" style={{ fontSize: 12 }}>
                  {r.item.kind === 'chain' ? `回归链路 ${r.item.id}` : `${r.item.module || '—'}${r.item.branch ? ' / ' + r.item.branch : ''}`}
                </span>
              )
            },
            {
              title: '文件',
              width: 190,
              ellipsis: true,
              render: (_: any, r: any) => (
                <span className="muted" style={{ fontSize: 12 }} title={r.relPath}>
                  <FileTextOutlined /> {r.fileName}
                </span>
              )
            }
          ]}
        />
      )}

      {staleCount ? (
        <div className="link-modal-note">
          有 {staleCount} 条已关联的用例在目录里找不到了（改名或删除），保存后会一并移除。
        </div>
      ) : null}
      <div className="link-modal-note">没关联是正常状态 —— 只勾那些你会反复测、又容易变的接口。</div>
    </Modal>
  );
}