/* 代码调试（超时 + 运行环境 + Java 两步）+ 导入模板下载 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const codelab = require('../shared/codelab.js');
const importTemplate = require('../shared/importTemplate.js');
const { COLLECTIONS, COLLECTION_MAP } = require('../shared/collections.js');

/* ============================================================
 * 1. clampTimeout：前端传什么都别信
 * ============================================================ */
const CLAMP_CASES = [
  { input: 0, want: 15000, name: '0 当作没传 → 15000' },
  { input: -1, want: 15000, name: '-1 非法 → 15000' },
  { input: 500, want: 1000, name: '500 抬到下限 1000' },
  { input: 1000, want: 1000, name: '1000 正好是下限' },
  { input: 15000, want: 15000, name: '15000 默认值不变' },
  { input: 60000, want: 60000, name: '60000 正好是上限' },
  { input: 99999, want: 60000, name: '99999 压到上限 60000' },
  { input: 'abc', want: 15000, name: '"abc" 不是数字 → 15000' },
  { input: undefined, want: 15000, name: 'undefined → 15000' }
];
for (const c of CLAMP_CASES) {
  check('clampTimeout ' + c.name, codelab.clampTimeout(c.input) === c.want, codelab.clampTimeout(c.input));
}
check('clampTimeout 常量对得上', codelab.DEFAULT_TIMEOUT_MS === 15000 && codelab.MAX_TIMEOUT_MS === 60000 && codelab.MIN_TIMEOUT_MS === 1000, {
  d: codelab.DEFAULT_TIMEOUT_MS,
  max: codelab.MAX_TIMEOUT_MS,
  min: codelab.MIN_TIMEOUT_MS
});

/* ============================================================
 * 2. buildTaskkillArgs：Windows 必须杀整棵树
 * ============================================================ */
check(
  'buildTaskkillArgs(1234) = [/PID,1234,/T,/F]',
  JSON.stringify(codelab.buildTaskkillArgs(1234)) === JSON.stringify(['/PID', '1234', '/T', '/F']),
  codelab.buildTaskkillArgs(1234)
);
check('buildTaskkillArgs 接受字符串 pid', JSON.stringify(codelab.buildTaskkillArgs('5678')) === JSON.stringify(['/PID', '5678', '/T', '/F']), codelab.buildTaskkillArgs('5678'));
check('buildTaskkillArgs 非法 pid 返回空数组', codelab.buildTaskkillArgs(0).length === 0 && codelab.buildTaskkillArgs('abc').length === 0, codelab.buildTaskkillArgs('abc'));

/* ============================================================
 * 3. javaClassName：文件名必须等于 public class 名
 * ============================================================ */
check('javaClassName 认 public class Foo', codelab.javaClassName('public class Foo {\n}') === 'Foo', codelab.javaClassName('public class Foo {}'));
check('javaClassName 认非 public 的 class Bar', codelab.javaClassName('class Bar {}') === 'Bar', codelab.javaClassName('class Bar {}'));
check('javaClassName 没有 class → Main', codelab.javaClassName('int x = 1;\nSystem.out.println(x);') === 'Main', codelab.javaClassName('int x = 1;'));
check('javaClassName 认 public final class', codelab.javaClassName('public final class Baz {}') === 'Baz', codelab.javaClassName('public final class Baz {}'));
check(
  'javaClassName 不被行注释骗',
  codelab.javaClassName('// public class Fake {}\npublic class Real {}') === 'Real',
  codelab.javaClassName('// public class Fake {}\npublic class Real {}')
);
check(
  'javaClassName 不被块注释骗',
  codelab.javaClassName('/* class Fake {} */\npublic class Real {}') === 'Real',
  codelab.javaClassName('/* class Fake {} */\npublic class Real {}')
);
check(
  'javaClassName 不被字符串字面量骗',
  codelab.javaClassName('public class Real {\n  String s = "public class Fake {}";\n}') === 'Real',
  codelab.javaClassName('public class Real { String s = "public class Fake {}"; }')
);

/* ============================================================
 * 4. buildRunPlan：三种语言 + 缺运行时的中文错误
 * ============================================================ */
const RT_OK = {
  node: { ok: true, path: 'C:/node/node.exe', viaElectron: false },
  python: { ok: true, path: 'D:/python/python.exe' },
  java: { ok: true, java: 'D:/jdk/bin/java.exe', javac: 'D:/jdk/bin/javac.exe' }
};

const jsPlan = codelab.buildRunPlan({ lang: 'javascript', code: 'console.log(1)', dir: 'D:/tmp/x', runtime: RT_OK });
check('js 计划写到 main.js', jsPlan.files.length === 1 && jsPlan.files[0].name === 'main.js', jsPlan.files.map((f) => f.name));
check('js 计划一步跑 node', jsPlan.steps.length === 1 && jsPlan.steps[0].cmd === RT_OK.node.path, jsPlan.steps);
check('js 计划带 cwd', jsPlan.steps[0].cwd === 'D:/tmp/x', jsPlan.steps[0].cwd);

