import React, { useEffect, useRef, useState } from 'react';
import { Drawer, Button, Tag, Space, Popconfirm, Select, Tooltip } from 'antd';
import {
  CopyOutlined,
  EditOutlined,
  DeleteOutlined,
  ExportOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  StarFilled,
  LinkOutlined,
  FileTextOutlined,
  CloseOutlined,
  CaretRightOutlined
} from '@ant-design/icons';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import api from '../api';
import { toast } from '../msg';
import { buildCurl, fmtTime, recordToText } from '../utils';
import JsonTableToggle from './JsonTableToggle';
import VarsEditor from './VarsEditor';
import MetricsTable from './MetricsTable';
import ScenePicker from './ScenePicker';
import AccountsEditor from './AccountsEditor';
import SniffPanel, { type SniffBrowser, type SniffPhase, type SniffTarget } from './SniffPanel';
import { caseKey, knownCaseKeys, loadCaseIndex } from '../caseIndex';
import { matchOnlyFor, recentForApi, resultTone, runLine } from '../../shared/runs';
import { RUN_KIND_OPTIONS } from '../../shared/collections';
import VarFillModal from './VarFillModal';
import CaseLinkModal from './CaseLinkModal';
import ErrorBoundary from './feedback/ErrorBoundary';
import StateEmpty from './states/StateEmpty';
import { asArray, fieldOptions, getOptionsSync, loadOptions, OptionsMap } from '../options';
import {
  parseElements,
  normalizeMode,
  settleSniff,
  readSniffBrowser,
  writeSniffBrowser,
  reopenWithBrowser,
  type PageElement
} from './PageElementsEditor';
import { previewLocatorCode } from '../../shared/locatorModes';

marked.setOptions({ gfm: true, breaks: true });

/**
 * 「定位方式」的短标签。
 *
 * css 是老记录的缺省值（serialize 时根本不写进 JSON），用户看定位值就能认出来，
 * 所以不显示标签；其余 8 种是 Playwright 的语义化定位（getByRole / getByTestId …），
 * 必须给个标签，否则 `button:登录` 这种值在表格里看起来像写错的 CSS。
 */
const MODE_SHORT_LABEL: Record<string, string> = {
  xpath: 'XPath',
  role: 'Role',
  label: 'Label',
  placeholder: 'Placeholder',
  text: 'Text',
  alttext: 'AltText',
  title: 'Title',
  testid: 'TestId'
};

/**
 * 一行的定位方式标签：css → 空串（不显示），其余 → Role / TestId 这种短名。
 * 认不出的脏 mode 走 normalizeMode 兜底成 css，也就是不显示标签。
 */
export function elementModeTag(mode: any): string {
  const m = normalizeMode(mode);
  return m === 'css' ? '' : MODE_SHORT_LABEL[m] || m;
}

/** 定位值 + 方式标签（复制成文本时写成 `[Role] button:登录`，不然方式丢了就认不出是语义化定位） */
export function elementLocatorText(el: PageElement): string {
  const tag = elementModeTag(el.mode);
  const sel = String(el.selector || '').trim() || '-';
  return tag ? `[${tag}] ${sel}` : sel;
}

/**
 * 元素定位器 → 可粘贴的纯文本。
 *
 * 用制表符分隔（不是 markdown 表格）：用户要的是能直接粘进用例文档 / Excel / 聊天窗口的文本，
 * 粘到哪里都不会变形，也不是给程序解析的 JSON。
 */
export function elementsToText(raw: any): string {
  const rows = parseElements(raw);
  if (!rows.length) return '';
  return [['名称', '定位值', '说明'].join('\t')]
    .concat(
      rows.map((el) =>
        [
          String(el.name || '').trim() || '-',
          elementLocatorText(el),
          String(el.desc || '').trim() || '-'
        ].join('\t')
      )
    )
    .join('\n');
}

/** 定位方式 → 校验面板里显示的名字（css 在详情里没有标签，这里补全称） */
function elementModeLabel(mode: any): string {
  const m = normalizeMode(mode);
  return m === 'css' ? 'CSS 选择器' : MODE_SHORT_LABEL[m] || m;
}

/**
 * 详情页的单行「实时校验」（v0.55 / v0.56 修 bugB）。
 *
 * 和编辑器里用的是同一个 SniffPanel，但**启动权只在用户手上**：
 *   · 挂载本身不发 sniff:start —— 旧实现「挂载即启动」的后果是：关抽屉再打开同一条
 *     详情就等于自动跑了一次校验（浏览器自己弹出来，用户莫名其妙）；
 *   · 只有父组件判定「这一次点击的 nonce 还没启动过」（autoStart）时才发；
 *   · 面板关闭 / 抽屉关闭 / 换一条记录 都由父组件统一 stop 一次并清掉 target。
 *
 * 详情是只读的：没有顺序走查、不写回 elements、不调 saveRecord。
 */
