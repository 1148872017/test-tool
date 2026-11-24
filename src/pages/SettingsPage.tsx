import React, { useEffect, useRef, useState } from 'react';
import { Button, Select, Input, Modal, Tag, Popconfirm, Space, Alert, Switch, Segmented, Progress, Tooltip } from 'antd';
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
  FileTextOutlined,
  CloudDownloadOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import { fmtTime } from '../utils';

/** 字节数 → 人类可读（1.2 MB / 850 KB） */
const fmtBytes = (n: number) => {
  if (!n || n <= 0) return '0 B';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
};

/** 速度 → MB/s */
const fmtSpeed = (bps: number) => {
  if (!bps || bps <= 0) return '';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  return Math.round(bps / 1024) + ' KB/s';
};

/** 剩余秒数 → 1分20秒 */
const fmtEta = (sec: number) => {
  if (!sec || sec <= 0) return '';
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
};
import OptionEditor from '../components/OptionEditor';
import EnvCard from '../components/EnvCard';
import SkinCard from '../components/SkinCard';

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
  const [workspaceDir, setWorkspaceDir] = useState('');
  const [casesDir, setCasesDir] = useState('');
  const [jmxDir, setJmxDir] = useState('');
  const [jmeterPath, setJmeterPath] = useState('');
  const [jmeterVersion, setJmeterVersion] = useState('');
  const [reportDir, setReportDir] = useState('');
  const [allureDir, setAllureDir] = useState('');
  const [projectDir, setProjectDir] = useState('');
  /** 示例数据：条数 + 清除中 */
  const [demoCount, setDemoCount] = useState(0);
  const [demoBusy, setDemoBusy] = useState(false);
  const [kbDir, setKbDir] = useState('');
  const [notesDir, setNotesDir] = useState('');

  // 应用内更新
  const [updating, setUpdating] = useState(false);
  const [updateState, setUpdateState] = useState<'idle' | 'latest' | 'found' | 'downloading' | 'ready' | 'failed'>('idle');
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [updatePct, setUpdatePct] = useState(0);
  const [updateSpeed, setUpdateSpeed] = useState(0);
  const [updateEta, setUpdateEta] = useState(0);
  const [updateConns, setUpdateConns] = useState(0);
  const [updateReceived, setUpdateReceived] = useState(0);
  const [updateTotal, setUpdateTotal] = useState(0);
  const [updateError, setUpdateError] = useState('');
  const [updateFile, setUpdateFile] = useState('');
  const [clearTarget, setClearTarget] = useState<string | undefined>(undefined);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearCountdown, setClearCountdown] = useState(0);
  const [clearBusy, setClearBusy] = useState(false);
  // 选中的 .db 待确认恢复（整库覆盖是破坏性操作）
  const [dbConfirm, setDbConfirm] = useState<any>(null);
  const [restoring, setRestoring] = useState('');

  const settings = boot.settings || {};

  /**
   * 目录类设置的初始化。
   *
   * 踩坑 #100：原来这里漏了 workspaceDir / allureDir / projectDir ——
   * 它们从来没被赋过值，所以「填完切换页面再回来就变空」
   * （组件重挂载时 state 回到初始的空串）。
   *
   * 以后加新目录字段，只要往这里补一行 + 依赖数组补一项。
   */
  useEffect(() => {
    setWorkspaceDir(settings.workspaceDir || '');
    setCasesDir(settings.casesDir || '');
    setJmxDir(settings.jmxDir || '');
    setJmeterPath(settings.jmeterPath || '');
    setReportDir(settings.reportDir || '');
    setAllureDir(settings.allureDir || '');
    setKbDir(settings.kbDir || '');
    setNotesDir(settings.notesDir || '');
    setProjectDir(settings.projectDir || '');
  }, [
    settings.workspaceDir,
    settings.casesDir,
    settings.jmxDir,
    settings.jmeterPath,
    settings.reportDir,
    settings.allureDir,
    settings.kbDir,
    settings.notesDir,
    settings.projectDir
  ]);

  /** 检查更新 */
  const doCheckUpdate = async (force?: boolean) => {
    // 下载中不允许检查更新：否则状态被重置，进度条消失但下载还在跑
    if (updateState === 'downloading') {
      toast('正在下载，请先取消或等下载完成');
      return;
    }
    setUpdating(true);
    setUpdateState('idle');
    try {
      const res = await api.updateCheck(!!force);
      if (!res || !res.ok) {
        toast((res && res.message) || '检查更新失败', 'error');
        return;
      }
      setUpdateInfo(res);
      if (res.hasNew) {
        setUpdateState('found');
        toast(res.cached ? `发现新版本 v${res.latest}（缓存）` : `发现新版本 v${res.latest}`);
      } else {
        setUpdateState('latest');
        toast(res.cached ? '已是最新版本（缓存）' : '已是最新版本');
      }
    } catch (e: any) {
      toast('检查更新失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setUpdating(false);
    }
  };

  /** 下载安装包 */
  const doDownloadUpdate = async () => {
    if (!updateInfo || !updateInfo.asset) {
      toast('没有可下载的安装包', 'error');
      return;
    }
    setUpdateState('downloading');
    setUpdatePct(0);
    setUpdateSpeed(0);
    setUpdateEta(0);
    setUpdateConns(0);
    setUpdateReceived(0);
    setUpdateTotal(updateInfo.asset.size || 0);
    setUpdateError('');
    const off = api.onUpdateProgress((d: any) => {
      setUpdatePct(d.pct || 0);
      setUpdateSpeed(d.speed || 0);
      setUpdateEta(d.eta || 0);
      setUpdateConns(d.connections || 0);
      setUpdateReceived(d.received || 0);
      setUpdateTotal(d.total || 0);
    });
    try {
      const res = await api.updateDownload(updateInfo.asset);
      if (res && res.ok) {
        setUpdateFile(res.file);
        setUpdateState('ready');
        toast('下载完成');
      } else if (res && res.cancelled) {
        setUpdateState('found');
        toast('已取消下载（已下载部分会保留，重试可续传）');
      } else {
        setUpdateState('failed');
        setUpdateError((res && res.message) || '下载失败');
        toast((res && res.message) || '下载失败', 'error');
      }
    } catch (e: any) {
      setUpdateState('failed');
      setUpdateError(e && e.message ? e.message : String(e));
      toast('下载失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      if (typeof off === 'function') off();
    }
  };

  /** 取消下载 */
  const doCancelDownload = async () => {
    try {
      await api.updateCancel();
    } catch (e: any) {
      toast('取消失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /** 安装：确认后启动安装器，程序自己退出 */
  const doInstallUpdate = () => {
    Modal.confirm({
      title: '安装新版本',
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          <div>安装程序会启动，当前程序将自动退出。</div>
          <div style={{ marginTop: 8, color: '#8a90a2' }}>
            安装时可能弹出 UAC 确认框，点「是」即可。
            <br />
            你的数据（密码库、用例、笔记）不受影响。
          </div>
        </div>
      ),
      okText: '退出并安装',
      cancelText: '稍后',
      onOk: async () => {
        try {
          const res = await api.updateInstall(updateFile);
          if (!res || !res.ok) {
            toast((res && res.message) || '启动安装器失败', 'error');
          }
          // 成功时程序会自己退出，这里不用做别的
        } catch (e: any) {
          toast('启动安装器失败：' + (e && e.message ? e.message : e), 'error');
        }
      }
    });
  };

  const doPickNotesDir = async () => {    try {
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

  /* ---------- 示例数据 ---------- */
  const refreshDemoCount = async () => {
    try {
      const res = await api.demoCount();
      setDemoCount(res && res.ok ? Number(res.count) || 0 : 0);
    } catch (e) {
      setDemoCount(0);
    }
  };

  const doClearDemo = async () => {
    setDemoBusy(true);
    try {
      const res = await api.demoClear();
      if (!res.ok) {
        toast(res.message || '清除失败', 'error');
        return;
      }
      toast(`已清除 ${res.removed} 条示例数据`);
      setDemoCount(0);
      onChanged();
    } catch (e: any) {
      toast('清除失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setDemoBusy(false);
    }
  };

  /**
   * 目录输入框的「边输边存」。
   *
   * 为什么不用 onBlur（踩坑 #100）：
   *   用户填完目录直接点侧栏切页面时，blur 不一定触发，
   *   或者触发了但保存还没完成，回来就变空了。
   *   改成输入后 600ms 自动静默保存，怎么切都不会丢。
   */
  const dirSaveTimer = useRef<any>(null);
  const saveDirDebounced = (key: string, value: string) => {
    if (dirSaveTimer.current) clearTimeout(dirSaveTimer.current);
    dirSaveTimer.current = setTimeout(() => {
      saveSettings({ [key]: value }, true);
    }, 600);
  };

  /** 选工作区目录（通用选择器） */
  const doPickWorkspaceDir = async () => {
    try {
      const res = await api.pickDir({ title: '选择工作区目录' });
      if (res && res.ok) {
        setWorkspaceDir(res.dir || '');
        saveSettings({ workspaceDir: res.dir || '' });
        toast('工作区已设置，子目录会自动推导');
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /** 选项目代码目录 */
  const doPickProjectDir = async () => {
    try {
      const res = await api.pickDir({ title: '选择项目代码目录' });
      if (res && res.ok) {
        setProjectDir(res.dir || '');
        saveSettings({ projectDir: res.dir || '' });
        toast('项目目录已更新');
      }
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const doPickAllureDir = async () => {
    try {
      const res = await api.allurePickDir();
      if (res && res.ok) {
        setAllureDir(res.dir || '');
        saveSettings({ allureDir: res.dir || '' });
        toast('Allure 报告目录已更新');
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

  /**
   * 保存设置。
   *
   * @param patch   要改的字段
   * @param silent  静默（不弹「已保存」）——给 debounce 自动保存用。
   *                不加这个的话，输入框每敲一下都会刷一条 toast。
   */
  const saveSettings = async (patch: any, silent = false) => {
    try {
      await api.saveSettings(patch);
      if (!silent) toast('已保存');
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
          <div className="page-desc">目录、环境、外观、行为、数据</div>
        </div>
      </div>

      {/* 侧边快速导航 */}
      <nav className="settings-nav">
        {[
          // 6 个分组（原来是 10 个，太散）
          { id: 'sec-dirs', label: '目录配置' },
          { id: 'sec-env', label: '开发环境' },
          { id: 'sec-skin', label: '外观' },
          { id: 'sec-behavior', label: '行为与安全' },
          { id: 'sec-data', label: '数据与备份' },
          { id: 'sec-about', label: '关于' }
        ].map((it) => (
          <a
            key={it.id}
            className="settings-nav-item"
            onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById(it.id);
              if (!el) return;
              // 手动算滚动位置：scrollIntoView 会被 sticky 导航挡住
              const scroller = document.querySelector('.main') as HTMLElement | null;
              if (!scroller) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
              }
              const navH = 56; // 导航条高度 + 间距
              const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - navH;
              scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
            }}
            href={`#${it.id}`}
          >
            {it.label}
          </a>
        ))}
      </nav>

      <div id="sec-dirs" className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <FolderOpenOutlined /> 目录配置
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          这里全是<b>只读索引</b>：平台只扫描，不修改、不复制你的文件。
        </div>

        {/* ===== 1 级：工作区 ===== */}
        <div className="dir-level-1">
          <div className="dir-level-badge">1 级</div>
          <div className="dir-row" style={{ borderTop: 'none' }}>
            <div className="dir-row-label">工作区目录</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={workspaceDir}
              placeholder="例如 D:\\你的工作区（配这一个，下面 7 个自动推导）"
              onChange={(e) => {
                setWorkspaceDir(e.target.value);
                saveDirDebounced('workspaceDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickWorkspaceDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">
            配了工作区后，下面的子目录<b>留空就自动用</b>「工作区/子目录名」——通常你只需要配这一个
          </div>
        </div>

        {/* ===== 2 级：子目录 ===== */}
        <div className="dir-level-2">
          <div className="dir-level-badge">2 级</div>
          <div className="dir-level-title muted">子目录（留空 = 用工作区下的默认名）</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">测试用例</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={casesDir}
              placeholder="留空 → 工作区/test_cases"
              onChange={(e) => {
                setCasesDir(e.target.value);
                saveDirDebounced('casesDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickCasesDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">测试用例页：索引 markdown 用例</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">压测脚本</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={jmxDir}
              placeholder="留空 → 工作区/jmx"
              onChange={(e) => {
                setJmxDir(e.target.value);
                saveDirDebounced('jmxDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickJmxDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">压测脚本页：索引 .jmx 脚本</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">压测报告</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={reportDir}
              placeholder="留空 → 工作区/jmx/压测结果"
              onChange={(e) => {
                setReportDir(e.target.value);
                saveDirDebounced('reportDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickReportDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">「测试执行 → 导入压测报告」默认扫这里</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">Allure 报告</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={allureDir}
              placeholder="留空 → 不推导（通常指向项目里的 allure-results）"
              onChange={(e) => {
                setAllureDir(e.target.value);
                saveDirDebounced('allureDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickAllureDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">「报告分析」打开时递归找 allure-results</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">知识库</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={kbDir}
              placeholder="留空 → 工作区/知识库"
              onChange={(e) => {
                setKbDir(e.target.value);
                saveDirDebounced('kbDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickKbDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">知识库页：索引 markdown，跳过 _archive / _review</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">测试笔记</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={notesDir}
              placeholder="留空 → 工作区/notes"
              onChange={(e) => {
                setNotesDir(e.target.value);
                saveDirDebounced('notesDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickNotesDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted">测试笔记页：用 Typora 改，平台只读</div>
          <div className="dir-row dir-sub-row">
            <div className="dir-row-label">项目代码</div>
            <Input
              style={{ flex: 1, maxWidth: 620 }}
              value={projectDir}
              placeholder="留空 → 工作区/Project"
              onChange={(e) => {
                setProjectDir(e.target.value);
                saveDirDebounced('projectDir', e.target.value);
              }}
            />
            <Button size="small" icon={<FolderOpenOutlined />} onClick={doPickProjectDir}>
              选择…
            </Button>
          </div>
          <div className="dir-row-hint muted"><b>代码体检 / 代码调试</b> 默认扫这里（可临时改单个页面的扫描目录）</div>
        </div>
      </div>

      <div id="sec-env">
        <EnvCard saveSettings={saveSettings} settings={settings} />
      </div>

      <div id="sec-skin">
        <SkinCard saveSettings={saveSettings} settings={settings} />
      </div>



      <div id="sec-behavior">
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', borderTop: '1px solid #f0f2f8' }}>
          <div style={{ width: 120 }} className="muted">
            点关闭按钮时
          </div>
          <Segmented
            size="small"
            value={settings.closeAction === 'quit' ? 'quit' : 'tray'}
            onChange={(v) => saveSettings({ closeAction: String(v) })}
            options={[
              { label: '缩到托盘', value: 'tray' },
              { label: '退出程序', value: 'quit' }
            ]}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            {settings.closeAction === 'quit'
              ? '点 X 直接退出，不会在后台留进程'
              : '点 X 隐藏到托盘（默认），按 Ctrl+Alt+T 或双击托盘图标唤回。注意：托盘时进程仍在后台，装新版前需先从托盘退出' }
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

      </div>

      <div id="sec-data" className="tool-card" style={{ marginBottom: 14 }}>
        <div className="tool-card-title">
          <SaveOutlined /> 数据与备份
        </div>

        {/* 示例数据 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0 10px' }}>
          <div style={{ width: 120 }} className="muted">
            示例数据
          </div>
          <div style={{ flex: 1 }}>
            {demoCount ? (
              <>
                <Tag color="blue" style={{ marginRight: 6 }}>
                  {demoCount} 条
                </Tag>
                <span className="muted" style={{ fontSize: 12 }}>
                  首次启动写入的示例（带「示例」标签）。看懂后可以清除，不影响你自己的数据。
                </span>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                没有示例数据（已清除或非首次启动）
              </span>
            )}
          </div>
          <Popconfirm
            title="清除所有示例数据？"
            description="只删带「示例」标签的记录 + 内置的示例项目/报告文件，你自己的数据不受影响。"
            okText="清除"
            cancelText="取消"
            onConfirm={doClearDemo}
            disabled={!demoCount}
          >
            <Button size="small" danger icon={<DeleteOutlined />} loading={demoBusy} disabled={!demoCount}>
              清除示例
            </Button>
          </Popconfirm>
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
            {/*
              四个按钮差别大，光看文字分不清（用户要求加 hover 提示）：
                导出整库   → .db 数据库文件（整库，可回滚）
                导出       → JSON（搬家/分享，密码加密或不含）
                导出含密码 → JSON + 明文密码（只在本机用）
                导入       → JSON 合并 或 .db 整库覆盖
            */}
            <Tooltip
              title={
                <div style={{ lineHeight: 1.7 }}>
                  <div>导出整个 <b>data.db</b> 数据库文件</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    · 包含所有集合 + 关联 + 选项配置
                    <br />· 用「恢复」能整库回滚到这个状态
                    <br />· 换机器时优先用这个
                  </div>
                </div>
              }
            >
              <Button size="small" icon={<DatabaseOutlined />} onClick={doExportDb}>
                导出整库
              </Button>
            </Tooltip>

            <Tooltip
              title={
                <div style={{ lineHeight: 1.7 }}>
                  <div>导出所有集合为 <b>JSON</b>（不含密码明文）</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    · 适合分享给别人 / 提交到仓库
                    <br />· 导入时是<b>合并</b>，不会覆盖现有数据
                    <br />· 需要密码也带走？用右边「导出含密码」
                  </div>
                </div>
              }
            >
              <Button size="small" icon={<DownloadOutlined />} onClick={() => doExport(false)}>
                导出
              </Button>
            </Tooltip>

            <Popconfirm title="导出会包含明文密码，确定？" okText="确定" cancelText="取消" onConfirm={() => doExport(true)}>
              <Tooltip
                title={
                  <div style={{ lineHeight: 1.7 }}>
                    <div>导出所有集合为 <b>JSON + 明文密码</b></div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      · 只在自己机器间搬运用
                      <br />· <b style={{ color: '#e5534b' }}>别外发、别进 git</b>
                      <br />· 含 DPAPI 密文解出来的原始密码
                    </div>
                  </div>
                }
              >
                <Button size="small" icon={<DownloadOutlined />}>
                  导出含密码
                </Button>
              </Tooltip>
            </Popconfirm>

            <Tooltip
              title={
                <div style={{ lineHeight: 1.7 }}>
                  <div>从备份文件恢复数据</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    · <b>JSON</b> → 合并（保留原 id，已有的更新）
                    <br />· <b>.db</b> → 整库覆盖（破坏性，会先弹确认）
                  </div>
                </div>
              }
            >
              <Button size="small" icon={<UploadOutlined />} onClick={doImport}>
                导入
              </Button>
            </Tooltip>
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

      <div id="sec-about" className="tool-card">
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

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f0f2f8' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Button
              size="small"
              icon={<CloudDownloadOutlined />}
              onClick={() => doCheckUpdate(false)}
              loading={updating}
              disabled={updateState === 'downloading'}
            >
              检查更新
            </Button>
            <Tooltip title="忽略 10 分钟缓存，强制重新检查">
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                onClick={() => doCheckUpdate(true)}
                disabled={updating || updateState === 'downloading'}
              />
            </Tooltip>
            {updateState === 'latest' ? (
              <span className="muted" style={{ fontSize: 12 }}>
                已是最新版本
              </span>
            ) : null}
            {updateState === 'found' && updateInfo ? (
              <span style={{ fontSize: 12, color: '#6c5ce7' }}>
                发现新版本 <b>v{updateInfo.latest}</b>（当前 v{updateInfo.current}）
              </span>
            ) : null}
            {updateState === 'downloading' ? (
              <span className="muted" style={{ fontSize: 12 }}>
                正在下载… {updatePct}%
                {updateSpeed > 0 ? ` · ${fmtSpeed(updateSpeed)}` : ''}
                {updateEta > 0 ? ` · 剩余 ${fmtEta(updateEta)}` : ''}
              </span>
            ) : null}
            {updateState === 'ready' ? (
              <span style={{ fontSize: 12, color: '#2e9e5b' }}>
                下载完成，可以安装了
              </span>
            ) : null}
            {updateState === 'failed' ? (
              <span style={{ fontSize: 12, color: '#e05252' }}>
                下载失败{updateError ? '：' + updateError : ''}
              </span>
            ) : null}
          </div>

          {updateState === 'downloading' ? (
            <div style={{ marginTop: 10, maxWidth: 460 }}>
              <Progress percent={updatePct} size="small" status="active" />
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                {fmtBytes(updateReceived)} / {fmtBytes(updateTotal)}
                {updateConns > 1 ? ` · ${updateConns} 连接` : ''}
                {updateSpeed > 0 ? ` · ${fmtSpeed(updateSpeed)}` : ''}
                {updateEta > 0 ? ` · 剩余 ${fmtEta(updateEta)}` : ''}
              </div>
              <Button size="small" danger style={{ marginTop: 8 }} onClick={doCancelDownload}>
                取消下载
              </Button>
            </div>
          ) : null}

          {updateState === 'found' && updateInfo ? (
            <div style={{ marginTop: 10 }}>
              {updateInfo.notes ? <div className="update-notes">{updateInfo.notes.slice(0, 600)}</div> : null}
              <Button type="primary" size="small" style={{ marginTop: 8 }} onClick={doDownloadUpdate}>
                下载 v{updateInfo.latest}
              </Button>
            </div>
          ) : null}

          {updateState === 'failed' ? (
            <div style={{ marginTop: 10 }}>
              <Button type="primary" size="small" onClick={doDownloadUpdate}>
                重试下载
              </Button>
              <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                已下载的部分会保留，重试时续传
              </span>
            </div>
          ) : null}

          {updateState === 'ready' ? (
            <Button type="primary" size="small" style={{ marginTop: 10 }} onClick={doInstallUpdate}>
              立即安装并重启
            </Button>
          ) : null}
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