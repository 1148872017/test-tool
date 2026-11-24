import React, { useEffect, useMemo, useState } from 'react';
import { Table, Button, Tag, Popconfirm, Input, Tooltip } from 'antd';
import {
  DeleteOutlined,
  ReloadOutlined,
  UndoOutlined,
  ClearOutlined,
  SearchOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { fmtTime, trashDaysLeft, TRASH_RETENTION_DAYS } from '../utils';
import { COLLECTION_MAP } from '../../shared/collections';
import StateEmpty from '../components/states/StateEmpty';

type Props = {
  /** 恢复 / 清理之后通知外层刷新侧栏角标 */
  onChanged?: () => void;
};

/**
 * 回收站。
 *
 * 数据层是软删除：删除只写 records.deleted_at，所以这里能原样列出来。
 * 三件事必须说清楚，否则用户不敢点：
 *   · 还能恢复
 *   · 过多少天自动清除（N 天后自动清除）
 *   · 「彻底删除」是真没了（二次确认里写明不可撤销）
 *
 * 入口在侧栏，路由 route.type === 'trash'。
 */
export default function TrashPage({ onChanged }: Props) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** 主进程还没接上回收站通道时给个明确提示，而不是一屏空白 */
  const [missing, setMissing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const fn = (api as any).trashList;
      if (typeof fn !== 'function') {
        setRows([]);
        setMissing(true);
        return;
      }
      const list = await fn();
      setRows(Array.isArray(list) ? list : []);
      setMissing(false);
    } catch (e: any) {
      toast('读取回收站失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter((r) => {
      const name = COLLECTION_MAP[r.collection] ? COLLECTION_MAP[r.collection].name : r.collection;
      const hay = [r.title || '', name || '', (r.tags || []).join(',')].join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }, [rows, keyword]);

  const notify = () => {
    if (onChanged) onChanged();
  };

  const restoreOne = async (r: any) => {
    try {
      const ok = await (api as any).trashRestore(r.id);
      if (ok) {
        toast(`已恢复「${r.title}」`);
        setSelected((prev) => prev.filter((id) => id !== r.id));
        await load();
        notify();
      } else {
        toast('恢复失败：这条可能已经不在了，刷新看看', 'error');
      }
    } catch (e: any) {
      toast('恢复失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const purgeOne = async (r: any) => {
    try {
      const ok = await (api as any).trashPurge(r.id);
      if (ok) {
        toast(`已彻底删除「${r.title}」`);
        setSelected((prev) => prev.filter((id) => id !== r.id));
        await load();
        notify();
      } else {
        toast('彻底删除失败：这条可能已经不在了，刷新看看', 'error');
      }
    } catch (e: any) {
      toast('彻底删除失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /** 批量恢复：一条一条来，失败的单独计数，别因为一条坏数据整批不动 */
  const restoreSelected = async () => {
    if (!selected.length) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const id of selected.slice()) {
        try {
          if (await (api as any).trashRestore(id)) ok++;
        } catch (e) {
          /* 单条失败不影响其他 */
        }
      }
      if (ok) {
        toast(`已恢复 ${ok} 条`);
        setSelected([]);
        await load();
        notify();
      } else {
        toast('没有恢复成功的记录，刷新看看', 'warning');
      }
    } finally {
      setBusy(false);
    }
  };

  /** 批量彻底删除 */
  const purgeSelected = async () => {
    if (!selected.length) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const id of selected.slice()) {
        try {
          if (await (api as any).trashPurge(id)) ok++;
        } catch (e) {
          /* 单条失败不影响其他 */
        }
      }
      if (ok) {
        toast(`已彻底删除 ${ok} 条`);
        setSelected([]);
        await load();
        notify();
      } else {
        toast('没有删除成功的记录，刷新看看', 'warning');
      }
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      const res = await (api as any).trashClear();
      const n = res && res.removed !== undefined ? res.removed : 0;
      toast(n ? `回收站已清空（${n} 条）` : '回收站已经是空的');
      setSelected([]);
      await load();
      notify();
    } catch (e: any) {
      toast('清空回收站失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const collectionName = (key: string) => (COLLECTION_MAP[key] ? COLLECTION_MAP[key].name : key || '未知集合');

  const columns: any[] = [
    {
      title: '名称',
      dataIndex: 'title',
      key: 'title',
      width: '38%',
      ellipsis: true,
      render: (text: string, r: any) => (
        <div className="title-cell">
          <span className="t" title={text}>
            {text || '(未命名)'}
          </span>
          {(r.tags || []).map((t: string) => (
            <Tag key={t} style={{ fontSize: 11, marginInlineEnd: 0 }}>
              {t}
            </Tag>
          ))}
        </div>
      )
    },
    {
      title: '集合',
      dataIndex: 'collection',
      key: 'collection',
      width: '13%',
      render: (key: string) => <Tag>{collectionName(key)}</Tag>
    },
    {
      title: '删除时间',
      dataIndex: 'deleted_at',
      key: 'deleted_at',
      width: '20%',
      render: (v: number) => <span className="muted">{fmtTime(Number(v), true)}</span>
    },
    {
      title: '自动清除',
      key: 'expire',
      width: '16%',
      render: (_: any, r: any) => {
        const left = trashDaysLeft(Number(r.deleted_at) || 0);
        // 只剩 3 天以内给个红字提醒，别等清完了才发现
        return left <= 3 ? (
          <Tooltip title={`超过 ${TRASH_RETENTION_DAYS} 天会自动彻底删除，到时无法恢复`}>
            <Tag color="red">{left} 天后自动清除</Tag>
          </Tooltip>
        ) : (
          <span className="muted">{left} 天后自动清除</span>
        );
      }
    },
    {
      title: '',
      key: 'op',
      width: '13%',
      render: (_: any, r: any) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <Button type="text" size="small" icon={<UndoOutlined />} title="恢复" onClick={() => restoreOne(r)} />
          <Popconfirm
            title="彻底删除？"
            description="不可撤销，也无法从回收站恢复"
            okText="彻底删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => purgeOne(r)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} title="彻底删除" />
          </Popconfirm>
        </div>
      )
    }
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">
            回收站
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 400, marginLeft: 2 }}>{rows.length} 条</span>
          </div>
          <div className="page-desc">
            删除的记录在这里保留 {TRASH_RETENTION_DAYS} 天，到期自动清除；期间随时可以恢复
          </div>
        </div>
        <div className="page-head-right">
          <Popconfirm
            title="恢复所选？"
            description={`选中的 ${selected.length} 条会回到原来的集合`}
            okText="恢复"
            cancelText="取消"
            disabled={!selected.length}
            onConfirm={restoreSelected}
          >
            <Button icon={<UndoOutlined />} disabled={!selected.length} loading={busy}>
              恢复所选{selected.length ? ` (${selected.length})` : ''}
            </Button>
          </Popconfirm>
          <Popconfirm
            title="彻底删除所选？"
            description="不可撤销，也无法从回收站恢复"
            okText="彻底删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={!selected.length}
            onConfirm={purgeSelected}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selected.length} loading={busy}>
              彻底删除所选
            </Button>
          </Popconfirm>
          <Popconfirm
            title="清空回收站？"
            description="里面的记录会被永久删除，不可撤销，也无法从回收站恢复"
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={!rows.length}
            onConfirm={clearAll}
          >
            <Button danger icon={<ClearOutlined />} disabled={!rows.length} loading={busy}>
              清空回收站
            </Button>
          </Popconfirm>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <Input
            allowClear
            style={{ width: 280 }}
            prefix={<SearchOutlined style={{ color: 'var(--text-3)' }} />}
            placeholder="搜名称、集合、标签"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>
            {filtered.length} / {rows.length} 条
          </span>
        </div>
        <Table
          dataSource={filtered}
          columns={columns}
          rowKey="id"
          size="middle"
          tableLayout="fixed"
          loading={loading}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys: any[]) => setSelected(keys.map((k) => String(k)))
          }}
          pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
          locale={{
            emptyText: (
              <StateEmpty
                kind={missing ? 'failed' : keyword ? 'no-match' : 'no-data'}
                object="已删除的记录"
                keyword={keyword}
                title={missing ? '回收站还没接上' : keyword ? undefined : '回收站为空'}
                desc={
                  missing
                    ? '主进程还没注册回收站通道（records:trash-list），先更新一下程序，再点「重新加载」'
                    : keyword
                      ? '换个关键词试试，或清掉搜索看全部'
                      : '删除的记录会出现在这里，30 天内都能恢复：先去记录列表删一条试试'
                }
                detail={missing ? '缺少 IPC 通道：records:trash-list（更新到最新版本即可）' : undefined}
                action={
                  missing
                    ? { label: '重新加载', onClick: load }
                    : keyword
                      ? { label: '清空筛选', onClick: () => setKeyword('') }
                      : { label: '刷新列表', onClick: load }
                }
              />
            )
          }}
        />
      </div>
    </div>
  );
}