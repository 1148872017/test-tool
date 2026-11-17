import React, { useEffect, useMemo, useState } from 'react';
import { Table, Input, Button, Tag, Drawer, Segmented, Empty, Tooltip, Dropdown } from 'antd';
import {
  ReloadOutlined,
  SearchOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  FolderOutlined,
  CopyOutlined,
  BookOutlined,
  UnorderedListOutlined
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

export default function KnowledgePage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  const [sortKey, setSortKey] = useState('updated_desc');
  const [detail, setDetail] = useState<any>(null);
  const [activeSection, setActiveSection] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.kbScan();
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

  const docs = (data && data.docs) || [];

  const dirs = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of docs) {
      const key = d.dir || '（根目录）';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [docs]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    let rows = docs;
    if (dirFilter) rows = rows.filter((d) => (d.dir || '（根目录）') === dirFilter);
    if (kw) {
      rows = rows.filter((d) => {
        const hay = [d.title, d.name, d.body, d.meta.updatedAt, (d.meta.tags || []).join(' ')]
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
  }, [docs, keyword, dirFilter, sortKey]);

  const openDoc = (d: any) => {
    setDetail(d);
    // 默认显示第一章，不展开全文
    setActiveSection(d.sections && d.sections.length ? 's0' : '');
  };

  const copyDoc = async (d: any) => {
    await api.copy(d.body);
    toast('已复制正文');
  };

  const columns: any[] = [
    {
      title: '文档',
      dataIndex: 'title',
      width: '46%',
      render: (_: any, d: any) => (
        <div className="kb-title-cell">
          <div className="kb-title-line">
            <BookOutlined style={{ color: '#6c5ce7', fontSize: 13 }} />
            <span className="kb-title">{d.title}</span>
          </div>
          <div className="kb-title-meta">
            {d.meta.updatedAt ? <Tag className="kb-tag">更新 {d.meta.updatedAt}</Tag> : null}
            {(d.meta.tags || []).map((t: string) => (
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
      render: (_: any, d: any) => {
        if (!d.sections.length) return <span className="muted">—</span>;
        return (
          <div className="kb-sections-cell">
            <span className="kb-section-count">{d.sections.length} 个章节</span>
            <span className="kb-section-first muted" title={d.sections[0].title}>
              {d.sections[0].title}
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
      render: (_: any, d: any) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="打开源文件">
            <Button type="text" size="small" icon={<FileTextOutlined />} onClick={() => api.kbOpenFile(d.fullPath)} />
          </Tooltip>
        </div>
      )
    }
  ];

  // 详情里渲染 markdown（按章节切）
  const renderSection = (s: any) => {
    const html = DOMPurify.sanitize(marked.parse(s.text || '') as string);
    return <div className="kb-md" dangerouslySetInnerHTML={{ __html: html }} />;
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">知识库</div>
          <div className="page-desc">
            只读索引业务规则文档（{data && data.root ? data.root : '未配置目录'}），不修改任何文件
          </div>
        </div>
        <div className="page-head-right">
          <Button icon={<FolderOpenOutlined />} onClick={() => api.kbReveal(data && data.root)}>
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
            <span className="tag-count">{docs.length}</span>
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
          {!dirs.length && !loading ? <div className="tag-empty">没有找到文档</div> : null}
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
                {filtered.length} / {docs.length} 篇
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
                      <BookOutlined />
                    </div>
                    <div className="empty-title">
                      {data && data.error ? data.error : keyword || dirFilter ? '没有匹配的文档' : '目录里还没有 markdown'}
                    </div>
                    <div className="empty-desc">
                      {data && data.error
                        ? '到「设置 → 知识库」里改成你的目录，再点重新扫描'
                        : keyword || dirFilter
                        ? '换个关键词，或点左侧「全部」清空筛选'
                        : '把业务规则文档放到这个目录下，点右上角「重新扫描」'}
                    </div>
                  </div>
                )
              }}
              onRow={(d: any) => ({ onClick: () => openDoc(d), style: { cursor: 'pointer' } })}
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
                      <div className="kb-toc-dropdown-head">
                        目录 · {detail.sections.length} 章
                      </div>
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
              <Button size="small" icon={<FileTextOutlined />} onClick={() => api.kbOpenFile(detail.fullPath)}>
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
                <a onClick={() => api.kbOpenFile(detail.fullPath)}>{detail.relPath}</a>
              </div>
              <div>
                <span className="muted">篇幅</span>
                <span>
                  {fmtChars(detail.chars)} · {detail.lines} 行 · {detail.sections.length} 个章节
                </span>
              </div>
            </div>

            <div className="kb-content">
              {detail.sections.length ? (
                detail.sections.map((s: any, i: number) => {
                  // 默认只显示第一章；点了目录就只显示那一章（含其子章节）
                  const show = activeSection === `s${i}` || activeSection.startsWith(`s${i}-`);
                  if (!show) return null;
                  return (
                    <section className="kb-section" key={i}>
                      <h3>{s.title}</h3>
                      {s.text ? renderSection(s) : null}
                      {s.children.map((c: any, j: number) => {
                        // 选中父章节时显示全部子章节；选中某个子章节时只显示那一个
                        const showSub = activeSection === `s${i}` || activeSection === `s${i}-${j}`;
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
    </div>
  );
}
