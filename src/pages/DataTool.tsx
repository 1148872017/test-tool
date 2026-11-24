import React, { useState } from 'react';
import { InputNumber, Button, Select, Space, Tag, Tooltip } from 'antd';
import { CopyOutlined, ThunderboltOutlined, DownloadOutlined } from '@ant-design/icons';
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

export default function DataTool() {
  const [type, setType] = useState('phone');
  const [count, setCount] = useState(5);
  const [rows, setRows] = useState<string[]>([]);

  const generate = () => {
    const def = TYPES.find((t) => t.value === type) || TYPES[0];
    // 上限 10 万（CSV 导出用，太多会卡）
    const n = Math.max(1, Math.min(100000, Number(count) || 1));
    setRows(Array.from({ length: n }, () => def.fn()));
  };

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
    if (!rows.length) return;
    const def = TYPES.find((t) => t.value === type) || TYPES[0];
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
    let content = '';
    let mime = '';
    let ext = '';

    if (format === 'csv') {
      // CSV：表头 + 每行一个值（值里有逗号/引号要转义）
      const esc = (v: string) => {
        const t = String(v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      };
      content = '\uFEFF' + def.label + '\n' + rows.map(esc).join('\n');
      mime = 'text/csv;charset=utf-8';
      ext = 'csv';
    } else {
      content = JSON.stringify(rows, null, 2);
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${def.value}-${rows.length}-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${rows.length} 条 ${ext.toUpperCase()}`);
  };

  const copyAll = async () => {
    if (!rows.length) {
      toast('还没有生成数据', 'warning');
      return;
    }
    await api.copy(rows.join('\n'), false);
    toast(`已复制 ${rows.length} 条`);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">测试数据</div>
          <div className="page-desc">常用测试数据批量生成，本地计算，随机但格式合法</div>
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <Space wrap size={12}>
          <Select value={type} onChange={setType} options={TYPES} style={{ width: 140 }} />
          <Space size={6}>
            <span className="muted">数量</span>
            <InputNumber min={1} max={100000} value={count} onChange={(v) => setCount(Number(v) || 1)} style={{ width: 100 }} />
          </Space>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={generate}>
            生成
          </Button>
          <Button icon={<CopyOutlined />} onClick={copyAll} disabled={!rows.length}>
            复制全部
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => doExport('csv')} disabled={!rows.length}>
            导出 CSV
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => doExport('json')} disabled={!rows.length}>
            导出 JSON
          </Button>
        </Space>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="muted" style={{ fontSize: 12 }}>
            {rows.length ? `${rows.length} 条` : '点「生成」开始'}
          </span>
        </div>
        {rows.length === 0 ? (
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