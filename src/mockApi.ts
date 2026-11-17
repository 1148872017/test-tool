/**
 * 浏览器预览用的内存实现。
 * 只有在没有 window.api（即不是 Electron 环境）时才启用，不影响正式运行。
 */

import { COLLECTION_MAP } from '../shared/collections';

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
        env: 'test',
        account: 'admin',
        password: 'Admin@123',
        note: '入口 /login，测试环境 10.0.0.1'
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
        env: 'staging',
        account: 'qa_refund',
        password: 'Refund#2026',
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
        env: 'other',
        account: 'sandbox',
        password: 'pay123456',
        note: '只用于联调，不要提交真实卡号'
      },
      tags: ['支付'],
      favorite: false,
      created_at: now() - 86400000 * 6,
      updated_at: now() - 86400000
    }
  ],
  accounts: [
    {
      id: 'a1',
      collection: 'accounts',
      title: '运营后台-管理员',
      data: {
        name: '运营后台-管理员',
        env: 'test',
        role: '超级管理员',
        account: 'ops_admin',
        password: 'Ops@123456',
        site: 's1',
        expire: '2027-06-30',
        note: '能改配置，慎用'
      },
      tags: ['超管'],
      favorite: true,
      created_at: now() - 86400000 * 5,
      updated_at: now() - 5400000
    },
    {
      id: 'a2',
      collection: 'accounts',
      title: '运营后台-只读',
      data: {
        name: '运营后台-只读',
        env: 'staging',
        role: '只读',
        account: 'viewer',
        password: 'View@123',
        site: 's2',
        expire: '',
        note: '验证权限用'
      },
      tags: [],
      favorite: false,
      created_at: now() - 86400000 * 4,
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
  ],
  notes: [
    {
      id: 'n1',
      collection: 'notes',
      title: '退款并发问题的复现步骤',
      data: {
        name: '退款并发问题的复现步骤',
        content:
          '# 退款并发复现\n\n## 前置\n- 订单状态 `PAID`\n- 退款金额 = 订单金额\n\n## 步骤\n1. 用同一个 `X-Request-Id` 并发发起 2 次退款\n2. 观察 `t_refund` 是否出现两条记录\n3. 查支付网关流水，确认是否重复扣款\n\n## 结论\n- 幂等键只在网关生效，业务库没加唯一索引 → 建议加 `(order_no, refund_no)` 唯一索引\n\n> 2026-10 回归：已修复，需验证高并发场景。'
      },
      tags: ['退款', '并发'],
      favorite: true,
      created_at: now() - 86400000 * 2,
      updated_at: now() - 900000
    }
  ]
};

/** 预览模式的压测报告（真机上是扫描目录得到的） */
const MOCK_REPORTS: any[] = [
  {
    dir: 'D:\\AI_Workspace\\jmx\\压测结果',
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
      jtl: 'D:\\AI_Workspace\\jmx\\压测结果\\result.jtl',
      statistics: 'D:\\AI_Workspace\\jmx\\压测结果\\html-report\\statistics.json',
      htmlIndex: 'D:\\AI_Workspace\\jmx\\压测结果\\html-report\\index.html'
    }
  }
];

