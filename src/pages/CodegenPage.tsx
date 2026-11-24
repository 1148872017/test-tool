import React, { useEffect, useMemo, useState } from 'react';
import { Select, Button, Input, Tag, Space, Segmented, Empty } from 'antd';
import {
  CodeOutlined,
  SaveOutlined,
  CopyOutlined,
  ReloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

type Target = {
  key: string;
  label: string;
  desc: string;
  lang: string;
  ext: string;
  kind: 'api' | 'page' | 'model';
};

/** 页面元素（POM 生成用） */
type PageElement = { name: string; selector: string; desc: string };

export default function CodegenPage() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetKey, setTargetKey] = useState('java-restassured');

  // 数据源
  const [apis, setApis] = useState<any[]>([]);
  const [apiId, setApiId] = useState('');
  // 数据源：record = 从接口记录选；file = 直接导入 OpenAPI 文件
  const [apiSource, setApiSource] = useState<'record' | 'file'>('record');
  const [openapiFile, setOpenapiFile] = useState('');
  const [openapiItems, setOpenapiItems] = useState<any[]>([]);
  const [openapiIdx, setOpenapiIdx] = useState<number>(-1);
  const [openapiBusy, setOpenapiBusy] = useState(false);
  const [jsonText, setJsonText] = useState('{\n  "code": 0,\n  "msg": "ok"\n}');
  /** model 模式的数据源：JSON 响应体 / CREATE TABLE 建表语句 */
  const [modelSource, setModelSource] = useState<'json' | 'sql'>('json');
  const [sqlText, setSqlText] = useState(
    'CREATE TABLE t_order (\n  id bigint(20) NOT NULL COMMENT 主键,\n  order_no varchar(64) NOT NULL COMMENT 订单号,\n  amount decimal(10,2) COMMENT 金额,\n  created_at datetime COMMENT 创建时间\n);'
  );
  const [pages, setPages] = useState<any[]>([]);
  const [pageId, setPageId] = useState('');
  const [pageName, setPageName] = useState('login');
  const [pageUrl, setPageUrl] = useState('/login');
  const [elements, setElements] = useState<PageElement[]>([
    { name: 'usernameInput', selector: '#username', desc: '用户名输入框' }
  ]);
  const [className, setClassName] = useState('');

  // 输出
  const [code, setCode] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => targets.find((t) => t.key === targetKey), [targets, targetKey]);
  const kind = current ? current.kind : 'api';

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    (async () => {
      try {
        const res = await api.codegenTargets();
        setTargets(res.targets || []);
      } catch (e: any) {
        toast('加载生成目标失败：' + (e && e.message ? e.message : e), 'error');
      }
      try {
        const rows = await api.records('apis');
        setApis(rows || []);
      } catch (e) {
        /* ignore */
      }
      try {
        const rows = await api.records('pages');
        setPages(rows || []);
      } catch (e) {
        /* ignore */
      }
    })();
  }, []);

  /* ---------- 选并解析 OpenAPI 文件 ---------- */
  const doPickOpenapi = async () => {
    setOpenapiBusy(true);
    try {
      const picked = await api.openapiPickFile();
      if (picked.canceled) return;
      if (!picked.ok) {
        toast(picked.message || '选择失败', 'error');
        return;
      }
      const res = await api.openapiParseFile(picked.file);
      if (!res.ok) {
        toast(res.message || '解析失败', 'error');
        setOpenapiItems([]);
        return;
      }
      setOpenapiFile(picked.file);
      setOpenapiItems(res.items || []);
      setOpenapiIdx(res.items && res.items.length ? 0 : -1);
      toast(`解析出 ${(res.items || []).length} 个接口`);
    } catch (e: any) {
      toast('导入失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setOpenapiBusy(false);
    }
  };

  /** 当前选中的接口数据（文件模式或记录模式） */
  const currentApiData = () => {
    if (apiSource === 'file') {
      return openapiIdx >= 0 && openapiItems[openapiIdx] ? openapiItems[openapiIdx] : null;
    }
    if (!apiId) return null;
    const hit = apis.find((a) => a.id === apiId);
    return hit ? hit.data : null;
  };

  /* ---------- 生成预览 ---------- */
  const doPreview = async () => {
    setBusy(true);
    try {
      const payload: any = { targetKey, className };
      if (kind === 'api') {
        if (apiSource === 'file') {
          const d = currentApiData();
          if (!d) {
            toast('请先从文件里选一个接口', 'warning');
            setBusy(false);
            return;
          }
          payload.apiData = d;
        } else {
          if (!apiId) {
            toast('请先选一个接口', 'warning');
            setBusy(false);
            return;
          }
          payload.apiId = apiId;
        }
      } else if (kind === 'page') {
        payload.page = { name: pageName, url: pageUrl, elements };
      } else if (modelSource === 'sql') {
        payload.sql = sqlText;
      } else {
        payload.json = jsonText;
      }
      const res = await api.codegenPreview(payload);
      if (!res.ok) {
        toast(res.message || '生成失败', 'error');
        setCode('');
        return;
      }
      setCode(res.code);
      setFilename(res.filename);
    } catch (e: any) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 保存 ---------- */
  const doSave = async () => {
    if (!code) {
      toast('先生成预览', 'warning');
      return;
    }
    setBusy(true);
    try {
      const payload: any = { targetKey, className };
      if (kind === 'api') {
        if (apiSource === 'file') payload.apiData = currentApiData();
        else payload.apiId = apiId;
      } else if (kind === 'page') payload.page = { name: pageName, url: pageUrl, elements };
      else if (modelSource === 'sql') payload.sql = sqlText;
      else payload.json = jsonText;

      const res = await api.codegenSave(payload);
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '保存失败', 'error');
        return;
      }
      toast('已保存：' + res.file);
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async () => {
    if (!code) return;
    await api.copy(code, false);
    toast('代码已复制');
  };

  /** 解析 elements 字段（兼容 JSON 数组和旧的多行文本） */
  const parseElements = (text: string): PageElement[] => parseElementsShared(text);

  /** 从「页面元素」集合载入一个页面 */
  const doLoadPage = (id: string) => {
    setPageId(id);
    const hit = pages.find((x) => x.id === id);
    if (!hit) return;
    const d = hit.data || {};
    setPageName(String(d.name || ''));
    setPageUrl(String(d.url || '/'));
    const els = parseElements(d.elements || '');
    if (els.length) setElements(els);
    toast(`已载入「${d.name || ''}」（${els.length} 个元素）`);
  };

  /* ---------- 元素增删 ---------- */
  const addElement = () =>
    setElements((prev) => prev.concat([{ name: '', selector: '', desc: '' }]));
  const removeElement = (i: number) => setElements((prev) => prev.filter((_, idx) => idx !== i));
  const setElement = (i: number, key: keyof PageElement, v: string) => {
    setElements((prev) => {
      const next = prev.slice();
      next[i] = Object.assign({}, next[i], { [key]: v });
      return next;
    });
  };

  return (
    <div className="codegen-page">
      {/* 顶部：生成目标 */}
      <div className="codegen-bar">
        <Space size={8} wrap>
          <span className="muted">生成</span>
          <Select
            size="small"
            value={targetKey}
            onChange={(v) => {
              setTargetKey(v);
              setCode('');
            }}
            style={{ width: 240 }}
            options={targets.map((t) => ({ value: t.key, label: t.label }))}
          />
          <span className="muted">类名</span>
          <Input
            size="small"
            style={{ width: 160 }}
            value={className}
            placeholder="自动推断"
            onChange={(e) => setClassName(e.target.value)}
          />
          <Button
            type="primary"
            size="small"
            icon={<CodeOutlined />}
            onClick={doPreview}
            loading={busy}
          >
            生成预览
          </Button>
          <Button size="small" icon={<SaveOutlined />} onClick={doSave} disabled={!code}>
            保存到文件
          </Button>
          <Button size="small" icon={<CopyOutlined />} onClick={doCopy} disabled={!code}>
            复制
          </Button>
        </Space>
      </div>

      {current ? <div className="codegen-desc muted">{current.desc}</div> : null}

      <div className="codegen-body">
        {/* 左侧：数据源 */}
        <div className="codegen-source">
          {kind === 'api' ? (
            <>
              <div className="codegen-label">数据源</div>
              <Segmented
                size="small"
                value={apiSource}
                onChange={(v) => setApiSource(v as 'record' | 'file')}
                options={[
                  { label: '接口记录', value: 'record' },
                  { label: 'OpenAPI 文件', value: 'file' }
                ]}
              />

              {apiSource === 'record' ? (
                <>
                  <Select
                    size="small"
                    style={{ width: '100%' }}
                    value={apiId}
                    onChange={setApiId}
                    placeholder={apis.length ? '从「接口记录」里选' : '还没有接口记录'}
                    showSearch
                    optionFilterProp="label"
                    options={apis.map((a) => ({
                      value: a.id,
                      label: `${a.data.method} ${a.data.url} · ${a.title}`
                    }))}
                  />
                  {apiId ? (
                    <div className="codegen-api-info">
                      {(() => {
                        const hit = apis.find((a) => a.id === apiId);
                        if (!hit) return null;
                        return (
                          <>
                            <div>
                              <Tag color="blue">{hit.data.method}</Tag>
                              <span className="mono">{hit.data.url}</span>
                            </div>
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              {hit.title}
                              {hit.data.module ? ' · ' + hit.data.module : ''}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={doPickOpenapi}
                    loading={openapiBusy}
                    style={{ width: `100%` }}
                  >
                    {openapiFile ? '重新选择文件' : '选择 OpenAPI 文件（json / yaml）'}
                  </Button>
                  {openapiFile ? (
                    <div className="muted mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                      {openapiFile}
                    </div>
                  ) : null}
                  {openapiItems.length ? (
                    <>
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        value={openapiIdx}
                        onChange={setOpenapiIdx}
                        showSearch
                        optionFilterProp="label"
                        options={openapiItems.map((it, i) => ({
                          value: i,
                          label: `${it.method} ${it.url} · ${it.name}`
                        }))}
                      />
                      <div className="muted" style={{ fontSize: 12 }}>
                        共 {openapiItems.length} 个接口（从文件解析，不影响「接口记录」）
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </>
          ) : null}

          {kind === 'page' ? (
            <>
              <div className="codegen-label">从「页面元素」载入</div>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={pageId}
                onChange={doLoadPage}
                allowClear
                placeholder={pages.length ? '选一个已保存的页面' : '还没有页面（去「页面元素」新增）'}
                showSearch
                optionFilterProp="label"
                options={pages.map((x) => ({
                  value: x.id,
                  label: `${x.data.name || ''} · ${x.data.url || ''}`
                }))}
              />

              <div className="codegen-label" style={{ marginTop: 8 }}>
                页面信息
              </div>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Input
                  size="small"
                  value={pageName}
                  placeholder="页面名（如 login）"
                  onChange={(e) => setPageName(e.target.value)}
                />
                <Input
                  size="small"
                  value={pageUrl}
                  placeholder="页面路径（如 /login）"
                  onChange={(e) => setPageUrl(e.target.value)}
                />
              </Space>

              <div className="codegen-label" style={{ marginTop: 10 }}>
                元素定位器
              </div>
              <table className="jmx-table codegen-el-table">
                <thead>
                  <tr>
                    <th style={{ width: '30%' }}>名称</th>
                    <th style={{ width: '40%' }}>定位器</th>
                    <th>说明</th>
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {elements.map((el, i) => (
                    <tr key={i}>
                      <td>
                        <Input
                          size="small"
                          value={el.name}
                          placeholder="usernameInput"
                          onChange={(e) => setElement(i, 'name', e.target.value)}
                        />
                      </td>
                      <td>
                        <Input
                          size="small"
                          className="mono"
                          value={el.selector}
                          placeholder="#username"
                          onChange={(e) => setElement(i, 'selector', e.target.value)}
                        />
                      </td>
                      <td>
                        <Input
                          size="small"
                          value={el.desc}
                          placeholder="用户名输入框"
                          onChange={(e) => setElement(i, 'desc', e.target.value)}
                        />
                      </td>
                      <td>
                        <Button
                          type="text"
                          size="small"
                          danger
                          onClick={() => removeElement(i)}
                        >
                          ×
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button size="small" type="link" onClick={addElement}>
                + 添加元素
              </Button>
            </>
          ) : null}

          {kind === 'model' ? (
            <>
              <div className="codegen-label">数据来源</div>
              <Segmented
                size="small"
                value={modelSource}
                onChange={(v) => setModelSource(v as 'json' | 'sql')}
                options={[
                  { label: 'JSON 响应体', value: 'json' },
                  { label: 'CREATE TABLE', value: 'sql' }
                ]}
              />

              {modelSource === 'json' ? (
                <>
                  <div className="codegen-label" style={{ marginTop: 6 }}>
                    JSON 示例
                  </div>
                  <Input.TextArea
                    className="mono"
                    rows={12}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    spellCheck={false}
                    placeholder='{"code": 0, "data": {...}}'
                  />
                </>
              ) : (
                <>
                  <div className="codegen-label" style={{ marginTop: 6 }}>
                    建表语句（MySQL / SQLite 都认）
                  </div>
                  <Input.TextArea
                    className="mono"
                    rows={12}
                    value={sqlText}
                    onChange={(e) => setSqlText(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    从建表语句推断字段和类型（不连数据库）。类名默认按表名取（t_order → Order）。
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>

        {/* 右侧：代码预览 */}
        <div className="codegen-output">
          <div className="codegen-output-head">
            <span>
              {filename ? (
                <>
                  <FileTextOutlined /> {filename}
                </>
              ) : (
                '代码预览'
              )}
            </span>
            {code ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {code.split('\n').length} 行
              </span>
            ) : null}
          </div>
          {code ? (
            <pre className="codegen-code mono">{code}</pre>
          ) : (
            <div className="codegen-empty">
              <Empty description="选好数据源，点「生成预览」" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
