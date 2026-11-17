/* 接口只读镜像（OpenAPI → apis）测试
 *   1) 解析层：paths/method/servers/标签/参数摘要/$ref 内联/完整度/去重/各种坏文件
 *   2) store 层：幂等 upsert、只覆盖 OpenAPI 字段、认领手写记录、URL 变了不删老记录、落盘重开
 *   3) IPC 层：apis:sync 读文件、坏文件给明确错误、锁屏拒绝
 * 用一个 stub 顶掉 electron，不需要 GUI。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), 'tt-openapi-' + Date.now());
const dirStore = path.join(tmp, 'store');
const dirIpc = path.join(tmp, 'ipc');
const fileDir = path.join(tmp, 'files');
fs.mkdirSync(fileDir, { recursive: true });

const handlers = {};
const clip = { value: '' };
const fakeElectron = {
  app: {
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getPath(p) {
      return path.join(tmp, p);
    },
    requestSingleInstanceLock() {
      return true;
    },
    on() {},
    once() {},
    whenReady() {
      return Promise.resolve();
    },
    quit() {},
    getVersion() {
      return '0.8.0';
    },
    commandLine: { appendSwitch() {} }
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send() {}, on() {}, toggleDevTools() {} };
    }
    loadFile() {
      return Promise.resolve();
    }
    once() {}
    on() {}
    show() {}
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
  },
  ipcMain: {
    handle(channel, fn) {
      handlers[channel] = fn;
    }
  },
  clipboard: {
    writeText(t) {
      clip.value = String(t);
    },
    readText() {
      return clip.value;
    },
    clear() {
      clip.value = '';
    }
  },
  shell: { openExternal: async () => true, openPath: async () => '', showItemInFolder() {} },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  },
  Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } },
  globalShortcut: { register() {}, unregisterAll() {} },
  dialog: {
    showErrorBox() {},
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true })
  },
  nativeImage: { createFromPath() { return {}; } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
  }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
}

/* ------------------------------ 测试用 OpenAPI ------------------------------ */

function baseDoc() {
  return {
    openapi: '3.0.1',
    info: { title: '商家门户 API', version: '1.4.0' },
    servers: [{ url: 'https://test.merchant.local/' }],
    paths: {
      '/api/v1/refund': {
        parameters: [{ name: 'tenantId', in: 'header', required: true, schema: { type: 'string' }, description: '租户' }],
        post: {
          tags: ['退款'],
          summary: '创建退款单',
          description: '创建退款单。金额不能超过订单实付。',
          parameters: [
            { name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string' }, description: '幂等键' },
            { name: 'orderNo', in: 'query', schema: { type: 'string' }, description: '订单号' }
          ],
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RefundReq' }, example: { orderNo: 'SO1' } }
            }
          },
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/RefundResp' } } } }
          }
        }
      },
      '/api/v1/order/{orderNo}': {
        get: {
          tags: ['订单'],
          operationId: 'getOrder',
          // 故意不写 summary / description → 缺描述
          parameters: [{ name: 'orderNo', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { orderNo: { type: 'string' } } } } } }
          }
        }
      },
      '/api/v1/ping': {
        // 有描述、没 example → 缺示例
        get: { summary: '健康检查', responses: { 200: { description: 'ok', content: { 'text/plain': { schema: { type: 'string' } } } } } }
      },
      '/api/v1/echo': {
        put: {
          summary: 'Echo',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string', example: 'x' } } } } } },
          responses: { 201: { description: 'created' } }
        }
      },
      '/api/v1/not-api': {
        // 非 HTTP 方法，必须忽略
        trace: { summary: '不该出现' },
        'x-custom': { summary: '也不该出现' }
      }
    },
    components: {
      schemas: {
        RefundReq: {
          type: 'object',
          required: ['orderNo', 'amount'],
          properties: { orderNo: { type: 'string' }, amount: { type: 'number', example: 99.9 } }
        },
        RefundResp: { type: 'object', properties: { refundNo: { type: 'string' } } }
      }
    }
  };
}

