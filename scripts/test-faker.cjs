/* v0.42.0：造数类型扩充（边界值 / 车牌号 / MAC 地址） */
const fs = require('fs');
const path = require('path');

const faker = require('../shared/faker.js');
const { TYPES, BOUNDARY_VALUES, genOne, genColumn, genRows, genBoundary, genPlate, genMac } = faker;

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ============================================================
 * 1. 类型清单
 * ============================================================ */
check('TYPES 共 14 种', TYPES.length === 14, TYPES.length);
check('TYPES 每项有 value/label/fn', TYPES.every((t) => t.value && t.label && typeof t.fn === 'function'), TYPES.map((t) => t.value));

{
  const byValue = new Map(TYPES.map((t) => [t.value, t]));
  check('新增 boundary（边界值）', byValue.has('boundary') && byValue.get('boundary').label === '边界值', [...byValue.keys()]);
  check('新增 plate（车牌号）', byValue.has('plate') && byValue.get('plate').label === '车牌号', [...byValue.keys()]);
  check('新增 mac（MAC 地址）', byValue.has('mac') && byValue.get('mac').label === 'MAC 地址', [...byValue.keys()]);
}

/* ============================================================
 * 2. 边界值：固定池 + 有序循环
 * ============================================================ */
check('boundary 第 1 条是空串', genBoundary(0) === '', genBoundary(0));
check('boundary 值池 ≥ 15 个', BOUNDARY_VALUES.length >= 15, BOUNDARY_VALUES.length);
check('boundary 含 int32 最大值', BOUNDARY_VALUES.includes('2147483647'), 'no int32 max');
check('boundary 含 int32 溢出值', BOUNDARY_VALUES.includes('2147483648'), 'no int32 max+1');
check('boundary 含 1000 位超长串', BOUNDARY_VALUES.includes('a'.repeat(1000)), 'no long str');
check('boundary 含字面量 null/undefined', BOUNDARY_VALUES.includes('null') && BOUNDARY_VALUES.includes('undefined'), 'no literal');
check('boundary 含中英混排与 emoji', BOUNDARY_VALUES.includes('测试Test123') && BOUNDARY_VALUES.includes('😀😀😀'), 'missing');
check('boundary 含全角字符', BOUNDARY_VALUES.includes('ＡＢＣ１２３'), 'no fullwidth');
check(
  'boundary 只有单条 SQL 边界，不含整段载荷',
  BOUNDARY_VALUES.includes("' OR '1'='1") && !BOUNDARY_VALUES.some((v) => /DROP|UNION|--/i.test(v)),
  BOUNDARY_VALUES.filter((v) => /DROP|UNION|--/i.test(v))
);

{
  // 核心：genColumn 必须按行推进，不能每行都回到第 0 个
  const col = genColumn('boundary', 5).map((r) => r[0]);
  check('genColumn(boundary,5) 前 5 条互不相同', new Set(col).size === 5, col);
  check('genColumn(boundary,5) 与值池顺序一致', JSON.stringify(col) === JSON.stringify(BOUNDARY_VALUES.slice(0, 5)), col);

  const all = genColumn('boundary', BOUNDARY_VALUES.length).map((r) => r[0]);
  check('循环一整圈能取满值池', JSON.stringify(all) === JSON.stringify(BOUNDARY_VALUES), all.length);
  check('索引越界会回绕', genBoundary(BOUNDARY_VALUES.length + 1) === BOUNDARY_VALUES[1], genBoundary(BOUNDARY_VALUES.length + 1));
  check('genOne 支持索引参数', genOne('boundary', {}, 3) === BOUNDARY_VALUES[3], genOne('boundary', {}, 3));
  check('genOne 不传索引时退回第 1 个', genOne('boundary') === BOUNDARY_VALUES[0], genOne('boundary'));
}

/* ============================================================
 * 3. 车牌号：普通 + 新能源
 * ============================================================ */
const PROV = '[京沪粤浙苏川鄂湘鲁豫]';
const LETTER = '[A-HJ-NP-Z]';
const RE_PLATE_NORMAL = new RegExp('^' + PROV + LETTER + '\\d{5}$');
const RE_PLATE_NEW = new RegExp('^' + PROV + LETTER + '[DF]\\d{5}$');

{
  const plates = Array.from({ length: 300 }, () => genPlate());
  const normal = plates.filter((p) => RE_PLATE_NORMAL.test(p));
  const energy = plates.filter((p) => RE_PLATE_NEW.test(p));

  check('车牌普通格式正确（京A12345）', normal.length > 0, plates.slice(0, 5));
  check('车牌新能源格式正确（沪AD12345）', energy.length > 0, plates.slice(0, 5));
  check('车牌全部落在两种格式内', normal.length + energy.length === plates.length, plates.filter((p) => !RE_PLATE_NORMAL.test(p) && !RE_PLATE_NEW.test(p)));
  check('车牌省份简称合法', plates.every((p) => '京沪粤浙苏川鄂湘鲁豫'.includes(p[0])), plates.slice(0, 5));
  // 注意：只生成一次再判断，别在条件里重复调用随机函数（会抽到不同的值）
  const onePlate = genOne('plate');
  check('genOne 能出车牌', RE_PLATE_NORMAL.test(onePlate) || RE_PLATE_NEW.test(onePlate), onePlate);
}

