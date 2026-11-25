import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Input, Select, DatePicker, Switch, Tooltip, Button, AutoComplete } from 'antd';
import { ImportOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../api';
import { toast } from '../msg';
import { COLLECTION_MAP } from '../../shared/collections';
import VarsEditor, { parseVars, serializeVars } from './VarsEditor';
import ScenePicker from './ScenePicker';
import AccountsEditor, { dropEmptyAccounts } from './AccountsEditor';
import PageElementsEditor, { dropEmptyElements } from './PageElementsEditor';
import { visibleFields } from '../../shared/runs';
import {
  appendOptionValue,
  asArray,
  fieldOptions,
  getOptionsSync,
  labelOf,
  loadOptions,
  mergeOptionCache,
  withCurrentOption,
  OptionsMap
} from '../options';
import { convertSelectionToVar, VAR_NAME_PATTERN } from '../utils';

type Props = {
  open: boolean;
  conf: any;
  record: any;
  /** cURL 导入的预填值（和 record 互斥：record 有值时忽略 prefill） */
  prefill?: any;
  /** 字段级提示（来自 cURL 解析），按 field 分组挂到对应字段旁 */
  warnings?: { field: string; text: string }[];
  onClose: () => void;
  onSaved: (rec: any) => void;
};

/**
 * 关联下拉：平铺按环境排序，每条都带「· 环境」后缀，避免同名站点分不清。
 * 目标集合没有 env 字段时就只显示名称。
 */
function buildLinkOptions(
  f: any,
  rows: any[],
  opts: OptionsMap
): { options: any[]; envById: Record<string, any> } {
  const targetConf = COLLECTION_MAP[f.linkTo];
  const envField =
    targetConf && targetConf.fields ? targetConf.fields.find((x: any) => x.key === 'env' && x.optionsKey) : null;
  const envList = envField ? fieldOptions(envField, opts) : [];
  const titleOf = (r: any) => r.title || (targetConf && (r.data || {})[targetConf.titleField]) || r.id;

  const items = rows.map((r: any) => {
    const envValue = (r.data || {}).env;
    const envArr = asArray(envValue);
    const idx = envArr.length ? envList.findIndex((o: any) => o.value === envArr[0]) : -1;
    const envLabel = envArr.map((e) => labelOf(e, envField || {}, opts)).join(' / ');
    return {
      value: r.id,
      name: titleOf(r),
      envValue,
      envLabel,
      order: idx >= 0 ? idx : envList.length
    };
  });

  items.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const envById: Record<string, any> = {};
  items.forEach((it) => {
    if (it.envValue) envById[it.value] = it.envValue;
  });

  return {
    options: items.map((it) => ({ value: it.value, label: it.envLabel ? `${it.name} · ${it.envLabel}` : it.name })),
    envById
  };
}

export default function RecordForm({ open, conf, record, prefill, warnings, onClose, onSaved }: Props) {
  const [data, setData] = useState<any>({});
  const [tagArr, setTagArr] = useState<string[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 按字段分组 warnings，供标签旁的 ? 使用 */
  const warnByField = useMemo(() => {
    const map: Record<string, { field: string; text: string }[]> = {};
    for (const w of warnings || []) {
      if (!w || !w.field) continue;
      if (!map[w.field]) map[w.field] = [];
      map[w.field].push(w);
    }
    return map;
  }, [warnings]);
  const [linkOptions, setLinkOptions] = useState<Record<string, any[]>>({});
  const [linkEnv, setLinkEnv] = useState<Record<string, Record<string, any>>>({});
  const [opts, setOpts] = useState<OptionsMap>(getOptionsSync());

  /* ------------------------------------------------------------------ *
   * SQL 片段：「转化为变量」
   *
   * 只有 sqls 集合的 sql 字段才有这个按钮（其他集合没有 SQL 正文）。
   * 三个状态各管一件事：
   *   sqlRef   → 拿到真正的 textarea（受控组件，光标要直接操作 DOM）
   *   sqlSel   → 记住「选区的起止」+「当时那段文字」，点按钮时用来防错位
   *   varDlg   → 改名弹框（变量名可改，比自动生成的可控）
   * ------------------------------------------------------------------ */
  const sqlRef = useRef<any>(null);
  const [sqlSel, setSqlSel] = useState<{ start: number; end: number; text: string } | null>(null);
  const [varDlg, setVarDlg] = useState<{ start: number; end: number; text: string; name: string; desc: string } | null>(
    null
  );

  /** 只有 sqls 集合的 sql 字段算「SQL 正文」 */
  const isSqlField = (f: any) => conf.key === 'sqls' && f.key === 'sql';

  /** 变量表（data.vars 是 JSON 字符串） */
  const varsRows = useMemo(() => parseVars(String(data.vars || '')), [data.vars]);

  /** AntD TextArea 的 ref 不是原生 textarea，要往里挖一层 */
  const sqlTextarea = (): HTMLTextAreaElement | null => {
    const r: any = sqlRef.current;
    return r && r.resizableTextArea ? r.resizableTextArea.textArea : null;
  };

  /**
   * 记住这次选区。
   *
   * 关键点：除了起止位置，还要把「当时那段文字」一起记下来 ——
   * 用户选中之后又改了正文的话，位置就对不上了，点按钮时靠这段文字校验出来。
   */
  const rememberSqlSelection = (ta: HTMLTextAreaElement | null) => {
    if (!ta) return;
    const start = ta.selectionStart || 0;
    const end = ta.selectionEnd || 0;
    // 选区塌了（只是点了一下光标）就当没选
    if (end <= start) {
      setSqlSel(null);
      return;
    }
    setSqlSel({ start, end, text: ta.value.slice(start, end) });
  };

  /** 选区预览：太长就截断，别把工具条撑开 */
  const clipText = (s: string, n = 16) => {
    const one = String(s || '').replace(/\s+/g, ' ');
    return one.length > n ? one.slice(0, n) + '…' : one;
  };

  /** 点「转化为变量」：先校验，再弹改名框（不直接替换，给用户一次反悔机会） */
  const openVarDialog = () => {
    const cur = String(data.sql || '');
    const ta = sqlTextarea();
    // 优先用记住的选区（能查出「正文变了」）；没有就退回 DOM 当前的
    let sel = sqlSel;
    if (!sel && ta) {
      const s0 = ta.selectionStart || 0;
      const e0 = ta.selectionEnd || 0;
      sel = { start: s0, end: e0, text: cur.slice(s0, e0) };
    }
    if (!sel || !sel.text.trim()) {
      toast('先在 SQL 里选中一段文字，再点「转化为变量」', 'warning');
      return;
    }
    const probe = convertSelectionToVar(cur, sel.start, sel.end, varsRows, sel.text);
    if (!probe.ok) {
      if (probe.reason === 'changed') toast('正文已经变了，请重新选中再点一次', 'warning');
      else if (probe.reason === 'already') toast(`已经是变量了（${'{{' + probe.varName + '}}'}）`, 'warning');
      else toast('先在 SQL 里选中一段文字，再点「转化为变量」', 'warning');
      return;
    }
    setVarDlg({ start: sel.start, end: sel.end, text: sel.text, name: probe.varName, desc: '' });
  };

  /** 弹框点确定：按用户确认的名字替换正文 + 追加变量定义 */
  const applyVarDialog = () => {
    if (!varDlg) return;
    const name = varDlg.name.trim();
    if (!name) {
      toast('请填写变量名', 'warning');
      return;
    }
    if (!VAR_NAME_PATTERN.test(name)) {
      toast('变量名只能用字母、数字、下划线、点和横线，且不能以数字开头', 'warning');
      return;
    }
    if (varsRows.some((v: any) => v.name.trim() === name)) {
      toast(`已经有一个叫「${name}」的变量了，换个名字`, 'warning');
      return;
    }
    // 这里再算一次：弹框开着的时候正文可能又被改过，仍然要防错位
    const res = convertSelectionToVar(String(data.sql || ''), varDlg.start, varDlg.end, varsRows, varDlg.text, name);
    if (!res.ok) {
      setVarDlg(null);
      setSqlSel(null);
      toast(res.reason === 'changed' ? '正文已经变了，请重新选中再点一次' : '这段文字现在不能转成变量', 'warning');
      return;
    }
    // 变量表：追加一条，说明用弹框里填的
    const nextVars = res.vars.slice();
    nextVars[nextVars.length - 1] = { name, value: '', desc: varDlg.desc.trim() };
    set('sql', res.text);
    set('vars', serializeVars(nextVars));
    setVarDlg(null);
    setSqlSel(null);
    toast(`已转为 {{${name}}}`);
    // 光标落到 }} 后面；等受控值渲染完再设，否则会被打回原位置
    window.setTimeout(() => {
      const ta = sqlTextarea();
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(res.cursor, res.cursor);
    }, 0);
  };

  useEffect(() => {
    if (!open) return;
    loadOptions().then(setOpts).catch(() => {});
    const init: any = {};
    // record 优先（编辑已有记录），否则用 prefill（cURL 导入）
    const source = record && record.data ? record.data : prefill || {};
    for (const f of conf.fields) {
      const raw = source[f.key];
      if (f.type === 'multiselect') {
        init[f.key] = raw !== undefined ? asArray(raw) : asArray(f.default);
      } else {
        init[f.key] = raw !== undefined ? raw : f.default || '';
      }
    }
    setData(init);
    setTagArr(asArray((record && record.tags) || []));
    setFavorite(!!(record && record.favorite));
  }, [open, record, prefill, conf]);

  useEffect(() => {
    if (!open) return;
    const linkFields = conf.fields.filter((f: any) => f.type === 'link');
    linkFields.forEach(async (f: any) => {
      try {
        const rows = await api.records(f.linkTo);
        const built = buildLinkOptions(f, rows, opts);
        setLinkOptions((prev) => ({ ...prev, [f.key]: built.options }));
        setLinkEnv((prev) => ({ ...prev, [f.key]: built.envById }));
      } catch (e) {
        /* ignore */
      }
    });
  }, [open, conf, opts]);

  const set = (key: string, value: any) => setData((prev: any) => ({ ...prev, [key]: value }));

  /** 正在保存选项集的 key：同一个选项集同时只留一次写盘，避免连点 / 连续失焦打架 */
  const optSaveRef = useRef<Record<string, boolean>>({});

  /**
   * 「可选择 + 可新建」字段：值不在选项集里就把它补进去。
   *
   * 为什么放到失焦 / 保存时才做：AutoComplete 的 onChange 每敲一个字符触发一次，
   * 在这儿直接写盘会把「资产管理系统」拆成「资」「资产」「资产管」… 一串碎词。
   * 老记录里的自由文本（导入的模块 / 项目）也走这条路，编辑一次就自动收进选项集。
   *
   * 失败只静默跳过：记录本身该存还是存，候选没记住不影响这条数据。
   */
  const rememberOption = async (f: any, value: any) => {
    const key = f && f.optionsKey;
    if (!key) return;
    const next = appendOptionValue((opts as any)[key], value);
    if (!next) return; // 空值或已经在选项集里
    if (optSaveRef.current[key]) return;
    optSaveRef.current[key] = true;
    try {
      const saved: any = await api.saveOptions(key, next);
      const list = saved && Array.isArray(saved[key]) ? saved[key] : next;
      setOpts((prev) => ({ ...prev, [key]: list }) as OptionsMap);
      // 同步进进程内缓存：别的表单 / 详情页下次打开就能选到这个新值
      mergeOptionCache(key, list);
    } catch (e) {
      /* 忽略：只是候选没记住 */
    } finally {
      optSaveRef.current[key] = false;
    }
  };

  const save = async () => {
    for (const f of conf.fields) {
      if (f.required && !String(data[f.key] === undefined ? '' : data[f.key]).trim()) {
        toast(`请填写「${f.label}」`, 'error');
        return;
      }
    }
    setSaving(true);
    try {
      // 保存前清理：丢掉完全空的账号行（编辑时不过滤，保存时才过滤）
      const payload = Object.assign({}, data);
      for (const f of conf.fields) {
        if (f.type === 'accounts' && payload[f.key]) {
          payload[f.key] = dropEmptyAccounts(String(payload[f.key]));
        }
        // 页面元素：丢掉空行 + 序列化成 JSON
        if (f.type === 'elements' && payload[f.key]) {
          payload[f.key] = dropEmptyElements(payload[f.key]);
        }
      }
      // 「可选择 + 可新建」：用户输入完直接点保存、没触发失焦时，这里补一次
      for (const f of conf.fields) {
        if (f.type === 'selectOrCreate') await rememberOption(f, payload[f.key]);
      }
      const saved = await api.saveRecord({
        id: record && record.id,
        collection: conf.key,
        data: payload,
        tags: tagArr,
        favorite
      });
      toast(record && record.id ? '已保存' : '已新增');
      onSaved(saved);
      onClose();
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const renderField = (f: any) => {
    const v = data[f.key];
    switch (f.type) {
      case 'select':
        return (
          <Select
            value={v || undefined}
            placeholder={f.placeholder}
            options={fieldOptions(f, opts)}
            onChange={(val) => set(f.key, val)}
            allowClear
            style={{ width: '100%' }}
          />
        );
      case 'selectOrCreate': {
        // 候选里补上「当前值」：老数据的自由文本不在选项集里，也要能正常显示 / 保存
        const candidates = withCurrentOption(fieldOptions(f, opts), v).map((o: any) => ({
          value: o.value,
          label: o.label
        }));
        return (
          <AutoComplete
            value={v}
            options={candidates}
            placeholder={f.placeholder}
            // 打字只改本地值，不写盘（见 rememberOption 的说明）
            onChange={(val) => set(f.key, val)}
            // 失焦才把新值收进选项集：下次就能从下拉里直接选
            onBlur={() => rememberOption(f, data[f.key])}
            allowClear
            style={{ width: '100%' }}
            filterOption={(input, opt) =>
              String((opt && (opt as any).value) || '')
                .toLowerCase()
                .includes(String(input || '').toLowerCase())
            }
          />
        );
      }
      case 'multiselect':
        return (
          <Select
            mode="multiple"
            value={Array.isArray(v) ? v : asArray(v)}
            placeholder={f.placeholder || '可多选'}
            options={fieldOptions(f, opts)}
            onChange={(val: string[]) => set(f.key, asArray(val))}
            optionFilterProp="label"
            allowClear
            style={{ width: '100%' }}
          />
        );
      case 'date':
        return (
          <DatePicker
            value={v ? dayjs(v) : null}
            onChange={(d) => set(f.key, d ? d.format('YYYY-MM-DD') : '')}
            style={{ width: '100%' }}
          />
        );
      case 'datetime':
        return (
          <DatePicker
            showTime
            value={v ? dayjs(Number(v)) : null}
            onChange={(d) => set(f.key, d ? d.valueOf() : '')}
            style={{ width: '100%' }}
          />
        );
      case 'number':
        return (
          <Input
            type="number"
            value={v === undefined || v === null ? '' : String(v)}
            placeholder={f.placeholder}
            onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'link': {
        const opts = linkOptions[f.key] || [];
        const stale = v && !opts.some((o: any) => o.value === v);
        const targetConf = COLLECTION_MAP[f.linkTo];
        const hasSyncEnv =
          !!(targetConf && targetConf.fields && targetConf.fields.some((x: any) => x.key === 'env')) &&
          conf.fields.some((x: any) => x.key === 'env');
        return (
          <Select
            value={v || undefined}
            placeholder={f.placeholder}
            options={stale ? [...opts, { value: v, label: '（原记录已删除）' }] : opts}
            onChange={(val) => {
              set(f.key, val);
              // 选了站点就把它所在环境带过来，省得再手选一次；清空则不动
              const env = val && linkEnv[f.key] ? linkEnv[f.key][val] : '';
              if (hasSyncEnv && env) {
                const localEnvField = conf.fields.find((x: any) => x.key === 'env');
                set('env', localEnvField && localEnvField.type === 'multiselect' ? asArray(env) : env);
              }
            }}
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
          />
        );
      }
      case 'secret':
        return <Input.Password value={v} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />;
      case 'accounts':
        return <AccountsEditor value={v} onChange={(next) => set(f.key, next)} />;
      case 'elements':
        return <PageElementsEditor value={v} onChange={(next) => set(f.key, next)} placeholder={f.placeholder} />;
      case 'scene':
        return <ScenePicker value={v} onChange={(next) => set(f.key, next)} placeholder={f.placeholder} />;
      case 'vars':
        return <VarsEditor value={v} onChange={(next) => set(f.key, next)} sqlText={String(data.sql || '')} />;
      case 'code':
      case 'markdown':
        return (
          <>
            <Input.TextArea
              ref={isSqlField(f) ? sqlRef : undefined}
              className="code-area"
              value={v}
              onChange={(e) => set(f.key, e.target.value)}
              // 选中就记下来（含当时那段文字），点「转化为变量」时校验用
              onSelect={(e: any) => {
                if (isSqlField(f)) rememberSqlSelection(e.target);
              }}
              autoSize={{ minRows: f.rows || 6, maxRows: 20 }}
              placeholder={f.placeholder}
            />
            {isSqlField(f) ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                {/* onMouseDown 拦默认行为：点按钮不抢焦点，textarea 的选区才不会丢 */}
                <Button
                  size="small"
                  type="link"
                  icon={<ImportOutlined />}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={openVarDialog}
                  style={{ paddingInline: 0 }}
                >
                  转化为变量
                </Button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {sqlSel && sqlSel.text.trim()
                    ? `已选中「${clipText(sqlSel.text)}」—— 点左边把它变成 {'{{变量}}'}，并自动加一条变量说明`
                    : `先在 SQL 里选中一段写死的值（比如单号），再点「转化为变量」变成 {'{{变量}}'}`}
                </span>
              </div>
            ) : null}
          </>
        );
      case 'textarea':
        return (
          <Input.TextArea
            value={v}
            onChange={(e) => set(f.key, e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={f.placeholder}
          />
        );
      default:
        return <Input value={v} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />;
    }
  };

  return (
    <>
      <Modal
        open={open}
        title={(record && record.id ? '编辑' : '新增') + conf.name}
        onCancel={onClose}
        width={660}
        okText="保存"
        cancelText="取消"
        onOk={save}
        confirmLoading={saving}
        destroyOnClose
      >
      <div style={{ paddingTop: 8 }}>
        {visibleFields(conf.fields, data.kind)
          .filter((f: any) => !f.formHidden)
          .map((f: any) => (
          <div key={f.key} style={{ marginBottom: 14 }}>
            <div className="kv-label">
              {f.label}
              {f.required ? <span style={{ color: '#e5534b' }}> *</span> : null}
              {warnByField[f.key] && warnByField[f.key].length ? (
                <Tooltip
                  title={
                    <ol className="field-warn-list">
                      {warnByField[f.key].map((w: any, i: number) => (
                        <li key={i}>{w.text}</li>
                      ))}
                    </ol>
                  }
                >
                  <span className="field-warn-mark">?</span>
                </Tooltip>
              ) : null}
            </div>
            {renderField(f)}
            {f.hint ? <div className="form-hint muted">{f.hint}</div> : null}
            {f.key === conf.titleField && record && record.data && record.data.source === 'openapi' ? (
              <div className="form-hint muted">
                这条是同步来的：名称/描述以 Apifox 为准，下次同步会覆盖；你自己的东西写在「我的备注」里
              </div>
            ) : null}
          </div>
        ))}
        <div style={{ marginBottom: 14 }}>
          <div className="kv-label">标签</div>
          <Select
            mode="tags"
            value={tagArr}
            placeholder="输入后回车确认，新标签会自动加入配置"
            options={(opts.tags || []).map((t: string) => ({ value: t, label: t }))}
            onChange={(val: string[]) => setTagArr(asArray(val))}
            tokenSeparators={[',', '，', ' ']}
            allowClear
            style={{ width: '100%' }}
          />
        </div>
        {!conf.noFavorite ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="kv-label" style={{ margin: 0 }}>
              收藏
            </span>
            <Switch checked={favorite} onChange={setFavorite} size="small" />
          </div>
        ) : null}
        </div>
      </Modal>

      {/*
        改名弹框：自动猜的名字只是草稿，用户在这里改。
        为什么不直接替换 —— 猜错一次就得撤销重来，弹框更可控。
      */}
      <Modal
        open={!!varDlg}
        title="转化为变量"
        okText="确定"
        cancelText="取消"
        width={420}
        onOk={applyVarDialog}
        onCancel={() => setVarDlg(null)}
        destroyOnClose
      >
        <div style={{ paddingTop: 4 }}>
          <div className="kv-label">变量名</div>
          <Input
            value={varDlg ? varDlg.name : ''}
            placeholder="如 orderNo"
            autoFocus
            onChange={(e) => setVarDlg((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onPressEnter={applyVarDialog}
          />
          <div className="form-hint muted">
            正文里会变成 {'{{变量名}}'}；字母、数字、下划线、点和横线，且不能以数字开头
          </div>
          <div className="kv-label" style={{ marginTop: 10 }}>
            说明（选填）
          </div>
          <Input
            value={varDlg ? varDlg.desc : ''}
            placeholder="如 订单号"
            onChange={(e) => setVarDlg((prev) => (prev ? { ...prev, desc: e.target.value } : prev))}
            onPressEnter={applyVarDialog}
          />
          <div className="form-hint muted">写进「变量说明」，留空也行，之后在表格里补</div>
          {varDlg ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              要替换的文字：「{clipText(varDlg.text, 40)}」
            </div>
          ) : null}
        </div>
      </Modal>
    </>
  );
}