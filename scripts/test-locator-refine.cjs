'use strict';
/**
 * 定位器「过滤后缀」+ 原生表达式 + 解析器保真（v0.66）。
 *
 * ============================================================
 * 为什么要有这一套
 * ============================================================
 * 起因是 user 的两句话：
 *   1. 「locator(".studyList a", setHasText("面向对象")) 这种带限制条件的，录入怎么优化」
 *   2. 「getBy语法怎么办，而且过滤条件还不少」（getByRole 有 9 个 options）
 *
 * 排查后发现真正的问题不是「UI 不够灵活」，而是：
 *   **codegen 录的是精确定位，平台解析入库时把过滤条件全丢了。**
 *   实测：setExact(true) → 只剩 button:登录；setHasText → 只剩 .studyList a；
 *         .nth(1) → 只剩 link:面向对象。
 *   于是「页面上的那一个」入库后变成「这一类」，生成出来定位不唯一。
 *
 * 这一套守四件事：
 *   1. parseRefine 能正确拆 `主语|后缀`，且**不会误伤 CSS 里合法的 `|`**
 *      （`div[class|="col"]`、命名空间 `svg|rect`）；
 *   2. previewLocatorCode 按后缀生成正确的 Java / Python（options 与链式的位置不同）；
 *   3. 解析器把 codegen 的三种语言写法还原成后缀，不再丢；
 *   4. raw 模式原样送出，只做最小容错。
 *
 * 全程不启动浏览器（浏览器行为由另一个探针验过闭环 8/8）。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
const ROOT = path.join(__dirname, '..');

const lm = require(path.join(ROOT, 'shared', 'locatorModes.js'));
const gen = (mode, sel, lang) => lm.previewLocatorCode(mode, sel, lang || 'java');

/* ============================================================
 * 一、parseRefine：拆后缀，不能误伤 CSS
 * ============================================================ */

{
  const p1 = lm.parseRefine('button:登录|exact');
  check('拆：主体 + exact', p1.base === 'button:登录' && p1.refine.length === 1 && p1.refine[0].key === 'exact', p1);

  const p2 = lm.parseRefine('button:提交|exact|disabled');
  check('拆：多个后缀按顺序', p2.refine.map((r) => r.key).join(',') === 'exact,disabled', p2.refine);

  const p3 = lm.parseRefine('checkbox|checked=false');
  check('拆：布尔 false 也认', p3.refine[0].key === 'checked' && p3.refine[0].value === false, p3.refine);

  const p4 = lm.parseRefine('link:面向对象|nth=1');
  check('拆：nth 的值是数字', p4.refine[0].key === 'nth' && p4.refine[0].value === 1, p4.refine);

  const p5 = lm.parseRefine('.studyList a|has-text=面向对象');
  check('拆：has-text 带值', p5.refine[0].key === 'has-text' && p5.refine[0].value === '面向对象', p5.refine);

  /* ---- 关键：CSS 里合法的 | 不能被拆 ---- */
  const safe1 = lm.parseRefine('div[class|="col"]');
  check(
    '安全：div[class|="col"] 不被误拆（| 后面不是已知后缀）',
    safe1.base === 'div[class|="col"]' && safe1.refine.length === 0,
    safe1
  );
  const safe2 = lm.parseRefine('svg|rect');
  check('安全：命名空间 svg|rect 不被误拆', safe2.base === 'svg|rect' && safe2.refine.length === 0, safe2);
  const safe3 = lm.parseRefine('.a|b|c');
  check('安全：不认识的后缀原样保留', safe3.base === '.a|b|c' && safe3.refine.length === 0, safe3);

  const edge1 = lm.parseRefine('|exact');
  check('边界：只有后缀、没主体 → 原样当主体', edge1.base === '|exact' && edge1.refine.length === 0, edge1);
  const edge2 = lm.parseRefine('');
  check('边界：空串不炸', edge2.base === '' && edge2.refine.length === 0, edge2);
  const edge3 = lm.parseRefine('.a|');
  check('边界：尾随空后缀不拆', edge3.base === '.a|' && edge3.refine.length === 0, edge3);
}

/* ============================================================
 * 二、生成：Java / Python 各自的写法
 * ============================================================ */

