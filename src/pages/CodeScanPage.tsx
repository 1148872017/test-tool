import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Input,
  Tag,
  Alert,
  Space,
  Segmented,
  Progress,
  Tooltip,
  Select,
  Checkbox,
  Drawer
} from 'antd';
import {
  FolderOpenOutlined,
  ReloadOutlined,
  SyncOutlined,
  SafetyOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileSearchOutlined,
  AppstoreOutlined,
  ApartmentOutlined,
  FilterOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import StateEmpty from '../components/states/StateEmpty';
import StateError from '../components/states/StateError';
import LoadingRows from '../components/states/LoadingRows';

type CoverageItem = {
  id: string;
  name: string;
  method: string;
  url: string;
  module: string;
  hits: number;
  files: string[];
};

/**
 * 范围下拉里「按单个接口 / 按单个页面」的选项（codescan:modules 的 records）。
 *
 * label 由后端拼好（方法 + 路径 / 页面名 + 路径），前端只负责显示：
 * 同一个东西两处拼格式，迟早会拼出两种样子。
 */
type ScopeRecord = {
  id: string;
  name: string;
  method: string;
  url: string;
  module: string;
  label: string;
};

type Issue = {
  rule: string;
  ruleId?: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  hint: string;
  file: string;
  line: number;
  snippet: string;
};

/** 规则表条目（codescan:rules 返回） */
type ScanRule = {
  id: string;
  pack: 'audit' | 'coverage';
  category: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  desc: string;
};

/* ============================================================
 * 四类扫描：类型是**选择项**，不是**执行按钮**
 *
 * 改造前是 4 个 size="small" 的按钮，点一下就扫 —— 语义错：
 * 用户只是想去看看「页面覆盖上次的结果」，却触发了一次全量扫描。
 * 现在拆成两件事：
 *   Segmented  只决定「要看哪一类结果」（不扫描，立即切视图）
 *   「开始扫描」才真的执行
 * ============================================================ */
type ScanType = 'cov-api' | 'cov-page' | 'audit' | 'deps';

const SCAN_TYPES: { value: ScanType; label: string; tip: string; icon: React.ReactNode }[] = [
  {
    value: 'cov-api',
    label: '接口覆盖',
    tip: '代码里真正调用了哪些接口 vs 接口记录，找出没测到的',
    icon: <FileSearchOutlined />
  },
  {
    value: 'cov-page',
    label: '页面覆盖',
    tip: '代码里真正跳转了哪些页面 vs 页面元素，找出没测到的',
    icon: <AppstoreOutlined />
  },
  {
    value: 'audit',
    label: '代码体检',
    tip: '密码/Token/URL 写死、脆弱定位、弱断言 —— 按规则表逐条查，按高中低危分级',
    icon: <SafetyOutlined />
  },
  {
    value: 'deps',
    label: '依赖检查',
    tip: 'pom.xml / requirements.txt 的版本冲突、重复声明、占位符没定义',
    icon: <ApartmentOutlined />
  }
];

/** 严重程度 → 颜色 + 文案（antd Tag 用） */
const sevMeta = (s: string) => {
  if (s === 'high') return { color: 'red', label: '高' };
  if (s === 'medium') return { color: 'orange', label: '中' };
  return { color: 'default', label: '低' };
};

/**
 * 严重程度 → issue 行左边框色。
 *
 * 注意：颜色**不能是唯一通道** —— 同一行里还有「高危/中危/低危」的文字标签，
 * 色弱用户、黑白打印、截图转灰度都能读出来。
 */
const SEV_BORDER: Record<string, string> = {
  high: '#B42318',
  medium: '#A15C00',
  low: '#E1E5EE'
};

/**
 * 严重度 → issue 行修饰类（styles.css 里的 .issue-row-high/-medium/-low）。
 * 迁移注脚：旧内联写的是 borderLeftColor: SEV_BORDER[...]；现在这样写
 * 让静态选择器也能被 CSS 覆盖，不再把颜色写死在组件里。
 */
const issueRowClass = (severity: string): string =>
  'issue-row issue-row-' + (SEV_BORDER[severity] ? severity : 'low');

/** 严重程度 → 完整中文（rail 与 issue 标签共用，替代只写「高」的单字） */
const SEV_FULL: Record<string, string> = {
  high: '高危',
  medium: '中危',
  low: '低危'
};

/**
 * 摘要条 / rail 上小色块的颜色。
 *
 * 低危在规范里是 #E1E5EE —— 做 issue 行的 3px 边框刚好看得出来，
 * 但当 3×14 的小色条铺在白底上就等于没有。所以这两个位置单独用可辨的灰，
 * issue 行仍然严格用 SEV_BORDER。
 */
const SEV_RAIL: Record<string, string> = {
  high: '#B42318',
  medium: '#A15C00',
  low: '#98a0b3'
};

const SEV_KEYS = ['high', 'medium', 'low'];

/** 规则分类 → 展示名 + 排序（和 electron/scan-rules.js 的 category 对应） */
const CATEGORY_META: Record<string, { label: string; order: number }> = {
  ui: { label: 'UI 自动化反模式', order: 0 },
  secret: { label: '硬编码敏感信息', order: 1 },
  assert: { label: '断言质量', order: 2 },
  coverage: { label: '覆盖取数', order: 3 }
};

/* ============================================================
 * 每类结果一个槽位
 *
 * 为什么不再是单个 cov / scan / deps 三个变量：
 *   v0.41.2 为了修「结果乱串」加了「失败就 setCov(null)」，代价是一次失败就丢掉全部上下文。
 *   正确的做法是**按类型分槽**：
 *     · 切类型 → 读对应槽位（有就显示上次的，没有就是空状态）→ 点哪个看哪个不丢
 *     · 扫描失败 → 只写这个槽位的 error，data / at 一格不动 → 旧结果还在、也不会被当成本次结果
 * ============================================================ */
type Slot = {
  /** 最近一次成功的结果；失败时**原样保留** */
  data: any;
  /** 最近一次成功的时间戳（0 = 从没成功过） */
  at: number;
  /** 最近一次失败的一句话原因；成功后清空 */
  error: string;
  /** 最近一次失败的详情（后端 message / 异常信息），给「详情」折叠用 */
  detail: string;
};

const emptySlot = (): Slot => ({ data: null, at: 0, error: '', detail: '' });

/** 成功：写数据 + 时间戳，顺手清掉上一次的错误 */
const okSlot = (set: React.Dispatch<React.SetStateAction<Slot>>, data: any) =>
  set({ data, at: Date.now(), error: '', detail: '' });

/** 失败：只更新 error —— prev.data / prev.at 不动（失败不清旧结果） */
const failSlot = (set: React.Dispatch<React.SetStateAction<Slot>>, message: string, detail?: string) =>
  set((prev) => ({ ...prev, error: message, detail: detail || '' }));

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 时间戳 → HH:mm（摘要条上的「12:03」）；没成功过返回空串 */
const fmtClock = (ts: number) => {
  if (!ts) return '';
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};

/** 摘要条的「上次」短语：只扫过才写「上次 12:03」，没扫过就直说 */
const lastLabel = (ts: number) => (ts ? '上次 ' + fmtClock(ts) : '还没扫过');

/**
 * 范围指纹：把「哪一类 + 选了哪些模块 + 选了哪些记录」压成一个字符串。
 *
 * 只做一件事：比对「现在选的范围」和「上次扫描实际用的范围」是不是同一个。
 * 不一样就说明屏幕上的结果属于上一次的范围 —— 得提示用户再扫一次，
 * 不然改了筛选却没变结果，用户会以为筛选功能坏了。
 */
const scopeKeyOf = (kind: 'api' | 'page', mods: string[], ids: string[]) =>
  kind + '|' + mods.join(',') + '|' + ids.join(',');

/**
 * 摘要条：一行 36px 说清「多少条 + 覆盖率 + 什么时候扫的」。
 *
 * 改造前是 4 张 cov-stat 大卡（每张约 80px 高），把结果区挤掉一半高度：
 * 用户想看的是问题清单，不是四个数字块。压成一行后，同样的窗口能多看 2-3 条问题。
 *
 * 样式在 styles.css 的 .codescan-statbar：固定 36px 单行。
 * 迁移注脚：旧内联写的是 minHeight: 36 / height: 36，已收进类。
 */
function StatBar({
  stats,
  extra
}: {
  stats: { label: string; value: React.ReactNode; color?: string }[];
  extra: React.ReactNode;
}) {
  return (
    <div className="codescan-statbar">
      {stats.map((s, i) => (
        <React.Fragment key={s.label}>
          {i ? <span className="codescan-divider" /> : null}
          <span className="codescan-stat">
            <span className="codescan-stat-mark" style={{ background: s.color || 'var(--text-3)' }} />
            <span>{s.label}</span>
            <b className="codescan-stat-value" style={{ color: s.color || '#3a4055' }}>
              {s.value}
            </b>
          </span>
        </React.Fragment>
      ))}
      <span className="codescan-divider" />
      {extra}
    </div>
  );
}

export default function CodeScanPage() {
  const [root, setRoot] = useState('');
  /** 当前看哪一类结果：coverage（含接口/页面两种）/ hardcoded（代码体检）/ deps */
  const [view, setView] = useState<'coverage' | 'hardcoded' | 'deps'>('coverage');
  /** 覆盖矩阵的对象：接口 / 页面 */
  const [covKind, setCovKind] = useState<'api' | 'page'>('api');
  /**
   * 覆盖矩阵的范围（v0.46.0 起两种粒度，共用一个多选框）：
   *   modules / pickedModules —— 按模块（接口）或项目（页面）筛，空 = 全部
   *   records / pickedIds     —— 按单条接口 / 单页筛，空 = 全部
   * 两个都空 = 不筛选（全量对比）；两个都有 = 后端取并集（见 ipc-scan.js 的注释）。
   */
  const [modules, setModules] = useState<{ name: string; count: number }[]>([]);
  const [pickedModules, setPickedModules] = useState<string[]>([]);
  const [records, setRecords] = useState<ScopeRecord[]>([]);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [noModuleCount, setNoModuleCount] = useState(0);
  /** 手动刷新范围清单时的转圈（自动刷新不转，理由见 loadModules 注释） */
  const [refreshing, setRefreshing] = useState(false);
  /** 「开始扫描」在刷范围清单那几毫秒的转圈（防连点发出两次扫描） */
  const [preparing, setPreparing] = useState(false);
  /**
   * 上一次覆盖扫描实际用的范围指纹。
   * 用来提示「范围改过了，但屏幕上的结果还是上一次的」—— 改完不看这个就会以为筛选没生效。
   */
  const [scannedScope, setScannedScope] = useState('');

  /** 正在跑的类型（'' = 空闲）：只让当前类型转圈，不牵连其它类型的按钮 */
  const [running, setRunning] = useState<ScanType | ''>('');

  /** 规则表 + 勾选状态（默认全选） */
  const [rules, setRules] = useState<ScanRule[]>([]);
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesError, setRulesError] = useState('');

  /* 四类结果各存一份，互不覆盖 */
  const [covApiSlot, setCovApiSlot] = useState<Slot>(emptySlot);
  const [covPageSlot, setCovPageSlot] = useState<Slot>(emptySlot);
  const [auditSlot, setAuditSlot] = useState<Slot>(emptySlot);
  const [depsSlot, setDepsSlot] = useState<Slot>(emptySlot);

  /** 严重程度筛选（代码体检 / 依赖检查共用） */
  const [sevFilter, setSevFilter] = useState('');
  /** 覆盖矩阵的列表筛选：'' 全部 / miss 未覆盖 / hit 已覆盖 */
  const [covFilter, setCovFilter] = useState<'' | 'miss' | 'hit'>('');

  /* ---------- 规则表 ---------- */
  const loadRules = async () => {
    try {
      // 老 preload / 预览模式可能还没有这个通道：读不到就退回「全部规则」，不要挡住扫描
      const fn = (api as any).codescanRules;
      if (typeof fn !== 'function') {
        setRulesError('当前环境没有规则表通道（codescan:rules），扫描时按全部规则执行');
        return;
      }
      const res = await fn();
      const list: ScanRule[] = (res && res.rules) || [];
      if (!list.length) {
        setRulesError('规则表为空，扫描时按全部规则执行');
        return;
      }
      setRules(list);
      setRuleIds(list.map((r) => r.id));
      setRulesError('');
    } catch (e: any) {
      setRulesError('规则表读取失败，扫描时按全部规则执行');
    }
  };

  /** 本次要跑的规则 id；规则表没加载到时返回 undefined（= 后端默认全跑） */
  const idsForPack = (pack: 'audit' | 'coverage'): string[] | undefined => {
    if (!rules.length) return undefined;
    return ruleIds.filter((id) => {
      const r = rules.find((x) => x.id === id);
      return !!r && r.pack === pack;
    });
  };

  const toggleRule = (id: string) => {
    setRuleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /** 按 category 分组（抽屉展示用） */
  const ruleGroups = useMemo(() => {
    const map = new Map<string, ScanRule[]>();
    for (const r of rules) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)!.push(r);
    }
    return [...map.entries()]
      .map(([category, list]) => ({
        category,
        label: (CATEGORY_META[category] || { label: category }).label,
        order: (CATEGORY_META[category] || { order: 9 }).order,
        rules: list
      }))
      .sort((a, b) => a.order - b.order);
  }, [rules]);

  /* ---------- 范围清单（模块/项目聚合 + 单条记录）---------- */
  /**
   * 取范围清单。**只取清单，不扫描** ——
   * 所以切类型时、开始扫描前、点刷新时都能随便调，不会顺带跑一次扫描。
   *
   * 取不到时退化成「只有全部」：范围下拉空着、扫描照旧按全量走，
   * 不能因为清单读失败就把整页顶成错误态（覆盖矩阵本身还是能用的）。
   *
   * @param kind 'api' 接口 / 'page' 页面（两边的聚合字段不同：module vs project）
   * @returns 后端原始结果；读不到返回 null（调用方据此区分「刷新失败」和「没有记录」）
   */
  const loadModules = async (kind: 'api' | 'page') => {
    try {
      const res = await api.codescanModules(kind);
      if (res && res.ok) {
        setModules(res.modules || []);
        // 老 preload 没有 records 字段：退化成只有「按模块」一组，不报错
        setRecords(Array.isArray(res.records) ? res.records : []);
        setNoModuleCount(Number(res.noModule) || 0);
        return res;
      }
    } catch (e) {
      setModules([]);
      setRecords([]);
    }
    return null;
  };

  /** 清空范围选择：换 kind 时两种粒度的选项整套都变了，旧的选中项全部失效 */
  const resetScope = () => {
    setPickedModules([]);
    setPickedIds([]);
  };

  /* ---------- 只切视图，不扫描 ---------- */
  const selectType = (t: ScanType) => {
    if (t === 'cov-api' || t === 'cov-page') {
      const k = t === 'cov-page' ? 'page' : 'api';
      if (k !== covKind) {
        // 接口和页面的范围清单不是一套（module vs project），换 kind 要重新取一次
        // —— 这只是取清单，不是扫描；切类型仍然不触发任何扫描
        resetScope();
        loadModules(k);
      }
      setCovKind(k);
      setView('coverage');
      return;
    }
    if (t === 'audit') {
      setView('hardcoded');
      return;
    }
    setView('deps');
  };

  /* ---------- 覆盖矩阵 ---------- */
  const doCoverage = async (kind?: 'api' | 'page') => {
    const k = kind || covKind;
    if (k !== covKind) {
      // 换 kind 时范围选项整套都换（模块↔项目），旧选中项必须清掉再重取清单
      resetScope();
      await loadModules(k);
    }
    setCovKind(k);

    /**
     * **先切视图，再发请求**（v0.41.2 修过、这里必须保住）。
     *
     * 原来的顺序是「请求成功才切视图」，结果：
     *   点接口覆盖（成功）→ 点代码体检（成功）→ 再点接口覆盖（**失败**）
     *   → 视图停在代码体检上，用户看到的是别类的结果，以为"结果乱串"。
     *
     * 正确语义：看哪类就说哪类 —— 成功填这一类的槽，失败只给这一类的槽写 error。
     */
    setView('coverage');

    const setSlot = k === 'page' ? setCovPageSlot : setCovApiSlot;

    // 一条取数规则都没勾 → 扫了也是空结果，直接拦下来（别让人以为「代码里没请求」）
    const covIds = idsForPack('coverage');
    if (covIds && !covIds.length) {
      toast('至少勾一条「覆盖取数」规则，否则扫了也是空结果', 'error');
      return;
    }

    setRunning(k === 'page' ? 'cov-page' : 'cov-api');
    try {
      /**
       * 范围两种粒度一起交给后端（modules + ids），后端取并集：
       * 只选模块 = 老行为；只选几条记录 = 精确盯；两个都选 = 都要。
       */
      const res = await api.codescanCoverage(root || undefined, k, pickedModules, covIds, pickedIds);
      if (!res || !res.ok) {
        const msg = (res && res.message) || '扫描失败';
        toast(msg, 'error');
        // 只写 error：上一次的结果和时间戳都留着（不清屏）
        failSlot(setSlot, msg, (res && res.message) || '');
        return;
      }
      okSlot(setSlot, res);
      // 记下这次用的范围：范围一改，屏幕上就是「上一次的范围」，要提示出来
      setScannedScope(scopeKeyOf(k, pickedModules, pickedIds));
      const label = k === 'page' ? '页面' : '接口';
      const scopeNote = res.filtered ? `，范围 ${res.scopeCount} 条` : '';
      toast(`${label}覆盖：${res.covered}/${res.total}（扫描 ${res.scannedFiles} 个文件${scopeNote}）`);
    } catch (e: any) {
      const msg = '扫描失败：' + (e && e.message ? e.message : e);
      toast(msg, 'error');
      failSlot(setSlot, msg, String((e && (e.stack || e.message)) || e));
    } finally {
      setRunning('');
    }
  };

  /* ---------- 代码体检（原「硬编码检查」）---------- */
  const doHardcoded = async () => {
    setView('hardcoded'); // 先切视图（理由见 doCoverage）

    const auditIds = idsForPack('audit');
    if (auditIds && !auditIds.length) {
      toast('至少勾一条规则，否则扫了也是空结果', 'error');
      return;
    }

    setRunning('audit');
    try {
      const res = await api.codescanHardcoded(root || undefined, auditIds);
      if (!res || !res.ok) {
        const msg = (res && res.message) || '扫描失败';
        toast(msg, 'error');
        failSlot(setAuditSlot, msg, (res && res.message) || '');
        return;
      }
      okSlot(setAuditSlot, res);
      toast(`扫描 ${res.scannedFiles} 个文件，发现 ${res.summary.total} 个问题`);
    } catch (e: any) {
      const msg = '扫描失败：' + (e && e.message ? e.message : e);
      toast(msg, 'error');
      failSlot(setAuditSlot, msg, String((e && (e.stack || e.message)) || e));
    } finally {
      setRunning('');
    }
  };

  /* ---------- 依赖检查 ---------- */
  const doDeps = async () => {
    setView('deps'); // 先切视图（理由见 doCoverage）
    setRunning('deps');
    try {
      const res = await api.codescanDeps(root || undefined);
      if (!res || !res.ok) {
        const msg = (res && res.message) || '检查失败';
        toast(msg, 'error');
        failSlot(setDepsSlot, msg, (res && res.message) || '');
        return;
      }
      okSlot(setDepsSlot, res);
      if (res.message) toast(res.message, 'info');
      else toast(`检查 ${res.poms} 个 pom + ${res.reqs} 个 requirements，发现 ${res.summary.total} 个问题`);
    } catch (e: any) {
      const msg = '检查失败：' + (e && e.message ? e.message : e);
      toast(msg, 'error');
      failSlot(setDepsSlot, msg, String((e && (e.stack || e.message)) || e));
    } finally {
      setRunning('');
    }
  };

  /**
   * 「开始扫描」：按当前选中的类型执行 —— 只有这个动作会真的扫。
   *
   * 覆盖类**扫之前先重取一次范围清单**，这就是「新增接口后模块范围下拉不更新」的另一半修法：
   * 以前 loadModules 只挂在 useEffect([]) 上，页面不重挂就永远看不到新模块
   * （接口表单里刚填的模块、刚同步进来的接口，下拉里都没有）。
   * 现在每次点扫描都先刷一遍清单，再扫 —— 顺序反了就还是拿旧清单去筛。
   *
   * 这里是 async 的：等清单回来再发扫描请求，不能并发（否则扫描用的还是旧 modules）。
   */
  const doScan = async () => {
    if (view === 'coverage') {
      /**
       * 刷清单这一段也挂到按钮的转圈上（preparing）：
       * 否则这段几毫秒里按钮看着能点，连点会发出两次扫描。
       * 单独用一个状态而不是复用 running —— doCoverage 里「一条取数规则都没勾」
       * 是提前 return 的，running 在那儿不会被清掉，会把按钮卡在转圈上。
       */
      setPreparing(true);
      try {
        await loadModules(covKind);
      } finally {
        setPreparing(false);
      }
      await doCoverage(covKind);
      return;
    }
    if (view === 'hardcoded') return doHardcoded();
    return doDeps();
  };

  /* ---------- 范围行（工具条第三行，扫描前就能设）---------- */
  /** 范围标签：接口按「模块」聚合，页面按「项目」聚合（两个集合的字段不一样） */
  const scopeLabel = covKind === 'page' ? '项目范围' : '模块范围';
  /** 「按模块」这一组的组名 */
  const scopeGroupModule = covKind === 'page' ? '按项目' : '按模块';
  /** 「按记录」这一组的组名 */
  const scopeGroupRecord = covKind === 'page' ? '按单个页面' : '按单个接口';
  /** 空选时的占位文案：把「能选什么」直接写出来，不让人猜 */
  const scopePlaceholder =
    '全部（不筛选）— 可选' + (covKind === 'page' ? '项目或单个页面' : '模块或单个接口');

  /**
   * Select 的值：两种粒度拼成一个数组，用前缀区分。
   *   m:模块名   模块/项目组
   *   r:记录id   单条接口/页面组
   * 为什么共用一个多选框而不是两个下拉：两个下拉就得回答「两个都选时谁说了算」，
   * 而这个答案在界面上永远解释不清；一个多选框里「我勾了什么就是什么」没有歧义。
   */
  const scopeValues = useMemo(
    () => [...pickedModules.map((m) => 'm:' + m), ...pickedIds.map((id) => 'r:' + id)],
    [pickedModules, pickedIds]
  );

  /** Select → 两个 state：按前缀拆回去，两组各自独立 */
  const onScopeChange = (vals: string[]) => {
    setPickedModules(vals.filter((v) => v.startsWith('m:')).map((v) => v.slice(2)));
    setPickedIds(vals.filter((v) => v.startsWith('r:')).map((v) => v.slice(2)));
  };

  /** 下拉选项：分组（按模块 / 按记录），模块带计数、记录带方法+路径，都为了好认 */
  const scopeOptions = useMemo(() => {
    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    if (modules.length) {
      groups.push({
        label: scopeGroupModule,
        options: modules.map((m) => ({ value: 'm:' + m.name, label: m.name + '（' + m.count + ' 条）' }))
      });
    }
    if (records.length) {
      groups.push({
        label: scopeGroupRecord,
        options: records.map((r) => ({ value: 'r:' + r.id, label: r.label }))
      });
    }
    return groups;
  }, [modules, records, scopeGroupModule, scopeGroupRecord]);

  /** 当前范围会参与对比多少条：清单在手上，扫之前就能算出来，不用先扫一遍看结果 */
  const scopeCount = useMemo(() => {
    const mods = new Set(pickedModules);
    const ids = new Set(pickedIds);
    if (!mods.size && !ids.size) return records.length;
    return records.filter((r) => ids.has(r.id) || mods.has(r.module)).length;
  }, [records, pickedModules, pickedIds]);

  /**
   * 范围行右侧的一句话：这次到底对比几条。
   * 一定写出条数 —— 选了个空模块时会显示「参与对比 0 条」，
   * 否则用户看到空列表会以为「代码里一条都没调用」。
   */
  const scopeHint = (() => {
    if (!modules.length && !records.length) return '还没有接口/页面记录：先去补记录，再回来扫覆盖';
    /**
     * 拿不到 records（老 preload / 浏览器预览的假数据）时**不报条数**：
     * 本地算出来的「0 条」是假的，说错了比不说更糟。
     */
    const counted = records.length > 0;
    if (!pickedModules.length && !pickedIds.length) {
      if (!counted) return '不选 = 全部参与对比';
      const noMark = noModuleCount
        ? '，另有 ' + noModuleCount + ' 条没标' + (covKind === 'page' ? '项目' : '模块')
        : '';
      return '不选 = 全部参与对比（' + scopeCount + ' 条' + noMark + '）';
    }
    const parts: string[] = [];
    if (pickedModules.length) parts.push(pickedModules.length + ' 个' + (covKind === 'page' ? '项目' : '模块'));
    if (pickedIds.length) parts.push(pickedIds.length + ' 条记录');
    return '已选 ' + parts.join(' + ') + (counted ? '，参与对比 ' + scopeCount + ' 条' : '');
  })();

  /** 手动刷新范围清单：给「不想重进页面、也不想先扫一遍」的人一个明确入口 */
  const refreshScope = async () => {
    setRefreshing(true);
    const label = covKind === 'page' ? '页面' : '接口';
    try {
      const res = await loadModules(covKind);
      if (res) {
        const n = Array.isArray(res.records) ? res.records.length : 0;
        const m = Array.isArray(res.modules) ? res.modules.length : 0;
        toast('范围选项已刷新：' + m + ' 个' + (covKind === 'page' ? '项目' : '模块') + ' / ' + n + ' 条' + label);
      } else {
        toast('范围选项读取失败，扫描时按全部对比', 'error');
      }
    } finally {
      setRefreshing(false);
    }
  };

  /* 首次进入加载接口范围清单 + 规则表 */
  useEffect(() => {
    loadModules('api');
    loadRules();
  }, []);

  /* ---------- 选目录 ---------- */
  const doPick = async () => {
    try {
      const res = await api.codescanPickDir();
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '选择失败', 'error');
        return;
      }
      setRoot(res.dir);
    } catch (e: any) {
      toast('选择失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /* ---------- 当前视图对应的结果 / 槽位 ---------- */
  const typeValue: ScanType =
    view === 'deps' ? 'deps' : view === 'hardcoded' ? 'audit' : covKind === 'page' ? 'cov-page' : 'cov-api';
  const isRunning = running === typeValue;

  const covSlot = covKind === 'page' ? covPageSlot : covApiSlot;
  const cov = covSlot.data;
  /** 代码体检结果（失败时这里仍是上一次的结果） */
  const scan = auditSlot.data;
  const deps = depsSlot.data;
  /** 当前视图的槽位：错误条和「上次时间」都读它 */
  const slot = view === 'deps' ? depsSlot : view === 'hardcoded' ? auditSlot : covSlot;

  /** 旧结果提示：失败时说明「看到的不是本次结果」 */
  const staleNote = slot.data && slot.at ? '下面还是 ' + fmtClock(slot.at) + ' 的结果' : '';

  /**
   * 范围改过但还没重扫：屏幕上的覆盖结果是**上一次范围**跑出来的。
   * 必须放在 cov 声明之后（在它之前读 cov 会撞上 TDZ，整页白屏 —— 已经踩过一次）。
   */
  const scopeChanged = view === 'coverage' && !!cov && scannedScope !== scopeKeyOf(covKind, pickedModules, pickedIds);

  /* ---------- 过滤问题 ---------- */
  const filteredIssues = useMemo(() => {
    if (!scan) return [];
    if (!sevFilter) return scan.issues;
    return scan.issues.filter((it: Issue) => it.severity === sevFilter);
  }, [scan, sevFilter]);

  const filteredDeps = useMemo(() => {
    if (!deps) return [];
    if (!sevFilter) return deps.issues;
    return deps.issues.filter((it: any) => it.severity === sevFilter);
  }, [deps, sevFilter]);

  const covPct = cov && cov.total ? Math.round((cov.covered / cov.total) * 100) : 0;

  /* ---------- 左栏 rail：视图内的「范围」筛选（替代横向 Segmented）---------- */
  const railItems = useMemo(() => {
    if (view === 'coverage') {
      return [
        { key: '', label: '全部', count: cov ? cov.total : 0, color: 'var(--text-3)' },
        { key: 'miss', label: '未覆盖', count: cov ? cov.uncovered.length : 0, color: '#B42318' },
        { key: 'hit', label: '已覆盖', count: cov ? cov.coveredList.length : 0, color: '#2e9e5b' }
      ];
    }
    const data = view === 'deps' ? deps : scan;
    const s = (data && data.summary) || {};
    return [
      { key: '', label: '全部', count: s.total || 0, color: 'var(--text-3)' },
      ...SEV_KEYS.map((k) => ({
        key: k,
        label: SEV_FULL[k],
        count: s[k] || 0,
        color: SEV_RAIL[k]
      }))
    ];
  }, [view, cov, scan, deps]);

  const railActive = view === 'coverage' ? covFilter : sevFilter;
  const setRail = (key: string) => {
    if (view === 'coverage') setCovFilter(key as '' | 'miss' | 'hit');
    else setSevFilter(key);
  };

  /** 摘要条：按视图给不同的数字组合 */
  const summaryBar = (() => {
    if (view === 'coverage') {
      return (
        <StatBar
          stats={[
            { label: '未覆盖', value: cov ? cov.uncovered.length : 0, color: '#B42318' },
            { label: '已覆盖', value: cov ? cov.coveredList.length : 0, color: '#2e9e5b' }
          ]}
          extra={
            <>
              <span className="codescan-extra">
                <span>覆盖</span>
                <b className="codescan-stat-value">{cov ? cov.covered + '/' + cov.total : '—'}</b>
                <span className="muted">{cov ? '· ' + covPct + '%' : ''}</span>
                <Progress
                  percent={covPct}
                  size="small"
                  showInfo={false}
                  style={{ width: 90, margin: 0 }}
                  strokeColor={covPct >= 80 ? '#2e9e5b' : covPct >= 50 ? '#f5a623' : '#e5534b'}
                />
              </span>
              <span className="codescan-divider" />
              <span className="muted" style={{ fontSize: 12 }}>
                {lastLabel(slot.at)}
                {cov ? ' · ' + cov.scannedFiles + ' 文件' : ''}
              </span>
            </>
          }
        />
      );
    }
    if (view === 'deps') {
      const s = (deps && deps.summary) || {};
      return (
        <StatBar
          stats={SEV_KEYS.map((k) => ({ label: SEV_FULL[k], value: s[k] || 0, color: SEV_RAIL[k] }))}
          extra={
            <>
              <span>
                共 <b className="codescan-stat-value">{s.total || 0}</b> 条
              </span>
              <span className="codescan-divider" />
              <span className="muted" style={{ fontSize: 12 }}>
                {lastLabel(slot.at)}
                {deps ? ' · ' + (deps.poms + deps.reqs) + ' 文件' : ''}
              </span>
            </>
          }
        />
      );
    }
    const s = (scan && scan.summary) || {};
    return (
      <StatBar
        stats={SEV_KEYS.map((k) => ({ label: SEV_FULL[k], value: s[k] || 0, color: SEV_RAIL[k] }))}
        extra={
          <>
            <span>
              共 <b className="codescan-stat-value">{s.total || 0}</b> 条
              {Array.isArray(scan && scan.rulesRun) ? (
                <span className="muted"> · {scan.rulesRun.length} 条规则</span>
              ) : null}
            </span>
            <span className="codescan-divider" />
            <span className="muted" style={{ fontSize: 12 }}>
              {lastLabel(slot.at)}
              {scan ? ' · ' + scan.scannedFiles + ' 文件' : ''}
            </span>
          </>
        }
      />
    );
  })();

  /** 规则抽屉内容（原来插在中间、max-height:360 的区块） */
  const rulesDrawer = (
    <Drawer
      open={rulesOpen}
      onClose={() => setRulesOpen(false)}
      placement="right"
      width={560}
      title={
        <span>
          <FilterOutlined /> 规则勾选
        </span>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Alert
          type="info"
          showIcon
          message="启发式检查，不是语法树分析：可能误报，也会漏报"
          description="规则都是正则 + 条件判断，命中只代表「这里值得看一眼」；确认是误报就取消勾选这类规则再扫。"
        />
        {rulesError ? <Alert type="warning" showIcon message={rulesError} /> : null}

        <div className="rule-panel-head">
          <span className="muted" style={{ fontSize: 12 }}>
            已勾选 {ruleIds.length} / {rules.length} 条
            {rules.length
              ? `（代码体检 ${idsForPack('audit')?.length || 0} 条 · 覆盖取数 ${idsForPack('coverage')?.length || 0} 条）`
              : ''}
          </span>
          <Space size={6}>
            <Button size="small" onClick={() => setRuleIds(rules.map((r) => r.id))}>
              全选
            </Button>
            <Button size="small" onClick={() => setRuleIds([])}>
              全不选
            </Button>
          </Space>
        </div>

        <div className="rule-groups" style={{ gridTemplateColumns: '1fr' }}>
          {ruleGroups.map((g) => (
            <div className="rule-group" key={g.category}>
              <div className="rule-group-title">
                {g.label} <span className="muted">({g.rules.length})</span>
              </div>
              {g.rules.map((r) => {
                const m = sevMeta(r.severity);
                return (
                  <div className="rule-row" key={r.id}>
                    <Checkbox checked={ruleIds.includes(r.id)} onChange={() => toggleRule(r.id)}>
                      <span className="rule-title">{r.title}</span>
                    </Checkbox>
                    <Tag color={m.color} className="rule-sev">
                      {m.label}
                    </Tag>
                    {r.pack === 'coverage' ? <Tag className="rule-pack">覆盖取数</Tag> : null}
                    <Tooltip title={r.desc}>
                      <span className="rule-desc muted">{r.desc}</span>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );

  return (
    <div className="codescan-page">
      {/* 第一行：扫哪个目录 */}
      <div className="codescan-bar">
        <span className="muted">代码目录</span>
        <Input
          size="small"
          style={{ width: 360 }}
          value={root}
          placeholder="留空 = 用「设置 → 开发环境」里的项目目录"
          onChange={(e) => setRoot(e.target.value)}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={doPick}>
          选目录
        </Button>
      </div>

      {/*
        第二行：看哪类（Segmented，**只切视图**）+ 规则入口（右侧抽屉）
        这一行只放「看着哪一类」和「按哪些规则」，不放执行按钮。
      */}
      <div className="codescan-bar">
        <Segmented
          value={typeValue}
          onChange={(v) => selectType(v as ScanType)}
          options={SCAN_TYPES.map((t) => ({
            value: t.value,
            label: (
              <Tooltip title={t.tip}>
                <span className="codescan-extra">
                  {t.icon}
                  {t.label}
                </span>
              </Tooltip>
            )
          }))}
        />
        <span style={{ flex: 1, minWidth: 8 }} />
        <Button size="small" icon={<FilterOutlined />} onClick={() => setRulesOpen(true)}>
          规则{rules.length ? ` ${ruleIds.length}/${rules.length}` : ''}
        </Button>
      </div>

      {/*
        第三行：范围 → 开始扫描。

        为什么范围要挪到这里（v0.46.0）：
          用户的心智顺序是「选定项目 → 选定范围（不填=全部）→ 开始扫描」。
          改造前 .cov-scope 长在结果区里，只有**扫过一次**才出现 ——
          想「先缩范围再扫」根本做不到，只能先全量扫一遍（慢、还可能被上百条
          无关未覆盖刷屏），再回头点筛选。范围本来就是扫描的输入，不该藏在输出里。

        为什么单独占一行、不挤进第二行：
          Segmented 四类约 390px；范围是多选框，选中两个模块后 tag 会把宽度撑开；
          再加规则 + 开始扫描 ≈ 940px，在 980px 内容宽下随便一选就换行，
          换行后「开始扫描」会被挤到范围下面 —— 顺序反而更乱。
          独立一行后范围能独占剩余宽度，扫描按钮也固定在最右（肌肉记忆不用改）。

        为什么复用 .cov-scope 这个类名：
          它就是「范围那一行」的样式（浅底 + 细边 + 可换行），正好是工具条条块的观感；
          沿用旧类名，styles.css 一行都不用改（并行改造时少一个冲突点）。
      */}
      <div className="cov-scope" style={{ marginBottom: 0 }}>
        {view === 'coverage' ? (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              {scopeLabel}
            </span>
            <Select
              mode="multiple"
              size="small"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ minWidth: 280, maxWidth: 640 }}
              value={scopeValues}
              onChange={(v) => onScopeChange(v as string[])}
              placeholder={scopePlaceholder}
              options={scopeOptions}
              maxTagCount="responsive"
              disabled={!scopeOptions.length}
            />
            <Tooltip title="重新读取接口/页面记录：别的页面刚加的接口，点一下就出现在选项里（每次点「开始扫描」前也会自动刷一次）">
              <Button
                size="small"
                icon={<SyncOutlined />}
                loading={refreshing}
                onClick={refreshScope}
                aria-label="刷新范围选项"
              >
                刷新
              </Button>
            </Tooltip>
            {/* 改过范围还没重扫时换成警示色：不改色的话这句话会被当成普通说明读过去 */}
            <span className="muted" style={{ fontSize: 12, color: scopeChanged ? '#A15C00' : undefined }}>
              {scopeChanged ? scopeHint + '；范围改过了，点「开始扫描」才生效' : scopeHint}
            </span>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            {view === 'hardcoded' ? '代码体检' : '依赖检查'}按整个代码目录扫，不按范围筛选
            {modules.length || records.length ? '；要缩范围请切到「接口覆盖 / 页面覆盖」' : ''}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 8 }} />
        <Tooltip title={view === 'coverage' ? '按上面选的范围扫一次' : '扫一次当前类型'}>
          <Button type="primary" icon={<ReloadOutlined />} loading={!!running || preparing} onClick={doScan}>
            开始扫描
          </Button>
        </Tooltip>
      </div>

      {rulesDrawer}

      {/* 结果区：左 96px rail（范围/严重程度）+ 右侧内容。
          样式在 .codescan-rail / .codescan-rail-item；旧内联宽度是 width: 96。 */}
      <div className="codescan-main">
        <aside className="codescan-rail">
          <div className="codescan-rail-title">{view === 'coverage' ? '覆盖情况' : '严重程度'}</div>
          {railItems.map((it) => {
            const active = railActive === it.key;
            return (
              <button
                key={it.key || 'all'}
                type="button"
                className={'codescan-rail-item' + (active ? ' active' : '')}
                onClick={() => setRail(it.key)}
              >
                <span className="codescan-rail-mark" style={{ background: it.color }} />
                <span className="codescan-rail-label">{it.label}</span>
                <span className="codescan-rail-count">{it.count}</span>
              </button>
            );
          })}
        </aside>

        <div className="codescan-main-body">
          {summaryBar}

          {/*
            失败时：有旧结果就在上面压一条就地错误条（旧结果照旧显示，但明确写出「这是上次的」）；
            没有旧结果时交给下面的 failed 空状态（带「详情」折叠），同一句话不重复出现两遍。
          */}
          {slot.error && slot.data ? (
            <StateError
              message={slot.error}
              detail={slot.detail}
              staleLabel={staleNote}
              onRetry={doScan}
              retryLabel="重试"
            />
          ) : null}

          {/* ---------- 覆盖矩阵 ---------- */}
          {view === 'coverage' ? (
            !cov ? (
              isRunning ? (
                <LoadingRows rows={6} />
              ) : (
                <StateEmpty
                  size="page"
                  kind={slot.error ? 'failed' : 'no-data'}
                  object={covKind === 'page' ? '页面覆盖结果' : '接口覆盖结果'}
                  desc={
                    slot.error
                      ? '目录不对、代码太大或后端报错都可能读不到：到「设置 → 开发环境」改项目目录，或直接在上面「选目录」换一个再试'
                      : covKind === 'page'
                        ? '把代码里真正跳转的页面和「页面元素」记录比一遍，找出没测到的'
                        : '把代码里真正调用的接口和「接口记录」比一遍，找出没测到的'
                  }
                  detail={slot.detail || undefined}
                  action={{ label: slot.error ? '重试' : '开始扫描', onClick: doScan }}
                  secondary={{ label: '选代码目录', onClick: doPick }}
                />
              )
            ) : (
              <div className="codescan-content codescan-content-scroll">
                {!cov.total && !cov.uncovered.length && !cov.coveredList.length ? (
                  <StateEmpty
                    size="page"
                    kind="no-data"
                    object={covKind === 'page' ? '页面记录' : '接口记录'}
                    desc="「接口记录 / 页面元素」里还没有可比对的数据：先去补记录，再回来扫覆盖"
                    action={{ label: '重新扫描', onClick: doScan }}
                  />
                ) : (
                  <>
                    {covFilter !== 'hit' ? (
                      <>
                        <div className="cov-section-title">
                          <CloseCircleOutlined style={{ color: '#e5534b' }} /> 未覆盖（
                          {cov.uncovered.length}）
                        </div>
                        {cov.uncovered.length ? (
                          <div className="cov-list">
                            {cov.uncovered.map((u: CoverageItem) => (
                              <div className="cov-row cov-row-miss" key={u.id}>
                                {u.method ? <Tag color="blue">{u.method}</Tag> : null}
                                <span className="mono cov-url">{u.url}</span>
                                <span className="cov-name muted">{u.name}</span>
                                {u.module ? <Tag>{u.module}</Tag> : null}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <StateEmpty
                            kind="no-match"
                            keyword="未覆盖"
                            title="没有未覆盖的入口"
                            desc="这个范围内所有接口都被代码调用到了"
                            action={{ label: '看清全部', onClick: () => setCovFilter('') }}
                          />
                        )}
                      </>
                    ) : null}

                    {covFilter !== 'miss' ? (
                      <>
                        <div className="cov-section-title" style={{ marginTop: 4 }}>
                          <CheckCircleOutlined style={{ color: '#2e9e5b' }} /> 已覆盖（
                          {cov.coveredList.length}）
                        </div>
                        {cov.coveredList.length ? (
                          <div className="cov-list">
                            {cov.coveredList.map((c: CoverageItem) => (
                              <div className="cov-row" key={c.id}>
                                {c.method ? <Tag color="blue">{c.method}</Tag> : null}
                                <span className="mono cov-url">{c.url}</span>
                                <span className="cov-name muted">{c.name}</span>
                                <Tag color="green">{c.hits} 处</Tag>
                                {c.files.length ? (
                                  <Tooltip title={c.files.join('\n')}>
                                    <span className="muted" style={{ fontSize: 12 }}>
                                      {c.files[0].split(/[\\/]/).pop()}
                                      {c.files.length > 1 ? ` +${c.files.length - 1}` : ''}
                                    </span>
                                  </Tooltip>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <StateEmpty
                            kind="no-match"
                            keyword="已覆盖"
                            title="还没有被代码调用的条目"
                            desc="扫到的路径一条都对不上记录：检查一下目录选对没有、模块范围是不是筛太窄"
                            action={{ label: '看清全部', onClick: () => setCovFilter('') }}
                          />
                        )}
                      </>
                    ) : null}
                  </>
                )}
              </div>
            )
          ) : null}

          {/* ---------- 依赖检查 ---------- */}
          {view === 'deps' ? (
            !deps ? (
              isRunning ? (
                <LoadingRows rows={6} />
              ) : (
                <StateEmpty
                  size="page"
                  kind={slot.error ? 'failed' : 'no-data'}
                  object="依赖检查结果"
                  desc={
                    slot.error
                      ? '目录不对或没有可解析的 pom / requirements：到「设置 → 开发环境」改项目目录，或直接在上面「选目录」换一个再试'
                      : '扫 pom.xml / requirements.txt：同一声明重复、版本不一致、占位符没定义'
                  }
                  detail={slot.detail || undefined}
                  action={{ label: slot.error ? '重试' : '开始扫描', onClick: doScan }}
                  secondary={{ label: '选代码目录', onClick: doPick }}
                />
              )
            ) : (
              <div className="codescan-content">
                {deps.message ? <Alert type="info" showIcon message={deps.message} /> : null}

                {!filteredDeps.length ? (
                  deps.summary.total === 0 ? (
                    <StateEmpty
                      size="page"
                      kind="no-data"
                      object="依赖问题"
                      desc="只查「同一声明重复 / 版本不一致 / 占位符没定义」，不做传递依赖分析（用 mvn dependency:tree 更准）"
                      action={{ label: '重新检查', onClick: doScan }}
                    />
                  ) : (
                    <StateEmpty
                      size="page"
                      kind="no-match"
                      title={`没有匹配「${SEV_FULL[sevFilter] || ''}」的问题`}
                      desc="这次检查里有别的问题，清掉筛选就能看到"
                      action={{ label: '清空筛选', onClick: () => setSevFilter('') }}
                    />
                  )
                ) : (
                  <div className="issue-list">
                    {filteredDeps.map((it: any, i: number) => {
                      const m = sevMeta(it.severity);
                      return (
                        <div className={issueRowClass(it.severity)} key={i}>
                          <Tag color={m.color}>{SEV_FULL[it.severity] || m.label}</Tag>
                          <span className="issue-label">{it.title}</span>
                          <span className="issue-file mono muted">{it.file}</span>
                          <div className="issue-snippet mono">{it.detail}</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="muted" style={{ fontSize: 12 }}>
                  只查「同一声明重复 / 版本不一致 / 占位符没定义」，不做传递依赖分析（用 mvn dependency:tree 更准）。
                </div>
              </div>
            )
          ) : null}

          {/* ---------- 代码体检 ---------- */}
          {view === 'hardcoded' ? (
            !scan ? (
              isRunning ? (
                <LoadingRows rows={6} />
              ) : (
                <StateEmpty
                  size="page"
                  kind={slot.error ? 'failed' : 'no-data'}
                  object="代码体检结果"
                  desc={
                    slot.error
                      ? '目录不对、代码太大或后端报错都可能读不到：到「设置 → 开发环境」改项目目录，或直接在上面「选目录」换一个再试'
                      : '按勾选的规则扫一遍：密码/Token 写死、脆弱定位、弱断言，按高中低危分级'
                  }
                  detail={slot.detail || undefined}
                  action={{ label: slot.error ? '重试' : '开始扫描', onClick: doScan }}
                  secondary={{ label: '挑规则', onClick: () => setRulesOpen(true) }}
                />
              )
            ) : (
              <div className="codescan-content">
                {/* 截断必须说清楚：为什么少、少在哪 —— 不能让人以为这就是全部 */}
                {scan.truncated ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={'结果被截断：' + (scan.truncatedReason || '达到扫描上限')}
                    description="命中数可能偏少。可以少勾几条规则、缩小目录，或分批扫。"
                  />
                ) : null}

                {scan.suppressed ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    另有 {scan.suppressed} 条同类命中未展示（每规则每文件最多 3 条）
                  </span>
                ) : null}

                {!filteredIssues.length ? (
                  scan.summary.total === 0 ? (
                    <StateEmpty
                      size="page"
                      kind="no-data"
                      object="问题"
                      title="勾选的规则一条都没命中"
                      desc="注意这是启发式检查：没命中不等于没问题。规则只看正则能识别到的写法，漏报是常态。"
                      action={{ label: '换几条规则再扫', onClick: () => setRulesOpen(true) }}
                      secondary={{ label: '重新扫描', onClick: doScan }}
                    />
                  ) : (
                    <StateEmpty
                      size="page"
                      kind="no-match"
                      title={`没有匹配「${SEV_FULL[sevFilter] || ''}」的问题`}
                      desc="这次扫描里有别的问题，清掉筛选就能看到"
                      action={{ label: '清空筛选', onClick: () => setSevFilter('') }}
                    />
                  )
                ) : (
                  <div className="issue-list">
                    {filteredIssues.map((it: Issue, i: number) => {
                      const m = sevMeta(it.severity);
                      return (
                        <div className={issueRowClass(it.severity)} key={i}>
                          {/* 颜色 + 文字双通道：色弱 / 灰度截图也能读出来 */}
                          <Tag color={m.color}>{SEV_FULL[it.severity] || m.label}</Tag>
                          <span className="issue-label">{it.label}</span>
                          <span className="issue-file mono muted">
                            {it.file.split(/[\\/]/).slice(-2).join('/')}:{it.line}
                          </span>
                          <div className="issue-snippet mono">{it.snippet}</div>
                          <div className="issue-hint muted">{it.hint}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}