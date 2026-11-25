/* 主进程逻辑冒烟测试：用 stub 顶掉 electron，直接验证 store / 加密 / 锁 / IPC */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const tmp = path.join(os.tmpdir(), 'tt-test-' + Date.now());
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
      return '0.1.0';
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
  shell: { openExternal: async () => true, openPath: async () => '' },
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

process.env.TT_DATA_DIR = tmp;
delete process.env.TT_DEBUG;
// 关掉示例数据：这个测试断言的是「自己写了几条就是几条」，混进 demo 会全乱
process.env.TT_NO_DEMO = '1';

require(path.join(__dirname, '..', 'electron', 'main.js'));

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
}

/* 真实资产目录不存在时**显式跳过**：unit 档必须能在任何机器上绿，
 * 但跳过要出现在汇总里，不能像以前那样假装跑过。 */
const skipped = [];
function skip(name) {
  skipped.push(name);
}

/**
 * 从 jtl 源文件独立数一遍样本行。
 * 不复用 electron/jtl.js 的解析器，否则「自己证自己」没有意义。
 */
function countJtlSamples(file) {
  if (!file || !fs.existsSync(file)) return 0;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return 0;
  }
  const head = text.slice(0, 400).trim();
  // XML 格式（output_format=xml）：数样本节点
  if (head.indexOf('<?xml') === 0 || head.indexOf('<testResults') === 0) {
    return (text.match(/<(?:httpSample|sample)\b/g) || []).length;
  }
  // CSV 格式：按表头取 timeStamp / elapsed，数两列都是数字的行
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return 0;
  const header = lines[0].split(',').map((h) => h.trim());
  const tsIdx = header.indexOf('timeStamp');
  const elIdx = header.indexOf('elapsed');
  if (tsIdx < 0 || elIdx < 0) return 0;
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (Number.isFinite(Number(c[tsIdx])) && Number.isFinite(Number(c[elIdx]))) n++;
  }
  return n;
}

const call = (channel, payload) => handlers[channel]({}, payload);

