/**
 * 浏览器预览用的内存实现。
 * 只有在没有 window.api（即不是 Electron 环境）时才启用，不影响正式运行。
 */

import { COLLECTION_MAP } from '../shared/collections';
import { buildTemplate, templateFileName } from '../shared/importTemplate';

const now = () => Date.now();
const uid = () => 'r_' + now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 预览用的「上次同步变更」样例：两个挂了用例、一个没挂（灰色不催） */
const impactFixture = (at: number) => ({
  at,
  affectedCases: 3,
  changed: [
    {
      apiId: 'p1',
      name: '创建退款单',
      method: 'POST',
      url: 'https://test.refund.local/api/v1/refund',
      changes: [
        { kind: 'req-param-add', label: '必填参数 +1', detail: 'X-Request-Id' },
        { kind: 'resp-field-add', label: '响应体字段 +1', detail: 'failReason' }
      ],
      cases: [
        {
          filePath: '模块A重构/TC_模块A重构_第三次迭代_混合_2026_10_08_修正版.md',
          caseTitle: '工作台快捷操作区渲染 9 入口且「网点」位序正确'
        },
        { filePath: 'TC_回归测试_极简链路用例_20260701.md', caseTitle: '余额核销核心回归链' }
      ]
    },
    {
      apiId: 'p2',
      name: '查询订单详情',
      method: 'GET',
      url: 'https://test.order.local/api/v1/order/{{orderNo}}',
      changes: [{ kind: 'resp-field-add', label: '响应体字段 +2', detail: 'payTime, refundStatus' }],
      cases: [
        { filePath: '模块A重构/TC_模块A重构_第三次迭代_混合_2026_10_08_修正版.md', caseTitle: '仅展示「网点」引导气泡且四功能引导不显示' }
      ]
    },
    {
      apiId: 'p9',
      name: '关闭订单',
      method: 'POST',
      url: 'https://test.order.local/api/v1/order/close',
      changes: [{ kind: 'req-param-add', label: '必填参数 +1', detail: 'closeReason' }],
      cases: []
    }
  ]
});

const SEED: Record<string, any[]> = {
  sites: [
    {
      id: 's1',
      collection: 'sites',
      title: '资产管理系统-管理后台',
      data: {
        name: '资产管理系统-管理后台',
        url: 'https://test.asset.local/admin',
        env: ['test'],
        accounts: [
          { label: '管理员', account: 'admin', password: 'Admin@123', role: ['admin'], isDefault: true, note: '能改配置' },
          { label: '普通用户', account: 'user01', password: 'User@123', role: ['user'], isDefault: false, note: '只读权限' }
        ],
        note: '入口 /login，测试环境见站点地址'
      },
      tags: ['核心'],
      favorite: true,
      created_at: now() - 86400000 * 3,
      updated_at: now() - 3600000
    },
    {
      id: 's2',
      collection: 'sites',
      title: '退款服务-运营端',
      data: {
        name: '退款服务-运营端',
        url: 'https://test.refund.local',
        env: ['staging'],
        accounts: [
          { label: '测试账号', account: 'qa_refund', password: 'Refund#2026', role: ['user'], isDefault: true, note: '预发环境专用' }
        ],
        note: '预发环境，数据每天凌晨重置'
      },
      tags: ['退款'],
      favorite: false,
      created_at: now() - 86400000 * 2,
      updated_at: now() - 7200000
    },
    {
      id: 's3',
      collection: 'sites',
      title: '支付网关-沙箱',
      data: {
        name: '支付网关-沙箱',
        url: 'https://sandbox.pay.local',
        env: ['other'],
        accounts: [
          { label: '沙箱账号', account: 'sandbox', password: 'pay123456', role: ['user'], isDefault: true, note: '只用于联调' }
        ],
        note: '只用于联调，不要提交真实卡号'
      },
      tags: ['支付'],
      favorite: false,
      created_at: now() - 86400000 * 6,
      updated_at: now() - 86400000
    }
  ],
  sqls: [
    {
      id: 'q1',
      collection: 'sqls',
      title: '按订单号查退款流水',
      data: {
        name: '按订单号查退款流水',
        db: 'test_order',
        sql:
          'select r.refund_no, r.order_no, r.amount, r.status, r.created_at\nfrom t_refund r\nwhere r.order_no = {{orderNo}}\n  and r.created_at >= {{startDate}}\norder by r.created_at desc;',
        vars: '{{orderNo}} = 订单号；{{startDate}} = 起始日期',
        note: 'order_no 上有索引'
      },
      tags: ['退款'],
      favorite: true,
      created_at: now() - 86400000 * 7,
      updated_at: now() - 3600000 * 2
    },
    {
      id: 'q2',
      collection: 'sqls',
      title: '查重复支付单',
      data: {
        name: '查重复支付单',
        db: 'test_pay',
        sql: 'select pay_no, count(*) c from t_payment group by pay_no having c > 1;',
        vars: '',
        note: '排查并发时用'
      },
      tags: ['支付'],
      favorite: false,
      created_at: now() - 86400000 * 9,
      updated_at: now() - 86400000 * 2
    }
  ],
  apis: [
    {
      id: 'p1',
      collection: 'apis',
      title: '创建退款单',
      data: {
        name: '创建退款单',
        method: 'POST',
        url: 'https://test.refund.local/api/v1/refund',
        headers: 'Content-Type: application/json\nAuthorization: Bearer {{token}}',
        body: '{\n  "orderNo": "{{orderNo}}",\n  "amount": 99.9,\n  "reason": "用户申请"\n}',
        note: '幂等键放 header: X-Request-Id',
        // 以下为「从 Apifox 同步」带过来的镜像字段（详情里只读展示）
        module: '退款',
        summary: '创建退款单。金额不能超过订单实付；同一订单可多次部分退款。',
        params: 'header: X-Request-Id* (string) 幂等键\nheader: Authorization* (string) Bearer token',
        reqSchema:
          '{\n  "type": "object",\n  "required": ["orderNo", "amount"],\n  "properties": {\n    "orderNo": { "type": "string", "example": "SO20261102001", "description": "订单号" },\n    "amount": { "type": "number", "example": 99.9, "description": "退款金额，两位小数" },\n    "reason": { "type": "string", "example": "用户申请", "description": "退款原因" }\n  }\n}',
        respSchema:
          '{\n  "type": "object",\n  "properties": {\n    "code": { "type": "integer", "example": 0 },\n    "data": {\n      "type": "object",\n      "properties": {\n        "refundNo": { "type": "string", "example": "RF20261102001" },\n        "status": { "type": "string", "enum": ["PENDING", "SUCCESS", "FAILED"], "example": "SUCCESS" }\n      }\n    }\n  }\n}',
        completeness: 'ok',
        source: 'openapi',
        syncedAt: now() - 1800000,
        // 上次同步检出的结构变化（详情里只读展示，表单里不出现）
        lastChange: JSON.stringify({
          at: now() - 1800000,
          changes: [
            { kind: 'req-param-add', label: '必填参数 +1', detail: 'X-Request-Id' },
            { kind: 'resp-field-add', label: '响应体字段 +1', detail: 'data.failReason' }
          ]
        }),
        myNote: '走的是支付网关，退款成功回调有 3~5 秒延迟，断言前先 sleep；失败用例要用已超过 90 天的订单。'
      },
      tags: ['退款', '核心'],
      favorite: true,
      created_at: now() - 86400000 * 3,
      updated_at: now() - 1800000
    },
    {
      id: 'p2',
      collection: 'apis',
      title: '查询订单详情',
      data: {
        name: '查询订单详情',
        method: 'GET',
        url: 'https://test.order.local/api/v1/order/{{orderNo}}',
        headers: 'Authorization: Bearer {{token}}',
        body: '',
        note: '',
        // 缺描述 + 缺示例：预览里能看到灰字「缺描述 / 缺示例」长什么样
        module: '订单',
        summary: '',
        params: 'path: orderNo* (string) 订单号',
        respSchema:
          '{\n  "type": "object",\n  "properties": {\n    "orderNo": { "type": "string" },\n    "status": { "type": "string", "description": "订单状态" }\n  }\n}',
        completeness: 'missing-desc',
        source: 'openapi',
        syncedAt: now() - 86400000 * 3,
        myNote: ''
      },
      tags: [],
      favorite: false,
      created_at: now() - 86400000 * 8,
      updated_at: now() - 86400000 * 3
    }
  ],
  runs: [
    {
      id: 'r1',
      collection: 'runs',
      title: '退款主链路 · 10 并发 1 分钟',
      data: {
        name: '退款主链路 · 10 并发 1 分钟',
        kind: 'perf',
        result: 'ok',
        ranAt: now() - 86400000 * 1,
        apiRef: 'p1',
        env: 'test',
        scene: 'refund_main.jmx',
        report: 'https://apifox.example.com/perf/refund-20261102',
        concurrency: 10,
        duration: '60s',
        tps: 320,
        p95: 180,
        errRate: 0.2,
        conclusion: '达标（目标 P95 < 300ms）。余量还有，瓶颈在支付网关回调，不在本服务。'
      },
      tags: [],
      favorite: false,
      created_at: now() - 86400000,
      updated_at: now() - 86400000
    },
    {
      id: 'r2',
      collection: 'runs',
      title: '退款接口 · 改动后回归',
      data: {
        name: '退款接口 · 改动后回归',
        kind: 'api',
        result: 'bad',
        ranAt: now() - 3600000,
        apiRef: 'p1',
        env: 'test',
        scene: '退款回归（Apifox 测试场景）',
        report: '',
        passCount: 11,
        failCount: 2,
        conclusion: 'X-Request-Id 必填后，两条老用例没带这个头，已补。'
      },
      tags: [],
      favorite: false,
      created_at: now() - 3500000,
      updated_at: now() - 3500000
    }
  ]
,
  pages: [
    {
      id: 'pg1',
      collection: 'pages',
      title: '登录页',
      data: {
        name: '登录页',
        url: '/login',
        project: 'OTA-automation',
        elements: '[{"name":"usernameInput","selector":"#username","desc":"用户名输入框"},{"name":"passwordInput","selector":"#password","desc":"密码输入框"},{"name":"submitBtn","selector":"button[type=submit]","desc":"登录按钮"}]',
        note: '演示数据'
      },
      tags: []
    }
  ],
  /**
   * 流程模板：积木区「保存为流程」写出来的样子（预览里给一条现成的，方便直接点「载入流程」）。
   * steps 是 JSON 字符串，和真机一致；pomMode / pomClass / pomVar 是当时的 POM 快照。
   */
  flows: [
    {
      id: 'fl1',
      collection: 'flows',
      title: '登录页流程-1125',
      data: {
        name: '登录页流程-1125',
        pageId: 'pg1',
        pageName: '登录页',
        steps: JSON.stringify([
          { actionId: 'goto', params: { url: '/login' } },
          {
            actionId: 'fill',
            params: { el: 'usernameInput', text: 'admin' },
            elementMode: 'css',
            elementSelector: '#username'
          },
          {
            actionId: 'click',
            params: { el: 'submitBtn' },
            elementMode: 'css',
            elementSelector: 'button[type=submit]'
          }
        ]),
        pomMode: 'generated',
        pomClass: 'LoginPage',
        pomVar: 'loginPage',
        note: '演示数据：登录成功链路，POM 用本页生成的'
      },
      tags: [],
      favorite: false,
      created_at: now() - 3600000,
      updated_at: now() - 3600000
    },
    /**
     * 接口流程（kind: 'api'）：接口积木「保存为流程」写出来的样子。
     * 上面那条 UI 流程**故意没有 kind** —— 预览里正好能看出「老记录当 ui」的兜底。
     */
    {
      id: 'fl2',
      collection: 'flows',
      title: '接口流程-1125',
      data: {
        name: '接口流程-1125',
        kind: 'api',
        baseUrl: 'http://localhost:8080',
        testName: 'testOrderFlow',
        steps: JSON.stringify([
          {
            actionId: 'call',
            params: {
              apiId: 'p1',
              apiName: '登录',
              as: 'loginResp',
              method: 'POST',
              path: '/api/login',
              headers: [{ k: 'Content-Type', v: 'application/json' }],
              body: '{"username":"admin","password":"123"}'
            }
          },
          {
            actionId: 'extract-json',
            params: { from: 'loginResp', path: '$.data.token', as: 'token' }
          },
          {
            actionId: 'call',
            params: {
              apiId: 'p2',
              apiName: '查询订单详情',
              as: 'orderResp',
              method: 'GET',
              path: '/api/order',
              headers: [{ k: 'Authorization', v: 'Bearer ${token}' }],
              body: ''
            }
          },
          { actionId: 'assert-status', params: { from: 'orderResp', code: 200 } }
        ]),
        note: '演示数据：接口流程（登录 → 提取 token → 查订单 → 断言 200）'
      },
      tags: [],
      favorite: false,
      created_at: now() - 1800000,
      updated_at: now() - 1800000
    }
  ]
};

