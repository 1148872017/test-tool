/* 变量说明表格：解析 / 序列化 / 兼容旧格式 */
const path = require('path');
const Module = require('module');

// VarsEditor.tsx 是 TSX，测试里只测纯函数部分（parseVars / serializeVars）
// 用 esbuild 现场转译成 CJS
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
const fs = require('fs');

const tsx = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'VarsEditor.tsx'), 'utf8');
// 只保留纯函数部分（去掉 React 组件）
const pure = tsx
  .replace(/^import .*$/gm, '')
  .replace(/export default function VarsEditor[\s\S]*$/, '')
  .replace(/export function/g, 'function');

const code = pure + '\nmodule.exports = { parseVars, serializeVars };';
const out = esbuild.transformSync(code, { loader: 'tsx', format: 'cjs' });
const mod = { exports: {} };
new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
const { parseVars, serializeVars } = mod.exports;

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 新格式（JSON）---------- */
const json = JSON.stringify([
  { name: 'orderNo', value: 'A001', desc: '订单号' },
  { name: 'today', value: '', desc: '今天' }
]);
const r1 = parseVars(json);
check('JSON：2 行', r1.length === 2, r1.length);
check('JSON：name 正确', r1[0].name === 'orderNo' && r1[1].name === 'today', r1.map((r) => r.name));
check('JSON：value 正确', r1[0].value === 'A001' && r1[1].value === '', r1.map((r) => r.value));
check('JSON：desc 正确', r1[0].desc === '订单号', r1[0].desc);

/* ---------- 2. 旧格式（纯文本）---------- */
const old1 = '{{orderNo}} = 订单号；{{today}} = 今天';
const r2 = parseVars(old1);
check('旧格式：2 行', r2.length === 2, r2.length);
check('旧格式：name 正确', r2[0].name === 'orderNo' && r2[1].name === 'today', r2.map((r) => r.name));
check('旧格式：desc 正确', r2[0].desc === '订单号' && r2[1].desc === '今天', r2.map((r) => r.desc));
check('旧格式：value 为空', r2[0].value === '', r2[0].value);

const old2 = '{{a}} = 说明A\n{{b}} = 说明B';
const r3 = parseVars(old2);
check('旧格式：换行分隔', r3.length === 2, r3.length);

const old3 = '{{onlyName}}';
const r4 = parseVars(old3);
check('旧格式：只有变量名', r4.length === 1 && r4[0].name === 'onlyName' && r4[0].desc === '', r4);

/* ---------- 3. 边界 ---------- */
check('空字符串返回空数组', parseVars('').length === 0);
check('null 不崩', parseVars(null).length === 0);
check('undefined 不崩', parseVars(undefined).length === 0);
check('纯文本无变量返回空', parseVars('select 1 from t').length === 0);
check('坏 JSON 走旧格式', parseVars('[{bad').length === 0);

/* ---------- 4. 序列化 ---------- */
const s1 = serializeVars([{ name: 'a', value: '1', desc: 'x' }]);
check('序列化：是 JSON', s1.startsWith('['), s1);
check('序列化：能反解', parseVars(s1)[0].name === 'a', parseVars(s1));
check('序列化：空数组返回空串', serializeVars([]) === '', serializeVars([]));
check('序列化：过滤空 name', serializeVars([{ name: '', value: '1', desc: 'x' }]) === '', serializeVars([{ name: '', value: '1', desc: 'x' }]));

/* ---------- 5. 往返 ---------- */
const rows = [{ name: 'a', value: '1', desc: 'A' }, { name: 'b', value: '', desc: 'B' }];
const round = parseVars(serializeVars(rows));
check('往返：长度一致', round.length === 2, round.length);
check('往返：内容一致', round[0].name === 'a' && round[1].desc === 'B', round);

const failed = results.filter((r) => !r.ok);
console.log('===== 变量表格测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
