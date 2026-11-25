/* v0.43.1：PIN 移除流程 + 工作区子目录自动推导 回归测试
 *
 * 覆盖两个用户报的 bug：
 *   1. 「设置密码 → 移除密码 → 提示密码错误」：移除必须弹框输当前密码，
 *      后端 pin:clear 要区分「没填」和「填错」，未设密码时幂等成功；
 *   2. 「设置工作区目录后，子目录没自动推导，本机也没建目录」：
 *      settings:set 收到 workspaceDir 就要立即推导 7 个子目录 + 建目录，
 *      同时不能覆盖用户自己填的路径，清空工作区时也不能残留旧路径。
 *
 * 做法：stub electron 后真加载 main.js（和 test-main.cjs 同一套路），
 * 临时目录里造工作区，全部走真实 IPC handler。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-ws-'));

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
      return '0.43.1';
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
      if (handlers[channel]) {
        throw new Error("Attempted to register a second handler for '" + channel + "'");
      }
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
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

process.env.TT_DATA_DIR = tmp;
process.env.TT_NO_DEMO = '1';
delete process.env.TT_DEBUG;

require(path.join(__dirname, '..', 'electron', 'main.js'));
// 直接 require 一次模块，做「注入 fs 替身」的权限失败用例
const workspaceDerive = require(path.join(__dirname, '..', 'electron', 'workspace-derive.js'));

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
const call = (channel, payload) => handlers[channel]({}, payload);

/** 7 个子目录在指定工作区下应该是什么路径（allureDir 沿用既有语义 = 工作区根） */
const SUB_NAME = {
  casesDir: 'test_cases',
  jmxDir: 'jmx',
  reportDir: path.join('jmx', '压测结果'),
  allureDir: '',
  kbDir: '知识库',
  notesDir: 'notes',
  projectDir: 'Project'
};
const DIR_KEYS = Object.keys(SUB_NAME);
const expectPath = (ws, key) => (SUB_NAME[key] ? path.join(ws, SUB_NAME[key]) : ws);

