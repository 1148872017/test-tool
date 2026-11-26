'use strict';
/**
 * 积木步骤 → 测试方法体（Java / Python）。
 *
 * ============================================================
 * 为什么和 shared/codegen.js 分开
 * ============================================================
 * codegen.js 顶部 require('ejs')，渲染进程（src/**）一 import 就把 ejs / fs 打进浏览器包。
 * 这个生成器只做字符串拼装，依赖只有零依赖的 locatorModes.js + 纯数据的 uiActions.js，
 * 所以 CodegenPage 能直接调用 —— 预览、测试、真实生成用的是同一份逻辑，不会各写一遍。
 *
 * 元素定位复用 v0.45 的 previewLocatorCode：
 *   pomMode = none               → page.locator("#username") / page.getByRole(AriaRole.BUTTON, ...)
 *   pomMode = generated/existing → loginPage.usernameInput() / login_page.username_input()
 *
 * @returns {{ code: string, imports: string[], warnings: string[] }}
 */

const {
  previewLocatorCode,
  normalizeLocatorMode,
  escapeDoubleQuoted
} = require('./locatorModes.js');
const { actionById, summaryOf } = require('./uiActions.js');

/** POM 三种模式（顺序即前端单选项顺序） */
const POM_MODES = ['none', 'generated', 'existing'];

/** 方法体缩进：4 个空格，和生成的 Java 类 / Python 模块保持一致 */
const INDENT = '    ';

/* ============================================================
 * 命名工具（自带一份，不依赖 shared/codegen.js —— 那份带 ejs）
 * ============================================================ */

/** 只保留 ASCII 字母数字（中文页面名 / 元素名会让标识符变成空串） */
function asciiWords(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
}

/** 转驼峰：user_name → userName；首字母小写 */
function camel(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/** 转帕斯卡：login-page → LoginPage */
function pascal(s) {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** 转下划线小写：usernameInput → username_input（Python 方法名用） */
function snake(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** Java 标识符：缺省兜底成 element，绝不生成空的 .() */
function javaMember(name) {
  return camel(name) || 'element';
}

/** Python 标识符：同上下划线 */
function pyMember(name) {
  return snake(name) || 'element';
}

/** 元素名是否是合法标识符（POM 模式下会直接当方法名用） */
function isIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(name === undefined || name === null ? '' : name).trim());
}

/**
 * 「用本页生成的」POM 类名。
 *
 * 取值顺序和 shared/codegen.js 的 pageBaseName 完全一致：
 *   类名输入框 > 页面名 > 页面路径 > MyPage
 * （中文名字 asciiWords 之后为空，会顺延到下一个来源。）
 *
 * 必须共用同一套顺序：POM 类文件按 pageBaseName 命名，积木如果只看页面名，
 * 用户填了类名就会出现「文件叫 MyLoginPage.java、代码里 new LoginPage(page)」。
 *
 * 前端展示的自动类名也走这个函数，保证「显示什么类名」和「生成什么类名」一致。
 */
function pomClassNameFromPage(pageName, pageUrl, className) {
  const candidates = [className, pageName, pageUrl];
  for (const c of candidates) {
    const words = asciiWords(c);
    if (!words) continue;
    const base = pascal(words).replace(/Page$/, '');
    if (base) return base + 'Page';
  }
  return 'MyPage';
}

/**
 * 测试方法名：类名（去 Test 后缀）> 页面名 > 页面路径 > Flow。
 *   LoginFlowTest → testLoginFlow / test_login_flow
 *   login         → testLogin     / test_login
 */
function testMethodName(o, lang) {
  const explicit = String((o && o.methodName) || '').trim();
  const classBase = String((o && o.className) || '')
    .trim()
    .replace(/Test$/i, '');
  const candidates = [explicit, classBase, o && o.pageName, o && o.pageUrl];
  let base = 'Flow';
  for (const c of candidates) {
    const words = asciiWords(c);
    if (words) {
      base = pascal(words);
      break;
    }
  }
  const name = base || 'Flow';
  return lang === 'python' ? 'test_' + (snake(name) || 'flow') : 'test' + name;
}

/**
 * 测试**类名**（v0.65）。
 *
 * 和 testMethodName 分开：方法名是 testHow2j，类名是 How2jTest。
 * 注意别和 POM 的页面对象类名（pomClass，如 LoginPage）混了 ——
 * 那个是**被调用**的类，这个是**装着测试方法的**类，两者不同。
 *
 * ⚠️ 两门语言的命名习惯正好相反：
 *   · Java/TestNG：`How2jTest`（后缀）
 *   · Python/pytest：`TestHow2j`（**前缀**）—— pytest 默认只收集 `Test*` 开头的类，
 *     叫 `How2jTest` 的话类里的用例一个都不会被执行。这是实测踩到的坑。
 */
function testClassName(o, lang) {
  const py = lang === 'python';
  const explicit = String((o && o.className) || '').trim();
  let base = '';
  if (explicit) {
    base = pascal(explicit.replace(/^Test/i, '').replace(/Test$/i, ''));
  } else {
    for (const c of [o && o.pageName, o && o.pageUrl]) {
      const words = asciiWords(c);
      if (words) {
        base = pascal(words);
        break;
      }
    }
  }
  base = base || 'Flow';
  return py ? 'Test' + base : base + 'Test';
}

/**
 * 把「方法 + import 清单」包成一个**真正能编译的文件**（v0.65）。
 *
 * 为什么必须这么做：
 *   以前积木面板的「复制 / 保存到文件」交出去的是
 *   `imports.join('\n') + '\n\n' + code` ——
 *   而 imports 是**裸全限定名**（`com.microsoft.playwright.Page`，没有 import 关键字），
 *   code 只是**一个孤立方法**（`@Test public void testX() {...}`，没有 class 包裹）。
 *   粘进 IDE 的结果就是用户实际遇到的那个文件：前几行是裸名字、然后直接 @Test，
 *   整个文件编译不过。v0.60 起说的「落盘即可编译」是错的，这里补正。
 *
 * @param {{code:string, imports:string[], className:string, packageName?:string, lang:string}} o
 * @returns {string} 完整文件内容
 */
function wrapAsFile(o) {
  const lang = (o && o.lang) === 'python' ? 'python' : 'java';
  const code = String((o && o.code) || '');
  if (!code.trim()) return '';
  const imports = Array.isArray(o.imports) ? o.imports.filter(Boolean) : [];
  const className = String((o && o.className) || (lang === 'python' ? 'TestFlow' : 'FlowTest'));
  const pkg = String((o && o.packageName) || '').trim();

  if (lang === 'java') {
    const importLines = imports.map((i) => 'import ' + i + ';');
    const head = [];
    if (pkg) head.push('package ' + pkg + ';', '');
    if (importLines.length) head.push.apply(head, importLines.concat(['']));
    const body = code
      .split('\n')
      .map((l) => (l.trim() === '' ? '' : INDENT + l))
      .join('\n');
    // head 已经以空串结尾（join 后是 "\n"），再补一个换行才是「import 块 + 空行 + class」
    return head.join('\n') + '\npublic class ' + className + ' {\n\n' + body + '\n}\n';
  }

  // Python：imports 本身就是完整语句（from ... import ...），不用加关键字
  const head = imports.length ? imports.join('\n') + '\n\n' : '';
  const body = code
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : INDENT + l))
    .join('\n');
  return head + 'class ' + className + ':\n' + body + '\n';
}