let jsErr = '';
try {
  codelab.buildRunPlan({ lang: 'javascript', code: 'x', runtime: { node: { ok: false, path: '' } } });
} catch (e) {
  jsErr = e.message;
}
check('缺 Node 抛中文错误', /Node/.test(jsErr), jsErr);
check('用内置 Node 时挂 ELECTRON_RUN_AS_NODE', (() => {
  const p = codelab.buildRunPlan({ lang: 'javascript', code: 'x', runtime: { node: { ok: true, path: 'app.exe', viaElectron: true } } });
  return p.steps[0].env && p.steps[0].env.ELECTRON_RUN_AS_NODE === '1';
})(), 'no env');

const pyPlan = codelab.buildRunPlan({ lang: 'python', code: 'print(1)', dir: 'D:/tmp/y', runtime: RT_OK });
check('python 计划写到 main.py', pyPlan.files[0].name === 'main.py', pyPlan.files[0].name);
check('python 用 -u 关缓冲', pyPlan.steps[0].args.indexOf('-u') >= 0, pyPlan.steps[0].args);

let pyErr = '';
try {
  codelab.buildRunPlan({ lang: 'python', code: 'x', runtime: { python: { ok: false, path: '' } } });
} catch (e) {
  pyErr = e.message;
}
check('缺 Python 抛「请安装或在设置里指定」', /Python/.test(pyErr) && /设置/.test(pyErr), pyErr);

const javaPlan = codelab.buildRunPlan({
  lang: 'java',
  code: 'public class Hello {\n  public static void main(String[] a) {}\n}',
  dir: 'D:/tmp/z',
  runtime: RT_OK
});
check('java 文件名跟着类名走', javaPlan.files[0].name === 'Hello.java', javaPlan.files[0].name);
check('java 是两步（javac + java）', javaPlan.steps.length === 2, javaPlan.steps.length);
check('java 第一步是 javac', javaPlan.steps[0].cmd === RT_OK.java.javac && javaPlan.steps[0].args[0] === 'Hello.java', javaPlan.steps[0]);
check(
  'java 第二步是 java -cp . Hello',
  javaPlan.steps[1].cmd === RT_OK.java.java &&
    JSON.stringify(javaPlan.steps[1].args) === JSON.stringify(['-cp', '.', 'Hello']),
  javaPlan.steps[1]
);

let javacErr = '';
try {
  codelab.buildRunPlan({ lang: 'java', code: 'class X {}', runtime: { java: { java: 'java.exe', javac: '' } } });
} catch (e) {
  javacErr = e.message;
}
check('只有 JRE 时提示需要 JDK', /JDK/.test(javacErr) && /JRE/.test(javacErr), javacErr);

let langErr = '';
try {
  codelab.buildRunPlan({ lang: 'ruby', code: 'puts 1' });
} catch (e) {
  langErr = e.message;
}
check('不认识的语言有中文错误', /不支持的语言/.test(langErr), langErr);

/* ============================================================
 * 5. splitSteps：编译和运行必须分开，编译失败不继续
 * ============================================================ */
const splitJava = codelab.splitSteps(javaPlan);
check('java 编译步骤只有 1 个', splitJava.compile.length === 1 && splitJava.compile[0].cmd === RT_OK.java.javac, splitJava.compile);
check('java 运行步骤只有 1 个', splitJava.run.length === 1 && splitJava.run[0].cmd === RT_OK.java.java, splitJava.run);

const splitJs = codelab.splitSteps(jsPlan);
check('单步语言 compile 为空', splitJs.compile.length === 0, splitJs.compile);
check('单步语言 run 就是那一步', splitJs.run.length === 1 && splitJs.run[0].cmd === RT_OK.node.path, splitJs.run);
check('空计划 split 不炸', JSON.stringify(codelab.splitSteps({ steps: [] })) === JSON.stringify({ compile: [], run: [] }), codelab.splitSteps({}));

/* 输出面板回显：只留命令名，不显示安装路径和 .exe */
check(
  'stepCommandLine 去掉目录和 .exe',
  codelab.stepCommandLine({ cmd: 'D:\\Java\\jdk-17\\bin\\javac.exe', args: ['Main.java'] }) === 'javac Main.java',
  codelab.stepCommandLine({ cmd: 'D:\\Java\\jdk-17\\bin\\javac.exe', args: ['Main.java'] })
);

/* ============================================================
 * 6. buildTemplate：每个集合都能生成「字段齐全、能直接导入」的 JSON
 * ============================================================ */
check('模板模块导出 buildTemplate', typeof importTemplate.buildTemplate === 'function', typeof importTemplate.buildTemplate);