/** 预览模式的压测报告（真机上是扫描目录得到的） */
const MOCK_REPORTS: any[] = [
  {
    dir: 'D:\\demo\\jmx\\report',
    name: '压测结果',
    mtime: Date.now() - 3600e3,
    sources: ['statistics.json', 'jtl'],
    samples: 50,
    fails: 0,
    errRate: 0,
    tps: 29.41,
    durationS: 1.699,
    concurrency: 2,
    avg: 4.04,
    min: 1,
    max: 87,
    p50: 2,
    p90: 4,
    p95: 4,
    p99: 87,
    labels: [{ label: '商品详情', samples: 50, fails: 0, errRate: 0, avg: 4.04, p95: 4 }],
    warnings: [],
    files: {
      jtl: 'D:\\demo\\jmx\\report\\result.jtl',
      statistics: 'D:\\demo\\jmx\\report\\html-report\\statistics.json',
      htmlIndex: 'D:\\demo\\jmx\\report\\html-report\\index.html'
    }
  }
];

function seedData() {
  const db: Record<string, any[]> = {};
  for (const key of Object.keys(SEED)) db[key] = SEED[key].map((r) => ({ ...r, data: { ...r.data }, tags: [...r.tags] }));
  // 和真实迁移 v4/v5 对齐：env 是数组；sites 的账号在 accounts 数组里
  for (const r of db['sites'] || []) {
    const d = r.data || {};
    if (!Array.isArray(d.env)) d.env = d.env ? [d.env] : [];
    if (!Array.isArray(d.accounts)) d.accounts = [];
  }
  return db;
}

/** 预览模式的选项配置（真机上是 meta 表，这里放内存） */
function seedOptions() {
  const env: any[] = [
    { value: 'test', label: '测试', color: 'green' },
    { value: 'staging', label: '预发', color: 'gold' },
    { value: 'prod', label: '生产', color: 'red' },
    { value: 'other', label: '其他', color: 'default' }
  ];
  const role = ['超级管理员', '只读'];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(SEED)) {
    for (const r of SEED[key]) for (const t of r.tags || []) {
      if (!seen.has(t)) {
        seen.add(t);
        tags.push(t);
      }
    }
  }
  return { env, role, tags };
}

