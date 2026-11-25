/**
 * 集合能力解析。
 *
 * 唯一事实源是 shared/collections.js 里的 `capabilities`（纯数据）；
 * 这里只做三件事：
 *   1. 给出稳定的 TS 类型，页面不再到处 `conf.xxx` 摸字段；
 *   2. 老数据 / 漏配集合兜底 —— 按旧字段（actions / sync / noFavorite / openField）
 *      推导出等价能力，保证升级后界面不变；
 *   3. 收口「某个动作是否支持」的判断，页面不再按集合 key 写 if/else。
 *
 * 加第 6 个集合：只改 shared/collections.js 的 capabilities，本文件不用动。
 */

export type CopyKind = 'accounts' | 'sql' | 'curl' | 'text';

/** 页头「⋯」菜单里的动作；顺序即菜单顺序，由 capabilities.headerActions 决定 */
export type HeaderAction =
  | 'importData'
  | 'importTemplate'
  | 'exportData'
  | 'refresh'
  | 'importReport'
  | 'importCurl'
  | 'syncOpenApi'
  | 'impact';

/**
 * 「关联报告」能力：报告目录存在哪个字段、什么条件下才该给入口。
 *
 * 为什么要带 when：
 *   runs 里 reportDir 有两个来源 —— Allure 归档（kind=api，报告分析页能解析）
 *   和 jtl 压测导入（kind=perf，目录里是 JMeter 的报告，报告分析页解析不了）。
 *   只看「有 reportDir」会给压测记录挂一个点了就报错的图标，
 *   所以条件也写进能力里，页面只做通用判断，不认识 kind 的语义。
 */
export interface LinkedReportCapability {
  /** 报告目录存在哪个字段里（一般是 reportDir） */
  field: string;
  /** 只有这个字段等于这个值时才显示入口；缺省 = 都显示 */
  when?: { field: string; equals: string };
}

export interface CollectionCapabilities {
  /** 有「打开地址」动作时，存地址的字段名；null = 没有这个动作 */
  open: string | null;
  /** 快速复制格式；第一项是列表行内「复制」按钮的行为 */
  copyKinds: CopyKind[];
  /** 外部同步源（目前只有 openapi）；null = 不同步 */
  sync: string | null;
  /** 详情里是否展示「最近执行」 */
  showRunLog: boolean;
  /** 是否支持收藏（false = 工具条不出现「收藏」chip） */
  favorite: boolean;
  /** 页头「⋯」菜单动作，顺序即展示顺序 */
  headerActions: HeaderAction[];
  /** 名称列宽百分比（0~100），其余列按权重分剩下的宽度 */
  titleWidthPct: number;
  /**
   * 「关联报告」锚点；null = 这个集合没有关联报告。
   *
   * 存字段名而不是布尔值：页面拿它去 `record.data[字段名]` 取值，
   * 不需要认识集合 key，也不用知道报告目录到底存在哪个字段里。
   */
  linkedReport: LinkedReportCapability | null;
}

const DEFAULT_HEADER_ACTIONS: HeaderAction[] = ['importData', 'importTemplate', 'exportData', 'refresh'];

const KNOWN_HEADER_ACTIONS: HeaderAction[] = [
  'importData',
  'importTemplate',
  'exportData',
  'refresh',
  'importReport',
  'importCurl',
  'syncOpenApi',
  'impact'
];

function asHeaderActions(value: any): HeaderAction[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x: any): x is HeaderAction => KNOWN_HEADER_ACTIONS.indexOf(x) >= 0);
}

function asCopyKinds(value: any): CopyKind[] {
  if (!Array.isArray(value)) return [];
  const allowed: CopyKind[] = ['accounts', 'sql', 'curl', 'text'];
  return value.filter((x: any): x is CopyKind => allowed.indexOf(x) >= 0);
}

/**
 * 旧字段兜底：只用于老备份 / 漏配 capabilities 的集合。
 * 新集合请直接在 shared/collections.js 写 capabilities。
 */
function legacyCopyKinds(conf: any): CopyKind[] {
  const actions = Array.isArray(conf && conf.actions) ? conf.actions : [];
  if (actions.indexOf('sql') >= 0) return ['sql'];
  if (actions.indexOf('curl') >= 0) return ['curl', 'text'];
  if (actions.indexOf('open') >= 0) return ['accounts'];
  return ['text'];
}

function legacyTitleWidthPct(conf: any): number {
  const listFields = Array.isArray(conf && conf.listFields) ? conf.listFields : [];
  // 站点有账号列，内容长；名称列收窄给账号让位
  return listFields.indexOf('accounts') >= 0 ? 32 : 50;
}

/**
 * 「关联报告」能力：字段必须是这个集合里真实存在的（when.field 同理）。
 *
 * 光看配置不够 —— 字段名写错（比如 reports）会让每条记录都渲染出一个
 * 点了没反应的图标；这里对不上就当没有，宁可少一个入口也不给假入口。
 *
 * 兼容两种写法：
 *   字符串          → 'reportDir'（无条件）
 *   对象            → { field: 'reportDir', when: { field: 'kind', equals: 'api' } }
 */
function asLinkedReport(conf: any, value: any): LinkedReportCapability | null {
  const fields = Array.isArray(conf && conf.fields) ? conf.fields : [];
  const has = (key: any) => typeof key === 'string' && key.trim() !== '' && fields.some((f: any) => f && f.key === key);

  const raw = typeof value === 'string' ? { field: value } : value;
  if (!raw || typeof raw !== 'object') return null;

  const field = String(raw.field || '').trim();
  if (!field || !has(field)) return null;

  const when = raw.when && typeof raw.when === 'object' ? raw.when : null;
  if (when) {
    const wf = String(when.field || '').trim();
    const eq = when.equals === undefined || when.equals === null ? '' : String(when.equals);
    if (!wf || !has(wf) || !eq) return { field };
    return { field, when: { field: wf, equals: eq } };
  }
  return { field };
}

export function capabilitiesOf(conf: any): CollectionCapabilities {
  const raw = (conf && conf.capabilities) || {};
  const actions = Array.isArray(conf && conf.actions) ? conf.actions : [];
  const sync = raw.sync !== undefined ? raw.sync || null : (conf && conf.sync) || null;
  const open =
    raw.open !== undefined
      ? raw.open || null
      : actions.indexOf('open') >= 0
        ? (conf && conf.openField) || 'url'
        : null;

  const copyKinds = asCopyKinds(raw.copyKinds);
  const headerActions = asHeaderActions(raw.headerActions);
  const linkedReport = asLinkedReport(conf, raw.linkedReport);

  return {
    open,
    copyKinds: copyKinds.length ? copyKinds : legacyCopyKinds(conf),
    sync,
    showRunLog: raw.showRunLog !== undefined ? !!raw.showRunLog : sync === 'openapi',
    favorite: raw.favorite !== undefined ? !!raw.favorite : !(conf && conf.noFavorite),
    headerActions: headerActions.length ? headerActions : DEFAULT_HEADER_ACTIONS,
    titleWidthPct:
      typeof raw.titleWidthPct === 'number' && raw.titleWidthPct > 0
        ? Math.min(90, Math.max(20, raw.titleWidthPct))
        : legacyTitleWidthPct(conf),
    linkedReport
  };
}

/** 某个页头动作是否属于这个集合 */
export function hasHeaderAction(caps: CollectionCapabilities, action: HeaderAction): boolean {
  return caps.headerActions.indexOf(action) >= 0;
}