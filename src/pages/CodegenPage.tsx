import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Button, Input, Tag, Space, Segmented, Empty } from 'antd';
import {
  CodeOutlined,
  SaveOutlined,
  CopyOutlined,
  ReloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined
} from '@ant-design/icons';
import api from '../api';
import { toast } from '../msg';
import {
  parseElements,
  LOCATOR_MODE_OPTIONS,
  LOCATOR_MODE_PLACEHOLDER,
  normalizeMode,
  looksLikeXPath,
  type LocatorMode,
  type PageElement
} from '../components/PageElementsEditor';
import { previewLocatorCode } from '../../shared/locatorModes';

/**
 * 积木面板用「受保护的 require」加载，而不是写在顶部的静态 import。
 *
 * 原因：scripts/test-elements.cjs 会用一个白名单 require 桩现场加载本文件来验证
 * groupTargets —— 桩表里没有登记的模块一律抛错，静态 import 一个新模块会让那个
 * 套件在**载入阶段**就崩掉。真打包时 esbuild 不看 try/catch，照样把这棵模块打进
 * dist/app.js；测试环境拿不到时只是不渲染积木面板，生成目标分组等逻辑照旧可测。
 */
let BricksPanelLazy: any = null;
try {
  BricksPanelLazy = require('../components/ui-bricks/BricksPanel').default;
} catch (e) {
  BricksPanelLazy = null;
}

/**
 * 「（N 个元素）」hover 提示的包装组件，同样用受保护的 require：
 * 理由和上面一样 —— 测试里的白名单 require 桩没有登记它，静态 import 会让
 * 那些套件在载入阶段就崩；真打包时 esbuild 照样把它打进 dist/app.js。
 */
let ElementCountTipLazy: any = null;
try {
  ElementCountTipLazy = require('../components/ui-bricks/ElementCountTip').default;
} catch (e) {
  ElementCountTipLazy = null;
}

/**
 * 接口积木面板（「接口流程（积木）」视图），同样用受保护的 require。
 * 理由和上面两块一样：scripts/test-elements.cjs 的白名单 require 桩没登记它，
 * 静态 import 会让那个套件在载入阶段就崩；真打包时 esbuild 照样打进 dist/app.js。
 */
let ApiBricksPanelLazy: any = null;
try {
  ApiBricksPanelLazy = require('../components/api-bricks/ApiBricksPanel').default;
} catch (e) {
  ApiBricksPanelLazy = null;
}

/**
 * 接口目标下的两个视图：单个接口（原有「接口测试类骨架」）/ 接口流程（积木）。
 *
 * 只有这两个 REST Assured / pytest 目标有「流程」概念；
 * POJO / Pydantic 模型、Playwright 页面对象各走各的视图。
 */
const API_BRICKS_TARGETS = ['java-restassured', 'python-pytest'];

/**
 * 这条流程记录是不是接口流程。
 *
 * 老记录没有 kind 字段（v0.49 之前只有 UI 积木），一律当 UI 流程 —— 兜底规则
 * 和 src/components/api-bricks/apiBrickHelpers.ts 的 flowKindOf 完全一致。
 */
function flowIsApiKind(rec: any): boolean {
  const d = (rec && rec.data) || {};
  return String(d.kind || '').trim().toLowerCase() === 'api';
}

type Target = {
  key: string;
  label: string;
  desc: string;
  lang: string;
  ext: string;
  kind: 'api' | 'page' | 'model';
};

/** 生成类型下拉的语言分组顺序（只有这两门语言，其他语言的组排后面） */
const TARGET_LANG_ORDER = ['java', 'python'];
const TARGET_LANG_LABEL: Record<string, string> = { java: 'Java', python: 'Python' };

/**
 * 生成目标 → 按语言分组的下拉选项。
 *
 * 平铺 6 个目标时「Java · REST Assured / Java · Playwright / ...」挤成一长串，
 * 按语言分组后先选语言再选框架，扫起来快得多。target key 一律以 shared/codegen.js 为准。
 */
