'use strict';
/**
 * v0.44.0 两项优化的回归：
 *   1) 造数「多字段组合」的字段名预设（每个类型一个驼峰默认名 + 同类型递增序号，
 *      删除不重置序号）；
 *   2) 脚本生成页的「脚本模板」入口 + 断言代码能直接生成进 jmx。
 *
 * 本套件只读仓库内源码 / shared 纯函数，不碰本机真实资产（unit 档）。
 */
const fs = require('fs');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const faker = require('../shared/faker.js');
const { TYPES, createFieldNamer, defaultNameOf } = faker;
const templates = require('../shared/scriptTemplates.js');
const { generateJmx, normalizeExtras } = require('../shared/jmxgen.js');
const { parseJmx } = require('../electron/jmx.js');

/* ============================================================
 * 一、字段名预设：defaultName
 * ============================================================ */

/** 约定表（用户明确给的对应关系，写死在测试里，防止以后被随手改） */
const EXPECTED_DEFAULTS = {
  name: 'userName',
  phone: 'mobile',
  email: 'email',
  idcard: 'idCard',
  bank: 'bankCard',
  address: 'address',
  company: 'companyName',
  uuid: 'uuid',
  date: 'date',
  amount: 'amount',
  order: 'orderNo',
  boundary: 'edgeValue',
  plate: 'plateNo',
  mac: 'macAddress'
};

check('14 个类型都配了 defaultName', TYPES.every((t) => typeof t.defaultName === 'string' && t.defaultName), TYPES.map((t) => t.value + ':' + t.defaultName));

check(
  'defaultName 与约定表逐个一致',
  TYPES.length === Object.keys(EXPECTED_DEFAULTS).length &&
    TYPES.every((t) => EXPECTED_DEFAULTS[t.value] === t.defaultName),
  TYPES.filter((t) => EXPECTED_DEFAULTS[t.value] !== t.defaultName).map((t) => t.value + '→' + t.defaultName)
);

/** 驼峰：小写开头，只含字母数字，且第一个词之后每个词首字母大写 */
const CAMEL_RE = /^[a-z][a-zA-Z0-9]*$/;
check('defaultName 全是合法驼峰（小写开头、无下划线）', TYPES.every((t) => CAMEL_RE.test(t.defaultName)), TYPES.filter((t) => !CAMEL_RE.test(t.defaultName)).map((t) => t.defaultName));

check(
  'defaultName 互不重复（否则序号会串台）',
  new Set(TYPES.map((t) => t.defaultName)).size === TYPES.length,
  TYPES.map((t) => t.defaultName)
);

check('未知类型退回 field', defaultNameOf('not-a-type') === 'field', defaultNameOf('not-a-type'));

/* ============================================================
 * 二、序号规则：第一次不带后缀，之后 _2 _3 …
 * ============================================================ */

{
  // 前端就是这么用的：一个 namer 装进 useRef，加字段时调 next
  const namer = createFieldNamer();
  const nextNameFor = (type) => namer.next(type);

  // 注意：每个 next() 都先把结果存下来再断言——直接写在 check 参数里会多取一个号
  const first = nextNameFor('name');
  const second = nextNameFor('name');
  const third = nextNameFor('name');
  check('第一个 name 字段 → userName', first === 'userName', first);
  check('第二个 name 字段 → userName_2', second === 'userName_2', second);
  check('第三个 name 字段 → userName_3', third === 'userName_3', third);
  check('序号快照记录已用 3 个', namer.snapshot().name === 3, namer.snapshot());
}

{
  // 「删除不重置」：删掉的号绝不复用——计数器只增不减
  const namer = createFieldNamer();
  const got = [namer.next('name'), namer.next('name'), namer.next('name')];
  // 用户删掉 userName_2（只是从字段列表里删，计数器不动）
  const afterDelete = namer.next('name');
  check('删掉中间字段后再加 → userName_4（不重置、不复用 _2）', afterDelete === 'userName_4', { got, afterDelete });
  check('删除不会让序号回退（下一个仍是 _5）', namer.next('name') === 'userName_5', 'reset happened');
}

{
  // 不同 type 各自独立计数
  const namer = createFieldNamer();
  const name1 = namer.next('name');
  const name2 = namer.next('name');
  const phone1 = namer.next('phone');
  const phone2 = namer.next('phone');
  const phone3 = namer.next('phone');
  check(
    '不同 type 独立计数（name 与 phone 互不影响）',
    name1 === 'userName' && name2 === 'userName_2' && phone1 === 'mobile' && phone2 === 'mobile_2' && phone3 === 'mobile_3',
    { name1, name2, phone1, phone2, phone3 }
  );
  check('快照里两个类型各记各的号', namer.snapshot().name === 2 && namer.snapshot().phone === 3, namer.snapshot());
}