(async () => {
  await new Promise((r) => setTimeout(r, 2500));

  const init = await call('app:init');
  check('init 返回版本与设置', init && init.version === '0.1.0' && init.settings.hasPin === false, init);
  check('init 未锁定（未设密码）', init.locked === false);

  const saved = await call('records:save', {
    collection: 'sites',
    data: {
      name: '测试站A',
      url: 'https://a.test.local',
      env: ['test'],
      // v0.30.0 起账号在 accounts 数组里，密码是嵌套字段（靠 secretPaths 加密）
      accounts: [
        { label: '管理员', account: 'admin', password: 'SuperSecret123', role: ['admin'], isDefault: true, note: '' }
      ],
      note: 'note-abc'
    },
    tags: ['tagA'],
    favorite: true
  });
  check(
    '保存返回明文密码给界面',
    saved && saved.data.accounts && saved.data.accounts[0].password === 'SuperSecret123',
    saved && saved.data
  );

  const dbPath = path.join(tmp, 'data.db');
  await new Promise((r) => setTimeout(r, 800)); // 等 400ms 防抖落盘
  const raw = fs.readFileSync(dbPath);
  check('数据库里没有明文密码', raw.indexOf(Buffer.from('SuperSecret123')) === -1);
  check('数据库里有密文前缀', raw.indexOf(Buffer.from('enc:')) >= 0);

  const list = await call('records:list', { collection: 'sites' });
  check(
    '列表返回 1 条且解密正确',
    list.length === 1 && list[0].data.accounts[0].password === 'SuperSecret123',
    list.length
  );
  check('标题取 name 字段', list[0].title === '测试站A');
  check('标签保存正确', Array.isArray(list[0].tags) && list[0].tags[0] === 'tagA');

  const kw = await call('records:list', { collection: 'sites', keyword: 'note-abc' });
  check('按明文内容搜索命中', kw.length === 1, kw.length);
  const kw2 = await call('records:list', { collection: 'sites', keyword: 'SuperSecret123' });
  check('密文不参与搜索', kw2.length === 0, kw2.length);

  const updated = await call('records:save', {
    id: saved.id,
    collection: 'sites',
    data: { ...saved.data, name: '测试站A-改' },
    tags: ['tagA', 'tagB'],
    favorite: false
  });
  check('更新生效', updated && updated.title === '测试站A-改' && updated.tags.length === 2);
  const listAfter = await call('records:list', { collection: 'sites' });
  check('更新后仍只有 1 条', listAfter.length === 1);

  const counts = await call('records:counts');
  check('统计正确', counts.sites === 1, counts);

  const pinRes = await call('pin:set', { oldPin: '', pin: '1234' });
  check('设置密码成功', pinRes && pinRes.ok, pinRes);

  await call('app:lock');
  let lockedErr = null;
  try {
    await call('records:list', { collection: 'sites' });
  } catch (e) {
    lockedErr = e;
  }
  check('锁定后拒绝读数据', lockedErr && lockedErr.code === 'LOCKED');

  const bad = await call('app:unlock', { pin: '0000' });
  check('错误密码解锁失败', bad && bad.ok === false, bad);
  const good = await call('app:unlock', { pin: '1234' });
  check('正确密码解锁成功', good && good.ok === true, good);

  const md5 = await call('util:hash', { algo: 'md5', text: 'hello' });
  check('MD5 计算正确', md5 === '5d41402abc4b2a76b9719d911017c592', md5);
  const sha256 = await call('util:hash', { algo: 'sha256', text: 'hello' });
  check('SHA-256 计算正确', sha256 === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', sha256);

  await call('clipboard:copy', { text: 'SuperSecret123', secret: true });
  check('剪贴板写入', clip.value === 'SuperSecret123', clip.value);

  const st = await call('settings:set', { autoLockMinutes: 30, clipboardClearSeconds: 15 });
  check('设置保存', st.autoLockMinutes === 30 && st.clipboardClearSeconds === 15, st);

  // 点 X 的行为：默认 tray，可切 quit，非法值回落到 tray
  check('closeAction 默认 tray', st.closeAction === 'tray', st.closeAction);
  const stQuit = await call('settings:set', { closeAction: 'quit' });
  check('closeAction 可切 quit', stQuit.closeAction === 'quit', stQuit.closeAction);
  const stBad = await call('settings:set', { closeAction: 'nonsense' });
  check('closeAction 非法值回落 tray', stBad.closeAction === 'tray', stBad.closeAction);

  /* ---------- 目录类设置：存进去要能读回来（踩坑 #100）----------
   * 用户报「填了 allure 目录，切页面再回来就空了」，
   * 先确认后端存取链路是通的（前端保存时机另测）。
   */
  {
    const dirKeys = [
      'casesDir', 'jmxDir', 'reportDir', 'allureDir',
      'kbDir', 'notesDir', 'projectDir', 'workspaceDir'
    ];
    const patch = {};
    for (const k of dirKeys) patch[k] = 'D:/tt-test/' + k;
    const saved = await call('settings:set', patch);
    const got = await call('settings:get');

    const missingInSave = dirKeys.filter((k) => saved[k] !== patch[k]);
    check('settings:set 返回所有目录字段', missingInSave.length === 0, missingInSave);

    const missingInGet = dirKeys.filter((k) => got[k] !== patch[k]);
    check('settings:get 能读回所有目录字段', missingInGet.length === 0, missingInGet);

    // publicSettings 有没有漏（这是白名单最容易漏的地方）
    const inPublic = dirKeys.filter((k) => !(k in got));
    check('publicSettings 暴露所有目录字段', inPublic.length === 0, inPublic);
  }
  await call('settings:set', { closeAction: 'tray' });

  const info = await call('app:info');
  check('备份目录存在且有备份', info.backups && info.backups.length >= 1, info.backups);

  // 按集合导出：只返回该集合的记录（列表页的「导出」按钮）
  const storeMod = require(path.join(__dirname, '..', 'electron', 'store'));
  const onlySites = storeMod.exportAll(false, 'sites');
  check(
    '按集合导出只含该集合',
    onlySites.records.length === 1 && onlySites.records[0].collection === 'sites',
    onlySites.records.length
  );

  const removed = await call('records:remove', { id: saved.id });
  check('删除成功', removed === true);
  const afterDel = await call('records:list', { collection: 'sites' });
  check('删除后列表为空', afterDel.length === 0);

  // 按集合导入：只吃匹配的集合（列表页的「导入」按钮）
  const mixed = {
    version: 1,
    records: [
      { collection: 'sites', data: { name: '导入站', env: 'test' }, tags: [] },
      { collection: 'sqls', data: { name: '导入片段', sql: 'select 1' }, tags: [] }
    ]
  };
  const impOnly = storeMod.importAll(mixed, 'sites');
  check('按集合导入忽略其他集合', impOnly.imported === 1 && impOnly.skipped === 1, impOnly);
  const impAll = storeMod.importAll(mixed, null);
  check('不传集合时全部导入', impAll.imported === 2 && impAll.skipped === 0, impAll);

  // 用例索引：走 IPC 读真实目录。
  // 目录不在就显式跳过——旧版这条断言「>500 条用例」，等于把作者机器的数据量当成了产品契约。
  const CASES_ROOT = process.env.CASES_ROOT || path.join(os.homedir(), 'Documents', '测试工作台', 'test_cases');
  if (fs.existsSync(CASES_ROOT)) {
    const scanned = await call('cases:scan', { root: CASES_ROOT });
    check('用例扫描读到用例', scanned && scanned.totalCases >= 1, scanned && scanned.totalCases);
    check('用例扫描无解析错误', scanned && scanned.errors && scanned.errors.length === 0, scanned && scanned.errors);
    const sample = scanned && scanned.files && scanned.files[0] && scanned.files[0].cases[0];
    check('用例字段带风险等级与断言迹', !!sample && !!sample.risk && Array.isArray(sample.assertions), sample && sample.title);
  } else {
    skip('用例索引（真实用例目录不存在：' + CASES_ROOT + '）');
  }

  // 重新加载数据库文件，验证持久化
  const raw2 = fs.readFileSync(dbPath);
  check('数据库文件已落盘', raw2.length > 1024);

  // ---------- 测试执行：字段按类型裁剪（onlyFor）+ 摘要行 ----------
  const { COLLECTIONS, RUN_KIND_OPTIONS, RUN_RESULT_OPTIONS } = require('../shared/collections.js');
  const { matchOnlyFor, visibleFields, runLine, resultTone, recentForApi } = require('../shared/runs.js');

  // 集合配置自检：改 collections.js 时最容易犯的错，全在这里拦住
  const keys = new Set(COLLECTIONS.map((c) => c.key));
  check('集合 key 不重复', keys.size === COLLECTIONS.length);
  check('每个集合的 titleField 都是真字段', COLLECTIONS.every((c) => c.fields.some((f) => f.key === c.titleField)), COLLECTIONS.filter((c) => !c.fields.some((f) => f.key === c.titleField)).map((c) => c.key));
  check('listFields 都指向真字段', COLLECTIONS.every((c) => (c.listFields || []).every((k) => c.fields.some((f) => f.key === k))), COLLECTIONS.filter((c) => (c.listFields || []).some((k) => !c.fields.some((f) => f.key === k))).map((c) => c.key));
  check('filterField 指向真字段', COLLECTIONS.every((c) => !c.filterField || c.fields.some((f) => f.key === c.filterField)));
  check('link 字段的 linkTo 都存在', COLLECTIONS.every((c) => c.fields.filter((f) => f.type === 'link').every((f) => keys.has(f.linkTo))));
  check('onlyFor 引用的类型值合法', COLLECTIONS.every((c) => c.fields.every((f) => !f.onlyFor || !f.onlyFor.kind || RUN_KIND_OPTIONS.some((o) => o.value === f.onlyFor.kind))));
  check('onlyFor 字段都能被某个类型看到', (() => {
    const runs = COLLECTIONS.find((c) => c.key === 'runs');
    const conditioned = runs.fields.filter((f) => f.onlyFor);
    return conditioned.every((f) => conditioned.filter((x) => x.onlyFor.kind === f.onlyFor.kind).length >= 1) &&
      RUN_KIND_OPTIONS.every((o) => visibleFields(runs.fields, o.value).length > 0);
  })());

  // 三档写死而不是 >=2：加类型是要同步改表、字段裁剪、关联报告三处的事，
  // 通配会让「多加了一档但没人接」这件事静默通过。
  check(
    'runs 集合存在且带类型/结果选项（api,ui,perf）',
    !!COLLECTIONS.find((c) => c.key === 'runs') &&
      RUN_KIND_OPTIONS.map((o) => o.value).join(',') === 'api,ui,perf' &&
      RUN_RESULT_OPTIONS.length === 3
  );

  // 字段裁剪
  const runsFields = COLLECTIONS.find((c) => c.key === 'runs').fields;
  const apiLabels = visibleFields(runsFields, 'api').map((f) => f.key);
  const perfLabels = visibleFields(runsFields, 'perf').map((f) => f.key);
  check('接口测试看得到通过/失败', apiLabels.includes('passCount') && apiLabels.includes('failCount'), apiLabels);
  check('接口测试看不到并发/TPS', !apiLabels.includes('concurrency') && !apiLabels.includes('tps'), apiLabels);
  // v0.51 UI 测试：和接口测试共用「通过/失败」口径，但不该出现压测指标
  const uiLabels = visibleFields(runsFields, 'ui').map((f) => f.key);
  check('UI 测试与接口测试共用通过/失败口径', uiLabels.includes('passCount') && uiLabels.includes('failCount'), uiLabels);
  check('UI 测试看不到压测指标', !uiLabels.includes('concurrency') && !uiLabels.includes('p95') && !uiLabels.includes('errRate'), uiLabels);
  check('压测看得到并发/P95/错误率', perfLabels.includes('concurrency') && perfLabels.includes('p95') && perfLabels.includes('errRate'), perfLabels);
  check('压测看不到通过/失败', !perfLabels.includes('passCount'), perfLabels);
  check('公共字段两类都在', ['name', 'kind', 'result', 'ranAt', 'apiRef', 'report'].every((k) => apiLabels.includes(k) && perfLabels.includes(k)));
  check('没写 onlyFor 的字段恒显示', matchOnlyFor({ key: 'name' }, 'perf') === true && matchOnlyFor({ key: 'name' }, 'api') === true);
  check('kind 为空时只留公共字段', visibleFields(runsFields, '').every((f) => !f.onlyFor));

  // 摘要行
  check('压测摘要带五个指标', runLine({ kind: 'perf', concurrency: 10, duration: '60s', tps: 320, p95: 180, errRate: 0.2 }) === '10 并发 · 60s · 320 TPS · P95 180ms · 错 0.2%', runLine({ kind: 'perf', concurrency: 10, duration: '60s', tps: 320, p95: 180, errRate: 0.2 }));
  check('接口测试摘要 = 通过 / 失败', runLine({ kind: 'api', passCount: 11, failCount: 2 }) === '11 通过 · 2 失败', runLine({ kind: 'api', passCount: 11, failCount: 2 }));
  check('缺指标就跳过，不硬凑破折号', runLine({ kind: 'perf', tps: 400 }) === '400 TPS', runLine({ kind: 'perf', tps: 400 }));
  check('没有 kind 默认当接口测试', runLine({ passCount: 3 }) === '3 通过', runLine({ passCount: 3 }));
  check('空数据摘要为空串', runLine({}) === '' && runLine(null) === '');
  check('文本数字也能算进去（老数据/手填）', runLine({ kind: 'perf', tps: '320', p95: '180' }) === '320 TPS · P95 180ms');
  check('小数错误率原样保留', runLine({ kind: 'perf', errRate: 0.25 }).indexOf('错 0.25%') >= 0);

  // 结果颜色
  check('结果颜色：正常绿 / 异常红 / 未判定灰', resultTone('ok') === 'green' && resultTone('bad') === 'red' && resultTone('unknown') === 'default' && resultTone('') === 'default');

  // 某接口的最近执行
  const runRows = [
    { id: 'a', updated_at: 1000, data: { apiRef: 'p1', ranAt: 3000, kind: 'perf' } },
    { id: 'b', updated_at: 9000, data: { apiRef: 'p1', ranAt: 1000, kind: 'api' } },
    { id: 'c', updated_at: 5000, data: { apiRef: 'p2', ranAt: 5000 } },
    { id: 'd', updated_at: 8000, data: { apiRef: 'p1' } }
  ];
  const recent = recentForApi(runRows, 'p1', 3);
  check('只留这个接口的执行', recent.every((r) => r.data.apiRef === 'p1'), recent.map((r) => r.id));
  check('按执行时间倒序，没填的退回更新时间', recent.map((r) => r.id).join(',') === 'd,a,b', recent.map((r) => [r.id, r.data.ranAt, r.updated_at]));
  check('limit 生效', recentForApi(runRows, 'p1', 2).length === 2);
  check('接口没跑过 = 空数组', recentForApi(runRows, 'nope', 3).length === 0);
  check('脏数据不抛异常', recentForApi(null, 'p1', 3).length === 0 && recentForApi([null, {}], 'p1', 3).length === 0);

  // ---- 可配置选项（环境 / 角色·权限 / 标签）----
  const opt0 = await call('options:get');
  check('默认有 env/role/tags 三组选项', !!opt0 && Array.isArray(opt0.env) && Array.isArray(opt0.role) && Array.isArray(opt0.tags), opt0);
  check('环境默认带测试/预发/生产', ['test', 'staging', 'prod'].every((v) => opt0.env.some((o) => o.value === v)), opt0.env);

  const savedRole = await call('options:save', { key: 'role', items: [' 超管 ', '超管', '', '只读'] });
  check('保存角色：去空格、去重、去空', JSON.stringify(savedRole.role) === JSON.stringify(['超管', '只读']), savedRole.role);

  const savedEnv = await call('options:save', {
    key: 'env',
    items: [{ value: 'test', label: '测试环境', color: 'green' }, { value: 'uat', label: 'UAT' }, '单独一项']
  });
  check(
    '环境保存保留 value/label/color 并补默认色',
    savedEnv.env[0].label === '测试环境' && savedEnv.env[1].color === 'default' && savedEnv.env.length === 3,
    savedEnv.env
  );

  let optThrew = false;
  try {
    await call('options:save', { key: 'nope', items: [] });
  } catch (e) {
    optThrew = true;
  }
  check('未知选项集报错而不是静默吞掉', optThrew);

  await call('records:save', { collection: 'sqls', data: { name: '带新标签', sql: 'select 1' }, tags: ['全新标签', '超管'] });
  const opt1 = await call('options:get');
  check('新标签随保存自动加入配置', opt1.tags.indexOf('全新标签') >= 0, opt1.tags);
  check('已存在的标签不重复加', opt1.tags.filter((t) => t === '超管').length === 1, opt1.tags);

  // ---- 迁移能力：导出带 id/关联/选项，导入能挂回去 ----
  const migApi = await call('records:save', {
    collection: 'apis',
    data: { name: '迁移测试接口', method: 'POST', url: '/api/migrate', note: '' },
    tags: []
  });
  await call('links:add', { apiId: migApi.id, filePath: 'x/TC_a.md', caseTitle: '某用例', caseIndex: 1 });
  await call('options:save', { key: 'role', items: ['迁移角色'] });

  const storeMod2 = storeMod;
  const payload = storeMod2.exportAll(true, null);
  check('整库导出每条记录都带 id', payload.records.length > 0 && payload.records.every((r) => !!r.id), payload.records.length);
  check('整库导出带关联', Array.isArray(payload.links) && payload.links.length >= 1, payload.links && payload.links.length);
  check('整库导出带选项配置', !!payload.options && Array.isArray(payload.options.env), payload.options && Object.keys(payload.options));
  check('按集合导出不带关联和选项', (() => {
    const p = storeMod2.exportAll(true, 'sqls');
    return !p.links && !p.options;
  })());

  const linksBefore = (await call('links:forApi', { apiId: migApi.id })).length;
  await call('links:save', { apiId: migApi.id, targets: [] });
  check('清空后关联为 0 条', (await call('links:forApi', { apiId: migApi.id })).length === 0);

  const impFull = storeMod2.importAll(payload, null);
  check('重复导入同一份文件是原地更新，不翻倍', impFull.keptIds === 0 && impFull.updated > 0, impFull);
  const linksAfter = (await call('links:forApi', { apiId: migApi.id })).length;
  check('导入后关联挂回来了', linksAfter === linksBefore && linksBefore >= 1, { before: linksBefore, after: linksAfter });
  const rolesAfter = (await call('options:get')).role;
  check('导入后选项配置并集合并', rolesAfter.indexOf('迁移角色') >= 0, rolesAfter);

  // ---- 整库文件：导出 / 校验 / 恢复 ----
  const dbOut = path.join(tmp, 'exported.db');
  const expDb = storeMod2.exportDbTo(dbOut);
  check('导出整库文件存在且非空', fs.existsSync(dbOut) && expDb.bytes > 0, expDb);
  const infoOut = storeMod2.inspectDbFile(dbOut);
  check('导出的 .db 能被识别为有效备份', infoOut.recordCount > 0 && infoOut.version === storeMod2.schemaVersion(), infoOut);

  const fakeDb = path.join(tmp, 'fake.db');
  fs.writeFileSync(fakeDb, 'not a database', 'utf8');
  let inspectThrew = false;
  try {
    storeMod2.inspectDbFile(fakeDb);
  } catch (e) {
    inspectThrew = true;
  }
  check('不是数据库的文件会被拒绝', inspectThrew);

  await call('records:save', { collection: 'sqls', data: { name: '恢复前标记', sql: 'select 1' } });
  await new Promise((r) => setTimeout(r, 500));
  const bkBeforeRestore = await call('backup:now');
  const notesBeforeRestore = (await call('records:counts')).notes;
  await call('records:save', { collection: 'sqls', data: { name: '备份之后才会出现', sql: 'select 1' } });
  const restored = await call('backup:restore', { file: path.basename(bkBeforeRestore.file) });
  check('恢复备份成功并报出记录数', restored.ok && restored.recordCount > 0, restored);
  check('恢复带密码的备份后会重新上锁', restored.locked === true && restored.settings.hasPin === true, {
    locked: restored.locked,
    hasPin: restored.settings && restored.settings.hasPin
  });
  await call('app:unlock', { pin: '1234' });
  const notesAfterRestore = (await call('records:counts')).notes;
  check('恢复后回到备份时刻的状态', notesAfterRestore === notesBeforeRestore, { notesBeforeRestore, notesAfterRestore });
  check('恢复前自动留了安全备份', !!restored.backupFile && fs.existsSync(restored.backupFile), restored.backupFile);

  // ---- jmx 索引（走 IPC 读真实目录）----
  // 默认目录现在指向「文档\测试工作台」，测试要显式传真实路径。
  // 目录 / 本机 JMeter 不在就显式跳过：这两样都是「这台机器装了什么」，不是产品契约。
  const REAL_JMX = process.env.JMX_ROOT || path.join(os.homedir(), 'Documents', '测试工作台', 'jmx');
  const REAL_REPORT = process.env.REPORT_ROOT || path.join(os.homedir(), 'Documents', '测试工作台', 'jmx', '压测结果');
  const REAL_KB = process.env.KB_ROOT || path.join(os.homedir(), 'Documents', '测试工作台', '知识库');

  // JMeter 装没装是本机属性，和本机有没有 jmx 目录无关：app:init 已经让后端探过一次
  const jmeterBat = (init && init.settings && init.settings.jmeterPath) || '';
  const jmeterFound = !!jmeterBat;
  let jmxFiles = [];
  if (fs.existsSync(REAL_JMX)) {
    const jmxRes = await call('jmx:scan', { root: REAL_JMX });
    check('jmx 扫描读到真实脚本', jmxRes && jmxRes.totalFiles >= 1, jmxRes && jmxRes.totalFiles);
    check('jmx 扫描无错误', jmxRes && jmxRes.errors && jmxRes.errors.length === 0, jmxRes && jmxRes.errors);
    jmxFiles = (jmxRes && jmxRes.files) || [];

    // 版本号是「本机装了什么」：只验证格式像版本号，不再写死 5.4.3
    const jm = jmxRes && jmxRes.jmeter;
    if (jmeterFound) {
      check('jmx 扫描也报告找到 JMeter', !!(jm && jm.found && jm.path), jm);
      check('jmx 版本号是 x.y[.z] 格式', typeof jm.version === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(jm.version), jm && jm.version);
    } else {
      check('jmx 扫描报告没找到 JMeter', !!(jm && jm.found === false), jm);
    }

    const jmxSample = jmxFiles[0];
    check('jmx 解析出线程组与采样器', !!jmxSample && jmxSample.threadGroups.length > 0 && jmxSample.samplers.length > 0, jmxSample && jmxSample.file);
    check('jmx 带健康检查结果', !!jmxSample && !!jmxSample.health && Array.isArray(jmxSample.health.issues), jmxSample && jmxSample.health);

    // 打开目录：传目录要真的打开目录，不能打开父目录（v0.17.0 修的 bug）
    const revealDir = await call('jmx:reveal', { file: jmxRes.root });
    check('打开目录返回的就是该目录本身', revealDir && revealDir.ok && revealDir.dir === jmxRes.root, revealDir);
  } else {
    skip('jmx 索引（真实 jmx 目录不存在：' + REAL_JMX + '）');
  }

  // 这两条不需要真实资产：错误输入必须明确失败
  const jmxBad = await call('jmx:openGui', { file: 'D:\\不存在.jmx' });
  check('jmx 打开不存在的文件返回失败', jmxBad && jmxBad.ok === false, jmxBad);
  const revealBad = await call('jmx:reveal', { file: 'D:\\不存在的目录' });
  check('打开不存在的路径返回失败而不是静默', revealBad && revealBad.ok === false, revealBad);

  if (jmeterFound) {
    // app:init 探测到的路径要落盘，否则设置页永远显示空
    check('自动探测的 jmeterPath 已写回设置', /^jmeter/i.test(path.basename(jmeterBat)), jmeterBat);
  } else {
    skip('自动探测的 jmeterPath 写回（本机未安装 JMeter）');
  }

  // 真正拉起 JMeter GUI 的断言默认不跑：它会在桌面上弹窗口，不适合放进日常 `npm test`。
  // 要冒烟验证 .bat 启动链路时设 TT_JMETER_SMOKE=1。
  if (jmeterFound && process.env.TT_JMETER_SMOKE === '1') {
    const launch = await call('jmx:launch');
    check('启动 JMeter 成功（Windows 上 .bat 必须走 shell）', launch && launch.ok === true, launch);
    check('启动返回实际命令，便于排查', !!launch && typeof launch.command === 'string' && !!launch.jmeter && launch.command.indexOf(path.basename(launch.jmeter)) >= 0, launch && launch.command);
    check('启动返回 JMeter 版本', launch && typeof launch.version === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(launch.version), launch && launch.version);

    // 用 JMeter 打开脚本：不写死文件名，直接用刚扫到的第一份脚本
    if (jmxFiles.length) {
      const guiTarget = jmxFiles[0].file;
      const guiOk = await call('jmx:openGui', { file: guiTarget });
      check('用 JMeter 打开指定脚本成功', guiOk && guiOk.ok === true, guiOk);
      check('打开脚本的命令带 -t 和脚本路径', guiOk && guiOk.command && guiOk.command.includes('-t') && guiOk.command.includes(path.basename(guiTarget)), guiOk && guiOk.command);
    } else {
      skip('用 JMeter 打开指定脚本（jmx 目录里没有脚本）');
    }
  } else {
    skip(
      '启动 JMeter / 打开脚本（' +
        (jmeterFound ? '默认不拉起 GUI，设 TT_JMETER_SMOKE=1 才跑' : '本机未安装 JMeter') +
        '）'
    );
  }
  const guiNoFile = await call('jmx:openGui', {});
  check('不传脚本路径时给出明确错误码', guiNoFile && guiNoFile.ok === false && guiNoFile.code === 'NO_FILE', guiNoFile);

  // ---- 压测报告导入 ----
  if (fs.existsSync(REAL_REPORT)) {
    const repScan = await call('report:scan', { root: REAL_REPORT });
    check('报告扫描读到真实跑批', repScan && repScan.reports && repScan.reports.length >= 1, repScan && repScan.reports && repScan.reports.length);
    const rep0 = repScan && repScan.reports && repScan.reports[0];
    if (!rep0) {
      // 扫不到报告就到此为止：绝不拿 undefined 去取 .dir（v0.42.0 的崩溃点）
      check('报告目录里至少有一份能解析的报告', false, repScan && repScan.errors);
    } else {
      // 样本数不写死：从 jtl 源文件独立数一遍，要求两边一致
      const jtlSamples = countJtlSamples(rep0.files && rep0.files.jtl);
      const hasJtl = jtlSamples > 0;
      check('报告样本数与 jtl 行数一致', rep0.samples > 0 && (hasJtl ? rep0.samples === jtlSamples : true), { samples: rep0.samples, jtlSamples });
      // P95 不写死：只要求「从 jtl 算出来、大于 0、不超过最大值」
      check('报告 P95 落在 (0, max] 区间内', hasJtl ? rep0.p95 > 0 && rep0.p95 <= rep0.max : rep0.p95 === null, { p95: rep0.p95, max: rep0.max, hasJtl });
      check('报告带 html 报告路径字段', !!rep0.files && typeof rep0.files.htmlIndex === 'string' && (!rep0.files.htmlIndex || fs.existsSync(rep0.files.htmlIndex)), rep0.files);
      const repParse = await call('report:parse', { dir: rep0.dir });
      check('按目录解析返回 ok', repParse && repParse.ok === true, repParse && repParse.message);
    }
    const repBad = await call('report:parse', { dir: 'D:\\不存在的报告目录' });
    check('解析不存在的目录返回失败', repBad && repBad.ok === false, repBad);
  } else {
    skip('压测报告导入（真实报告目录不存在：' + REAL_REPORT + '）');
  }

  // ---- 知识库索引 ----
  if (fs.existsSync(REAL_KB)) {
    const kbRes = await call('kb:scan', { root: REAL_KB });
    check('知识库扫描读到真实文档', kbRes && kbRes.totalDocs >= 1, kbRes && kbRes.totalDocs);
    check('知识库扫描无错误', kbRes && kbRes.errors && kbRes.errors.length === 0, kbRes && kbRes.errors);
    const kb0 = kbRes && kbRes.docs && kbRes.docs[0];
    check('知识库文档带章节', !!kb0 && Array.isArray(kb0.sections), kb0 && kb0.title);
    check('知识库跳过归档目录', kbRes && kbRes.docs.every((d) => d.dir.indexOf('_archive') < 0), kbRes && kbRes.docs.filter((d) => d.dir.indexOf('_archive') >= 0).map((d) => d.relPath));
  } else {
    skip('知识库索引（真实知识库目录不存在：' + REAL_KB + '）');
  }
  const kbBad = await call('kb:reveal', { file: 'D:\\不存在的知识库' });
  check('知识库打开不存在路径返回失败', kbBad && kbBad.ok === false, kbBad);

  // ---- 导入过滤器：按集合只认 JSON，整库才认 .db ----
  // 直接读后端源码确认逻辑（避免在测试里重复实现一遍）；
  // data:import 已搬到 electron/ipc/ipc-records.js，所以扫整个 electron/ 目录。
  // v0.43.0 起通道统一走 ipc-guard 的 handle()（带解锁守卫），不再写 ipcMain.handle。
  const mainSrc = require('./_electron-src.cjs').readElectronSource();
  const importBlock = mainSrc.slice(mainSrc.indexOf("handle('data:import'"), mainSrc.indexOf("handle('backup:restore'"));
  check('按集合导入的过滤器只含 json', /conf\s*\?\s*\[\{\s*name:\s*'JSON',\s*extensions:\s*\['json'\]\s*\}\]/.test(importBlock), importBlock.slice(0, 300));
  check('整库导入的过滤器含 db', /extensions:\s*\['json',\s*'db'\]/.test(importBlock), importBlock.slice(0, 300));
  check('按集合选了 .db 会明确拒绝', /不能只导入某个集合/.test(importBlock));

  // ---- 清除数据（破坏性操作，重点验证「清了不会自己回来」）----
  await call('records:save', { collection: 'sqls', data: { name: '清除前留一条', sql: 'select 1' } });
  await new Promise((r) => setTimeout(r, 500));
  const bk = await call('backup:now');
  check('清除前能生成备份', !!bk.file, bk);

  const clrBackups = await call('data:clear', { target: 'backups' });
  check('清除备份返回删除数量与字节数', clrBackups.ok && clrBackups.removed >= 1 && clrBackups.bytes > 0, clrBackups);
  const backupsLeft = await call('backup:list');
  check('清除后备份目录为空', backupsLeft.length === 0, backupsLeft.length);

  const clrLocal = await call('data:clear', { target: 'local' });
  check('清除本地数据返回 ok 并报出删除的文件', clrLocal.ok && Array.isArray(clrLocal.removed) && clrLocal.removed.length >= 1, clrLocal);
  const countsAfterClear = await call('records:counts');
  check('清除后所有集合都为空', Object.keys(countsAfterClear).length === 0, countsAfterClear);
  check('清除后重建了空库文件', fs.existsSync(path.join(tmp, 'data.db')));
  await new Promise((r) => setTimeout(r, 700));
  const countsLater = await call('records:counts');
  check('过了防抖窗口数据也没有自己回来', Object.keys(countsLater).length === 0, countsLater);
  const badClear = await call('data:clear', { target: 'whatever' });
  check('未知清除目标返回失败而不是抛错', badClear.ok === false, badClear);
  const afterReset = await call('app:init');
  check('重置后回到未设密码状态', afterReset && afterReset.locked === false && afterReset.settings.hasPin === false, afterReset && afterReset.settings);
  const optAfterReset = await call('options:get');
  check('清除数据后选项配置回到默认', optAfterReset.env.length === 4 && optAfterReset.role.length === 0, {
    env: optAfterReset.env.length,
    role: optAfterReset.role.length
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 主进程测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  for (const name of skipped) console.log('  SKIP  ' + name);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});