export function groupTargets(list: Target[]): { label: string; options: { value: string; label: string }[] }[] {
  const byLang = new Map<string, { value: string; label: string }[]>();
  for (const t of list) {
    const lang = String(t.lang || 'other');
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push({ value: t.key, label: t.label });
  }
  const langs = Array.from(byLang.keys()).sort((a, b) => {
    const ia = TARGET_LANG_ORDER.indexOf(a);
    const ib = TARGET_LANG_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return langs.map((lang) => ({
    label: TARGET_LANG_LABEL[lang] || '其他',
    options: byLang.get(lang)!
  }));
}

export default function CodegenPage() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetKey, setTargetKey] = useState('java-restassured');

  // 数据源
  const [apis, setApis] = useState<any[]>([]);
  const [apiId, setApiId] = useState('');
  // 数据源：record = 从接口记录选；file = 直接导入 OpenAPI 文件
  const [apiSource, setApiSource] = useState<'record' | 'file'>('record');
  const [openapiFile, setOpenapiFile] = useState('');
  const [openapiItems, setOpenapiItems] = useState<any[]>([]);
  const [openapiIdx, setOpenapiIdx] = useState<number>(-1);
  const [openapiBusy, setOpenapiBusy] = useState(false);
  const [jsonText, setJsonText] = useState('{\n  "code": 0,\n  "msg": "ok"\n}');
  /** model 模式的数据源：JSON 响应体 / CREATE TABLE 建表语句 */
  const [modelSource, setModelSource] = useState<'json' | 'sql'>('json');
  const [sqlText, setSqlText] = useState(
    'CREATE TABLE t_order (\n  id bigint(20) NOT NULL COMMENT 主键,\n  order_no varchar(64) NOT NULL COMMENT 订单号,\n  amount decimal(10,2) COMMENT 金额,\n  created_at datetime COMMENT 创建时间\n);'
  );
  const [pages, setPages] = useState<any[]>([]);
  const [pageId, setPageId] = useState('');
  const [pageName, setPageName] = useState('login');
  const [pageUrl, setPageUrl] = useState('/login');
  /** 载入提示：「已载入：登录页（4 个元素）」，让用户一眼确认带进来了什么 */
  const [pageHint, setPageHint] = useState('');
  /** 「流程模板」集合里 **UI 流程** 的记录（接口流程走 apiFlows，两边不串台） */
  const [flows, setFlows] = useState<any[]>([]);
  /** 「流程模板」集合里 **接口流程** 的记录（kind === 'api'） */
  const [apiFlows, setApiFlows] = useState<any[]>([]);
  /**
   * 本次会话里已经生成过 POM 类的页面（key 见 pomKeyOf）。
   *
   * 平台不存生成的代码，所以「类在不在」只能靠这个记：
   * 点过「页面对象类」的生成预览 → 认为用户的项目里已经有这个类了。
   */
  const [pomReadyKeys, setPomReadyKeys] = useState<string[]>([]);
  /** 积木区当前拼装状态：切到「页面对象类」再切回来时用它恢复（切换会卸载面板） */
  const bricksStateRef = useRef<any>(null);
  /** 接口积木区的拼装状态（切到「接口测试类骨架」再切回来时用它恢复） */
  const apiBricksStateRef = useRef<any>(null);
  const [elements, setElements] = useState<PageElement[]>([
    { name: 'usernameInput', selector: '#username', desc: '用户名输入框' }
  ]);
  /** 当前聚焦的「定位值」行（-1 = 没聚焦）：只影响下面的代码预览行显不显示 */
  const [focusEl, setFocusEl] = useState<number>(-1);
  const [className, setClassName] = useState('');

  // 输出
  const [code, setCode] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);

  const current = useMemo(() => targets.find((t) => t.key === targetKey), [targets, targetKey]);
  const kind = current ? current.kind : 'api';
  /**
   * 积木区只在 Playwright POM 目标下出现：
   * 那两个目标产出的本来就是「测试方法 + 页面对象」，动作拼装才有意义；
   * 接口测试类骨架 / POJO / Pydantic 模型完全不受影响。
   */
  const isBricksTarget = kind === 'page' && String(targetKey).indexOf('playwright-') === 0;
  /**
   * 接口目标（REST Assured / pytest）下也有两块：单个接口（原有骨架）/ 接口流程（积木）。
   * 和 Playwright 的「[页面对象类] [动作拼装（积木）]」是同构的切换。
   */
  const isApiBricksTarget =
    !!current && kind === 'api' && API_BRICKS_TARGETS.indexOf(String(targetKey)) >= 0;
  /** Playwright 目标下的两个视图：动作拼装（积木）/ 页面对象类（原有 POM 生成） */
  const [pageView, setPageView] = useState<'bricks' | 'pom'>('bricks');
  const showBricks = isBricksTarget && pageView === 'bricks';
  /**
   * 接口目标下的两个视图：single = 单个接口（原有「接口测试类骨架」，一行没动）/ bricks = 接口流程。
   * 默认停在 single：这是老用户的主路径，不该因为新增视图被顶掉。
   */
  const [apiView, setApiView] = useState<'single' | 'bricks'>('single');
  const showApiBricks = isApiBricksTarget && apiView === 'bricks';
  /** 两个积木视图都会顶掉工具条上的「生成预览 / 保存到文件 / 复制」 */
  const inBricksView = showBricks || showApiBricks;
  /**
   * 元素表格里的代码预览按当前生成目标的语言来出。
   * Java 和 Python 的定位 API 风格不同（getByLabel vs get_by_label），预览不能说谎。
   */
  const previewLang = current && current.lang === 'python' ? 'python' : 'java';
  /** 生成类型下拉：按语言分组 */
  const targetOptions = useMemo(() => groupTargets(targets), [targets]);

  /**
   * 读「流程模板」并按 kind 分给两块积木。
   *
   * UI 积木只该看到 ui 流程、接口积木只该看到 api 流程 —— 两边共用一个 flows 集合，
   * 靠这个字段分区；老记录没有 kind，兜底成 ui（v0.49 之前只有 UI 积木）。
   */
  const refreshFlows = async () => {
    const rows = await api.records('flows');
    const list = rows || [];
    setFlows(list.filter((f) => !flowIsApiKind(f)));
    setApiFlows(list.filter((f) => flowIsApiKind(f)));
  };

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    (async () => {
      try {
        const res = await api.codegenTargets();
        setTargets(res.targets || []);
      } catch (e: any) {
        toast('加载生成目标失败：' + (e && e.message ? e.message : e), 'error');
      }
      try {
        const rows = await api.records('apis');
        setApis(rows || []);
      } catch (e) {
        /* ignore */
      }
      try {
        const rows = await api.records('pages');
        setPages(rows || []);
      } catch (e) {
        /* ignore */
      }
      try {
        // 流程模板：两块积木的「载入流程」都用它；读不到就给空表（不能因此让页面白屏）
        await refreshFlows();
      } catch (e) {
        /* ignore */
      }
    })();
  }, []);

  /* ---------- 选并解析 OpenAPI 文件 ---------- */
  const doPickOpenapi = async () => {
    setOpenapiBusy(true);
    try {
      const picked = await api.openapiPickFile();
      if (picked.canceled) return;
      if (!picked.ok) {
        toast(picked.message || '选择失败', 'error');
        return;
      }
      const res = await api.openapiParseFile(picked.file);
      if (!res.ok) {
        toast(res.message || '解析失败', 'error');
        setOpenapiItems([]);
        return;
      }
      setOpenapiFile(picked.file);
      setOpenapiItems(res.items || []);
      setOpenapiIdx(res.items && res.items.length ? 0 : -1);
      toast(`解析出 ${(res.items || []).length} 个接口`);
    } catch (e: any) {
      toast('导入失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setOpenapiBusy(false);
    }
  };

  /** 当前选中的接口数据（文件模式或记录模式） */
  const currentApiData = () => {
    if (apiSource === 'file') {
      return openapiIdx >= 0 && openapiItems[openapiIdx] ? openapiItems[openapiIdx] : null;
    }
    if (!apiId) return null;
    const hit = apis.find((a) => a.id === apiId);
    return hit ? hit.data : null;
  };

  /**
   * 生成用的页面元素：只认填了名字的行。
   * 空行交给模板会生成 `public Locator () { return page.locator(""); }` 这种坏代码。
   */
  const filledElements = () => elements.filter((el) => String(el.name || '').trim());

  /**
   * 「这个页面」的身份：优先用页面记录 id，没有就用「页面名|路径」。
   * 只用来记住「这套 POM 类本次会话生成过没有」，不进任何持久化数据。
   */
  const pomKeyOf = () =>
    pageId ? 'id:' + pageId : 'text:' + String(pageName || '') + '|' + String(pageUrl || '');

  /* ---------- 生成预览 ---------- */
  const doPreview = async () => {
    // 生成前就取 key：await 之后 pageId 可能已经被用户改掉了
    const key = pomKeyOf();
    setBusy(true);
    try {
      const payload: any = { targetKey, className };
      if (kind === 'api') {
        if (apiSource === 'file') {
          const d = currentApiData();
          if (!d) {
            toast('请先从文件里选一个接口', 'warning');
            setBusy(false);
            return;
          }
          payload.apiData = d;
        } else {
          if (!apiId) {
            toast('请先选一个接口', 'warning');
            setBusy(false);
            return;
          }
          payload.apiId = apiId;
        }
      } else if (kind === 'page') {
        const els = filledElements();
        if (!els.length) {
          toast('页面元素是空的：先从「页面元素」载入，或手动填一个元素', 'warning');
          setBusy(false);
          return;
        }
        payload.page = { name: pageName, url: pageUrl, elements: els };
      } else if (modelSource === 'sql') {
        payload.sql = sqlText;
      } else {
        payload.json = jsonText;
      }
      const res = await api.codegenPreview(payload);
      if (!res.ok) {
        toast(res.message || '生成失败', 'error');
        setCode('');
        return;
      }
      setCode(res.code);
      setFilename(res.filename);
      /*
       * 生成成功 = 用户项目里（应该）已经有这个 POM 类了。
       * 积木区据此把「⚠ 需要先生成」换成「✅ 已生成过」——
       * 之前用户选「用本页生成的」只看到 new LoginPage(page)，
       * 完全不知道那个类得先在这里生成。
       */
      if (kind === 'page') {
        setPomReadyKeys((prev) => (prev.indexOf(key) >= 0 ? prev : prev.concat([key])));
      }
    } catch (e: any) {
      toast('生成失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---------- 保存 ---------- */
  const doSave = async () => {
    if (!code) {
      toast('先生成预览', 'warning');
      return;
    }
    setBusy(true);
    try {
      const payload: any = { targetKey, className };
      if (kind === 'api') {
        if (apiSource === 'file') payload.apiData = currentApiData();
        else payload.apiId = apiId;
      } else if (kind === 'page') {
        const els = filledElements();
        if (!els.length) {
          toast('页面元素是空的：先从「页面元素」载入，或手动填一个元素', 'warning');
          setBusy(false);
          return;
        }
        payload.page = { name: pageName, url: pageUrl, elements: els };
      } else if (modelSource === 'sql') payload.sql = sqlText;
      else payload.json = jsonText;

      const res = await api.codegenSave(payload);
      if (res.canceled) return;
      if (!res.ok) {
        toast(res.message || '保存失败', 'error');
        return;
      }
      toast('已保存：' + res.file);
    } catch (e: any) {
      toast('保存失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCopy = async () => {
    if (!code) return;
    await api.copy(code, false);
    toast('代码已复制');
  };

  /** 积木面板的「复制」：连 import 一起复制，粘进 IDEA 少一步手抄 */
  const doCopyBricks = async (text: string) => {
    if (!text) return;
    try {
      await api.copy(text, false);
      toast('动作代码已复制（含 import）');
    } catch (e: any) {
      toast('复制失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  /**
   * 积木区的「保存为流程」：写一条 flows 记录（steps 存 JSON 字符串）。
   *
   * 面板本身不碰 api（否则测试要给它准备一堆桩），这里拿到 data 直接落库，
   * 顺便把 flows 列表刷一遍 —— 保存完立刻能从「载入流程」里看到。
   */
  const doSaveFlow = async (data: any) => {
    try {
      await api.saveRecord({
        collection: 'flows',
        title: String((data && data.name) || '').trim(),
        data,
        tags: []
      });
      try {
        // 列表刷一遍：保存完立刻能从「载入流程」里看到（按 kind 归到对应那块积木）
        await refreshFlows();
      } catch (e) {
        /* 列表没刷新不影响已经存进去的记录 */
      }
      return true;
    } catch (e: any) {
      toast('保存流程失败：' + (e && e.message ? e.message : e), 'error');
      return false;
    }
  };

  /** 积木面板的提示（保存 / 载入结果）：面板自己不做副作用，toast 收在这里 */
  const doNotifyBricks = (message: string, level?: 'success' | 'warning' | 'error') => {
    toast(message, level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'success');
  };

  /**
   * 「去生成页面对象类」：切到「页面对象类」视图并顺手生成。
   *
   * 用户选「用本页生成的」时只看到 `new LoginPage(page)`，不知道类在哪 ——
   * 这个按钮把「先有类、再拼方法体」的顺序直接变成一次点击。
   * 步骤不会丢：积木区的状态由 bricksStateRef 兜着（切换视图会卸载面板）。
   */
  const doGoPom = () => {
    setPageView('pom');
    void doPreview();
  };

  /**
   * 从「页面元素」集合载入一个页面。
   *
   * 这里曾经写的是 `parseElementsShared(...)`，但那个函数从来没定义 / 没导入过 ——
   * 点下拉时直接 ReferenceError，所以「带不出存储的元素」、连 toast 都不弹。
   * 现在直接用 PageElementsEditor 里导出的同一份解析函数（格式完全一致）。
   */
  const doLoadPage = (id: string) => {
    setPageId(id);
    const hit = pages.find((x) => x.id === id);
    if (!hit) return;
    const d = hit.data || {};
    setPageName(String(d.name || ''));
    setPageUrl(String(d.url || '/'));
    const els = parseElements(d.elements || '');
    // 原来只在 els.length 时才覆盖，载入一个空页面会留着上一个页面的元素，容易生成错代码
    setElements(els.length ? els : [{ name: '', selector: '', desc: '' }]);
    setPageHint(`已载入：${d.name || '未命名页面'}（${els.length} 个元素）`);
    toast(`已载入「${d.name || ''}」（${els.length} 个元素）`);
  };

  /* ---------- 元素增删 ---------- */
  const addElement = () =>
    setElements((prev) => prev.concat([{ name: '', selector: '', desc: '' }]));
  const removeElement = (i: number) => {
    setElements((prev) => prev.filter((_, idx) => idx !== i));
    // 删行后下标会错位，聚焦预览直接清掉，免得预览跑到别的行上
    setFocusEl(-1);
  };
  const setElement = (i: number, key: keyof PageElement, v: string) => {
    setElements((prev) => {
      const next = prev.slice();
      next[i] = Object.assign({}, next[i], { [key]: v });
      return next;
    });
  };

  return (
    <div className="codegen-page">
      {/* 顶部：生成目标 */}
      <div className="codegen-bar">
        <Space size={8} wrap>
          <span className="muted">生成</span>
          <Select
            size="small"
            value={targetKey}
            onChange={(v) => {
              setTargetKey(v);
              setCode('');
            }}
            style={{ width: 240 }}
            placeholder="选一个生成目标"
            options={targetOptions}
          />
          <span className="muted">类名</span>
          <Input
            size="small"
            style={{ width: 160 }}
            value={className}
            placeholder="自动推断"
            allowClear
            onChange={(e) => setClassName(e.target.value)}
          />
          {/*
            积木视图下这三个按钮是「页面对象类」/「接口测试类骨架」视图的操作
            （生成/保存的是整份骨架文件），留在这儿点了没反应，会让人以为坏了 ——
            直接不渲染，切回对应视图就有。
          */}
          {inBricksView ? null : (
            <>
              <Button
                type="primary"
                size="small"
                icon={<CodeOutlined />}
                onClick={doPreview}
                loading={busy}
              >
                生成预览
              </Button>
              <Button size="small" icon={<SaveOutlined />} onClick={doSave} disabled={!code}>
                保存到文件
              </Button>
              <Button size="small" icon={<CopyOutlined />} onClick={doCopy} disabled={!code}>
                复制
              </Button>
            </>
          )}
        </Space>
      </div>

      {current ? <div className="codegen-desc muted">{current.desc}</div> : null}

      {/* Playwright POM 目标才有的视图切换：动作拼装（新）/ 页面对象类（原有） */}
      {isBricksTarget ? (
        <Segmented
          size="small"
          value={pageView}
          onChange={(v) => setPageView(v as 'bricks' | 'pom')}
          options={[
            { label: '动作拼装（积木）', value: 'bricks' },
            { label: '页面对象类', value: 'pom' }
          ]}
        />
      ) : null}

      {/* 接口目标才有的视图切换：接口测试类骨架（原有）/ 接口流程（积木，新） */}
      {isApiBricksTarget ? (
        <Segmented
          size="small"
          value={apiView}
          onChange={(v) => setApiView(v as 'single' | 'bricks')}
          options={[
            { label: '接口测试类骨架', value: 'single' },
            { label: '接口流程（积木）', value: 'bricks' }
          ]}
        />
      ) : null}

      {showBricks ? (
        BricksPanelLazy ? (
          <BricksPanelLazy
            pages={pages}
            pageId={pageId}
            onSelectPage={doLoadPage}
            pageName={pageName}
            pageUrl={pageUrl}
            className={className}
            elements={filledElements()}
            lang={previewLang}
            onCopy={doCopyBricks}
            /* ---- 流程模板：保存 / 载入 ---- */
            flows={flows}
            onSaveFlow={doSaveFlow}
            onNotify={doNotifyBricks}
            /* ---- 「用本页生成的」：这个页面的 POM 类生成了没 ---- */
            pomReady={pomReadyKeys.indexOf(pomKeyOf()) >= 0}
            onGoGeneratePom={doGoPom}
            /* 切换视图会卸载面板：状态回传给页面，回来时原样恢复 */
            initialState={bricksStateRef.current}
            onStateChange={(s: any) => {
              bricksStateRef.current = s;
            }}
          />
        ) : (
          <div className="muted" style={{ padding: 12 }}>
            积木面板没有加载起来，刷新页面再试
          </div>
        )
      ) : showApiBricks ? (
        ApiBricksPanelLazy ? (
          <ApiBricksPanelLazy
            /* 接口记录：apiRecord 参数的下拉从这里出（选中即抄快照） */
            apis={apis}
            lang={previewLang}
            /* 只喂接口流程；UI 流程在 flows 里，两块面板不串台 */
            flows={apiFlows}
            onCopy={doCopyBricks}
            onSaveFlow={doSaveFlow}
            onNotify={doNotifyBricks}
            /* 切换视图会卸载面板：状态回传给页面，回来时原样恢复 */
            initialState={apiBricksStateRef.current}
            onStateChange={(s: any) => {
              apiBricksStateRef.current = s;
            }}
          />
        ) : (
          <div className="muted" style={{ padding: 12 }}>
            接口积木面板没有加载起来，刷新页面再试
          </div>
        )
      ) : (
        <div className="codegen-body">
        {/* 左侧：数据源 */}
        <div className="codegen-source">
          {kind === 'api' ? (
            <>
              <div className="codegen-label">数据源</div>
              <Segmented
                size="small"
                value={apiSource}
                onChange={(v) => setApiSource(v as 'record' | 'file')}
                options={[
                  { label: '接口记录', value: 'record' },
                  { label: 'OpenAPI 文件', value: 'file' }
                ]}
              />

              {apiSource === 'record' ? (
                <>
                  {/*
                    接口记录下拉的 placeholder 提示 v0.44 就写了，但**一直没显示出来**：
                    antd v5 的 Select 把受控的 `value=""` 当成「已选中一个空值」，placeholder 不渲染
                    （react-dom/server 实测：value="" 不出 placeholder，value=undefined 才出）。
                    apiId 的初值就是 ''，所以这里必须 `apiId || undefined`，否则用户看到的是个空白下拉，
                    正是「接口记录缺少 Placeholder 提示」的来源。
                  */}
                  <Select
                    size="small"
                    style={{ width: '100%' }}
                    value={apiId || undefined}
                    onChange={setApiId}
                    placeholder={apis.length ? '选一个接口记录（会用它生成测试类）' : '还没有接口记录'}
                    showSearch
                    optionFilterProp="label"
                    options={apis.map((a) => ({
                      value: a.id,
                      label: `${a.data.method} ${a.data.url} · ${a.title}`
                    }))}
                  />
                  {apiId ? (
                    <div className="codegen-api-info">
                      {(() => {
                        const hit = apis.find((a) => a.id === apiId);
                        if (!hit) return null;
                        return (
                          <>
                            <div>
                              <Tag color="blue">{hit.data.method}</Tag>
                              <span className="mono">{hit.data.url}</span>
                            </div>
                            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                              {hit.title}
                              {hit.data.module ? ' · ' + hit.data.module : ''}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={doPickOpenapi}
                    loading={openapiBusy}
                    style={{ width: `100%` }}
                  >
                    {openapiFile ? '重新选择文件' : '选择 OpenAPI 文件（json / yaml）'}
                  </Button>
                  {openapiFile ? (
                    <div className="muted mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                      {openapiFile}
                    </div>
                  ) : null}
                  {openapiItems.length ? (
                    <>
                      {/* 文件分支同样要有提示：-1 也是「没选」，用 undefined 才能让 placeholder 出来 */}
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        value={openapiIdx >= 0 ? openapiIdx : undefined}
                        onChange={setOpenapiIdx}
                        placeholder="选一个文件里的接口（会用它生成测试类）"
                        showSearch
                        optionFilterProp="label"
                        options={openapiItems.map((it, i) => ({
                          value: i,
                          label: `${it.method} ${it.url} · ${it.name}`
                        }))}
                      />
                      <div className="muted" style={{ fontSize: 12 }}>
                        共 {openapiItems.length} 个接口（从文件解析，不影响「接口记录」）
                      </div>
                    </>
                  ) : null}
                </>
              )}
            </>
          ) : null}

          {kind === 'page' ? (
            <>
              <div className="codegen-label">从「页面元素」载入</div>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={pageId || undefined}
                onChange={(v) => {
                  // allowClear 清空时 v 是 undefined，别把 undefined 当 id 去查
                  if (!v) {
                    setPageId('');
                    setPageHint('');
                    return;
                  }
                  doLoadPage(String(v));
                }}
                allowClear
                placeholder={pages.length ? '选一个已保存的页面' : '还没有页面（去「页面元素」新增）'}
                showSearch
                optionFilterProp="label"
                options={pages.map((x) => ({
                  value: x.id,
                  label: `${x.data.name || ''} · ${x.data.url || ''}`
                }))}
              />
              {/* 选中后明确告诉用户「载入了什么、几个元素」，光靠高亮不够醒目 */}
              {pageHint ? (
                <div style={{ marginTop: 6 }}>
                  {/* hover 到「（N 个元素）」上列出是哪几个元素（名称 · 定位方式） */}
                  {ElementCountTipLazy ? (
                    <ElementCountTipLazy elements={elements}>
                      <Tag color="blue">{pageHint}</Tag>
                    </ElementCountTipLazy>
                  ) : (
                    <Tag color="blue">{pageHint}</Tag>
                  )}
                </div>
              ) : null}

              <div className="codegen-label" style={{ marginTop: 8 }}>
                页面信息
              </div>
              {/* addonBefore 把「页面名 / 路径」写死在框里，比两个空框靠 placeholder 猜要清楚 */}
              <Space size={8} wrap>
                <Input
                  size="small"
                  addonBefore="页面名"
                  style={{ width: 200 }}
                  value={pageName}
                  placeholder="login"
                  allowClear
                  onChange={(e) => setPageName(e.target.value)}
                />
                <Input
                  size="small"
                  addonBefore="路径"
                  style={{ width: 180 }}
                  value={pageUrl}
                  placeholder="/login"
                  allowClear
                  onChange={(e) => setPageUrl(e.target.value)}
                />
              </Space>

              <div className="codegen-label" style={{ marginTop: 10 }}>
                元素定位器
              </div>
              {/* 左栏只有 380px，多一列「定位方式」后必须横滑，否则「说明」会被挤成几个字 */}
              <div className="codegen-el-scroll" style={{ overflowX: 'auto' }}>
                <table className="jmx-table codegen-el-table" style={{ minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th style={{ width: '20%' }}>名称</th>
                      <th style={{ width: 130 }}>定位方式</th>
                      <th style={{ width: '32%' }}>定位值</th>
                      <th>说明</th>
                      <th style={{ width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {elements.map((el, i) => {
                      const mode = normalizeMode(el.mode);
                      // 和 PageElementsEditor 用同一个生成函数，只是这里知道目标语言
                      const preview = previewLocatorCode(mode, el.selector, previewLang);
                      const showPreview = focusEl === i || String(el.selector || '').trim() !== '';
                      return (
                        <tr key={i}>
                          <td>
                            <Input
                              size="small"
                              value={el.name}
                              placeholder="usernameInput"
                              onChange={(e) => setElement(i, 'name', e.target.value)}
                            />
                          </td>
                          <td>
                            <Select
                              size="small"
                              style={{ width: '100%' }}
                              value={mode}
                              options={LOCATOR_MODE_OPTIONS}
                              placeholder="定位方式"
                              onChange={(v) => setElement(i, 'mode', v as LocatorMode)}
                            />
                          </td>
                          <td>
                            <Input
                              size="small"
                              className="mono"
                              value={el.selector}
                              placeholder={LOCATOR_MODE_PLACEHOLDER[mode]}
                              onChange={(e) => setElement(i, 'selector', e.target.value)}
                              onFocus={() => setFocusEl(i)}
                              onBlur={() => setFocusEl(-1)}
                            />
                            {mode === 'css' && looksLikeXPath(el.selector) ? (
                              <div
                                className="pe-el-xpath-hint"
                                style={{ fontSize: 11, lineHeight: '15px', marginTop: 2, color: '#d46b08' }}
                              >
                                ⚠ 看起来像 XPath，建议把定位方式改成 XPath
                              </div>
                            ) : null}
                            {showPreview ? (
                              <div
                                className="pe-el-preview mono"
                                style={{
                                  fontSize: 11,
                                  lineHeight: '15px',
                                  marginTop: 2,
                                  color: 'var(--text-3)',
                                  wordBreak: 'break-all'
                                }}
                              >
                                {'→ ' + (preview || '（等待输入）')}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <Input
                              size="small"
                              value={el.desc}
                              placeholder="用户名输入框"
                              onChange={(e) => setElement(i, 'desc', e.target.value)}
                            />
                          </td>
                          <td>
                            <Button
                              type="text"
                              size="small"
                              danger
                              onClick={() => removeElement(i)}
                            >
                              ×
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Button size="small" type="link" onClick={addElement}>
                + 添加元素
              </Button>
            </>
          ) : null}

          {kind === 'model' ? (
            <>
              <div className="codegen-label">数据来源</div>
              <Segmented
                size="small"
                value={modelSource}
                onChange={(v) => setModelSource(v as 'json' | 'sql')}
                options={[
                  { label: 'JSON 响应体', value: 'json' },
                  { label: 'CREATE TABLE', value: 'sql' }
                ]}
              />

              {modelSource === 'json' ? (
                <>
                  <div className="codegen-label" style={{ marginTop: 6 }}>
                    JSON 示例
                  </div>
                  <Input.TextArea
                    className="mono"
                    rows={12}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    spellCheck={false}
                    placeholder='{"code": 0, "data": {...}}'
                  />
                </>
              ) : (
                <>
                  <div className="codegen-label" style={{ marginTop: 6 }}>
                    建表语句（MySQL / SQLite 都认）
                  </div>
                  <Input.TextArea
                    className="mono"
                    rows={12}
                    value={sqlText}
                    onChange={(e) => setSqlText(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    从建表语句推断字段和类型（不连数据库）。类名默认按表名取（t_order → Order）。
                  </div>
                </>
              )}
            </>
          ) : null}
        </div>

        {/* 右侧：代码预览 */}
        <div className="codegen-output">
          <div className="codegen-output-head">
            <span>
              {filename ? (
                <>
                  <FileTextOutlined /> {filename}
                </>
              ) : (
                '代码预览'
              )}
            </span>
            {code ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {code.split('\n').length} 行
              </span>
            ) : null}
          </div>
          {code ? (
            <pre className="codegen-code mono">{code}</pre>
          ) : (
            <div className="codegen-empty">
              <Empty description="选好数据源，点「生成预览」" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