/* ============================================================
 * 4. MAC 地址
 * ============================================================ */
{
  const RE_MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
  const macs = Array.from({ length: 300 }, () => genMac());
  check('MAC 格式正确（AA:BB:CC:DD:EE:FF）', macs.every((m) => RE_MAC.test(m)), macs.filter((m) => !RE_MAC.test(m)).slice(0, 3));
  check('MAC 长度 17、6 组', macs.every((m) => m.length === 17 && m.split(':').length === 6), macs[0]);
  check('MAC 全部大写', macs.every((m) => m === m.toUpperCase()), macs[0]);
  const oneMac = genOne('mac');
  check('genOne 能出 MAC', RE_MAC.test(oneMac), oneMac);
  // 随机性：300 条里不该全是同一个值
  check('MAC 是随机生成', new Set(macs).size > 250, new Set(macs).size);
}

/* ============================================================
 * 5. 多字段组合 / 回归老类型
 * ============================================================ */
{
  const fields = [
    { name: 'edge', type: 'boundary' },
    { name: 'plate', type: 'plate' },
    { name: 'mac', type: 'mac' },
    { name: 'name', type: 'name' }
  ];
  const rows = genRows(fields, 4);
  check('多字段 4 行 4 列', rows.length === 4 && rows[0].length === 4, rows.length);
  check(
    '多字段里 boundary 也按行推进',
    rows.map((r) => r[0]).join('|') === BOUNDARY_VALUES.slice(0, 4).join('|'),
    rows.map((r) => r[0])
  );
  check('多字段里 mac 列格式正确', rows.every((r) => /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(r[2])), rows.map((r) => r[2]));
  check('多字段里固定值仍优先', genRows([{ name: 'a', type: 'plate', fixed: 'FIX' }], 2).every((r) => r[0] === 'FIX'), 'fixed broken');
  check('空字段列表仍返回空数组', genRows([], 3).length === 0, 'not empty');
}

{
  const OLD = ['name', 'phone', 'email', 'idcard', 'bank', 'address', 'company', 'uuid', 'date', 'amount', 'order'];
  const bad = OLD.filter((t) => typeof genOne(t) !== 'string' || genOne(t).length === 0);
  check('原有 11 种类型仍能生成', bad.length === 0, bad);
  const phoneCol = genColumn('phone', 5);
  const nameCol = genColumn('name', 7);
  check('手机号格式仍正确', phoneCol.every((r) => /^1\d{10}$/.test(r[0])), phoneCol);
  const oneDate = genOne('date', { from: '2026-01-01', to: '2026-12-31' });
  check('日期仍落在指定范围', oneDate.startsWith('2026-'), oneDate);
  check('genColumn 行数正确', nameCol.length === 7, nameCol.length);
}

/* ============================================================
 * 6. 前端接线（只读源码断言，不改逻辑）
 * ============================================================ */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'DataTool.tsx'), 'utf8');
  check('下拉框直接读 TYPES（没写死列表）', /options=\{TYPES\}/.test(src), 'hardcoded list');
  check('DataTool 把行号传给 fn', /def\.fn\(index\)/.test(src) && /r\.fn\(i\)/.test(src), 'no index');
  // v0.41.2 的大数量导出逻辑必须原样保留
  check('大数量阈值/预览常量未被改动', /LARGE_THRESHOLD = 200/.test(src) && /PREVIEW_ROWS = 200/.test(src), 'threshold changed');
  check('generateToFile 仍在', /generateToFile/.test(src), 'no generateToFile');

  /**
   * 14 个类型必须一次全渲染出来。
   *
   * rc-select 默认虚拟滚动：listHeight=200 / listItemHeight=20 → 刚好显示 10 行，
   * 第 11~14 项（boundary / plate / mac 等）要滚动才看得到，用户会以为功能缺失。
   * 14 项虚拟化没有任何收益，两处 TYPES 下拉都必须 virtual={false}。
   */
  const virtualOff = src.match(/options=\{TYPES\}[\s\S]{0,120}?virtual=\{false\}/g) || [];
  check('单类型下拉 virtual={false}', virtualOff.length === 2, virtualOff.length + ' 处');
  check('TYPES 下拉的虚拟化全部关掉（没有漏网的）', (src.match(/virtual=\{false\}/g) || []).length === 2, (src.match(/virtual=\{false\}/g) || []).length);
}

const failed = results.filter((r) => !r.ok);
console.log('===== v0.42.0 造数类型扩充测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);