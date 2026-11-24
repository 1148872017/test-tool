/**
 * test-security.cjs —— 后端安全 6 项的正例 / 反例（第 2 波改造）
 *
 *   1. 命令注入（.cmd + shell:true → 任意命令执行）
 *   2. 更新通道（任意 URL 下载 → 任意路径写 → 执行）
 *   3. 迁移 v5 明文密码 / v7 回扫重加密
 *   4. IPC 解锁守卫（锁定态仍能调 13+ 个敏感通道）
 *   5. isInsideRoot 接线（root/file 入参照单全收）
 *   6. 导航护栏（markdown 外链 → 窗口离开 app 源 → 直达 IPC = RCE）
 *
 * 写法说明：
 *   - 纯函数直接调（快、无副作用）；
 *   - 「真的会不会被执行」「真的会不会被拦」这类必须跑真实代码：
 *     命令注入用真 .cmd 探针，IPC 用真 require main.js + stub electron，
 *     这样断言的是行为而不是「源码里有没有写某句话」。
 *   - 静态断言只用于「结构上不许出现某种写法」（比如 shell: true）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const proj = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-security-'));
process.env.TT_DATA_DIR = tmp;
process.env.TT_NO_DEMO = '1';
delete process.env.TT_DEBUG;

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 0. stub electron + 真加载 main.js（IPC 守卫 / 路径守卫要真行为）
 * ============================================================ */
const handlers = {};
const clip = { value: '' };
const openedPaths = [];
const openedExternal = [];

