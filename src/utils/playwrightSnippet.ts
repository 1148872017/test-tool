/**
 * playwrightSnippet.ts —— 把 Playwright codegen 录制出来的代码解析成「页面元素」行。
 *
 * 为什么要有它（v0.54.1）：
 *   录元素交给 Playwright codegen（它比平台做得更好），
 *   但录完那一堆 `page.get_by_role("button", name="登录").click()` 还要人一条条敲进台账。
 *   这个小解析器把「录制 → 粘贴 → 自动入库」这一段接上。
 *
 * 只做一件事：认出**定位器**，忽略动作（click/fill/press...）。
 * 三种语法都认：
 *   Python `get_by_role("x", name="y")`
 *   Node   `getByRole('x', { name: 'y' })`
 *   Java   `getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("y"))`
 * Java 的定位器经常出现在断言行里（assertThat(...)），所以按「行内出现定位器就认」处理。
 *
 * 产出的行直接就是 PageElementsEditor 的存储格式：
 *   { name, mode, selector, desc }
 * 其中 mode ∈ 9 种定位方式，role 存成「角色:可访问名」（和 locatorModes 的约定一致）。
 */

export type ParsedRow = { name: string; mode: string; selector: string; desc: string };
export type ParseResult = { rows: ParsedRow[]; skipped: number; duplicates: number };

/** 定位方式 → 该方式在代码里的写法（Python 的 get_by_x 与 Node 的 getByX 都收） */
const MODE_CALLS: Array<{ mode: string; re: RegExp }> = [
  { mode: 'testid', re: /\bget_?[bB]y_?[tT]est_?[iI]d\s*\(/ },
  { mode: 'role', re: /\bget_?[bB]y_?[rR]ole\s*\(/ },
  { mode: 'label', re: /\bget_?[bB]y_?[lL]abel\s*\(/ },
  { mode: 'placeholder', re: /\bget_?[bB]y_?[pP]laceholder\s*\(/ },
  { mode: 'alttext', re: /\bget_?[bB]y_?[aA]lt_?[tT]ext\s*\(/ },
  { mode: 'title', re: /\bget_?[bB]y_?[tT]itle\s*\(/ },
  { mode: 'text', re: /\bget_?[bB]y_?[tT]ext\s*\(/ },
  { mode: 'css', re: /\bget_?[bB]y_?[cC]ss\s*\(/ }
];

/** 取第一个字符串字面量（单/双引号都认，忽略三引号与转义里的引号） */
function firstString(text: string): string {
  const m = /(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(text);
  return m ? m[2].replace(/\\(['"\\])/g, '$1') : '';
}

/**
 * 取 `name="登录"` / `{ name: '登录' }` / Java `setName("登录")` 里的可访问名。
 *
 * 三种写法分别是 Python / Node / Java codegen 的产物；
 * Java 的 `new Page.GetByRoleOptions().setName("…")` 最容易漏，漏了就只剩角色、丢了名字。
 */
function accessibleName(text: string): string {
  const py = /\bname\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(text);
  if (py) return py[2].replace(/\\(['"\\])/g, '$1');
  const js = /\bname\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(text);
  if (js) return js[2].replace(/\\(['"\\])/g, '$1');
  const java = /\bsetName\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)/.exec(text);
  if (java) return java[2].replace(/\\(['"\\])/g, '$1');
  return '';
}

/**
 * Java codegen 的角色是枚举而不是字符串：
 *   page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"))
 * 这里把 `AriaRole.BUTTON` 取成 `button`，和 Python/JS 的「角色:可访问名」口径一致。
 */
function ariaRoleOf(text: string): string {
  const m = /\bAriaRole\.([A-Za-z_]+)/.exec(text);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 把一段描述文字收成一个能当变量名用的 name。
 *
 * 台账里的 name 会进生成的 POM，所以必须是合法标识符：
 *   中文/空格/标点一律当分隔符，最后兜底成 el1 / el2。
 */
export function toIdentifier(raw: string, fallbackIndex: number): string {
  const parts = String(raw || '')
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // 纯中文没有可用的 ascii 标识符：用 elN 兜底（用户自己会改名）
  const ascii = parts
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)))
    .join('');
  const name = ascii || 'el' + fallbackIndex;
  return /^[A-Za-z_]/.test(name) ? name : 'el' + fallbackIndex;
}

/**
 * 解析一段 codegen 代码。
 *
 * @param text 用户从 codegen 录制器里复制出来的代码
 * @returns rows（已去重）/ skipped（当成动作忽略掉的行）/ duplicates（重复的定位器）
 */
export function parsePlaywrightSnippet(text: string): ParseResult {
  const src = String(text || '');
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let skipped = 0;

  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    let mode = '';
    for (const item of MODE_CALLS) {
      if (item.re.test(line)) {
        mode = item.mode;
        break;
      }
    }

    let selector = '';
    if (mode) {
      // 定位器调用的参数就是这一行里「第一个括号之后」的内容
      const open = line.search(/\bget_?[bB]y_?[A-Za-z_]+\s*\(/);
      const seg = open >= 0 ? line.slice(line.indexOf('(', open) + 1) : '';
      if (mode === 'role') {
        const enumRole = ariaRoleOf(seg);
        const name = accessibleName(seg);
        if (enumRole) {
          // Java：AriaRole.BUTTON + new Page.GetByRoleOptions().setName("登录")
          selector = name ? enumRole + ':' + name : enumRole;
        } else {
          // Python / Node：第一个字符串参数就是角色
          const role = firstString(seg);
          selector = role ? (name ? role + ':' + name : role) : '';
        }
      } else {
        selector = firstString(seg);
      }
    } else if (/\bpage\.locator\s*\(|\blocator\s*\(/.test(line)) {
      // 从 locator 自己的括号开始取，不能拿行内第一个 '('
      // （Java 断言写成 assertThat(page.locator("#x")).isVisible() 时第一个括号是 assertThat 的）
      const at = line.search(/\b(?:page\.)?locator\s*\(/);
      const open = at >= 0 ? line.indexOf('(', at) : -1;
      const value = firstString(open >= 0 ? line.slice(open + 1) : '');
      if (/^xpath=/.test(value)) {
        mode = 'xpath';
        selector = value.slice('xpath='.length);
      } else if (value.startsWith('//') || value.startsWith('(/')) {
        mode = 'xpath';
        selector = value;
      } else if (value) {
        mode = 'css';
        selector = value;
      }
    }

    if (!mode || !selector) {
      skipped += 1;
      continue;
    }

    const key = mode + '\u0000' + selector;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    const hint = mode === 'role' ? selector.split(':')[1] || selector : accessibleName(line) || selector;
    rows.push({
      name: toIdentifier(hint, rows.length + 1),
      mode,
      selector,
      desc: 'codegen'
    });
  }

  return { rows, skipped, duplicates };
}