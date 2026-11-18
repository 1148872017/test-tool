import React, { useEffect, useState } from 'react';
import { Button, Select, Input, Modal, Tag, Popconfirm, Space, Alert, Switch } from 'antd';
import {
  LockOutlined,
  FolderOpenOutlined,
  DownloadOutlined,
  UploadOutlined,
  SaveOutlined,
  KeyOutlined,
  DeleteOutlined,
  TagOutlined,
  HistoryOutlined,
  DatabaseOutlined,
  DashboardOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  BookOutlined,
  FileTextOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { fmtTime } from '../utils';
import OptionEditor from '../components/OptionEditor';

type Props = {
  boot: any;
  onChanged: () => void;
};

export default function SettingsPage({ boot, onChanged }: Props) {
  const [info, setInfo] = useState<any>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [pinOpen, setPinOpen] = useState(false);
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [casesDir, setCasesDir] = useState('');
  const [jmxDir, setJmxDir] = useState('');
  const [jmeterPath, setJmeterPath] = useState('');
  const [jmeterVersion, setJmeterVersion] = useState('');
  const [reportDir, setReportDir] = useState('');
  const [kbDir, setKbDir] = useState('');
  const [notesDir, setNotesDir] = useState('');
  const [clearTarget, setClearTarget] = useState<string | undefined>(undefined);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearCountdown, setClearCountdown] = useState(0);
  const [clearBusy, setClearBusy] = useState(false);
  // 选中的 .db 待确认恢复（整库覆盖是破坏性操作）
  const [dbConfirm, setDbConfirm] = useState<any>(null);
  const [restoring, setRestoring] = useState('');

  const settings = boot.settings || {};

  useEffect(() => {
    setCasesDir(settings.casesDir || '');
    setJmxDir(settings.jmxDir || '');
    setJmeterPath(settings.jmeterPath || '');
    setReportDir(settings.reportDir || '');
    setKbDir(settings.kbDir || '');
    setNotesDir(settings.notesDir || '');
  }, [settings.casesDir, settings.jmxDir, settings.jmeterPath, settings.reportDir, settings.kbDir, settings.notesDir]);

  const doPickNotesDir = async () => {
    try {
      const res = await api.notesPickDir();
      if (res && res.ok) {
        setNotesDir(res.dir || '');
        toast('笔记目录已更新');
        onChanged();
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doPickKbDir = async () => {
    try {
      const res = await api.kbPickDir();
      if (res && res.ok) {
        setKbDir(res.dir || '');
        toast('知识库目录已更新');
        onChanged();
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doPickReportDir = async () => {
    try {
      const res = await api.reportPickDir();
      if (res && res.ok) {
        setReportDir(res.dir || '');
        toast('压测报告目录已更新');
        onChanged();
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doPickJmxDir = async () => {
    try {
      const res = await api.jmxPickDir();
      if (res && res.ok) {
        setJmxDir(res.dir || '');
        toast('压测脚本目录已更新');
        onChanged();
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doPickJmeter = async () => {
    try {
      const res = await api.jmxPickJmeter();
      if (res && res.ok) {
        setJmeterPath(res.path || '');
        setJmeterVersion(res.version || '');
        toast(res.version ? `已找到 JMeter ${res.version}` : '已设置路径');
        onChanged();
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  // 确认按钮 3 秒后才能点：破坏性操作不做「点一下就到手」
  useEffect(() => {
    if (!clearOpen) {
      setClearCountdown(0);
      return;
    }
    setClearCountdown(3);
    const timer = setInterval(() => setClearCountdown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [clearOpen]);

  const doPickCasesDir = async () => {
    try {
      const res = await api.casePickDir();
      if (res && res.ok) {
        setCasesDir(res.dir || '');
        toast('用例目录已更新');
        onChanged();
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const refreshInfo = () => {
    api.info().then(setInfo).catch(() => {});
    api.backups().then(setBackups).catch(() => {});
  };

  useEffect(() => {
    refreshInfo();
  }, []);

  const saveSettings = async (patch: any) => {
    try {
      await api.saveSettings(patch);
      toast('已保存');
      onChanged();
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doSetPin = async () => {
    if (newPin.length < 4) {
      toast('密码至少 4 位', 'error');
      return;
    }
    setPinBusy(true);
    const res = await api.setPin(oldPin, newPin);
    setPinBusy(false);
    if (res && res.ok) {
      toast('密码已设置');
      setPinOpen(false);
      setOldPin('');
      setNewPin('');
      onChanged();
    } else {
      toast((res && res.message) || '设置失败', 'error');
    }
  };

  const doClearPin = async () => {
    const res = await api.clearPin(oldPin);
    if (res && res.ok) {
      toast('已移除密码');
      setOldPin('');
      onChanged();
    } else {
      toast((res && res.message) || '移除失败', 'error');
    }
  };

  const doBackup = async () => {
    const res = await api.backupNow();
    if (res && res.file) {
      toast('已备份：' + res.file.split(/[\\/]/).pop());
      refreshInfo();
    } else {
      toast('备份失败', 'error');
    }
  };

  const doExport = async (includeSecrets: boolean) => {
    try {
      const res = await api.exportData(includeSecrets);
      if (res && res.ok) toast(`已导出 ${res.count} 条`);
      else if (res && res.message) toast(res.message, 'error');
    } catch (e: any) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doImport = async () => {
    try {
      const res = await api.importData();
      if (res && res.ok) {
        const extra = res.links ? `，关联 ${res.links} 条` : '';
        toast(`导入 ${res.imported} 条${res.skipped ? `，跳过 ${res.skipped} 条` : ''}${extra}`);
        onChanged();
      } else if (res && res.needConfirm) {
        // 选的是 .db：整库覆盖，先让用户确认
        setDbConfirm(res);
      } else if (res && res.message) {
        toast(res.message, 'error');
      }
    } catch (e: any) {
      toast('导入失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doRestore = async (file: string) => {
    setRestoring(file);
    try {
      const res = await api.restoreBackup(file);
      if (res && res.ok) {
        toast(`已恢复整库（${res.recordCount} 条记录）`);
        setDbConfirm(null);
        refreshInfo();
        onChanged();
      } else {
        toast((res && res.message) || '恢复失败', 'error');
      }
    } catch (e: any) {
      toast('恢复失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setRestoring('');
    }
  };

  const doExportDb = async () => {
    try {
      const res = await api.exportDb();
      if (res && res.ok) toast(`已导出整库 ${(res.bytes / 1024).toFixed(1)} KB`);
      else if (res && res.message) toast(res.message, 'error');
    } catch (e: any) {
      toast('导出失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const backupBytes = backups.reduce((sum, b) => sum + (Number(b.size) || 0), 0);

  const doClearData = async () => {
    if (!clearTarget || clearCountdown > 0 || clearBusy) return;
    const target = clearTarget;
    setClearBusy(true);
    try {
      const res = await api.clearData(target);
      if (res && res.ok) {
        if (target === 'backups') {
          toast(res.removed ? `已清除 ${res.removed} 个备份文件` : '没有可清除的备份文件');
        } else {
          const files = Array.isArray(res.removed) && res.removed.length ? res.removed.join('、') : 'data.db';
          toast(`已重置本地数据（删除 ${files}）`);
        }
        setClearOpen(false);
        setClearTarget(undefined);
        refreshInfo();
        if (target === 'local') onChanged();
      } else {
        toast((res && res.message) || '清除失败', 'error');
      }
    } catch (e: any) {
      toast('清除失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-desc">安全、数据与备份</div>
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <FolderOpenOutlined /> 测试用例
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
          <div style={{ width: 120 }} className="muted">
            用例目录
          </div>
          <Input
            style={{ flex: 1, maxWidth: 560 }}
            value={casesDir}
            placeholder="例如 D:\你的目录\test_cases"
            onChange={(e) => setCasesDir(e.target.value)}
            onBlur={() => {
              if (casesDir !== (settings.casesDir || '')) saveSettings({ casesDir });
            }}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickCasesDir}>
            选择…
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, paddingLeft: 134 }}>
          只读索引：只扫描这个目录下的 markdown，不会修改任何文件
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <DashboardOutlined /> 压测（JMeter）
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
          <div style={{ width: 120 }} className="muted">
            jmx 目录
          </div>
          <Input
            style={{ flex: 1, maxWidth: 560 }}
            value={jmxDir}
            placeholder="例如 D:\你的目录\jmx"
            onChange={(e) => setJmxDir(e.target.value)}
            onBlur={() => {
              if (jmxDir !== (settings.jmxDir || '')) saveSettings({ jmxDir });
            }}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickJmxDir}>
            选择…
          </Button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            JMeter 路径
          </div>
          <Input
            style={{ flex: 1, maxWidth: 560 }}
            value={jmeterPath}
            placeholder="留空自动探测（支持 JMETER_HOME 环境变量）"
            onChange={(e) => setJmeterPath(e.target.value)}
            onBlur={() => {
              if (jmeterPath !== (settings.jmeterPath || '')) saveSettings({ jmeterPath });
            }}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickJmeter}>
            选择…
          </Button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            压测报告目录
          </div>
          <Input
            style={{ flex: 1, maxWidth: 560 }}
            value={reportDir}
            placeholder="例如 D:\你的目录\jmx\压测结果"
            onChange={(e) => setReportDir(e.target.value)}
            onBlur={() => {
              if (reportDir !== (settings.reportDir || '')) saveSettings({ reportDir });
            }}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickReportDir}>
            选择…
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, paddingLeft: 134 }}>
          「测试执行 → 导入压测报告」默认扫这个目录；每个子目录算一次跑批（含 result.jtl 或 html-report）
        </div>
        <div style={{ paddingLeft: 134, fontSize: 12, marginTop: 4 }}>
          {jmeterPath ? (
            <span style={{ color: '#3fbf7f' }}>
              <CheckCircleOutlined /> 已配置
              {jmeterVersion ? ` · JMeter ${jmeterVersion}` : ''}
            </span>
          ) : (
            <span style={{ color: '#f5a623' }}>
              <WarningOutlined /> 未找到 JMeter —— 点「选择…」指定 bin\jmeter.bat，否则「启动 JMeter」按钮不可用
            </span>
          )}
        </div>
        <div className="muted" style={{ fontSize: 12, paddingLeft: 134, marginTop: 2 }}>
          只读索引 jmx，不修改文件；配好路径后可在列表里一键用 JMeter GUI 打开脚本
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <BookOutlined /> 知识库
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
          <div style={{ width: 120 }} className="muted">
            知识库目录
          </div>
          <Input
            style={{ flex: 1, maxWidth: 560 }}
            value={kbDir}
            placeholder="例如 D:\你的目录\知识库"
            onChange={(e) => setKbDir(e.target.value)}
            onBlur={() => {
              if (kbDir !== (settings.kbDir || '')) saveSettings({ kbDir });
            }}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickKbDir}>
            选择…
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, paddingLeft: 134 }}>
          只读索引 markdown（业务规则沉淀等），自动跳过 _archive / _review 归档目录
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <FileTextOutlined /> 测试笔记
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
          <div style={{ width: 120 }} className="muted">
            笔记目录
          </div>
          <Input
            style={{ flex: 1, maxWidth: 560 }}
            value={notesDir}
            placeholder="例如 D:\你的目录\notes"
            onChange={(e) => setNotesDir(e.target.value)}
            onBlur={() => {
              if (notesDir !== (settings.notesDir || '')) saveSettings({ notesDir });
            }}
          />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickNotesDir}>
            选择…
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, paddingLeft: 134 }}>
          只读索引 markdown 笔记；用 Typora 等专业编辑器改，平台只读。「导入 md」会把外部文件移动到这里
        </div>
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <TagOutlined /> 选项配置
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          「环境」「角色 / 权限」「标签」的下拉项都在这里维护，保存后新增和编辑表单立即生效
        </div>
        <OptionEditor />
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <LockOutlined /> 安全
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
          <div style={{ width: 120 }} className="muted">
            启动 / 锁屏密码
          </div>
          <div style={{ flex: 1 }}>
            {settings.hasPin ? (
              <Tag color="green">已设置</Tag>
            ) : (
              <Tag>未设置</Tag>
            )}
          </div>
          <Space>
            <Button size="small" icon={<KeyOutlined />} onClick={() => setPinOpen(true)}>
              {settings.hasPin ? '修改密码' : '设置密码'}
            </Button>
            {settings.hasPin ? (
              <Popconfirm
                title="移除密码后，任何人都能打开这个工具"
                okText="移除"
                cancelText="取消"
                onConfirm={doClearPin}
              >
                <Button size="small" danger>
                  移除
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            闲置自动锁定
          </div>
          <Select
            value={settings.autoLockMinutes || 0}
            onChange={(v) => saveSettings({ autoLockMinutes: v })}
            style={{ width: 160 }}
            options={[
              { value: 1, label: '1 分钟' },
              { value: 5, label: '5 分钟' },
              { value: 10, label: '10 分钟' },
              { value: 30, label: '30 分钟' },
              { value: 0, label: '不自动锁定' }
            ]}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            需要先设置密码
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            复制密码后清空
          </div>
          <Select
            value={settings.clipboardClearSeconds || 0}
            onChange={(v) => saveSettings({ clipboardClearSeconds: v })}
            style={{ width: 160 }}
            options={[
              { value: 15, label: '15 秒' },
              { value: 30, label: '30 秒' },
              { value: 60, label: '60 秒' },
              { value: 120, label: '120 秒' },
              { value: 0, label: '不清空' }
            ]}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            复制的是密码时生效
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            打开网站时带密码
          </div>
          <Switch
            checked={settings.openCopyPassword !== false}
            onChange={(v) => saveSettings({ openCopyPassword: v })}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            浏览器不允许程序直接填表，所以打开的同时把密码放剪贴板，Ctrl+V 即可
          </span>
        </div>

        {info && !info.encryptionAvailable ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 10 }}
            message="系统加密不可用，密码字段以弱编码保存"
            description="通常是 Windows 凭据服务异常，建议修复后再录入敏感信息。"
          />
        ) : null}
      </div>

      <div className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <SaveOutlined /> 数据与备份
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0' }}>
          <div style={{ width: 120 }} className="muted">
            数据目录
          </div>
          <div className="mono" style={{ flex: 1, fontSize: 12, color: '#4a5165', wordBreak: 'break-all' }}>
            {info ? info.dataDir : '-'}
          </div>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => api.openDataDir()}>
            打开
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            备份
          </div>
          <div style={{ flex: 1 }} className="muted">
            每天启动时自动备份一次，保留最近 10 份
          </div>
          <Button size="small" onClick={doBackup}>
            立即备份
          </Button>
        </div>

        {backups.length ? (
          <div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
            {backups.map((b) => (
              <div
                key={b.name}
                style={{ display: 'flex', gap: 10, padding: '5px 0', fontSize: 12, borderTop: '1px dashed #f0f2f8' }}
              >
                <span className="mono" style={{ flex: 1 }}>
                  {b.name}
                </span>
                <span className="muted">{(b.size / 1024).toFixed(1)} KB</span>
                <span className="muted" style={{ width: 110, textAlign: 'right' }}>
                  {fmtTime(b.mtime)}
                </span>
                <Popconfirm
                  title="用这份备份恢复？"
                  description="当前数据会被整库覆盖，恢复前会自动给当前库留一份安全备份"
                  okText="恢复"
                  cancelText="取消"
                  onConfirm={() => doRestore(b.name)}
                >
                  <Button size="small" type="link" icon={<HistoryOutlined />} loading={restoring === b.name}>
                    恢复
                  </Button>
                </Popconfirm>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            导入 / 导出
          </div>
          <div style={{ flex: 1 }} className="muted">
            JSON 用来搬家（合并导入、保留原 id、带关联和选项）；.db 用来回滚（整库覆盖）
          </div>
          <Space>
            <Button size="small" icon={<DatabaseOutlined />} onClick={doExportDb}>
              导出整库
            </Button>
            <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport(false)}>
              导出
            </Button>
            <Popconfirm title="导出会包含明文密码，确定？" okText="确定" cancelText="取消" onConfirm={() => doExport(true)}>
              <Button size="small" icon={<DownloadOutlined />}>
                导出含密码
              </Button>
            </Popconfirm>
            <Button size="small" icon={<UploadOutlined />} onClick={doImport}>
              导入
            </Button>
          </Space>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '10px 0 4px',
            marginTop: 4,
            borderTop: '1px solid #f0f2f8'
          }}
        >
          <div style={{ width: 120 }} className="muted">
            清除数据
          </div>
          <Select
            value={clearTarget}
            placeholder="选择要清除的内容"
            style={{ width: 340 }}
            onChange={(v) => setClearTarget(v)}
            options={[
              { value: 'backups', label: '本地备份文件' },
              { value: 'local', label: '本地数据文件（删除保存的所有本地测试数据）' }
            ]}
          />
          <Button danger icon={<DeleteOutlined />} disabled={!clearTarget} onClick={() => setClearOpen(true)}>
            清除
          </Button>
        </div>
        <div className="muted" style={{ fontSize: 12, paddingLeft: 134 }}>
          清除不可撤销，操作前请先导出需要保留的数据
        </div>
      </div>

      <div className="tool-card">
        <div className="tool-card-title">关于</div>
        <div style={{ display: 'flex', gap: 24, fontSize: 12.5, color: '#4a5165', flexWrap: 'wrap' }}>
          <span>
            版本 <b>{boot.version}</b>
          </span>
          <span>
            存储 <b>SQLite (WASM)</b>
          </span>
          <span>
            数据结构 <b>v{info && info.schemaVersion ? info.schemaVersion : 1}</b>
          </span>
          <span>
            密码字段 <b>{info && info.encryptionAvailable ? 'Windows DPAPI 加密' : '弱编码（DPAPI 不可用）'}</b>
          </span>
          <span className="muted">热键 Ctrl+Alt+T 唤起窗口</span>
        </div>
      </div>

      <Modal
        open={pinOpen}
        title={settings.hasPin ? '修改密码' : '设置密码'}
        onCancel={() => setPinOpen(false)}
        onOk={doSetPin}
        okText="确定"
        cancelText="取消"
        confirmLoading={pinBusy}
        width={420}
      >
        {settings.hasPin ? (
          <div style={{ marginBottom: 12 }}>
            <div className="kv-label">原密码</div>
            <Input.Password value={oldPin} onChange={(e) => setOldPin(e.target.value)} />
          </div>
        ) : null}
        <div>
          <div className="kv-label">新密码（至少 4 位）</div>
          <Input.Password
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            autoFocus
            onPressEnter={doSetPin}
            placeholder="用于解锁工具，不是 Windows 密码"
          />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          忘记密码只能删除数据目录重建，密码只存在本机，不会被上传。
        </div>
      </Modal>

      <Modal
        open={clearOpen}
        title={<span style={{ color: '#cf1322' }}>确认清除</span>}
        onCancel={() => setClearOpen(false)}
        onOk={doClearData}
        okText={clearCountdown > 0 ? `确认清除（${clearCountdown}s）` : '确认清除'}
        okButtonProps={{ danger: true, disabled: clearCountdown > 0 }}
        cancelText="取消"
        confirmLoading={clearBusy}
        maskClosable={false}
        width={480}
      >
        {clearTarget === 'local' ? (
          <Alert
            type="error"
            showIcon
            message="将删除本地数据文件 data.db"
            description={
              <div style={{ fontSize: 12.5, lineHeight: 1.75 }}>
                里面有：全部记录（网站、测试账号、SQL 片段、接口记录、测试笔记、执行记录）、用例与接口的关联关系、
                以及<b>设置和锁屏密码</b>。删除后会重建一个空库，等于回到首次启动状态，<b>无法通过备份恢复</b>。
              </div>
            }
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message={`将删除 ${backups.length} 个本地备份文件${
              backupBytes ? `（约 ${(backupBytes / 1024).toFixed(1)} KB）` : ''
            }`}
            description="备份是用来在数据损坏时恢复的。清空后这些历史备份就没了，data.db 本身不受影响。"
          />
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          为防手滑，确认按钮 3 秒后才可点击。
        </div>
      </Modal>

      <Modal
        open={!!dbConfirm}
        title={<span style={{ color: '#cf1322' }}>整库覆盖确认</span>}
        onCancel={() => setDbConfirm(null)}
        onOk={() => dbConfirm && doRestore(dbConfirm.file)}
        okText="覆盖并恢复"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={!!restoring}
        maskClosable={false}
        width={500}
      >
        <Alert
          type="error"
          showIcon
          message="将用这个文件覆盖当前全部数据"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.75 }}>
              {dbConfirm ? (
                <>
                  <div className="mono" style={{ wordBreak: 'break-all', marginBottom: 6 }}>
                    {dbConfirm.file}
                  </div>
                  包含 <b>{dbConfirm.recordCount}</b> 条记录（结构 v{dbConfirm.fromVersion}）。
                  当前数据库会被整库替换，恢复前系统会自动给当前库留一份安全备份。
                </>
              ) : null}
            </div>
          }
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          想合并数据（而不是覆盖）请用 JSON 导入。
        </div>
      </Modal>
    </div>
  );
}