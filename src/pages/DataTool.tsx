import React, { useMemo, useState } from 'react';
import { InputNumber, Input, Button, Select, Space, Tag, Tooltip, Segmented } from 'antd';
import {
  CopyOutlined,
  ThunderboltOutlined,
  DownloadOutlined,
  PlusOutlined,
  DeleteOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'.split('');
const GIVEN = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '霞', '平', '刚', '桂英', '建国', '文', '辉', '雪', '鹏'];
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州'];
const ROADS = ['中山路', '人民路', '解放路', '建设路', '长江路', '黄河路', '科技大道', '高新路'];
const COMPANY_PRE = ['华', '中', '恒', '远', '天', '创', '诚', '汇', '鑫', '博'];
const COMPANY_MID = ['联', '信', '达', '泰', '通', '科', '网', '盛'];
const COMPANY_SUF = ['科技有限公司', '网络技术有限公司', '信息技术有限公司', '电子商务有限公司'];

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

function genName() {
  return pick(SURNAMES) + pick(GIVEN);
}

function genPhone() {
  return '1' + pick('3456789'.split('')) + digits(9);
}

function genEmail() {
  const pool = ['test', 'qa', 'dev', 'auto', 'demo', 'case'];
  return `${pick(pool)}${digits(4)}@${pick(['example.com', 'test.com', 'mail.com', 'corp.cn'])}`;
}

function genIdCard() {
  const area = pick(['110101', '310101', '440305', '330106', '510107', '420106']);
  const year = 1970 + Math.floor(Math.random() * 35);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
  const body = area + year + month + day + digits(3);
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = body.split('').reduce((acc, ch, i) => acc + Number(ch) * weights[i], 0);
  const check = '10X98765432'[sum % 11];
  return body + check;
}

