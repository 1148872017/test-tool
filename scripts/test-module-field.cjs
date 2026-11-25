/*
 * 接口模块 / 页面项目：可选择 + 可新建（含「详情 / 表单一致性」防回归检查）
 *
 * 用户报的 bug：接口详情的「模块 / 目录」有值，但新建 / 编辑表单里没这个字段。
 * 根因是字段上写了 formHidden: true —— 详情只过滤 hideInDetail，于是「详情有、表单没有」。
 * 本套件把这类不一致钉死：凡是 formHidden 又没 hideInDetail 的字段，必须写明原因。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const { COLLECTIONS, COLLECTION_MAP, OPTION_SETS } = require('../shared/collections.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * 一、option 集登记
 * ------------------------------------------------------------------ */
check('OPTION_SETS 有 module', !!OPTION_SETS.module);
check('OPTION_SETS 有 project', !!OPTION_SETS.project);
check(
  'module 的 defaults 是空数组（让用户自己建）',
  Array.isArray(OPTION_SETS.module && OPTION_SETS.module.defaults) && OPTION_SETS.module.defaults.length === 0,
  OPTION_SETS.module && OPTION_SETS.module.defaults
);
check(
  'project 的 defaults 是空数组（让用户自己建）',
  Array.isArray(OPTION_SETS.project && OPTION_SETS.project.defaults) && OPTION_SETS.project.defaults.length === 0,
  OPTION_SETS.project && OPTION_SETS.project.defaults
);
check('module 显示名是「接口模块」', OPTION_SETS.module.name === '接口模块', OPTION_SETS.module.name);
check('project 显示名是「页面项目」', OPTION_SETS.project.name === '页面项目', OPTION_SETS.project.name);
check(
  'module / project 都是 text 型（值即显示名）',
  OPTION_SETS.module.kind === 'text' && OPTION_SETS.project.kind === 'text',
  [OPTION_SETS.module.kind, OPTION_SETS.project.kind]
);

/* ------------------------------------------------------------------ *
 * 二、接口字段：模块 / 目录
 * ------------------------------------------------------------------ */
const moduleField = (COLLECTION_MAP.apis.fields || []).find((f) => f.key === 'module');
check('apis 有 module 字段', !!moduleField);
check('apis.module 类型是 selectOrCreate', !!moduleField && moduleField.type === 'selectOrCreate', moduleField && moduleField.type);
check('apis.module 指向选项集 module', !!moduleField && moduleField.optionsKey === 'module', moduleField && moduleField.optionsKey);
check('apis.module 不再 formHidden（用户报的 bug）', !!moduleField && !moduleField.formHidden, moduleField && moduleField.formHidden);
check('apis.module 标签仍是「模块 / 目录」', !!moduleField && moduleField.label === '模块 / 目录', moduleField && moduleField.label);
check(
  'apis.module 提示可新建（placeholder 里有「输入」）',
  !!moduleField && /输入/.test(String(moduleField.placeholder || '')),
  moduleField && moduleField.placeholder
);

/* ------------------------------------------------------------------ *
 * 三、页面字段：所属项目
 * ------------------------------------------------------------------ */
const pagesConf = COLLECTION_MAP.pages;
const projectField = (pagesConf.fields || []).find((f) => f.key === 'project');
check('pages 有 project 字段', !!projectField);
check('pages.project 类型是 selectOrCreate', !!projectField && projectField.type === 'selectOrCreate', projectField && projectField.type);
check('pages.project 指向选项集 project', !!projectField && projectField.optionsKey === 'project', projectField && projectField.optionsKey);
check('pages.project 不再 formHidden', !!projectField && !projectField.formHidden, projectField && projectField.formHidden);
check('pages.project 不是必填（可留空）', !!projectField && !projectField.required, projectField && projectField.required);
check(
  'pages.project 提示可留空',
  !!projectField && /可留空/.test(String(projectField.placeholder || '')),
  projectField && projectField.placeholder
);