/* ============================================================
 * 三、恢复已有字段：计数器从最大值往后推
 * ============================================================ */

{
  // 场景：首次挂载时字段列表里已经有 userName / userName_7 / mobile_3
  const namer = createFieldNamer([
    { name: 'userName', type: 'name' },
    { name: 'userName_7', type: 'name' },
    { name: 'mobile_3', type: 'phone' },
    { name: 'myField', type: 'name' } // 手改过的名字
  ]);
  check('恢复时从已有名字最大值往后推（userName_7 → _8）', namer.next('name') === 'userName_8', namer.snapshot());
  check('恢复时 phone 也从最大值往后推（mobile_3 → _4）', namer.next('phone') === 'mobile_4', namer.snapshot());
}

{
  // 手改过的名字不参与计数：不认的模式直接忽略
  const namer = createFieldNamer([{ name: 'myOwnName' }, { name: 'u2' }, { name: 'userName_abc' }]);
  check('手写名字不参与计数（仍从 userName 开始）', namer.next('name') === 'userName', namer.snapshot());
  check('手写名字不会被记进快照', namer.snapshot().name === 1, namer.snapshot());
}

{
  // 运行期又恢复了外部字段 → seedFrom 只往前推，不回退
  const namer = createFieldNamer();
  const first = namer.next('name');
  namer.seedFrom([{ name: 'userName_9' }]);
  check('seedFrom 只增不减（userName_9 之后是 _10）', first === 'userName' && namer.next('name') === 'userName_10', namer.snapshot());
  namer.seedFrom([{ name: 'userName_2' }]);
  check('seedFrom 遇到更小的号不回退', namer.next('name') === 'userName_11', namer.snapshot());
}

{
  // 默认 4 个字段本身就是 userName/mobile/email/idCard，所以打开页面后加的第一个 name 字段是 _2
  const namer = createFieldNamer([
    { name: 'userName', type: 'name' },
    { name: 'mobile', type: 'phone' },
    { name: 'email', type: 'email' },
    { name: 'idCard', type: 'idcard' }
  ]);
  check('默认字段存在时新增 name 字段从 _2 开始（不会和默认值重名）', namer.next('name') === 'userName_2', namer.snapshot());
  check('默认字段存在时新增 email 字段从 _2 开始', namer.next('email') === 'email_2', namer.snapshot());
}

/* ============================================================
 * 四、DataTool 接线（只读源码断言）
 * ============================================================ */