for (const conf of COLLECTIONS) {
  let obj = null;
  let err = '';
  try {
    obj = JSON.parse(importTemplate.buildTemplate(conf));
  } catch (e) {
    err = e.message;
  }
  check('「' + conf.name + '」模板是合法 JSON', !!obj, err);
  if (!obj) continue;

  const rec = obj.records && obj.records[0];
  check('「' + conf.name + '」外层结构 = 导出格式', obj.version === 2 && obj.includeSecrets === false && Array.isArray(obj.records), Object.keys(obj));
  check('「' + conf.name + '」记录 collection 对得上', rec && rec.collection === conf.key, rec && rec.collection);

  const wantKeys = conf.fields.filter((f) => importTemplate.VIRTUAL_FIELD_TYPES.indexOf(f.type) < 0).map((f) => f.key).sort();
  const gotKeys = Object.keys((rec && rec.data) || {}).sort();
  check(
    '「' + conf.name + '」字段和 COLLECTIONS 对得上',
    JSON.stringify(gotKeys) === JSON.stringify(wantKeys),
    { got: gotKeys, want: wantKeys }
  );

  const requiredEmpty = conf.fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = rec.data[f.key];
      return !(Array.isArray(v) ? v.length : String(v === undefined || v === null ? '' : v).trim());
    })
    .map((f) => f.key);
  check('「' + conf.name + '」必填字段都有示例值', requiredEmpty.length === 0, requiredEmpty);

  // 标题字段必须有值（列表页靠它显示，导进去空白会变成「(未命名)」）
  check('「' + conf.name + '」标题字段有值', !!String(rec.data[conf.titleField] || '').trim(), rec.data[conf.titleField]);
}

check('未知集合生成模板会报错', (() => {
  try {
    importTemplate.buildTemplate('not-a-collection');
    return false;
  } catch (e) {
    return /不认识的集合/.test(e.message);
  }
})());
check('模板文件名带集合名', /导入模板-网站管理\.json$/.test(importTemplate.templateFileName(COLLECTION_MAP.sites)), importTemplate.templateFileName(COLLECTION_MAP.sites));

/* ============================================================
 * 7. 后端接线：通道 / 钳制 / taskkill 真被用上
 * ============================================================ */
const electronSrc = require('./_electron-src.cjs').readElectronSource();
check('有 runner:detect 通道', /ipcMain\.handle\('runner:detect'/.test(electronSrc), 'no runner:detect');
check('有 data:importTemplate 通道', /ipcMain\.handle\('data:importTemplate'/.test(electronSrc), 'no data:importTemplate');
check('runner:run 里钳制超时', /clampTimeout\(payload\.timeout\)/.test(electronSrc), 'not clamped');
check('runner:detect 把 java 和 javac 分开报', /javac: javacExe/.test(electronSrc), 'javac not separate');
check('删掉旧的 child.kill 超时逻辑', !/spawn\('taskkill', \['\/pid'/.test(electronSrc), 'old lowercase taskkill left');

const runnerSrc = fs.readFileSync(path.join(ROOT, 'electron', 'runner.js'), 'utf8');
check('runner.js 用 buildTaskkillArgs 杀树', /buildTaskkillArgs\(proc\.pid\)/.test(runnerSrc) && /killTree/.test(runnerSrc), 'no tree kill');
check('runner.js 取消也杀树', /killTree\(hit\.proc\)/.test(runnerSrc), 'cancel not killing tree');

/* ============================================================
 * 8. 前端接线：超时下拉 + 环境状态 + 模板按钮
 * ============================================================ */
const pageSrc = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'CodeRunnerPage.tsx'), 'utf8');
check('调试页引用 shared/codelab', /from '\.\.\/\.\.\/shared\/codelab'/.test(pageSrc), 'not imported');
check('调试页有超时下拉', /timeoutPreset/.test(pageSrc), 'no timeout select');
check('超时预设含 5/10/15/30/60 秒', ['5 秒', '10 秒', '15 秒', '30 秒', '60 秒'].every((s) => pageSrc.indexOf(s) >= 0), 'missing preset');
check('有自定义秒数输入', /自定义/.test(pageSrc) && /InputNumber/.test(pageSrc), 'no custom input');
check('调 runner:detect 拿环境', /runnerDetect/.test(pageSrc), 'no detect call');
check('有运行环境状态条', /env-strip/.test(pageSrc), 'no env strip');
check('缺 javac 时提示需要 JDK', /需要 JDK 不是 JRE/.test(pageSrc), 'no jdk hint');
check('运行 payload 带 timeout', /timeout: timeoutMs/.test(pageSrc), 'no timeout in payload');
check('超时提示写明秒数', /执行超过/.test(pageSrc), 'no timeout message');

const collSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'CollectionPage.tsx'), 'utf8');
check('集合页有下载模板按钮', /下载模板\s*<\/Button>/.test(collSrc), 'no template button');
check('集合页调 importTemplate', /api\.importTemplate\(conf\.key\)/.test(collSrc), 'not wired');
check('模板入口排在导入备份后面（挨着放）', (() => {
  const tpl = /下载模板\s*<\/Button>/.exec(collSrc);
  const imp = collSrc.indexOf('导入备份');
  return !!tpl && imp >= 0 && tpl.index > imp;
})(), { importAt: collSrc.indexOf('导入备份') });
check('模板按钮有 hover 说明', /导入模板/.test(collSrc), 'no tooltip text');

const failed = results.filter((r) => !r.ok);
console.log('===== 代码调试 + 导入模板测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);