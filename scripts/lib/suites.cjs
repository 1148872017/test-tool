'use strict';
/**
 * 测试套件分档表（唯一事实源）
 *
 * 分档依据：
 *   unit —— 只读仓库内的源码 / shared 模块，或者在 os.tmpdir() 里造临时目录；
 *           不碰任何「本机真实资产」，换一台干净机器也能直接跑。
 *   env  —— 会 readFileSync / scan 真实路径：
 *           %USERPROFILE%\Documents\测试工作台\{test_cases,jmx,知识库}
 *           或 D:\AI_Workspace\{test_cases,jmx,知识库} 这类只有作者机器才有的目录。
 *           必须先过 test-preflight.cjs（4 个环境变量），否则一上来就崩。
 *
 * 新增 / 改名 scripts/test-*.cjs 时**必须**登记进这里：
 * runner 会校验「磁盘上有、表里没有」并直接报错，
 * 避免再出现「新写的套件根本没被 npm test 跑到，却以为全绿」。
 */
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.resolve(__dirname, '..');

/**
 * 不是「业务测试套件」的脚本，不参与登记与校验：
 *   test-preflight.cjs      —— 环境变量前置检查（跑 env 档前用）
 *   test-selfcheck.cjs      —— 自检工具本身的自测（跑 npm run check:selftest）
 *
 * 为什么自测不放 unit 档：它每次 spawn 70+ 次 node --check + 1 次 tsc，
 * 单跑要 70 秒。工具不常改，没必要每次 npm test 都跑。
 */
const NOT_A_SUITE = ['test-preflight.cjs', 'test-selfcheck.cjs'];

/** unit 档：纯函数 + 临时目录，任何机器都能跑（npm test 只跑这一档） */
const unit = [
  'test-accounts.cjs',
  'test-api-bricks.cjs',
  'test-allure-steps.cjs',
  'test-allure.cjs',
  'test-brand.cjs',
  'test-bricks-save.cjs',
  'test-bundle.cjs',
  'test-code-highlight.cjs',
  'test-codegen.cjs',
  'test-codelab.cjs',
  'test-codescan.cjs',
  'test-curl.cjs',
  'test-data-safety.cjs',
  'test-debounce.cjs',
  'test-demo.cjs',
  'test-detail-placeholder.cjs',
  'test-elements.cjs',
  'test-faker.cjs',
  'test-fields-templates.cjs',
  'test-fixes-361.cjs',
  'test-gaps.cjs',
  'test-gaps2.cjs',
  'test-generated-syntax.cjs',
  'test-groovy-templates.cjs',
  'test-guard-paths.cjs',
  'test-gui-smoke.cjs',
  'test-installer.cjs',
  'test-io-tooltip.cjs',
  'test-ipc-unique.cjs',
  'test-json-table.cjs',
  'test-jsx-text.cjs',
  'test-jmx-detail.cjs',
  'test-jmx-writeback.cjs',
  'test-linebuffer.cjs',
  'test-links.cjs',
  'test-locator-mode.cjs',
  'test-locator-refine.cjs',
  'test-snippet-multiline.cjs',
  'test-sniff-refine.cjs',
  'test-main.cjs',
  'test-metrics.cjs',
  'test-migrate.cjs',
  'test-mock-coverage.cjs',
  'test-module-field.cjs',
  'test-notes.cjs',
  'test-openapi.cjs',
  'test-pin-workspace.cjs',
  'test-recycle.cjs',
  'test-report-archive.cjs',
  'test-rules.cjs',
  'test-runner.cjs',
  'test-scan-scope.cjs',
  'test-scriptgen.cjs',
  'test-security.cjs',
  'test-skin.cjs',
  'test-sniff-browser.cjs',
  'test-sniff-highlight.cjs',
  'test-startup.cjs',
  'test-templates.cjs',
  'test-theme.cjs',
  'test-ui-bricks.cjs',
  'test-updater.cjs',
  'test-v41.cjs',
  'test-vars.cjs'
];

/** env 档：依赖本机真实资产，必须先过前置检查（npm run test:env） */
const env = ['test-jmx.cjs', 'test-jtl.cjs', 'test-knowledge.cjs', 'test-cases.cjs'];

/** 全量清单（先 unit 再 env） */
const all = unit.concat(env);

/**
 * 表与磁盘对账。
 * @returns {{missingOnDisk: string[], unclassified: string[], duplicated: string[]}}
 *   missingOnDisk —— 表里登记了但磁盘上没有（改名/删文件后忘了改表）
 *   unclassified  —— 磁盘上有 test-*.cjs 但表里没有登记（永远跑不到）
 *   duplicated    —— 同一个文件被登记了多次（会被跑两遍）
 */
function validate(dir) {
  const scriptsDir = dir || SCRIPTS_DIR;
  const onDisk = fs
    .readdirSync(scriptsDir)
    .filter((f) => /^test-.*\.cjs$/.test(f) && NOT_A_SUITE.indexOf(f) < 0)
    .sort();

  const seen = Object.create(null);
  const duplicated = [];
  for (const f of all) {
    seen[f] = (seen[f] || 0) + 1;
  }
  for (const f of Object.keys(seen)) {
    if (seen[f] > 1) duplicated.push(f);
  }

  const onDiskSet = new Set(onDisk);
  const listedSet = new Set(all);
  return {
    missingOnDisk: all.filter((f) => !onDiskSet.has(f)),
    unclassified: onDisk.filter((f) => !listedSet.has(f)),
    duplicated
  };
}

module.exports = { unit, env, all, validate, SCRIPTS_DIR, NOT_A_SUITE };