export function installMockIfNeeded() {
  if ((window as any).api) return;
  // eslint-disable-next-line no-console
  console.log('[mock] 未检测到 Electron API，使用内存数据预览');

  const db = seedData();
  const options = seedOptions();
  let settings = {
    autoLockMinutes: 10,
    clipboardClearSeconds: 30,
    openCopyPassword: true,
    closeAction: 'tray',
    // 备份保留份数：每日备份与 jmx 写回共用一个数（真机默认也是 10）
    backupKeep: 10,
    hasPin: false,
    pin: '',
    casesDir: 'D:\\demo\\cases',
    allureDir: '',
    jmxDir: 'D:\\demo\\jmx',
    jmeterPath: 'D:\\apache-jmeter-5.4.3\\bin\\jmeter.bat',
    reportDir: 'D:\\demo\\jmx\\report',
    kbDir: 'D:\\demo\\kb',
    notesDir: 'D:\\demo\\notes',
    projectDir: 'D:\\demo\\Project',
    javaHome: 'C:/mock/jdk-17',
    pythonPath: 'C:/mock/python.exe',
    mvnPath: 'C:/mock/mvn.cmd',
    themeColor: 'purple',
    bgImage: '',
    bgOpacity: 85,
    bgTextMode: 'auto',
    bgOverlay: 35,
    bgOverlayColor: 'dark'
  };
  let locked = false;

  // 用例 ↔ 接口关联（预览模式的内存版，和真实 store 的软键一致）
  const CASE_FILE = '模块A重构/TC_模块A重构_第三次迭代_混合_2026_10_08_修正版.md';
  let linkSeq = 10;
  let linkRows: any[] = [
    {
      id: 1,
      file_path: CASE_FILE,
      case_title: '工作台快捷操作区渲染 9 入口且「网点」位序正确',
      case_index: 1,
      api_id: 'p1',
      source: 'manual',
      created_at: now() - 3600000
    }
  ];

  const findCollection = (collection: string) => {
    if (!db[collection]) db[collection] = [];
    return db[collection];
  };

  const clone = (v: any) => JSON.parse(JSON.stringify(v));

/** 这条记录是不是在回收站里（关联查询要据此过滤） */
const isTrashed = (id: string) => {
  for (const key of Object.keys(db)) {
    const hit = db[key].find((r: any) => r.id === id);
    if (hit) return (hit.deleted_at || 0) > 0;
  }
  return true;
};

  /**
   * 预览模式的「局部编辑」状态（L2 写回）。
   *
   * 真机里 editable 来自 jmx:detail、写回由主进程改文件；浏览器里没有文件系统，
   * 就把这份基线放在内存，让两条主路径都能真跑：
   *   · 写回成功 → 改内存值 + stamp 前移，界面重新拉详情能看到新值；
   *   · STALE   → 任意输入框填 `stale`（大小写不限）模拟「文件被外部改动」；
   *   · BAD_VALUE → 线程组三个数字字段填非整数会被逐条拒绝；
   *   · NOT_EDITABLE → loops / 断言值留空（文件里没有这一项）的输入框是禁用的。
   */
  let jmxStampSeq = 1;
  /**
   * 写回成功后的 pruned（本次清理掉的旧备份份数）在预览里**交替**给 0 / 2：
   * 第 1 次写回 0（工作区还干净）、第 2 次 2（假装已经攒了 10 份以上旧 .bak 被清掉），
   * 这样两种 toast 文案在浏览器里各点一次保存就能各看到一次。
   */
  let jmxWriteSeq = 0;
  /**
   * 线程组基线：type 跟真后端一致（thread / setup / teardown），
   * index 是全文顺序下三类合起来的序号 —— 和 jmxScan 里那一行的 threadGroups 顺序对齐，
   * 预览里写回后才能就地更新左侧列表（不用靠重扫）。
   */
  const jmxEdit: { stamp: string; groups: any[]; assertions: any[] } = {
    stamp: 'mock-stamp-' + jmxStampSeq,
    groups: [
      { index: 0, name: 'setUp 登录准备', type: 'setup', numThreads: '1', rampUp: '0', loops: '' },
      { index: 1, name: '用户模块', type: 'thread', numThreads: '10', rampUp: '2', loops: '1' },
      { index: 2, name: '门店模块', type: 'thread', numThreads: '5', rampUp: '1', loops: '3' }
    ],
    assertions: [
      { index: 0, name: '响应断言-状态码200', testField: 'resp_code', value: '200' },
      { index: 1, name: '断言-返回体成功', testField: 'success', value: '' }
    ]
  };
  /** 每次返回新快照（真 IPC 也是深拷贝回来，界面拿这份基线算 from→to） */
  const jmxEditable = () => clone({ stamp: jmxEdit.stamp, groups: jmxEdit.groups, assertions: jmxEdit.assertions });

  /**
   * 扫描行里的线程组（预览用）。
   *
   * 数值优先取内存 editable：真机「写回 → 重扫」是重读文件，能看到刚写进去的值；
   * 预览里没有文件系统，不同步的话走静默重扫兜底时列表会看起来回退到旧值。
   * fallback 只给 editable 里没有的组（支付模块 / 模块B业务）用。
   */
  const jmxScanGroup = (name: string, type: string, enabled: boolean, fallback: any) => {
    const hit = jmxEdit.groups.find((g: any) => g.name === name && String(g.type || 'thread') === type);
    const src = hit || fallback;
    return { type, name, enabled, numThreads: src.numThreads, rampUp: src.rampUp, duration: '', loops: src.loops, scheduler: false };
  };

  /* ============================================================
   * 页面元素「实时校验」的预览实现
   *
   * 浏览器预览里没有 CDP、没有本地进程，**不假装能起浏览器**：
   * 默认五个通道一律回
   *   { ok:false, running:false, message:'浏览器预览模式不支持实时校验，请在安装版里使用' }
   * 界面把这句原文显示出来（错误态本身也就能在浏览器里验到）。
   *
   * 但面板还有十来个状态（多个匹配 / 找不到 / 不可见 / iframe / shadow DOM /
   * 会话被关掉…），只看错误态等于没验过。所以留一个**显式调试开关**：
   *   · 地址栏 `?sniff=cycle`  → 每调一次 highlight/start 走下一个场景（默认推荐）
   *   · `?sniff=ready | multi | invisible | missing | iframe | shadow | error | closed`
   *   · 运行中也可以在控制台敲 `__SNIFF_MODE = 'multi'` 即时切换
   * 不带开关 = 上面那句「不支持」（绝不自作主张起浏览器）。
   * ============================================================ */

  /** 统一返回体的「什么都不成立」版本 */
  const sniffUnsupported = () => ({
    ok: false,
    running: false,
    browser: '',
    browserChosen: '',
    url: '',
    name: '',
    mode: '',
    selector: '',
    found: 0,
    total: 0,
    visible: false,
    inIframe: false,
    reason: '',
    message: '浏览器预览模式不支持实时校验，请在安装版里使用'
  });

  /** 调试开关：优先看控制台里现敲的 __SNIFF_MODE，其次地址栏 ?sniff= */
  const sniffModeName = () => {
    try {
      const fromWindow = String((window as any).__SNIFF_MODE || '').trim();
      if (fromWindow) return fromWindow.toLowerCase();
      const q = new URLSearchParams(window.location.search).get('sniff');
      return String(q || '').trim().toLowerCase();
    } catch (e) {
      return '';
    }
  };
  const sniffDebug = () => !!sniffModeName();
  /** 装配版里起浏览器要 1~3 秒，预览里给一小段延迟，好让「启动中」这个状态看得见 */
  const sniffDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let sniffRunning = false;
  let sniffStep = 0;
  let sniffUrl = '';
  let sniffName = '';
  let sniffMode = 'css';
  let sniffSelector = '';
  /**
   * 浏览器选择（v0.56）：界面传 { browser: 'auto'|'edge'|'chrome' }，默认 auto。
   * 真机上 auto 由主进程读系统默认浏览器；预览里固定按「系统默认 = chrome」演，
   * 这样用户默认 Chrome 却拉起 Edge 的那种回显差异在浏览器里也看得见。
   */
  let sniffBrowserChosen = 'auto';
  let sniffBrowser = 'chrome';

  /** 记住这次按哪个选择起的，并算回「实际用哪个」 */
  const applyBrowserChoice = (choice: any) => {
    const v = String(choice === undefined || choice === null ? '' : choice)
      .trim()
      .toLowerCase();
    sniffBrowserChosen = v === 'edge' || v === 'chrome' ? v : 'auto';
    sniffBrowser = sniffBrowserChosen === 'auto' ? 'chrome' : sniffBrowserChosen;
    return sniffBrowser;
  };

  /** 当前这次解析出的统一返回体底稿（真机里 url/name/mode/selector 是回显上次的目标） */
  const sniffBase = () => ({
    ok: true,
    running: sniffRunning,
    browser: sniffBrowser,
    browserChosen: sniffBrowserChosen,
    url: sniffUrl,
    name: sniffName,
    mode: sniffMode,
    selector: sniffSelector,
    found: 0,
    total: 0,
    visible: true,
    inIframe: false,
    reason: '',
    message: ''
  });

  /**
   * cycle 模式的九个场景，和面板文案一一对应，点一次「重新高亮 / 下一个」走一个：
   *   1 已在页面上高亮 → 2 匹配到 3 个 → 3 元素不可见 → 4 没找到 →
   *   5 iframe → 6 shadow DOM → 7 ok:false 原文 → 8 恢复正常 → 9 会话已结束
   */
  const SNIFF_STEPS: Array<() => any> = [
    () => Object.assign(sniffBase(), { found: 1, total: 1, visible: true }),
    () => Object.assign(sniffBase(), { found: 3, total: 3, visible: true }),
    () => Object.assign(sniffBase(), { found: 1, total: 1, visible: false }),
    () => Object.assign(sniffBase(), { found: 0, total: 0, visible: true, reason: 'not-found' }),
    () => Object.assign(sniffBase(), { found: 0, total: 0, visible: true, inIframe: true, reason: 'in-iframe' }),
    () => Object.assign(sniffBase(), { found: 0, total: 0, visible: true, reason: 'shadow-dom' }),
    () => Object.assign(sniffBase(), { ok: false, found: 0, message: '没找到浏览器：请先安装 Microsoft Edge' }),
    () => Object.assign(sniffBase(), { found: 1, total: 1, visible: true }),
    () => {
      sniffRunning = false;
      return Object.assign(sniffBase(), { running: false, message: '浏览器窗口已被关闭' });
    }
  ];

  const sniffResult = () => {
    const mode = sniffModeName();
    const b = sniffBase();
    if (mode === 'cycle' || mode === 'all') {
      const step = SNIFF_STEPS[sniffStep % SNIFF_STEPS.length];
      sniffStep += 1;
      return step();
    }
    if (mode === 'multi') return Object.assign(b, { found: 3, total: 3, visible: true });
    if (mode === 'invisible') return Object.assign(b, { found: 1, total: 1, visible: false });
    if (mode === 'missing' || mode === 'notfound') return Object.assign(b, { found: 0, total: 0, visible: true, reason: 'not-found' });
    if (mode === 'iframe') return Object.assign(b, { found: 0, total: 0, visible: true, inIframe: true, reason: 'in-iframe' });
    if (mode === 'shadow') return Object.assign(b, { found: 0, total: 0, visible: true, reason: 'shadow-dom' });
    if (mode === 'error') return Object.assign(b, { ok: false, found: 0, message: '没找到浏览器：请先安装 Microsoft Edge' });
    // ready / closed / 其他：正常命中一个
    return Object.assign(b, { found: 1, total: 1, visible: true });
  };

  const api = {
    init: async () => ({
      locked,
      version: '0.1.0-preview',
      dataDir: '(浏览器预览，无数据目录)',
      encryptionAvailable: false,
      settings: {
        autoLockMinutes: settings.autoLockMinutes,
        clipboardClearSeconds: settings.clipboardClearSeconds,
        openCopyPassword: settings.openCopyPassword, closeAction: settings.closeAction,
        backupKeep: settings.backupKeep,
        hasPin: settings.hasPin,
        workspaceDir: settings.workspaceDir,
        casesDir: settings.casesDir,
        jmxDir: settings.jmxDir,
        jmeterPath: settings.jmeterPath,
        reportDir: settings.reportDir,
        allureDir: settings.allureDir,
        kbDir: settings.kbDir,
        notesDir: settings.notesDir,
        projectDir: settings.projectDir,
        javaHome: settings.javaHome,
        pythonPath: settings.pythonPath,
        mvnPath: settings.mvnPath,
        themeColor: settings.themeColor,
        bgImage: settings.bgImage,
        bgOpacity: settings.bgOpacity,
        bgTextMode: settings.bgTextMode,
        bgOverlay: settings.bgOverlay,
        bgOverlayColor: settings.bgOverlayColor
      }
    }),
    lock: async () => {
      locked = true;
      return true;
    },
    unlock: async (pin: string) => {
      if (!settings.hasPin || pin === settings.pin) {
        locked = false;
        return { ok: true };
      }
      return { ok: false };
    },
    setPin: async (oldPin: string, pin: string) => {
      if (settings.hasPin && oldPin !== settings.pin) return { ok: false, message: '原密码不对' };
      if (!pin || pin.length < 4) return { ok: false, message: '密码至少 4 位' };
      settings.pin = pin;
      settings.hasPin = true;
      return { ok: true };
    },
    clearPin: async (pin: string) => {
      if (settings.hasPin && pin !== settings.pin) return { ok: false, message: '密码不对' };
      settings.hasPin = false;
      settings.pin = '';
      return { ok: true };
    },
    /**
     * 返回完整 settings（原来是白名单，加新字段就会漏 —— 踩坑 #100）。
     * 真机的 settings:get 返回的就是全部字段，预览也该一致。
     */
    settings: async () => ({ ...settings }),
    saveSettings: async (patch: any) => {
      settings = { ...settings, ...patch };
      /**
       * 和真机一致：backupKeep 会被收成 1..100 的整数，非法值回默认 10。
       * 预览里不模拟这一步的话，用户会看到「填 0 也存进去了」，
       * 而真机上会被悄悄纠正 —— 那种差异最难查。
       */
      const n = Math.floor(Number(settings.backupKeep));
      settings.backupKeep = isFinite(n) && n > 0 ? Math.max(1, Math.min(100, n)) : 10;
      return { ...settings };
    },
    records: async (collection: string) =>
      // 回收站里的不出现（和真机 store.list 一致）
      clone(findCollection(collection).filter((r: any) => !(r.deleted_at || 0))),
    record: async (id: string) => {
      for (const key of Object.keys(db)) {
        const hit = db[key].find((r: any) => r.id === id && !(r.deleted_at || 0));
        if (hit) return clone(hit);
      }
      return null;
    },
    saveRecord: async (input: any) => {
      const list = findCollection(input.collection);
      // 和真实 store 一样：新标签自动收进配置
      for (const t of input.tags || []) {
        if (t && options.tags.indexOf(t) < 0) options.tags.push(t);
      }
      const conf = (COLLECTION_MAP as any)[input.collection] || { titleField: 'name' };
      const titleField = conf.titleField || 'name';
      const title = String((input.data && input.data[titleField]) || '').trim() || '(未命名)';
      if (input.id) {
        const idx = list.findIndex((r) => r.id === input.id);
        const updated = {
          ...list[idx],
          title,
          data: clone(input.data),
          tags: input.tags || [],
          favorite: !!input.favorite,
          updated_at: now()
        };
        list[idx] = updated;
        return clone(updated);
      }
      const created = {
        id: uid(),
        collection: input.collection,
        title,
        data: clone(input.data),
        tags: input.tags || [],
        favorite: !!input.favorite,
        deleted_at: 0,
        created_at: now(),
        updated_at: now()
      };
      list.unshift(created);
      return clone(created);
    },
    /** 删除 = 移入回收站（软删除），和真实 store 语义一致：只打 deleted_at */
    removeRecord: async (id: string) => {
      let hit: any = null;
      for (const key of Object.keys(db)) {
        const row = db[key].find((r: any) => r.id === id);
        if (row) {
          hit = row;
          break;
        }
      }
      if (!hit) return false;
      if (!hit.deleted_at) hit.deleted_at = now(); // 已删过不刷新时间（幂等）
      return true;
    },

    /* ---- 回收站（deleted_at > 0 就是在回收站里）---- */
    trashList: async () => {
      const out: any[] = [];
      for (const key of Object.keys(db)) {
        for (const r of db[key]) if ((r.deleted_at || 0) > 0) out.push(r);
      }
      out.sort((a, b) => (b.deleted_at || 0) - (a.deleted_at || 0));
      return clone(out);
    },
    trashCount: async () => {
      let n = 0;
      for (const key of Object.keys(db)) {
        for (const r of db[key]) if ((r.deleted_at || 0) > 0) n++;
      }
      return n;
    },
    trashRestore: async (id: string) => {
      for (const key of Object.keys(db)) {
        const row = db[key].find((r: any) => r.id === id && (r.deleted_at || 0) > 0);
        if (row) {
          row.deleted_at = 0;
          return true;
        }
      }
      return false;
    },
    trashPurge: async (id: string) => {
      let found = false;
      for (const key of Object.keys(db)) {
        const before = db[key].length;
        db[key] = db[key].filter((r: any) => r.id !== id);
        if (db[key].length !== before) found = true;
      }
      if (found) linkRows = linkRows.filter((r) => r.api_id !== id);
      return found;
    },
    trashClear: async () => {
      let removed = 0;
      const purgedApis: string[] = [];
      for (const key of Object.keys(db)) {
        const keep: any[] = [];
        for (const r of db[key]) {
          if ((r.deleted_at || 0) > 0) {
            removed++;
            if (r.collection === 'apis') purgedApis.push(r.id);
          } else {
            keep.push(r);
          }
        }
        db[key] = keep;
      }
      if (purgedApis.length) linkRows = linkRows.filter((r) => purgedApis.indexOf(r.api_id) < 0);
      return { removed };
    },
    counts: async () => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(db)) {
        out[key] = db[key].filter((r: any) => !(r.deleted_at || 0)).length;
      }
      return out;
    },
    copy: async (text: string) => {
      try {
        await navigator.clipboard.writeText(String(text));
      } catch (e) {
        /* 预览环境可能没有剪贴板权限 */
      }
      return true;
    },
    openUrl: async (url: string) => {
      window.open(url, '_blank');
      return true;
    },

    /* ---- 代码调试（mock）---- */
    runnerList: async () => ({
      ok: true,
      runners: [
        { key: 'groovy', label: 'Groovy（JMeter）', desc: '用 JMeter 自带的 Groovy 跑脚本', ext: '.groovy', needs: ['java', 'jmeter'] },
        { key: 'python', label: 'Python', desc: '直接跑 Python 脚本', ext: '.py', needs: ['python'] },
        { key: 'pytest', label: 'Python（pytest）', desc: '用 pytest 跑测试文件', ext: '.py', needs: ['python'] },
        { key: 'maven', label: 'Java（Maven）', desc: '跑 Maven 项目的测试类', ext: null, needs: ['mvn', 'java'] }
      ],
      env: { java: 'C:/mock/java.exe', python: 'C:/mock/python.exe', mvn: 'C:/mock/mvn.cmd', javaHome: 'C:/mock/jdk-17', jmeter: '', playwright: { found: true, dir: 'C:/mock/ms-playwright', browsers: [{ name: 'chromium-1234', size: 427 * 1024 * 1024 }], totalSize: 427 * 1024 * 1024 } },
      jdks: [{ version: 17, home: 'C:/mock/jdk-17', name: 'jdk-17' }],
      pythons: [{ version: '3.14', path: 'C:/mock/python.exe', name: 'python' }],
      manual: { javaHome: '', pythonPath: '', mvnPath: '' }
    }),
    runnerRun: async () => ({ ok: true, runId: 'mock-run-1', cmd: 'mock', args: [], cwd: '' }),
    runnerCancel: async () => ({ ok: true }),
    projectsScan: async () => ({
      ok: true,
      root: 'D:/mock/Project',
      projects: [
        { name: 'example', dir: 'D:/mock/Project/example', type: 'maven', frameworks: [{ key: 'rest-assured', label: 'REST Assured', color: 'blue' }, { key: 'testng', label: 'TestNG', color: 'green' }], isTest: true, testDir: '' },
        { name: 'OTA-automation', dir: 'D:/mock/Project/OTA-automation', type: 'maven', frameworks: [{ key: 'playwright', label: 'Playwright', color: 'purple' }], isTest: true, testDir: '' }
      ]
    }),
    projectsTestClasses: async () => ({ ok: true, classes: ['LoginApiTest', 'RefundApiTest'] }),
    // 「在项目中定位」：预览里给一份固定的假映射，够把按钮点通；
    // 真机的映射由 electron/projects.js 的 locateTestClass 扫 src/test/java 得出
    projectsLocateTest: async (payload: any) => {
      const cls = String((payload && payload.testClass) || '').trim() || 'LoginApiTest';
      const simple = cls.split('.').filter(Boolean).pop() || cls;
      const dir = 'D:/mock/Project/example';
      return {
        ok: true,
        root: 'D:/mock/Project',
        testClass: cls,
        scanned: [dir],
        truncated: [],
        matches: [
          {
            className: simple,
            fqcn: 'com.example.' + simple,
            package: 'com.example',
            lang: 'java',
            file: dir + '/src/test/java/com/example/' + simple + '.java'
          }
        ]
      };
    },
    projectsReveal: async (file: string) => ({ ok: true, file: String(file || '') }),
    projectsPickDir: async () => ({ ok: false, canceled: true }),
    runnerOpenBrowserDir: async () => ({ ok: true, dir: 'C:/mock/ms-playwright' }),
    pickFile: async () => ({ ok: false, canceled: true }),
    pickDir: async () => ({ ok: false, canceled: true }),
    onRunnerOutput: () => () => {},
    onRunnerExit: () => () => {},

    /* ---- JMeter 脚本生成（mock）---- */
    jmxgenPreview: async () => ({
      ok: true,
      jmeterVersion: '5.6.3',
      filename: '压测计划.jmx',
      xml: '<?xml version="1.0" encoding="UTF-8"?>\n<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">\n  <hashTree>\n    <!-- mock 预览 -->\n  </hashTree>\n</jmeterTestPlan>\n'
    }),
    jmxgenSave: async () => ({ ok: false, canceled: true }),

    /* ---- MySQL / SQLite SQL 生成（mock）---- */
    sqlgenSnapshot: async (payload: any) => {
      const sq = payload && payload.dialect === 'sqlite';
      return {
        ok: true,
        sql: sq
          ? '-- 测试库快照（建备份表）（SQLite）\n-- mock 预览\n\n-- 快照：t_order → bak_t_order_20261124_120000\nCREATE TABLE "bak_t_order_20261124_120000" AS SELECT * FROM "t_order";\n'
          : '-- 测试库快照（建备份表）（MySQL）\n-- mock 预览\n\nUSE `test_db`;\n\n-- 快照：t_order → bak_t_order_20261124_120000\nCREATE TABLE `bak_t_order_20261124_120000` LIKE `t_order`;\nINSERT INTO `bak_t_order_20261124_120000` SELECT * FROM `t_order`;\n'
      };
    },
    sqlgenCleanup: async (payload: any) => {
      const sq = payload && payload.dialect === 'sqlite';
      return {
        ok: true,
        sql: sq
          ? '-- 测试数据清理（SQLite）\n-- mock 预览\n\nPRAGMA foreign_keys = OFF;\n\nDELETE FROM "t_order";\nDELETE FROM sqlite_sequence WHERE name = \'t_order\';\n\nPRAGMA foreign_keys = ON;\nVACUUM;\n'
          : '-- 测试数据清理（MySQL）\n-- mock 预览\n\nUSE `test_db`;\n\nDELETE FROM `t_order` WHERE create_time < \'2026-01-01\';\n'
      };
    },
    sqlgenRestore: async (payload: any) => {
      const sq = payload && payload.dialect === 'sqlite';
      return {
        ok: true,
        sql: sq
          ? '-- 测试数据还原（SQLite）\n-- mock 预览\n\nPRAGMA foreign_keys = OFF;\n\nDELETE FROM "t_order";\nINSERT INTO "t_order" SELECT * FROM "bak_t_order_20261124_120000";\n\nPRAGMA foreign_keys = ON;\n'
          : '-- 测试数据还原（MySQL）\n-- mock 预览\n\nUSE `test_db`;\n\nTRUNCATE TABLE `t_order`;\nINSERT INTO `t_order` SELECT * FROM `bak_t_order_20261124_120000`;\n'
      };
    },
    sqlgenListBackups: async () => ({ ok: true, list: [] }),

    /* ---- 代码生成（mock）---- */
    openapiPickFile: async () => ({ ok: false, canceled: true }),
    openapiParseFile: async () => ({
      ok: true,
      file: 'D:/demo/openapi.json',
      doc: { title: '示例模块', version: '1.0.0', baseUrl: '' },
      items: [
        { tmpId: 'tmp-0', name: '创建用户', method: 'POST', url: '/user', module: '用户', paramTable: '[]', body: '', bodyType: 'none' },
        { tmpId: 'tmp-1', name: '查用户', method: 'GET', url: '/user/{id}', module: '用户', paramTable: '[]', body: '', bodyType: 'none' }
      ]
    }),

    codegenTargets: async () => ({
      ok: true,
      targets: [
        { key: 'java-restassured', label: 'Java · REST Assured', desc: '接口测试类骨架', lang: 'java', ext: '.java', kind: 'api' },
        { key: 'python-pytest', label: 'Python · pytest + requests', desc: '接口测试类骨架', lang: 'python', ext: '.py', kind: 'api' },
        { key: 'playwright-java', label: 'Java · Playwright POM', desc: '页面对象类', lang: 'java', ext: '.java', kind: 'page' },
        { key: 'playwright-python', label: 'Python · Playwright POM', desc: '页面对象类', lang: 'python', ext: '.py', kind: 'page' },
        { key: 'pojo-java', label: 'Java · POJO（Lombok）', desc: '从 JSON 生成实体类', lang: 'java', ext: '.java', kind: 'model' },
        { key: 'dataclass-python', label: 'Python · Pydantic 模型', desc: '从 JSON 生成数据模型', lang: 'python', ext: '.py', kind: 'model' },
        // v0.64：预览里也要有，否则截图/自查看不到这个目标
        { key: 'java-playwright-base', label: 'Java · Playwright 测试基类', desc: '浏览器生命周期 + 收尾（新建自动化项目先要这个）', lang: 'java', ext: '.java', kind: 'base' }
      ]
    }),
    codegenPreview: async () => ({
      ok: true,
      filename: 'PetApiTest.java',
      code: 'package com.test.api;\n\npublic class PetApiTest {\n    @Test\n    public void testCreatePet() {\n        // mock 预览\n    }\n}\n'
    }),
    codegenSave: async () => ({ ok: false, canceled: true }),
    // 预览里没有真实文件系统：返回取消，界面走「没选到文件」的分支
    codegenPickClass: async () => ({ ok: false, canceled: true }),

    /* ---- 皮肤（mock）---- */
    skinPickImage: async () => ({ ok: false, canceled: true }),
    skinClearImage: async () => ({ ok: true }),
    skinGetImage: async () => ({ ok: true, url: '' }),

    /* ---- Allure 报告（mock）---- */
    allureScan: async () => ({ ok: true, dirs: ['D:/mock/Project/example/allure-results'] }),
    allurePickDir: async () => ({ ok: false, canceled: true }),
    allureParse: async () => ({
      ok: true,
      dir: 'D:/mock/Project/example/allure-results',
      tests: [
        { id: '1', name: '正确用户名和密码登录成功', fullName: 't1', status: 'passed', message: '', trace: '', suite: '登录', testClass: 'LoginApiTest', testMethod: 'testLogin', feature: '登录', severity: 'normal', duration: 1200, attachments: [], steps: [{ name: '构造登录请求体', status: 'passed', duration: 300, steps: [], attachments: [] }, { name: 'POST /api/login', status: 'passed', duration: 620, steps: [], attachments: [] }, { name: '断言 code=0 且 token 非空', status: 'passed', duration: 280, steps: [], attachments: [] }], stepSummary: { total: 3, passed: 3, failed: 0, skipped: 0, broken: 0 }, firstFailedStep: '' },
        { id: '2', name: '空用户名登录失败', fullName: 't2', status: 'broken', message: 'Cannot invoke "Response.getStatusCode()" because "response" is null', trace: 'java.lang.NullPointerException: Cannot invoke "Response.getStatusCode()" because "response" is null\n\tat com.example.LoginApiTest.testEmpty(LoginApiTest.java:42)\n\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)', suite: '登录', testClass: 'LoginApiTest', testMethod: 'testEmpty', feature: '登录', severity: 'normal', duration: 3000, attachments: [], steps: [{ name: '构造 username="" 的请求体', status: 'passed', duration: 240, steps: [], attachments: [] }, { name: 'POST /api/login', status: 'passed', duration: 900, steps: [], attachments: [] }, { name: '断言 HTTP 400', status: 'broken', duration: 1860, steps: [{ name: '读取响应状态码', status: 'broken', duration: 1800, steps: [], attachments: [{ name: '接口响应', source: 'mock-attach-1', type: 'text/plain' }] }], attachments: [] }], stepSummary: { total: 4, passed: 2, failed: 0, skipped: 0, broken: 2 }, firstFailedStep: '断言 HTTP 400' },
        { id: '3', name: '错误密码登录失败', fullName: 't3', status: 'broken', message: 'Cannot invoke "Response.getStatusCode()" because "response" is null', trace: '', suite: '登录', testClass: 'LoginApiTest', testMethod: 'testWrong', feature: '登录', severity: 'normal', duration: 2800, attachments: [], steps: [{ name: '构造错误密码请求体', status: 'passed', duration: 220, steps: [], attachments: [] }, { name: 'POST /api/login', status: 'passed', duration: 780, steps: [], attachments: [] }, { name: '断言 HTTP 401', status: 'broken', duration: 1800, steps: [], attachments: [] }], stepSummary: { total: 3, passed: 2, failed: 0, skipped: 0, broken: 1 }, firstFailedStep: '断言 HTTP 401' }
      ],
      summary: { total: 3, passed: 1, failed: 0, broken: 2, skipped: 0, unknown: 0, duration: 7000 },
      clusters: [
        { key: 'k1', pattern: 'Cannot invoke "<STR>" because "<STR>" is null', count: 2, sample: 'Cannot invoke "Response.getStatusCode()" because "response" is null', tests: [{ id: '2', name: '空用户名登录失败', status: 'broken' }, { id: '3', name: '错误密码登录失败', status: 'broken' }] }
      ]
    }),
    allureFlaky: async () => ({ ok: true, runs: 2, flaky: [{ fullName: 't1', name: '正确用户名和密码登录成功', history: ['passed', 'failed', 'passed'], flaky: true }], errors: [] }),
    allureArchive: async (payload: any) => ({
      ok: true,
      // 预览里不落库，给个假 id 让「去测试执行看看」的跳转能跑通
      id: 'r_mock_allure_archive',
      name: (payload && payload.name) || 'Allure 归档-11-25 09:40',
      kind: (payload && payload.kind) || 'api',
      result: payload && Number(payload.failCount) > 0 ? 'bad' : 'ok',
      dir: (payload && payload.dir) || 'D:/mock/Project/example/allure-results',
      duplicated: false,
      duplicates: 0,
      counts: {
        total: Number((payload && payload.total) || 3),
        passCount: Number((payload && payload.passCount) || 1),
        failCount: Number((payload && payload.failCount) || 2),
        skipped: 0,
        duration: Number((payload && payload.duration) || 7000)
      }
    }),

    /* ---- 代码体检（mock）---- */
    codescanCoverage: async () => ({
      ok: true,
      total: 5,
      covered: 3,
      scannedFiles: 12,
      uncovered: [
        { id: 'u1', name: '删除用户', method: 'DELETE', url: '/api/v1/user/{id}', module: '用户', hits: 0, files: [] },
        { id: 'u2', name: '导出报表', method: 'GET', url: '/api/v1/report/export', module: '报表', hits: 0, files: [] }
      ],
      coveredList: [
        { id: 'c1', name: '登录', method: 'POST', url: '/api/login', module: '认证', hits: 2, files: ['D:/mock/Project/example/AuthClient.java'] },
        { id: 'c2', name: '查用户', method: 'GET', url: '/api/v1/user', module: '用户', hits: 1, files: ['D:/mock/Project/example/UserClient.java'] },
        { id: 'c3', name: '退款', method: 'POST', url: '/api/v1/refund', module: '退款', hits: 3, files: ['D:/mock/Project/example/RefundClient.java'] }
      ],
      codePaths: []
    }),
    codescanHardcoded: async () => ({
      ok: true,
      scannedFiles: 12,
      summary: { high: 1, medium: 2, low: 1, total: 4 },
      issues: [
        { rule: 'hardcoded-password', label: '硬编码密码', severity: 'high', hint: '密码应放配置/环境变量', file: 'D:/mock/Project/example/LoginApiTest.java', line: 38, snippet: 'correctPassword = "admin123";' },
        { rule: 'sleep', label: '硬编码 sleep', severity: 'medium', hint: 'sleep 会让测试变慢且不稳定', file: 'D:/mock/Project/example/BaseApiTest.java', line: 64, snippet: 'Thread.sleep(1000L * attempt);' },
        { rule: 'sleep', label: '硬编码 sleep', severity: 'medium', hint: 'sleep 会让测试变慢且不稳定', file: 'D:/mock/Project/example/BaseApiTest.java', line: 75, snippet: 'Thread.sleep(1000L * attempt);' },
        { rule: 'absolute-xpath', label: '绝对 XPath', severity: 'low', hint: '绝对 XPath 极易失效', file: 'D:/mock/Project/example/LoginPage.java', line: 12, snippet: 'By.xpath("/html/body/div[1]/span")' }
      ]
    }),
    dataGenFile: async (payload: any) => {
      if (!payload || !payload.count) return { ok: false, message: '参数错' };
      return { ok: true, file: 'D:/demo/multi-data-' + payload.count + '-2026-11-24.csv', count: payload.count, bytes: payload.count * 20 };
    },
    dataOpenWorkspace: async () => ({ ok: true }),

    runnerDetect: async () => ({
      node: { ok: true, path: 'C:/mock/node.exe', viaElectron: false },
      python: { ok: true, path: 'C:/mock/python.exe' },
      java: { ok: true, java: 'C:/mock/jdk-17/bin/java.exe', javac: 'C:/mock/jdk-17/bin/javac.exe' },
      supported: ['javascript', 'python', 'java']
    }),

    importTemplate: async (collection?: string) => {
      const conf: any = collection ? (COLLECTION_MAP as any)[collection] : null;
      if (!conf) return { ok: false, message: '不认识的集合：' + (collection || '(空)') };
      const text = buildTemplate(conf);
      const name = templateFileName(conf);
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return { ok: true, file: name, count: 1, bytes: blob.size, collection: conf.key };
    },

    demoCount: async () => ({ ok: true, count: 11 }),
    demoClear: async () => ({ ok: true, removed: 11, errors: [] }),
    demoPaths: async () => ({
      ok: true,
      project: 'D:/demo/demo-project',
      allure: 'D:/demo/demo-allure-results'
    }),

    codescanModules: async () => ({
      ok: true,
      kind: 'api',
      total: 5,
      noModule: 0,
      modules: [
        { name: '认证', count: 2 },
        { name: '订单', count: 2 },
        { name: '退款', count: 1 }
      ]
    }),

    codescanRules: async () => ({
      ok: true,
      total: 17,
      packs: [
        { id: 'audit', label: '代码体检', count: 12 },
        { id: 'coverage', label: '接口覆盖取数', count: 5 }
      ],
      rules: [
        { id: 'ui-hard-sleep', pack: 'audit', category: 'ui', severity: 'medium', title: '硬编码等待', desc: '写死 sleep / waitForTimeout：慢机器上偶发失败，快机器上白等。改成显式等待或轮询条件。' },
        { id: 'ui-abs-xpath', pack: 'audit', category: 'ui', severity: 'low', title: '绝对 XPath', desc: '以 /html/body 开头的绝对路径，页面结构一变就整条失效。改用相对定位或 data-testid。' },
        { id: 'ui-deep-css', pack: 'audit', category: 'ui', severity: 'low', title: '深层 CSS 选择器', desc: '四级以上 a > b > c > d > e 对 DOM 层级高度敏感，加一层包裹就全挂。' },
        { id: 'ui-fragile-locator', pack: 'audit', category: 'ui', severity: 'medium', title: '按下标定位', desc: '用 [n] / :nth-child 按下标取元素，列表插一个节点就错位。改用 data-testid。' },
        { id: 'ui-text-locator', pack: 'audit', category: 'ui', severity: 'low', title: '按界面文案定位', desc: 'linkText / By.text 依赖文案，改个文案或被翻译就挂。改用 data-testid。' },
        { id: 'sec-hardcoded-url', pack: 'audit', category: 'secret', severity: 'medium', title: '硬编码地址', desc: '把环境地址写进代码，换环境要改代码。改成配置或变量占位。' },
        { id: 'sec-token-literal', pack: 'audit', category: 'secret', severity: 'high', title: '硬编码令牌', desc: 'token / secret / apiKey 直接写字符串，提交进仓库即泄露。' },
        { id: 'sec-password-literal', pack: 'audit', category: 'secret', severity: 'high', title: '硬编码口令', desc: 'password / pwd 写成字面量，等于把测试账号公开。' },
        { id: 'sec-intranet-ip', pack: 'audit', category: 'secret', severity: 'medium', title: '内网 IP 直连', desc: '10./192.168./172.16-31. 网段写死，换环境即不可用。' },
        { id: 'assert-status-only', pack: 'audit', category: 'assert', severity: 'medium', title: '只断言状态码', desc: '只校验 HTTP 状态码，不校验响应体：200 但业务 code=500 时抓不到。' },
        { id: 'assert-truthy-only', pack: 'audit', category: 'assert', severity: 'medium', title: '只判真假', desc: 'assert xxx 只是「有值/非空」，证明不了「值对」。' },
        { id: 'assert-no-assertion', pack: 'audit', category: 'assert', severity: 'high', title: '断言缺失', desc: '测试方法里一条断言都没有：这条用例永远「通过」，等于没测。' },
        { id: 'cov-spring-mapping', pack: 'coverage', category: 'coverage', severity: 'low', title: 'Spring 映射路径', desc: '@GetMapping/@PostMapping 上的路径原文。' },
        { id: 'cov-restassured', pack: 'coverage', category: 'coverage', severity: 'low', title: '链式客户端调用', desc: 'RestAssured / axios 的 .get("/x") 链式调用。' },
        { id: 'cov-python-requests', pack: 'coverage', category: 'coverage', severity: 'low', title: 'Python requests 调用', desc: 'requests.get/post/put/delete("…")。' },
        { id: 'cov-url-literal', pack: 'coverage', category: 'coverage', severity: 'low', title: '.url("/x") 字面量', desc: 'HttpRequest.url("/x") 这类显式设置路径的写法。' },
        { id: 'cov-path-literal', pack: 'coverage', category: 'coverage', severity: 'low', title: '路径字面量', desc: '任何形如 "/api/..." 的字符串字面量，以及 page.goto 的路径。' }
      ]
    }),

    codescanDeps: async () => ({
      ok: true,
      poms: 1,
      reqs: 0,
      summary: { high: 1, medium: 2, low: 0, total: 3 },
      issues: [
        {
          kind: 'maven-version-conflict',
          severity: 'high',
          title: '同一依赖声明了不同版本',
          detail: 'org.junit:junit-jupiter → 5.9.0 / 5.10.0',
          file: 'pom.xml'
        },
        {
          kind: 'maven-duplicate',
          severity: 'medium',
          title: '依赖声明了多次',
          detail: 'org.junit:junit-jupiter 在同一个 pom 里出现 2 次',
          file: 'pom.xml'
        },
        {
          kind: 'pip-duplicate',
          severity: 'medium',
          title: '同一个 requirements 里包重复',
          detail: 'requests 出现 2 次',
          file: 'requirements.txt'
        }
      ]
    }),
    codescanPickDir: async () => ({ ok: false, canceled: true }),
    hash: async (algo: string, text: string) => {
      const map: Record<string, string> = { md5: 'SHA-256', sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' };
      const buf = await crypto.subtle.digest(map[algo] || 'SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    },
    backupNow: async () => ({ file: '(预览模式无备份)' }),
    backups: async () => [],
    openDataDir: async () => '',
    getOptions: async () => clone(options),
    saveOptions: async (key: string, items: any[]) => {
      const clean = (items || [])
        .map((it: any) => (typeof it === 'string' ? it.trim() : it))
        .filter(Boolean);
      (options as any)[key] = clean;
      return clone(options);
    },
    clearData: async (target: string) =>
      target === 'local'
        ? { ok: true, target, removed: ['data.db'] }
        : { ok: true, target, removed: 0, bytes: 0 },
    exportDb: async () => ({ ok: false, message: '预览模式不支持导出整库' }),
    restoreBackup: async () => ({ ok: false, message: '预览模式不支持恢复备份' }),
    caseScan: async () => ({
      root: 'D:\\demo\\cases（预览模式模拟）',
      totalCases: 9,
      totalFiles: 4,
      errors: [],
      files: [
        {
          relPath: '模块A重构/TC_模块C券_20250109.md',
          name: 'TC_模块C券_20250109.md',
          dir: '模块A重构',
          fullPath: 'D:\\demo\\cases\\module-a\\TC_coupon_20250109.md',
          title: '模块C券',
          meta: ['生成日期: 2025-01-09'],
          kind: 'cases',
          mtime: Date.now() - 86400000 * 9,
          size: 8800,
          cases: [
            {
              kind: 'standard',
              index: 1,
              id: '#1',
              module: '新人券',
              branch: '领取',
              title: '新用户首次进入可领取新人券且金额正确',
              risk: '🔴高',
              type: '功能',
              corePath: true,
              tags: ['🔴高', '功能'],
              line: 12,
              pre: [{ depth: 1, text: '新注册且未领过券的用户' }],
              steps: [{ depth: 0, text: '进入券中心 → 点「立即领取」' }],
              expects: [{ depth: 1, text: '结果1：券到账，金额 20 元' }],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [
                { dim: 'API', text: '200 且 couponId 非空' },
                { dim: 'DB', text: 't_user_coupon 一条' },
                { dim: 'UI', text: '券中心显示已领取' }
              ],
              covers: ['R12.1']
            },
            {
              kind: 'standard',
              index: 2,
              id: '#2',
              module: '新人券',
              branch: '重复领取',
              title: '同一用户重复领取新人券应被拦截',
              risk: '🟡中',
              type: '异常',
              corePath: false,
              tags: ['🟡中', '异常'],
              line: 30,
              pre: [{ depth: 1, text: '该用户已领过新人券' }],
              steps: [{ depth: 0, text: '再次点「立即领取」' }],
              expects: [{ depth: 1, text: '结果1：提示「已领取」，不重复到账' }],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [{ dim: 'API', text: '业务码 COUPON_REPEAT' }],
              covers: ['R12.2']
            }
          ]
        },
        {
          relPath: '模块A重构/TC_模块B卡券_核销_20250210.md',
          name: 'TC_模块B卡券_核销_20250210.md',
          dir: '模块A重构',
          fullPath: 'D:\\demo\\cases\\module-a\\TC_coupon_redeem_20250210.md',
          title: '模块B卡券核销',
          meta: ['生成日期: 2025-02-10'],
          kind: 'cases',
          mtime: Date.now() - 86400000 * 6,
          size: 6600,
          cases: [
            {
              kind: 'standard',
              index: 1,
              id: '#1',
              module: '模块B卡券',
              branch: '核销',
              title: '券核销成功后订单状态变为已完成',
              risk: '🔴高',
              type: '冒烟',
              corePath: true,
              tags: ['🔴高', '冒烟'],
              line: 18,
              pre: [{ depth: 1, text: '用户持有一张可用券' }],
              steps: [{ depth: 0, text: '门店扫码核销' }],
              expects: [{ depth: 1, text: '结果1：券状态 USED，订单已完成' }],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [
                { dim: 'API', text: '200' },
                { dim: 'DB', text: 't_coupon.status=USED' },
                { dim: 'UI', text: '订单列表显示已完成' }
              ],
              covers: ['R13.1']
            },
            {
              kind: 'standard',
              index: 2,
              id: '#2',
              module: '模块B卡券',
              branch: '核销',
              title: '已过期的券核销应失败',
              risk: '🟡中',
              type: '异常',
              corePath: false,
              tags: ['🟡中', '异常'],
              line: 40,
              pre: [{ depth: 1, text: '券有效期为昨天' }],
              steps: [{ depth: 0, text: '门店扫码核销' }],
              expects: [{ depth: 1, text: '结果1：提示券已过期' }],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [{ dim: 'API', text: '业务码 COUPON_EXPIRED' }],
              covers: ['R13.2']
            }
          ]
        },
        {
          relPath: '模块A重构/TC_模块A重构_第三次迭代_混合_2026_10_08_修正版.md',
          name: 'TC_模块A重构_第三次迭代_混合_2026_10_08_修正版.md',
          dir: '模块A重构',
          fullPath: 'D:\\demo\\cases\\module-a\\TC_module_a_iter3_20261008.md',
          title: '模块A重构· 第三次迭代测试用例（修正版）',
          meta: ['生成日期: 2026-10-08', '总计: 56用例 (15高+28中+13低)'],
          kind: 'cases',
          mtime: Date.now() - 86400000 * 3,
          size: 42000,
          cases: [
            {
              kind: 'standard',
              index: 1,
              id: '#1',
              module: '工作台与全局',
              branch: '快捷操作区入口栅格',
              title: '工作台快捷操作区渲染 9 入口且「网点」位序正确',
              risk: '🟡中',
              type: '冒烟',
              corePath: true,
              tags: ['🟡中', '冒烟'],
              line: 12,
              pre: [
                { depth: 1, text: '基础前置：商家账号已登录新版模块A' },
                { depth: 1, text: '环境/规则前置：新版门户为第三次迭代版本（含「网点」入口）' }
              ],
              steps: [{ depth: 0, text: '打开 App 底部「工作台」，核对快捷操作区入口清单与位序' }],
              expects: [
                { depth: 1, text: '结果1：快捷操作区完整渲染 9 个入口' },
                { depth: 1, text: '结果2：9 入口按 4 列栅格排布为 4＋4＋1' }
              ],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [
                { dim: 'UI', text: '9入口齐全且「网点」在第4位' },
                { dim: 'API', text: '200' },
                { dim: 'DB', text: '无' }
              ],
              covers: ['R9.2']
            },
            {
              kind: 'standard',
              index: 2,
              id: '#2',
              module: '工作台与全局',
              branch: '上线引导切换',
              title: '仅展示「网点」引导气泡且四功能引导不显示',
              risk: '🟡中',
              type: '冒烟',
              corePath: true,
              tags: ['🟡中', '冒烟'],
              line: 44,
              pre: [{ depth: 1, text: '基础前置：商家账号已登录，且已清除本地存储中的引导已读标记' }],
              steps: [{ depth: 0, text: '冷启动 App 后进入「工作台」，观察引导气泡数量、锚点位置与文案' }],
              expects: [{ depth: 1, text: '结果1：仅展示 1 个「网点」引导气泡' }],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [
                { dim: 'UI', text: '仅1个「网点」气泡且锚点正确' },
                { dim: 'API', text: '无' },
                { dim: 'DB', text: '—' }
              ],
              covers: ['R9.1', 'R9.2']
            },
            {
              // 故意和「创建退款单」这个接口同一个模块（退款），用来看关联弹窗里的灰字候选
              kind: 'standard',
              index: 3,
              id: '#3',
              module: '退款',
              branch: '创建退款单',
              title: '创建退款单成功且退款流水可查',
              risk: '🔴高',
              type: '功能',
              corePath: true,
              tags: ['🔴高', '功能'],
              line: 88,
              pre: [{ depth: 1, text: '存在已支付且未全额退款的订单' }],
              steps: [{ depth: 0, text: '调用创建退款单接口，订单号与金额合法' }],
              expects: [{ depth: 1, text: '结果1：返回 refundNo，状态 PENDING；3~5 秒后变 SUCCESS' }],
              notes: [],
              checklist: [],
              chainMeta: [],
              assertions: [
                { dim: 'API', text: '200 且 refundNo 非空' },
                { dim: 'DB', text: 't_refund 落一条 PENDING' },
                { dim: 'UI', text: '退款列表能看到这条' }
              ],
              covers: ['R10.1']
            }
          ]
        },
        {
          relPath: 'TC_回归测试_极简链路用例_20260701.md',
          name: 'TC_回归测试_极简链路用例_20260701.md',
          dir: '',
          fullPath: 'D:\\demo\\cases\\TC_regression_20260701.md',
          title: '回归测试 — 极简链路用例',
          meta: ['生成日期: 2026-07-01', '用途: 功能上线后核心流程快速回归'],
          kind: 'cases',
          mtime: Date.now() - 86400000 * 20,
          size: 5200,
          cases: [
            {
              kind: 'chain',
              index: 1,
              id: 'C1',
              module: '',
              branch: '',
              title: '余额核销核心回归链',
              risk: '',
              type: '冒烟',
              corePath: false,
              tags: ['冒烟'],
              line: 9,
              pre: [{ depth: 0, text: '手机号未注册，微信/支付宝支付可用' }],
              steps: [
                { depth: 1, text: '打开小程序 → 微信一键授权注册并登录' },
                { depth: 1, text: '进入充值页 → 选择充值档位(¥100) → 确认支付' },
                { depth: 1, text: '打开核销码页 → 扫码 → 启动核销流程' }
              ],
              expects: [
                { depth: 1, text: '注册成功进入首页' },
                { depth: 1, text: '余额增加至充值金额+赠送金(如108元)' }
              ],
              notes: [],
              checklist: [
                { depth: 0, text: '扫码登录', done: false },
                { depth: 0, text: '结算扣减', done: false }
              ],
              chainMeta: ['覆盖回归流程: #1注册 + #3充值 + #5扫码消费'],
              assertions: [],
              covers: []
            },
            {
              kind: 'chain',
              index: 2,
              id: 'C2',
              module: '',
              branch: '',
              title: '平台卡券核销回归链',
              risk: '',
              type: '冒烟',
              corePath: false,
              tags: ['冒烟'],
              line: 31,
              pre: [{ depth: 0, text: '已登录，支付可用，券列表无平台券' }],
              steps: [{ depth: 1, text: '购买全自动卡 → 完成支付' }],
              expects: [{ depth: 1, text: '券到账，"全自动"Tab可查看' }],
              notes: [],
              checklist: [{ depth: 0, text: '购买到账', done: false }],
              chainMeta: ['覆盖回归流程: #7 购买全自动卡'],
              assertions: [],
              covers: []
            }
          ]
        }
      ]
    }),
    caseOpen: async () => ({ ok: true }),
    caseReveal: async () => ({ ok: true }),
    casePickDir: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),

    linksForApi: async (apiId: string) =>
      clone(linkRows.filter((r) => r.api_id === apiId && !isTrashed(r.api_id))),
    linksForCase: async (filePath: string, caseTitle: string) =>
      clone(
        linkRows.filter((r) => r.file_path === filePath && r.case_title === caseTitle && !isTrashed(r.api_id))
      ),
    linkCounts: async () => {
      const out: Record<string, number> = {};
      for (const r of linkRows) if (!isTrashed(r.api_id)) out[r.api_id] = (out[r.api_id] || 0) + 1;
      return out;
    },
    linkSave: async (apiId: string, targets: any[]) => {
      const before = linkRows.filter((r) => r.api_id === apiId).length;
      linkRows = linkRows.filter((r) => r.api_id !== apiId);
      const seen = new Set<string>();
      for (const t of targets || []) {
        const key = String(t.filePath) + '\u0001' + String(t.caseTitle);
        if (seen.has(key)) continue;
        seen.add(key);
        linkRows.push({
          id: linkSeq++,
          file_path: String(t.filePath),
          case_title: String(t.caseTitle),
          case_index: t.caseIndex === undefined ? null : t.caseIndex,
          api_id: apiId,
          source: 'manual',
          created_at: now()
        });
      }
      return { apiId, count: seen.size, added: 0, removed: before - seen.size > 0 ? before - seen.size : 0 };
    },
    linkAdd: async (payload: any) => {
      linkRows.push({
        id: linkSeq++,
        file_path: String(payload.filePath),
        case_title: String(payload.caseTitle),
        case_index: payload.caseIndex === undefined ? null : payload.caseIndex,
        api_id: String(payload.apiId),
        source: 'manual',
        created_at: now()
      });
      return { ok: true };
    },
    linkRemove: async (id: number) => {
      const before = linkRows.length;
      linkRows = linkRows.filter((r) => r.id !== id);
      return { removed: before - linkRows.length };
    },
    linkPrune: async () => {
      const ids = new Set<string>();
      for (const key of Object.keys(db)) for (const r of db[key]) ids.add(r.id);
      const before = linkRows.length;
      linkRows = linkRows.filter((r) => ids.has(r.api_id));
      return { removed: before - linkRows.length };
    },

    // 预览模式：假装同步了一个 128 条接口的导出文件（不真读文件）
    syncOpenApi: async (file?: string) => {
      const impact = impactFixture(now() - 60000);
      return {
        ok: true,
        file: file || 'D:\\demo\\openapi.json',
        doc: { title: '示例 API', version: '1.4.0', baseUrl: 'https://test.merchant.local' },
        stats: {
          total: 128,
          added: 118,
          updated: 6,
          skipped: 4,
          unchanged: 4,
          invalid: 1,
          dupInBatch: 0,
          missingDesc: 31,
          changed: impact.changed.length,
          affectedCases: impact.affectedCases,
          changedList: impact.changed,
          /*
           * v0.72：「没写进库的明细」。
           * 预览模式也要有，否则在浏览器里跑 build -- --preview 时看不到这个新块，
           * 改版效果没法自查（这个 mock 的职责就是「让界面上每块都能被看到」）。
           */
          skippedList: [
            {
              name: '创建退款单',
              method: 'POST',
              url: 'https://test.merchant.local/api/v1/refund/',
              kind: 'dup',
              reason: '同一个文件里重复定义（同方法同地址），只留了第一条'
            },
            {
              name: '查询订单详情',
              method: 'GET',
              url: 'https://test.merchant.local/api/v1/order/{orderNo}',
              kind: 'unchanged',
              reason: '库里已有这条且内容一致，没有要更新的字段'
            },
            {
              name: '发放优惠券',
              method: 'POST',
              url: 'https://test.merchant.local/api/v1/coupon',
              kind: 'unchanged',
              reason: '库里已有这条且内容一致，没有要更新的字段'
            },
            {
              name: '',
              method: 'GET',
              url: '',
              kind: 'invalid',
              reason: 'url 是空的，算不出唯一键'
            }
          ],
          skippedListTotal: 5,
          at: impact.at
        },
        dup: 2
      };
    },

    // 预览模式：默认就带一份「上次同步变更」，方便看页头入口
    lastSyncChanges: async () => impactFixture(now() - 3600000),

    jmxScan: async () => ({
      root: 'D:\\demo\\jmx（预览模式模拟）',
      totalFiles: 2,
      errors: [],
      jmeter: { path: 'D:\\apache-jmeter-5.4.3\\bin\\jmeter.bat', version: '5.4.3', found: true },
      files: [
        {
          file: '测试计划.jmx',
          relPath: '测试计划.jmx',
          dir: '',
          fullPath: 'D:\\demo\\jmx\\demo-plan.jmx',
          jmeterVersion: '5.4.3',
          testPlanName: '测试计划',
          mtime: Date.now() - 86400000 * 280,
          size: 49439,
          parseError: '',
          // 顺序和 jmxEdit.groups 对齐（index 0 是 setup）；数值每次现取，写回后重扫也不会回退
          threadGroups: [
            jmxScanGroup('setUp 登录准备', 'setup', true, { numThreads: '1', rampUp: '0', loops: '' }),
            jmxScanGroup('用户模块', 'thread', true, { numThreads: '10', rampUp: '2', loops: '1' }),
            jmxScanGroup('门店模块', 'thread', false, { numThreads: '5', rampUp: '1', loops: '3' }),
            jmxScanGroup('支付模块', 'thread', false, { numThreads: '1', rampUp: '1', loops: '' }),
            jmxScanGroup('模块B业务', 'thread', false, { numThreads: '1', rampUp: '1', loops: '' })
          ],
          samplers: [
            { name: '查询用户余额', enabled: true, method: 'GET', path: '/api/v1/user/info', domain: '', port: '', protocol: '', args: [] },
            { name: '小程序登录', enabled: true, method: 'POST', path: '/api/v1/user/login', domain: '127.0.0.1', port: '8080', protocol: 'http', args: [] },
            { name: '商品详情', enabled: false, method: 'GET', path: '/api/v1/product/detail', domain: '', port: '', protocol: '', args: [] },
            { name: '微信登录', enabled: true, method: 'GET', path: '', domain: '', port: '', protocol: '', args: [] }
          ],
          defaults: [{ name: 'HTTP请求默认值', domain: '${test_environment}', port: '8080', protocol: 'http', path: '' }],
          headers: [{ name: 'HTTP信息头管理器', enabled: true, headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'token', value: '${token_file}' }] }],
          variables: [
            {
              name: '用户定义的变量',
              enabled: true,
              vars: [
                { name: 'test_environment', value: '127.0.0.1', desc: '测试环境' },
                { name: 'mail', value: 'test@example.com', desc: '账号' },
                { name: 'pwd', value: '123456', desc: '密码' }
              ]
            }
          ],
          csvs: [
            { name: 'CSV 数据文件设置', enabled: true, filename: 'D:/demo/压测数据/token.txt', variableNames: 'token_file', delimiter: '||', shareMode: 'shareMode.all' },
            { name: 'account数据csv', enabled: true, filename: 'D:/demo/压测数据/user.csv', variableNames: 'account', delimiter: '||', shareMode: 'shareMode.all' }
          ],
          responseAssertions: [],
          durationAssertions: [],
          beanShell: { pre: [{ name: 'BeanShell 预处理程序', enabled: false, script: '' }], post: [{ name: 'BeanShell 提取token', enabled: true, script: '' }], assert: [{ name: 'BeanShell 断言', enabled: true, script: '' }] },
          jsonExtractors: [{ name: '提取登录token', enabled: false, varName: 'token', jsonPath: '$.data.token', defaultValue: '' }],
          syncTimers: [{ name: '同步定时器', enabled: true, groupSize: '10', timeout: '5000' }],
          listeners: [
            { name: '察看结果树', enabled: true, class: 'ResultCollector', guiClass: 'ViewResultsFullVisualizer', filename: '', scope: '查询用户余额' },
            { name: '察看结果树', enabled: true, class: 'ResultCollector', guiClass: 'ViewResultsFullVisualizer', filename: '', scope: '商品详情' },
            { name: '察看结果树', enabled: true, class: 'ResultCollector', guiClass: 'ViewResultsFullVisualizer', filename: '', scope: '用户模块' },
            { name: '聚合报告', enabled: true, class: 'ResultCollector', guiClass: 'StatVisualizer', filename: '', scope: '小程序登录' },
            { name: '察看结果树', enabled: true, class: 'ResultCollector', guiClass: 'ViewResultsFullVisualizer', filename: '', scope: '小程序登录' }
          ],
          loops: [{ name: '循环控制器', loops: '1' }],
          placeholders: ['test_environment', 'token_file', 'mail', 'pwd'],
          health: {
            level: 'error',
            issues: [
              { level: 'warn', code: 'no-assertion', title: '没有任何断言', detail: '教程第四章：响应断言 + 持续时间断言是常规必备' },
              { level: 'error', code: 'csv-missing', title: 'CSV 文件不存在：token.txt', detail: 'D:/demo/压测数据/token.txt' },
              {
                level: 'warn',
                code: 'csv-absolute-path',
                title: 'CSV 用了绝对路径：user.csv',
                detail:
                  '当前机器上能找到（D:/demo/压测数据/user.csv），但换机器/换人必挂。建议改成相对路径（相对 jmx 所在目录）或 ${__P(user.dir)}，让脚本和数据一起搬'
              },
              { level: 'info', code: 'sampler-inherit', title: '1 个采样器 path 为空（继承 HTTP 请求默认值）', detail: '默认值 domain=${test_environment}' },
              { level: 'info', code: 'partial-groups', title: '5 个线程组只启用了 2 个', detail: 'setUp 登录准备、用户模块' }
            ]
          }
        },
        {
          file: 'demo测试计划.jmx',
          relPath: 'demo测试计划.jmx',
          dir: '',
          fullPath: 'D:\\demo\\jmx\\demo-plan-2.jmx',
          jmeterVersion: '5.4.3',
          testPlanName: 'demo测试计划',
          mtime: Date.now() - 86400000 * 283,
          size: 47806,
          parseError: '',
          threadGroups: [{ type: 'thread', name: '用户模块', enabled: true, numThreads: '10', rampUp: '2', duration: '', loops: '', scheduler: false }],
          samplers: [
            { name: '微信小程序注册', enabled: true, method: 'POST', path: '/member/register/wechat', domain: '', port: '', protocol: '', args: [] },
            { name: '微信验证码登录', enabled: true, method: 'POST', path: '/member/register/user', domain: '', port: '', protocol: '', args: [] }
          ],
          defaults: [{ name: 'HTTP请求默认值', domain: '${test_environment}', port: '8080', protocol: 'http', path: '' }],
          headers: [{ name: 'HTTP信息头管理器', enabled: true, headers: [{ name: 'Content-Type', value: 'application/json' }] }],
          variables: [{ name: '用户定义的变量', enabled: true, vars: [{ name: 'test_environment', value: 'test.example.com', desc: '测试环境' }] }],
          csvs: [{ name: 'CSV 数据文件设置', enabled: true, filename: 'D:/demo/压测数据/user.csv', variableNames: 'account', delimiter: '||', shareMode: 'shareMode.all' }],
          responseAssertions: [],
          durationAssertions: [],
          beanShell: { pre: [], post: [], assert: [] },
          jsonExtractors: [],
          syncTimers: [],
          listeners: [{ name: '聚合报告', enabled: true, class: 'ResultCollector', guiClass: 'StatVisualizer', filename: '', scope: '微信验证码登录' }],
          loops: [],
          placeholders: ['test_environment'],
          health: {
            level: 'warn',
            issues: [{ level: 'warn', code: 'no-assertion', title: '没有任何断言', detail: '教程第四章：响应断言 + 持续时间断言是常规必备' }]
          }
        }
      ]
    }),
    /**
     * 预览模式的 jmx 详情（L1 只读解析）。
     * 浏览器里没有文件系统，返回一份和真实 IPC 同形的样例 ——
     * 带 JSR223 断言 / 前置，正好用来核对详情抽屉的展示效果。
     */
    jmxDetail: async (file?: string) => ({
      ok: true,
      file: file ? String(file).split(/[\\/]/).pop() : '测试计划.jmx',
      fullPath: file || 'D:\\demo\\jmx\\demo-plan.jmx',
      size: 49439,
      modifiedAt: Date.now() - 86400000 * 280,
      jmeterVersion: '5.4.3',
      testPlan: { name: '测试计划' },
      threadGroups: jmxEdit.groups.map((g: any, i: number) => ({
        name: g.name,
        // type 三类都可能有（setup / teardown 现在也进 editable，详情表按它显示「前置 / 后置」）
        type: g.type || 'thread',
        enabled: g.type === 'setup' || g.name === '用户模块',
        numThreads: g.numThreads,
        rampUp: g.rampUp,
        loops: g.loops,
        duration: 0,
        scheduler: false
      })),
      samplers: [
        {
          name: '小程序登录',
          method: 'POST',
          path: '/api/v1/user/login',
          domain: '127.0.0.1',
          enabled: true,
          assertions: [
            { name: '响应断言-状态码200', type: 'ResponseAssertion', kind: 'assertion', enabled: true, scope: '小程序登录' },
            {
              name: '断言-返回体成功',
              type: 'JSR223Assertion',
              kind: 'assertion',
              enabled: true,
              scope: '小程序登录',
              language: 'groovy',
              scriptPreview: 'assert json.success == true'
            }
          ],
          preProcessors: [
            {
              name: '附加前置处理',
              type: 'JSR223PreProcessor',
              kind: 'preProcessor',
              enabled: true,
              scope: '小程序登录',
              language: 'groovy',
              scriptPreview: 'vars.put("sign", "abc")'
            }
          ],
          postProcessors: [],
          timers: []
        },
        {
          name: '查询用户余额',
          method: 'GET',
          path: '/api/v1/user/info',
          domain: '',
          enabled: true,
          assertions: [],
          preProcessors: [],
          postProcessors: [],
          timers: []
        }
      ],
      configs: [
        { name: 'CSV 数据文件设置', type: 'CSVDataSet', enabled: true, scope: '用户模块' },
        { name: 'HTTP信息头管理器', type: 'HeaderManager', enabled: true, scope: '小程序登录' }
      ],
      variables: ['test_environment', 'token_file', 'mail', 'pwd'],
      assertionCount: 2,
      summary: { threadGroups: jmxEdit.groups.length, samplers: 2, assertions: 2, configs: 2 },
      // L2 局部编辑：stamp + 可改字段清单（值为空串 = 文件里没有这一项，界面会禁用输入框）
      editable: jmxEditable()
    }),
    /**
     * 预览模式的写回（L2）：没有文件系统，只改内存里的 editable 快照。
     * 返回结构和真 IPC 完全同形，错误分支在浏览器里也能真跑（见上面 jmxEdit 的注释）。
     */
    jmxWriteback: async (payload?: any) => {
      const req = payload || {};
      const file = String(req.file || '');
      const edits: any[] = Array.isArray(req.edits) ? req.edits : [];
      if (!file) return { ok: false, code: 'BAD_PATH', message: '没拿到文件路径' };
      if (!/[\\/]jmx[\\/]/i.test(file)) {
        return { ok: false, code: 'OUTSIDE_ROOT', message: '预览模式只接受 jmx 目录下的文件：' + file };
      }
      if (String(req.stamp || '') !== jmxEdit.stamp) {
        return { ok: false, code: 'STALE', message: '预览模式模拟：文件已被外部改动（stamp 已过期）' };
      }
      if (!edits.length) return { ok: false, code: 'NOT_EDITABLE', message: '这次没有任何要改的字段' };
      // 特殊开关：任意一处填 stale 就模拟「打开详情后文件被外部改过」
      if (edits.some((e) => String(e && e.value).trim().toLowerCase() === 'stale')) {
        return { ok: false, code: 'STALE', message: '预览模式模拟：文件已被外部改动（填 stale 触发）' };
      }

      const noTarget: string[] = [];
      const notEditable: string[] = [];
      const badValues: string[] = [];
      const changes: any[] = [];
      for (const e of edits) {
        const kind = e && e.kind === 'assertion' ? 'assertion' : 'thread';
        const index = Number(e && e.index);
        const field = String((e && e.field) || '');
        const to = String(e && e.value !== undefined && e.value !== null ? e.value : '').trim();
        const list = kind === 'thread' ? jmxEdit.groups : jmxEdit.assertions;
        const hit = list.find((x: any) => Number(x.index) === index);
        const owner = kind === 'thread' ? '线程组' : '断言';
        if (!hit) {
          noTarget.push(owner + ' #' + (index + 1) + ' 在文件里找不到');
          continue;
        }
        // 和真后端一样核对可选 name / type：详情打开后索引漂移时宁可直接拒绝
        if (e && e.name !== undefined && e.name !== null && String(e.name) !== String(hit.name)) {
          noTarget.push(owner + ' #' + (index + 1) + ' 的名字对不上（文件里是「' + hit.name + '」，请求是「' + String(e.name) + '」）');
          continue;
        }
        if (kind === 'thread' && e && e.type !== undefined && e.type !== null) {
          const hitType = String(hit.type || 'thread');
          if (String(e.type) !== hitType) {
            noTarget.push(owner + ' #' + (index + 1) + ' 的类型对不上（文件里是「' + hitType + '」，请求是「' + String(e.type) + '」）');
            continue;
          }
        }
        const from = String(hit[field] === undefined || hit[field] === null ? '' : hit[field]);
        if (from === '') {
          notEditable.push(owner + '「' + hit.name + '」的「' + (field === 'value' ? '值' : field) + '」在文件里没有这一项');
          continue;
        }
        if (kind === 'assertion' && !to) {
          badValues.push('断言「' + hit.name + '」的值不能为空');
          continue;
        }
        if (kind === 'thread') {
          // 值区间和真后端一致：numThreads 1..1e6、rampUp 0..1e6、loops -1 或 1..1e6
          const n = Number(to);
          const intOk = /^-?\d+$/.test(to);
          const label = field === 'numThreads' ? '线程数' : field === 'rampUp' ? '爬坡秒' : field === 'loops' ? '循环次数' : field;
          let err = '';
          if (!intOk) err = '「' + to + '」不是整数';
          else if (field === 'loops' && !(n === -1 || (n >= 1 && n <= 1000000))) err = '必须是 -1（永久循环）或 1..1000000';
          else if (field === 'rampUp' && (n < 0 || n > 1000000)) err = '必须在 0..1000000 之间';
          else if (field === 'numThreads' && (n < 1 || n > 1000000)) err = '必须在 1..1000000 之间';
          if (err) {
            badValues.push('线程组「' + hit.name + '」的' + label + err);
            continue;
          }
        }
        if (to === from) continue;
        changes.push({ kind, index, field, from, to });
      }

      if (noTarget.length) return { ok: false, code: 'NO_SUCH_TARGET', message: noTarget.join('\n') };
      if (notEditable.length) return { ok: false, code: 'NOT_EDITABLE', message: notEditable.join('\n') };
      if (badValues.length) return { ok: false, code: 'BAD_VALUE', message: badValues.join('\n') };
      if (!changes.length) return { ok: false, code: 'NOT_EDITABLE', message: '这些值和文件里的一样，不需要写回' };

      for (const c of changes) {
        const list = c.kind === 'thread' ? jmxEdit.groups : jmxEdit.assertions;
        const hit = list.find((x: any) => Number(x.index) === c.index);
        if (hit) hit[c.field] = c.to;
      }
      jmxStampSeq += 1;
      jmxEdit.stamp = 'mock-stamp-' + jmxStampSeq;
      jmxWriteSeq += 1;
      // 交替 0 / 2：两种 pruned 文案（不追加 / 追加「已清理 N 份旧备份」）都能在预览里点到
      const pruned = jmxWriteSeq % 2 === 1 ? 0 : 2;
      return {
        ok: true,
        file,
        backup: 'D:\\demo\\jmx\\demo-plan.jmx.bak',
        pruned,
        changes,
        editable: jmxEditable()
      };
    },
    jmxOpenFile: async () => ({ ok: true }),
    jmxReveal: async () => ({ ok: true }),
    jmxOpenGui: async () => ({ ok: false, message: '预览模式不能启动 JMeter' }),
    jmxLaunch: async () => ({ ok: false, message: '预览模式不能启动 JMeter' }),
    jmxPickDir: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),
    jmxPickJmeter: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),

    /* ---- 页面元素实时校验（mock）----
     * 五个通道，返回统一形状；不带调试开关时一律「预览不支持」，见上方说明。
     */
    sniffStatus: async () => {
      if (!sniffDebug()) return sniffUnsupported();
      // closed 这个场景专门演「用户把浏览器窗口关了」：状态回 running:false，面板切到「会话已结束」
      if (sniffModeName() === 'closed') return Object.assign(sniffBase(), { running: false, message: '浏览器窗口已被关闭' });
      return Object.assign(sniffBase(), { found: sniffRunning ? 1 : 0, total: sniffRunning ? 1 : 0 });
    },
    sniffStart: async (payload?: any) => {
      if (!sniffDebug()) return sniffUnsupported();
      sniffUrl = String((payload && payload.url) || '');
      sniffName = String((payload && payload.name) || '');
      sniffMode = String((payload && payload.mode) || 'css');
      sniffSelector = String((payload && payload.selector) || '');
      // v0.56：{ browser: 'auto'|'edge'|'chrome' }，默认 auto（跟随系统）
      applyBrowserChoice(payload && payload.browser);
      await sniffDelay(600); // 让「正在启动浏览器…」这个状态能被看到
      sniffRunning = true;
      return sniffResult();
    },
    sniffHighlight: async (payload?: any) => {
      if (!sniffDebug()) return sniffUnsupported();
      if (payload && payload.name) sniffName = String(payload.name);
      if (payload && payload.mode) sniffMode = String(payload.mode);
      if (payload && payload.selector) sniffSelector = String(payload.selector);
      // 换浏览器「下一次启动生效」：高亮时把选择记住，真机会在需要重新拉起时用它
      if (payload && payload.browser) applyBrowserChoice(payload.browser);
      // 高亮之前顺手保证会话在（真机里主进程也会负责起浏览器）
      sniffRunning = true;
      return sniffResult();
    },
    /**
     * 重新打开页面。
     * v0.56 入参是 `{ url, browser }`；老调用方还会传纯字符串 url，
     * 两种都认（真机 preload 两代形态并存，这里保持同样的宽容）。
     */
    sniffReopen: async (payload?: any) => {
      if (!sniffDebug()) return sniffUnsupported();
      const p = payload && typeof payload === 'object' ? payload : { url: payload };
      if (p.browser) applyBrowserChoice(p.browser);
      sniffUrl = String(p.url || sniffUrl);
      sniffRunning = true;
      sniffStep = 0;
      return Object.assign(sniffBase(), { found: 1, total: 1, visible: true, message: '已重新打开页面' });
    },
    sniffStop: async () => {
      if (!sniffDebug()) return sniffUnsupported();
      sniffRunning = false;
      return Object.assign(sniffBase(), { running: false, message: '浏览器已关闭' });
    },
    /**
     * 拉起 Playwright codegen：预览模式没有 Python / Node 子进程，如实说不行。
     * （打开 ?sniff=... 调试开关时给一个假的成功回执，好把弹窗交互看全。）
     */
    sniffCodegen: async (payload?: any) => {
      const lang = String((payload && payload.lang) || 'python');
      if (!sniffDebug()) {
        return { ok: false, lang, message: '浏览器预览模式不能拉起 Playwright codegen，请在安装版里使用' };
      }
      return {
        ok: true,
        pid: 0,
        lang,
        message: lang === 'java' ? 'Playwright codegen（Java · Node 版）已启动（预览模拟）' : 'Playwright codegen（Python）已启动（预览模拟）'
      };
    },

    reportScan: async () => ({
      root: 'D:\\demo\\jmx\\report（预览模式模拟）',
      reports: MOCK_REPORTS,
      errors: []
    }),
    reportPick: async () => ({ ok: false, message: '预览模式不支持选目录' }),
    reportParse: async (dir: string) => {
      const hit = MOCK_REPORTS.find((r) => r.dir === dir);
      return hit ? { ok: true, report: hit } : { ok: false, message: '预览模式只认识内置的那条' };
    },
    reportPickDir: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),

    kbScan: async () => ({
      root: 'D:\\demo\\kb（预览模式模拟）',
      totalDocs: 2,
      errors: [],
      docs: [
        {
          relPath: '业务规则沉淀_模块I公告.md',
          name: '业务规则沉淀_模块I公告.md',
          dir: '',
          fullPath: 'D:\\demo\\kb\\business-rules_module-i.md',
          title: '业务规则沉淀_模块I公告',
          meta: { updatedAt: '2026-05-27 (新增发布者角色与审批规则)', tags: [] },
          chars: 930,
          lines: 47,
          mtime: Date.now() - 86400000 * 5,
          size: 2226,
          body: '## 一、用户类型\n- 查看用户类型可选：**商家** / **用户**\n\n## 二、发布者角色与审批规则（新增）\n- **管理员**发布公告：提交后**默认审批通过**，直接生效\n- **商家**发布公告：提交后状态为**待审核**',
          sections: [
            {
              title: '一、用户类型',
              line: 5,
              text: '- 查看用户类型可选：**商家** / **用户**\n- 选择"用户"时不区分具体用户类型',
              children: []
            },
            {
              title: '二、发布者角色与审批规则（新增）',
              line: 10,
              text: '- **管理员**发布公告：提交后**默认审批通过**，直接生效\n- **商家**发布公告：提交后状态为**待审核**',
              children: []
            },
            {
              title: '四、已读统计规则',
              line: 20,
              text: '',
              children: [
                { title: '4.1 基本统计', line: 22, text: '- 已读人数 = 已读商家去重计数\n- 未读人数 = 应该商家数 - 已读商家数', children: [] },
                { title: '4.2 编辑后统计动态更新', line: 27, text: '- 编辑公告修改发送范围后，已读统计**动态跟随变化**', children: [] }
              ]
            }
          ]
        },
        {
          relPath: '业务规则沉淀_模块D配置.md',
          name: '业务规则沉淀_模块D配置.md',
          dir: '',
          fullPath: 'D:\\demo\\kb\\business-rules_module-d.md',
          title: '业务规则沉淀_模块D配置',
          meta: { updatedAt: '2026-11-03', tags: [] },
          chars: 43824,
          lines: 620,
          mtime: Date.now() - 86400000 * 14,
          size: 96757,
          body: '## 一、折扣类型\n- 满减 / 折扣 / 立减',
          sections: [{ title: '一、折扣类型', line: 5, text: '- 满减 / 折扣 / 立减', children: [] }]
        }
      ]
    }),
    kbOpenFile: async () => ({ ok: true }),
    kbReveal: async () => ({ ok: true }),
    kbPickDir: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),

    updateCheck: async () => ({
      ok: true,
      hasNew: true,
      current: '0.25.0',
      latest: '0.26.0',
      asset: { name: 'test-tool-Setup-0.26.0-x64.exe', size: 125000000, url: 'https://example.com/x.exe' },
      notes: '预览模式：这是模拟的更新说明。',
      publishedAt: new Date().toISOString()
    }),
    updateDownload: async () => ({ ok: false, message: '预览模式不支持下载' }),
    updateCancel: async () => ({ ok: true }),
    updateCleanup: async () => ({ ok: true }),
    updateInstall: async () => ({ ok: false, message: '预览模式不支持安装' }),
    onUpdateProgress: () => () => {},
    notesScan: async () => ({
      root: 'D:\\demo\\notes（预览模式模拟）',
      totalNotes: 2,
      errors: [],
      notes: [
        {
          relPath: '退款并发问题的复现步骤.md',
          name: '退款并发问题的复现步骤.md',
          dir: '',
          fullPath: 'D:\\demo\\notes\\refund-concurrency-repro.md',
          title: '退款并发问题的复现步骤',
          meta: { updatedAt: '2026-10-15', tags: [] },
          chars: 320,
          lines: 18,
          mtime: Date.now() - 86400000 * 2,
          size: 1200,
          body: '## 前置\n- 订单状态 PAID\n\n## 步骤\n1. 并发发起 2 次退款\n\n## 结论\n- 建议加唯一索引',
          sections: [
            { title: '前置', line: 3, text: '- 订单状态 `PAID`\n- 退款金额 = 订单金额', children: [] },
            { title: '步骤', line: 7, text: '1. 用同一个 `X-Request-Id` 并发发起 2 次退款\n2. 观察 `t_refund` 是否出现两条记录', children: [] },
            { title: '结论', line: 12, text: '- 幂等键只在网关生效，业务库没加唯一索引', children: [] }
          ]
        },
        {
          relPath: '接口联调记录.md',
          name: '接口联调记录.md',
          dir: '',
          fullPath: 'D:\\demo\\notes\\api-integration-log.md',
          title: '接口联调记录',
          meta: { updatedAt: '2026-11-10', tags: [] },
          chars: 180,
          lines: 10,
          mtime: Date.now() - 86400000 * 8,
          size: 800,
          body: '## 联调环境\n- 测试环境地址见配置\n\n## 问题\n- 返回 500',
          sections: [{ title: '联调环境', line: 3, text: '- 测试环境地址见配置', children: [] }]
        }
      ]
    }),
    notesOpenFile: async () => ({ ok: true }),
    notesReveal: async () => ({ ok: true }),
    notesPickDir: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),
    notesPickImport: async () => ({ ok: false, message: '预览模式不支持导入' }),
    notesImport: async () => ({ ok: false, message: '预览模式不支持导入' }),

    exportData: async (includeSecrets?: boolean, collection?: string) => {
      const lists: any[] = collection ? db[collection] || [] : Object.keys(db).reduce((acc: any[], k) => acc.concat(db[k]), []);
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: !!includeSecrets,
        records: lists.map((r: any) => ({
          collection: r.collection,
          title: r.title,
          data: clone(r.data),
          tags: r.tags,
          favorite: r.favorite,
          created_at: r.created_at,
          updated_at: r.updated_at
        }))
      };
      const name = `测试工作台-${collection || '备份'}-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return { ok: true, file: name, count: payload.records.length };
    },
    importData: async () => ({ ok: false, message: '预览模式不支持导入（正式版可用）' }),
    info: async () => ({
      version: '0.1.0-preview',
      dataDir: '(浏览器预览)',
      dbPath: '',
      backupDir: '',
      encryptionAvailable: false,
      backups: []
    })
  };

  (window as any).api = api;
}