/* ------------------------------------------------------------------ *
 * 四、全部 selectOrCreate 字段的通用约束
 * ------------------------------------------------------------------ */
const noOptionsKey = [];
const badOptionsKey = [];
for (const conf of COLLECTIONS) {
  for (const f of conf.fields) {
    if (f.type !== 'selectOrCreate') continue;
    if (!f.optionsKey) noOptionsKey.push(conf.key + '.' + f.key);
    else if (!OPTION_SETS[f.optionsKey]) badOptionsKey.push(conf.key + '.' + f.key + ' -> ' + f.optionsKey);
  }
}
check('所有 selectOrCreate 字段都声明了 optionsKey', noOptionsKey.length === 0, noOptionsKey);
check('optionsKey 都指向已登记的选项集', badOptionsKey.length === 0, badOptionsKey);

/* ------------------------------------------------------------------ *
 * 五、「详情可见」与「表单可见」一致性检查（防同类 bug 再发生）
 *
 * 规则：formHidden 的字段，要么 hideInDetail（两边都看不到，一致），
 *       要么必须写 formHiddenReason 说明为什么只藏表单。
 *       —— 什么都不写就藏表单，正是这次用户报的问题。
 * ------------------------------------------------------------------ */
function findUnjustifiedFields(list) {
  const out = [];
  for (const conf of list) {
    for (const f of conf.fields || []) {
      if (!f.formHidden) continue;
      if (f.hideInDetail) continue;
      if (String(f.formHiddenReason || '').trim()) continue;
      out.push(conf.key + '.' + f.key);
    }
  }
  return out;
}

const unjustified = findUnjustifiedFields(COLLECTIONS);
check('formHidden 字段都有 hideInDetail 或 formHiddenReason（详情/表单一致）', unjustified.length === 0, unjustified);
check(
  '已修复的 module 不在问题清单里',
  unjustified.indexOf('apis.module') < 0,
  unjustified
);
check(
  '同步镜像字段都写明了原因（数量够）',
  COLLECTIONS.reduce(
    (n, c) => n + c.fields.filter((f) => f.formHidden && String(f.formHiddenReason || '').trim()).length,
    0
  ) >= 10,
  COLLECTIONS.reduce((n, c) => n + c.fields.filter((f) => f.formHidden && f.formHiddenReason).length, 0)
);
// 反向验证：故意造一个「只藏表单、不说明」的字段，检查器必须抓出来
const fabricated = [{ key: 'demo', fields: [{ key: 'ghost', type: 'text', formHidden: true }] }];
const fabricatedHit = findUnjustifiedFields(fabricated);
check(
  '反向验证：检查器能抓住合成的「只藏表单」字段',
  fabricatedHit.length === 1 && fabricatedHit[0] === 'demo.ghost',
  fabricatedHit
);

/* ------------------------------------------------------------------ *
 * 六、RecordForm：selectOrCreate 用 AutoComplete + 失焦补选项
 * ------------------------------------------------------------------ */
const formSrc = readSrc('src/components/RecordForm.tsx');
const caseAt = formSrc.indexOf("case 'selectOrCreate'");
const nextCaseAt = formSrc.indexOf("case 'multiselect'", caseAt);
const branch = caseAt >= 0 && nextCaseAt > caseAt ? formSrc.slice(caseAt, nextCaseAt) : '';