(async () => {
  const openapi = require(path.join(proj, 'electron', 'openapi.js'));

  // ================= 1. 解析层 =================
  const parsed = openapi.parseOpenApi(baseDoc());
  check('解析出 4 条接口（忽略非 HTTP 方法）', parsed.items.length === 4, parsed.items.map((i) => i.method + ' ' + i.url));
  check('method 一律大写', parsed.items.every((i) => i.method === i.method.toUpperCase()), parsed.items.map((i) => i.method));
  check(
    'url = servers 去尾斜杠 + path',
    parsed.items[0].url === 'https://test.merchant.local/api/v1/refund',
    parsed.items[0].url
  );
  check('name 优先取 summary', parsed.items[0].name === '创建退款单', parsed.items[0].name);
  check('没有 summary 时退回 operationId', !!parsed.items.find((i) => i.name === 'getOrder'), parsed.items.map((i) => i.name));
  check('module 取第一个 tag', parsed.items[0].module === '退款', parsed.items[0].module);
  check('没有 tag 时归到「未分组」', parsed.items.find((i) => i.url.endsWith('/ping')).module === '未分组');

  const refund = parsed.items[0];
  const paramLines = refund.params.split('\n');
  check(
    '参数摘要按 query → header 排序且必填带 *',
    paramLines.length === 3 &&
      paramLines[0].indexOf('query: orderNo') === 0 &&
      paramLines[1].indexOf('header: tenantId*') === 0 &&
      paramLines[2].indexOf('header: X-Request-Id*') === 0,
    paramLines
  );
  check('参数摘要带类型和描述', /header: X-Request-Id\* \(string\) 幂等键/.test(refund.params), refund.params);
  check('$ref 被内联进 reqSchema', refund.reqSchema.indexOf('"$ref"') < 0 && refund.reqSchema.indexOf('amount') >= 0, refund.reqSchema.slice(0, 120));
  check('respSchema 取 200 的 schema', refund.respSchema.indexOf('refundNo') >= 0, refund.respSchema.slice(0, 120));
  check('只有 201 时也能取到 respSchema', !!parsed.items.find((i) => i.method === 'PUT').reqSchema);
  check('有描述有 example → ok', refund.completeness === 'ok', refund.completeness);
  check('没描述 → missing-desc', parsed.items.find((i) => i.name === 'getOrder').completeness === 'missing-desc');
  check('有描述没 example → missing-example', parsed.items.find((i) => i.url.endsWith('/ping')).completeness === 'missing-example');
  check('每条都标 source = openapi', parsed.items.every((i) => i.source === 'openapi'));

  // servers 变量替换 / 无 servers
  const withVar = baseDoc();
  withVar.servers = [{ url: 'https://{host}/', variables: { host: { default: 'api.dev.local' } } }];
  check('servers 的 {变量} 用 default 填', openapi.parseOpenApi(withVar).items[0].url.indexOf('https://api.dev.local/api/v1/refund') === 0, openapi.parseOpenApi(withVar).items[0].url);

  const noServer = baseDoc();
  delete noServer.servers;
  check('没有 servers 时用相对 path', openapi.parseOpenApi(noServer).items[0].url === '/api/v1/refund', openapi.parseOpenApi(noServer).items[0].url);

  // 尾斜杠重复：/a 与 /a/ 归一成同一个键
  const dupDoc = baseDoc();
  dupDoc.paths['/api/v1/ping/'] = { get: { summary: '健康检查', responses: { 200: { description: 'ok' } } } };
  const dupParsed = openapi.parseOpenApi(dupDoc);
  check('同一 method + url（只差尾斜杠）只留一条', dupParsed.items.length === 4 && dupParsed.stats.dup === 1, {
    n: dupParsed.items.length,
    dup: dupParsed.stats.dup
  });

  // 坏文件
  const bad = [];
  const tryBad = (doc) => {
    try {
      openapi.parseOpenApi(doc);
      bad.push('no-throw');
    } catch (e) {
      bad.push(e.message);
    }
  };
  tryBad({ swagger: '2.0', paths: {} });
  check('Swagger 2.0 给明确报错', bad[0].indexOf('OpenAPI 3') >= 0, bad[0]);
  tryBad({ openapi: '4.0.0', paths: {} });
  check('openapi 版本不是 3 时报错', bad[1].indexOf('只支持 OpenAPI 3') >= 0, bad[1]);
  tryBad({ openapi: '3.0.0', paths: {} });
  check('paths 为空时报错', bad[2].indexOf('没有 paths') >= 0, bad[2]);
  tryBad('not-an-object');
  check('传字符串时报错而不是崩', typeof bad[3] === 'string' && bad[3].length > 0, bad[3]);

  // 超长 schema 截断
  const big = baseDoc();
  const props = {};
  for (let i = 0; i < 900; i++) props['field_' + i] = { type: 'string', description: '很长的说明文字啊啊啊啊' };
  big.components.schemas.RefundReq = { type: 'object', properties: props };
  const bigParsed = openapi.parseOpenApi(big);
  check('超长 Schema 截断并注明', bigParsed.items[0].reqSchema.indexOf('已截断') > 0 && bigParsed.items[0].reqSchema.length < 7000, bigParsed.items[0].reqSchema.length);

  // 循环 $ref 不能炸
  const loopDoc = {
    openapi: '3.0.0',
    info: { title: 'loop' },
    paths: {
      '/x': {
        post: {
          summary: '循环引用',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } },
          responses: { 200: { description: 'ok' } }
        }
      }
    },
    components: { schemas: { A: { type: 'object', properties: { child: { $ref: '#/components/schemas/A' } } } } }
  };
  let loopErr = null;
  try {
    openapi.parseOpenApi(loopDoc);
  } catch (e) {
    loopErr = e;
  }
  check('循环 $ref 不会栈溢出', loopErr === null, loopErr && loopErr.message);

  // ================= 1.5 变更 diff（纯函数） =================
  const d1 = openapi.diffApi(
    { paramSpec: JSON.stringify([{ in: 'query', name: 'a', required: false, type: 'string' }]) },
    { paramSpec: JSON.stringify([{ in: 'query', name: 'a', required: true, type: 'string' }]) }
  );
  check('可选参数变必填也算「必填参数 +1」', d1.length === 1 && d1[0].kind === 'req-param-add' && d1[0].detail === 'a', d1);

  const d2 = openapi.diffApi(
    { paramSpec: JSON.stringify([{ in: 'query', name: 'a', required: true, type: 'string' }]) },
    { paramSpec: JSON.stringify([{ in: 'query', name: 'a', required: true, type: 'number' }]) }
  );
  check('参数类型变化能检出', d2.length === 1 && d2[0].kind === 'param-type' && d2[0].detail.indexOf('string→number') >= 0, d2);

  const d3 = openapi.diffApi(
    { paramSpec: JSON.stringify([{ in: 'query', name: 'gone', required: true, type: 'string' }]) },
    { paramSpec: '[]' }
  );
  check('必填参数被删能检出', d3.length === 1 && d3[0].kind === 'req-param-remove', d3);

  const d4 = openapi.diffApi(
    { reqSchema: JSON.stringify({ type: 'object', required: ['x'], properties: { x: { type: 'string' }, y: { type: 'string' } } }) },
    { reqSchema: JSON.stringify({ type: 'object', required: ['x', 'z'], properties: { x: { type: 'string' }, z: { type: 'string' } } }) }
  );
  const kinds4 = d4.map((c) => c.kind).sort();
  check('请求体：必填 +1、字段增删都能检出', kinds4.indexOf('req-required-add') >= 0 && kinds4.indexOf('req-field-add') >= 0 && kinds4.indexOf('req-field-remove') >= 0, d4);

  const d5 = openapi.diffApi(
    { respSchema: JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } } }) },
    { respSchema: JSON.stringify({ type: 'array', items: { type: 'object', properties: { ok: { type: 'boolean' }, msg: { type: 'string' } } } }) }
  );
  check('响应体是数组时钻一层再比', d5.length === 1 && d5[0].kind === 'resp-field-add' && d5[0].detail === 'msg', d5);

  check('只改描述 → 没有结构变更', openapi.diffApi({ summary: '旧' }, { summary: '新' }).length === 0);
  check('老记录没有镜像字段 → 不算变更（不虚报）', openapi.diffApi({}, { paramSpec: '[]', reqSchema: '{"type":"object"}' }).length === 0);
  check('完全一样 → 0 条', openapi.diffApi({ paramSpec: '[]' }, { paramSpec: '[]' }).length === 0);
  check('坏 JSON 不会抛异常', (() => {
    try {
      openapi.diffApi({ paramSpec: '{oops', reqSchema: 'nope' }, { paramSpec: '[]', reqSchema: '{}' });
      return true;
    } catch (e) {
      return false;
    }
  })());

  const many = {};
  for (let i = 0; i < 30; i++) many['p' + i] = { type: 'string' };
  const d6 = openapi.diffApi({ reqSchema: JSON.stringify({ type: 'object', properties: {} }) }, { reqSchema: JSON.stringify({ type: 'object', properties: many }) });
  check('变更条数有上限（最多 8 项）', d6.length <= 8 && d6.length > 0, d6.length);

  // ================= 2. store 层 =================
  const store = require(path.join(proj, 'electron', 'store'));
  await store.init(dirStore);
  const items = () => openapi.parseOpenApi(baseDoc()).items;

  const s1 = store.syncApis({ items: items() });
  check('首次同步全部新增', s1.added === 4 && s1.updated === 0 && s1.total === 4, s1);
  check('库里正好 4 条接口记录', store.list('apis').length === 4, store.list('apis').length);
  check('缺描述计数 = 1', s1.missingDesc === 1, s1.missingDesc);

  const s2 = store.syncApis({ items: items() });
  check('再同步同一份：0 新增 0 更新 4 跳过', s2.added === 0 && s2.updated === 0 && s2.skipped === 4, s2);
  check('重复同步不产生重复记录（幂等）', store.list('apis').length === 4, store.list('apis').length);

  const refundRec = store.list('apis').find((r) => r.data.url === 'https://test.merchant.local/api/v1/refund');
  check('镜像字段写进记录（module/summary/source/syncedAt）', refundRec.data.module === '退款' && !!refundRec.data.syncedAt && refundRec.data.source === 'openapi', refundRec.data.module);

  // 用户写了备注、打了标签、收藏，然后 Apifox 里改了描述
  store.save({
    id: refundRec.id,
    collection: 'apis',
    data: Object.assign({}, refundRec.data, { myNote: '回调有 3 秒延迟', headers: 'X-A: 1', body: '{"a":1}', note: '手写备注' }),
    tags: ['退款', '核心'],
    favorite: true
  });
  const changedDoc = baseDoc();
  changedDoc.paths['/api/v1/refund'].post.description = '改过的描述：金额不能超过订单实付，且需传幂等键。';
  const s3 = store.syncApis({ items: openapi.parseOpenApi(changedDoc).items });
  const afterChange = store.get(refundRec.id);
  check('描述变了会更新这条', s3.updated === 1 && afterChange.data.summary.indexOf('改过的描述') >= 0, s3);
  check('myNote 不被覆盖', afterChange.data.myNote === '回调有 3 秒延迟', afterChange.data.myNote);
  check('headers / body / note 不被覆盖', afterChange.data.headers === 'X-A: 1' && afterChange.data.body === '{"a":1}' && afterChange.data.note === '手写备注');
  check('tags / favorite 保留', afterChange.tags.indexOf('退款') >= 0 && afterChange.favorite === true, { tags: afterChange.tags, fav: afterChange.favorite });
  check('只改描述 → 不算「有变更」（updated 但 changed=0）', s3.updated === 1 && s3.changed === 0, { updated: s3.updated, changed: s3.changed });
  check('没变更时不写 lastChange', !afterChange.data.lastChange, afterChange.data.lastChange);
  check('没变更时「上次同步变更」清空', store.lastSyncChanges() === null, store.lastSyncChanges());

  // ---- 结构化变更：加一个必填 header + 一个新响应字段，并且这条接口挂了用例 ----
  store.links.add({ apiId: refundRec.id, filePath: '退款/退款主流程.md', caseTitle: '正常退款成功' });
  const structDoc = baseDoc();
  structDoc.paths['/api/v1/refund'].post.description = '改过的描述：金额不能超过订单实付，且需传幂等键。';
  structDoc.paths['/api/v1/refund'].post.parameters.push({ name: 'X-Idem-Key', in: 'header', required: true, schema: { type: 'string' } });
  structDoc.components.schemas.RefundResp.properties.refundReason = { type: 'string' };
  const s3b = store.syncApis({ items: openapi.parseOpenApi(structDoc).items });
  const afterStruct = store.get(refundRec.id);
  const lastChange = afterStruct.data.lastChange ? JSON.parse(afterStruct.data.lastChange) : null;
  check('结构变了 → changed=1、updated=1', s3b.updated === 1 && s3b.changed === 1, { updated: s3b.updated, changed: s3b.changed });
  check('变更清单带 apiId / 名称 / 结构标签', (() => {
    const c = (s3b.changedList || [])[0];
    return !!c && c.apiId === refundRec.id && c.name === '创建退款单' && c.changes.some((x) => x.label === '必填参数 +1' && x.detail === 'X-Idem-Key');
  })(), s3b.changedList);
  check('响应体字段新增也算变更', (s3b.changedList[0].changes || []).some((x) => x.kind === 'resp-field-add' && x.detail === 'refundReason'), s3b.changedList[0].changes);
  check('变更落到记录的 lastChange（带时间）', !!lastChange && lastChange.changes.length >= 2 && lastChange.at > 0, lastChange);
  check('影响面：这条变更接口挂着 1 条用例', s3b.affectedCases === 1 && s3b.changedList[0].cases[0].caseTitle === '正常退款成功', { affected: s3b.affectedCases, cases: s3b.changedList[0].cases });
  check('变更清单落 meta，关掉卡片还能再打开', (() => {
    const m = store.lastSyncChanges();
    return !!m && m.changed.length === 1 && m.changed[0].apiId === refundRec.id && m.affectedCases === 1;
  })(), store.lastSyncChanges());

  // ---- 同一份再同步：没有变化 → 不算变更，meta 清空（「上次同步」永远指最近一次） ----
  const s3c = store.syncApis({ items: openapi.parseOpenApi(structDoc).items });
  check('无变化再同步：changed=0 且 meta 清空', s3c.changed === 0 && store.lastSyncChanges() === null, { s3c: s3c.changed, meta: store.lastSyncChanges() });

  // ---- 把加的参数再删掉（回退）→ 检出「必填参数 -1」 ----
  const revertDoc = baseDoc();
  revertDoc.paths['/api/v1/refund'].post.description = '改过的描述：金额不能超过订单实付，且需传幂等键。';
  const s3d = store.syncApis({ items: openapi.parseOpenApi(revertDoc).items });
  check('参数被删掉也能检出（必填参数 -1）', s3d.changed === 1 && (s3d.changedList[0].changes || []).some((x) => x.kind === 'req-param-remove' && x.detail === 'X-Idem-Key'), s3d.changedList);
  check('回退后 lastChange 反映最近一次', (() => {
    const lc = JSON.parse(store.get(refundRec.id).data.lastChange || '{}');
    return (lc.changes || []).some((x) => x.kind === 'req-param-remove');
  })());
  store.links.save({ apiId: refundRec.id, targets: [] });

  // 手写的占位接口：先手动建（Apifox 里还没有），后来导出文件里出现了同 method+url → 应被认领
  const beforeAdopt = store.list('apis').length;
  const manual = store.save({
    collection: 'apis',
    data: { name: '手写的发券接口', method: 'POST', url: 'https://test.merchant.local/api/v1/coupon', myNote: '先占位，等开发给真实路径' },
    tags: ['占位'],
    favorite: false
  });
  const adoptDoc = baseDoc();
  adoptDoc.paths['/api/v1/coupon'] = {
    post: { tags: ['营销'], summary: '发放优惠券', responses: { 200: { description: 'ok' } } }
  };
  const s4 = store.syncApis({ items: openapi.parseOpenApi(adoptDoc).items });
  const adopted = store.get(manual.id);
  check('手写占位接口被认领（不新增重复记录）', store.list('apis').length === beforeAdopt + 1 && s4.added === 0, { len: store.list('apis').length, s4 });
  check('认领后 source 变 openapi、名字跟 Apifox 走、myNote 保留', adopted.data.source === 'openapi' && adopted.data.name === '发放优惠券' && adopted.data.myNote === '先占位，等开发给真实路径', adopted.data);

  // URL 变了 → 新增一条，老记录不删
  const renamed = baseDoc();
  renamed.paths['/api/v1/coupon'] = adoptDoc.paths['/api/v1/coupon'];
  renamed.paths['/api/v1/ping2'] = renamed.paths['/api/v1/ping'];
  delete renamed.paths['/api/v1/ping'];
  const beforeRename = store.list('apis').length;
  const s5 = store.syncApis({ items: openapi.parseOpenApi(renamed).items });
  const urls = store.list('apis').map((r) => r.data.url);
  check('URL 变了算新增', s5.added === 1 && store.list('apis').length === beforeRename + 1, s5);
  check('老 URL 的记录还在（不偷偷删）', urls.indexOf('https://test.merchant.local/api/v1/ping') >= 0 && urls.indexOf('https://test.merchant.local/api/v1/ping2') >= 0, urls);

  // 同一批重复 + 残缺条目
  const s6 = store.syncApis({
    items: [
      { method: 'GET', url: 'https://test.merchant.local/api/v1/dup', name: 'dup' },
      { method: 'GET', url: 'https://test.merchant.local/api/v1/dup', name: 'dup' },
      { name: '没有 method 和 url' },
      null
    ]
  });
  check(
    '同一批重复只写一条、残缺条目计入 invalid',
    s6.added === 1 && s6.dupInBatch === 1 && s6.invalid === 2 &&
      store.list('apis').filter((r) => r.data.url === 'https://test.merchant.local/api/v1/dup').length === 1,
    s6
  );

  // 尾斜杠 / 大小写归一
  const s7 = store.syncApis({ items: [{ method: 'get', url: 'https://test.merchant.local/api/v1/dup/', name: 'dup' }] });
  check('尾斜杠和大小写不同视为同一条', s7.added === 0, s7);

  const s8 = store.syncApis({ items: [] });
  check('空同步不报错', s8 && s8.added === 0 && s8.total === 0, s8);

  // 落盘重开
  const countBefore = store.list('apis').length;
  store.persist();
  await store.init(dirStore);
  check('重开后接口记录还在', store.list('apis').length === countBefore, store.list('apis').length);
  check('重开后 myNote 还在', store.get(refundRec.id).data.myNote === '回调有 3 秒延迟', store.get(refundRec.id).data.myNote);

  // ================= 3. IPC 层 =================
  const goodFile = path.join(fileDir, 'openapi.json');
  fs.writeFileSync(goodFile, JSON.stringify(baseDoc()), 'utf8');
  const badFile = path.join(fileDir, 'broken.json');
  fs.writeFileSync(badFile, '{ not json', 'utf8');
  const swaggerFile = path.join(fileDir, 'swagger2.json');
  fs.writeFileSync(swaggerFile, JSON.stringify({ swagger: '2.0', paths: {} }), 'utf8');

  process.env.TT_DATA_DIR = dirIpc;
  require(path.join(proj, 'electron', 'main.js'));
  await new Promise((r) => setTimeout(r, 2500));
  const call = (channel, payload) => handlers[channel]({}, payload);

  check('apis:sync IPC 已注册', typeof handlers['apis:sync'] === 'function', Object.keys(handlers).filter((k) => k.indexOf('apis:') === 0));

  const synced = await call('apis:sync', { file: goodFile });
  check('IPC 读文件同步成功', !!(synced && synced.ok) && synced.stats.added === 4, synced && synced.stats);
  check('IPC 返回文件信息与项目元信息', synced.file === goodFile && synced.doc.title === '商家门户 API' && synced.doc.version === '1.4.0', synced.doc);

  const again = await call('apis:sync', { file: goodFile });
  check('IPC 重复同步幂等', again.stats.added === 0 && again.stats.skipped === 4, again.stats);
  check('IPC 同步结果带变更字段', typeof again.stats.changed === 'number' && Array.isArray(again.stats.changedList) && again.stats.changed === 0, again.stats);
  check('apis:lastSync IPC 已注册', typeof handlers['apis:lastSync'] === 'function', Object.keys(handlers).filter((k) => k.indexOf('apis:') === 0));
  check('这次没变更 → apis:lastSync 返回 null', (await call('apis:lastSync')) === null);

  const missing = await call('apis:sync', { file: path.join(fileDir, 'nope.json') });
  check('文件不存在时返回 ok:false 而不是抛错', missing && missing.ok === false && !!missing.message, missing);

  const broken = await call('apis:sync', { file: badFile });
  check('坏 JSON 返回 ok:false 且说明原因', broken && broken.ok === false && broken.message.indexOf('JSON') >= 0, broken);

  const swag = await call('apis:sync', { file: swaggerFile });
  check('Swagger 2.0 文件给出「重新导出 OpenAPI 3」提示', swag && swag.ok === false && swag.message.indexOf('OpenAPI 3') >= 0, swag);

  const pinSet = await call('pin:set', { oldPin: '', pin: '2468' });
  await call('app:lock');
  let lockedErr = null;
  try {
    await call('apis:sync', { file: goodFile });
  } catch (e) {
    lockedErr = e;
  }
  check('锁定后同步被拒绝', !!(pinSet && pinSet.ok && lockedErr && lockedErr.code === 'LOCKED'), lockedErr && lockedErr.code);
  let lockedLast = null;
  try {
    await call('apis:lastSync');
  } catch (e) {
    lockedLast = e;
  }
  check('锁定后读变更清单也被拒绝', !!(lockedLast && lockedLast.code === 'LOCKED'), lockedLast && lockedLast.code);
  await call('app:unlock', { pin: '2468' });

  // ================= 汇总 =================
  const failed = results.filter((r) => !r.ok);
  for (const r of results) if (!r.ok) console.log('  ✗ ' + r.name + (r.extra ? '\n      ' + r.extra : ''));
  console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    /* 清不掉就算了，在系统临时目录里 */
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('[test-openapi] 崩了：', e);
  process.exit(1);
});