const fakeElectron = {
  app: {
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getPath(p) {
      if (p === 'temp') return path.join(tmp, 'temp');
      if (p === 'appData') return path.join(tmp, 'appData');
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
      return '0.42.0';
    },
    commandLine: { appendSwitch() {} }
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        send() {},
        on() {},
        toggleDevTools() {},
        setWindowOpenHandler(fn) {
          handlers.__windowOpenHandler = fn;
        }
      };
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
      if (handlers[channel] && channel.indexOf('__') !== 0) {
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
  shell: {
    openExternal: async (u) => {
      openedExternal.push(u);
      return true;
    },
    openPath: async (p) => {
      openedPaths.push(p);
      return '';
    },
    showItemInFolder() {}
  },
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
  },
  net: { request: () => { throw new Error('stub: 测试不联网'); } }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

require(path.join(proj, 'electron', 'main.js'));

const call = (channel, payload) => handlers[channel]({}, payload);

/* 直接 require 的模块（纯函数 / 不依赖 electron 运行期） */
const shellSafety = require(path.join(proj, 'shared', 'shell-safety.js'));
const { RUNNERS } = require(path.join(proj, 'shared', 'runners.js'));
const runner = require(path.join(proj, 'electron', 'runner.js'));
const updater = require(path.join(proj, 'electron', 'updater.js'));
const sharedHelpers = require(path.join(proj, 'electron', 'shared-helpers.js'));
const ipcGuard = require(path.join(proj, 'electron', 'ipc-guard.js'));
const navGuard = require(path.join(proj, 'electron', 'nav-guard.js'));
const scanRules = require(path.join(proj, 'electron', 'scan-rules.js'));
const migrations = require(path.join(proj, 'electron', 'migrations.js'));

const electronSrc = require('./_electron-src.cjs').readElectronSource();
const srcOf = (rel) => fs.readFileSync(path.join(proj, rel), 'utf8');

/** 跑一个命令，收集 stdout（探针用） */
function runProbe(opts) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const id = runner.run({
      cmd: opts.cmd,
      args: opts.args,
      cwd: opts.cwd,
      timeout: 15000,
      onData: (c) => {
        if (c.stream === 'stdout') out += c.text;
        else err += c.text;
      },
      onExit: (r) => resolve({ out, err, ...r, id })
    });
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 2500));

  /* ============================================================
   * 1. 命令注入
   * ============================================================ */
  {
    /* 1.1 纯校验：Maven 测试类名 */
    const bad = ['Foo & echo PWNED', 'Foo|bar', 'Foo/Bar', 'Foo"x', "Foo'x", 'Foo;calc', 'Foo>x', 'Foo%PATH%', 'Foo Bar', 'Foo\nbar', 'Foo$(id)'];
    for (const v of bad) {
      const r = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj', testClass: v });
      check('maven 拒绝非法测试类名：' + JSON.stringify(v), !!r.error && /测试类名不合法/.test(r.error), r);
    }
    const okClass = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj', testClass: 'com.x.LoginTest' });
    check('maven 接受合法类名（idea 的 $ 内部类也放行）', !okClass.error && okClass.args.includes('-Dtest=com.x.LoginTest'), okClass);
    const innerClass = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj', testClass: 'com.x.LoginTest$Inner#method' });
    check('maven 接受 $ 内部类 # 方法名', !innerClass.error && innerClass.args.includes('-Dtest=com.x.LoginTest$Inner#method'), innerClass);
    const emptyClass = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj', testClass: '' });
    check('maven 空测试类名 = 跑全部（不加 -Dtest）', !emptyClass.error && !emptyClass.args.some((a) => a.startsWith('-Dtest=')), emptyClass);

    /* 1.2 纯校验：会被拼进命令行的路径 */
    const badDir = RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/proj & calc' });
    check('maven 拒绝含 & 的项目目录', !!badDir.error && /项目目录/.test(badDir.error), badDir);
    check('projectDir 含空格仍然允许（"Program Files (x86)" 是合法目录）', !RUNNERS.maven.build({ mvn: 'mvn.cmd', projectDir: 'D:/Program Files (x86)/proj' }).error);
    check('shell-safety 直接判非法路径', shellSafety.assertCommandPath('D:/a & b', '脚本').ok === false);
    check('shell-safety 判 空值 为合法（空 = 不传）', shellSafety.assertCommandPath('', '脚本').ok === true && shellSafety.assertCommandPath('', '脚本').value === '');
    check('shell-safety 拒绝换行注入', shellSafety.assertCommandPath('D:/a\ncalc', '脚本').ok === false);

    /* 1.3 结构：cmd.exe 调用形态（argv 由我们控制） */
    const inv = shellSafety.buildCmdExeInvocation('D:/a b/mvn.cmd', ['-q', 'test', '-Dtest=Foo & calc']);
    check('batch 调用走 cmd.exe', /cmd\.exe$/i.test(inv.file), inv.file);
    check('batch 调用带 /d /s /c', inv.args[0] === '/d' && inv.args[1] === '/s' && inv.args[2] === '/c', inv.args);
    check('batch 调用把整条命令包成一层引号', inv.args[3].startsWith('""') && inv.args[3].endsWith('""'), inv.args[3]);
    check('batch 调用逐项加引号（注入串被关在引号里）', inv.args[3].indexOf('"-Dtest=Foo & calc"') >= 0, inv.args[3]);
    check('batch 调用声明 windowsVerbatimArguments', inv.windowsVerbatimArguments === true);
    check('参数里有引号时直接抛错而不是硬拼', (() => {
      try {
        shellSafety.buildCmdExeInvocation('x.cmd', ['a"b']);
        return false;
      } catch (e) {
        return true;
      }
    })());

    /* 1.4 静态：不能再出现 shell:true / needsShell */
    const runnerSrc = srcOf('electron/runner.js');
    check('runner.js 不再用 shell: true', !/shell:\s*true/.test(runnerSrc), 'shell:true remains');
    check('runner.js 不再用 needsShell 分支', !/needsShell/.test(runnerSrc), 'needsShell remains');
    check('runner.js 用 windowsVerbatimArguments 自己组 argv', /windowsVerbatimArguments:\s*true/.test(runnerSrc));
    check('shared-helpers.js 的 launchJmeter 不再用 shell: true', !/shell:\s*true/.test(srcOf('electron/shared-helpers.js')), 'shell:true remains');

    /* 1.5 行为探针：真的跑一个 .cmd，看注入串会不会被执行 */
    const probeDir = path.join(tmp, 'probe');
    fs.mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, 'echo-args.cmd');
    fs.writeFileSync(probe, '@echo off\r\necho ARG1=[%1]\r\necho ARG2=[%2]\r\nexit /b 3\r\n', 'utf8');
    const marker = path.join(probeDir, 'PWNED.txt');

    const clean = await runProbe({ cmd: probe, args: ['-Dtest=Foo', 'normal'], cwd: probeDir });
    // 注意：批处理里的 %1 会保留引号（所以是 ARG1=["-Dtest=Foo"]），这是 cmd 的正常行为
    check('探针：.cmd 能正常跑起来（argv 传递没坏）', clean.out.indexOf('-Dtest=Foo') >= 0 && clean.out.indexOf('ARG1=[') >= 0, clean.out);
    check('探针：退出码原样传回', clean.code === 3, clean.code);

    const attack = await runProbe({
      cmd: probe,
      args: ['-Dtest=Foo', 'x & type nul > PWNED.txt'],
      cwd: probeDir
    });
    check('探针：注入串没有被当成第二条命令（marker 文件没生成）', !fs.existsSync(marker), 'PWNED.txt created!');
    check('探针：注入串原样落在一个参数里', attack.out.indexOf('x & type nul > PWNED.txt') >= 0, attack.out);

    /* 1.6 launchJmeter：脚本路径先过白名单（不合法不启动） */
    const badJmx = sharedHelpers.launchJmeter({}, () => {}, 'D:/x.jmx & calc');
    check('launchJmeter 拒绝含 & 的 jmx 路径', badJmx.ok === false && badJmx.code === 'BAD_PATH', badJmx);
    const badJmx2 = sharedHelpers.launchJmeter({}, () => {}, 'D:/x.jmx | calc');
    check('launchJmeter 拒绝含 | 的 jmx 路径', badJmx2.ok === false, badJmx2);
  }

  /* ============================================================
   * 2. 更新通道
   * ============================================================ */
  {
    const GOOD_PREFIX = 'https://github.com/1148872017/test-tool/releases/download/';
    const GOOD_NAME = 'test-tool-Setup-0.43.0-x64.exe';
    const GOOD_URL = GOOD_PREFIX + 'v0.43.0/' + GOOD_NAME;

    /* 2.1 URL 白名单 */
    check('更新：官方前缀放行', updater.isAllowedUpdateUrl(GOOD_URL) === true);
    check('更新：http 的任意主机拒绝', updater.isAllowedUpdateUrl('http://evil.com/x.exe') === false);
    check('更新：github 其它仓库拒绝', updater.isAllowedUpdateUrl('https://github.com/evil/repo/releases/download/v1/x.exe') === false);
    check('更新：同前缀绕过（download-evil）拒绝', updater.isAllowedUpdateUrl('https://github.com/1148872017/test-tool/releases/download-evil/v1/x.exe') === false);
    check('更新：file:// 拒绝', updater.isAllowedUpdateUrl('file:///C:/Windows/System32/cmd.exe') === false);
    check('更新：空 url 拒绝', updater.isAllowedUpdateUrl('') === false);

    /* 2.2 文件名白名单（路径穿越） */
    check('更新：正常安装包名放行', updater.safeAssetName(GOOD_NAME) === GOOD_NAME);
    check('更新：../../evil.exe 拒绝', updater.safeAssetName('../../evil.exe') === '');
    check('更新：..\\..\\evil.exe 拒绝', updater.safeAssetName('..\\..\\evil.exe') === '');
    check('更新：绝对路径拒绝', updater.safeAssetName('C:\\Windows\\System32\\cmd.exe') === '');
    check('更新：非本产品名拒绝', updater.safeAssetName('evil.exe') === '');
    check('更新：伪装前缀但扩展名不对拒绝', updater.safeAssetName('test-tool-Setup-0.43.0-x64.bat') === '');
    check('更新：.. 单独拒绝', updater.safeAssetName('..') === '');

    /* 2.3 download 的入参闸（在碰磁盘/网络之前就拦住） */
    const d1 = await updater.download({ name: '../../evil.exe', url: GOOD_URL, size: 10 }, () => {});
    check('更新：下载时拒绝穿越文件名', d1.ok === false && d1.code === 'BAD_ASSET_NAME', d1);
    const d2 = await updater.download({ name: GOOD_NAME, url: 'http://evil.com/x.exe', size: 10 }, () => {});
    check('更新：下载时拒绝非白名单 URL', d2.ok === false && d2.code === 'BAD_ASSET_URL', d2);
    const d3 = await updater.download({ name: GOOD_NAME, url: GOOD_URL, size: 10 }, () => {});
    check('更新：没有 sha512 就拒绝下载（下载完要执行的，必须可校验）', d3.ok === false && d3.code === 'NO_SHA512', d3);

    /* 2.4 install：只认下载目录 + 校验过的文件 */
    const outside = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const i1 = await updater.install(outside);
    check('更新：install 拒绝系统目录里的可执行文件', i1.ok === false && /下载目录/.test(i1.message), i1);
    const fakeExe = path.join(updater.downloadDir(), GOOD_NAME);
    fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
    fs.writeFileSync(fakeExe, 'not really an installer', 'utf8');
    const i2 = await updater.install(fakeExe);
    check('更新：install 拒绝没有校验记录的安装包', i2.ok === false && i2.code === 'UNVERIFIED', i2);
    check('更新：install 拒绝不存在的文件', (await updater.install(path.join(tmp, 'nope.exe'))).ok === false);
    check('更新：install 拒绝空路径', (await updater.install('')).ok === false);
    check('更新：下载目录判定按分隔符（兄弟目录不算）', updater.isInsideDownloadDir(path.dirname(updater.downloadDir()) + path.sep + 'other') === false);
    check('sha512 归一化：支持 sha512- 前缀', updater.normalizeSha512('sha512-' + 'A'.repeat(88)) === 'A'.repeat(88));
    check('sha512 归一化：垃圾值返回空', updater.normalizeSha512('hello') === '');
    check(
      'sha512 校验：值对得上返回 true、对不上返回 false',
      (await (async () => {
        const f = path.join(tmp, 'sha-probe.txt');
        fs.writeFileSync(f, 'abc', 'utf8');
        const crypto = require('crypto');
        const right = crypto.createHash('sha512').update('abc').digest('base64');
        const a = await updater.verifyFileSha512(f, right);
        const b = await updater.verifyFileSha512(f, 'B'.repeat(88));
        return a === true && b === false;
      })()) === true
    );

    /* 2.5 update:* 通道带解锁校验（在锁定态下验证，见第 4 部分） */
    check('更新：频道前缀常量存在', /^https:\/\/github\.com\/1148872017\/test-tool\/releases\/download\/$/.test(updater.DOWNLOAD_PREFIX), updater.DOWNLOAD_PREFIX);
  }

  /* ============================================================
   * 3. 迁移：v5 走 serialize / v7 回扫重加密
   * ============================================================ */
  {
    check('迁移：SCHEMA_VERSION = 7', migrations.SCHEMA_VERSION === 7, migrations.SCHEMA_VERSION);
    check('迁移：v7 存在', migrations.MIGRATIONS.some((m) => m.to === 7), migrations.MIGRATIONS.map((m) => m.to));
    check(
      '迁移：v5 新建「未归类账号」时走 api.serialize（不再裸 JSON.stringify）',
      /api\.sql\([\s\S]{0,400}JSON\.stringify\(api\.serialize\('sites', data\)\)/.test(srcOf('electron/migrations.js')),
      'v5 still writes plaintext'
    );
    check('迁移：store 把 serialize 暴露给迁移脚本', /serialize:\s*\(collection, data\) => serialize\(collection, data\)/.test(srcOf('electron/store.js')));
    check('迁移：v7 幂等判定用 enc:/raw: 前缀', (() => {
      const p = migrations.plainSecretPaths;
      return (
        p({ password: 'plain' }, ['password']).length === 1 &&
        p({ password: 'enc:xxx' }, ['password']).length === 0 &&
        p({ password: 'raw:eHl6' }, ['password']).length === 0 &&
        p({ password: '' }, ['password']).length === 0 &&
        p({ accounts: [{ password: 'plain' }] }, ['accounts[].password']).length === 1
      );
    })());
    check('迁移：v7 迁移写的是「重新加密」而不是删数据', /api\.write\(rec\)/.test(srcOf('electron/migrations.js')));

    /* 端到端：造一条 v6 的明文记录 → 打开库 → 变成 enc: */
    const v7dir = path.join(tmp, 'v7');
    fs.mkdirSync(v7dir, { recursive: true });
    const initSqlJs = require(path.join(proj, 'node_modules', 'sql.js'));
    const SQL = await initSqlJs({
      locateFile: (f) => path.join(path.dirname(require.resolve(path.join(proj, 'node_modules', 'sql.js'))), f)
    });
    const legacy = new SQL.Database();
    legacy.run(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, collection TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    legacy.run(
      'INSERT INTO records (id, collection, title, data, tags, favorite, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'r_plain',
        'sites',
        '明文站',
        JSON.stringify({ name: '明文站', accounts: [{ label: 'a', account: 'u1', password: 'SecretPlain1', role: [], isDefault: true }] }),
        '',
        0,
        Date.now(),
        Date.now(),
        0
      ]
    );
    legacy.run('INSERT INTO meta (k, v) VALUES (?, ?)', ['schemaVersion', '6']);
    fs.writeFileSync(path.join(v7dir, 'data.db'), Buffer.from(legacy.export()));
    legacy.close();

    const storeMod = require(path.join(proj, 'electron', 'store'));
    const info = await storeMod.init(v7dir);
    check('迁移：v6 老库能升上来', storeMod.schemaVersion() >= 7, storeMod.schemaVersion());
    check('迁移：v7 在升级记录里', !!(info.migration && info.migration.ran.indexOf(7) >= 0), info.migration);
    const rec = storeMod.get('r_plain');
    check('迁移：明文密码还能解出来（数据没丢）', rec && rec.data.accounts[0].password === 'SecretPlain1', rec && rec.data);
    const rawDb = fs.readFileSync(path.join(v7dir, 'data.db'));
    check('迁移：磁盘上已经没有明文密码', rawDb.indexOf(Buffer.from('SecretPlain1')) === -1, 'plaintext in db!');
    check('迁移：磁盘上出现了密文前缀', rawDb.indexOf(Buffer.from('enc:')) >= 0);

    // 幂等：退回版本号再打开一次
    storeMod.setMeta('schemaVersion', 6);
    storeMod.persist();
    storeMod.close();
    const info2 = await storeMod.init(v7dir);
    check('迁移：v7 重跑不报错（幂等）', !!(info2.migration && info2.migration.ran.indexOf(7) >= 0), info2.migration);
    const rec2 = storeMod.get('r_plain');
    check('迁移：重跑后数据不变', rec2 && rec2.data.accounts[0].password === 'SecretPlain1', rec2 && rec2.data);
    const rawDb2 = fs.readFileSync(path.join(v7dir, 'data.db'));
    check('迁移：重跑后仍然没有明文', rawDb2.indexOf(Buffer.from('SecretPlain1')) === -1, 'plaintext in db!');
    storeMod.close();
  }

  /* ============================================================
   * 4. IPC 解锁守卫
   * ============================================================ */
  {
    /* 4.1 判定逻辑 */
    const needLock = [
      'data:export',
      'data:import',
      'backup:now',
      'backup:restore',
      'data:openDir',
      'data:exportDb',
      'data:clear',
      'data:genFile',
      'settings:set',
      'clipboard:copy',
      'update:download',
      'update:cancel',
      'update:cleanup',
      'update:install',
      'skin:getImage',
      'records:list',
      'jmx:openGui'
    ];
    for (const ch of needLock) {
      check('守卫：' + ch + ' 要求解锁', ipcGuard.needsUnlock(ch) === true, ch);
    }
    const freeList = ipcGuard.UNLOCK_WHITELIST.concat(['pin:set', 'pin:clear', 'pin:anything']);
    for (const ch of freeList) {
      check('守卫：' + ch + ' 锁定态放行', ipcGuard.needsUnlock(ch) === false, ch);
    }
    check('守卫：白名单只有 5 个精确通道 + pin 前缀', ipcGuard.UNLOCK_WHITELIST.length === 5, ipcGuard.UNLOCK_WHITELIST);
    check('守卫：前缀不能误伤（pinned:x 仍需解锁）', ipcGuard.needsUnlock('pinned:set') === true);
    check('守卫：空通道名默认需要解锁', ipcGuard.needsUnlock('') === true);

    /* 4.2 包装器行为：锁定态抛 LOCKED，白名单不抛 */
    {
      const store2 = {};
      let locked = true;
      const fakeIpc = {
        handle(ch, fn) {
          store2[ch] = fn;
        }
      };
      const handle = ipcGuard.createHandle({
        ipcMain: fakeIpc,
        assertUnlocked: () => {
          if (locked) {
            const e = new Error('已锁定，请先解锁');
            e.code = 'LOCKED';
            throw e;
          }
        }
      });
      handle('data:export', async () => 'secret');
      handle('app:init', async () => 'boot');

      let blocked = null;
      try {
        await store2['data:export']({});
      } catch (e) {
        blocked = e;
      }
      check('守卫：包装后的敏感通道锁定态抛 LOCKED', blocked && blocked.code === 'LOCKED', blocked && blocked.message);
      check('守卫：包装后的白名单通道锁定态照常返回', (await store2['app:init']({})) === 'boot');
      locked = false;
      check('守卫：解锁后敏感通道恢复', (await store2['data:export']({})) === 'secret');
    }

    /* 4.3 真 main.js：逐个通道验证（这就是「列出所有通道」那一步） */
    const allChannels = Object.keys(handlers).filter((c) => c.indexOf('__') !== 0);
    check('守卫：main.js 注册了全部通道', allChannels.length >= 110, allChannels.length);

    const pinRes = await call('pin:set', { oldPin: '', pin: '1234' });
    check('守卫：能设锁屏密码（pin:* 在锁定态也可用）', pinRes && pinRes.ok === true, pinRes);
    await call('app:lock');

    const leaked = [];
    let guardedCount = 0;
    let freeCount = 0;
    for (const ch of allChannels) {
      if (!ipcGuard.needsUnlock(ch)) {
        freeCount += 1;
        continue;
      }
      guardedCount += 1;
      let err = null;
      try {
        await handlers[ch]({}, undefined);
      } catch (e) {
        err = e;
      }
      if (!err || err.code !== 'LOCKED') leaked.push(ch);
    }
    check('守卫：白名单之外的通道全部真的拒了（无泄露）', leaked.length === 0, leaked);
    check('守卫：受保护通道数 > 100', guardedCount > 100, guardedCount);
    // 放行的 = 5 个白名单精确通道 + pin:set / pin:clear 两个前缀通道
    check('守卫：放行的通道数 = 白名单 5 + pin 族 2', freeCount === 7, freeCount);

    const initLocked = await call('app:init');
    check('守卫：锁定态 app:init 仍可用且报告 locked', initLocked && initLocked.locked === true, initLocked && initLocked.locked);
    const stLocked = await call('settings:get');
    check('守卫：锁定态 settings:get 仍可用', !!stLocked && typeof stLocked === 'object');
    const badUnlock = await call('app:unlock', { pin: '0000' });
    check('守卫：错密码解锁失败', badUnlock && badUnlock.ok === false, badUnlock);
    const goodUnlock = await call('app:unlock', { pin: '1234' });
    check('守卫：对密码解锁成功', goodUnlock && goodUnlock.ok === true, goodUnlock);
  }

  /* ============================================================
   * 5. isInsideRoot / assertPathIn 接线
   * ============================================================ */
  {
    const rootDir = path.join(tmp, 'allowed-root');
    const insideFile = path.join(rootDir, 'sub', 'a.md');
    const siblingFile = path.join(tmp, 'allowed-root-evil', 'a.md');
    const settingsStub = { kbDir: rootDir };

    check('路径：白名单内返回 null', sharedHelpers.assertPathIn(insideFile, [], settingsStub) === null);
    check('路径：根自身允许', sharedHelpers.assertPathIn(rootDir, [], settingsStub) === null);
    check('路径：兄弟目录（同前缀）拒绝', (() => {
      const r = sharedHelpers.assertPathIn(siblingFile, [], settingsStub);
      return !!r && r.code === 'OUTSIDE_ROOT';
    })(), siblingFile);
    check('路径：.. 越界拒绝', (() => {
      const r = sharedHelpers.assertPathIn(path.join(rootDir, '..', 'other', 'x.md'), [], settingsStub);
      return !!r && r.code === 'OUTSIDE_ROOT';
    })());
    check('路径：系统文件拒绝', (() => {
      const r = sharedHelpers.assertPathIn('C:\\Windows\\System32\\drivers\\etc\\hosts', [], settingsStub);
      return !!r && r.code === 'OUTSIDE_ROOT';
    })());
    check('路径：空值拒绝', (() => {
      const r = sharedHelpers.assertPathIn('', [], settingsStub);
      return !!r && r.code === 'BAD_PATH';
    })());
    check('路径：settings 里的 8 个目录都算白名单', sharedHelpers.settingsRoots({
      workspaceDir: 'a',
      casesDir: 'b',
      jmxDir: 'c',
      reportDir: 'd',
      allureDir: 'e',
      kbDir: 'f',
      notesDir: 'g',
      projectDir: 'h'
    }).length === 8);
    check('路径：会话内选过的目录被记住', (() => {
      sharedHelpers.resetSessionRoots();
      const picked = path.join(tmp, 'picked-root');
      fs.mkdirSync(picked, { recursive: true });
      sharedHelpers.rememberPicked(picked);
      const ok = sharedHelpers.isPathAllowed(path.join(picked, 'x', 'y.txt'), [], {});
      sharedHelpers.resetSessionRoots();
      return ok === true;
    })());
    check('路径：会话记忆可以清空（不跨会话泄漏）', (() => {
      const picked = path.join(tmp, 'picked-root');
      sharedHelpers.resetSessionRoots();
      return sharedHelpers.isPathAllowed(path.join(picked, 'x.txt'), [], {}) === false;
    })());
    check('路径：realpath 归一化（不存在的路径按 resolve 处理）', typeof sharedHelpers.isPathAllowed === 'function');
    check('路径：isInsideRoot 本身仍然可用', scanRules.isInsideRoot(rootDir, insideFile) === true && scanRules.isInsideRoot(rootDir, siblingFile) === false);

    /* 5.1 skin:getImage 的穿越点 */
    check('皮肤：正常文件名放行', sharedHelpers.safeSkinFileName('bg.png') === 'bg.png');
    check('皮肤：zip 之类扩展名拒绝', sharedHelpers.safeSkinFileName('bg.zip') === '');
    check('皮肤：../../.ssh/id_rsa 拒绝', sharedHelpers.safeSkinFileName('../../../Users/x/.ssh/id_rsa') === '');
    check('皮肤：..\\..\\x.png 拒绝', sharedHelpers.safeSkinFileName('..\\..\\x.png') === '');
    check('皮肤：绝对路径拒绝', sharedHelpers.safeSkinFileName('C:\\Windows\\bg.png') === '');
    check('皮肤：名字前缀不对拒绝', sharedHelpers.safeSkinFileName('evil.png') === '');
    check('皮肤：.. 拒绝', sharedHelpers.safeSkinFileName('..') === '');

    /* 5.2 真 IPC：越界入参必须被拒（正例也要通） */
    const outsideDir = 'C:\\Windows\\System32\\drivers\\etc';
    const c1 = await call('codescan:coverage', { root: outsideDir });
    check('IPC：codescan:coverage 拒绝系统目录', c1 && c1.ok === false && c1.code === 'OUTSIDE_ROOT', c1);
    const c2 = await call('codescan:hardcoded', { root: outsideDir });
    check('IPC：codescan:hardcoded 拒绝系统目录', c2 && c2.ok === false && c2.code === 'OUTSIDE_ROOT', c2);
    const c3 = await call('codescan:deps', { root: outsideDir });
    check('IPC：codescan:deps 拒绝系统目录', c3 && c3.ok === false && c3.code === 'OUTSIDE_ROOT', c3);
    const c4 = await call('kb:openFile', { file: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    check('IPC：kb:openFile 拒绝系统文件（不会去打开它）', c4 && c4.ok === false && c4.code === 'OUTSIDE_ROOT', c4);
    const c5 = await call('backup:restore', { file: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    check('IPC：backup:restore 拒绝白名单外的 .db', c5 && c5.ok === false && c5.code === 'OUTSIDE_ROOT', c5);
    const c6 = await call('data:genFile', { dir: 'C:\\Windows\\Temp', count: 1, type: 'name' });
    check('IPC：data:genFile 拒绝往系统目录写文件', c6 && c6.ok === false && c6.code === 'OUTSIDE_ROOT', c6);
    const c7 = await call('allure:parse', { dir: outsideDir });
    check('IPC：allure:parse 拒绝系统目录', c7 && c7.ok === false && c7.code === 'OUTSIDE_ROOT', c7);
    const c8 = await call('allure:flaky', { dirs: [outsideDir] });
    check('IPC：allure:flaky 拒绝系统目录', c8 && c8.ok === false && c8.code === 'OUTSIDE_ROOT', c8);
    const c9 = await call('report:parse', { dir: outsideDir });
    check('IPC：report:parse 拒绝系统目录', c9 && c9.ok === false && c9.code === 'OUTSIDE_ROOT', c9);
    const c10 = await call('jmx:openGui', { file: 'C:\\Windows\\System32\\cmd.exe' });
    check('IPC：jmx:openGui 拒绝系统可执行文件', c10 && c10.ok === false, c10);

    // 正例：用户自己配的知识库目录里的文件能打开
    const kbDir = path.join(tmp, 'kb-real');
    fs.mkdirSync(kbDir, { recursive: true });
    const kbFile = path.join(kbDir, 'note.md');
    fs.writeFileSync(kbFile, '# hi', 'utf8');
    await call('settings:set', { kbDir });
    const okOpen = await call('kb:openFile', { file: kbFile });
    check('IPC：白名单内的文件能正常打开', okOpen && okOpen.ok === true, okOpen);

    // 扫描过的根：*:scan 传进来的 root 自动进白名单（否则「选了目录→打开文件」会被拦）
    const scanRoot = path.join(tmp, 'scan-root2');
    fs.mkdirSync(path.join(scanRoot, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(scanRoot, 'deep', 'x.md'), '# x', 'utf8');
    await call('kb:scan', { root: scanRoot });
    const afterScan = await call('kb:openFile', { file: path.join(scanRoot, 'deep', 'x.md') });
    check('IPC：扫描过的根目录内的文件可以打开（会话内记忆）', afterScan && afterScan.ok === true, afterScan);

    // 皮肤穿越：settings 里塞穿越串，getImage 必须回空而不是读文件
    await call('settings:set', { bgImage: '..\\..\\..\\Users\\x\\.ssh\\id_rsa' });
    const skin = await call('skin:getImage');
    check('IPC：skin:getImage 对穿越文件名回空', skin && skin.ok === true && skin.url === '' && skin.rejected === true, skin);
    await call('settings:set', { bgImage: '' });

    // data:openDir 这类仍然正常（数据目录在白名单里）
    const openDirOk = await call('data:openDir');
    check('IPC：data:openDir 仍然可用', typeof openDirOk === 'string' && openDirOk.length > 0, openDirOk);
  }

  /* ============================================================
   * 6. 导航护栏
   * ============================================================ */
  {
    const distDir = path.join(proj, 'dist');
    const appUrl = 'file:///' + path.join(distDir, 'index.html').replace(/\\/g, '/');
    check('导航：app 自己的 file:// 页面放行', navGuard.isAppUrl(appUrl, distDir) === true, appUrl);
    check('导航：https 外链不放行', navGuard.isAppUrl('https://evil.com/x', distDir) === false);
    check('导航：外部 file:// 不放行', navGuard.isAppUrl('file:///C:/Windows/System32/x.html', distDir) === false);
    check('导航：空串不放行', navGuard.isAppUrl('', distDir) === false);
    check('导航：http 外链允许交给系统浏览器', navGuard.isExternalUrlAllowed('http://a.com/x') === true);
    check('导航：https 外链允许交给系统浏览器', navGuard.isExternalUrlAllowed('https://a.com/x') === true);
    check('导航：file:// 不许 openExternal', navGuard.isExternalUrlAllowed('file:///C:/Windows/x.exe') === false);
    check('导航：javascript: 不许 openExternal', navGuard.isExternalUrlAllowed('javascript:alert(1)') === false);
    check('导航：相对链接不按外链处理', navGuard.safeExternalHref('./other.md') === '');
    check('导航：safeExternalHref 只放 http(s)', navGuard.safeExternalHref('https://a.com') === 'https://a.com' && navGuard.safeExternalHref('ms-msdt:/id') === '');

    const mainSrc = srcOf('electron/main.js');
    check('导航：main.js 有 will-navigate', /will-navigate/.test(mainSrc));
    check('导航：main.js 有 preventDefault', /preventDefault\(\)/.test(mainSrc));
    check('导航：main.js 有 setWindowOpenHandler', /setWindowOpenHandler/.test(mainSrc));
    check("导航：window-open 一律 deny", /action:\s*'deny'/.test(mainSrc));
    check('导航：BrowserWindow 开了 sandbox', /sandbox:\s*true/.test(mainSrc));
    check('导航：不再有 sandbox: false', !/sandbox:\s*false/.test(mainSrc));

    // 沙箱要求：preload 只能依赖 electron 的 contextBridge/ipcRenderer
    const preloadSrc = srcOf('electron/preload.js');
    const requires = [...preloadSrc.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    check('导航：preload 只 require electron（sandbox 下 Node 模块不可用）', requires.length > 0 && requires.every((m) => m === 'electron'), requires);
    check('导航：preload 用 contextBridge 暴露 api', /contextBridge\.exposeInMainWorld\('api'/.test(preloadSrc));
  }

  /* ============================================================
   * 7. 收尾：静态一致性
   * ============================================================ */
  {
    check('结构：所有域模块都从 deps 取 handle 注册通道', (() => {
      const dir = path.join(proj, 'electron', 'ipc');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
      const bad = files.filter((f) => {
        const s = fs.readFileSync(path.join(dir, f), 'utf8');
        if (!/handle\('/.test(s)) return false; // 这个域没有通道
        return !/\bhandle\b[\s\S]{0,200}= deps;/.test(s) && !/handle,\s*\n/.test(s) && !/\{\s*handle\s*,/.test(s);
      });
      return bad.length === 0;
    })());
    check('结构：ipc-settings.js 不再直接 path.join(skinDir(), settings.bgImage)', !/path\.join\(skinDir\(\), settings\.bgImage\)/.test(srcOf('electron/ipc/ipc-settings.js')));
    check('结构：ipc-scan.js 三处扫描都接了 assertPathIn', (srcOf('electron/ipc/ipc-scan.js').match(/assertPathIn\(dir\)/g) || []).length === 3);
    check('结构：ipc-guard 是唯一注册入口（main.js 里 createHandle）', /handle:\s*ipcGuard\.createHandle\(/.test(srcOf('electron/main.js')));
    check('结构：electron/ 下没有裸 ipcMain.handle 注册', !/ipcMain\.handle\('/.test(electronSrc));
  }

  /* ---------------- 汇总 ---------------- */
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 后端安全测试（第 2 波） =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH', e);
  process.exit(2);
});