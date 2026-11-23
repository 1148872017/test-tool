import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Input, Select, DatePicker, Switch, Tooltip } from 'antd';
import dayjs from 'dayjs';
import api from '../api';
import { toast } from '../msg';
import { COLLECTION_MAP } from '../../shared/collections';
import VarsEditor from './VarsEditor';
import ScenePicker from './ScenePicker';
import AccountsEditor, { dropEmptyAccounts } from './AccountsEditor';
import { visibleFields } from '../../shared/runs';
import { asArray, fieldOptions, getOptionsSync, labelOf, loadOptions, OptionsMap } from '../options';

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
      case 'scene':
        return <ScenePicker value={v} onChange={(next) => set(f.key, next)} placeholder={f.placeholder} />;
      case 'vars':
        return <VarsEditor value={v} onChange={(next) => set(f.key, next)} sqlText={String(data.sql || '')} />;
      case 'code':
      case 'markdown':
        return (
          <Input.TextArea
            className="code-area"
            value={v}
            onChange={(e) => set(f.key, e.target.value)}
            autoSize={{ minRows: f.rows || 6, maxRows: 20 }}
            placeholder={f.placeholder}
          />
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
  );
}