(async () => {
  // 等 whenReady 跑完：store.init → loadSettings → registerIpc
  await new Promise((r) => setTimeout(r, 2500));

  /* ============================================================
   * A. PIN：设置 / 移除 / 修改
   * ============================================================ */
  const init = await call('app:init');
  check('A1 初始状态：没有密码且未锁定', init.settings.hasPin === false && init.locked === false, init && init.locked);

  const clearNone = await call('pin:clear', { pin: '' });
  check(
    'A2 未设密码时 pin:clear 直接成功（幂等，不报「密码不对」）',
    clearNone && clearNone.ok === true && clearNone.hasPin === false,
    clearNone
  );

  const set1 = await call('pin:set', { oldPin: '', pin: '1234' });
  check('A3 首次设置密码成功（不用原密码）', set1 && set1.ok === true, set1);
  check('A4 设置后 hasPin=true', (await call('settings:get')).hasPin === true);

  // 用户复现路径的第一步：设置完立刻点「移除」，此时输入框是空的
  const clearEmpty = await call('pin:clear', { pin: '' });
  check('A5 有密码时 pin:clear 传空密码失败', clearEmpty && clearEmpty.ok === false, clearEmpty);
  check('A6 空密码的文案是「请输入当前密码」', clearEmpty && clearEmpty.message === '请输入当前密码', clearEmpty && clearEmpty.message);

  const clearWrong = await call('pin:clear', { pin: '9999' });
  check('A7 有密码时 pin:clear 传错密码失败', clearWrong && clearWrong.ok === false, clearWrong);
  check('A8 错密码的文案是「密码不对」', clearWrong && clearWrong.message === '密码不对', clearWrong && clearWrong.message);
  check('A9 两次失败都没动密码', (await call('settings:get')).hasPin === true);

  const clearOk = await call('pin:clear', { pin: '1234' });
  check('A10 正确密码 pin:clear 成功', clearOk && clearOk.ok === true && clearOk.hasPin === false, clearOk);
  check('A11 移除后 hasPin=false', (await call('settings:get')).hasPin === false);

  // 已有密码时修改：必须验原密码
  await call('pin:set', { oldPin: '', pin: '1111' });
  check('A12 重新设置密码成功（为下一组做准备）', (await call('settings:get')).hasPin === true);

  const setNoOld = await call('pin:set', { oldPin: '', pin: '2222' });
  check(
    'A13 已有密码时 pin:set 不填原密码被拒',
    setNoOld && setNoOld.ok === false && setNoOld.message === '请输入原密码',
    setNoOld
  );

  const setWrongOld = await call('pin:set', { oldPin: '0000', pin: '2222' });
  check(
    'A14 已有密码时 pin:set 原密码错被拒',
    setWrongOld && setWrongOld.ok === false && setWrongOld.message === '原密码不对',
    setWrongOld
  );

  const setShort = await call('pin:set', { oldPin: '1111', pin: '123' });
  check(
    'A15 新密码不足 4 位被拒',
    setShort && setShort.ok === false && setShort.message === '密码至少 4 位',
    setShort
  );

  await call('app:lock');
  const unlockStill = await call('app:unlock', { pin: '1111' });
  check('A16 三次失败的修改都没动原密码', unlockStill && unlockStill.ok === true, unlockStill);

  const setChanged = await call('pin:set', { oldPin: '1111', pin: '2222' });
  check('A17 原密码正确时可以改密码', setChanged && setChanged.ok === true, setChanged);
  await call('app:lock');
  const unlockNew = await call('app:unlock', { pin: '2222' });
  const unlockOld = await call('app:unlock', { pin: '1111' });
  check(
    'A18 改完新密码可用、旧密码失效',
    unlockNew && unlockNew.ok === true && unlockOld && unlockOld.ok === false,
    { unlockNew, unlockOld }
  );

  // preload 正常会传 { pin }，这里顺带覆盖「直接传字符串」的兼容分支
  const clearStr = await call('pin:clear', '2222');
  check('A19 pin:clear 兼容直接传字符串', clearStr && clearStr.ok === true, clearStr);
  check('A20 清完 hasPin=false', (await call('settings:get')).hasPin === false);

  /* ============================================================
   * B. 前端设置页（静态校验：这些是本次修的交互，跑不了 DOM 就查代码）
   * ============================================================ */
  const setSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');

  check('B1 移除密码改用独立 state（api.clearPin(clearPinValue)）', /api\.clearPin\(\s*clearPinValue\s*\)/.test(setSrc), '仍是别的入参');
  check('B2 不再拿 oldPin 去调 clearPin（那正是「密码不对」的根因）', !/api\.clearPin\(\s*oldPin\s*\)/.test(setSrc), 'still oldPin');
  check('B3 移除按钮不再是 onConfirm={doClearPin} 的 Popconfirm', !/onConfirm=\{doClearPin\}/.test(setSrc), 'still popconfirm');
  check('B4 移除密码走独立 Modal（open={clearPinOpen}）', /open=\{clearPinOpen\}/.test(setSrc), 'no modal');
  check('B5 移除弹窗里有「当前密码」输入框', /value=\{clearPinValue\}/.test(setSrc) && /请输入当前密码/.test(setSrc), 'no input');
  check(
    'B6 打开设置/修改密码弹窗时清空 oldPin + newPin',
    /const openPinModal[\s\S]{0,400}?setOldPin\(''\)[\s\S]{0,200}?setNewPin\(''\)/.test(setSrc),
    'dirty state reused'
  );
  check('B7 打开移除弹窗时清空 clearPinValue', /const openClearPinModal[\s\S]{0,300}?setClearPinValue\(''\)/.test(setSrc), 'dirty state reused');
  check(
    'B8 原密码那行按 hasPin 条件渲染（未设密码时不显示）',
    /settings\.hasPin \? \(\s*<div[^>]*>\s*<div className="kv-label">原密码<\/div>/.test(setSrc),
    'old pin row not conditional'
  );
  check(
    'B9 未设密码时 setPin 传空原密码（不把残留值传上去）',
    /api\.setPin\(\s*needOld \? oldPin : ''\s*,\s*newPin\s*\)/.test(setSrc),
    'no hasPin branch'
  );
  check('B10 工作区 toast 会报「子目录已自动推导」', /已设置工作区，\$\{derived\} 个子目录已自动推导/.test(setSrc), 'no toast');
  check('B11 工作区 toast 会报「创建失败（权限不足？）」', /个目录创建失败（权限不足？）/.test(setSrc), 'no fail text');
  check('B12 保存回执里的 dirSync 被用起来', /dirSyncText\(res && res\.dirSync\)/.test(setSrc), 'dirSync ignored');

  /* ============================================================
   * C. 工作区推导 + 自动建目录
   * ============================================================ */
  const got0 = await call('settings:get');
  check(
    'C1 启动时没配工作区 → 按「文档\测试工作台」兜底',
    got0.casesDir === path.join(tmp, 'documents', '测试工作台', 'test_cases'),
    got0.casesDir
  );

  const wsA = path.join(tmp, 'ws-a');
  fs.mkdirSync(wsA, { recursive: true });
  const setWs = await call('settings:set', { workspaceDir: wsA });

  check(
    'C2 设工作区后 7 个子目录全部推导成 {工作区}/xxx',
    DIR_KEYS.every((k) => setWs[k] === expectPath(wsA, k)),
    DIR_KEYS.filter((k) => setWs[k] !== expectPath(wsA, k)).map((k) => [k, setWs[k]])
  );
  check('C3 settings:set 回执带 dirSync 报告', !!(setWs.dirSync && Array.isArray(setWs.dirSync.created)), setWs.dirSync);
  check(
    'C4 推导出的目录真的被创建（fs.existsSync 为真）',
    ['casesDir', 'jmxDir', 'reportDir', 'kbDir', 'notesDir', 'projectDir'].every((k) => fs.existsSync(expectPath(wsA, k))),
    ['casesDir', 'jmxDir', 'reportDir', 'kbDir', 'notesDir', 'projectDir'].filter((k) => !fs.existsSync(expectPath(wsA, k)))
  );
  check('C5 建出来的是目录不是文件', ['casesDir', 'notesDir', 'reportDir'].every((k) => fs.statSync(expectPath(wsA, k)).isDirectory()), 'not dir');
  check('C6 回执里的 created 至少 6 个目录', setWs.dirSync && setWs.dirSync.created.length >= 6, setWs.dirSync && setWs.dirSync.created);
  const debugGot = await call('settings:get');
  check(
    'C7 推导结果写进 settings 并持久化（settings:get 读得到）',
    debugGot.notesDir === expectPath(wsA, 'notesDir'),
    debugGot.notesDir
  );

  // 用户显式填的路径：尊重，不覆盖，也不自动创建
  const wsB = path.join(tmp, 'ws-b');
  fs.mkdirSync(wsB, { recursive: true });
  const mineNotes = path.join(tmp, 'my-notes');
  const setWithOwn = await call('settings:set', { workspaceDir: wsB, notesDir: mineNotes });
  check('C8 用户显式填的子目录不被覆盖', setWithOwn.notesDir === mineNotes, setWithOwn.notesDir);
  check('C9 用户显式路径不会被自动创建（可能填错）', !fs.existsSync(mineNotes), 'created anyway');
  check(
    'C10 其余子目录仍然跟着新工作区推导',
    setWithOwn.casesDir === expectPath(wsB, 'casesDir') && setWithOwn.kbDir === expectPath(wsB, 'kbDir'),
    setWithOwn.casesDir
  );

  // 显式传空串 = 「我要清空，回退到推导」（哪怕没带 workspaceDir）
  const clearNotes = await call('settings:set', { notesDir: '' });
  check('C11 显式清空子目录 → 回退成工作区推导值', clearNotes.notesDir === expectPath(wsB, 'notesDir'), clearNotes.notesDir);
  check('C12 清空触发的推导也会把目录建出来', fs.existsSync(expectPath(wsB, 'notesDir')), 'not created');

  // 清空工作区：推导值要清空，不能残留上一个工作区的路径
  const cleared = await call('settings:set', { workspaceDir: '' });
  check(
    'C13 清空工作区后 7 个子目录被清空（不是残留旧值）',
    DIR_KEYS.every((k) => cleared[k] === ''),
    DIR_KEYS.map((k) => [k, cleared[k]])
  );
  check('C14 清空后没残留旧工作区路径', !String(cleared.casesDir || '').toLowerCase().includes('ws-b'), cleared.casesDir);
  check('C15 清空工作区不会删磁盘上的目录', fs.existsSync(expectPath(wsB, 'casesDir')), 'deleted');

  const again = await call('settings:set', { workspaceDir: wsA });
  check('C16 清空后再设工作区照样推导', again.casesDir === expectPath(wsA, 'casesDir'), again.casesDir);

  // 用户显式值要能跨工作区切换活下来
  const mineCases = path.join(tmp, 'mine-cases');
  await call('settings:set', { workspaceDir: wsB, casesDir: mineCases });
  const moved = await call('settings:set', { workspaceDir: wsA });
  check('C17 用户显式目录跨工作区切换不被覆盖', moved.casesDir === mineCases, moved.casesDir);
  check('C18 用户显式目录始终不被自动创建', !fs.existsSync(mineCases), 'created anyway');

  // 工作区根不存在：只推导路径，不建目录，也不许抛异常
  const ghost = path.join(tmp, 'ghost-ws');
  const ghostSet = await call('settings:set', { workspaceDir: ghost });
  check(
    'C19 工作区根不存在时不建目录、不抛异常',
    ghostSet && ghostSet.dirSync && ghostSet.dirSync.rootReady === false && !fs.existsSync(ghost),
    ghostSet && ghostSet.dirSync
  );
  check('C20 根不存在时路径照样推导回来', ghostSet.jmxDir === expectPath(ghost, 'jmxDir'), ghostSet.jmxDir);
  check('C21 根不存在时有 skipped 计数（前端据此提示「暂未创建」）', (ghostSet.dirSync.skipped || 0) >= 1, ghostSet.dirSync.skipped);

  // 工作区指向一个文件：statSync 说不是目录，同样不建、不崩
  const blocker = path.join(tmp, 'blocker.txt');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const blocked = await call('settings:set', { workspaceDir: blocker });
  check(
    'C22 工作区指向文件时不崩且不往里建目录',
    blocked && blocked.dirSync && blocked.dirSync.rootReady === false && fs.statSync(blocker).isFile(),
    blocked && blocked.dirSync
  );

  // 建目录失败（权限不足）：注入 fs 替身，稳定复现
  const failingIo = {
    statSync: () => ({ isDirectory: () => true }),
    existsSync: () => false,
    mkdirSync: () => {
      const err = new Error('EACCES: 权限不足');
      err.code = 'EACCES';
      throw err;
    }
  };
  const permSettings = { workspaceDir: path.join(tmp, 'perm-ws'), derivedDirs: {} };
  let permThrown = null;
  let permReport = null;
  try {
    permReport = workspaceDerive.applyWorkspaceChange(
      permSettings,
      { workspaceDir: permSettings.workspaceDir },
      { io: failingIo }
    );
  } catch (e) {
    permThrown = e;
  }
  check('C23 建目录失败不抛异常（不阻塞保存）', !permThrown, permThrown && String(permThrown.message));
  check('C24 失败目录逐条记进 failed', permReport && permReport.failed.length === 7, permReport && permReport.failed.length);
  check(
    'C25 失败也照样把推导值写回 settings',
    permSettings.casesDir === expectPath(permSettings.workspaceDir, 'casesDir'),
    permSettings.casesDir
  );
  check(
    'C26 failed 里带具体路径和错误信息',
    !!(permReport && permReport.failed[0] && permReport.failed[0].dir && /权限不足/.test(permReport.failed[0].message)),
    permReport && permReport.failed[0]
  );

  /* ============================================================
   * D. 启动推导（loadSettings）：工作区优先，且只算路径不建目录
   * ============================================================ */
  const defaultBase = path.join(tmp, 'documents', '测试工作台');
  const startup = {
    workspaceDir: path.join(tmp, 'new-ws'),
    casesDir: expectPath(defaultBase, 'casesDir'),
    derivedDirs: {}
  };
  workspaceDerive.applyStartupDefaults(startup, defaultBase);
  check(
    'D1 启动时工作区优先（覆盖老版本写进去的默认目录）',
    startup.casesDir === expectPath(path.join(tmp, 'new-ws'), 'casesDir'),
    startup.casesDir
  );
  check('D2 启动推导只算路径、不建目录', !fs.existsSync(startup.casesDir), 'created at startup');

  const startupEmpty = { workspaceDir: '', derivedDirs: {} };
  workspaceDerive.applyStartupDefaults(startupEmpty, defaultBase);
  check(
    'D3 没配工作区时按默认目录兜底 5 个（老语义）',
    ['casesDir', 'jmxDir', 'reportDir', 'kbDir', 'notesDir'].every((k) => startupEmpty[k] === expectPath(defaultBase, k)),
    startupEmpty
  );
  check(
    'D4 allure / project 不在默认兜底里（和老版本一致）',
    startupEmpty.allureDir === undefined && startupEmpty.projectDir === undefined,
    startupEmpty
  );
  check('D5 默认兜底也不建目录', !fs.existsSync(startupEmpty.notesDir), 'created at startup');

  const ownedSettings = {
    workspaceDir: '',
    casesDir: path.join(tmp, 'user-cases'),
    derivedDirs: {}
  };
  workspaceDerive.applyStartupDefaults(ownedSettings, defaultBase);
  check('D6 启动时不动用户显式填的目录', ownedSettings.casesDir === path.join(tmp, 'user-cases'), ownedSettings.casesDir);

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('===== v0.43.1 PIN 移除 + 工作区推导测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('崩了:', (e && e.stack) || e);
  process.exit(1);
});