import React, { useState } from 'react';
import { Input, Button, Space, Select, Tag, InputNumber, Slider, Switch, DatePicker, Segmented } from 'antd';
import { CopyOutlined, SyncOutlined, SwapOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import api from '../api';
import { toast } from '../msg';
import { TIME_UNITS, fmtDuration } from '../utils';

const enc = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
};

const dec = (s: string) => {
  const bin = atob(s.trim());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export default function Toolbox() {
  const [b64In, setB64In] = useState('');
  const [b64Out, setB64Out] = useState('');
  const [urlIn, setUrlIn] = useState('');
  const [urlOut, setUrlOut] = useState('');
  const [hashIn, setHashIn] = useState('');
  const [hashAlgo, setHashAlgo] = useState('md5');
  const [hashOut, setHashOut] = useState('');
  const [tsInput, setTsInput] = useState(String(Date.now()));
  const [tsOut, setTsOut] = useState('');
  const [pwdLen, setPwdLen] = useState(16);
  const [pwdUpper, setPwdUpper] = useState(true);
  const [pwdNum, setPwdNum] = useState(true);
  const [pwdSymbol, setPwdSymbol] = useState(true);
  const [pwd, setPwd] = useState('');

  // 时间计算
  const [calcMode, setCalcMode] = useState<'diff' | 'offset'>('diff');
  const [diffFrom, setDiffFrom] = useState<Dayjs | null>(dayjs());
  const [diffTo, setDiffTo] = useState<Dayjs | null>(dayjs());
  const [baseTime, setBaseTime] = useState<Dayjs | null>(dayjs());
  const [offsetValue, setOffsetValue] = useState<number>(1);
  const [offsetUnit, setOffsetUnit] = useState<string>('day');

  const unitMs = (TIME_UNITS.find((u) => u.value === offsetUnit) || TIME_UNITS[3]).ms;
  const diffMs = diffFrom && diffTo ? diffTo.valueOf() - diffFrom.valueOf() : 0;
  const diffAbs = Math.abs(diffMs);
  const diffMain = diffFrom && diffTo ? `${diffMs < 0 ? '往前 ' : '往后 '}${fmtDuration(diffMs)}` : '';
  const diffTotals = `合计 ${Math.round(diffAbs / 1000)} 秒 · ${(diffAbs / 60000).toFixed(2)} 分钟 · ${(diffAbs / 3600000).toFixed(2)} 小时 · ${(diffAbs / 86400000).toFixed(2)} 天`;

  const offsetMs = (Number(offsetValue) || 0) * unitMs;
  const calcResult = baseTime ? baseTime.add(offsetMs, 'millisecond') : null;
  const resultDelta = calcResult ? calcResult.valueOf() - dayjs().valueOf() : 0;

  const copy = async (text: string, label = '已复制') => {
    if (!text) {
      toast('没有内容', 'warning');
      return;
    }
    await api.copy(text, false);
    toast(label);
  };

  const runHash = async () => {
    if (!hashIn) {
      toast('先输入内容', 'warning');
      return;
    }
    const out = await api.hash(hashAlgo, hashIn);
    setHashOut(out);
  };

  const tsConvert = () => {
    const raw = tsInput.trim();
    if (!raw) return;
    if (/^\d+$/.test(raw)) {
      let n = Number(raw);
      if (raw.length <= 10) n *= 1000;
      const d = new Date(n);
      if (isNaN(d.getTime())) {
        setTsOut('无法识别');
        return;
      }
      setTsOut(`${d.toLocaleString('zh-CN')}  |  ISO: ${d.toISOString()}`);
    } else {
      const d = new Date(raw.replace(' ', 'T'));
      if (isNaN(d.getTime())) {
        setTsOut('无法识别，可以试试 「2026-10-28 19:30:00」 或 「1761652200」');
        return;
      }
      setTsOut(`秒: ${Math.floor(d.getTime() / 1000)}  |  毫秒: ${d.getTime()}`);
    }
  };

  const genPwd = () => {
    let pool = 'abcdefghijkmnpqrstuvwxyz';
    if (pwdUpper) pool += 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    if (pwdNum) pool += '23456789';
    if (pwdSymbol) pool += '!@#$%^&*_-+=?';
    const n = Math.max(6, Math.min(64, pwdLen));
    let out = '';
    for (let i = 0; i < n; i++) out += pool[Math.floor(Math.random() * pool.length)];
    setPwd(out);
  };

  const genUuid = () => {
    const list = Array.from({ length: 5 }, () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          })
    );
    setPwd(list.join('\n'));
    toast('已生成 5 个 UUID');
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">工具箱</div>
          <div className="page-desc">日常零碎转换，全部本地完成</div>
        </div>
      </div>

      <div className="tool-grid">
        <div className="tool-card wide">
          <div className="tool-card-title">时间计算</div>
          <Segmented
            size="small"
            value={calcMode}
            onChange={(v) => setCalcMode(v as 'diff' | 'offset')}
            options={[
              { label: '两个时间差', value: 'diff' },
              { label: '往后 / 往前推', value: 'offset' }
            ]}
          />

          {calcMode === 'diff' ? (
            <>
              <div className="calc-row">
                <DatePicker
                  showTime
                  allowClear={false}
                  value={diffFrom}
                  onChange={(v) => setDiffFrom(v)}
                  format="YYYY-MM-DD HH:mm:ss"
                  style={{ width: 198 }}
                />
                <Button
                  size="small"
                  icon={<SwapOutlined />}
                  title="交换"
                  onClick={() => {
                    setDiffFrom(diffTo);
                    setDiffTo(diffFrom);
                  }}
                />
                <DatePicker
                  showTime
                  allowClear={false}
                  value={diffTo}
                  onChange={(v) => setDiffTo(v)}
                  format="YYYY-MM-DD HH:mm:ss"
                  style={{ width: 198 }}
                />
                <Button
                  size="small"
                  onClick={() => {
                    const n = dayjs();
                    setDiffFrom(n);
                    setDiffTo(n);
                  }}
                >
                  都设为现在
                </Button>
              </div>
              <div className="calc-result">
                <div className="calc-big">{diffMain}</div>
                <div className="muted mono" style={{ marginTop: 4 }}>
                  {diffTotals}
                </div>
                <Space style={{ marginTop: 8 }}>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(fmtDuration(diffMs))}>
                    复制时长
                  </Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(String(Math.round(diffAbs / 1000)))}>
                    复制相差秒数
                  </Button>
                </Space>
              </div>
            </>
          ) : (
            <>
              <div className="calc-row">
                <DatePicker
                  showTime
                  allowClear={false}
                  value={baseTime}
                  onChange={(v) => setBaseTime(v)}
                  format="YYYY-MM-DD HH:mm:ss"
                  style={{ width: 198 }}
                />
                <InputNumber
                  value={offsetValue}
                  onChange={(v) => setOffsetValue(Number(v) || 0)}
                  style={{ width: 110 }}
                  placeholder="负数=往前"
                />
                <Select
                  value={offsetUnit}
                  onChange={setOffsetUnit}
                  style={{ width: 88 }}
                  options={TIME_UNITS.map((u) => ({ value: u.value, label: u.label }))}
                />
                <Button size="small" onClick={() => setBaseTime(dayjs())}>
                  基准设为现在
                </Button>
              </div>
              <Space wrap style={{ marginBottom: 10 }}>
                {[
                  { label: '+1 小时', v: 1, u: 'hour' },
                  { label: '-1 小时', v: -1, u: 'hour' },
                  { label: '+1 天', v: 1, u: 'day' },
                  { label: '+7 天', v: 7, u: 'day' },
                  { label: '-1 天', v: -1, u: 'day' },
                  { label: '+30 分', v: 30, u: 'minute' }
                ].map((p) => (
                  <Button
                    key={p.label}
                    size="small"
                    onClick={() => {
                      setOffsetValue(p.v);
                      setOffsetUnit(p.u);
                    }}
                  >
                    {p.label}
                  </Button>
                ))}
              </Space>
              <div className="calc-result">
                <div className="calc-big">{calcResult ? calcResult.format('YYYY-MM-DD HH:mm:ss dddd') : '-'}</div>
                <div className="muted mono" style={{ marginTop: 4 }}>
                  {calcResult
                    ? `秒 ${calcResult.unix()} · 毫秒 ${calcResult.valueOf()} · ${
                        resultDelta >= 0 ? '还有 ' : '已过去 '
                      }${fmtDuration(resultDelta)}`
                    : ''}
                </div>
                <Space wrap style={{ marginTop: 8 }}>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(calcResult ? calcResult.format('YYYY-MM-DD HH:mm:ss') : '')}>
                    复制时间
                  </Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(calcResult ? String(calcResult.unix()) : '')}>
                    复制秒级戳
                  </Button>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(calcResult ? String(calcResult.valueOf()) : '')}>
                    复制毫秒戳
                  </Button>
                </Space>
              </div>
            </>
          )}
        </div>

        <div className="tool-card">
          <div className="tool-card-title">Base64</div>
          <Input.TextArea
            className="code-area"
            value={b64In}
            onChange={(e) => setB64In(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 6 }}
            placeholder="输入原文或 Base64"
          />
          <Space style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => setB64Out(enc(b64In))}>
              编码
            </Button>
            <Button
              size="small"
              onClick={() => {
                try {
                  setB64Out(dec(b64In));
                } catch (e) {
                  toast('不是合法的 Base64', 'error');
                }
              }}
            >
              解码
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(b64Out)}>
              复制结果
            </Button>
          </Space>
          <Input.TextArea
            className="code-area"
            value={b64Out}
            readOnly
            style={{ marginTop: 8 }}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="结果"
          />
        </div>

        <div className="tool-card">
          <div className="tool-card-title">URL 编解码</div>
          <Input.TextArea
            className="code-area"
            value={urlIn}
            onChange={(e) => setUrlIn(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 6 }}
            placeholder="输入 URL 或参数串"
          />
          <Space style={{ marginTop: 8 }}>
            <Button size="small" onClick={() => setUrlOut(encodeURIComponent(urlIn))}>
              编码
            </Button>
            <Button
              size="small"
              onClick={() => {
                try {
                  setUrlOut(decodeURIComponent(urlIn));
                } catch (e) {
                  toast('不是合法的 URL 编码', 'error');
                }
              }}
            >
              解码
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(urlOut)}>
              复制结果
            </Button>
          </Space>
          <Input.TextArea
            className="code-area"
            value={urlOut}
            readOnly
            style={{ marginTop: 8 }}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="结果"
          />
        </div>

        <div className="tool-card">
          <div className="tool-card-title">哈希</div>
          <Space style={{ marginBottom: 8 }}>
            <Select
              value={hashAlgo}
              onChange={setHashAlgo}
              style={{ width: 110 }}
              options={[
                { value: 'md5', label: 'MD5' },
                { value: 'sha1', label: 'SHA-1' },
                { value: 'sha256', label: 'SHA-256' }
              ]}
            />
            <Button size="small" type="primary" onClick={runHash}>
              计算
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(hashOut)}>
              复制
            </Button>
          </Space>
          <Input.TextArea
            className="code-area"
            value={hashIn}
            onChange={(e) => setHashIn(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 5 }}
            placeholder="要计算哈希的文本"
          />
          <Input value={hashOut} readOnly style={{ marginTop: 8 }} placeholder="哈希值" />
        </div>

        <div className="tool-card">
          <div className="tool-card-title">时间戳</div>
          <Input
            value={tsInput}
            onChange={(e) => setTsInput(e.target.value)}
            placeholder="时间戳或日期，如 2026-10-28 19:30:00"
            suffix={
              <Button type="text" size="small" icon={<SyncOutlined />} onClick={() => setTsInput(String(Date.now()))} />
            }
          />
          <Space style={{ marginTop: 8 }}>
            <Button size="small" type="primary" onClick={tsConvert}>
              转换
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(tsOut)}>
              复制
            </Button>
          </Space>
          <div className="mono" style={{ marginTop: 10, minHeight: 20, color: '#4a5165' }}>
            {tsOut || '支持 「1761652200」「2026-10-28 19:30:00」'}
          </div>
        </div>

        <div className="tool-card">
          <div className="tool-card-title">随机密码 / UUID</div>
          <Space wrap style={{ marginBottom: 10 }}>
            <span className="muted">长度</span>
            <InputNumber min={6} max={64} value={pwdLen} onChange={(v) => setPwdLen(Number(v) || 16)} style={{ width: 70 }} />
            <span className="muted">大写</span>
            <Switch size="small" checked={pwdUpper} onChange={setPwdUpper} />
            <span className="muted">数字</span>
            <Switch size="small" checked={pwdNum} onChange={setPwdNum} />
            <span className="muted">符号</span>
            <Switch size="small" checked={pwdSymbol} onChange={setPwdSymbol} />
          </Space>
          <Space style={{ marginBottom: 10 }}>
            <Button size="small" type="primary" onClick={genPwd}>
              生成密码
            </Button>
            <Button size="small" onClick={genUuid}>
              生成 5 个 UUID
            </Button>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(pwd)}>
              复制
            </Button>
          </Space>
          <Input.TextArea
            className="code-area"
            value={pwd}
            readOnly
            autoSize={{ minRows: 2, maxRows: 7 }}
            placeholder="结果"
          />
        </div>

        <div className="tool-card">
          <div className="tool-card-title">说明</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            <div>· 所有换算都在本机完成，不走网络。</div>
            <div>· 哈希在 Electron 主进程用 Node crypto 计算，支持 MD5 / SHA-1 / SHA-256。</div>
            <div>· 随机密码默认 16 位，已排除易混淆字符（0/O、1/l/I）。</div>
            <div style={{ marginTop: 8 }}>
              <Tag style={{ fontSize: 11 }}>本地</Tag>
              <Tag style={{ fontSize: 11 }}>离线可用</Tag>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}