'use strict';
/**
 * 「页面元素 → 代码生成」的联动对齐（v0.72）。
 *
 * ============================================================
 * 为什么要有这一套
 * ============================================================
 * 页面元素模块在 v0.66~v0.71 连改了 6 版（过滤后缀 / raw 原生表达式 /
 * 跨行解析 / 扩展伪类 / 详情页复制）。每一次都只改了「录入」和「实时校验」，
 * **没人回头看「生成」那边跟没跟上」** —— 这次顺着 OpenAPI 的活顺带查了一遍，
 * 挖出两个真问题：
 *
 *   1. **raw 模式下漏 import**：`hasRole` 只按 `mode === 'role'` 判断，
 *      但 raw 的代码里也可能写 `AriaRole.BUTTON` / `PlaywrightAssertions.assertThat(...)`，
 *      结果生成的 .java 里少了那条 import → 编译不过。
 *      （同一处 bug 在 shared/codegen.js 的 POM 和 shared/uiStepGen.js 的积木里各有一份）
 *
 *   2. **raw 静默跨语言**：raw 存的是整段代码（通常从 codegen 抄的 Java 写法），
 *      切到 Python 时被原样输出 —— 生成的 .py 里赫然是
 *      `page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions()...)`。
 *      语法就错的代码比报错更糟（报错至少让人停下来）。
 *
 * 这一套守：**生成器对元素新能力的处理**（import 补齐 + 跨语言警告），
 * 而不是「某个字符串长什么样」。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const codegen = require(path.join(ROOT, 'shared', 'codegen.js'));
const uiGen = require(path.join(ROOT, 'shared', 'uiStepGen.js'));

const RAW_JAVA = 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("x"))';

/** 从生成的 Java 里取 import 行 */
const importsOf = (code) =>
  String(code || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.indexOf('import ') === 0);

/* ============================================================
 * 一、POM 生成：raw 用到的类要补 import
 * ============================================================ */

{
  const gen = (elements) => codegen.generate('playwright-java', { page: { name: '测试页', elements } });
  const withRaw = (selector) => gen([{ name: 'el', mode: 'raw', selector }]);

  // AriaRole
  const r1 = withRaw(RAW_JAVA);
  check(
    'POM：raw 用了 AriaRole → 补 options.AriaRole import',
    importsOf(r1.code).some((l) => l.indexOf('com.microsoft.playwright.options.AriaRole') >= 0),
    importsOf(r1.code)
  );

  // PlaywrightAssertions
  const r2 = withRaw('PlaywrightAssertions.assertThat(page.locator("#x")).isVisible()');
  check(
    'POM：raw 用了 PlaywrightAssertions → 补 assertions.PlaywrightAssertions import',
    importsOf(r2.code).some((l) => l.indexOf('com.microsoft.playwright.assertions.PlaywrightAssertions') >= 0),
    importsOf(r2.code)
  );

  // 不回退：role 模式仍然补
  const r3 = gen([{ name: 'btn', mode: 'role', selector: 'button:登录' }]);
  check(
    'POM：role 模式仍然补 AriaRole import（不回退）',
    importsOf(r3.code).some((l) => l.indexOf('options.AriaRole') >= 0),
    importsOf(r3.code)
  );

  // 不多补：纯 css 不该出现 AriaRole
  const r4 = gen([{ name: 'a', mode: 'css', selector: '#a' }]);
  check(
    'POM：纯 css 元素不 import AriaRole（不产生没用的 import）',
    !importsOf(r4.code).some((l) => l.indexOf('AriaRole') >= 0),
    importsOf(r4.code)
  );

  // 词边界：BrowserContext 不该顺带 import Browser
  const r5 = withRaw('page.context().newPage()');
  const imp5 = importsOf(r5.code);
  check(
    'POM：import 扫描有词边界（BrowserContext 不会顺带 import Browser）',
    !(imp5.some((l) => /\.Browser;/.test(l)) && !imp5.some((l) => /\.BrowserContext;/.test(l))),
    imp5
  );
}

/* ============================================================
 * 二、POM 生成：raw 跨语言要警告
 * ============================================================ */

