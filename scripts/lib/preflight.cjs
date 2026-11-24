'use strict';
/**
 * env 档前置检查
 *
 * 为什么要有这一层：
 *   env 档的套件会直接去读「本机真实资产」——用例 md、jmx 脚本、压测报告、知识库。
 *   以前这些套件在目录不存在时要么直接崩（TypeError、ENOENT），
 *   要么静默跳过还打印全绿，两种都很误导。
 *   现在统一在这里把 4 个目录检查一遍：缺哪个就打印**能照着做**的提示，然后非零退出。
 *
 * 约定：
 *   - 4 个目录用环境变量 CASES_ROOT / JMX_ROOT / REPORT_ROOT / KB_ROOT 指定；
 *   - 不设环境变量时退回产品的默认位置（%USERPROFILE%\Documents\测试工作台）。
 *   - 本文件只做检查，不写任何东西、不启动任何程序。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 4 个真实资产目录（key 即环境变量名） */
const DIRS = [
  {
    key: 'CASES_ROOT',
    label: '用例目录',
    fallback: ['Documents', '测试工作台', 'test_cases'],
    example: 'D:\\AI_Workspace\\test_cases',
    usedBy: 'test-cases.cjs / test-main.cjs'
  },
  {
    key: 'JMX_ROOT',
    label: 'jmx 脚本目录',
    fallback: ['Documents', '测试工作台', 'jmx'],
    example: 'D:\\AI_Workspace\\jmx',
    usedBy: 'test-jmx.cjs / test-main.cjs'
  },
  {
    key: 'REPORT_ROOT',
    label: '压测报告目录',
    fallback: ['Documents', '测试工作台', 'jmx', '压测结果'],
    example: 'D:\\AI_Workspace\\jmx\\压测结果',
    usedBy: 'test-jtl.cjs / test-main.cjs'
  },
  {
    key: 'KB_ROOT',
    label: '知识库目录',
    fallback: ['Documents', '测试工作台', '知识库'],
    example: 'D:\\AI_Workspace\\知识库',
    usedBy: 'test-knowledge.cjs / test-main.cjs'
  }
];

/** 目录（不是文件）才算通过；权限不足等异常一律当不存在处理 */
function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/** 解析某个目录的生效路径：环境变量优先，否则用产品默认位置 */
function resolveRoot(d) {
  const fromEnv = String(process.env[d.key] || '').trim();
  if (fromEnv) return { root: fromEnv, from: 'env' };
  return { root: path.join(os.homedir(), ...d.fallback), from: 'default' };
}

/** 逐个检查，返回明细（供 CLI 与 run-env / run-all 复用） */
function checkDirs() {
  const rows = DIRS.map((d) => {
    const { root, from } = resolveRoot(d);
    return { key: d.key, label: d.label, usedBy: d.usedBy, example: d.example, root, from, exists: isDir(root) };
  });
  return { ok: rows.every((r) => r.exists), rows, missing: rows.filter((r) => !r.exists) };
}

/** 打印「照这个做就行」的提示；返回是否全部就绪 */
function printReport(res) {
  console.log('===== env 档前置检查：4 个真实资产目录 =====');
  for (const r of res.rows) {
    const tag = r.exists ? '[ OK ]' : '[缺失]';
    console.log(`${tag} ${r.key.padEnd(12)} ${r.root}`);
    console.log(`       ${r.label}（${r.usedBy}）${r.from === 'env' ? '，来自环境变量' : '，未设环境变量，用的是默认位置'}`);
    if (!r.exists) {
      console.log(`       → 请设置环境变量 ${r.key} 指向你的「${r.label}」，例如：`);
      console.log(`         $env:${r.key} = "${r.example}"`);
    }
  }

  if (res.ok) {
    console.log('\n4 个目录都在，env 档可以运行。');
    printJmeterHint();
    return true;
  }

  console.log(`\n缺少 ${res.missing.length} 个目录，env 档无法运行（不是测试失败，是环境没准备好）。`);
  console.log('一次性设置（PowerShell，路径按你的实际情况改）：');
  console.log(
    '  ' + DIRS.map((d) => `$env:${d.key}="${d.example}"`).join('; ')
  );
  console.log('\n提示：unit 档不依赖这些目录，`npm test` 现在就能跑。');
  return false;
}

/** 顺带提示 JMeter：没装不影响 env 档，但 test-main 里与 JMeter 相关的断言会显式跳过 */
function printJmeterHint() {
  try {
    const { detectJmeter } = require(path.join(__dirname, '..', '..', 'electron', 'shared-helpers.js'));
    const bat = detectJmeter({}, () => {});
    if (bat) {
      console.log('JMeter：' + bat);
    } else {
      console.log('提示：没探测到本机 JMeter（JMETER_HOME / PATH / 常见安装目录都没找到）。');
      console.log('      这不影响 env 档通过，但 test-main 里「启动 JMeter」相关断言会显示为 skipped。');
    }
  } catch (e) {
    /* 探测只是提示，失败不影响前置检查结论 */
  }
}

module.exports = { DIRS, checkDirs, printReport, isDir, resolveRoot };