{
  /* ---- 向后兼容：不带后缀时必须逐字保持原样 ---- */
  check(
    '兼容：role 无后缀，Java 一字不变',
    gen('role', 'link:面向对象') === 'page.getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("面向对象"))',
    gen('role', 'link:面向对象')
  );
  check(
    '兼容：role 无后缀，Python 一字不变',
    gen('role', 'link:面向对象', 'python') === 'self.page.get_by_role("link", name="面向对象")',
    gen('role', 'link:面向对象', 'python')
  );
  check('兼容：css 无后缀', gen('css', '.a') === 'page.locator(".a")', gen('css', '.a'));
  check('兼容：xpath 自动补前缀', gen('xpath', '//div') === 'page.locator("xpath=//div")', gen('xpath', '//div'));

  /* ---- role + options ---- */
  check(
    'role|exact → setExact(true)',
    gen('role', 'button:登录|exact') ===
      'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(true))',
    gen('role', 'button:登录|exact')
  );
  check(
    'role|exact → Python exact=True',
    gen('role', 'button:登录|exact', 'python') === 'self.page.get_by_role("button", name="登录", exact=True)',
    gen('role', 'button:登录|exact', 'python')
  );
  check(
    'role 多 options 串联',
    gen('role', 'button:提交|exact|disabled') ===
      'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交").setExact(true).setDisabled(true))',
    gen('role', 'button:提交|exact|disabled')
  );
  check(
    'role|checked=false → setChecked(false)',
    gen('role', 'checkbox|checked=false') ===
      'page.getByRole(AriaRole.CHECKBOX, new Page.GetByRoleOptions().setChecked(false))',
    gen('role', 'checkbox|checked=false')
  );
  check(
    'role|description → setDescription',
    gen('role', 'textbox|description=账号输入框') ===
      'page.getByRole(AriaRole.TEXTBOX, new Page.GetByRoleOptions().setDescription("账号输入框"))',
    gen('role', 'textbox|description=账号输入框')
  );
  check(
    'role 无 name 但有 checked → 不生成 setName',
    gen('role', 'checkbox|checked') === 'page.getByRole(AriaRole.CHECKBOX, new Page.GetByRoleOptions().setChecked(true))',
    gen('role', 'checkbox|checked')
  );

  /* ---- 链式：filter / first / last / nth ---- */
  check(
    'css|has-text → filter(setHasText)',
    gen('css', '.studyList a|has-text=面向对象') ===
      'page.locator(".studyList a").filter(new Locator.FilterOptions().setHasText("面向对象"))',
    gen('css', '.studyList a|has-text=面向对象')
  );
  check(
    'css|has-text → Python filter(has_text=)',
    gen('css', '.studyList a|has-text=面向对象', 'python') ===
      'self.page.locator(".studyList a").filter(has_text="面向对象")',
    gen('css', '.studyList a|has-text=面向对象', 'python')
  );
  check('css|nth=0 → .nth(0)', gen('css', '.row|nth=0') === 'page.locator(".row").nth(0)', gen('css', '.row|nth=0'));
  check('css|first → Java .first()', gen('css', '.row|first') === 'page.locator(".row").first()', gen('css', '.row|first'));
  check(
    'css|first → Python 是属性 .first（不带括号）',
    gen('css', '.row|first', 'python') === 'self.page.locator(".row").first',
    gen('css', '.row|first', 'python')
  );
  check('css|last → Java .last()', gen('css', '.row|last') === 'page.locator(".row").last()', gen('css', '.row|last'));

  /* ---- 顺序：filter 必须在 nth 之前（语义不同） ---- */
  check(
    '顺序：has-text 生成在 nth 之前（先缩小集合再取第几个）',
    gen('css', '.row|has-text=x|nth=1') ===
      'page.locator(".row").filter(new Locator.FilterOptions().setHasText("x")).nth(1)',
    gen('css', '.row|has-text=x|nth=1')
  );

  /* ---- 语义定位的 exact ---- */
  check(
    'text|exact → Java 需要 Options 类',
    gen('text', '提交|exact') === 'page.getByText("提交", new Page.GetByTextOptions().setExact(true))',
    gen('text', '提交|exact')
  );
  check(
    'text|exact → Python 是关键字参数',
    gen('text', '提交|exact', 'python') === 'self.page.get_by_text("提交", exact=True)',
    gen('text', '提交|exact', 'python')
  );
  check(
    'label|exact → GetByLabelOptions',
    gen('label', '用户名|exact') === 'page.getByLabel("用户名", new Page.GetByLabelOptions().setExact(true))',
    gen('label', '用户名|exact')
  );
  check(
    'testid 不支持 exact → 忽略后缀不报错',
    gen('testid', 'submit|exact') === 'page.getByTestId("submit")',
    gen('testid', 'submit|exact')
  );

  /* ---- 引号转义：带引号的过滤值不能弄坏生成的字符串 ---- */
  check(
    '过滤值里有双引号 → 正常转义',
    gen('css', '.a|has-text=说"你好"').indexOf('setHasText("说\\"你好\\"")') >= 0,
    gen('css', '.a|has-text=说"你好"')
  );
}

