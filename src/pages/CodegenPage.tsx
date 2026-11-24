import React, { useEffect, useMemo, useState } from 'react';
import { Select, Button, Input, Tag, Alert, Space, Segmented, Empty } from 'antd';
import {
  CodeOutlined,
  SaveOutlined,
  CopyOutlined,
  ReloadOutlined,
  FileTextOutlined
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
  const [jsonText, setJsonText] = useState('{\n  "code": 0,\n  "msg": "ok"\n}');
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
    })();
  }, []);

  /* ---------- 生成预览 ---------- */
  const doPreview = async () => {
    setBusy(true);
    try {
      const payload: any = { targetKey, className };
      if (kind === 'api') {
        if (!apiId) {
          toast('请先选一个接口', 'warning');
          setBusy(false);
          return;
        }
        payload.apiId = apiId;
      } else if (kind === 'page') {
        payload.page = { name: pageName, url: pageUrl, elements };
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
      if (kind === 'api') payload.apiId = apiId;
      else if (kind === 'page') payload.page = { name: pageName, url: pageUrl, elements };
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
              <div className="codegen-label">选接口</div>
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
                          {hit.data.module ? ` · ${hit.data.module}` : ''}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : null}
            </>
          ) : null}

          {kind === 'page' ? (
            <>
              <div className="codegen-label">页面信息</div>
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
              <div className="codegen-label">JSON 示例</div>
              <Input.TextArea
                className="mono"
                rows={12}
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
                placeholder='{"code": 0, "data": {...}}'
              />
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
