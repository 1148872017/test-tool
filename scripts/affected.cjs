'use strict';
/**
 * affected.cjs —— 改动影响面助手（2026-11-26 用户定下的验收原则的落地工具）
 *
 * 原则（用户原话）：
 *   每次新增/修改某个模块或功能时，对改动的地方 + 可能受影响的模块做一次
 *   **冒烟 + 正向 + 反向 + 异常场景**测试，**不用每次跑全平台**。
 *
 * 这个脚本只做一件容易被忘掉的事：把「这次改了哪些文件」翻译成
 * 「先跑哪几套 + 该补哪几类场景」。它**不阻断任何流程**（不是测试套件、不进 suites.cjs），
 * 只在你敲下它的时候给建议。
 *
 * 用法：
 *   node scripts/affected.cjs              # 看未提交改动
 *   node scripts/affected.cjs HEAD~1       # 看某个提交以来的改动
 *   node scripts/affected.cjs --staged     # 只看已暂存
 *
 * 设计约束（和 selfcheck 一致）：**误报率 > 10% 就该废掉这条**。
 * 所以规则宁少勿滥：认不出的文件走「兜底：跑 jsx-text + gui-smoke + npm test」，
 * 而不是硬套一个看起来相关的套件。
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * 影响面规则表。
 *
 * 每条：{ match: 正则（相对仓库根、正斜杠）, suites: [套件文件], why: 一句话 }
 * 顺序无所谓，所有命中的都会合并。
 */
const RULES = [
  // ---- 数据层：动 store/security/migrations 基本等于动全平台的数据安全 ----
  {
    match: /^electron\/(store|security|migrations)\.js$/,
    suites: ['test-data-safety', 'test-migrate', 'test-accounts', 'test-main', 'test-recycle', 'test-security'],
    why: '数据层（加解密 / 迁移 / 备份恢复）'
  },
  {
    match: /^electron\/(jmx-writeback|jmx)\.js$/,
    suites: ['test-jmx-writeback', 'test-jmx-detail'],
    why: 'jmx 解析与写回'
  },
  {
    match: /^electron\/(allure|jtl|openapi|cases|knowledge|notes)\.js$/,
    suites: ['test-allure', 'test-allure-steps', 'test-jtl', 'test-openapi', 'test-cases', 'test-knowledge', 'test-notes', 'test-links'],
    why: '只读解析器（解析错了会污染索引）'
  },
  {
    match: /^electron\/(codescan|scan-rules)\.js$/,
    suites: ['test-codescan', 'test-rules', 'test-scan-scope'],
    why: '代码体检规则'
  },
  {
    match: /^electron\/(sniffer|ipc\/ipc-sniff)/,
    suites: ['test-sniff-highlight', 'test-sniff-browser'],
    why: '实时校验（含真浏览器链路）'
  },
  // ---- IPC：任何域改动都要确认通道唯一性与路径守卫 ----
  {
    match: /^electron\/ipc\//,
    suites: ['test-ipc-unique', 'test-guard-paths', 'test-security', 'test-main'],
    why: 'IPC 通道（唯一性 / 解锁守卫 / 路径白名单）'
  },
  {
    match: /^electron\/(ipc-guard|shared-helpers|nav-guard)\.js$/,
    suites: ['test-ipc-unique', 'test-guard-paths', 'test-security', 'test-startup'],
    why: '守卫层（一改就是安全边界）'
  },
  {
    match: /^electron\/preload\.js$/,
    suites: ['test-ipc-unique', 'test-mock-coverage', 'test-jsx-text'],
    why: 'preload 方法表（要和 mockApi 对齐）'
  },
  // ---- 前端 ----
  {
    match: /^src\/components\/(PageElementsEditor|SniffPanel|OptionEditor)\.tsx$/,
    suites: ['test-elements', 'test-locator-mode', 'test-detail-placeholder', 'test-module-field'],
    why: '页面元素编辑器 / 校验面板 / 选项编辑器'
  },
  {
    match: /^src\/components\/(RecordDetail|RecordForm)\.tsx$/,
    suites: ['test-detail-placeholder', 'test-elements', 'test-jsx-text'],
    why: '记录详情与表单'
  },
  {
    match: /^src\/components\/(CodeBlock)\.tsx$|^shared\/codeHighlight\.js$/,
    suites: ['test-code-highlight'],
    why: '代码块高亮器'
  },
  {
    match: /^src\/(mockApi\.ts|api\.ts)$/,
    suites: ['test-mock-coverage', 'test-jsx-text'],
    why: '预览 mock（漏一个通道就点不动）'
  },
  {
    match: /^src\/pages\//,
    suites: ['test-jsx-text', 'test-gui-smoke'],
    why: '页面级改动（含路由与首屏）'
  },
  {
    match: /^src\/styles\.css$/,
    suites: ['test-gui-smoke', 'test-theme', 'test-skin'],
    why: '全局样式（易误伤其它页面）'
  },
  // ---- 共享层：前后端都吃，改动最容易外溢 ----
  {
    match: /^shared\//,
    suites: ['test-main', 'test-codegen', 'test-templates', 'test-scriptgen', 'test-ui-bricks', 'test-api-bricks'],
    why: 'shared/（前后端共用，改动面最大）'
  },
  // ---- 打包 / 版本 ----
  {
    match: /^(package\.json|scripts\/build\.mjs|build\/)/,
    suites: ['test-bundle', 'test-installer'],
    why: '打包配置（asar 内容 / 安装包）'
  },
  // ---- 文档 / 工具脚本：不影响行为，但也别让它们算「未识别」 ----
  {
    match: /^(README\.md|docs\/)/,
    suites: [],
    why: '文档（不影响行为，扫一眼有没有把旧数字写进去）'
  },
  {
    match: /^scripts\/(?!(test-|lib\/suites\.cjs))/,
    suites: [],
    why: '工具脚本（node --check 一下，确认它在 selfcheck 覆盖范围内）'
  },
  // ---- 测试自身 ----
  {
    match: /^scripts\/(lib\/suites\.cjs|test-)/,
    suites: [],
    why: '测试基建（改完直接 selfcheck + 跑你那套）'
  }
];

