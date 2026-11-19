import React, { useEffect, useMemo, useState } from 'react';
import { Table, Input, Button, Tag, Drawer, Segmented, Empty, Tooltip, Dropdown, Modal, Radio, Alert } from 'antd';
import {
  ReloadOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  FolderOutlined,
  CopyOutlined,
  UnorderedListOutlined,
  ImportOutlined,
  WarningOutlined,
  ReadOutlined
} from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import api from '../api';
import { toast } from '../msg';

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtChars = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`);

export default function NotesPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  const [sortKey, setSortKey] = useState('updated_desc');
  const [detail, setDetail] = useState<any>(null);
  const [activeSection, setActiveSection] = useState('');

  // 导入 md
  const [importOpen, setImportOpen] = useState(false);
  const [importItems, setImportItems] = useState<any[]>([]);
  const [importRoot, setImportRoot] = useState('');
  const [conflictMode, setConflictMode] = useState('rename');
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.notesScan();
      setData(res);
      if (res && res.error) toast(res.error, 'warning');
    } catch (e: any) {
      toast('扫描失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const notes = (data && data.notes) || [];

  const dirs = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notes) {
      const key = n.dir || '（根目录）';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [notes]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let rows = notes;
    if (dirFilter) rows = rows.filter((n) => (n.dir || '（根目录）') === dirFilter);
    if (kw) {
      rows = rows.filter((n) => {
        const hay = [n.title, n.name, n.body, n.meta.updatedAt, (n.meta.tags || []).join(' ')]
          .join(' ')
          .toLowerCase();
        return hay.includes(kw);
      });
    }
    const sorted = rows.slice();
    if (sortKey === 'updated_asc') sorted.sort((a, b) => a.mtime - b.mtime);
    else if (sortKey === 'title_asc') sorted.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
    else if (sortKey === 'size_desc') sorted.sort((a, b) => b.chars - a.chars);
    else sorted.sort((a, b) => b.mtime - a.mtime);
    return sorted;
  }, [notes, keyword, dirFilter, sortKey]);

  const openDoc = (n: any) => {
    setDetail(n);
    setActiveSection(n.sections && n.sections.length ? 's0' : '');
  };

  const copyDoc = async (n: any) => {
    await api.copy(n.body);
    toast('已复制正文');
  };

  /** 选文件 → 弹确认框 */
  const pickImport = async () => {
    try {
      const res = await api.notesPickImport();
      if (res && res.ok) {
        setImportItems(res.items || []);
        setImportRoot(res.root || '');
        setConflictMode('rename');
        setImportOpen(true);
      } else if (res && res.message) {
        toast(res.message, 'warning');
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doImport = async () => {
    setImporting(true);
    try {
      const files = importItems.map((i) => i.from);
      const res = await api.notesImport(files, conflictMode);
      if (res && res.ok) {
        const parts = [];
        if (res.moved.length) parts.push(`移入 ${res.moved.length} 个`);
        if (res.renamed.length) parts.push(`重命名 ${res.renamed.length} 个`);
        if (res.skipped.length) parts.push(`跳过 ${res.skipped.length} 个`);
        if (res.errors.length) parts.push(`失败 ${res.errors.length} 个`);
        toast(parts.join('，') || '没有文件被导入');
        setImportOpen(false);
        await load();
      } else {
        toast((res && res.message) || '导入失败', 'error');
      }
    } catch (e: any) {
      toast('导入失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setImporting(false);
    }
  };

  const columns: any[] = [
    {
      title: '笔记',
      dataIndex: 'title',
      width: '46%',
      render: (_: any, n: any) => (
        <div className="kb-title-cell">
          <div className="kb-title-line">
            <FileTextOutlined style={{ color: '#6c5ce7', fontSize: 13 }} />
            <span className="kb-title">{n.title}</span>
          </div>
          <div className="kb-title-meta">
            {n.meta.updatedAt ? <Tag className="kb-tag">更新 {n.meta.updatedAt}</Tag> : null}
            {(n.meta.tags || []).map((t: string) => (
              <Tag key={t} className="kb-tag">
                {t}
              </Tag>
            ))}
          </div>
        </div>
      )
    },
    {
      title: '章节',
      dataIndex: 'sections',
      width: '22%',
      render: (_: any, n: any) => {
        if (!n.sections.length) return <span className="muted">—</span>;
        return (
          <div className="kb-sections-cell">
            <span className="kb-section-count">{n.sections.length} 个章节</span>
            <span className="kb-section-first muted" title={n.sections[0].title}>
              {n.sections[0].title}
            </span>
          </div>
        );
      }
    },
    {
      title: '篇幅',
      dataIndex: 'chars',
      width: '14%',
      render: (v: number) => <span className="muted">{fmtChars(v)}</span>
    },
    {
      title: '修改时间',
      dataIndex: 'mtime',
      width: '14%',
      render: (v: number) => <span className="muted">{fmtTime(v)}</span>
    },
    {
      title: '',
      key: 'op',
      width: '4%',
      render: (_: any, n: any) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="打开源文件">
            <Button type="text" size="small" icon={<FileTextOutlined />} onClick={() => api.notesOpenFile(n.fullPath)} />
          </Tooltip>
        </div>
      )
    }
  ];

  const renderSection = (s: any) => {
    const html = DOMPurify.sanitize(marked.parse(s.text || '') as string);
    return <div className="kb-md" dangerouslySetInnerHTML={{ __html: html }} />;
  };

  const conflictCount = importItems.filter((i) => i.conflict).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">测试笔记</div>
          <div className="page-desc">
            只读索引 markdown 笔记（{data && data.root ? data.root : '未配置目录'}），用 Typora 等专业编辑器改，平台只读
          </div>
        </div>
        <div className="page-head-right">
          <Button icon={<ImportOutlined />} onClick={pickImport}>
            导入 md
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => api.notesReveal(data && data.root)}>
            打开目录
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            重新扫描
          </Button>
        </div>
      </div>

      <div className="page-with-aside">
        <aside className="tag-panel">
          <div className="tag-panel-head">
            <span>
              <FolderOutlined /> 目录
            </span>
            <span className="tag-panel-count">{dirs.length}</span>
          </div>
          <div className={'tag-item' + (dirFilter === '' ? ' active' : '')} onClick={() => setDirFilter('')}>
            <span className="tag-dot" />
            <span className="tag-name">全部</span>
            <span className="tag-count">{notes.length}</span>
          </div>
          <div className="tag-divider" />
          {dirs.map(([name, count]) => (
            <div
              key={name}
              className={'tag-item' + (dirFilter === name ? ' active' : '')}
              title={name}
              onClick={() => setDirFilter(dirFilter === name ? '' : name)}
            >
              <span className="tag-dot" />
              <span className="tag-name">{name}</span>
              <span className="tag-count">{count}</span>
            </div>
          ))}
          {!dirs.length && !loading ? <div className="tag-empty">没有找到笔记</div> : null}
        </aside>

        <div className="page-main">
          <div className="panel">
            <div className="panel-head">
              <Input
                allowClear
                style={{ width: 300 }}
                prefix={<SearchOutlined style={{ color: '#9aa1b4' }} />}
                placeholder="搜标题、正文、标签"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <span className="spacer" />
              <span className="muted" style={{ fontSize: 12 }}>
                {filtered.length} / {notes.length} 篇
              </span>
              <Segmented
                size="small"
                value={sortKey}
                onChange={(v) => setSortKey(String(v))}
                options={[
                  { label: '最近修改', value: 'updated_desc' },
                  { label: '最早修改', value: 'updated_asc' },
                  { label: '名称', value: 'title_asc' },
                  { label: '篇幅', value: 'size_desc' }
                ]}
              />
            </div>
            <Table
              dataSource={filtered}
              columns={columns}
              rowKey="relPath"
              size="middle"
              tableLayout="fixed"
              loading={loading}
              pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false, size: 'small' }}
              locale={{
                emptyText: (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <FileTextOutlined />
                    </div>
                    <div className="empty-title">
                      {data && data.error ? data.error : keyword || dirFilter ? '没有匹配的笔记' : '目录里还没有 markdown'}
                    </div>
                    <div className="empty-desc">
                      {data && data.error
                        ? '到「设置 → 笔记」里改成你的目录，再点重新扫描'
                        : keyword || dirFilter
                        ? '换个关键词，或点左侧「全部」清空筛选'
                        : '点右上角「导入 md」把外部笔记收进来，或直接把 md 放进这个目录'}
                    </div>
                  </div>
                )
              }}
              onRow={(n: any) => ({ onClick: () => openDoc(n), style: { cursor: 'pointer' } })}
            />
          </div>
        </div>
      </div>

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={860}
        title={
          detail ? (
            <div className="kb-drawer-title">
              <span>{detail.title}</span>
              {detail.meta.updatedAt ? <Tag>更新 {detail.meta.updatedAt}</Tag> : null}
            </div>
          ) : (
            ''
          )
        }
        extra={
          detail ? (
            <div className="drawer-extra">
              {detail.sections.length ? (
                <Dropdown
                  trigger={['hover']}
                  placement="bottomRight"
                  dropdownRender={() => (
                    <div className="kb-toc-dropdown">
                      <div className="kb-toc-dropdown-head">目录 · {detail.sections.length} 章</div>
                      <div className="kb-toc-dropdown-body">
                        {detail.sections.map((s: any, i: number) => (
                          <div key={i} className="kb-toc-group">
                            <div
                              className={'kb-toc-item' + (activeSection === `s${i}` ? ' active' : '')}
                              onClick={() => setActiveSection(`s${i}`)}
                            >
                              {s.title}
                            </div>
                            {s.children.length ? (
                              <div className="kb-toc-children">
                                {s.children.map((c: any, j: number) => (
                                  <div
                                    key={j}
                                    className={'kb-toc-sub' + (activeSection === `s${i}-${j}` ? ' active' : '')}
                                    onClick={() => setActiveSection(`s${i}-${j}`)}
                                  >
                                    {c.title}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                >
                  <Button size="small" icon={<UnorderedListOutlined />}>
                    目录
                  </Button>
                </Dropdown>
              ) : null}
              <Button size="small" icon={<CopyOutlined />} onClick={() => copyDoc(detail)}>
                复制正文
              </Button>
              <Button size="small" icon={<FileTextOutlined />} onClick={() => api.notesOpenFile(detail.fullPath)}>
                打开源文件
              </Button>
            </div>
          ) : null
        }
      >
        {detail ? (
          <div className="kb-detail">
            <div className="kb-detail-meta">
              <div>
                <span className="muted">文件</span>
                <a onClick={() => api.notesOpenFile(detail.fullPath)}>{detail.relPath}</a>
              </div>
              <div>
                <span className="muted">篇幅</span>
                <span>
                  {fmtChars(detail.chars)} · {detail.lines} 行 · {detail.sections.length} 个章节
                </span>
              </div>
            </div>

            {detail.sections.length ? (
              <div className="kb-readall">
                <Button
                  size="small"
                  type={activeSection === '' ? 'primary' : 'default'}
                  icon={<ReadOutlined />}
                  onClick={() => setActiveSection('')}
                >
                  阅读全文
                </Button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {activeSection === ''
                    ? `正在显示全部 ${detail.sections.length} 章`
                    : '当前只显示一章，点这里展开全文'}
                </span>
              </div>
            ) : null}

            <div className="kb-content">
              {detail.sections.length ? (
                detail.sections.map((s: any, i: number) => {
                  const show = activeSection === '' || activeSection === `s${i}` || activeSection.startsWith(`s${i}-`);
                  if (!show) return null;
                  return (
                    <section className="kb-section" key={i}>
                      <h3>{s.title}</h3>
                      {s.text ? renderSection(s) : null}
                      {s.children.map((c: any, j: number) => {
                        const showSub =
                          activeSection === '' || activeSection === `s${i}` || activeSection === `s${i}-${j}`;
                        if (!showSub) return null;
                        return (
                          <div className="kb-subsection" key={j}>
                            <h4>{c.title}</h4>
                            {c.text ? renderSection(c) : null}
                          </div>
                        );
                      })}
                    </section>
                  );
                })
              ) : (
                <div className="kb-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(detail.body) as string) }} />
              )}
            </div>
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={importOpen}
        title="导入 markdown 到笔记目录"
        onCancel={() => setImportOpen(false)}
        onOk={doImport}
        okText={`移动 ${importItems.length} 个文件`}
        cancelText="取消"
        confirmLoading={importing}
        width={620}
        maskClosable={false}
      >
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 12 }}
          message="这些文件会被移动到笔记目录，原位置不再保留"
          description={
            <div style={{ fontSize: 12.5 }}>
              目标目录：<span className="mono">{importRoot || '未配置'}</span>
            </div>
          }
        />

        <div className="import-list">
          {importItems.map((it, i) => (
            <div className="import-row" key={i}>
              <span className="import-name mono">{it.name}</span>
              {it.samePlace ? (
                <Tag color="default">已在目录里</Tag>
              ) : it.conflict ? (
                <Tag color="gold">同名冲突</Tag>
              ) : (
                <Tag color="green">新增</Tag>
              )}
            </div>
          ))}
        </div>

        {conflictCount ? (
          <div style={{ marginTop: 14 }}>
            <div className="kv-label">有 {conflictCount} 个同名文件，怎么处理？</div>
            <Radio.Group value={conflictMode} onChange={(e) => setConflictMode(e.target.value)}>
              <Radio value="rename">重命名（加 -1 后缀）</Radio>
              <Radio value="skip">跳过</Radio>
              <Radio value="overwrite">覆盖</Radio>
            </Radio.Group>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