/* ============================================================
 * 参数替换
 * ============================================================ */

/** 字符串类参数的转义（引号由模板负责，这里只管内容） */
function escapeText(value) {
  return escapeDoubleQuoted(value === undefined || value === null ? '' : value);
}

/** 数字参数：不是数字就退回默认值 / 0，并给出提示（不抛异常） */
function numberValue(raw, fallback, warnings, label) {
  const n = Number(raw);
  if (String(raw === undefined || raw === null ? '' : raw).trim() !== '' && !Number.isFinite(n)) {
    warnings.push('「' + (label || '数字参数') + '」不是有效数字，已用 ' + fallback);
    return String(fallback);
  }
  return String(Number.isFinite(n) ? n : fallback);
}

/** 非 element 参数 → 填进模板的字面量 */
function formatParam(param, raw, warnings) {
  if (param.type === 'number') {
    const fallback = param.default === undefined ? 0 : param.default;
    return numberValue(raw, fallback, warnings, param.label || param.key);
  }
  if (param.type === 'boolean') {
    return raw === false || raw === 'false' || raw === 0 ? 'false' : 'true';
  }
  if (param.type === 'select') {
    // select 的取值一般是枚举常量名，模板自己决定要不要加引号，这里原样透传
    return String(raw === undefined || raw === null ? '' : raw);
  }
  return escapeText(raw);
}

/**
 * %el% 的替换规则。
 *
 * none 模式必须复用 locatorModes 的 previewLocatorCode（不要另写一套定位器生成）：
 * 定位方式/定位值可以是步骤自带的（选元素时快照），也可以按名字去 o.elements 里查。
 */
