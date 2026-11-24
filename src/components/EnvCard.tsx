import React, { useEffect, useMemo, useState } from 'react';
import { Button, Select, Input, Tag, Alert, Tooltip, Space } from 'antd';
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
              jdks.length ? (
                <Select
                  size="small"
                  style={{ width: 260 }}
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
              pythons.length ? (
                <Select
                  size="small"
                  style={{ width: 260 }}
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
              <Space size={4}>
                <Input
                  size="small"
                  style={{ width: 200 }}
                  value={settings.mvnPath || ''}
                  placeholder="自动探测"
                  onChange={(e) => saveSettings({ mvnPath: e.target.value })}
                />
                <Button
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={async () => {
                    const res = await api.pickFile({
                      title: '选择 mvn.cmd / mvn',
                      filters: [{ name: 'Maven 可执行文件', extensions: ['cmd', 'bat', 'exe', ''] }]
                    });
                    if (res && res.ok && res.path) saveSettings({ mvnPath: res.path });
                  }}
                >
                  选择…
                </Button>
              </Space>
            }
          />

          {/*
            JMeter：检测 + 手动指定都在这一个地方。
            原来这里只是一行状态、「设置」里还有一张独立的 JMeter 卡片，
            同一件事分散在两处，用户得来回找（踩坑 #101）。
          */}
          <Row
            label="JMeter"
            ok={!!settings.jmeterPath}
            detail={
              settings.jmeterPath ? (
                <span className="mono">{settings.jmeterPath}</span>
              ) : (
                <span className="muted">
                  未配置。点右边「选择…」指定 bin\jmeter.bat（生成 jmx 和跑 Groovy 脚本都要它）
                </span>
              )
            }
            extra={
              <Space size={4}>
                <Button
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={async () => {
                    try {
                      const picked = await api.pickFile({
                        title: '选择 jmeter.bat',
                        filters: [{ name: 'JMeter 启动脚本', extensions: ['bat', 'cmd', 'sh', 'exe', ''] }]
                      });
                      if (picked && picked.ok && picked.path) {
                        saveSettings({ jmeterPath: picked.path });
                        load();
                      }
                    } catch (e: any) {
                      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
                    }
                  }}
                >
                  选择…
                </Button>
              </Space>
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