export function DetailElementSniff({
  url,
  target,
  browser,
  autoStart,
  onStarted,
  onBrowserChange,
  onClose
}: {
  url: string;
  target: SniffTarget;
  /** 用哪个浏览器（auto / edge / chrome），每次 start / highlight / reopen 都带上 */
  browser: SniffBrowser;
  /** 一次性闸门：父组件算好的「这一次点击还没启动过」 */
  autoStart: boolean;
  /** 真的发起了启动：父组件记下这个 nonce，重挂载不会再自动跑 */
  onStarted: () => void;
  onBrowserChange: (b: SniffBrowser) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<SniffPhase>(autoStart ? 'starting' : 'idle');
  const [busy, setBusy] = useState(!!autoStart);
  const [resp, setResp] = useState<any>(null);
  const [error, setError] = useState('');
  /** 「浏览器已切换，重新点校验生效」这类一次性提示 */
  const [notice, setNotice] = useState('');
  const phaseRef = useRef<SniffPhase>(autoStart ? 'starting' : 'idle');
  const aliveRef = useRef(true);
  /** 连点闸门（bugD）：busy 是异步 state，点两下会真起两个会话 */
  const gateRef = useRef(false);
  /** 每一轮请求的序号：过期回包直接丢掉 */
  const roundRef = useRef(0);
  /** 浏览器选择（切换后只影响下一次启动） */
  const browserRef = useRef<SniffBrowser>(browser);

  /** 统一调用入口：后端永远 resolve 一个统一返回体，这里再兜一层，面板不会白屏 */
  const request = async (method: string, payload?: any): Promise<any> => {
    try {
      const fn = (api as any)[method];
      if (typeof fn !== 'function') {
        return { ok: false, message: '当前环境没有 ' + method + '（浏览器预览不支持实时校验）' };
      }
      const raw = await fn(payload);
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e: any) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  };

  /** 落状态：序号过期（用户又点了别的 / 面板已关）就整包丢掉 */
  const finish = (round: number, res: any) => {
    if (round !== roundRef.current) return;
    gateRef.current = false;
    if (!aliveRef.current) return;
    const next = settleSniff(res, phaseRef.current);
    phaseRef.current = next.phase;
    setPhase(next.phase);
    setResp(next.resp);
    setError(next.error);
    setBusy(false);
  };

  const start = async () => {
    if (gateRef.current) return;
    gateRef.current = true;
    roundRef.current += 1;
    const round = roundRef.current;
    setBusy(true);
    setError('');
    setNotice('');
    if (!url) {
      // 没有页面地址：走同一条落状态路径，错误文案由面板照原文显示
      finish(round, { ok: false, running: false, message: '这条记录还没有页面地址（url），先填上再校验' });
      return;
    }
    const res = await request('sniffStart', {
      url,
      name: target.name,
      mode: target.mode,
      selector: target.selector,
      browser: browserRef.current
    });
    finish(round, res);
  };

  useEffect(() => {
    aliveRef.current = true;
    if (autoStart) {
      // 先告诉父组件「这个 nonce 已经启动过」，再发请求：重挂载时 autoStart 会是 false
      onStarted();
      start();
    }
    // autoStart 为 false（重挂载 / 只是把面板显示出来）就什么都不发 —— 这就是 bugB 的闸门
    // 面板开着时定期问一次：用户把浏览器窗口关了 → 切到「会话已结束」
    const timer = setInterval(() => {
      if (phaseRef.current !== 'ready') return;
      request('sniffStatus').then((res) => {
        if (!aliveRef.current) return;
        if (res && res.ok !== false && res.running === false) {
          phaseRef.current = 'ended';
          setPhase('ended');
          setBusy(false);
        }
      });
    }, 2500);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rehighlight = async () => {
    if (gateRef.current) return;
    gateRef.current = true;
    roundRef.current += 1;
    const round = roundRef.current;
    setBusy(true);
    setError('');
    const res = await request('sniffHighlight', {
      name: target.name,
      mode: target.mode,
      selector: target.selector,
      browser: browserRef.current
    });
    finish(round, res);
  };

  const reopen = async () => {
    if (gateRef.current) return;
    gateRef.current = true;
    roundRef.current += 1;
    const round = roundRef.current;
    setBusy(true);
    setError('');
    const res = await reopenWithBrowser(request, url, browserRef.current);
    finish(round, res);
  };

  /**
   * 切换浏览器：只影响下一次启动（不打断正在跑的会话），存由父组件写 localStorage。
   * 会话已经存在时给一句「已切换，重新点校验生效」。
   */
  const changeBrowser = (b: SniffBrowser) => {
    browserRef.current = b;
    onBrowserChange(b);
    if (phaseRef.current === 'ready' || phaseRef.current === 'starting') {
      setNotice('已切换，重新点校验生效');
    }
  };

  /** 「结束校验」和右上角 X 一样：收起面板（stop 由父组件统一调一次，见 stopVerify） */
  const stopAndClose = () => onClose();

  return (
    <SniffPanel
      phase={phase}
      busy={busy}
      resp={resp}
      error={error}
      sequential={false}
      index={0}
      total={0}
      currentName={target.name}
      currentModeLabel={elementModeLabel(target.mode)}
      currentSelector={target.selector}
      skipped={[]}
      url={url}
      browser={browser}
      browserNotice={notice}
      onBrowserChange={changeBrowser}
      onClose={stopAndClose}
      onHighlight={rehighlight}
      onReopen={reopen}
      onStopBrowser={stopAndClose}
      onNext={() => {}}
      onRepeat={rehighlight}
      onSkip={() => {}}
      onStopSeq={() => {}}
      onRestart={start}
    />
  );
}

type Props = {
  record: any;
  conf: any;
  linkMap: Record<string, string>;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: () => void;
  onLogRun?: (record: any) => void;
  /**
   * v0.63：抽屉头部 `extra` 里、编辑按钮**前面**的自定义动作。
   * 目前只有「流程模板」用（去生成代码并自动载入）；其余集合不传就不渲染。
   */
  extraActions?: React.ReactNode;
};

export default function RecordDetail({ record, conf, linkMap, onClose, onEdit, onDeleted, onLogRun, extraActions }: Props) {
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  /** 复制整条的格式：详情（人话）/ JSON / cURL（只有接口记录有） */
  const [copyFormat, setCopyFormat] = useState<'text' | 'json' | 'curl'>('text');
  /**
   * 元素表格里「复制定位语句」按哪种语言出（v0.71）。
   *
   * 为什么详情页要给这个切换：详情页没有「当前生成目标」的上下文，
   * 但用户很可能正在维护 Python 项目 —— 固定出 Java 语句对他没用。
   * 表级的切换（不是每行一个）是因为：一次浏览里语言不会变，
   * 而且每行再塞一个下拉会把 520px 的表格挤爆。
   */
  const [copyLang, setCopyLang] = useState<'java' | 'python'>('java');
  const [varOpen, setVarOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linkRows, setLinkRows] = useState<any[]>([]);
  const [staleIds, setStaleIds] = useState<number[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  // 这个接口最近跑过的几次（接口测试 / 压测都算一个「执行」）
  const [runs, setRuns] = useState<any[]>([]);
  const [opts, setOpts] = useState<OptionsMap>(getOptionsSync());
  /**
   * 详情页的单行实时校验：目标行 + 递增 nonce（每次点 ▶ 自增一次）。
   *
   * **只有用户刚点了 ▶ 才启动**（bugB）：nonce 是「这一次点击」的身份，
   * 父组件用 startedNonce 记住已经启动过哪个 nonce —— 抽屉重开、面板重挂载
   * 都只是把面板显示出来，不会再一次 sniffStart。
   */
  const [verify, setVerify] = useState<{ target: SniffTarget; nonce: number } | null>(null);
  /** 已经真正启动过的 nonce（父组件持有：子组件重挂载也不会忘） */
  const startedNonce = useRef(0);
  /** nonce 发号器（只增不减） */
  const verifySeq = useRef(0);
  /** 当前会话是否还在（卸载 / 抽屉关闭时据此决定要不要 stop） */
  const verifyRef = useRef<{ target: SniffTarget; nonce: number } | null>(null);
  /** 校验用哪个浏览器（bugC）：初始化读 localStorage，切换时写回 */
  const [sniffBrowser, setSniffBrowser] = useState<SniffBrowser>(() => readSniffBrowser());
  /** 上一条记录 id：换了记录就是上一轮校验结束 */
  const lastRecordId = useRef(record ? record.id : '');

  /**
   * 关掉详情页的校验会话：清掉 target（重开抽屉 / 切到另一行都不会自动再启动）
   * 并调一次 sniffStop（幂等；浏览器不会留在后台没人管）。
   */
  const stopVerify = () => {
    const had = !!verifyRef.current;
    verifyRef.current = null;
    setVerify(null);
    if (!had) return;
    const fn = (api as any).sniffStop;
    if (typeof fn === 'function') Promise.resolve(fn()).catch(() => {});
  };

  const isApis = conf.key === 'apis';

  /**
   * 按当前格式复制整条。
   *
   * 三种格式的用途不同（用户反馈原来只有一种，粘出来是 JSON，不好读）：
   *   text → 给人看的（账号按「账号：xxx 密码：yyy」展开）
   *   json → 给程序/接口调试用（完整原始数据）
   *   curl → 只有接口记录有，直接粘终端能跑
   */
  const copyAsFormat = async () => {
    const d = record.data || {};
    if (copyFormat === 'json') {
      await copy(JSON.stringify(d, null, 2), true, 'JSON 已复制');
      return;
    }
    if (copyFormat === 'curl') {
      await copy(buildCurl(record), false, 'cURL 已复制');
      return;
    }
    await copy(recordToText(record, conf, links), true, '整条已复制');
  };
  const recordId = record ? record.id : '';

  /** 换成另一条记录（点别的行）＝ 上一轮校验结束：清目标 + 关浏览器，绝不自动开始下一条 */
  useEffect(() => {
    if (lastRecordId.current === recordId) return;
    lastRecordId.current = recordId;
    stopVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);

  /** 记录被清空（点空白处关抽屉 / 删除后 onDeleted）同样收尾 */
  useEffect(() => {
    if (record) return;
    stopVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record]);

  /** 详情整个卸载（切页面 / 关窗口）也把浏览器收掉 */
  useEffect(
    () => () => {
      if (!verifyRef.current) return;
      verifyRef.current = null;
      const fn = (api as any).sniffStop;
      if (typeof fn === 'function') Promise.resolve(fn()).catch(() => {});
    },
    []
  );

  /**
   * 打开详情时把浏览器选择与 localStorage 对齐。
   *
   * 这个组件在集合页里是常驻挂载的（record 为 null 时 early return），
   * useState 只跑一次 —— 用户可能刚在编辑表单里改过选择，这里要重新读一遍，
   * 否则详情页会拿旧选择去拉起浏览器。
   */
  const detailOpen = !!record;
  useEffect(() => {
    if (!detailOpen) return;
    setSniffBrowser(readSniffBrowser());
  }, [detailOpen, recordId]);

  useEffect(() => {
    loadOptions().then(setOpts).catch(() => {});
  }, []);

  /** 读这个接口挂的用例；顺带标出目录里已经找不到的（用例改名/删除），只做灰字，不报警 */
  const reloadLinks = async () => {
    if (!isApis || !recordId) return;
    try {
      const rows = (await api.linksForApi(recordId)) || [];
      setLinkRows(rows);
      try {
        const known = knownCaseKeys(await loadCaseIndex());
        setStaleIds(
          known ? rows.filter((r: any) => !known.has(caseKey(r.file_path, r.case_title))).map((r: any) => r.id) : []
        );
      } catch (e) {
        setStaleIds([]);
      }
    } catch (e) {
      /* 关联读不到不影响详情本体 */
    }
  };

  useEffect(() => {
    if (isApis && recordId) reloadLinks();
  }, [isApis, recordId]);

  /** 读最近执行：读不到就当没有，不影响详情本体 */
  useEffect(() => {
    let alive = true;
    if (!isApis || !recordId) {
      setRuns([]);
      return () => {
        alive = false;
      };
    }
    api
      .records('runs')
      .then((rows: any[]) => {
        if (alive) setRuns(recentForApi(rows, recordId, 3));
      })
      .catch(() => {
        if (alive) setRuns([]);
      });
    return () => {
      alive = false;
    };
  }, [isApis, recordId]);

  const removeLink = async (row: any) => {
    try {
      await api.linkRemove(row.id);
      setLinkRows((prev) => prev.filter((r) => r.id !== row.id));
      setStaleIds((prev) => prev.filter((id) => id !== row.id));
    } catch (e: any) {
      toast('取消关联失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  const cleanStale = async () => {
    const ids = staleIds.slice();
    if (!ids.length) return;
    try {
      for (const id of ids) await api.linkRemove(id);
      setLinkRows((prev) => prev.filter((r) => ids.indexOf(r.id) < 0));
      setStaleIds([]);
      toast(`已清理 ${ids.length} 条失效关联`);
    } catch (e: any) {
      toast('清理失败：' + (e && e.message ? e.message : e), 'error');
    }
  };

  if (!record) return null;
  const data = record.data || {};

  // 关联字段：把 id 换成「名称 · 环境」；目标记录被删了就给个明确提示，别露 id
  const links: Record<string, string> = { ...linkMap };
  for (const f of conf.fields) {
    if (f.type !== 'link') continue;
    const id = data[f.key];
    if (id && !links[id]) links[id] = '（关联记录已删除）';
  }

  const copy = async (text: string, secret = false, label = '已复制') => {
    if (!text) {
      toast('没有内容可复制', 'warning');
      return;
    }
    await api.copy(String(text), secret);
    toast(label);
  };

  /** 打开站点；浏览器不允许程序填表，那就顺手把密码放剪贴板 */
  const openInBrowser = async () => {
    const url = String(data.url || '').trim();
    if (!url) {
      toast('这条记录没有填地址', 'warning');
      return;
    }
    await api.openUrl(url);
    try {
      const s = await api.settings();
      if (data.password && (!s || s.openCopyPassword !== false)) {
        await api.copy(String(data.password), true);
        toast('已用浏览器打开，密码已复制 —— 切过去 Ctrl+V');
        return;
      }
    } catch (e) {
      /* 忽略设置读取失败 */
    }
    toast('已用浏览器打开');
  };

  /**
   * 点元素行末的 ▶：只读地拉起实时校验（本机浏览器高亮这一行）。
   *
   * 每点一次 nonce +1：这是**用户刚刚点了**的唯一凭据，
   * 子组件只在「这个 nonce 还没启动过」时才发 sniff:start（bugB）。
   * 详情页不进入编辑：不写回 elements、不保存记录，换个位置只看事实。
   */
  const startVerify = (el: PageElement) => {
    const name = String(el.name || '').trim();
    const selector = String(el.selector || '').trim();
    if (!name || !selector) {
      toast('这一行还没填元素名称或定位值，先补上再校验', 'warning');
      return;
    }
    const url = String(data.url || '').trim();
    if (!url) {
      toast('这条记录还没有页面地址（url），先填上再校验', 'warning');
      return;
    }
    verifySeq.current += 1;
    const next = { target: { name, mode: normalizeMode(el.mode), selector }, nonce: verifySeq.current };
    verifyRef.current = next;
    setVerify(next);
  };

  /** 切换浏览器：写 localStorage + 更新面板受控值；下一次 start / highlight / reopen 生效 */
  const changeSniffBrowser = (b: SniffBrowser) => {
    writeSniffBrowser(b);
    setSniffBrowser(b);
  };

  /** 删除 = 移入回收站（软删除）：说清楚「还能找回」，别让人以为数据没了 */
  const remove = async () => {
    setDeleting(true);
    try {
      await api.removeRecord(record.id);
      toast('已移入回收站');
      onDeleted();
    } catch (e: any) {
      toast('移入回收站失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const renderValue = (f: any) => {
    const raw = data[f.key];
    if (raw === undefined || raw === null || raw === '') {
      // 「我的备注」是整个镜像模块最值钱的字段，空着就给一句灰字指路（不是警告）
      if (f.key === 'myNote') {
        return <span className="muted">还没写 —— 点「编辑」在「我的备注」里填，同步永不覆盖</span>;
      }
      return <span className="muted">—</span>;
    }

    switch (f.type) {
      case 'secret':
        return (
          <Space size={2}>
            <span className="mono">{showSecret[f.key] ? raw : '••••••••'}</span>
            <Button
              type="text"
              size="small"
              icon={showSecret[f.key] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              onClick={() => setShowSecret((prev) => ({ ...prev, [f.key]: !prev[f.key] }))}
            />
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(raw, true, '已复制，30 秒后自动清空剪贴板')} />
          </Space>
        );
      case 'select': {
        const opt = fieldOptions(f, opts).find((o: any) => o.value === raw);
        return <Tag color={opt ? opt.color : 'default'}>{opt ? opt.label : raw}</Tag>;
      }
      case 'multiselect': {
        const arr = asArray(raw);
        if (!arr.length) return <span className="muted">—</span>;
        return (
          <span className="multi-cell">
            {arr.map((v) => {
              const opt = fieldOptions(f, opts).find((o: any) => o.value === v);
              return (
                <Tag key={v} color={opt && opt.color ? opt.color : 'default'}>
                  {opt ? opt.label || v : v}
                </Tag>
              );
            })}
          </span>
        );
      }
      case 'link':
        return links[raw] ? <span>{links[raw]}</span> : <span className="muted">（关联记录已删除）</span>;
      case 'url':
        return (
          <Space size={2}>
            <a onClick={() => api.openUrl(raw)}>{raw}</a>
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(raw, false, '地址已复制')} />
          </Space>
        );
      case 'markdown':
        return (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(String(marked.parse(String(raw)))) }}
          />
        );
      case 'datetime':
        return <span className="muted">{fmtTime(Number(raw), true)}</span>;
      case 'change': {
        // 上次同步的结构变化（参数 / 请求体 / 响应体），描述文案改了不算
        let parsed: any = null;
        try {
          parsed = JSON.parse(String(raw));
        } catch (e) {
          parsed = null;
        }
        if (!parsed || !Array.isArray(parsed.changes) || !parsed.changes.length) return <span className="muted">—</span>;
        return (
          <div className="change-block">
            <div className="change-tags">
              {parsed.changes.map((c: any) => (
                <Tag key={c.kind + (c.detail || '')} bordered={false} className="change-tag" title={c.detail || ''}>
                  {c.label}
                </Tag>
              ))}
            </div>
            {parsed.at ? <span className="muted change-at">{fmtTime(Number(parsed.at), true)}</span> : null}
          </div>
        );
      }
      case 'code':
        // headers / body / paramTable / respExample 提供「表格 / JSON」切换
        if (['headers', 'body', 'paramTable', 'respExample'].includes(f.key)) {
          return <JsonTableToggle fieldKey={f.key} raw={String(raw)} />;
        }
        return (
          <div className="code-block">
            <pre className="mono">{String(raw)}</pre>
          </div>
        );
      case 'accounts':
        return <AccountsEditor value={String(raw)} onChange={() => {}} readOnly />;
      case 'scene':
        return <ScenePicker value={String(raw)} onChange={() => {}} readOnly />;
      case 'metrics':
        return <MetricsTable data={data} />;
      case 'vars':
        return <VarsEditor value={String(raw)} onChange={() => {}} readOnly />;
      case 'textarea':
        return <div className="multiline">{String(raw)}</div>;
      default:
        // 标了 copyable 的普通字段（如「账号」）给个和密码同款的复制按钮
        return f.copyable ? (
          <Space size={2}>
            <span>{String(raw)}</span>
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(String(raw), false, `${f.label}已复制`)} />
          </Space>
        ) : (
          <span>{String(raw)}</span>
        );
    }
  };

  /**
   * 「元素定位器」字段：只读的 3 列表格（名称 / 定位值 / 说明）。
   *
   * 原来走 default 分支的 `String(raw)`，把整个 JSON 数组甩成一行：
   * `[{"name":"usernameInput","selector":"#username","desc":"用户名输入框"},…]`
   * 名字和定位值挤在一起，对不上号。现在按元素一行渲染。
   *
   * 用原生 table + 已有的 .jmx-table 样式，不上 antd Table：
   *   抽屉只有 560px，antd Table 自带的边框 / 分页 / 空态插图在这里纯属占地方；
   *   而且 .field-value 是 pre-wrap（会把单元格的空白撑开），原生 table 更好控。
   */
  const renderElements = (f: any, raw: any) => {
    // 复用 PageElementsEditor 的 parseElements：JSON 数组 / 老的「name = selector」多行文本都认
    const rows = parseElements(raw);

    /**
     * 一个元素 → 它对应的定位语句（v0.71）。
     *
     * 复用 shared/locatorModes 的 previewLocatorCode —— 和编辑页的悬停预览、
     * 以及代码生成器**同一个函数**，三处不会漂移。
     * 语言按表级开关（copyLang），只出定位器本身、不带变量名：
     * 用户明确说过带变量名容易和代码里已有的冲突，贴过去还得手改。
     */
    const locatorCodeOf = (el: any): string => {
      const sel = String((el && el.selector) || '').trim();
      if (!sel) return '';
      try {
        return previewLocatorCode(String((el && el.mode) || 'css'), sel, copyLang) || '';
      } catch (e) {
        return '';
      }
    };

    const head = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: rows.length ? 6 : 0 }}>
        <span className="field-label" style={{ flex: 'none', paddingTop: 0 }}>
          {f.label}
          {rows.length ? `（${rows.length} 个）` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {/*
          v0.71：单个元素定位语句的「复制语言」。
          一次浏览里语言不会变，所以放在表级（每行再塞下拉会把 520px 的表格挤爆）。
          标题写清楚它影响的是「行末那个复制图标」。
        */}
        {rows.length ? (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, color: 'var(--text-3)' }}
            title="行末复制图标输出哪种语言的定位语句"
          >
            <button
              type="button"
              onClick={() => setCopyLang('java')}
              style={{
                border: 'none',
                background: copyLang === 'java' ? 'var(--primary-bg, #efedff)' : 'transparent',
                color: copyLang === 'java' ? 'var(--primary-text, #5b4dd6)' : 'var(--text-3)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 11,
                cursor: 'pointer'
              }}
            >
              Java
            </button>
            <button
              type="button"
              onClick={() => setCopyLang('python')}
              style={{
                border: 'none',
                background: copyLang === 'python' ? 'var(--primary-bg, #efedff)' : 'transparent',
                color: copyLang === 'python' ? 'var(--primary-text, #5b4dd6)' : 'var(--text-3)',
                borderRadius: 4,
                padding: '1px 6px',
                fontSize: 11,
                cursor: 'pointer'
              }}
            >
              Python
            </button>
          </span>
        ) : null}
        {/* 表格上方的复制：复制的是可粘贴的纯文本（制表符分隔），不是 markdown 表格 */}
        {rows.length ? (
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            title="复制成可直接粘贴的文本（制表符分隔）"
            onClick={() => copy(elementsToText(raw), false, '元素定位器已复制')}
          >
            复制
          </Button>
        ) : null}
      </div>
    );

    // 没有元素时只给一个「无」，不渲染空表格（用户明确要求）
    if (!rows.length) {
      return (
        <div className="field-row" key={f.key} style={{ display: 'block' }}>
          {head}
          <span className="muted">无</span>
        </div>
      );
    }

    return (
      <div className="field-row" key={f.key} style={{ display: 'block' }}>
        {head}
        <table className="jmx-table elements-table" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ width: '32%' }}>名称</th>
              <th style={{ width: '40%' }}>定位值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((el, i) => {
              const tag = elementModeTag(el.mode);
              return (
                <tr key={i}>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
                    {String(el.name || '').trim() || <span className="muted">-</span>}
                  </td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                        {/* 语义化定位（mode ≠ css）给个小标签，一眼看出不是 CSS 选择器 */}
                        {tag ? (
                          <Tag bordered={false} color="blue" style={{ marginInlineEnd: 4, fontSize: 11 }} title="语义化定位（不是 CSS 选择器）">
                            {tag}
                          </Tag>
                        ) : null}
                        {String(el.selector || '').trim() || <span className="muted">-</span>}
                      </span>
                      {/*
                        v0.71：复制这一行的**定位语句**（不是原始选择器）。
                        用户反馈：以前要复制单个元素的定位语句，得先进编辑页 hover 预览再划选，
                        多一步且 tooltip 会消失 —— 这里给一键复制。
                        图标本身 hover 时用 tooltip 显示「将复制什么」，省掉一个独立的预览区。
                      */}
                      {String(el.selector || '').trim() ? (
                        <Tooltip
                          placement="left"
                          mouseEnterDelay={0.25}
                          overlayStyle={{ maxWidth: 420 }}
                          title={
                            <div style={{ lineHeight: 1.6 }}>
                              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 2 }}>将复制这一段：</div>
                              <code className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                                {locatorCodeOf(el) || '（这条定位值生成不出代码）'}
                              </code>
                            </div>
                          }
                        >
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            aria-label="复制定位语句"
                            disabled={!locatorCodeOf(el)}
                            onClick={(e) => {
                              e.stopPropagation();
                              const code = locatorCodeOf(el);
                              if (code) copy(code, false, '定位语句已复制');
                            }}
                            style={{ flex: 'none', paddingInline: 2 }}
                          />
                        </Tooltip>
                      ) : null}
                    </div>
                  </td>
                  <td style={{ wordBreak: 'break-all' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ flex: 1 }}>{String(el.desc || '').trim() || <span className="muted">-</span>}</span>
                      {/*
                        行末的 ▶：只读的实时校验入口（浏览器高亮这一行）。
                        动作不进编辑表单，也不改 elements —— 详情页只负责「点验」。
                      */}
                      <Button
                        type="text"
                        size="small"
                        icon={<CaretRightOutlined />}
                        aria-label="实时校验这一行"
                        title="实时校验：用本机浏览器高亮这一行的元素（只读，不改数据）"
                        disabled={!String(el.selector || '').trim()}
                        onClick={(e) => {
                          e.stopPropagation();
                          startVerify(el);
                        }}
                        style={{ flex: 'none', paddingInline: 2 }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <Drawer
      open={!!record}
      // 点空白处 / Esc 关抽屉也当「这一轮校验结束」：清目标 + 关浏览器（bugB）
      onClose={() => {
        stopVerify();
        onClose();
      }}
      width={560}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{record.title}</span>
          {isApis && data.source === 'openapi' ? (
            <Tag color="blue" style={{ fontSize: 11 }} title="从 Apifox 导出文件同步来的">
              Apifox
            </Tag>
          ) : null}
          {!conf.noFavorite && record.favorite ? <StarFilled style={{ color: '#f5b301', fontSize: 12 }} /> : null}
          {(record.tags || []).map((t: string) => (
            <Tag key={t} style={{ fontSize: 11 }}>
              {t}
            </Tag>
          ))}
        </div>
      }
      extra={
        <Space size={4}>
          {/* v0.63：集合页可以往抽屉头部塞自己的动作（例如流程模板的「去生成代码」） */}
          {extraActions || null}
          <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
            编辑
          </Button>
          <Popconfirm
            title="移入回收站？"
            description="之后可以在回收站里恢复"
            okText="移入回收站"
            cancelText="取消"
            onConfirm={remove}
          >
            <Button size="small" danger icon={<DeleteOutlined />} title="移入回收站" loading={deleting} />
          </Popconfirm>
        </Space>
      }
    >
      {/*
        详情体单独包一层错误边界：一条脏数据（比如某字段是意料之外的结构）
        不该把整个集合页顶掉 —— React 18 里没人接的 render 异常会卸载整棵树，
        用户看到的是整窗白屏。这里兜住之后，抽屉里给一句人话 + 重试/关闭，
        列表和其它功能照常用。key 用记录 id：换一条记录会自动重建边界。
      */}
      <ErrorBoundary
        key={recordId || 'none'}
        scope={'record-detail:' + (conf && conf.key ? conf.key : '')}
        fallback={(err: Error, reset: () => void) => (
          <div className="detail-broken">
            <StateEmpty
              kind="failed"
              object="这条记录"
              title="这条记录渲染失败了"
              desc="数据没丢，只是某个字段的格式不对。其他记录不受影响：换一条看，或者先去编辑里把那个字段清掉。"
              detail={String((err && err.message) || err)}
              action={{ label: '重试', onClick: reset }}
              secondary={{ label: '关闭详情', onClick: onClose }}
            />
          </div>
        )}
      >
        <div className="detail-actions">
        {conf.actions && conf.actions.includes('open') && data.url ? (
          <Button size="small" icon={<ExportOutlined />} onClick={openInBrowser}>
            打开地址
          </Button>
        ) : null}
        {/* 原来这里有独立的「复制 cURL」按钮，已经并进下面的格式下拉了 */}
        {conf.key === 'sqls' ? (
          <Button size="small" icon={<CopyOutlined />} onClick={() => setVarOpen(true)}>
            填充变量并复制
          </Button>
        ) : null}
        {/* 复制整条：先选格式再复制（用户要求加下拉） */}
        <Space.Compact size="small">
          <Select
            size="small"
            value={copyFormat}
            onChange={(v) => setCopyFormat(v as any)}
            style={{ width: 120 }}
            options={[
              { value: 'text', label: '整条详情' },
              { value: 'json', label: 'JSON' },
              ...(isApis ? [{ value: 'curl', label: 'cURL' }] : [])
            ]}
          />
          <Button icon={<CopyOutlined />} onClick={copyAsFormat}>
            复制
          </Button>
        </Space.Compact>
      </div>

      {conf.fields
        .filter((f: any) => !f.hideInDetail)
        .filter((f: any) => matchOnlyFor(f, data.kind))
        .filter((f: any) => {
          // 虚拟字段（metrics / vars 等）不存数据，不能按 data[f.key] 判空
          if (f.type === 'metrics') return true;
          return !(f.hideEmpty && (data[f.key] === undefined || data[f.key] === null || data[f.key] === ''));
        })
        .map((f: any) =>
          // 元素定位器自己撑满整行（3 列表格塞进 74px 标签右边会挤成一条），其余的照常左标签右值
          f.type === 'elements' ? (
            renderElements(f, data[f.key])
          ) : (
            <div className="field-row" key={f.key}>
              <div className="field-label">{f.label}</div>
              <div className="field-value">{renderValue(f)}</div>
            </div>
          )
        )}

      <div className="field-row">
        <div className="field-label">更新于</div>
        <div className="field-value muted" style={{ fontSize: 12.5 }}>
          {fmtTime(record.updated_at, true)}
        </div>
      </div>

      {isApis ? (
        <div className="run-panel">
          <div className="run-panel-head">
            <span className="run-panel-title">最近执行{runs.length ? ` · ${runs.length} 次` : ''}</span>
            <span className="spacer" />
            {onLogRun ? (
              <Button type="link" size="small" onClick={() => onLogRun(record)}>
                记一笔
              </Button>
            ) : null}
          </div>
          {runs.length ? (
            <div className="run-list">
              {runs.map((r: any) => {
                // 类型标签统一从 RUN_KIND_OPTIONS 取：加了 ui 之后不能再按
                // 「perf / 其它」二分（否则 UI 测试的执行会被标成接口测试）
                const kindOpt = RUN_KIND_OPTIONS.find((o: any) => o.value === r.data.kind);
                const kind = kindOpt ? kindOpt.label : '接口测试';
                const line = runLine(r.data);
                const at = r.data.ranAt || r.updated_at;
                return (
                  <div className="run-item" key={r.id}>
                    <span className={'run-dot tone-' + resultTone(r.data.result)} />
                    <span className="run-kind">{kind}</span>
                    <span className="run-line" title={line || r.title}>
                      {line || r.title}
                    </span>
                    {r.data.report ? (
                      <Button type="text" size="small" icon={<LinkOutlined />} title="打开报告" onClick={() => api.openUrl(String(r.data.report))} />
                    ) : null}
                    <span className="run-at muted">{fmtTime(Number(at), true)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="run-empty muted">还没跑过 —— 在 Apifox 跑完记一笔，以后就能在这看到它挂没挂</div>
          )}
        </div>
      ) : null}

      {isApis ? (
        <div className="link-panel">
          <div className="link-panel-head">
            <Button size="small" icon={<LinkOutlined />} onClick={() => setLinkOpen(true)}>
              关联用例{linkRows.length ? ` [${linkRows.length}]` : ''}
            </Button>
            <span className="spacer" />
            {staleIds.length ? (
              <Button type="link" size="small" onClick={cleanStale}>
                清理 {staleIds.length} 条失效
              </Button>
            ) : null}
          </div>
          {linkRows.length ? (
            <div className="link-list">
              {linkRows.map((row: any) => {
                const stale = staleIds.indexOf(row.id) >= 0;
                return (
                  <div className="link-item" key={row.id}>
                    <FileTextOutlined className="link-item-icon" />
                    <span className={'link-title' + (stale ? ' is-stale' : '')} title={row.case_title}>
                      {row.case_title}
                    </span>
                    <span className="link-file muted" title={row.file_path}>
                      {stale ? '已失效 · ' : ''}
                      {row.file_path}
                    </span>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      title="取消关联"
                      onClick={() => removeLink(row)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="link-empty muted">还没关联 —— 只挂会反复测、又容易变的接口就行</div>
          )}
        </div>
      ) : null}

      <CaseLinkModal open={linkOpen} record={record} onClose={() => setLinkOpen(false)} onSaved={() => reloadLinks()} />

      <VarFillModal open={varOpen} text={String(data.sql || '')} title="填充变量并复制 SQL" onClose={() => setVarOpen(false)} />

      {/*
        详情页的单行实时校验：**只有点过 ▶ 才会启动**。
        key 带 nonce → 每点一次换一个实例；autoStart 由父组件的 startedNonce 决定，
        重开抽屉 / 面板重挂载都不会再自动跑一次（bugB）。
        关面板 / 关抽屉 / 换记录都由 stopVerify 统一 stop 一次并清掉目标。
      */}
      {verify ? (
        <DetailElementSniff
          key={(recordId || 'none') + ':' + String(verify.nonce)}
          url={String(data.url || '').trim()}
          target={verify.target}
          browser={sniffBrowser}
          autoStart={verify.nonce !== startedNonce.current}
          onStarted={() => {
            startedNonce.current = verify.nonce;
          }}
          onBrowserChange={changeSniffBrowser}
          onClose={stopVerify}
        />
      ) : null}
      </ErrorBoundary>
    </Drawer>
  );
}