{
  const page = {
    name: '测试页',
    elements: [
      { name: 'ok', mode: 'css', selector: '#a' },
      { name: 'rawEl', mode: 'raw', selector: RAW_JAVA }
    ]
  };

  const java = codegen.generate('playwright-java', { page });
  check('POM：Java 目标下 raw 不报警（Java 写法对 Java 是对的）', (java.warnings || []).length === 0, java.warnings);

  const py = codegen.generate('playwright-python', { page });
  check('POM：Python 目标下 raw 报警（原样输出会语法错）', (py.warnings || []).length >= 1, py.warnings);
  check(
    'POM：警告文案说清「原样输出」',
    (py.warnings || []).some((w) => w.indexOf('原样输出') >= 0),
    py.warnings
  );
  check(
    'POM：Python 产物文件头有醒目提醒（不只是界面弹一下）',
    String(py.code || '').indexOf('⚠️') >= 0 && String(py.code || '').indexOf('原生表达式') >= 0,
    String(py.code || '').slice(0, 300)
  );

  // 没有 raw 的页面不该出警告
  const clean = codegen.generate('playwright-python', {
    page: { name: '干净页', elements: [{ name: 'a', mode: 'css', selector: '#a' }] }
  });
  check('POM：没有 raw 的页面在 Python 下不报警', (clean.warnings || []).length === 0, clean.warnings);
}

/* ============================================================
 * 三、积木生成：同一处 bug 的两份实现都要修
 * ============================================================ */

{
  const step = (mode, selector, lang) =>
    uiGen.generateSteps({
      lang,
      pomMode: 'none',
      steps: [{ actionId: 'click', params: { el: 'el' }, elementMode: mode, elementSelector: selector }]
    });

  const javaRaw = step('raw', RAW_JAVA, 'java');
  check(
    '积木：raw 用了 AriaRole → import 补上（以前只按 mode 判断，会漏）',
    (javaRaw.imports || []).some((i) => i.indexOf('options.AriaRole') >= 0),
    javaRaw.imports
  );

  const pyRaw = step('raw', RAW_JAVA, 'python');
  check(
    '积木：Python 目标下 raw 报警',
    (pyRaw.warnings || []).some((w) => w.indexOf('原生表达式') >= 0),
    pyRaw.warnings
  );

  const javaRole = step('role', 'button:登录', 'java');
  check(
    '积木：role 元素仍然 import AriaRole（不回退）',
    (javaRole.imports || []).some((i) => i.indexOf('options.AriaRole') >= 0),
    javaRole.imports
  );

  const javaCss = step('css', '#btn', 'java');
  check(
    '积木：css 元素不 import AriaRole（不产生没用的 import）',
    !(javaCss.imports || []).some((i) => i.indexOf('AriaRole') >= 0),
    javaCss.imports
  );
}

/* ============================================================
 * 四、元素定位能力的「三处一致」（生成 / 预览 / POM 同一个函数）
 * ============================================================ */

{
  /**
   * 这是本套件最该守的一条：**定位代码只有一个来源**。
   * 只要三处都走 previewLocatorCode，就不会出现「预览是一个样、生成是另一个样」。
   */
  const lm = require(path.join(ROOT, 'shared', 'locatorModes.js'));
  const page = {
    name: '一致性页',
    elements: [
      { name: 'a', mode: 'css', selector: '.studyList a|has-text=面向对象' },
      { name: 'b', mode: 'role', selector: 'button:登录|exact' },
      { name: 'c', mode: 'css', selector: '.row|nth=1' }
    ]
  };
  const pom = String(codegen.generate('playwright-java', { page }).code || '');

  for (const el of page.elements) {
    const expected = lm.previewLocatorCode(el.mode, el.selector, 'java');
    check('POM 里的定位语句与 previewLocatorCode 逐字一致：' + el.name, pom.indexOf(expected) >= 0, {
      expected,
      tail: pom.slice(0, 200)
    });
  }
}

/* ============================================================
 * 说话
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log('  FAIL  ' + r.name + '  -> ' + r.extra);
console.log('');
console.log((results.length - failed.length) + '/' + results.length + ' passed' + (failed.length ? '，' + failed.length + ' 项失败' : ''));
process.exit(failed.length ? 1 : 0);
