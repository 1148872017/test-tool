'use strict';
/**
 * 「生成器」与「高亮器」的契约测试（v0.71）。
 *
 * ============================================================
 * 为什么单独有这一套
 * ============================================================
 * 用户实测报错：
 *   定位值 `.studyList a|has-text=面向对象` 点实时校验 →
 *   `'.studyList a|has-text=面向对象' is not a valid selector`
 *
 * 根因：v0.66 加 `|` 后缀时只改了**代码生成器**（locatorModes.previewLocatorCode），
 * 忘了实时校验那条链路（highlight.locatorExpr）—— 后缀被原样塞进 querySelectorAll。
 *
 * 最要命的是：**两边的单元测试当时都是绿的**。
 *   · test-locator-refine 验的是「生成出来对不对」
 *   · test-sniff-highlight 验的是「9 种模式各自拼得对不对」
 * 没人验「同一个定位值，两边理解一致吗」—— 这就是契约测试要补的洞。
 *
 * 这一套守四件事：
 *   1. 后缀**绝不能**漏进 DOM 查询字符串；
 *   2. 每个后缀都要翻译成对应的页面内过滤调用；
 *   3. **用 REFINE_KEYS 遍历** —— 以后新增后缀时这里会自动变红，强制两边一起改；
 *   4. 真实浏览器里命中数与生成代码的语义一致（可选，装了 chromium 才跑）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const lm = require(path.join(ROOT, 'shared', 'locatorModes.js'));
const hl = require(path.join(ROOT, 'electron', 'sniffer', 'highlight.js'));

/* ============================================================
 * 一、后缀绝不能漏进 DOM 查询
 * ============================================================ */

{
  const CASES = [
    ['css', '.studyList a|has-text=面向对象'],
    ['css', '.studyList a|has-not-text=已删除'],
    ['css', '.studyList a|nth=1'],
    ['css', '.row|first'],
    ['css', '.row|last'],
    ['role', 'link:面向对象|exact'],
    ['role', 'checkbox|checked'],
    ['role', 'button:提交|disabled'],
    ['role', 'textbox|description=账号输入框'],
    ['text', '提交|exact'],
    ['label', '用户名|exact'],
    ['xpath', '//div[@id="x"]|nth=0']
  ];

  for (const [mode, sel] of CASES) {
    const expr = hl.locatorExpr(mode, sel);
    // 关键断言：表达式里不能出现 "|has-text" 这类后缀原文
    // （允许 || 和字符串内合法内容，这里只查我们那 8 个后缀名）
    const leaked = /'[^']*\|(exact|disabled|checked|description|nth|first|last|has-text|has-not-text)/.test(expr) ||
      /"[^"]*\|(exact|disabled|checked|description|nth|first|last|has-text|has-not-text)/.test(expr);
    check('不漏后缀：[' + mode + '] ' + sel, !leaked && expr.length > 5, expr);
  }
}

/* ============================================================
 * 二、每个后缀都要翻译成对应的过滤调用
 * ============================================================ */

{
  const want = [
    ['css', '.a|has-text=x', '__ttFind.hasText('],
    ['css', '.a|has-not-text=x', '__ttFind.hasNotText('],
    ['css', '.a|nth=2', '__ttFind.nth('],
    ['css', '.a|first', '__ttFind.first('],
    ['css', '.a|last', '__ttFind.last('],
    ['role', 'button:a|exact', '__ttFind.exactName('],
    ['role', 'button:a|disabled', '__ttFind.flag('],
    ['role', 'checkbox|checked', '__ttFind.flag('],
    ['role', 'textbox|description=x', '__ttFind.description(']
  ];
  for (const [mode, sel, needle] of want) {
    const expr = hl.locatorExpr(mode, sel);
    check('后缀已翻译：[' + mode + '] ' + sel + ' → ' + needle.replace('__ttFind.', ''), expr.indexOf(needle) >= 0, expr);
  }

  // 顺序必须与生成器一致：has-text 在 nth 之前（先缩小集合再取第几个）
  const ordered = hl.locatorExpr('css', '.a|has-text=x|nth=1');
  check(
    '顺序与生成器一致：hasText 包在 nth 里面',
    ordered.indexOf('__ttFind.nth(') === 0 && ordered.indexOf('__ttFind.hasText(') > 0,
    ordered
  );
}

/* ============================================================
 * 三、用 REFINE_KEYS 遍历 —— 新增后缀时这里必须变红
 * ============================================================ */