/**
 * 按改动类型给「四类场景」的提示。
 * 这些是**提示**，不是清单：真实场景比这细。
 */
const SCENARIO_HINTS = {
  数据层: [
    '冒烟：正常增删改查一条记录，重启后还在',
    '正向：导出 → 清空 → 导入，条数与字段一致',
    '反向：解密失败 / 坏 JSON / 未知字段仍能读，不覆盖原值',
    '异常：磁盘只读、文件被占用、库被改名 → 明确报错且不损坏原库'
  ],
  IPC: [
    '冒烟：解锁后每个改动过的通道点一次，界面有反应',
    '正向：合法入参返回 ok 且数据正确',
    '反向：锁定态调用被拒（LOCKED）；越界路径被拒（OUTSIDE_ROOT）',
    '异常：通道重名 / 入参缺字段 / 前端 mock 漏实现 → 启动即红，不静默'
  ],
  前端: [
    '冒烟：页面能打开、控制台 0 error、关键按钮可点',
    '正向：填合法值 → 保存 → 重开详情仍在',
    '反向：必填留空 / 超长 / 特殊字符 → 有提示且不写脏数据',
    '异常：断网/慢响应、后端起不来、单条脏数据 → 页面不白屏（错误边界兜住）'
  ],
  浏览器会话: [
    '冒烟：点一次校验 → 只弹 1 个窗口且元素被框住',
    '正向：连点 3 次仍是 1 个窗口；换浏览器（Edge/Chrome）都能起',
    '反向：非法地址 / 非法浏览器名 → 明确拒绝且不起进程',
    '异常：上次进程残留、浏览器被手动关掉、调试端口被占 → 自动恢复或明确报错，不留尸'
  ],
  样式: [
    '冒烟：5 套主题各切一次，主按钮/选中态/表格仍可读',
    '正向：新样式只在目标组件生效',
    '反向：窄窗口（1080）下不换行错位、不遮住操作',
    '异常：长文本/空数据/超长标题不撑破布局'
  ]
};

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function changedFiles(ref) {
  try {
    if (ref === '--staged') return sh('git diff --cached --name-only').split(/\r?\n/).filter(Boolean);
    if (ref) return sh('git diff --name-only ' + ref + '...HEAD').split(/\r?\n/).filter(Boolean);
    // 默认：未提交改动（含未跟踪）
    const a = sh('git diff --name-only').split(/\r?\n/).filter(Boolean);
    const b = sh('git ls-files --others --exclude-standard').split(/\r?\n/).filter(Boolean);
    return Array.from(new Set(a.concat(b)));
  } catch (e) {
    return [];
  }
}

function classify(files) {
  const picked = new Map(); // suite -> why[]
  const kinds = new Set();
  let unmatched = 0;

  for (const f of files) {
    const rel = f.split(path.sep).join('/');
    let hit = false;
    for (const r of RULES) {
      if (!r.match.test(rel)) continue;
      hit = true;
      for (const s of r.suites) {
        if (!picked.has(s)) picked.set(s, []);
        if (picked.get(s).indexOf(r.why) < 0) picked.get(s).push(r.why);
      }
      if (/数据层/.test(r.why)) kinds.add('数据层');
      if (/IPC|守卫|preload/.test(r.why)) kinds.add('IPC');
      if (/sniffer|实时校验|浏览器/.test(r.why)) kinds.add('浏览器会话');
      if (/页面|组件|编辑器|详情|mock|样式|代码块/.test(r.why)) kinds.add('前端');
      if (/样式/.test(r.why)) kinds.add('样式');
    }
    if (!hit) unmatched += 1;
  }
  return { picked, kinds, unmatched };
}

const ref = process.argv[2];
const files = changedFiles(ref);

if (!files.length) {
  console.log('没有改动（或参数指定的范围内没有改动）。');
  process.exit(0);
}

const { picked, kinds, unmatched } = classify(files);

console.log('改动文件：' + files.length + ' 个');
for (const f of files.slice(0, 20)) console.log('  - ' + f);
if (files.length > 20) console.log('  ...（还有 ' + (files.length - 20) + ' 个）');

console.log('');
if (picked.size) {
  console.log('先跑这几套（按影响面挑的，不用全平台）：');
  for (const [suite, whys] of picked) {
    console.log('  node scripts/' + suite + '.cjs    ← ' + whys.join('；'));
  }
} else {
  console.log('没匹配到具体套件。');
}

if (unmatched) {
  console.log('');
  console.log('有 ' + unmatched + ' 个文件不在影响面表里（可能是新模块）：');
  console.log('  → 先跑 npm test 兜底，并考虑把它补进 scripts/affected.cjs 的 RULES');
}

console.log('');
console.log('四类场景（按改动类型，别只跑正向）：');
const order = Array.from(kinds);
if (!order.length) order.push('前端');
for (const k of order) {
  const hints = SCENARIO_HINTS[k] || [];
  if (!hints.length) continue;
  console.log('【' + k + '】');
  for (const h of hints) console.log('  - ' + h);
}

if (files.some((f) => /^(shared|electron)\//.test(f.split(path.sep).join('/')))) {
  console.log('');
  console.log('注意：改到了 shared/ 或 electron/ —— 这两处会外溢到很多页面，');
  console.log('      建议最后补一次 npm test（含自检）再收工。');
}
