/* 用例 ↔ 接口关联测试
 *   1) IPC 层：links:save / forApi / forCase / counts / remove / prune + 锁屏拒绝
 *   2) store 层：软键、防重、特殊字符、删接口顺带清关联、落盘重开、prune 边界
 *   3) 迁移层：v3 迁移脚本能在老库上建出 case_api_links，v2 老库升级有备份
 * 用一个 stub 顶掉 electron，不需要 GUI。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), 'tt-links-' + Date.now());
const dirIpc = path.join(tmp, 'ipc');
const dirStore = path.join(tmp, 'store');
const dirLegacy = path.join(tmp, 'legacy');
fs.mkdirSync(tmp, { recursive: true });

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
      return '0.7.0';
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
    showErrorBox(title, msg) {
      console.error('DIALOG', title, msg);
    },
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
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

process.env.TT_DATA_DIR = dirIpc;
delete process.env.TT_DEBUG;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
}

const CASE_A = { filePath: '模块A重构/TC_模块A重构.md', caseTitle: '工作台快捷操作区渲染 9 入口', caseIndex: 1 };
const CASE_B = { filePath: 'TC_回归测试_极简链路用例.md', caseTitle: '余额核销核心回归链', caseIndex: 1 };

(async () => {
  // ================= 1. IPC 层 =================
  require(path.join(proj, 'electron', 'main.js'));
  await new Promise((r) => setTimeout(r, 2500));

  const call = (channel, payload) => handlers[channel]({}, payload);
  check('links:* IPC 已注册', ['links:forApi', 'links:forCase', 'links:counts', 'links:save', 'links:remove', 'links:prune'].every((c) => typeof handlers[c] === 'function'), Object.keys(handlers).filter((k) => k.indexOf('links:') === 0));

  const apiRec = await call('records:save', {
    collection: 'apis',
    data: { name: '创建退款单', method: 'POST', url: 'https://test.local/api/refund', headers: '', body: '', note: '' },
    tags: []
  });
  check('接口记录建好', !!(apiRec && apiRec.id), apiRec);

  const emptyList = await call('links:forApi', { apiId: apiRec.id });
  check('新接口的关联为空（空是合法状态）', Array.isArray(emptyList) && emptyList.length === 0, emptyList);

  const saved = await call('links:save', { apiId: apiRec.id, targets: [CASE_A, CASE_B] });
  check('IPC 保存关联返回条数', saved && saved.count === 2, saved);

  const byApi = await call('links:forApi', { apiId: apiRec.id });
  check('IPC 按接口读回 2 条关联', byApi.length === 2, byApi.length);
  check(
    'IPC 关联行字段齐全（file_path/case_title/api_id/source）',
    byApi[0] && byApi[0].file_path === CASE_A.filePath && byApi[0].case_title === CASE_A.caseTitle && byApi[0].api_id === apiRec.id && byApi[0].source === 'manual',
    byApi[0]
  );

  const byCase = await call('links:forCase', { filePath: CASE_B.filePath, caseTitle: CASE_B.caseTitle });
  check('IPC 按用例读回所属接口', byCase.length === 1 && byCase[0].api_id === apiRec.id, byCase);

  const counts = await call('links:counts');
  check('IPC 按接口聚合条数', counts[apiRec.id] === 2, counts);

  const oneRemoved = await call('links:remove', { id: byApi[0].id });
  check('IPC 删单条关联生效', oneRemoved && oneRemoved.removed === 1, oneRemoved);
  check('IPC 删完只剩 1 条', (await call('links:forApi', { apiId: apiRec.id })).length === 1);

  const replaced = await call('links:save', { apiId: apiRec.id, targets: [CASE_A] });
  check('IPC 整组替换能算出删除数', replaced && replaced.count === 1 && replaced.removed === 1 && replaced.added === 1, replaced);

  const pruned = await call('links:prune');
  check('IPC prune 正常返回', pruned && typeof pruned.removed === 'number', pruned);

  const pinSet = await call('pin:set', { oldPin: '', pin: '2468' });
  await call('app:lock');
  let lockedErr = null;
  try {
    await call('links:forApi', { apiId: apiRec.id });
  } catch (e) {
    lockedErr = e;
  }
  check('锁定后关联 IPC 被拒绝', !!(pinSet && pinSet.ok && lockedErr && lockedErr.code === 'LOCKED'), lockedErr && lockedErr.code);
  await call('app:unlock', { pin: '2468' });

  // ================= 2. store 层 =================
  const store = require(path.join(proj, 'electron', 'store'));
  await store.init(dirStore);
  const links = store.links;

  check('新库自带关联表', Array.isArray(links.forApi('nope')) && links.forApi('nope').length === 0);

  const api2 = store.save({ collection: 'apis', data: { name: '查询订单详情', method: 'GET', url: 'https://test.local/api/order' }, tags: [] });
  links.add({ apiId: api2.id, filePath: CASE_A.filePath, caseTitle: CASE_A.caseTitle, caseIndex: 1 });
  links.add({ apiId: api2.id, filePath: CASE_A.filePath, caseTitle: CASE_A.caseTitle, caseIndex: 1 });
  check('重复加同一关联只留一条（唯一索引幂等）', links.forApi(api2.id).length === 1, links.forApi(api2.id).length);

  const weird = '“退款”\u0000<>&\' 🔴 高风险 & 空格 标题';
  links.add({ apiId: api2.id, filePath: '目录/文件 A.md', caseTitle: weird, caseIndex: 7 });
  const weirdRows = links.forCase('目录/文件 A.md', weird);
  check('标题带引号/尖括号/emoji/NUL 能存能取', weirdRows.length === 1 && weirdRows[0].case_title === weird, weirdRows);

  const emptySave = links.save({ apiId: api2.id, targets: [] });
  check('保存空数组 = 全部取消，不报错', emptySave && emptySave.count === 0 && links.forApi(api2.id).length === 0, emptySave);

  links.save({ apiId: api2.id, targets: [CASE_A, CASE_B, CASE_A] });
  check('保存时按软键去重', links.forApi(api2.id).length === 2, links.forApi(api2.id).length);

  store.remove(api2.id);
  check('删接口记录顺带清掉它的关联', links.forApi(api2.id).length === 0 && Object.keys(links.counts()).length === 0, links.counts());

  const ghost = store.save({ collection: 'apis', data: { name: '占位接口', method: 'POST', url: 'https://test.local/ghost' }, tags: [] });
  links.add({ apiId: ghost.id, filePath: CASE_B.filePath, caseTitle: CASE_B.caseTitle });
  const beforePrune = links.counts();
  check('占位接口也能关联（Apifox 找不到路径时的手动兜底）', beforePrune[ghost.id] === 1, beforePrune);

  links.add({ apiId: 'r_deleted_elsewhere', filePath: 'x.md', caseTitle: '野关联' });
  const pruneRes = links.prune();
  check('prune 只清指向不存在接口的关联', pruneRes.removed === 1 && links.counts()[ghost.id] === 1, pruneRes);
  check('prune 之后野关联没了', links.forApi('r_deleted_elsewhere').length === 0);

  store.close();
  await store.init(dirStore);
  check('关联落盘后重开数据库仍在', store.links.forCase(CASE_B.filePath, CASE_B.caseTitle).length === 1, store.links.counts());

  // ================= 3. 迁移层 =================
  const initSqlJs = require(path.join(proj, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve(path.join(proj, 'node_modules', 'sql.js'))), f)
  });
  const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

  const migrations = require(path.join(proj, 'electron', 'migrations'));
  const m3 = migrations.MIGRATIONS.find((m) => m.to === 3);
  check('真实迁移里有 v3（建关联表）', !!m3);

  // 3.1 直接在 v2 裸库上跑 v3 迁移脚本
  const bare = new SQL.Database();
  bare.run(OLD_SCHEMA);
  bare.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', '2']);
  m3.run({ sql: (stmt, params) => (params === undefined ? bare.run(stmt) : bare.run(stmt, params)) });
  const tableRow = bare.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='case_api_links'");
  const indexRow = bare.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_link'");
  check('v3 迁移在老库上建出了 case_api_links', tableRow.length > 0 && tableRow[0].values.length === 1, tableRow);
  check('v3 迁移建了唯一索引 idx_link', indexRow.length > 0 && indexRow[0].values.length === 1, indexRow);
  bare.run('INSERT INTO case_api_links (file_path, case_title, case_index, api_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['a.md', '标题', 1, 'r_x', 'manual', Date.now()]);
  const dupErr = (() => {
    try {
      bare.run('INSERT INTO case_api_links (file_path, case_title, case_index, api_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['a.md', '标题', 9, 'r_x', 'manual', Date.now()]);
      return null;
    } catch (e) {
      return e;
    }
  })();
  check('同一 (file_path, case_title, api_id) 插不进去', !!dupErr, dupErr && String(dupErr.message || dupErr));
  bare.close();

  // 3.2 v2 老库交给 store 升级
  fs.mkdirSync(dirLegacy, { recursive: true });
  const legacy = new SQL.Database();
  legacy.run(OLD_SCHEMA);
  legacy.run(
    'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['r_old_api', 'apis', '老接口', JSON.stringify({ name: '老接口', method: 'GET', url: 'https://old.local/x' }), '', 0, Date.now(), Date.now()]
  );
  legacy.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', '2']);
  fs.writeFileSync(path.join(dirLegacy, 'data.db'), Buffer.from(legacy.export()));
  legacy.close();

  const store2 = require(path.join(proj, 'electron', 'store'));
  const legacyInfo = await store2.init(dirLegacy);
  check(
    'v2 老库启动后版本号升到当前版本',
    store2.schemaVersion() === require(path.join(proj, 'electron', 'migrations')).SCHEMA_VERSION,
    store2.schemaVersion()
  );
  check(
    'v2 老库升级留下了迁移前备份',
    !!(legacyInfo.migration && /data-before-v2-/.test(legacyInfo.migration.backupFile || '') && fs.existsSync(legacyInfo.migration.backupFile)),
    legacyInfo.migration
  );
  store2.links.add({ apiId: 'r_old_api', filePath: 'a.md', caseTitle: '老用例', caseIndex: 3 });
  check('v2 老库升级后关联表可用', store2.links.forApi('r_old_api').length === 1, store2.links.counts());
  check('老记录没被迁移动坏', store2.get('r_old_api').title === '老接口', store2.get('r_old_api') && store2.get('r_old_api').title);

  store2.close();
  store.close();

  // ================= 4. 灰字候选（纯函数） =================
  const suggest = require(path.join(proj, 'shared', 'suggest.js'));
  const apiData = {
    name: '创建退款单',
    module: '退款',
    summary: '创建退款单。金额不能超过订单实付；同一订单可多次部分退款。',
    url: 'https://test.refund.local/api/v1/refund'
  };
  const kws = suggest.keywordsOf(apiData);
  const kwList = kws.map((k) => k.kw);
  check('候选关键词含接口名与模块', kwList.indexOf('创建退款单') >= 0 && kwList.indexOf('退款') >= 0, kwList);
  check('关键词带权重：接口名 > 模块', (kws.find((k) => k.kw === '创建退款单') || {}).w > (kws.find((k) => k.kw === '退款') || {}).w, kws);
  check('URL 路径段进关键词（refund）', kwList.indexOf('refund') >= 0, kwList);
  check('URL 里的版本号 / api 段被跳过', kwList.indexOf('v1') < 0 && kwList.indexOf('api') < 0, kwList);
  check('「未分组」「其他」不进关键词', (() => {
    const a = suggest.keywordsOf({ module: '未分组', name: 'A1' }).map((k) => k.kw);
    const b = suggest.keywordsOf({ module: '其他', name: 'A2' }).map((k) => k.kw);
    return a.indexOf('未分组') < 0 && b.indexOf('其他') < 0;
  })());
  check('停用词（接口/测试/用例…）不进关键词', (() => {
    const list = suggest.keywordsOf({ name: '接口测试' }).map((k) => k.kw);
    return list.indexOf('接口') < 0 && list.indexOf('测试') < 0;
  })(), suggest.keywordsOf({ name: '接口测试' }));

  const cases = [
    { key: 'k1', filePath: 'x.md', title: '创建退款单成功且流水可查', module: '退款', branch: '创建退款单' },
    { key: 'k2', filePath: 'z.md', title: '订单退款金额超过实付金额应被拦截', module: '订单', branch: '退款校验' },
    { key: 'k3', filePath: 'y.md', title: '工作台快捷操作区渲染 9 入口', module: '工作台与全局', branch: '快捷操作区' },
    { key: 'k4', filePath: 'w.md', title: '删除已退款订单', module: '订单', branch: '' }
  ];
  const ranked = suggest.suggestCases(apiData, cases);
  check('命中的用例按相关度排序（名称命中排第一）', ranked.length >= 2 && ranked[0].key === 'k1', ranked.map((r) => r.key + ':' + r.score));
  check('完全无关的用例不出现（不塞噪音）', ranked.every((r) => r.key !== 'k3'), ranked.map((r) => r.key));
  check('每条候选都说清命中了什么词', ranked.every((r) => Array.isArray(r.hits) && r.hits.length > 0), ranked);
  check('已勾上的不再当候选（exclude）', suggest.suggestCases(apiData, cases, { exclude: ['k1'] }).every((r) => r.key !== 'k1'));
  check('条数受 limit 限制', suggest.suggestCases(apiData, cases, { limit: 1 }).length === 1, suggest.suggestCases(apiData, cases, { limit: 1 }));
  check('接口没名没模块 → 不给候选', suggest.suggestCases({}, cases).length === 0);
  check('用例列表为空 → 空数组而不是报错', suggest.suggestCases(apiData, []).length === 0);
  check('传 null / 脏数据不抛异常', (() => {
    try {
      suggest.suggestCases(null, null);
      suggest.suggestCases(apiData, [null, { title: '' }]);
      return true;
    } catch (e) {
      return false;
    }
  })());
  check('模块命中也能进候选（标题里没有接口名）', (() => {
    const only = [{ key: 'm1', filePath: 'a.md', title: '退款流水列表分页正确', module: '退款', branch: '' }];
    return suggest.suggestCases({ name: '退款', module: '退款' }, only).length === 1;
  })());
  check('描述里的词权重低于接口名', (() => {
    const a = suggest.keywordsOf({ name: '退款', summary: '同一订单可多次部分退款' });
    const nameW = (a.find((k) => k.kw === '退款') || {}).w || 0;
    const descW = (a.find((k) => k.kw === '同一订单可多次部分退款') || {}).w || 99;
    return nameW > descW;
  })());
  check('候选里带 filePath（点了能回填关联）', ranked.every((r) => typeof r.filePath === 'string' && r.filePath.length > 0), ranked);

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 用例 ↔ 接口关联测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});