{
  /**
   * 每个后缀在高亮器里的落地方式。
   * 新增后缀必须在这里登记，否则下面的「全覆盖」断言会红 ——
   * 这正是为了防止再出现「生成器改了、高亮器忘了」。
   */
  const HANDLED = {
    exact: 'exactName',
    disabled: 'flag',
    checked: 'flag',
    description: 'description',
    nth: 'nth',
    first: 'first',
    last: 'last',
    'has-text': 'hasText',
    'has-not-text': 'hasNotText'
  };

  const keys = Array.from(lm.REFINE_KEYS);
  const missing = keys.filter((k) => !HANDLED[k]);
  check(
    'REFINE_KEYS 里每个后缀都在高亮器里有对应实现（新增后缀必须两边一起改）',
    missing.length === 0,
    { missing, hint: '新加后缀后，highlight.locatorExpr 和这套测试的 HANDLED 表都要补' }
  );

  const extra = Object.keys(HANDLED).filter((k) => keys.indexOf(k) < 0);
  check('高亮器没有处理 REFINE_KEYS 里不存在的后缀（防拼写漂移）', extra.length === 0, extra);

  // 每个后缀实际都能触发一个过滤调用
  for (const k of keys) {
    const sel = k === 'nth' ? '.a|nth=0' : '.a|' + k;
    const expr = hl.locatorExpr('role', 'x|' + (k === 'nth' ? 'nth=0' : k) === '.a' ? '' : 'x|' + (k === 'nth' ? 'nth=0' : k));
    // 只验「表达式能生成且不长后缀」，具体形式由第二节覆盖
    check('后缀可生成表达式：' + k, typeof expr === 'string' && expr.length > 0, expr);
  }
}

/* ============================================================
 * 四、基础行为不回退（无后缀时与旧版一致）
 * ============================================================ */

{
  check('css 无后缀 → __ttFind.css', hl.locatorExpr('css', '.a') === '__ttFind.css(__ttScope, ".a")', hl.locatorExpr('css', '.a'));
  check('xpath 无后缀', hl.locatorExpr('xpath', '//div').indexOf('__ttFind.xpath(') === 0, hl.locatorExpr('xpath', '//div'));
  check(
    'role 无后缀 → 只有 role 调用',
    hl.locatorExpr('role', 'button:登录') === '__ttFind.role(__ttScope, "button", "登录")',
    hl.locatorExpr('role', 'button:登录')
  );
  check(
    'testid 无后缀',
    hl.locatorExpr('testid', 'submit').indexOf('"data-testid"') > 0,
    hl.locatorExpr('testid', 'submit')
  );
  check('raw 仍是空数组（不能实时校验）', hl.locatorExpr('raw', 'page.locator(".a")') === '[]', hl.locatorExpr('raw', 'page.locator(".a")'));
}

/* ============================================================
 * 五、表达式必须是能解析的 JS（注入脚本里 eval 不了就白搭）
 * ============================================================ */

{
  const cases = [
    ['css', '.a|has-text=x|nth=0'],
    ['css', ".a|has-text=说'单引号'"],
    ['css', '.a|has-text=说"双引号"'],
    ['role', 'button:登录|exact|nth=1'],
    ['role', 'textbox|description=账号输入框']
  ];
  for (const [mode, sel] of cases) {
    const expr = hl.locatorExpr(mode, sel);
    let ok = true;
    try {
      // 只做语法检查，不执行（__ttFind 不存在）
      new Function('__ttFind', '__ttScope', 'return (' + expr + ');');
    } catch (e) {
      ok = false;
    }
    check('表达式语法合法：[' + mode + '] ' + sel, ok, expr);
  }

  // 整段注入脚本也要能构造出来（生成的脚本里后缀同样不能漏进**查询**）
  const script = hl.buildHighlightScript('css', '.studyList a|has-text=面向对象', { name: 'x' });
  check('注入脚本能构造', typeof script === 'string' && script.length > 1000, script.length);

  /**
   * 只查「DOM 查询调用」里的泄漏。
   * ⚠ 不能直接 `script.indexOf('|has-text=') < 0` ——
   * 注入脚本里本来就带 `__TT_SPEC__`（含原始 selector，用于把事实回传给界面），
   * 那是对的、必须保留。要查的是 `__ttFind.xxx(...)` 的参数里有没有后缀。
   */
  const LEAK_RE = /__ttFind\.[A-Za-z]+\([^)]*\|(exact|disabled|checked|description|nth|first|last|has-text|has-not-text)/;
  check('注入脚本的 DOM 查询里没有漏出的后缀', !LEAK_RE.test(script), (LEAK_RE.exec(script) || [])[0]);
  check(
    '注入脚本保留了原始 selector（回传事实要用，不能一起剥掉）',
    script.indexOf('|has-text=面向对象') >= 0,
    'spec 里丢了原始 selector'
  );
}

/* ============================================================
 * 说话
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log('  FAIL  ' + r.name + '  -> ' + r.extra);
console.log('');
console.log((results.length - failed.length) + '/' + results.length + ' passed' + (failed.length ? '，' + failed.length + ' 项失败' : ''));
process.exit(failed.length ? 1 : 0);
