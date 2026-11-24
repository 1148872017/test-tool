import React, { useMemo, useState } from 'react';
import { InputNumber, Input, Button, Select, Space, Tag, Tooltip, Segmented, Modal, Alert } from 'antd';
import {
  CopyOutlined,
  ThunderboltOutlined,
  DownloadOutlined,
  PlusOutlined,
  DeleteOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import StateEmpty from '../components/states/StateEmpty';
import { useHotkeys } from '../hooks/useHotkeys';

// 生成逻辑抽到 shared/faker.js，前后端共用（大数量在 Node 侧生成写文件）
import { TYPES, TYPE_MAP, genOne, genDate, toCsv, toJson } from '../../shared/faker';


/** 多字段组合里的一个字段 */
type Field = {
  /** 行键：删中间一行时不能让后面整排错位（不能用数组下标当 key） */
  id: number;
  name: string;
  type: string;
  /** 固定值（填了就不用随机生成） */
  fixed: string;
};

/** 字段行自增 id（只在前端用于 React key，不发给主进程） */
let fieldSeq = 0;
const makeField = (patch?: Partial<Omit<Field, 'id'>>): Field =>
  Object.assign({ id: ++fieldSeq, name: '', type: 'name', fixed: '' }, patch || {});

/** 默认字段组合（开箱即用的「用户表」样例） */
const DEFAULT_FIELDS: Field[] = [
  makeField({ name: 'userName', type: 'name' }),
  makeField({ name: 'mobile', type: 'phone' }),
  makeField({ name: 'email', type: 'email' }),
  makeField({ name: 'idCard', type: 'idcard' })
];

/**
 * 只把协议需要的三列送给主进程：id 是前端行键，别塞进 IPC 载荷。
 * （shared/faker 只读 name / type / fixed，多传也不会坏，但没必要）
 */
const toPayloadFields = (list: Field[]) =>
  list.filter((f) => f.name.trim()).map((f) => ({ name: f.name, type: f.type, fixed: f.fixed }));

/**
 * 造数预览行的 key。
 *
 * 生成结果没有业务主键，纯下标当 key 在「重新生成 / 行内容变了」时会让
 * React 复用旧节点；这里用「内容 + 位置」：内容变了就换 key，重复内容靠位置去重。
 */
const previewKey = (content: string, index: number) => index + ':' + content;

/**
 * 「大数量」分界线 + 预览条数。
 *
 * 用户要求：超过 200 条就**不再全量展示**，但也不是啥都不显示——
 * 展示前 200 条让人确认「格式对不对」，剩下的一次性写成文件。
 *
 * 为什么 200：
 *   一屏 20 行，200 行 = 10 屏，足够看清数据长什么样；
 *   再多就是给程序吃的（CSV Data Set / parametrize），不需要肉眼看。
 */
const LARGE_THRESHOLD = 200;
/** 大数量时最多展示多少条 */
const PREVIEW_ROWS = 200;

export default function DataTool() {
  // 单类型模式
  const [type, setType] = useState('phone');
  const [rows, setRows] = useState<string[]>([]);

  // 多字段模式
  const [mode, setMode] = useState<'single' | 'multi'>('single');
  const [fields, setFields] = useState<Field[]>(DEFAULT_FIELDS);
  const [multiRows, setMultiRows] = useState<string[][]>([]);

  const [count, setCount] = useState(5);
  /** 最近一次「大数量导出」的结果 */
  const [lastExport, setLastExport] = useState<{ file: string; count: number; bytes: number } | null>(null);
  const [busyFile, setBusyFile] = useState(false);
  /** 日期范围（只在「日期」类型时用） */
  const [dateFrom, setDateFrom] = useState('2020-01-01');
  const [dateTo, setDateTo] = useState('2026-12-31');

  /** 上限 10 万（CSV 导出用，太多会卡） */
  const normalizeCount = () => Math.max(1, Math.min(100000, Number(count) || 1));

  /**
   * 大数量：不塞进页面，直接生成文件到工作区。
   *
   * 没配工作区就拦下来，引导去设置（不静默失败）。
   */
  const generateToFile = async (n: number) => {
    const payload: any = {
      mode,
      type,
      fields: toPayloadFields(fields),
      count: n,
      format: 'csv',
      from: dateFrom,
      to: dateTo
    };

    setBusyFile(true);
    try {
      const res = await api.dataGenFile(payload);
      if (res && res.needWorkspace) {
        Modal.warning({
          title: '还没配工作区目录',
          content: (
            <div style={{ lineHeight: 1.8 }}>
              <div>
                生成 <b>{n.toLocaleString()}</b> 条数据不会显示在页面上，而是直接写成文件。
              </div>
              <div>文件要放在「工作区」目录下，但你还没配。</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                去 <b>设置 → 目录配置 → 工作区目录</b> 配一个就行（配了之后下面 7 个子目录也会自动推导）。
              </div>
            </div>
          ),
          okText: '知道了'
        });
        return;
      }
      if (!res || !res.ok) {
        toast((res && res.message) || '生成失败', 'error');
        return;
      }
      setLastExport({ file: res.file, count: res.count, bytes: res.bytes });
      setRows([]);
      setMultiRows([]);
      toast(`已生成 ${res.count.toLocaleString()} 条 → ${res.file}`);
    } catch (e: any) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusyFile(false);
    }
  };

  const generate = async () => {
    const n = normalizeCount();

    /**
     * 大数量：**展示前 200 条 + 同时导出全量文件**。
     *
     * 之前是「完全不展示，只出文件」——用户反馈看不到数据长什么样不放心。
     * 现在折中：页面给预览（能确认格式），完整数据落文件。
     */
    if (n > LARGE_THRESHOLD) {
      const previewCount = PREVIEW_ROWS;

      if (mode === 'single') {
        const def = TYPES.find((t) => t.value === type) || TYPES[0];
        // 传行号：边界值是有序循环，不能每条都从第 0 个开始
        const gen = (index: number) => (def.value === 'date' ? genDate(dateFrom, dateTo) : def.fn(index));
        setRows(Array.from({ length: previewCount }, (_, i) => gen(i)));
      } else {
        const valid = toPayloadFields(fields);
        const resolved = valid.map((f) => {
          const t = TYPES.find((x) => x.value === f.type) || TYPES[0];
          return { fixed: f.fixed, fn: t.value === 'date' ? () => genDate(dateFrom, dateTo) : t.fn };
        });
        setMultiRows(
          Array.from({ length: previewCount }, (_, i) =>
            resolved.map((r) => (r.fixed ? r.fixed : r.fn(i)))
          )
        );
      }

      await generateToFile(n);
      return;
    }

    setLastExport(null);

    if (mode === 'single') {
      const def = TYPES.find((t) => t.value === type) || TYPES[0];
      // 日期类型用自定义范围；其他类型传 undefined，忽略
      // 行号一路传下去：边界值按行取池子里的下一个
      const gen = (index: number) => (def.value === 'date' ? genDate(dateFrom, dateTo) : def.fn(index));
      setRows(Array.from({ length: n }, (_, i) => gen(i)));
      return;
    }

    // 多字段：每行按字段列表逐个生成
    const valid = toPayloadFields(fields);
    if (!valid.length) {
      toast('至少填一个字段名', 'warning');
      return;
    }
    const resolved = valid.map((f) => {
      const t = TYPES.find((x) => x.value === f.type) || TYPES[0];
      return {
        fixed: f.fixed,
        // 日期字段也走自定义范围
        fn: t.value === 'date' ? () => genDate(dateFrom, dateTo) : t.fn
      };
    });
    setMultiRows(
      Array.from({ length: n }, (_, i) => resolved.map((r) => (r.fixed ? r.fixed : r.fn(i))))
    );
  };

  /* ---------- 字段增删改 ---------- */
  // 增删都按 id 走：删中间一行后，剩下每行的 id 不变，React 不会错位复用输入框
  const addField = () => setFields((prev) => prev.concat([makeField()]));
  const removeField = (id: number) => setFields((prev) => prev.filter((f) => f.id !== id));
  const setField = (id: number, key: 'name' | 'type' | 'fixed', v: string) => {
    setFields((prev) => prev.map((f) => (f.id === id ? Object.assign({}, f, { [key]: v }) : f)));
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

  /* ---------- 快捷键 ---------- */
  /**
   * Ctrl+Enter 生成（和代码调试页一致）。挂在 window 上，
   * 焦点在数量框 / 字段输入框里也能直接按，不用先去点按钮。
   */
  useHotkeys({
    'Ctrl+Enter': () => {
      if (busyFile) return;
      void generate();
    }
  });

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
            /*
             * 14 个类型必须一次全给出来：rc-select 默认虚拟滚动
             * （listHeight 200 / listItemHeight 20 = 刚好 10 行），
             * 第 11~14 项要滚才能看到，用户会怀疑「是不是缺功能」。
             * 14 项虚拟化没有任何性能收益，直接关掉。
             */
            <Select
              value={type}
              onChange={setType}
              options={TYPES}
              virtual={false}
              style={{ width: 140 }}
            />
          ) : null}

          {/* 日期类型：可以指定范围（规划要求「指定范围的时间戳」） */}
          {type === 'date' ? (
            <Space size={4}>
              <span className="muted">从</span>
              <Input
                size="small"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                style={{ width: 140 }}
              />
              <span className="muted">到</span>
              <Input
                size="small"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                style={{ width: 140 }}
              />
            </Space>
          ) : null}
          <Space size={6}>
            <span className="muted">数量</span>
            <InputNumber
              min={1}
              max={1000000}
              value={count}
              onChange={(v) => setCount(Number(v) || 1)}
              style={{ width: 110 }}
            />
            {count > LARGE_THRESHOLD ? (
              <Tooltip
                title={
                  <div style={{ lineHeight: 1.7 }}>
                    超过 {LARGE_THRESHOLD.toLocaleString()} 条时不显示在页面上（会卡），
                    直接写成 CSV 文件放到「工作区」目录。
                  </div>
                }
              >
                <Tag color="orange" style={{ fontSize: 11 }}>
                  走文件
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={generate}
            loading={busyFile}
          >
            {count > LARGE_THRESHOLD ? `生成并导出（${count.toLocaleString()} 条）` : '生成'}
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
                {fields.map((f) => (
                  // key 用行 id：删中间一行时后面的输入框不会被错位复用
                  <tr key={f.id}>
                    <td>
                      <Input
                        size="small"
                        className="mono"
                        value={f.name}
                        placeholder="userName"
                        onChange={(e) => setField(f.id, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <Select
                        size="small"
                        value={f.type}
                        onChange={(v) => setField(f.id, 'type', v)}
                        style={{ width: '100%' }}
                        options={TYPES}
                        virtual={false}
                      />
                    </td>
                    <td>
                      <Input
                        size="small"
                        value={f.fixed}
                        placeholder="（留空 = 随机生成）"
                        onChange={(e) => setField(f.id, 'fixed', e.target.value)}
                      />
                    </td>
                    <td>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeField(f.id)}
                        aria-label={'删除字段 ' + (f.name.trim() || '未命名字段')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Button size="small" type="link" icon={<PlusOutlined />} onClick={addField}>
              添加字段
            </Button>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              一行 = 一条完整记录（比如「姓名 + 手机号 + 邮箱 + 身份证」），导出的 CSV 可直接喂给 pytest / JMeter 的 CSV Data Set。
            </div>
          </>
        ) : null}
      </div>

      {/* 大数量导出的结果 */}
      {lastExport ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={`已生成 ${lastExport.count.toLocaleString()} 条（页面只展示前 ${PREVIEW_ROWS} 条），完整文件：`}
          description={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div className="mono" style={{ wordBreak: 'break-all' }}>
                {lastExport.file}
              </div>
              <div className="muted">
                大小 {(lastExport.bytes / 1024).toFixed(1)} KB · 用 Excel 或 CSV Data Set 直接打开
              </div>
              <Space size={8} style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      await api.dataOpenWorkspace('');
                    } catch (e) {
                      /* ignore */
                    }
                  }}
                >
                  打开工作区
                </Button>
                <Button
                  size="small"
                  onClick={async () => {
                    await api.copy(lastExport.file, false);
                    toast('路径已复制');
                  }}
                >
                  复制路径
                </Button>
              </Space>
            </div>
          }
          closable
          onClose={() => setLastExport(null)}
        />
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <span className="muted" style={{ fontSize: 12 }}>
            {mode === 'multi'
              ? multiRows.length
                ? lastExport
                  ? `前 ${multiRows.length} 行预览（共 ${lastExport.count.toLocaleString()} 行，完整版见导出文件）`
                  : `${multiRows.length} 行 × ${activeFieldNames.length} 列`
                : '点「生成」开始'
              : rows.length
                ? lastExport
                  ? `前 ${rows.length} 条预览（共 ${lastExport.count.toLocaleString()} 条，完整版见导出文件）`
                  : `${rows.length} 条`
                : '点「生成」开始'}
          </span>
        </div>

        {/* 多字段预览：表格 */}
        {mode === 'multi' ? (
          multiRows.length === 0 ? (
            <StateEmpty
              kind="no-data"
              object="数据"
              desc="填好字段和数量，点「生成」；多字段一行 = 一条完整记录"
              action={{ label: '生成数据', onClick: generate }}
            />
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
                    // 预览行没有主键：用「行内容 + 位置」，重新生成时内容变了就换 key
                    <tr key={previewKey(row.join('\u0001'), i)}>
                      <td className="muted mono" style={{ fontSize: 12 }}>
                        {i + 1}
                      </td>
                      {row.map((v, j) => (
                        // 列 key 用字段名（字段顺序会随编辑变化），没有名字时退回下标
                        <td key={activeFieldNames[j] || j} className="mono" style={{ fontSize: 12 }}>
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {multiRows.length > 500 ? (
                <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
                  只显示前 500 行（共 {multiRows.length} 行，导出时是全部）
                </div>
              ) : null}
            </div>
          )
        ) : rows.length === 0 ? (
          <StateEmpty
            kind="no-data"
            object="数据"
            desc="选好类型和数量，点「生成」；生成的记录只在本机计算，不上传"
            action={{ label: '生成数据', onClick: generate }}
          />
        ) : (
          <div style={{ maxHeight: 460, overflow: 'auto' }}>
            {rows.map((v, i) => (
              <div
                key={previewKey(v, i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '7px 14px',
                  borderBottom: '1px solid #f5f6fb'
                }}
              >
                <span className="muted mono" style={{ width: 34, fontSize: 12 }}>
                  {i + 1}
                </span>
                <span className="mono" style={{ flex: 1 }}>
                  {v}
                </span>
                <Tooltip title="复制">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => copyOne(v)}
                    aria-label={'复制第 ' + (i + 1) + ' 条'}
                  />
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