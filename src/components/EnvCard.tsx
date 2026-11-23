import React, { useEffect, useMemo, useState } from 'react';
import { Button, Select, Input, Tag, Alert, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  WarningOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';

type Props = {
  /** 保存设置（父组件传下来的） */
  saveSettings: (patch: any) => void;
  /** 当前设置 */
  settings: any;
};

/** 字节 → 人类可读 */
const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

/**
 * 开发环境卡片。
 *
 * 只探测 + 引导，**不下载、不安装**（不碰用户环境）。
 * 用户可以在「手动指定」里覆盖自动探测的结果。
 */
export default function EnvCard({ saveSettings, settings }: Props) {
  const [loading, setLoading] = useState(false);
  const [env, setEnv] = useState<any>(null);
  const [jdks, setJdks] = useState<any[]>([]);
  const [pythons, setPythons] = useState<any[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.runnerList();
      setEnv(res.env || {});
      setJdks(res.jdks || []);
      setPythons(res.pythons || []);
    } catch (e: any) {
      toast('检测环境失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const pw = env && env.playwright;

  /** 一行环境状态 */
  const Row = ({
    label,
    ok,
    detail,
    extra
  }: {
    label: string;
    ok: boolean;
    detail: React.ReactNode;
    extra?: React.ReactNode;
  }) => (
    <div className="env-row">
      <div className="env-row-label">
        {ok ? (
          <CheckCircleOutlined style={{ color: '#2e9e5b' }} />
        ) : (
          <CloseCircleOutlined style={{ color: '#e5534b' }} />
        )}
        <span style={{ marginLeft: 6 }}>{label}</span>
      </div>
      <div className="env-row-detail">{detail}</div>
      {extra ? <div className="env-row-extra">{extra}</div> : null}
    </div>
  );

  return (
    <div className="tool-card" style={{ marginBottom: 14 }}>
      <div className="tool-card-title">
        <WarningOutlined /> 开发环境
        <Tooltip title="重新检测">
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={load}
            style={{ marginLeft: 8 }}
          />
        </Tooltip>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 10 }}
        message="平台只检测，不下载、不安装"
        description="环境请自行安装（JDK / Python / Maven / JMeter）。平台不会修改你的系统环境，卸载时也不会删除它们。"
      />

      {!env ? (
        <div className="muted" style={{ padding: 8 }}>检测中…</div>
      ) : (
        <>
          {/* JDK */}
          <Row
            label="JDK"
            ok={!!env.javaHome}
            detail={
              env.javaHome ? (
                <span className="mono">{env.javaHome}</span>
              ) : (
                <span className="muted">未检测到，请安装 JDK 17+</span>
              )
            }
            extra={
              jdks.length > 1 ? (
                <Select
                  size="small"
                  style={{ width: 220 }}
                  value={settings.javaHome || ''}
                  onChange={(v) => saveSettings({ javaHome: v })}
                  options={[
                    { value: '', label: '自动（按项目 pom.xml 选）' },
                    ...jdks.map((j) => ({ value: j.home, label: `JDK ${j.version} · ${j.home}` }))
                  ]}
                />
              ) : null
            }
          />

          {/* Python */}
          <Row
            label="Python"
            ok={!!env.python}
            detail={
              env.python ? (
                <span className="mono">{env.python}</span>
              ) : (
                <span className="muted">未检测到，请安装 Python 3.10+</span>
              )
            }
            extra={
              pythons.length > 1 ? (
                <Select
                  size="small"
                  style={{ width: 220 }}
                  value={settings.pythonPath || ''}
                  onChange={(v) => saveSettings({ pythonPath: v })}
                  options={[
                    { value: '', label: '自动' },
                    ...pythons.map((p) => ({ value: p.path, label: `Python ${p.version || '?'} · ${p.path}` }))
                  ]}
                />
              ) : null
            }
          />

          {/* Maven */}
          <Row
            label="Maven"
            ok={!!env.mvn}
            detail={
              env.mvn ? (
                <span className="mono">{env.mvn}</span>
              ) : (
                <span className="muted">未检测到，请安装 Maven 3.8+</span>
              )
            }
            extra={
              <Input
                size="small"
                style={{ width: 220 }}
                value={settings.mvnPath || ''}
                placeholder="自动探测（可手动指定）"
                onChange={(e) => saveSettings({ mvnPath: e.target.value })}
              />
            }
          />

          {/* JMeter */}
          <Row
            label="JMeter"
            ok={!!settings.jmeterPath}
            detail={
              settings.jmeterPath ? (
                <span className="mono">{settings.jmeterPath}</span>
              ) : (
                <span className="muted">未配置（在「压测」卡片里配）</span>
              )
            }
          />

          {/* Playwright 浏览器 */}
          <Row
            label="Playwright 浏览器"
            ok={!!(pw && pw.found)}
            detail={
              pw && pw.found ? (
                <span>
                  <span className="mono">{pw.dir}</span>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {pw.browsers.length} 个 · {fmtBytes(pw.totalSize)}
                  </span>
                </span>
              ) : (
                <span className="muted">
                  未下载。Java 和 Python 的 Playwright 共用这个目录
                </span>
              )
            }
            extra={
              pw && pw.dir ? (
                <Button
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={async () => {
                    const res = await api.runnerOpenBrowserDir();
                    if (!res.ok) toast(res.message || '打开失败', 'error');
                  }}
                >
                  打开目录
                </Button>
              ) : null
            }
          />

          {pw && pw.found ? (
            <div className="env-browsers">
              {pw.browsers.map((b: any) => (
                <Tag key={b.name} style={{ marginBottom: 4 }}>
                  {b.name} · {fmtBytes(b.size)}
                </Tag>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
