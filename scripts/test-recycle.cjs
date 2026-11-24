/*
 * 回收站（软删除）+ SQL 片段「转化为变量」测试
 *
 * 三块：
 *   1. src/utils.ts 的两个纯函数（esbuild 现场转译，和 test-vars.cjs 同一套办法）
 *   2. 真实 store（sql.js 落盘）上的软删除 / 恢复 / 彻底删除 / 过期清理 / 过滤
 *   3. ipc-records.js 的 5 条回收站通道（stub 掉 electron，直接调 handler）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmp = path.join(os.tmpdir(), 'tt-recycle-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

// --- stub electron（store -> security 需要 safeStorage）---
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
      }
    };
  }
  return origLoad.apply(this, arguments);
};

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ================================================================== *
 * 1. 纯函数：convertSelectionToVar / suggestVarName / trashDaysLeft
 * ================================================================== */
const esbuild = require(path.join(proj, 'node_modules', 'esbuild'));

function loadUtils() {
  const src = fs
    .readFileSync(path.join(proj, 'src', 'utils.ts'), 'utf8')
    // 去掉 import（dayjs / collections 在这几个纯函数里用不到）
    .replace(/^import .*$/gm, '');
  const code =
    src +
    '\nmodule.exports = { convertSelectionToVar, suggestVarName, trashDaysLeft, TRASH_RETENTION_DAYS, VAR_NAME_PATTERN };\n';
  const out = esbuild.transformSync(code, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
  return mod.exports;
}

const U = loadUtils();
const { convertSelectionToVar, suggestVarName, trashDaysLeft, TRASH_RETENTION_DAYS } = U;

/* ---- 变量名生成 ---- */
check('英文标识符直接当变量名', suggestVarName('orderNo', []) === 'orderNo', suggestVarName('orderNo', []));
check('中文选中内容不硬猜，生成 var1', suggestVarName('张三', []) === 'var1', suggestVarName('张三', []));
check('纯数字选中内容生成 var1', suggestVarName('SO20261124001', []) === 'var1', suggestVarName('SO20261124001', []));
check(
  '已有 var1 时递增到 var2',
  suggestVarName('123', [{ name: 'var1', value: '', desc: '' }]) === 'var2',
  suggestVarName('123', [{ name: 'var1', value: '', desc: '' }])
);
check(
  '英文名撞车时递增加后缀',
  suggestVarName('orderNo', [{ name: 'orderNo', value: '', desc: '' }]) === 'orderNo2',
  suggestVarName('orderNo', [{ name: 'orderNo', value: '', desc: '' }])
);
check('带点号横线的标识符也认', suggestVarName('a.b-c', []) === 'a.b-c', suggestVarName('a.b-c', []));
check('以数字开头的不算标识符', suggestVarName('1abc', []) === 'var1', suggestVarName('1abc', []));
check('前后空格要 trim 后再猜', suggestVarName('  orderNo  ', []) === 'orderNo', suggestVarName('  orderNo  ', []));
check(
  '空变量名的行不占名字',
  suggestVarName('orderNo', [{ name: '', value: '', desc: '' }]) === 'orderNo',
  suggestVarName('orderNo', [{ name: '', value: '', desc: '' }])
);

/* ---- 替换 ---- */
const SQL0 = "select * from t_refund where order_no = 'SO20261124001'";
const start0 = SQL0.indexOf('SO20261124001');
const end0 = start0 + 'SO20261124001'.length;
const r1 = convertSelectionToVar(SQL0, start0, end0, [], 'SO20261124001');
check('选中文字被换成 {{var1}}', r1.ok && r1.text === SQL0.replace('SO20261124001', '{{var1}}'), r1.text);
check('返回变量名', r1.ok && r1.varName === 'var1', r1.varName);
check('光标落在 }} 后面', r1.ok && r1.text.slice(r1.cursor - 2, r1.cursor) === '}}' && r1.text.charAt(r1.cursor) === "'", {
  cursor: r1.cursor,
  near: r1.text.slice(Math.max(0, r1.cursor - 4), r1.cursor + 2)
});
check(
  '变量表追加一条空定义',
  r1.ok && r1.vars.length === 1 && r1.vars[0].name === 'var1' && r1.vars[0].value === '' && r1.vars[0].desc === '',
  r1.vars
);

const r2 = convertSelectionToVar(SQL0, start0, end0, [{ name: 'orderNo', value: '1', desc: '订单号' }], 'SO20261124001', 'orderNo');
check('弹框里改的名字优先生效', r2.ok && r2.varName === 'orderNo' && r2.text.indexOf('{{orderNo}}') > 0, r2.text);
check('追加时保留已有变量', r2.ok && r2.vars.length === 2 && r2.vars[0].name === 'orderNo' && r2.vars[1].desc === '', r2.vars);

/* ---- 防错位 / 幂等 / 边界 ---- */
const changed = convertSelectionToVar(SQL0, start0, end0, [], 'SO20261124');
check('正文变了 → changed，且正文原样返回', !changed.ok && changed.reason === 'changed' && changed.text === SQL0, changed);
check('没选中 → empty', convertSelectionToVar(SQL0, 5, 5, []).reason === 'empty');
check('只选空白 → empty', convertSelectionToVar('a   b', 1, 4, []).reason === 'empty');
const already = convertSelectionToVar('select {{orderNo}}', 7, 18, []);
check('已经是变量 → already，不套第二层', !already.ok && already.reason === 'already' && already.varName === 'orderNo', already);
const alreadySpaced = convertSelectionToVar('{{ orderNo }}', 0, 13, []);
check('{{ 名字 }} 带空格也算已经是变量', alreadySpaced.reason === 'already' && alreadySpaced.varName === 'orderNo', alreadySpaced);
const oob = convertSelectionToVar('abc', 2, 999, []);
check('坐标越界不崩，夹到正文范围内', oob.ok && oob.text === 'ab{{c}}', oob);
const reversed = convertSelectionToVar('abcdef', 4, 2, []);
check('终点小于起点当没选（empty）', reversed.reason === 'empty', reversed);
const cn = convertSelectionToVar("where name = '张三'", 14, 16, []);
check('中文选中内容 → var1', cn.ok && cn.text.indexOf('{{var1}}') > 0, cn.text);

/* ---- 回收站倒计时 ---- */
const now = Date.now();
check('保留天数常量 = 30', TRASH_RETENTION_DAYS === 30, TRASH_RETENTION_DAYS);
check('刚删的显示 30 天', trashDaysLeft(now, now) === 30, trashDaysLeft(now, now));
check('删了 15 天显示 15 天', trashDaysLeft(now - 15 * 86400000, now) === 15, trashDaysLeft(now - 15 * 86400000, now));
check('超过保留期不显示负数', trashDaysLeft(now - 40 * 86400000, now) === 0, trashDaysLeft(now - 40 * 86400000, now));
check('没有删除时间时按满期算', trashDaysLeft(0, now) === 30, trashDaysLeft(0, now));

/* ================================================================== *
 * 2. 真实 store
 * ================================================================== */
const store = require(path.join(proj, 'electron', 'store'));

(async () => {
  const dataDir = path.join(tmp, 'store');
  await store.init(dataDir);
  check(
    '新库带回收站字段（deleted_at=0）',
    (() => {
      const r = store.save({ collection: 'pages', data: { name: '第一条' }, tags: [] });
      return r && r.deleted_at === 0;
    })()
  );

  // ---- 软删除 ----
  const s1 = store.save({ collection: 'sites', data: { name: '要删的站点', url: 'https://x.local' }, tags: [] });
  const delOk = store.remove(s1.id);
  check('remove 返回 true', delOk === true, delOk);
  check('删完不出现在正常列表', store.list('sites').length === 0, store.list('sites').length);
  check('get 默认读不到已删除的', store.get(s1.id) === null, store.get(s1.id));
  check('includeDeleted 才读得到', !!store.get(s1.id, { includeDeleted: true }), store.get(s1.id, { includeDeleted: true }));
  check('还能拿到删除时间', (store.get(s1.id, { includeDeleted: true }) || {}).deleted_at > 0);
  check(
    'list(includeDeleted) 能一起看',
    store.list('sites', { includeDeleted: true }).length === 1,
    store.list('sites', { includeDeleted: true }).length
  );
  check('counts 不计已删除的', store.counts().sites === undefined, store.counts());
  check('counts(includeDeleted) 才把回收站算进去', store.counts({ includeDeleted: true }).sites === 1, store.counts({ includeDeleted: true }));
  check('countTrash 计到 1 条', store.countTrash() === 1, store.countTrash());
  check(
    'listTrash 带集合与标题',
    (() => {
      const t = store.listTrash();
      return t.length === 1 && t[0].id === s1.id && t[0].collection === 'sites' && t[0].title === '要删的站点';
    })(),
    store.listTrash()
  );
  check(
    '重复 remove 不刷新删除时间（幂等）',
    (() => {
      const before = store.get(s1.id, { includeDeleted: true }).deleted_at;
      store.remove(s1.id);
      return store.get(s1.id, { includeDeleted: true }).deleted_at === before;
    })()
  );
  check('remove 不存在的 id 返回 false', store.remove('r_nope') === false);

  // ---- 导出不含回收站 ----
  const exported = store.exportAll(false, null);
  check(
    '导出不含回收站里的记录',
    exported.records.every((r) => r.id !== s1.id) && exported.records.length === 1,
    exported.records.map((r) => r.id)
  );

  // ---- 恢复 ----
  const rsOk = store.restore(s1.id);
  check('restore 返回 true', rsOk === true, rsOk);
  check('恢复后回到正常列表', store.list('sites').length === 1, store.list('sites').length);
  check('恢复后 countTrash 归零', store.countTrash() === 0, store.countTrash());
  check('恢复后 deleted_at 归零', store.get(s1.id).deleted_at === 0, store.get(s1.id).deleted_at);
  check('对未删除的记录 restore 返回 false', store.restore(s1.id) === false);

  // ---- 保存回收站里的记录 = 复活（导入备份时的路径）----
  store.remove(s1.id);
  const revived = store.save({ id: s1.id, collection: 'sites', data: { name: '又活了' }, tags: [] });
  check('按 id 保存回收站里的记录会复活', revived && revived.deleted_at === 0 && store.list('sites').length === 1, revived);
  check('复活后标题按新值更新', store.get(s1.id).title === '又活了', store.get(s1.id).title);

  // ---- 用例↔接口关联跟着回收站走 ----
  const apiRec = store.save({
    collection: 'apis',
    data: { name: '查询订单', method: 'GET', url: 'https://t.local/order' },
    tags: []
  });
  store.links.add({ apiId: apiRec.id, filePath: '用例/订单.md', caseTitle: '查询订单-正常' });
  check('关联先建好', store.links.forApi(apiRec.id).length === 1, store.links.forApi(apiRec.id).length);
  store.remove(apiRec.id);
  check(
    '接口进回收站后，关联查询不到（不显示悬空关联）',
    store.links.forApi(apiRec.id).length === 0 && Object.keys(store.links.counts()).length === 0,
    store.links.counts()
  );
  check('用例那边也查不到已删接口', store.links.forCase('用例/订单.md', '查询订单-正常').length === 0);
  store.restore(apiRec.id);
  check('接口恢复后，用例关联一起回来', store.links.forApi(apiRec.id).length === 1, store.links.forApi(apiRec.id).length);

  // ---- 彻底删除 ----
  store.remove(apiRec.id);
  const purgeOk = store.purge(apiRec.id);
  check('purge 返回 true', purgeOk === true, purgeOk);
  check('purge 之后真的没了（includeDeleted 也读不到）', store.get(apiRec.id, { includeDeleted: true }) === null);
  check('purge 之后 countTrash 归零', store.countTrash() === 0, store.countTrash());
  check(
    'purge 接口时关联也一起清掉',
    store.links.forApi(apiRec.id).length === 0 && Object.keys(store.links.counts()).length === 0,
    store.links.counts()
  );
  check('purge 不存在的 id 返回 false', store.purge('r_nope') === false);

  // ---- 同步不吃回收站里的接口 ----
  const syncUrl = 'https://t.local/sync-only';
  const syncRec = store.save({ collection: 'apis', data: { name: '同步接口', method: 'GET', url: syncUrl }, tags: [] });
  store.remove(syncRec.id);
  const liveBefore = store.list('apis').length;
  const syncStats = store.syncApis({ items: [{ name: '同步接口', method: 'GET', url: syncUrl, completeness: 'ok' }] });
  check(
    '回收站里的接口不参与同步匹配（按新增处理）',
    syncStats.added === 1 && syncStats.updated === 0 && store.list('apis').length === liveBefore + 1,
    syncStats
  );
  // 清掉这条，后面数回收站条数才好数
  store.purge(syncRec.id);

  // ---- 清空回收站 ----
  const c1 = store.save({ collection: 'pages', data: { name: '垃圾1' }, tags: [] });
  const c2 = store.save({ collection: 'pages', data: { name: '垃圾2' }, tags: [] });
  store.remove(c1.id);
  store.remove(c2.id);
  check('清空前 countTrash = 2', store.countTrash() === 2, store.countTrash());
  const cleared = store.clearTrash();
  check('clearTrash 报出清了几条', cleared.removed === 2, cleared);
  check('清空后回收站为空', store.countTrash() === 0 && store.listTrash().length === 0);
  check(
    '清空后正常记录不受影响',
    store.list('pages').length === 1,
    store.list('pages').map((r) => r.title)
  );

  // ---- 过期清理（超过 30 天）----
  const oldRec = store.save({ collection: 'pages', data: { name: '过期垃圾' }, tags: [] });
  store.remove(oldRec.id);
  const freshRec = store.save({ collection: 'pages', data: { name: '刚删的' }, tags: [] });
  store.remove(freshRec.id);
  // 把「过期垃圾」的删除时间改到 31 天前：关库 → 改文件 → 重开
  store.close();
  const initSqlJs = require(path.join(proj, 'node_modules', 'sql.js'));
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(path.dirname(require.resolve(path.join(proj, 'node_modules', 'sql.js'))), f)
  });
  const dbFile = path.join(dataDir, 'data.db');
  const raw = new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)));
  raw.run('UPDATE records SET deleted_at = ? WHERE id = ?', [Date.now() - 31 * 86400000, oldRec.id]);
  fs.writeFileSync(dbFile, Buffer.from(raw.export()));
  raw.close();
  await store.init(dataDir);
  check('重开后两条都还在回收站', store.countTrash() === 2, store.countTrash());
  const swept = store.purgeExpired(30);
  check('purgeExpired 只清超过 30 天的', swept.removed === 1 && swept.days === 30, swept);
  check('刚删的那条没被误删', store.get(freshRec.id, { includeDeleted: true }) !== null);
  check('过期那条真的没了', store.get(oldRec.id, { includeDeleted: true }) === null);
  check('purgeExpired 默认天数 = 30', store.purgeExpired().days === 30 && store.TRASH_RETENTION_DAYS === 30);
  check('过期清理后回收站只剩刚删的那条', store.countTrash() === 1 && store.listTrash()[0].id === freshRec.id, store.countTrash());
  store.purge(freshRec.id);
  check('把剩下那条也彻底删掉，回收站清零', store.countTrash() === 0, store.countTrash());

  /* ================================================================ *
   * 3. IPC 通道
   * ================================================================ */
  const handlers = {};
  const fakeIpc = {
    handle(channel, fn) {
      handlers[channel] = fn;
    }
  };
  require(path.join(proj, 'electron', 'ipc', 'ipc-records')).register({
    ipcMain: fakeIpc,
    dialog: {},
    shell: {},
    app: { getPath: () => tmp },
    store,
    path,
    fs,
    getWindow: () => null,
    getSettings: () => ({}),
    loadSettings: () => {},
    publicSettings: () => ({}),
    assertUnlocked: () => {},
    isLocked: () => false
  });

  const TRASH_CHANNELS = [
    'records:trash-list',
    'records:trash-count',
    'records:trash-restore',
    'records:trash-purge',
    'records:trash-clear'
  ];
  check(
    '注册了 5 条回收站通道',
    TRASH_CHANNELS.every((ch) => typeof handlers[ch] === 'function'),
    TRASH_CHANNELS.filter((ch) => typeof handlers[ch] !== 'function')
  );

  const ipcRec = store.save({ collection: 'pages', data: { name: '走 IPC 删的' }, tags: [] });
  await handlers['records:remove']({}, { id: ipcRec.id });
  const trashList = await handlers['records:trash-list']({});
  check('trash-list 能读到刚删的记录', trashList.length === 1 && trashList[0].id === ipcRec.id, trashList.map((r) => r.id));
  check('trash-count 与列表一致', (await handlers['records:trash-count']({})) === 1);
  check(
    'trash-restore 恢复成功',
    (await handlers['records:trash-restore']({}, { id: ipcRec.id })) === true &&
      store.list('pages').some((r) => r.id === ipcRec.id)
  );
  check('trash-restore 对不存在的 id 返回 false', (await handlers['records:trash-restore']({}, { id: 'r_nope' })) === false);

  await handlers['records:remove']({}, { id: ipcRec.id });
  check('trash-purge 彻底删除', (await handlers['records:trash-purge']({}, { id: ipcRec.id })) === true);
  check('彻底删除后 countTrash = 0', (await handlers['records:trash-count']({})) === 0);

  const batch = [
    store.save({ collection: 'pages', data: { name: '批量1' }, tags: [] }),
    store.save({ collection: 'pages', data: { name: '批量2' }, tags: [] })
  ];
  for (const r of batch) await handlers['records:remove']({}, { id: r.id });
  const clearRes = await handlers['records:trash-clear']({});
  check('trash-clear 报出清空条数', clearRes && clearRes.removed === 2, clearRes);
  check('清空后列表为空', (await handlers['records:trash-list']({})).length === 0);

  /* ================================================================ *
   * 4. 前端接线（静态检查：这几个文件不能漏）
   * ================================================================ */
  const readSrc = (rel) => fs.readFileSync(path.join(proj, rel), 'utf8');
  const trashPage = readSrc('src/pages/TrashPage.tsx');
  check('有回收站页面', trashPage.indexOf('回收站') > 0, 'missing');
  check('回收站显示自动清除倒计时', /天后自动清除/.test(trashPage), 'no countdown');
  check('彻底删除有二次确认文案', /不可撤销，也无法从回收站恢复/.test(trashPage), 'no confirm text');
  check('支持批量操作', /rowSelection/.test(trashPage) && /恢复所选/.test(trashPage), 'no batch');
  check('侧栏有回收站入口', /回收站/.test(readSrc('src/components/Sidebar.tsx')), 'no sidebar entry');
  check('App 有 trash 路由', /route\.type === 'trash'/.test(readSrc('src/App.tsx')), 'no route');
  check(
    '列表页删除文案改成「移入回收站」',
    /移入回收站/.test(readSrc('src/components/CollectionPage.tsx')) &&
      /之后可以在回收站里恢复/.test(readSrc('src/components/RecordDetail.tsx')),
    'copy not updated'
  );
  check('SQL 表单里有「转化为变量」按钮', /转化为变量/.test(readSrc('src/components/RecordForm.tsx')), 'no button');
  check(
    '只给 sqls 的 sql 字段显示按钮',
    /conf\.key === 'sqls' && f\.key === 'sql'/.test(readSrc('src/components/RecordForm.tsx')),
    'guard missing'
  );
  check('主进程装配层没被塞业务代码', !/trash|recycle|回收站/i.test(readSrc('electron/main.js')), 'main.js touched');
  check('回收站通道加在 ipc-records.js 里', /records:trash-list/.test(readSrc('electron/ipc/ipc-records.js')), 'wrong file');

  store.close();

  /* ---- 汇总 ---- */
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 回收站 + SQL 转变量测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});