function seedData() {
  const db: Record<string, any[]> = {};
  for (const key of Object.keys(SEED)) db[key] = SEED[key].map((r) => ({ ...r, data: { ...r.data }, tags: [...r.tags] }));
  // 和真实迁移 v4 对齐：站点/账号的 env、账号的 role 都是数组
  for (const coll of ['sites', 'accounts']) {
    for (const r of db[coll] || []) {
      const d = r.data || {};
      if (!Array.isArray(d.env)) d.env = d.env ? [d.env] : [];
      if (coll === 'accounts' && !Array.isArray(d.role)) d.role = d.role ? [d.role] : [];
    }
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
    hasPin: false,
    pin: '',
    casesDir: 'D:\\AI_Workspace\\test_cases',
    jmxDir: 'D:\\AI_Workspace\\jmx',
    jmeterPath: 'D:\\apache-jmeter-5.4.3\\bin\\jmeter.bat',
    reportDir: 'D:\\AI_Workspace\\jmx\\压测结果',
    kbDir: 'D:\\AI_Workspace\\知识库'
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

  const api = {
    init: async () => ({
      locked,
      version: '0.1.0-preview',
      dataDir: '(浏览器预览，无数据目录)',
      encryptionAvailable: false,
      settings: {
        autoLockMinutes: settings.autoLockMinutes,
        clipboardClearSeconds: settings.clipboardClearSeconds,
        openCopyPassword: settings.openCopyPassword,
        hasPin: settings.hasPin,
        casesDir: settings.casesDir,
        jmxDir: settings.jmxDir,
        jmeterPath: settings.jmeterPath,
        reportDir: settings.reportDir,
        kbDir: settings.kbDir
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
    settings: async () => ({ autoLockMinutes: settings.autoLockMinutes, clipboardClearSeconds: settings.clipboardClearSeconds, openCopyPassword: settings.openCopyPassword, hasPin: settings.hasPin }),
    saveSettings: async (patch: any) => {
      settings = { ...settings, ...patch };
      return { autoLockMinutes: settings.autoLockMinutes, clipboardClearSeconds: settings.clipboardClearSeconds, openCopyPassword: settings.openCopyPassword, hasPin: settings.hasPin };
    },
    records: async (collection: string) => clone(findCollection(collection)),
    record: async (id: string) => {
      for (const key of Object.keys(db)) {
        const hit = db[key].find((r) => r.id === id);
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
        created_at: now(),
        updated_at: now()
      };
      list.unshift(created);
      return clone(created);
    },
    removeRecord: async (id: string) => {
      for (const key of Object.keys(db)) {
        db[key] = db[key].filter((r) => r.id !== id);
      }
      // 接口记录被删 → 指向它的关联一起清掉
      linkRows = linkRows.filter((r) => r.api_id !== id);
      return true;
    },
    counts: async () => {
      const out: Record<string, number> = {};
      for (const key of Object.keys(db)) out[key] = db[key].length;
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
      root: 'D:\\AI_Workspace\\test_cases（预览模式模拟）',
      totalCases: 9,
      totalFiles: 4,
      errors: [],
      files: [
        {
          relPath: '模块A重构/TC_模块C券_20250109.md',
          name: 'TC_模块C券_20250109.md',
          dir: '模块A重构',
          fullPath: 'D:\\AI_Workspace\\test_cases\\模块A重构\\TC_模块C券_20250109.md',
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
          fullPath: 'D:\\AI_Workspace\\test_cases\\模块A重构\\TC_模块B卡券_核销_20250210.md',
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
              title: '洗车券核销成功后订单状态变为已完成',
              risk: '🔴高',
              type: '冒烟',
              corePath: true,
              tags: ['🔴高', '冒烟'],
              line: 18,
              pre: [{ depth: 1, text: '用户持有一张可用洗车券' }],
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
              title: '已过期的洗车券核销应失败',
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
          fullPath: 'D:\\AI_Workspace\\test_cases\\模块A重构\\TC_模块A重构_第三次迭代_混合_2026_10_08_修正版.md',
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
          fullPath: 'D:\\AI_Workspace\\test_cases\\TC_回归测试_极简链路用例_20260701.md',
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
                { depth: 1, text: '打开洗车码页 → 洗车机扫描二维码 → 启动洗车功能(按清水键)' }
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
              title: '平台卡券洗车回归链',
              risk: '',
              type: '冒烟',
              corePath: false,
              tags: ['冒烟'],
              line: 31,
              pre: [{ depth: 0, text: '已登录，支付可用，卡券列表无平台券' }],
              steps: [{ depth: 1, text: '购买全自动洗车卡 → 完成支付' }],
              expects: [{ depth: 1, text: '券到账，"全自动洗车"Tab可查看' }],
              notes: [],
              checklist: [{ depth: 0, text: '购买到账', done: false }],
              chainMeta: ['覆盖回归流程: #7 购买全自动洗车卡'],
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

    linksForApi: async (apiId: string) => clone(linkRows.filter((r) => r.api_id === apiId)),
    linksForCase: async (filePath: string, caseTitle: string) =>
      clone(linkRows.filter((r) => r.file_path === filePath && r.case_title === caseTitle)),
    linkCounts: async () => {
      const out: Record<string, number> = {};
      for (const r of linkRows) out[r.api_id] = (out[r.api_id] || 0) + 1;
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
        file: file || 'D:\\AI_Workspace\\_scratch\\2026-11-02\\openapi.json',
        doc: { title: '示例 API', version: '1.4.0', baseUrl: 'https://test.merchant.local' },
        stats: {
          total: 128,
          added: 118,
          updated: 6,
          skipped: 4,
          unchanged: 4,
          invalid: 0,
          missingDesc: 31,
          changed: impact.changed.length,
          affectedCases: impact.affectedCases,
          changedList: impact.changed,
          at: impact.at
        },
        dup: 2
      };
    },

    // 预览模式：默认就带一份「上次同步变更」，方便看页头入口
    lastSyncChanges: async () => impactFixture(now() - 3600000),

    jmxScan: async () => ({
      root: 'D:\\AI_Workspace\\jmx（预览模式模拟）',
      totalFiles: 2,
      errors: [],
      jmeter: { path: 'D:\\apache-jmeter-5.4.3\\bin\\jmeter.bat', version: '5.4.3', found: true },
      files: [
        {
          file: '测试计划.jmx',
          relPath: '测试计划.jmx',
          dir: '',
          fullPath: 'D:\\AI_Workspace\\jmx\\测试计划.jmx',
          jmeterVersion: '5.4.3',
          testPlanName: '测试计划',
          mtime: Date.now() - 86400000 * 280,
          size: 49439,
          parseError: '',
          threadGroups: [
            { type: 'thread', name: '用户模块', enabled: true, numThreads: '10', rampUp: '2', duration: '', loops: '', scheduler: false },
            { type: 'thread', name: '门店模块', enabled: false, numThreads: '1', rampUp: '1', duration: '', loops: '', scheduler: false },
            { type: 'thread', name: '支付模块', enabled: false, numThreads: '1', rampUp: '1', duration: '', loops: '', scheduler: false },
            { type: 'thread', name: '模块B业务', enabled: false, numThreads: '1', rampUp: '1', duration: '', loops: '', scheduler: false }
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
              { level: 'info', code: 'partial-groups', title: '4 个线程组只启用了 1 个', detail: '用户模块' }
            ]
          }
        },
        {
          file: 'demo测试计划.jmx',
          relPath: 'demo测试计划.jmx',
          dir: '',
          fullPath: 'D:\\AI_Workspace\\jmx\\demo测试计划.jmx',
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
    jmxOpenFile: async () => ({ ok: true }),
    jmxReveal: async () => ({ ok: true }),
    jmxOpenGui: async () => ({ ok: false, message: '预览模式不能启动 JMeter' }),
    jmxLaunch: async () => ({ ok: false, message: '预览模式不能启动 JMeter' }),
    jmxPickDir: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),
    jmxPickJmeter: async () => ({ ok: false, message: '预览模式请直接编辑输入框' }),

    reportScan: async () => ({
      root: 'D:\\AI_Workspace\\jmx\\压测结果（预览模式模拟）',
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
      root: 'D:\\AI_Workspace\\知识库（预览模式模拟）',
      totalDocs: 2,
      errors: [],
      docs: [
        {
          relPath: '业务规则沉淀_模块I公告.md',
          name: '业务规则沉淀_模块I公告.md',
          dir: '',
          fullPath: 'D:\\AI_Workspace\\知识库\\业务规则沉淀_模块I公告.md',
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
          fullPath: 'D:\\AI_Workspace\\知识库\\业务规则沉淀_模块D配置.md',
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