/* ============================================================
 * 三、raw 原生表达式
 * ============================================================ */

{
  const full = 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(true))';
  check('raw：带 page. 前缀原样送出', gen('raw', full) === full, gen('raw', full));

  check(
    'raw：省略 page. 时补上',
    gen('raw', 'getByRole(AriaRole.BUTTON)') === 'page.getByRole(AriaRole.BUTTON)',
    gen('raw', 'getByRole(AriaRole.BUTTON)')
  );
  check(
    'raw：Python 下补 self.page.',
    gen('raw', 'getByRole(AriaRole.BUTTON)', 'python') === 'self.page.getByRole(AriaRole.BUTTON)',
    gen('raw', 'getByRole(AriaRole.BUTTON)', 'python')
  );
  check(
    'raw：已有 self.page. 不重复加',
    gen('raw', 'self.page.locator(".a")', 'python') === 'self.page.locator(".a")',
    gen('raw', 'self.page.locator(".a")', 'python')
  );
  check('raw：不解析后缀（原样）', gen('raw', 'page.locator(".a")|nth=0') === 'page.locator(".a")|nth=0', gen('raw', 'page.locator(".a")|nth=0'));
  check('raw 在 LOCATOR_MODES 里', lm.LOCATOR_MODES.indexOf('raw') >= 0, lm.LOCATOR_MODES);
  check('normalizeLocatorMode 认 raw', lm.normalizeLocatorMode('raw') === 'raw', lm.normalizeLocatorMode('raw'));
  check('normalizeLocatorMode 仍兜底 css', lm.normalizeLocatorMode('不认识的') === 'css', lm.normalizeLocatorMode('不认识的'));
}

/* ============================================================
 * 四、解析器保真：codegen 三种写法 → 后缀（这是本次的核心修复）
 * ============================================================ */