function elementRef(step, o, ctx, elName) {
  const name = String(elName === undefined || elName === null ? '' : elName).trim();
  const lang = ctx.lang;

  if (ctx.pomMode !== 'none') {
    if (name && !isIdentifier(name)) {
      const msg =
        '元素名「' + name + '」不是合法标识符，POM 方法名（' + (lang === 'python' ? pyMember(name) : javaMember(name)) + '）可能编译不过';
      if (!ctx.warned.has(msg)) {
        ctx.warned.add(msg);
        ctx.warnings.push(msg);
      }
    }
    const member = lang === 'python' ? pyMember(name) : javaMember(name);
    return ctx.pomVar + '.' + member + '()';
  }

  let mode = step.elementMode;
  let selector = step.elementSelector;
  const empty = selector === undefined || selector === null || String(selector).trim() === '';
  if (empty && Array.isArray(o.elements)) {
    const hit = o.elements.find((e) => e && String(e.name || '').trim() === name);
    if (hit) {
      mode = hit.mode;
      selector = hit.selector;
    }
  }

  const code = previewLocatorCode(normalizeLocatorMode(mode), selector, lang);
  if (code) {
    if (normalizeLocatorMode(mode) === 'role') ctx.usesRole = true;
    return code;
  }

  ctx.warnings.push('元素「' + (name || '未命名') + '」没有定位方式 / 定位值，先补一个再生成');
  // 兜底成合法表达式（能编译），不留 `.fill(...)` 这种语法错误
  return lang === 'python' ? 'self.page.locator("TODO")' : 'page.locator("TODO")';
}

/* ============================================================
 * 生成入口
 * ============================================================ */

/**
 * @param {object} o
 *   steps    [{ actionId, params: {el: '页面元素name', text: '...'}, elementMode, elementSelector }]
 *   lang     'java' | 'python'
 *   pomMode  'none' | 'generated' | 'existing'
 *   pomClass 类名（generated 时从页面名推，existing 时用户填）
 *   pomVar   变量名（默认按类名推：LoginPage → loginPage / login_page）
 *   pageName / pageUrl  推类名用
 *   elements 可选：页面元素集合，步骤里没带定位值时按名字兜底查
 *   methodName 可选：显式指定测试方法名
 * @returns {{ code: string, imports: string[], warnings: string[] }}
 */