{
  const src = read('src/pages/DataTool.tsx');
  check('DataTool 从 shared/faker 引入 createFieldNamer', /createFieldNamer/.test(src) && /from '\.\.\/\.\.\/shared\/faker'/.test(src), 'not imported');
  check('计数器放在 useRef 里（跨渲染连续）', /useRef<ReturnType<typeof createFieldNamer> \| null>/.test(src), 'not in ref');
  check('有 nextNameFor 取号函数', /const nextNameFor = \(type: string\) => namerRef\.current!\.next\(type\)/.test(src), 'no nextNameFor');
  // v0.46.0：用户反馈「类型跟随上一行 + 名字自动填」让新行看起来像已填好的，
  // 改成空白待填行；用户选类型后 setFieldType 会自动补默认名（下面那条断言守着）。
  check(
    '添加字段给空白待填行（类型回默认、不跟随上一行）',
    /const addField = \(\) => \{\s*setFields\(\(prev\) => prev\.concat\(\[makeField\(\)\]\)\);\s*\};/.test(src),
    'addField 还在跟随上一行类型'
  );
  check('makeField 默认是空的 name + name 类型', /name: '',\s*type: 'name'/.test(src), 'makeField 默认值变了');
  check('字段名 placeholder 改为「默认按类型自动命名」', /placeholder="默认按类型自动命名"/.test(src), 'placeholder not updated');
  check(
    '切换类型时不覆盖已有名字，只有名字为空才补默认名',
    /const fillName = target && !target\.name\.trim\(\) \? nextNameFor\(v\) : ''/.test(src) && /setFieldType\(f\.id, v\)/.test(src),
    'type switch logic missing'
  );
  // 老回归不能破：按 id 增删、两处 TYPES 下拉关虚拟化
  check('字段增删仍按 id 操作', /removeField = \(id: number\)/.test(src) && /setField = \(id: number/.test(src), 'index based again');
  check('两处 TYPES 下拉仍关掉虚拟化', (src.match(/virtual=\{false\}/g) || []).length === 2, (src.match(/virtual=\{false\}/g) || []).length);
}

/* ============================================================
 * 五、脚本模板入口（ScriptGenPage + 抽屉）
 * ============================================================ */

{
  const page = read('src/pages/ScriptGenPage.tsx');
  check('脚本生成页引入了脚本模板抽屉', /import ScriptTemplatesDrawer from '\.\.\/components\/ScriptTemplatesDrawer'/.test(page), 'no import');
  check('JMeter 工具条上有「脚本模板」按钮', /<Button size="small" icon=\{<ReadOutlined \/>\} onClick=\{\(\) => setTplOpen\(true\)\}>\s*脚本模板/.test(page), 'no button');
  check('抽屉挂载并接了 onPick（选模板 → 填入附加代码）', /<ScriptTemplatesDrawer[\s\S]{0,160}onPick=\{pickTemplate\}/.test(page), 'drawer not wired');
  check('有附加代码区域与三态位置（前置/断言/后置）', /EXTRA_OPTIONS/.test(page) && /'assertion'/.test(page) && /'pre'/.test(page) && /'post'/.test(page), 'no extra ui');
  check('生成/保存都把 extraElements 传给主进程', (page.match(/extraElements: buildExtras\(\)/g) || []).length === 2, (page.match(/extraElements: buildExtras\(\)/g) || []).length);
  check(
    '顶部说明了「压测脚本 vs 脚本生成」的关系',
    /「压测脚本」页看的是你已经有的 \.jmx 脚本；这里生成的是新的 jmx 文件。/.test(page),
    'no hint'
  );
  check('代码注释里写了「为什么不做合并」', /为什么「压测脚本」和「脚本生成」不合并/.test(page), 'no merge rationale');
}

{
  const drawer = read('src/components/ScriptTemplatesDrawer.tsx');
  check('抽屉支持 onPick 回调', /onPick\?: \(item: \{ type: TemplateInsertKind; code: string; name: string \}\) => void/.test(drawer), 'no onPick prop');
  check('抽屉有「填入附加代码」按钮', /填入附加代码/.test(drawer), 'no insert button');
  check('抽屉底部有「复制后粘到 JMeter GUI 的对应元件里」说明', /复制后粘到 JMeter GUI 的对应元件里/.test(drawer), 'no footer note');
  check('抽屉底部有去 JMeter 目录/启动的快捷按钮', /打开 jmx 目录/.test(drawer) && /启动 JMeter/.test(drawer), 'no shortcut');
  check(
    '分类 → 元件类型映射正确（断言→assertion、提取→post）',
    /assert: 'assertion'/.test(drawer) && /extract: 'post'/.test(drawer),
    'bad mapping'
  );
}

/* ============================================================
 * 六、模板默认值填充（直接进 jmx 的代码不能留 {{占位符}}）
 * ============================================================ */

{
  const { fillTemplateDefaults } = templates;
  const jsonTpl = templates.TEMPLATES.find((t) => t.id === 'assert-json-field');
  const filled = fillTemplateDefaults(jsonTpl.code, jsonTpl.vars);
  check('填充后没有残留 {{占位符}}', !/\{\{/.test(filled), (filled.match(/\{\{[^}]*\}\}/g) || []).slice(0, 3));
  check('填充用了 vars 里的默认值', /def actual = json\.data\.status/.test(filled) && /def expected = "SUCCESS"/.test(filled), filled.slice(0, 120));
  check(
    '未知占位符原样保留（不凭空编值）',
    fillTemplateDefaults('x = "{{nope}}"', [{ name: 'other', value: '1' }]) === 'x = "{{nope}}"',
    'placeholder eaten'
  );
  check('没有 vars 时原样返回', fillTemplateDefaults('{{a}}', undefined) === '{{a}}', 'changed');
}

check('模板库仍是 18 个 / 7 个分类（回归）', templates.TEMPLATES.length === 18 && templates.TEMPLATE_CATEGORIES.length === 7, {
  tpl: templates.TEMPLATES.length,
  cat: templates.TEMPLATE_CATEGORIES.length
});

/* ============================================================
 * 七、附加代码生成进 jmx
 * ============================================================ */

const apis = [
  {
    data: {
      name: '登录',
      method: 'POST',
      url: 'https://test.example.com/api/login',
      headers: 'Content-Type: application/json',
      body: '{"username":"admin"}',
      bodyType: 'json'
    }
  },
  {
    data: { name: '查用户', method: 'GET', url: 'http://test.example.com/api/v1/user', headers: '', body: '', bodyType: 'none' }
  }
];

/** 断言模板填充后的真实代码（和页面上「填入附加代码」用的是同一套） */
const assertTpl = templates.TEMPLATES.find((t) => t.id === 'assert-body-contains');
const assertCode = templates.fillTemplateDefaults(assertTpl.code, assertTpl.vars);

{
  check('normalizeExtras 丢掉空代码', normalizeExtras([{ type: 'assertion', code: '   ' }]).length === 0, 'empty kept');
  check('normalizeExtras 丢掉不认识的位置类型', normalizeExtras([{ type: 'listener', code: 'x' }]).length === 0, 'unknown kept');
  check('normalizeExtras 保留合法项', normalizeExtras([{ type: 'pre', code: 'a=1' }]).length === 1, 'dropped');
}

{
  const gen = generateJmx({
    apis,
    name: '附加代码计划',
    rtLimit: 500,
    extraElements: [
      { type: 'assertion', code: assertCode, name: assertTpl.name },
      { type: 'pre', code: 'vars.put("sign", "abc")' },
      { type: 'post', code: 'log.info("done")' }
    ]
  });

  check('带额外代码仍能生成', gen.ok === true, gen.message);
  check('断言写成 JSR223Assertion', /<JSR223Assertion /.test(gen.xml), 'no JSR223Assertion');
  check('前置写成 JSR223PreProcessor', /<JSR223PreProcessor /.test(gen.xml), 'no JSR223PreProcessor');
  check('后置写成 JSR223PostProcessor', /<JSR223PostProcessor /.test(gen.xml), 'no JSR223PostProcessor');
  check(
    '每个采样器下都插入了（2 个接口 → 各 1 个断言元件）',
    (gen.xml.match(/<JSR223Assertion /g) || []).length === 2,
    (gen.xml.match(/<JSR223Assertion /g) || []).length
  );
  check('脚本语言写的是 groovy', (gen.xml.match(/<stringProp name="scriptLanguage">groovy<\/stringProp>/g) || []).length === 6, 'language missing');
  check('testname 带上了来源模板名（JMeter 树里能认出来）', gen.xml.indexOf('testname="' + assertTpl.name + '"') > 0, 'no template name');

  // 生成出来的还得是合法 jmx：自己的解析器必须能读，且采样器/断言数量不被污染
  const parsed = parseJmx(gen.xml, 'extras.jmx');
  check('附加代码后仍是合法 jmx（解析无错误）', parsed.parseError === '', parsed.parseError);
  check('采样器数量不变（还是 2 个）', parsed.samplers.length === 2, parsed.samplers.length);
  check('原有响应断言 / 持续时间断言没被顶掉', parsed.responseAssertions.length === 2 && parsed.durationAssertions.length === 2, {
    resp: parsed.responseAssertions.length,
    dur: parsed.durationAssertions.length
  });
}

{
  // 代码里的 < & " 必须转义，否则生成的 xml 直接坏掉
  const escGen = generateJmx({
    apis: apis.slice(0, 1),
    name: '转义计划',
    extraElements: [{ type: 'assertion', code: 'if (a < b && c > d) { log.info("x") }' }]
  });
  check(
    'Groovy 代码里的 < & " 被正确转义',
    /a &lt; b &amp;&amp; c &gt; d/.test(escGen.xml) && /&quot;x&quot;/.test(escGen.xml),
    (escGen.xml.match(/<stringProp name="script">[^<]*/) || [''])[0].slice(0, 120)
  );
  check('转义后仍是合法 jmx', parseJmx(escGen.xml, 'esc.jmx').parseError === '', parseJmx(escGen.xml, 'esc.jmx').parseError);
}

{
  // 不带附加代码时不能凭空冒出 JSR223 元件
  const plain = generateJmx({ apis, name: '纯生成' });
  check('不传 extraElements 时不生成任何 JSR223 元件', !/JSR223/.test(plain.xml), 'unexpected jsr223');

  const emptyList = generateJmx({ apis, name: '纯生成', extraElements: [] });
  check('传空数组时输出和不传完全一致', emptyList.xml === plain.xml, 'diff');
}

{
  // 主进程 IPC 必须透传，否则「预览有、保存丢」
  const ipc = read('electron/ipc/ipc-jmx.js');
  check('jmxgen:preview 透传 extraElements', (ipc.match(/extraElements: payload\.extraElements/g) || []).length === 2, (ipc.match(/extraElements: payload\.extraElements/g) || []).length);
}

/* ============================================================
 * 汇总
 * ============================================================ */

const failed = results.filter((r) => !r.ok);
console.log('===== v0.44.0 字段名预设 + 断言模板 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);