check('RecordForm 有 selectOrCreate 分支', caseAt >= 0, 'no case');
check('selectOrCreate 用 AutoComplete 渲染（可输入 + 有下拉）', /<AutoComplete/.test(branch), branch.slice(0, 120));
check('AutoComplete 绑了候选 options', /options=\{candidates\}/.test(branch), 'no options');
check('AutoComplete 的 onChange 直接写回字段值', /onChange=\{\(val\) => set\(f\.key, val\)\}/.test(branch), 'no onChange');
check('AutoComplete 可清空（allowClear）', /allowClear/.test(branch), 'no allowClear');
check(
  'AutoComplete 有大小写不敏感的 filterOption',
  /filterOption=/.test(branch) && /toLowerCase\(\)/.test(branch),
  'no filterOption'
);
check(
  '只在 onBlur 触发自动补选项集（不边敲边存）',
  /onBlur=\{\(\) => rememberOption\(f, data\[f\.key\]\)\}/.test(branch),
  'no onBlur'
);
check('selectOrCreate 的 onChange 里没有 saveOptions（防止碎词）', !/saveOptions/.test(branch), 'saveOptions in branch');
check(
  '保存记录时兜一次自动补（输入完直接点保存也收进去）',
  /if \(f\.type === 'selectOrCreate'\) await rememberOption\(f, payload\[f\.key\]\)/.test(formSrc),
  'no flush on save'
);
check('新值追加走 appendOptionValue（和老数据同一套逻辑）', /appendOptionValue\(/.test(formSrc), 'not using helper');
check('自动补成功后刷新本地 options', /setOpts\(\(prev\) =>/.test(formSrc), 'no setOpts');
check('自动补成功后同步进程内缓存', /mergeOptionCache\(/.test(formSrc), 'no mergeOptionCache');
check(
  '当前值（老数据自由文本）用 withCurrentOption 补进候选',
  /withCurrentOption\(fieldOptions\(f, opts\), v\)/.test(formSrc),
  'no withCurrentOption'
);

/* ------------------------------------------------------------------ *
 * 七、OptionEditor：两个管理区 + 删除提示
 * ------------------------------------------------------------------ */
const editorSrc = readSrc('src/components/OptionEditor.tsx');
check('OptionEditor 有「接口模块」管理区', /title: '接口模块'/.test(editorSrc), 'no module group');
check('OptionEditor 有「页面项目」管理区', /title: '页面项目'/.test(editorSrc), 'no project group');
check(
  '两个管理区分别挂到 module / project 选项集',
  /key: 'module'/.test(editorSrc) && /key: 'project'/.test(editorSrc),
  'keys not wired'
);
check(
  '复用 opt-row 行渲染（5 组以上）',
  (editorSrc.match(/className="opt-row"/g) || []).length >= 5,
  (editorSrc.match(/className="opt-row"/g) || []).length
);
check('管理区支持改名（Input 改行内值）', /next\[i\] = e\.target\.value/.test(editorSrc), 'no rename');
check(
  '删除前统计有多少条记录在用（只读记录）',
  /countUsage\(/.test(editorSrc) && /api\.records\(/.test(editorSrc),
  'no usage count'
);
check(
  '删除模块的提示文案正确（条数 + 不改记录）',
  /有 \$\{n\} 条接口用了这个模块，删除选项不会改它们的值/.test(editorSrc),
  'module warning missing'
);
check(
  '删除项目的提示文案正确（条数 + 不改记录）',
  /有 \$\{n\} 个页面用了这个项目，删除选项不会改它们的值/.test(editorSrc),
  'project warning missing'
);
check(
  '删除选项不会自动改用户记录（编辑器里没有 saveRecord / removeRecord）',
  !/saveRecord/.test(editorSrc) && !/removeRecord/.test(editorSrc),
  'touches records'
);

/* ------------------------------------------------------------------ *
 * 七-B、v0.55：模块 / 项目搬进功能页（OptionEditor 单套件模式）
 *
 * 真踩过的回归：把两套的显示条件写成 `only === 'project' ? null : …`，
 * 于是「不传 only」的设置页反而把两套都渲染出来了。这里把条件钉死。
 * ------------------------------------------------------------------ */
check('OptionEditor 支持 only: module | project 参数', /only\?:\s*'module'\s*\|\s*'project'/.test(editorSrc), 'no only prop');
check(
  'only 模式只渲染对应的那一套（不是「不是另一个就渲染」）',
  /only === 'module' \? renderStringGroup\(\{/.test(editorSrc) && /only === 'project' \? renderStringGroup\(\{/.test(editorSrc),
  'only gating wrong'
);
check(
  '默认模式（设置页）只渲染环境 / 角色 / 标签，不再出模块 / 项目',
  /only \? null : \(/.test(editorSrc) && !/only === 'project' \? null/.test(editorSrc) && !/only === 'module' \? null/.test(editorSrc),
  'default mode still renders module/project'
);

const settingsSrc = readSrc('src/pages/SettingsPage.tsx');
check(
  '设置页文案不再声称模块 / 项目在这里维护',
  !/「环境」「角色 \/ 权限」「标签」「接口模块」「页面项目」/.test(settingsSrc),
  'old settings copy still present'
);
check(
  '设置页文案指向各自功能页的 ⋯ → 管理模块 / 管理项目',
  /已经搬回各自的功能页/.test(settingsSrc) && /管理模块…/.test(settingsSrc) && /管理项目…/.test(settingsSrc),
  'no pointer to feature pages'
);

const collectionSrc = readSrc('src/components/CollectionPage.tsx');
/** 去掉注释再做「不写死集合 key」的守卫：注释里正举着反例 */
const collectionCode = collectionSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check(
  '集合页 ⋯ 菜单有「管理模块…」和「管理项目…」',
  /module: '管理模块…'/.test(collectionSrc) && /project: '管理项目…'/.test(collectionSrc),
  'no manage menu labels'
);
check(
  '管理弹窗只嵌 OptionEditor 的那一套（only={manageKind}）',
  /<OptionEditor only=\{manageKind\}/.test(collectionSrc),
  'modal not using only mode'
);
check(
  '管理入口按字段声明出现（不写死 conf.key === apis/pages）',
  /f\.optionsKey === 'module' \|\| f\.optionsKey === 'project'/.test(collectionCode) && !/conf\.key === 'apis'/.test(collectionCode),
  'manage entry hardcoded by collection key'
);
check(
  '「⋯」菜单里有录制 / 解析语言三项（Python / pytest / Java）',
  /RECORD_LANG_OPTIONS\.map/.test(collectionSrc) && /codegen:/.test(collectionSrc),
  'no language menu'
);

/* ------------------------------------------------------------------ *
 * 八、空值显示：列表 / 详情都是占位符
 * ------------------------------------------------------------------ */
const detailSrc = readSrc('src/components/RecordDetail.tsx');
const listSrc = readSrc('src/components/CollectionPage.tsx');
check(
  '详情页空值渲染占位符（页面项目留空也不会空着）',
  /if \(raw === undefined \|\| raw === null \|\| raw === ''\)/.test(detailSrc) &&
    /<span className="muted">—<\/span>/.test(detailSrc),
  'detail empty render missing'
);
check(
  '列表页空值渲染占位符（投影到列表的 project 同样）',
  /value === undefined \|\| value === null \|\| value === ''\) return <span className="muted">—<\/span>/.test(listSrc),
  'list empty render missing'
);

/* ------------------------------------------------------------------ *
 * 九、纯函数：新值追加 / 老数据兼容（直接转译 src/options.ts 来测）
 * ------------------------------------------------------------------ */
function loadOptionsModule() {
  const src = readSrc('src/options.ts');
  // 去掉 import（api / collections 用桩替代），再把 export 函数改成普通函数
  const body = src
    .replace(/^import .*$/gm, '')
    .replace(/^export async function/gm, 'async function')
    .replace(/^export function/gm, 'function');
  const prelude =
    'const OPTION_SETS = require(' +
    JSON.stringify(path.join(ROOT, 'shared', 'collections.js')) +
    ').OPTION_SETS;\n' +
    'const api = { getOptions: async () => (globalThis.__optStub || {}) };\n';
  const code =
    prelude +
    body +
    '\nmodule.exports = { appendOptionValue, withCurrentOption, fieldOptions, loadOptions, getOptionsSync };\n';
  const out = esbuild.transformSync(code, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
  return mod.exports;
}

const optsMod = loadOptionsModule();

// 9.1 追加
const appendFromEmpty = optsMod.appendOptionValue(undefined, '订单');
check('追加：空列表也能加（undefined 不崩）', JSON.stringify(appendFromEmpty) === JSON.stringify(['订单']), appendFromEmpty);
const appendToList = optsMod.appendOptionValue(['订单'], '退款');
check('追加：新值接在末尾', JSON.stringify(appendToList) === JSON.stringify(['订单', '退款']), appendToList);
const appendDup = optsMod.appendOptionValue(['订单'], '订单');
check('追加：已存在返回 null（不重复保存）', appendDup === null, appendDup);
const appendTrimDup = optsMod.appendOptionValue(['订单'], '  订单  ');
check('追加：前后空格不会造出重复项', appendTrimDup === null, appendTrimDup);
check('追加：空值返回 null', optsMod.appendOptionValue(['订单'], '') === null);
check('追加：纯空格返回 null', optsMod.appendOptionValue([], '   ') === null);
const appendObj = optsMod.appendOptionValue([{ value: 'test', label: '测试', color: 'green' }], '预发');
check(
  '追加：对象型选项集（环境）补成同构对象，不破坏 value/label/color',
  Array.isArray(appendObj) &&
    appendObj.length === 2 &&
    appendObj[0].value === 'test' &&
    appendObj[1].value === '预发' &&
    appendObj[1].label === '预发' &&
    appendObj[1].color === 'default',
  appendObj
);
const appendSrc = ['订单'];
optsMod.appendOptionValue(appendSrc, '退款');
check('追加：不改原数组（纯函数）', appendSrc.length === 1, appendSrc);

// 9.2 老数据自由文本能进候选
const legacy = optsMod.withCurrentOption([{ value: '订单', label: '订单' }], '老模块');
check(
  '老数据：不在选项集里的自由文本会补到候选最前面',
  legacy.length === 2 && legacy[0].value === '老模块' && legacy[0].label === '老模块',
  legacy
);
const existed = optsMod.withCurrentOption([{ value: '订单', label: '订单' }], '订单');
check('老数据：已经在候选里就不重复补', existed.length === 1, existed);
check('老数据：空值不加候选', optsMod.withCurrentOption([{ value: '订单' }], '').length === 1);
check(
  '老数据：模块字段能拿到补好的候选（fieldOptions + withCurrentOption）',
  (function () {
    const cand = optsMod.withCurrentOption(
      optsMod.fieldOptions(moduleField, { module: ['订单'], project: [] }),
      '导入模块'
    );
    return cand.some((o) => o.value === '导入模块') && cand.some((o) => o.value === '订单');
  })(),
  'legacy candidate missing'
);

// 9.3 读配置：新选项集也要读进来
const main = async () => {
  globalThis.__optStub = { module: ['订单'], project: ['OTA-automation'] };
  const loaded = await optsMod.loadOptions(true);
  check(
    'loadOptions 读到 module 选项集',
    JSON.stringify(loaded.module) === JSON.stringify(['订单']),
    loaded.module
  );
  check(
    'loadOptions 读到 project 选项集',
    JSON.stringify(loaded.project) === JSON.stringify(['OTA-automation']),
    loaded.project
  );

  globalThis.__optStub = {};
  const empty = await optsMod.loadOptions(true);
  check('没配置过时 module 是空数组', Array.isArray(empty.module) && empty.module.length === 0, empty.module);
  check('没配置过时 project 是空数组', Array.isArray(empty.project) && empty.project.length === 0, empty.project);
  check('环境仍保留 4 个默认项（老行为不变）', (empty.env || []).length === 4, (empty.env || []).length);

  globalThis.__optStub = { env: [], role: [], module: [], project: [] };
  const blank = await optsMod.loadOptions(true);
  check('环境存成空数组时退回默认（不能被清空）', (blank.env || []).length === 4, (blank.env || []).length);
  check('角色可以是空数组（听用户的，不硬塞默认值）', Array.isArray(blank.role) && blank.role.length === 0, blank.role);

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter((r) => !r.ok);
  console.log('===== 接口模块 / 页面项目测试 =====');
  for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});