function luhnCheckDigit(partial: string) {
  let sum = 0;
  let double = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = Number(partial[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

function genBankCard() {
  const partial = '62' + digits(13);
  return partial + luhnCheckDigit(partial);
}

function genAddress() {
  return `${pick(CITIES)}市${pick(['朝阳区', '海淀区', '浦东新区', '天河区', '西湖区'])}${pick(ROADS)}${1 + Math.floor(Math.random() * 200)}号`;
}

function genCompany() {
  return pick(COMPANY_PRE) + pick(COMPANY_MID) + pick(COMPANY_PRE) + pick(COMPANY_SUF);
}

function genUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function genDate() {
  const start = new Date(2020, 0, 1).getTime();
  const end = Date.now();
  return new Date(start + Math.random() * (end - start)).toISOString().slice(0, 10);
}

function genAmount() {
  return (Math.random() * 9999 + 0.01).toFixed(2);
}

function genOrderNo() {
  return 'SO' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + digits(6);
}

const TYPES = [
  { value: 'name', label: '中文姓名', fn: genName },
  { value: 'phone', label: '手机号', fn: genPhone },
  { value: 'email', label: '邮箱', fn: genEmail },
  { value: 'idcard', label: '身份证号', fn: genIdCard },
  { value: 'bank', label: '银行卡号', fn: genBankCard },
  { value: 'address', label: '地址', fn: genAddress },
  { value: 'company', label: '公司名', fn: genCompany },
  { value: 'uuid', label: 'UUID', fn: genUuid },
  { value: 'date', label: '日期', fn: genDate },
  { value: 'amount', label: '金额', fn: genAmount },
  { value: 'order', label: '订单号', fn: genOrderNo }
];

/** 多字段组合里的一个字段 */
type Field = {
  name: string;
  type: string;
  /** 固定值（填了就不用随机生成） */
  fixed: string;
};

/** 默认字段组合（开箱即用的「用户表」样例） */
const DEFAULT_FIELDS: Field[] = [
  { name: 'userName', type: 'name', fixed: '' },
  { name: 'mobile', type: 'phone', fixed: '' },
  { name: 'email', type: 'email', fixed: '' },
  { name: 'idCard', type: 'idcard', fixed: '' }
];

export default function DataTool() {
  // 单类型模式
  const [type, setType] = useState('phone');
  const [rows, setRows] = useState<string[]>([]);

  // 多字段模式
  const [mode, setMode] = useState<'single' | 'multi'>('single');
  const [fields, setFields] = useState<Field[]>(DEFAULT_FIELDS);
  const [multiRows, setMultiRows] = useState<string[][]>([]);

  const [count, setCount] = useState(5);

  /** 上限 10 万（CSV 导出用，太多会卡） */
  const normalizeCount = () => Math.max(1, Math.min(100000, Number(count) || 1));

  const generate = () => {
    const n = normalizeCount();

    if (mode === 'single') {
      const def = TYPES.find((t) => t.value === type) || TYPES[0];
      setRows(Array.from({ length: n }, () => def.fn()));
      return;
    }

    // 多字段：每行按字段列表逐个生成
    const valid = fields.filter((f) => f.name.trim());
    if (!valid.length) {
      toast('至少填一个字段名', 'warning');
      return;
    }
    const resolved = valid.map((f) => ({
      fixed: f.fixed,
      fn: (TYPES.find((t) => t.value === f.type) || TYPES[0]).fn
    }));
    setMultiRows(
      Array.from({ length: n }, () => resolved.map((r) => (r.fixed ? r.fixed : r.fn())))
    );
  };

  /* ---------- 字段增删改 ---------- */
  const addField = () => setFields((prev) => prev.concat([{ name: '', type: 'name', fixed: '' }]));
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));
  const setField = (i: number, key: keyof Field, v: string) => {
    setFields((prev) => {
      const next = prev.slice();
      next[i] = Object.assign({}, next[i], { [key]: v });
      return next;
    });
  };

  /** 当前模式下的有效字段名（导出用） */
  const activeFieldNames = useMemo(
    () => fields.filter((f) => f.name.trim()).map((f) => f.name.trim()),
    [fields]
  );

  const copyOne = async (v: string) => {
    await api.copy(v, false);
    toast('已复制');
  };

  /**
   * 导出为 CSV / JSON。
   *
   * 用 Blob + a[download] 触发浏览器下载（Electron 里也能用）。
   * CSV 加 BOM，否则 Excel 打开中文乱码。
   */
  const doExport = (format: 'csv' | 'json') => {
    const isMulti = mode === 'multi';
    const dataCount = isMulti ? multiRows.length : rows.length;
    if (!dataCount) return;

    const def = TYPES.find((t) => t.value === type) || TYPES[0];
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    let content = '';
    let mime = '';
    let ext = '';
    const baseName = isMulti ? 'multi' : def.value;

    // CSV 转义：值里有逗号/引号/换行要包起来
    const esc = (v: string) => {
      const t = String(v);
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };

    if (format === 'csv') {
      if (isMulti) {
        // 表头 = 字段名，每行 = 一条记录
        const lines = [activeFieldNames.map(esc).join(',')];
        for (const row of multiRows) lines.push(row.map(esc).join(','));
        content = '\uFEFF' + lines.join('\n');
      } else {
        content = '\uFEFF' + def.label + '\n' + rows.map(esc).join('\n');
      }
      mime = 'text/csv;charset=utf-8';
      ext = 'csv';
    } else {
      if (isMulti) {
        // JSON：对象数组，key 是字段名
        const objs = multiRows.map((row) => {
          const o: Record<string, string> = {};
          activeFieldNames.forEach((n, i) => {
            o[n] = row[i] === undefined ? '' : row[i];
          });
          return o;
        });
        content = JSON.stringify(objs, null, 2);
      } else {
        content = JSON.stringify(rows, null, 2);
      }
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}-${dataCount}-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${dataCount} 条 ${ext.toUpperCase()}`);
  };

  const copyAll = async () => {
    if (mode === 'multi') {
      if (!multiRows.length) {
        toast('还没有生成数据', 'warning');
        return;
      }
      // 复制成 TSV（Excel 直接粘贴就是多列）
      const lines = [activeFieldNames.join('\t')];
      for (const row of multiRows) lines.push(row.join('\t'));
      await api.copy(lines.join('\n'), false);
      toast(`已复制 ${multiRows.length} 行（制表符分隔，可直接粘进 Excel）`);
      return;
    }
    if (!rows.length) {
      toast('还没有生成数据', 'warning');
      return;
    }
    await api.copy(rows.join('\n'), false);
    toast(`已复制 ${rows.length} 条`);
  };

  const hasData = mode === 'multi' ? multiRows.length > 0 : rows.length > 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">测试数据</div>
          <div className="page-desc">常用测试数据批量生成，本地计算，随机但格式合法</div>
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <Space wrap size={12} style={{ marginBottom: 10 }}>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'single' | 'multi')}
            options={[
              { label: '单类型', value: 'single' },
              { label: '多字段组合', value: 'multi' }
            ]}
          />
          {mode === 'single' ? (
            <Select value={type} onChange={setType} options={TYPES} style={{ width: 140 }} />
          ) : null}
          <Space size={6}>
            <span className="muted">数量</span>
            <InputNumber min={1} max={100000} value={count} onChange={(v) => setCount(Number(v) || 1)} style={{ width: 100 }} />
          </Space>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={generate}>
            生成
          </Button>
          <Button icon={<CopyOutlined />} onClick={copyAll} disabled={!hasData}>
            {mode === 'multi' ? '复制（TSV）' : '复制全部'}
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => doExport('csv')} disabled={!hasData}>
            导出 CSV
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => doExport('json')} disabled={!hasData}>
            导出 JSON
          </Button>
        </Space>

        {/* 多字段模式的字段表 */}
        {mode === 'multi' ? (
          <>
            <table className="jmx-table" style={{ marginBottom: 6 }}>
              <thead>
                <tr>
                  <th style={{ width: '28%' }}>字段名</th>
                  <th style={{ width: '30%' }}>类型</th>
                  <th>固定值（可选，填了就不随机）</th>
                  <th style={{ width: 32 }} />
                </tr>
              </thead>
              <tbody>
                {fields.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <Input
                        size="small"
                        className="mono"
                        value={f.name}
                        placeholder="userName"
                        onChange={(e) => setField(i, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <Select
                        size="small"
                        value={f.type}
                        onChange={(v) => setField(i, 'type', v)}
                        style={{ width: '100%' }}
                        options={TYPES}
                      />
                    </td>
                    <td>
                      <Input
                        size="small"
                        value={f.fixed}
                        placeholder="（留空 = 随机生成）"
                        onChange={(e) => setField(i, 'fixed', e.target.value)}
                      />
                    </td>
                    <td>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeField(i)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button size="small" type="link" icon={<PlusOutlined />} onClick={addField}>
              添加字段
            </Button>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              一行 = 一条完整记录（比如「姓名 + 手机号 + 邮箱 + 身份证」），导出的 CSV 可直接喂给 pytest / JMeter 的 CSV Data Set。
            </div>
          </>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="muted" style={{ fontSize: 12 }}>
            {mode === 'multi'
              ? multiRows.length
                ? `${multiRows.length} 行 × ${activeFieldNames.length} 列`
                : '点「生成」开始'
              : rows.length
                ? `${rows.length} 条`
                : '点「生成」开始'}
          </span>
        </div>

        {/* 多字段预览：表格 */}
        {mode === 'multi' ? (
          multiRows.length === 0 ? (
            <div className="empty-tip">还没有数据</div>
          ) : (
            <div style={{ maxHeight: 460, overflow: 'auto' }}>
              <table className="jmx-table data-multi-table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>#</th>
                    {activeFieldNames.map((n) => (
                      <th key={n}>{n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {multiRows.slice(0, 500).map((row, i) => (
                    <tr key={i}>
                      <td className="muted mono" style={{ fontSize: 11.5 }}>
                        {i + 1}
                      </td>
                      {row.map((v, j) => (
                        <td key={j} className="mono" style={{ fontSize: 12 }}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {multiRows.length > 500 ? (
                <div className="muted" style={{ padding: '8px 12px', fontSize: 11.5 }}>
                  只显示前 500 行（共 {multiRows.length} 行，导出时是全部）
                </div>
              ) : null}
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="empty-tip">还没有数据</div>
        ) : (
          <div style={{ maxHeight: 460, overflow: 'auto' }}>
            {rows.map((v, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 14px',
                  borderBottom: '1px solid #f5f6fb'
                }}
              >
                <span className="muted mono" style={{ width: 34, fontSize: 11.5 }}>
                  {i + 1}
                </span>
                <span className="mono" style={{ flex: 1 }}>
                  {v}
                </span>
                <Tooltip title="复制">
                  <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copyOne(v)} />
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        <Tag style={{ fontSize: 11 }}>身份证带校验位</Tag>
        <Tag style={{ fontSize: 11 }}>银行卡通过 Luhn 校验</Tag>
        <Tag style={{ fontSize: 11 }}>仅供测试环境使用</Tag>
      </div>
    </div>
  );
}