function generateSteps(o) {
  const input = o || {};
  const warnings = [];
  const lang = input.lang === 'python' ? 'python' : 'java';
  const rawSteps = Array.isArray(input.steps) ? input.steps.filter(Boolean) : [];

  let pomMode = String(input.pomMode || 'none');
  if (POM_MODES.indexOf(pomMode) < 0) {
    warnings.push('不认识的 POM 模式「' + pomMode + '」，已按「不使用」处理');
    pomMode = 'none';
  }

  if (!rawSteps.length) {
    return {
      code: '',
      imports: [],
      warnings: warnings.concat(['还没有选任何步骤：先点左边的积木加一步']),
    };
  }

  /* ---------- 导航提示 ---------- */
  const gotoIndex = rawSteps.findIndex((s) => s && s.actionId === 'goto');
  if (gotoIndex < 0) {
    warnings.push('流程没有「打开地址」，可能需要先导航');
  } else if (gotoIndex > 0) {
    warnings.push('「打开地址」不在第一步，回放时可能先操作了还没打开的页面');
  }

  /* ---------- POM 类名 / 变量名 ---------- */
  let pomClass = String(input.pomClass || '').trim();
  if (pomMode === 'generated') {
    // 自动模式：取名规则和 POM 类生成共用一套（类名输入框 > 页面名 > 路径）。
    //
    // ⚠️ 这里**必须尊重已传进来的 pomClass**：
    //   UI 顶部的「类名」输入框在积木视图下仍然有效，用户改了类名就得用改后的。
    //   （v0.48.0 初版这里无条件覆盖，导致用户改类名不生效 —— 被单测抓出来。）
    pomClass =
      pomClass || pomClassNameFromPage(input.pageName, input.pageUrl, input.className);
  } else if (pomMode === 'existing' && !pomClass) {
    warnings.push('选了「用已有类」但类名是空的，先填页面对象类名');
    pomClass = 'MyPage';
  }

  let pomVar = String(input.pomVar || '').trim();
  if (pomMode !== 'none') {
    if (!pomVar) pomVar = lang === 'python' ? snake(pomClass) || 'pageObject' : camel(pomClass) || 'pageObject';
    else if (lang === 'python') pomVar = snake(pomVar) || 'page_object';
  }

  const ctx = {
    lang,
    pomMode,
    pomClass,
    pomVar,
    warnings,
    usesRole: false,
    /** 当前第几步（1 开始）：注释前缀用得到 */
    stepNo: 0,
    /** 同一句话只提示一次（同一个元素重复 3 次不必刷 3 遍） */
    warned: new Set(),
  };

  /* ---------- 逐条渲染 ---------- */
  const body = [];
  const usedIds = [];

  for (const step of rawSteps) {
    const action = actionById(step && step.actionId);
    if (!action) {
      warnings.push('不认识的动作「' + String((step && step.actionId) || '') + '」，已跳过');
      continue;
    }
    usedIds.push(action.id);

    let line = String(action[lang] || '');
    const params = (step && step.params) || {};

    for (const p of action.params || []) {
      const raw = params[p.key];
      const missing = raw === undefined || raw === null || String(raw).trim() === '';
      if (missing && p.required) {
        const msg = '动作「' + action.name + '」缺少「' + (p.label || p.key) + '」';
        if (!ctx.warned.has(msg)) {
          ctx.warned.add(msg);
          warnings.push(msg);
        }
      }

      let repl;
      if (p.type === 'element') {
        repl = elementRef(step, input, ctx, raw);
      } else {
        const value = missing ? (p.default === undefined ? '' : p.default) : raw;
        repl = formatParam(p, value, warnings);
      }
      // 用 split/join 而不是正则替换：替换内容里的 $ 不会被当成捕获组
      line = line.split('%' + p.key + '%').join(repl);
    }

    // 模板里还有没被 params 覆盖的 %key%（拼写错误在这里现形）
    const left = line.match(/%[A-Za-z0-9_]+%/g);
    if (left) {
      const msg = '动作「' + action.name + '」的模板里有未定义的占位符：' + left.join('、');
      if (!ctx.warned.has(msg)) {
        ctx.warned.add(msg);
        warnings.push(msg);
      }
    }

    // 多行模板（循环 / 连续两句，如「定时刷新」「退出并清空浏览器」）要逐行缩进，
    // 否则只有第一行在方法体里、后面的语句会掉到顶格
    //
    // v0.61：每步前面插一行注释，写清「这一步是在干什么」——
    //   // 3. 固定等待：3000 ms
    //   page.waitForTimeout(3000);
    // 积木拼出来的方法体隔几天自己都看不懂，注释是唯一能对回积木的东西。
    ctx.stepNo += 1;
    const summary = summaryOf(action, params);
    if (summary) {
      body.push(INDENT + (lang === 'python' ? '# ' : '// ') + ctx.stepNo + '. ' + summary);
    }
    for (const ln of line.split('\n')) body.push(INDENT + ln);
  }

  /* ---------- 拼方法 ---------- */
  const lines = [];
  const method = testMethodName(input, lang);
  if (lang === 'python') {
    lines.push('def ' + method + '(self):');
  } else {
    lines.push('@Test');
    lines.push('public void ' + method + '() {');
  }

  if (pomMode !== 'none') {
    lines.push(
      INDENT +
        (lang === 'python'
          ? pomVar + ' = ' + pomClass + '(self.page)'
          : pomClass + ' ' + pomVar + ' = new ' + pomClass + '(page);')
    );
  }
  lines.push.apply(lines, body);
  if (lang === 'java') lines.push('}');

  /* ---------- import ---------- */
  const imports = [];
  const has = (prefix) => usedIds.some((id) => id.indexOf(prefix) === 0);

  if (lang === 'java') {
    // 只要方法体里出现 page（导航 / 按键 / 等 URL / 断言标题 / POM 注入），就要 Page
    imports.push('com.microsoft.playwright.Page');
    if (has('assert-')) {
      imports.push('static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat');
    }
    if (has('press')) imports.push('com.microsoft.playwright.Keyboard');
    if (has('wait-visible')) {
      imports.push('com.microsoft.playwright.Locator');
      imports.push('com.microsoft.playwright.options.WaitForSelectorState');
    }
    if (ctx.usesRole) imports.push('com.microsoft.playwright.options.AriaRole');
  } else if (has('assert-')) {
    imports.push('from playwright.sync_api import expect');
  }

  const finalImports = Array.from(new Set(imports)).sort();

  /**
   * v0.65：同时给出 `fileCode` —— 一个**真正能编译的完整文件**。
   *
   * code 保持原样（一个方法体），因为：
   *   · 很多测试逐字比对了 code（改了会大面积红）；
   *   · 有些场景用户就是想拿一段方法体贴进自己已有类里。
   * 而「复制 / 保存到文件」用的是 fileCode —— 那是要交给 IDE 的东西。
   */
  const clsName = testClassName(input, lang);
  const fileCode = wrapAsFile({
    code: lines.join('\n'),
    imports: finalImports,
    className: clsName,
    packageName: input.packageName,
    lang
  });

  return {
    code: lines.join('\n'),
    /** 完整文件（package + import 语句 + class 包裹）；空步骤时为 '' */
    fileCode,
    /** 推导出来的测试类名（fileCode 里用的就是它） */
    testClassName: clsName,
    imports: finalImports,
    warnings,
  };
}

module.exports = {
  POM_MODES,
  generateSteps,
  pomClassNameFromPage,
  testMethodName,
  testClassName,
  wrapAsFile,
  camel,
  pascal,
  snake,
  asciiWords,
  isIdentifier,
};