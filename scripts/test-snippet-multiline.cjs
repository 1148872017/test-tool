'use strict';
/**
 * 定位器代码识别的「跨行」与「忽略明细」（v0.69）。
 *
 * ============================================================
 * 为什么要有这一套
 * ============================================================
 * 用户实测反馈（截图）：
 *   Locator loc2 = page.locator(".studyList a")
 *        .filter(new Locator.FilterOptions().setHasText("面向对象"));
 * 识别结果「已添加 0 个元素，忽略动作 1 行」，而且真正麻烦的是：
 * `.filter(...)` 在**第二行**，以前按物理行解析，过滤条件被丢掉 ——
 * 入库的是 `.studyList a`（命中 3 个），而不是带过滤的那一个。
 * **一个缺条件的元素比一个认不出的元素更危险**，因为它看起来是好的。
 *
 * 这一套守两件事：
 *   1. 跨行链式调用要拼成一条再解析（括号未闭合 / 下一行以 . 开头）；
 *   2. 认不出来的行要带上**原文 + 原因**回传，界面才能告诉用户忽略了什么。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

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

const one = (src) => {
  const r = parse(src);
  return { r, row: r.rows[0] || null, sel: (r.rows[0] || {}).selector };
};

/* ============================================================
 * 一、跨行拼接
 * ============================================================ */

{
  // 用户原始那段（第一行括号是平衡的，靠「下一行以 . 开头」续起来）
  const { r, sel } = one(`Locator loc2 = page.locator(".studyList a")
     .filter(new Locator.FilterOptions().setHasText("面向对象"));`);
  check('跨行：.filter 续行被拼上（不再丢过滤条件）', sel === '.studyList a|has-text=面向对象', sel);
  check('跨行：不产生多余的「忽略」行', r.skipped === 0, r.skipped);

  const b = one(`page.getByRole(AriaRole.BUTTON,
    new Page.GetByRoleOptions().setName("登录").setExact(true)).click();`);
  check('跨行：Java 括号未闭合（第一行只有左括号）', b.sel === 'button:登录|exact', b.sel);

  const c = one(`page.locator(".row")
   .filter(new Locator.FilterOptions().setHasText("订单"))
   .nth(1)
   .click();`);
  check('跨行：三行链式（filter + nth）', c.sel === '.row|has-text=订单|nth=1', c.sel);

  const d = one(`page.get_by_role(
    "button", name="登录").click()`);
  check('跨行：Python 参数换行', d.sel === 'button:登录', d.sel);

  const e = one(`page.locator('[data-x="(1)"]').click();`);
  check('跨行：字符串里的括号不算未闭合（不能误拼下一行）', e.sel === '[data-x="(1)"]', e.sel);

  const f = one(`page.getByText("提交").click();
page.getByText("取消").click();`);
  check('跨行：两条独立的单行不能被拼在一起', f.r.rows.length === 2, f.r.rows.length);
}

/* ============================================================
 * 二、忽略明细（原文 + 原因）
 * ============================================================ */

{
  const r = parse(`page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录")).click();
page.keyboard.press("Enter");`);
  check('明细：认出一个、忽略一个', r.rows.length === 1 && r.skipped === 1, { rows: r.rows.length, skipped: r.skipped });
  check('明细：ignored 里有被忽略那行的原文', !!r.ignored[0] && r.ignored[0].text.indexOf('keyboard.press') >= 0, r.ignored[0]);
  check('明细：ignored 带原因文案', !!r.ignored[0] && r.ignored[0].reason.length > 4, r.ignored[0] && r.ignored[0].reason);

  const v = parse('page.locator(mySelector).click();');
  check(
    '明细：变量当选择器 → 原因说「定位值是变量」（不是笼统的「没找到定位器」）',
    v.ignored[0] && v.ignored[0].reason.indexOf('变量') >= 0,
    v.ignored[0] && v.ignored[0].reason
  );

  const g = parse('console.log("hello");\nsomeFunction(1, 2);');
  check('明细：完全不是定位器 → 两行都进 ignored', g.ignored.length === 2, g.ignored.length);
  check(
    '明细：原因说「没找到定位器」',
    g.ignored.every((x) => x.reason.indexOf('没找到定位器') >= 0),
    g.ignored.map((x) => x.reason)
  );

  // 上限：只留 8 条，避免一大段代码刷屏
  const many = Array.from({ length: 20 }, (_, i) => 'console.log(' + i + ');').join('\n');
  const m = parse(many);
  check('明细：最多留 8 条（防刷屏）', m.ignored.length === 8, m.ignored.length);
  check('明细：但 skipped 计数是真实值（20）', m.skipped === 20, m.skipped);
}

/* ============================================================
 * 三、既有行为不回退
 * ============================================================ */

{
  const cases = [
    ['role + exact', 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(true)).click();', 'button:登录|exact'],
    ['role disabled', 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交").setDisabled(true)).click();', 'button:提交|disabled'],
    ['checked', 'page.getByRole(AriaRole.CHECKBOX, new Page.GetByRoleOptions().setChecked(true)).click();', 'checkbox|checked'],
    ['description', 'page.getByRole(AriaRole.TEXTBOX, new Page.GetByRoleOptions().setDescription("账号输入框")).fill("a");', 'textbox|description=账号输入框'],
    ['css single-line filter', 'page.locator(".studyList a").filter(new Locator.FilterOptions().setHasText("面向对象")).click();', '.studyList a|has-text=面向对象'],
    ['nth', 'page.getByRole(AriaRole.LINK, new Page.GetByRoleOptions().setName("面向对象")).nth(1).click();', 'link:面向对象|nth=1'],
    ['first', 'page.get_by_role("link", name="x").first.click()', 'link:x|first'],
    ['python exact', 'page.get_by_role("button", name="登录", exact=True).click()', 'button:登录|exact'],
    ['node exact', "page.getByRole('button', { name: '登录', exact: true }).click();", 'button:登录|exact']
  ];
  for (const [label, src, want] of cases) {
    const { sel } = one(src);
    check('不回退：' + label, sel === want, { got: sel, want });
  }

  const x = one('page.locator("//div[@id=\'x\']").click();');
  check('不回退：xpath 自动识别', x.r.rows[0] && x.r.rows[0].mode === 'xpath', x.r.rows[0]);

  const three = parse(`page.get_by_role("button", name="登录", exact=True).click()
page.get_by_text("提交").click()
page.locator(".row").nth(0).click()`);
  check('不回退：多行独立语句各自解析', three.rows.length === 3, three.rows.length);
}

/* ============================================================
 * 说话
 * ============================================================ */
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log('  FAIL  ' + r.name + '  -> ' + r.extra);
console.log('');
console.log((results.length - failed.length) + '/' + results.length + ' passed' + (failed.length ? '，' + failed.length + ' 项失败' : ''));
process.exit(failed.length ? 1 : 0);