{
  const SNIP = path.join(ROOT, 'src', 'utils', 'playwrightSnippet.ts');
  const { code } = esbuild.transformSync(fs.readFileSync(SNIP, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
    charset: 'utf8'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
  const parse = mod.exports.parsePlaywrightSnippet;
  const one = (s) => {
    const r = parse(s);
    return r.rows.length ? r.rows[0] : null;
  };

  /* ---- Java setter 链 ---- */
  let row = one('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(true)).click();');
  check('解析 Java：setExact → |exact', row && row.selector === 'button:登录|exact', row && row.selector);

  row = one('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交").setDisabled(true)).click();');
  check('解析 Java：setDisabled → |disabled', row && row.selector === 'button:提交|disabled', row && row.selector);

  row = one('page.getByRole(AriaRole.CHECKBOX, new Page.GetByRoleOptions().setChecked(true)).click();');
  check('解析 Java：setChecked → |checked', row && row.selector === 'checkbox|checked', row && row.selector);

  row = one('page.getByRole(AriaRole.TEXTBOX, new Page.GetByRoleOptions().setDescription("账号输入框")).fill("a");');
  check('解析 Java：setDescription → |description=', row && row.selector === 'textbox|description=账号输入框', row && row.selector);

  /* ---- Python 关键字参数 ---- */
  row = one('page.get_by_role("button", name="登录", exact=True).click()');
  check('解析 Python：exact=True → |exact', row && row.selector === 'button:登录|exact', row && row.selector);

  row = one('page.get_by_role("checkbox", checked=True).click()');
  check('解析 Python：checked=True → |checked', row && row.selector === 'checkbox|checked', row && row.selector);

  /* ---- Node 对象字面量 ---- */
  row = one("page.getByRole('button', { name: '登录', exact: true }).click();");
  check('解析 Node：exact: true → |exact', row && row.selector === 'button:登录|exact', row && row.selector);

  /* ---- locator 的 options 与 filter ---- */
  row = one('page.locator(".studyList a", new Locator.LocatorOptions().setHasText("面向对象")).click();');
  check('解析 Java：locator setHasText → |has-text=', row && row.selector === '.studyList a|has-text=面向对象', row && row.selector);

  row = one('page.locator(".studyList a").filter(has_text="面向对象").click()');
  check('解析 Python：filter(has_text) → |has-text=', row && row.selector === '.studyList a|has-text=面向对象', row && row.selector);

  /* ---- 位置 ---- */
  row = one('page.getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("面向对象")).nth(1).click();');
  check('解析 Java：.nth(1) → |nth=1', row && row.selector === 'link:面向对象|nth=1', row && row.selector);

  row = one('page.get_by_role("link", name="面向对象").first.click()');
  check('解析 Python：.first → |first', row && row.selector === 'link:面向对象|first', row && row.selector);

  /* ---- 不能重复加：用户自己写过的后缀 / 伪类不要被再叠一层 ---- */
  row = one('page.locator(".studyList a:has-text(\\"面向对象\\")").click();');
  check(
    '解析：:has-text 伪类写在选择器里的，不再追加 |has-text',
    row && row.selector === '.studyList a:has-text("面向对象")',
    row && row.selector
  );

  row = one('page.locator(".a|nth=0").click();');
  check('解析：用户已写 |nth=0 不重复加', row && row.selector === '.a|nth=0', row && row.selector);

  /* ---- exact=false 是默认行为，不该被记成后缀（否则全是噪音） ---- */
  row = one('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(false)).click();');
  check('解析：setExact(false) 不加后缀（那本来就是默认）', row && row.selector === 'button:登录', row && row.selector);
}

/* ============================================================
 * 五、向导：解析出来的东西必须能被重新生成（防两处约定漂移）
 * ============================================================ */

{
  const SNIP = path.join(ROOT, 'src', 'utils', 'playwrightSnippet.ts');
  const { code } = esbuild.transformSync(fs.readFileSync(SNIP, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node18',
    charset: 'utf8'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
  const parse = mod.exports.parsePlaywrightSnippet;

  /** 解析器产出的后缀，必须全是 parseRefine 认识的 key */
  const known = Array.from(lm.REFINE_KEYS);
  const samples = [
    'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(true)).click();',
    'page.getByRole(AriaRole.CHECKBOX, new Page.GetByRoleOptions().setChecked(true)).click();',
    'page.locator(".a").filter(new Locator.FilterOptions().setHasText("x")).nth(1).click();'
  ];
  for (const s of samples) {
    const r = parse(s);
    const sel = r.rows[0] ? r.rows[0].selector : '';
    const back = lm.parseRefine(sel);
    check(
      '往返：解析器产出的后缀都能被 parseRefine 认回（' + sel + '）',
      back.refine.every((x) => known.indexOf(x.key) >= 0) && back.refine.length > 0,
      { sel, back }
    );
    check(
      '往返：再生成的代码非空且不含未替换的占位符',
      lm.previewLocatorCode(r.rows[0].mode, sel, 'java').length > 10 &&
        lm.previewLocatorCode(r.rows[0].mode, sel, 'java').indexOf('%') < 0,
      lm.previewLocatorCode(r.rows[0].mode, sel, 'java')
    );
  }
}

/* ============================================================
 * 说话
 * ============================================================ */
console.log('');
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log('  FAIL  ' + r.name + '  -> ' + r.extra);
}
console.log(
  '\n' + (results.length - failed.length) + '/' + results.length + ' passed' +
    (failed.length ? '，' + failed.length + ' 项失败' : '')
);
process.exit(failed.length ? 1 : 0);
