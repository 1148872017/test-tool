'use strict';
/**
 * ipc-projects.js —— 「在项目中定位」域的 IPC。
 *
 * 为什么单独一个模块，而不是塞进 ipc-runner.js：
 *   代码调试域（projects:scan / projects:testClasses / runner:*）在 ipc-runner.js 里，
 *   那一块一直在改（超时、运行器、取消）。这里只放「报告分析页点失败用例 →
 *   定位到源码文件」需要的两个通道，自包含：改报告页的人不用碰运行器域。
 *
 * 两个通道都是**只读 + 定位**，不写任何用户资产（底线 #4）。
 *
 * ------------------------------------------------------------------
 * 关于「能不能跳到第几行」（重要，别把它做成假绿）
 *   Electron 的 shell.showItemInFolder 只能**在文件管理器里选中文件**，
 *   没有「选中第 N 行」这种能力；平台也不下载、不安装任何编辑器/插件
 *   （底线 #7）。所以这里的可靠做法是：
 *     1. 文件管理器里选中源文件（离线、不装东西、一定能做到）；
 *     2. 行号从 Allure 的**失败堆栈**里取（真实信息，不猜），界面复制成
 *        「文件:行」到剪贴板，用户粘到 IDE 的跳转框里就能到行。
 *   界面上明写「只到文件」，不承诺平台自己能跳行。
 * ------------------------------------------------------------------
 */
const projects = require('../projects');

function register(deps) {
  const { handle, shell, fs, getSettings, assertUnlocked, assertPathIn } = deps;

  /**
   * 把 Allure 的 testClass 标签映射到源文件。
   *
   * payload:
   *   testClass  Allure 的 testClass 标签（FQCN / 简单类名 / pytest 文件名都认）
   *   root       可选，显式指定项目根；空 = 设置里的「代码项目目录」
   *
   * 返回：{ ok, root, testClass, scanned: string[], truncated: string[], matches: [...] }
   *   matches[].file 是绝对路径，界面拿它去 projects:reveal。
   *
   * 找不到就是 matches: [] —— 不返回「猜一个最像的」，猜出来的定位点比没有更坑。
   */
  handle('projects:locateTest', async (e, payload = {}) => {
    assertUnlocked();
    const p = payload || {};
    const testClass = String(p.testClass || '').trim();
    if (!testClass) {
      return {
        ok: false,
        code: 'NO_TEST_CLASS',
        message: '这条用例没有 testClass 标签，定位不了',
        matches: [],
        scanned: []
      };
    }
    const settings = getSettings();
    const root = String(p.root || '').trim() || String(settings.projectDir || '').trim();
    if (!root) {
      return {
        ok: false,
        code: 'NO_PROJECT_DIR',
        message: '还没配「代码项目目录」（设置 → 工作目录），配好才能定位源码',
        matches: [],
        scanned: []
      };
    }
    // 入参守卫：只扫白名单目录（projectDir 就是用户自己配的可信根）
    const bad = assertPathIn(root);
    if (bad) return Object.assign({}, bad, { matches: [], scanned: [] });
    return projects.locateTestClass(root, testClass);
  });

  /**
   * 在系统文件管理器里选中某个文件（「定位」的最后一步）。
   *
   * 只做选中，不做「打开编辑器」：打开用什么程序是用户的默认关联，
   * 平台不替用户决定，也不装任何东西。
   */
  handle('projects:reveal', async (e, { file } = {}) => {
    assertUnlocked();
    const target = String(file || '').trim();
    if (!target) return { ok: false, code: 'NO_FILE', message: '缺少文件路径' };
    const bad = assertPathIn(target);
    if (bad) return bad;
    let isFile = false;
    try {
      isFile = fs.existsSync(target) && fs.statSync(target).isFile();
    } catch (err) {
      isFile = false;
    }
    if (!isFile) {
      return {
        ok: false,
        code: 'FILE_NOT_FOUND',
        message: '源文件不在了（项目可能被移动或改名）：' + target
      };
    }
    shell.showItemInFolder(target);
    return { ok: true, file: target };
  });
}

module.exports = { register };