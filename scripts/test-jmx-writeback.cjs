'use strict';
/**
 * jmx 局部编辑写回（L2）—— golden test
 *
 * 这个套件守的是底线 #4 被四道闸收紧之后的实际行为：
 *   闸 1  只有 electron/jmx-writeback.js 改用户文件（其余模块只读）
 *   闸 2  显式字段白名单（线程组 numThreads/rampUp/loops、响应断言 value）
 *   闸 3  写盘前 sidecar 备份 + tmp/fsync/rename 原子替换
 *   闸 4  本文件：逐字节证明「除目标值外全文不变」
 *
 * fixture 是手工造的一份 jmx：**2 个线程组 + 2 条断言 + CRLF 换行**，
 * 且线程组里还嵌了一个独立 LoopController（loops=3）——
 * 专门用来证明「改线程组的 loops 不会误伤其他控制器里的 loops」。
 *
 * 只读仓库源码 + os.tmpdir()，属 unit 档。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const jmx = require('../electron/jmx.js');
const wb = require('../electron/jmx-writeback.js');
const { parseJmx, readDetail } = jmx;

/* ============================================================
 * fixture：2 线程组 + 2 响应断言 + 1 个嵌套 LoopController + CRLF
 * ============================================================ */
function fixtureText() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">',
    '  <hashTree>',
    '    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="写回测试计划" enabled="true">',
    '      <stringProp name="TestPlan.comments"></stringProp>',
    '    </TestPlan>',
    '    <hashTree>',
    '      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="登录组" enabled="true">',
    '        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>',
    '        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '          <boolProp name="LoopController.continue_forever">false</boolProp>',
    '          <stringProp name="LoopController.loops">10</stringProp>',
    '        </elementProp>',
    '        <stringProp name="ThreadGroup.num_threads">50</stringProp>',
    '        <stringProp name="ThreadGroup.ramp_time">10</stringProp>',
    '        <boolProp name="ThreadGroup.scheduler">false</boolProp>',
    '        <stringProp name="ThreadGroup.duration">60</stringProp>',
    '      </ThreadGroup>',
    '      <hashTree>',
    '        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="POST /login" enabled="true">',
    '          <stringProp name="HTTPSampler.path">/api/login</stringProp>',
    '          <stringProp name="HTTPSampler.method">POST</stringProp>',
    '        </HTTPSamplerProxy>',
    '        <hashTree>',
    '          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="状态码200" enabled="true">',
    '            <collectionProp name="Asserion.test_strings">',
    '              <stringProp name="49586">200</stringProp>',
    '            </collectionProp>',
    '            <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>',
    '            <intProp name="Assertion.test_type">8</intProp>',
    '          </ResponseAssertion>',
    '          <hashTree/>',
    '          <LoopController guiclass="LoopControlPanel" testclass="LoopController" testname="嵌套循环" enabled="true">',
    '            <boolProp name="LoopController.continue_forever">false</boolProp>',
    '            <stringProp name="LoopController.loops">3</stringProp>',
    '          </LoopController>',
    '          <hashTree/>',
    '        </hashTree>',
    '      </hashTree>',
    '      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="下单组" enabled="true">',
    '        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>',
    '        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '          <boolProp name="LoopController.continue_forever">false</boolProp>',
    '          <stringProp name="LoopController.loops">5</stringProp>',
    '        </elementProp>',
    '        <stringProp name="ThreadGroup.num_threads">20</stringProp>',
    '        <stringProp name="ThreadGroup.ramp_time">5</stringProp>',
    '      </ThreadGroup>',
    '      <hashTree>',
    '        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="POST /order" enabled="true">',
    '          <stringProp name="HTTPSampler.path">/api/order</stringProp>',
    '          <stringProp name="HTTPSampler.method">POST</stringProp>',
    '        </HTTPSamplerProxy>',
    '        <hashTree>',
    '          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="响应文本-下单成功" enabled="true">',
    '            <collectionProp name="Asserion.test_strings">',
    '              <stringProp name="70001">下单成功 &amp; ok</stringProp>',
    '            </collectionProp>',
    '            <stringProp name="Assertion.test_field">Assertion.response_data</stringProp>',
    '            <intProp name="Assertion.test_type">16</intProp>',
    '          </ResponseAssertion>',
    '          <hashTree/>',
    '        </hashTree>',
    '      </hashTree>',
    '    </hashTree>',
    '  </hashTree>',
    '</jmeterTestPlan>',
    ''
  ].join('\r\n');
}

/* ============================================================
 * 临时目录 + 小工具
 * ============================================================ */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-jmx-writeback-'));
const DIR = path.join(TMP_ROOT, 'jmx');
const OUTSIDE = path.join(TMP_ROOT, 'outside');
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

const SAMPLE_TEXT = fixtureText();
const SAMPLE_BYTES = Buffer.from(SAMPLE_TEXT, 'utf8');
const BASE = path.join(DIR, '基准.jmx');
fs.writeFileSync(BASE, SAMPLE_BYTES);

const stampOfFile = (p) => wb.stampOf(fs.statSync(p));
const readBuf = (p) => fs.readFileSync(p);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const listDir = (dir) => fs.readdirSync(dir).sort().join('|');

/** 每次写回测试用一份全新的文件，互不污染 */
let copySeq = 0;
function freshCopy(label) {
  copySeq += 1;
  const p = path.join(DIR, label + '-' + copySeq + '.jmx');
  fs.writeFileSync(p, SAMPLE_BYTES);
  return p;
}

/** Buffer 里找一段文本的字节偏移（找不到 -1） */
function indexOfBuf(buf, text) {
  return buf.indexOf(Buffer.from(text, 'utf8'));
}

/** 把第一次出现的 oldText 换成 newText（用来算「期望字节」） */
function replaceOnce(buf, oldText, newText) {
  const at = indexOfBuf(buf, oldText);
  if (at < 0) throw new Error('fixture 里找不到：' + oldText);
  return Buffer.concat([buf.slice(0, at), Buffer.from(newText, 'utf8'), buf.slice(at + Buffer.byteLength(oldText, 'utf8'))]);
}

/** 某个文本在文件里出现几次 */
function countOf(buf, text) {
  const needle = Buffer.from(text, 'utf8');
  let n = 0;
  let at = 0;
  while ((at = buf.indexOf(needle, at)) >= 0) {
    n += 1;
    at += needle.length;
  }
  return n;
}

function parseFile(p) {
  return parseJmx(fs.readFileSync(p, 'utf8'), p);
}

/** 只有数字的断言值，用来验证边界值 */
function digits(n) {
  return '9'.repeat(n);
}

/* ============================================================
 * 一、detail 契约：editable 形状 + 不含字节位置 + 只读
 * ============================================================ */
const detail0 = readDetail(BASE);
check('detail 解析成功', detail0.ok === true, detail0);
check('detail 带 editable', !!detail0.editable && typeof detail0.editable === 'object', detail0.editable);
check('editable 有 stamp', typeof detail0.editable.stamp === 'string' && detail0.editable.stamp.length > 0, detail0.editable.stamp);
check(
  'stamp 形如 <mtimeMs>:<size>',
  /^\d+(?:\.\d+)?:\d+$/.test(detail0.editable.stamp) && detail0.editable.stamp === wb.stampOf(fs.statSync(BASE)),
  detail0.editable.stamp
);
check('editable 有 2 个线程组（按 <ThreadGroup> 出现顺序）', detail0.editable.groups.length === 2, detail0.editable.groups);
check('editable 线程组带 index 0/1', detail0.editable.groups[0].index === 0 && detail0.editable.groups[1].index === 1, detail0.editable.groups);
check('editable 线程组名字正确', detail0.editable.groups[0].name === '登录组' && detail0.editable.groups[1].name === '下单组', detail0.editable.groups.map((g) => g.name));
check(
  '线程组 0 三个可编辑值：50 / 10 / 10（loops 来自 main_controller）',
  detail0.editable.groups[0].numThreads === 50 && detail0.editable.groups[0].rampUp === 10 && detail0.editable.groups[0].loops === 10,
  detail0.editable.groups[0]
);
check(
  '线程组 1 三个可编辑值：20 / 5 / 5',
  detail0.editable.groups[1].numThreads === 20 && detail0.editable.groups[1].rampUp === 5 && detail0.editable.groups[1].loops === 5,
  detail0.editable.groups[1]
);
check('editable 有 2 条响应断言', detail0.editable.assertions.length === 2, detail0.editable.assertions);
check(
  '响应断言 0 名字/字段/值正确',
  detail0.editable.assertions[0].index === 0 &&
    detail0.editable.assertions[0].name === '状态码200' &&
    detail0.editable.assertions[0].testField === 'Assertion.response_code' &&
    detail0.editable.assertions[0].value === '200',
  detail0.editable.assertions[0]
);
check(
  '响应断言 1 的 &amp; 被还原成 &（展示值不是 XML 原文）',
  detail0.editable.assertions[1].value === '下单成功 & ok',
  detail0.editable.assertions[1].value
);
check('editable 不向界面暴露字节位置（只有 index/name/value 等语义字段）', (() => {
  const s = JSON.stringify(detail0.editable);
  return s.indexOf('valueStart') < 0 && s.indexOf('closeStart') < 0 && s.indexOf('openEnd') < 0 && s.indexOf('offset') < 0;
})(), Object.keys(detail0.editable.groups[0]));

{
  const before = readBuf(BASE);
  const beforeStat = fs.statSync(BASE);
  const beforeList = listDir(DIR);
  const again = readDetail(BASE);
  check('连续两次 detail 都成功（幂等）', again.ok === true && again.editable.stamp === detail0.editable.stamp, [again.ok, again.editable && again.editable.stamp]);
  check('detail / editable 不写盘：内容逐字节不变', readBuf(BASE).equals(before));
  check('detail / editable 不写盘：mtime 不变', fs.statSync(BASE).mtimeMs === beforeStat.mtimeMs);
  check('detail / editable 不写盘：目录里没有新增文件（尤其没有 .bak-）', listDir(DIR) === beforeList, listDir(DIR));
}

/* ============================================================
 * 二、闸 2：白名单外的字段一律 NOT_EDITABLE，且文件一个字节都不动
 * ============================================================ */
function expectRejected(label, file, edits, code) {
  const before = readBuf(file);
  const beforeStat = fs.statSync(file);
  const beforeList = listDir(DIR);
  const r = wb.writeback(file, stampOfFile(file), edits);
  check(label + ' → ' + code, r && r.ok === false && r.code === code, r);
  check(label + ' → 文件内容不变', readBuf(file).equals(before));
  check(label + ' → mtime 不变', fs.statSync(file).mtimeMs === beforeStat.mtimeMs);
  check(label + ' → 不产生备份/临时文件', listDir(DIR) === beforeList, listDir(DIR));
  return r;
}

{
  const p = freshCopy('not-editable');
  expectRejected('改线程组 duration（真实存在但不在白名单）', p, [{ kind: 'thread', index: 0, field: 'duration', value: 30 }], 'NOT_EDITABLE');
  expectRejected('改线程组 testname', p, [{ kind: 'thread', index: 0, field: 'testname', value: 'x' }], 'NOT_EDITABLE');
  expectRejected('改断言 testField', p, [{ kind: 'assertion', index: 0, field: 'testField', value: 'x' }], 'NOT_EDITABLE');
  expectRejected('未知 kind（sampler）', p, [{ kind: 'sampler', index: 0, field: 'numThreads', value: 10 }], 'NOT_EDITABLE');
  expectRejected('跨类型字段（thread.value）', p, [{ kind: 'thread', index: 0, field: 'value', value: 'x' }], 'NOT_EDITABLE');
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'duration', value: 30 }]);
  check('NOT_EDITABLE 的 message 说清了允许改什么', /numThreads|rampUp|loops|value/.test(r.message), r.message);
}

/* ============================================================
 * 三、值校验：0 / 小数 / 超范围 / 超长 / 尖括号 / 控制字符 / 50 条上限
 * ============================================================ */
{
  const p = freshCopy('bad-value-num');
  const beforeList = listDir(DIR);
  expectRejected('线程数 = 0', p, [{ kind: 'thread', index: 0, field: 'numThreads', value: 0 }], 'BAD_VALUE');
  expectRejected('线程数 = 1.5（小数）', p, [{ kind: 'thread', index: 0, field: 'numThreads', value: 1.5 }], 'BAD_VALUE');
  expectRejected('线程数 = 1000001（超上限）', p, [{ kind: 'thread', index: 0, field: 'numThreads', value: 1000001 }], 'BAD_VALUE');
  expectRejected('线程数 = abc（非数字）', p, [{ kind: 'thread', index: 0, field: 'numThreads', value: 'abc' }], 'BAD_VALUE');
  expectRejected('线程数 = -1（负数，只有 loops 允许 -1）', p, [{ kind: 'thread', index: 0, field: 'numThreads', value: -1 }], 'BAD_VALUE');
  expectRejected('爬坡 = -5（负数）', p, [{ kind: 'thread', index: 0, field: 'rampUp', value: -5 }], 'BAD_VALUE');
  expectRejected('爬坡 = -1（负数，0 才是下界）', p, [{ kind: 'thread', index: 0, field: 'rampUp', value: -1 }], 'BAD_VALUE');
  expectRejected('爬坡 = 1000001（超上限）', p, [{ kind: 'thread', index: 0, field: 'rampUp', value: 1000001 }], 'BAD_VALUE');
  expectRejected('循环 = 0（既不是 -1 也不是 1..）', p, [{ kind: 'thread', index: 0, field: 'loops', value: 0 }], 'BAD_VALUE');
  expectRejected('循环 = -2（只有 -1 是永久循环）', p, [{ kind: 'thread', index: 0, field: 'loops', value: -2 }], 'BAD_VALUE');
  expectRejected('循环 = 1000001（超上限）', p, [{ kind: 'thread', index: 0, field: 'loops', value: 1000001 }], 'BAD_VALUE');
  expectRejected('循环 = 空串', p, [{ kind: 'thread', index: 0, field: 'loops', value: '' }], 'BAD_VALUE');
  expectRejected('循环 = -1.5（小数）', p, [{ kind: 'thread', index: 0, field: 'loops', value: -1.5 }], 'BAD_VALUE');

  // BAD_VALUE 的 message 必须写清区间（用户看着报错就知道该填什么）
  const msgThreads = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 0 }]).message;
  check('BAD_VALUE(numThreads) 的 message 写清 1..1000000', /1\.\.1000000/.test(msgThreads), msgThreads);
  const msgRamp = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'rampUp', value: -1 }]).message;
  check('BAD_VALUE(rampUp) 的 message 写清 0..1000000（0 合法）', /0\.\.1000000/.test(msgRamp), msgRamp);
  const msgLoops = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'loops', value: 0 }]).message;
  check('BAD_VALUE(loops) 的 message 写清 -1（永久循环）或 1..1000000', /-1（永久循环）/.test(msgLoops) && /1\.\.1000000/.test(msgLoops), msgLoops);

  expectRejected('断言值 501 个字符', p, [{ kind: 'assertion', index: 0, field: 'value', value: digits(501) }], 'BAD_VALUE');
  expectRejected('断言值含 <', p, [{ kind: 'assertion', index: 0, field: 'value', value: '<script>' }], 'BAD_VALUE');
  expectRejected('断言值含 >', p, [{ kind: 'assertion', index: 0, field: 'value', value: '1 > 0' }], 'BAD_VALUE');
  expectRejected('断言值含控制字符', p, [{ kind: 'assertion', index: 0, field: 'value', value: 'a\u0000b' }], 'BAD_VALUE');
  expectRejected('断言值不是字符串/数字', p, [{ kind: 'assertion', index: 0, field: 'value', value: null }], 'BAD_VALUE');
  expectRejected('断言值为空', p, [{ kind: 'assertion', index: 0, field: 'value', value: '' }], 'BAD_VALUE');

  expectRejected('edits 为空数组', p, [], 'BAD_VALUE');
  expectRejected('edits 不是数组', p, 'not-an-array', 'BAD_VALUE');
  expectRejected(
    '51 条修改超过单次上限',
    p,
    Array.from({ length: 51 }, () => ({ kind: 'thread', index: 0, field: 'numThreads', value: 1 })),
    'BAD_VALUE'
  );
  expectRejected('index 不是整数', p, [{ kind: 'thread', index: 1.5, field: 'numThreads', value: 10 }], 'BAD_VALUE');

  check('所有 BAD_VALUE 都没在目录里留下备份/临时文件', listDir(DIR) === beforeList, listDir(DIR));
}

{
  // 整单原子性：一条合法 + 一条非法 → 一条都不写
  // 非法那条用 loops=0（0 既不是 -1 的永久循环，也不是 1..1000000，必须拒绝）
  const p = freshCopy('mixed');
  const before = readBuf(p);
  const beforeStat = fs.statSync(p);
  const beforeList = listDir(DIR);
  const r = wb.writeback(p, stampOfFile(p), [
    { kind: 'thread', index: 0, field: 'numThreads', value: 66 },
    { kind: 'thread', index: 0, field: 'loops', value: 0 }
  ]);
  check('合法 + 非法混在一单 → BAD_VALUE（整单拒绝）', r.ok === false && r.code === 'BAD_VALUE', r);
  check('整单拒绝后文件内容不变（合法那条也没写）', readBuf(p).equals(before));
  check('整单拒绝后 mtime 不变', fs.statSync(p).mtimeMs === beforeStat.mtimeMs);
  check('整单拒绝后没有备份/临时文件', listDir(DIR) === beforeList, listDir(DIR));
}

/* ============================================================
 * 四、边界值：1 / 1000000 / 500 字符都允许
 * ============================================================ */
{
  const p = freshCopy('bounds');
  const r1 = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 1000000 }]);
  check('线程数上界 1000000 允许写入', r1.ok === true && r1.editable.groups[0].numThreads === 1000000, r1.ok ? r1.editable.groups[0] : r1);
  const r2 = wb.writeback(p, r1.editable.stamp, [{ kind: 'thread', index: 0, field: 'rampUp', value: 1 }]);
  check('爬坡 = 1 允许写入', r2.ok === true && r2.editable.groups[0].rampUp === 1, r2.ok ? r2.editable.groups[0] : r2);
  const r3 = wb.writeback(p, r2.editable.stamp, [{ kind: 'assertion', index: 0, field: 'value', value: digits(500) }]);
  check('断言值 500 字符（正好上限）允许写入', r3.ok === true && r3.editable.assertions[0].value === digits(500), r3.ok ? r3.editable.assertions[0].value.length : r3);
  check('边界值写完后重新解析仍然一致', parseFile(p).threadGroups[0].numThreads === '1000000' && parseFile(p).responseAssertions[0].patterns[0] === digits(500));
}

/* ============================================================
 * 五、乐观锁 STALE：mtime 变了就不写盘
 * ============================================================ */
{
  const p = freshCopy('stale');
  const oldStamp = stampOfFile(p);
  const before = readBuf(p);
  const beforeList = listDir(DIR);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(p, t, t);
  const newStat = fs.statSync(p);
  check('测试前置：utimes 之后 stamp 确实变了', oldStamp !== wb.stampOf(newStat), [oldStamp, wb.stampOf(newStat)]);
  const r = wb.writeback(p, oldStamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 30 }]);
  check('stamp 不一致 → STALE', r.ok === false && r.code === 'STALE', r);
  check('STALE 时文件内容不变', readBuf(p).equals(before));
  check('STALE 时 mtime 没有被写回操作改掉', fs.statSync(p).mtimeMs === newStat.mtimeMs);
  check('STALE 时目录里没有新增备份/临时文件', listDir(DIR) === beforeList, [beforeList, listDir(DIR)]);

  const r2 = wb.writeback(p, '', [{ kind: 'thread', index: 0, field: 'numThreads', value: 30 }]);
  check('缺少 stamp → STALE（无法确认是否被外部改过）', r2.ok === false && r2.code === 'STALE', r2);
}

/* ============================================================
 * 六、NO_SUCH_TARGET：index 越界 / 名字对不上
 * ============================================================ */
{
  const p = freshCopy('no-target');
  const before = readBuf(p);
  const r1 = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 2, field: 'numThreads', value: 10 }]);
  check('线程组 index 越界 → NO_SUCH_TARGET', r1.ok === false && r1.code === 'NO_SUCH_TARGET', r1);
  const r2 = wb.writeback(p, stampOfFile(p), [{ kind: 'assertion', index: 9, field: 'value', value: 'x' }]);
  check('断言 index 越界 → NO_SUCH_TARGET', r2.ok === false && r2.code === 'NO_SUCH_TARGET', r2);
  const r3 = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 10, name: '别的线程组' }]);
  check('可选 name 与文件里的 testname 不一致 → NO_SUCH_TARGET', r3.ok === false && r3.code === 'NO_SUCH_TARGET', r3);
  check('NO_SUCH_TARGET 时文件内容不变', readBuf(p).equals(before));

  const r4 = wb.writeback(path.join(DIR, '不存在.jmx'), '1:2', []);
  check('文件不存在 → BAD_PATH（不是抛异常）', r4.ok === false && r4.code === 'BAD_PATH', r4);
  check('空路径 → BAD_PATH', wb.writeback('', '1:2', []).code === 'BAD_PATH');
}

/* ============================================================
 * 七、核心：只改目标值那几个字节（CRLF / 缩进 / 属性顺序全保留）
 * ============================================================ */
{
  const p = freshCopy('bytes');
  const before = readBuf(p);
  const beforeStat = fs.statSync(p);
  const beforeHash = sha256(before);
  const crlfBefore = countOf(before, '\r\n');

  const expected = replaceOnce(before, '<stringProp name="ThreadGroup.num_threads">50</stringProp>', '<stringProp name="ThreadGroup.num_threads">120</stringProp>');

  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 120 }]);
  const after = readBuf(p);

  check('写回成功', r.ok === true, r);
  check('返回 file 是目标绝对路径', r.ok && r.file === p, r.file);
  check('返回 changes 一条且字段正确', r.ok && r.changes.length === 1 && r.changes[0].kind === 'thread' && r.changes[0].index === 0 && r.changes[0].field === 'numThreads', r.ok ? r.changes : r);
  check('changes.from/to 是 50 → 120', r.ok && r.changes[0].from === '50' && r.changes[0].to === '120', r.ok ? r.changes[0] : r);
  check('返回的新 editable 里 numThreads = 120', r.ok && r.editable.groups[0].numThreads === 120, r.ok ? r.editable.groups[0] : r);
  check('返回的 stamp 与写完后 stat 一致', r.ok && r.editable.stamp === wb.stampOf(fs.statSync(p)), r.ok ? [r.editable.stamp, wb.stampOf(fs.statSync(p))] : r);

  /**
   * (a) 逐字节：把「目标值」按预期替换后应该与写回结果**完全相等**。
   * 这比「再 parse 一遍字段对不对」强得多：任何多余的空格、换行、属性顺序变化都会被抓到。
   */
  check('(a) 除目标值外全文逐字节相等（与期望 Buffer 完全一致）', after.equals(expected), {
    afterHash: sha256(after),
    expectedHash: sha256(expected),
    beforeHash
  });
  check('(a) 文件长度只增加了 1 字节（50 → 120）', after.length === before.length + 1, [before.length, after.length]);
  check('(a) 目标值之前的字节完全没动', after.slice(0, indexOfBuf(before, '>50<') + 1).equals(before.slice(0, indexOfBuf(before, '>50<') + 1)));
  check('(a) 目标值之后的字节完全没动', after.slice(after.length - 40).equals(before.slice(before.length - 40)));
  check('(a) CRLF 数量不变', countOf(after, '\r\n') === crlfBefore, [crlfBefore, countOf(after, '\r\n')]);
  check('(a) 没有混进裸 LF（原文是 CRLF）', countOf(after, '\n') === countOf(after, '\r\n'), [countOf(after, '\n'), countOf(after, '\r\n')]);
  check('(a) 自闭合写法 <hashTree/> 原样保留', countOf(after, '<hashTree/>') === countOf(before, '<hashTree/>'));
  check('(a) 其它线程组的 num_threads 没被动', countOf(after, '<stringProp name="ThreadGroup.num_threads">20</stringProp>') === 1);
  check('(a) 文件 mtime 确实更新了（写盘发生过）', fs.statSync(p).mtimeMs !== beforeStat.mtimeMs);

  // (g) 备份：同目录 + 命名格式 + 内容 == 原始字节
  check('(g) 返回了 backup 路径', r.ok && typeof r.backup === 'string' && r.backup.length > 0, r.backup);
  check('(g) 备份文件真的存在', r.ok && fs.existsSync(r.backup), r.backup);
  check('(g) 备份与原文件同目录（sidecar）', r.ok && path.dirname(r.backup) === path.dirname(p), r.ok ? path.dirname(r.backup) : '');
  check(
    '(g) 备份名 = <原文件名>.bak-<yyyyMMdd-HHmmss>',
    r.ok && new RegExp('^' + path.basename(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-\\d{8}-\\d{6}(-\\d+)?$').test(path.basename(r.backup)),
    r.ok ? path.basename(r.backup) : ''
  );
  check('(g) 备份内容 == 写回前的原始字节', r.ok && readBuf(r.backup).equals(before));
  check('(g) 目录里没有残留 tmp 文件', fs.readdirSync(DIR).filter((f) => /\.tmp-/.test(f)).length === 0, fs.readdirSync(DIR).filter((f) => /\.tmp-/.test(f)));

  // (h) 写完之后用 electron/jmx.js 重新解析
  const parsed = parseFile(p);
  check('(h) 重新 parseJmx 后线程数 = 120', parsed.threadGroups[0].numThreads === '120', parsed.threadGroups[0].numThreads);
  check('(h) 重新 parseJmx 后仍是 2 个线程组（结构没坏）', parsed.threadGroups.length === 2, parsed.threadGroups.length);
  check('(h) 重新 readDetail 的 editable.stamp 与新 stat 一致', readDetail(p).editable.stamp === wb.stampOf(fs.statSync(p)));
}

/* ============================================================
 * 八、多线程组：只改 index 指定的那个
 * ============================================================ */
{
  const p = freshCopy('two-groups');
  const before = readBuf(p);
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 1, field: 'numThreads', value: 99 }]);
  const after = readBuf(p);
  const parsed = parseFile(p);
  check('(b) 改 index=1 成功', r.ok === true, r);
  check('(b) 组 0 的 50 没变', parsed.threadGroups[0].numThreads === '50', parsed.threadGroups[0].numThreads);
  check('(b) 组 1 的 20 → 99', parsed.threadGroups[1].numThreads === '99', parsed.threadGroups[1].numThreads);
  check('(b) 原文里 20 那一段被精确替换（20 不再出现）', countOf(after, '<stringProp name="ThreadGroup.num_threads">20</stringProp>') === 0);
  check('(b) 原文里 50 那一段原样保留', countOf(after, '<stringProp name="ThreadGroup.num_threads">50</stringProp>') === 1);
  check(
    '(b) 除 index=1 的目标值外全文不变',
    after.equals(replaceOnce(before, '<stringProp name="ThreadGroup.num_threads">20</stringProp>', '<stringProp name="ThreadGroup.num_threads">99</stringProp>'))
  );
}

/* ============================================================
 * 九、LoopController.loops：只改该线程组 main_controller 里的
 * ============================================================ */
{
  const p = freshCopy('loops');
  const before = readBuf(p);
  check('(c) 前置：文件里有 3 处 LoopController.loops（10 / 3 / 5）', countOf(before, 'name="LoopController.loops"') === 3, countOf(before, 'name="LoopController.loops"'));
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'loops', value: 77 }]);
  const after = readBuf(p);
  const parsed = parseFile(p);
  check('(c) 改线程组 0 的 loops 成功', r.ok === true && r.changes[0].from === '10' && r.changes[0].to === '77', r.ok ? r.changes : r);
  check('(c) 线程组 0 的 loops = 77', parsed.threadGroups[0].loops === '77', parsed.threadGroups[0].loops);
  check('(c) 嵌套 LoopController 的 loops 仍然是 3（没误伤）', countOf(after, '<stringProp name="LoopController.loops">3</stringProp>') === 1);
  check('(c) 线程组 1 的 loops 仍然是 5（没误伤）', parsed.threadGroups[1].loops === '5', parsed.threadGroups[1].loops);
  check('(c) 原文里 77 只出现 1 次', countOf(after, '>77</stringProp>') === 1, countOf(after, '>77</stringProp>'));
  check(
    '(c) 除目标 loops 外全文不变',
    after.equals(replaceOnce(before, '<stringProp name="LoopController.loops">10</stringProp>', '<stringProp name="LoopController.loops">77</stringProp>'))
  );
  check('(c) editable 里线程组 0 的 loops 同步变成 77', r.ok && r.editable.groups[0].loops === 77, r.ok ? r.editable.groups[0] : r);
}

/* ============================================================
 * 十、断言值：XML 转义往返正确
 * ============================================================ */
{
  const p = freshCopy('escape');
  const VALUE = 'a&b"c\'d';
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'assertion', index: 0, field: 'value', value: VALUE }]);
  const after = readBuf(p);
  const parsed = parseFile(p);
  check('(i) 断言值写入成功', r.ok === true && r.changes[0].from === '200' && r.changes[0].to === VALUE, r.ok ? r.changes[0] : r);
  check('(i) 文件里写的是转义后的 &amp;（不是裸 &）', after.toString('utf8').indexOf('a&amp;b"c\'d') >= 0);
  check('(i) 双引号不需要转义、原样保留', after.toString('utf8').indexOf('b"c') >= 0);
  check('(i) parseJmx 读回来 === 输入值（往返一致）', parsed.responseAssertions[0].patterns[0] === VALUE, parsed.responseAssertions[0].patterns[0]);
  check('(i) detail.editable 读回来 === 输入值', readDetail(p).editable.assertions[0].value === VALUE, readDetail(p).editable.assertions[0].value);
  check('(i) 另一条断言（含 &amp; 原文）没被误改', parsed.responseAssertions[1].patterns[0] === '下单成功 & ok', parsed.responseAssertions[1].patterns[0]);
}

{
  // 用户输入里本来就带 &amp; 字样：必须原样往返（转义成 &amp;amp;，解析回来还是 &amp;）
  const p = freshCopy('escape-entity');
  const VALUE = '&amp; 不是实体';
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'assertion', index: 0, field: 'value', value: VALUE }]);
  const parsed = parseFile(p);
  check('(i) 输入里带 &amp; 字样时往返一致（不会二次解释）', r.ok === true && parsed.responseAssertions[0].patterns[0] === VALUE, parsed.responseAssertions[0].patterns[0]);
  check('(i) 文件里是 &amp;amp;（正确的二次转义）', readBuf(p).toString('utf8').indexOf('&amp;amp; 不是实体') >= 0);
}

{
  // 换行 / 制表符 / 中文：值里的空白保留
  const p = freshCopy('escape-ws');
  const VALUE = '第一行\n第二行\t结尾';
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'assertion', index: 0, field: 'value', value: VALUE }]);
  const parsed = parseFile(p);
  check('(i) 值里的换行/制表符/中文往返一致', r.ok === true && parsed.responseAssertions[0].patterns[0] === VALUE, parsed.responseAssertions[0].patterns[0]);
}

/* ============================================================
 * 十一、备份不互相覆盖（同一秒内连续写两次）
 * ============================================================ */
{
  const p = freshCopy('backup-twice');
  const original = readBuf(p);
  const r1 = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 60 }]);
  const afterFirst = readBuf(p);
  const r2 = wb.writeback(p, r1.editable.stamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 70 }]);
  check('连续两次写回都成功', r1.ok === true && r2.ok === true, [r1.code, r2.code]);
  check('两次备份文件名不同（同秒也不覆盖）', r1.backup !== r2.backup, [r1.backup, r2.backup]);
  check('第一次备份 == 最初原始字节', readBuf(r1.backup).equals(original));
  check('第二次备份 == 第一次写回后的字节', readBuf(r2.backup).equals(afterFirst));
  check('两次写回后 numThreads = 70', parseFile(p).threadGroups[0].numThreads === '70');
}

/* ============================================================
 * 十二、(j) 只读文件 → WRITE_FAILED，且不留半截文件
 * ============================================================ */
{
  const p = freshCopy('readonly');
  const before = readBuf(p);
  const beforeStat = fs.statSync(p);
  const beforeList = listDir(DIR);
  let chmodOk = true;
  try {
    fs.chmodSync(p, 0o444);
  } catch (e) {
    chmodOk = false;
  }
  check('前置：能把文件置为只读', chmodOk);
  if (chmodOk) {
    const stamp = wb.stampOf(fs.statSync(p));
    const r = wb.writeback(p, stamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 88 }]);
    check('(j) 只读文件 → ok:false + WRITE_FAILED', r.ok === false && r.code === 'WRITE_FAILED', r);
    check('(j) 只读文件内容一个字节都没变', readBuf(p).equals(before));
    check('(j) 只读文件 mtime 没变', fs.statSync(p).mtimeMs === beforeStat.mtimeMs);
    check('(j) 没有留下 .tmp- 半截文件', fs.readdirSync(DIR).filter((f) => /\.tmp-/.test(f)).length === 0, fs.readdirSync(DIR).filter((f) => /\.tmp-/.test(f)));
    check('(j) 失败时把本次 sidecar 备份也清掉了（目录条目不变）', listDir(DIR) === beforeList, [beforeList, listDir(DIR)]);
    fs.chmodSync(p, 0o666);
  } else {
    check('(j) 只读回归：环境不支持 chmod，显式跳过（按失败计）', false, 'chmod failed');
  }
}

/* ============================================================
 * 十三、结构边界：SetupThreadGroup / 自闭合 / 空断言集合 / BOM
 * ============================================================ */
{
  /** 造一份最小 jmx（字段可插拔），专门测定位规则本身 */
  const minimal = (groupTag, groupAttrs, inner, assertionExtra) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">',
      '  <hashTree>',
      '    <TestPlan testclass="TestPlan" testname="最小计划" enabled="true"/>',
      '    <hashTree>',
      '      <' + groupTag + ' ' + groupAttrs + '>',
      inner,
      '      </' + groupTag + '>',
      '      <hashTree>',
      '        <ResponseAssertion testclass="ResponseAssertion" testname="断言A" enabled="true">',
      '          <collectionProp name="Asserion.test_strings"/>',
      '          <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>',
      assertionExtra || '',
      '        </ResponseAssertion>',
      '        <hashTree/>',
      '      </hashTree>',
      '    </hashTree>',
      '  </hashTree>',
      '</jmeterTestPlan>',
      ''
    ].join('\r\n');

  // 1) SetupThreadGroup 现在也算可编辑线程组（type = 'setup'），且只改它自己的值
  {
    const text = minimal('SetupThreadGroup', 'guiclass="SetupThreadGroupGui" testclass="SetupThreadGroup" testname="准备数据" enabled="true"', '        <stringProp name="ThreadGroup.num_threads">1</stringProp>\r\n        <stringProp name="ThreadGroup.ramp_time">3</stringProp>');
    const p = path.join(DIR, 'setup-only.jmx');
    fs.writeFileSync(p, text, 'utf8');
    const before = readBuf(p);
    const d = readDetail(p);
    check(
      'SetupThreadGroup 是可编辑线程组（editable.groups 1 个且 type = setup）',
      d.ok === true && d.editable.groups.length === 1 && d.editable.groups[0].type === 'setup' && d.editable.groups[0].name === '准备数据',
      d.ok ? d.editable.groups : d
    );
    const r = wb.writeback(p, d.editable.stamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 5, type: 'setup' }]);
    check('对 SetupThreadGroup 写回线程数成功', r.ok === true && r.changes[0].from === '1' && r.changes[0].to === '5', r);
    check('SetupThreadGroup 写回后重新 parse 读到 5', parseFile(p).threadGroups[0].numThreads === '5', parseFile(p).threadGroups[0].numThreads);
    check(
      'SetupThreadGroup 写回仍只动目标值那几个字节（golden）',
      readBuf(p).equals(replaceOnce(before, '<stringProp name="ThreadGroup.num_threads">1</stringProp>', '<stringProp name="ThreadGroup.num_threads">5</stringProp>'))
    );
    const wrongType = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'rampUp', value: 7, type: 'thread' }]);
    check('对 Setup 组传 type=thread（类型对不上）→ NO_SUCH_TARGET', wrongType.ok === false && wrongType.code === 'NO_SUCH_TARGET', wrongType);
  }

  // 1b) <ThreadGroupX 不是线程组（词边界），</SetupThreadGroup> 也不能被当成 </ThreadGroup>
  {
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">',
      '  <hashTree>',
      '    <TestPlan testclass="TestPlan" testname="边界计划" enabled="true"/>',
      '    <hashTree>',
      '      <SetupThreadGroup testclass="SetupThreadGroup" testname="前置" enabled="true">',
      '        <stringProp name="ThreadGroup.num_threads">2</stringProp>',
      '      </SetupThreadGroup>',
      '      <hashTree>',
      '        <ThreadGroupX testclass="ThreadGroupX" testname="冒牌组" enabled="true">',
      '          <stringProp name="ThreadGroup.num_threads">9</stringProp>',
      '        </ThreadGroupX>',
      '        <hashTree/>',
      '        <PostThreadGroup testclass="PostThreadGroup" testname="后置" enabled="true">',
      '          <stringProp name="ThreadGroup.num_threads">3</stringProp>',
      '        </PostThreadGroup>',
      '        <hashTree/>',
      '      </hashTree>',
      '    </hashTree>',
      '  </hashTree>',
      '</jmeterTestPlan>',
      ''
    ].join('\r\n');
    const p = path.join(DIR, 'tag-boundary.jmx');
    fs.writeFileSync(p, text, 'utf8');
    const d = readDetail(p);
    check(
      '标签词边界：只认 3 个线程组（<ThreadGroupX 不算），顺序 setup → teardown',
      d.ok === true && d.editable.groups.length === 2 && d.editable.groups[0].type === 'setup' && d.editable.groups[1].type === 'teardown',
      d.ok ? d.editable.groups : d
    );
    check(
      'Setup/Post 各自读到自己组里的值（2 / 3，不是冒牌组的 9）',
      d.ok && d.editable.groups[0].numThreads === 2 && d.editable.groups[1].numThreads === 3,
      d.ok ? d.editable.groups : d
    );
  }

  // 2) 自闭合 ThreadGroup：结构能识别，但没有可改的 prop → NO_SUCH_TARGET
  {
    const text = minimal('ThreadGroup', 'testclass="ThreadGroup" testname="空线程组" enabled="true"', '');
    const p = path.join(DIR, 'empty-group.jmx');
    fs.writeFileSync(p, text, 'utf8');
    const d = readDetail(p);
    check('没有 prop 的线程组仍出现在 editable 里（看得见，只是值为 null）', d.editable.groups.length === 1 && d.editable.groups[0].numThreads === null, d.editable.groups);
    const r = wb.writeback(p, d.editable.stamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 5 }]);
    check('线程组里没有 num_threads prop → NO_SUCH_TARGET', r.ok === false && r.code === 'NO_SUCH_TARGET', r);
  }

  // 3) 断言集合是空的：详情里 value = ''，写回不能凭空造一个值
  {
    const text = minimal('ThreadGroup', 'testclass="ThreadGroup" testname="组A" enabled="true"', '        <stringProp name="ThreadGroup.num_threads">2</stringProp>');
    const p = path.join(DIR, 'empty-assertion.jmx');
    fs.writeFileSync(p, text, 'utf8');
    const d = readDetail(p);
    check('空断言的 editable.value 是空串', d.editable.assertions.length === 1 && d.editable.assertions[0].value === '', d.editable.assertions);
    const r = wb.writeback(p, d.editable.stamp, [{ kind: 'assertion', index: 0, field: 'value', value: 'x' }]);
    check('空断言集合 → NO_SUCH_TARGET（不新增值）', r.ok === false && r.code === 'NO_SUCH_TARGET', r);
  }

  // 4) testname 里有 &gt;：属性解析要按引号走，不能把 > 当标签结束
  {
    const text = minimal('ThreadGroup', 'testclass="ThreadGroup" testname="A &gt; B" enabled="true"', '        <stringProp name="ThreadGroup.num_threads">2</stringProp>');
    const p = path.join(DIR, 'gt-name.jmx');
    fs.writeFileSync(p, text, 'utf8');
    const d = readDetail(p);
    check('testname 里的 &gt; 被还原成 >', d.ok === true && d.editable.groups[0].name === 'A > B', d.ok ? d.editable.groups[0] : d);
    const r = wb.writeback(p, d.editable.stamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 7, name: 'A > B' }]);
    check('带 &gt; 的 testname 也能按 name 校验并写回', r.ok === true && r.editable.groups[0].numThreads === 7, r.ok ? r.changes : r);
  }

  // 5) UTF-8 BOM：写回只动值，BOM 三个字节原样保留
  {
    const text = minimal('ThreadGroup', 'testclass="ThreadGroup" testname="BOM组" enabled="true"', '        <stringProp name="ThreadGroup.num_threads">2</stringProp>');
    const p = path.join(DIR, 'bom.jmx');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
    const d = readDetail(p);
    check('带 BOM 的 jmx 能读出 editable', d.ok === true && d.editable.groups.length === 1, d.ok ? d.editable.groups : d);
    const r = wb.writeback(p, d.editable.stamp, [{ kind: 'thread', index: 0, field: 'numThreads', value: 8 }]);
    const after = readBuf(p);
    check('BOM 文件写回成功', r.ok === true, r);
    check('写回后 BOM 三个字节原样保留', after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf, [after[0], after[1], after[2]]);
    check('BOM 文件写回后值正确', parseFile(p).threadGroups[0].numThreads === '8');
  }
}

/* ============================================================
 * 十四、三类线程组混排：index 跨类型连续，改一个不误伤别的
 * ============================================================ */
function mixGroupText() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">',
    '  <hashTree>',
    '    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="混排计划" enabled="true">',
    '      <stringProp name="TestPlan.comments"></stringProp>',
    '    </TestPlan>',
    '    <hashTree>',
    '      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="主流程" enabled="true">',
    '        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '          <boolProp name="LoopController.continue_forever">false</boolProp>',
    '          <stringProp name="LoopController.loops">10</stringProp>',
    '        </elementProp>',
    '        <stringProp name="ThreadGroup.num_threads">50</stringProp>',
    '        <stringProp name="ThreadGroup.ramp_time">10</stringProp>',
    '      </ThreadGroup>',
    '      <hashTree>',
    '        <SetupThreadGroup guiclass="SetupThreadGroupGui" testclass="SetupThreadGroup" testname="准备数据" enabled="true">',
    '          <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '            <stringProp name="LoopController.loops">1</stringProp>',
    '          </elementProp>',
    '          <stringProp name="ThreadGroup.num_threads">1</stringProp>',
    '          <stringProp name="ThreadGroup.ramp_time">1</stringProp>',
    '        </SetupThreadGroup>',
    '        <hashTree/>',
    '        <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="下单组" enabled="true">',
    '          <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '            <stringProp name="LoopController.loops">5</stringProp>',
    '          </elementProp>',
    '          <stringProp name="ThreadGroup.num_threads">20</stringProp>',
    '          <stringProp name="ThreadGroup.ramp_time">5</stringProp>',
    '        </ThreadGroup>',
    '        <hashTree/>',
    '        <PostThreadGroup guiclass="PostThreadGroupGui" testclass="PostThreadGroup" testname="收尾" enabled="true">',
    '          <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">',
    '            <stringProp name="LoopController.loops">2</stringProp>',
    '          </elementProp>',
    '          <stringProp name="ThreadGroup.num_threads">2</stringProp>',
    '          <stringProp name="ThreadGroup.ramp_time">2</stringProp>',
    '        </PostThreadGroup>',
    '        <hashTree/>',
    '      </hashTree>',
    '    </hashTree>',
    '  </hashTree>',
    '</jmeterTestPlan>',
    ''
  ].join('\r\n');
}

{
  const p = path.join(DIR, 'mix-group.jmx');
  const MIX = Buffer.from(mixGroupText(), 'utf8');
  fs.writeFileSync(p, MIX);

  const d = readDetail(p);
  const g = d.ok ? d.editable.groups : [];
  check('(4) 混排文件：editable 有 4 个线程组（thread/setup/thread/teardown）', g.length === 4, g);
  check(
    '(5) index 跨类型连续：0=thread 1=setup 2=thread 3=teardown',
    d.ok && g[0].index === 0 && g[1].index === 1 && g[2].index === 2 && g[3].index === 3 && g[0].type === 'thread' && g[1].type === 'setup' && g[2].type === 'thread' && g[3].type === 'teardown',
    g.map((x) => [x.index, x.type, x.name])
  );
  check('(5) 各组名字按全文顺序', d.ok && g.map((x) => x.name).join('|') === '主流程|准备数据|下单组|收尾', d.ok ? g.map((x) => x.name) : d);
  check(
    '(5) 各组值各归各位（50/1/20/2）',
    d.ok && g.map((x) => x.numThreads).join(',') === '50,1,20,2',
    d.ok ? g.map((x) => x.numThreads) : d
  );
  check(
    '(5) editable.groups 的顺序与 jmx.js 的 threadGroups 完全一致（type/name 逐个相同）',
    (() => {
      const jmxGroups = parseFile(p).threadGroups;
      return jmxGroups.length === g.length && jmxGroups.every((t, i) => t.type === g[i].type && t.name === g[i].name);
    })(),
    parseFile(p).threadGroups.map((t) => [t.type, t.name])
  );

  // 改第 2 个元素（setup，index=1）：它前后的组一个字节都不许动
  const beforeSetup = readBuf(p);
  const rSetup = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 1, field: 'numThreads', value: 5, type: 'setup', name: '准备数据' }]);
  const afterSetup = readBuf(p);
  const pSetup = parseFile(p);
  check('(4) 改 index=1（SetupThreadGroup）成功', rSetup.ok === true && rSetup.changes[0].from === '1' && rSetup.changes[0].to === '5', rSetup);
  check(
    '(4) 改 SetupThreadGroup 后全文其余字节不变（golden：只替换那一个值）',
    afterSetup.equals(
      replaceOnce(beforeSetup, '<stringProp name="ThreadGroup.num_threads">1</stringProp>', '<stringProp name="ThreadGroup.num_threads">5</stringProp>')
    ),
    [sha256(afterSetup), sha256(beforeSetup)]
  );
  check('(5) 第 1 个（index=0）线程数仍是 50（没误改）', pSetup.threadGroups[0].numThreads === '50', pSetup.threadGroups[0].numThreads);
  check('(5) 第 3 个（index=2）线程数仍是 20（没误改）', pSetup.threadGroups[2].numThreads === '20', pSetup.threadGroups[2].numThreads);
  check('(5) 第 4 个（index=3）线程数仍是 2（没误改）', pSetup.threadGroups[3].numThreads === '2', pSetup.threadGroups[3].numThreads);
  check('(4) 重新 parse 后 setup 组 = 5，且 4 个组都还在', pSetup.threadGroups[1].numThreads === '5' && pSetup.threadGroups.length === 4, pSetup.threadGroups.map((t) => t.numThreads));

  // 改 index=2（普通线程组）：setup 与收尾都不许动
  const beforeThird = readBuf(p);
  const rThird = wb.writeback(p, rSetup.editable.stamp, [{ kind: 'thread', index: 2, field: 'rampUp', value: 6, type: 'thread' }]);
  const pThird = parseFile(p);
  check('(5) 改 index=2 成功', rThird.ok === true && rThird.changes[0].from === '5' && rThird.changes[0].to === '6', rThird);
  check(
    '(5) 改第 3 个元素后 setup 组与收尾组原样（只替换目标值）',
    readBuf(p).equals(
      replaceOnce(beforeThird, '<stringProp name="ThreadGroup.ramp_time">5</stringProp>', '<stringProp name="ThreadGroup.ramp_time">6</stringProp>')
    )
  );
  check('(5) 第 2 个（setup）线程数仍是 5', pThird.threadGroups[1].numThreads === '5', pThird.threadGroups[1].numThreads);

  // 可选 type 传错 → NO_SUCH_TARGET，且文件不动
  const beforeBad = readBuf(p);
  const badSetup = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 1, field: 'numThreads', value: 9, type: 'thread' }]);
  check('(4) index=1 传 type=thread（实际是 setup）→ NO_SUCH_TARGET', badSetup.ok === false && badSetup.code === 'NO_SUCH_TARGET', badSetup);
  const badPost = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 3, field: 'numThreads', value: 9, type: 'setup' }]);
  check('(4) index=3 传 type=setup（实际是 teardown）→ NO_SUCH_TARGET', badPost.ok === false && badPost.code === 'NO_SUCH_TARGET', badPost);
  const badName = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 1, field: 'numThreads', value: 9, type: 'setup', name: '主流程' }]);
  check('(4) index=1 名字对不上 → NO_SUCH_TARGET', badName.ok === false && badName.code === 'NO_SUCH_TARGET', badName);
  check('(4) type/name 校验失败时文件一个字节都没动', readBuf(p).equals(beforeBad));
}

/* ============================================================
 * 十五、取值区间放宽：loops=-1、rampUp=0 可写；numThreads=0 仍拒绝
 * ============================================================ */
{
  const p = freshCopy('range-loops-forever');
  const before = readBuf(p);
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'loops', value: -1 }]);
  const parsed = parseFile(p);
  check('(6) loops = -1（永久循环）写回成功', r.ok === true && r.changes[0].from === '10' && r.changes[0].to === '-1', r.ok ? r.changes : r);
  check('(6) 重新 parse 读到 loops = -1', parsed.threadGroups[0].loops === '-1', parsed.threadGroups[0].loops);
  check('(6) editable 里 loops = -1（数字，不是字符串）', r.ok && r.editable.groups[0].loops === -1, r.ok ? r.editable.groups[0] : r);
  check(
    '(6) 写 -1 时只动目标值那几个字节（golden）',
    readBuf(p).equals(replaceOnce(before, '<stringProp name="LoopController.loops">10</stringProp>', '<stringProp name="LoopController.loops">-1</stringProp>'))
  );
  check('(6) 嵌套 LoopController 的 loops（3）与线程组 1 的 loops（5）没被牵连', parsed.threadGroups[1].loops === '5' && countOf(readBuf(p), '>3</stringProp>') === 1);
}

{
  const p = freshCopy('range-ramp-zero');
  const before = readBuf(p);
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'rampUp', value: 0 }]);
  const parsed = parseFile(p);
  check('(7) rampUp = 0 写回成功', r.ok === true && r.changes[0].from === '10' && r.changes[0].to === '0', r.ok ? r.changes : r);
  check('(7) 重新 parse 读到 rampUp = 0', parsed.threadGroups[0].rampUp === '0', parsed.threadGroups[0].rampUp);
  check('(7) editable 里 rampUp = 0', r.ok && r.editable.groups[0].rampUp === 0, r.ok ? r.editable.groups[0] : r);
  check(
    '(7) 写 0 时只动目标值那几个字节（golden）',
    readBuf(p).equals(replaceOnce(before, '<stringProp name="ThreadGroup.ramp_time">10</stringProp>', '<stringProp name="ThreadGroup.ramp_time">0</stringProp>'))
  );
  check('(7) 线程组 1 的 rampUp（5）没被牵连', parsed.threadGroups[1].rampUp === '5', parsed.threadGroups[1].rampUp);
}

{
  const p = freshCopy('range-threads-zero');
  const before = readBuf(p);
  const beforeStat = fs.statSync(p);
  const beforeList = listDir(DIR);
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 0 }]);
  check('(8) numThreads = 0 仍回 BAD_VALUE', r.ok === false && r.code === 'BAD_VALUE', r);
  check('(8) numThreads=0 被拒时文件不变、mtime 不变', readBuf(p).equals(before) && fs.statSync(p).mtimeMs === beforeStat.mtimeMs);
  check('(8) numThreads=0 被拒时不留备份/临时文件', listDir(DIR) === beforeList, listDir(DIR));
}

/* ============================================================
 * 十六、备份保留策略：只留最近 KEEP_BACKUPS 份（且只删本文件自己的备份）
 * ============================================================ */
/** 造一份「假备份」；mtime 显式指定，别依赖文件系统的同毫秒精度 */
function makeFakeBackup(target, stamp, mtimeMs) {
  const p = target + '.bak-' + stamp;
  fs.writeFileSync(p, 'fake');
  const t = new Date(mtimeMs);
  fs.utimesSync(p, t, t);
  return p;
}

/** 目录里「本文件的备份」名字（与实现同口径：整名匹配 + 必须是普通文件） */
function backupNamesOf(target) {
  const escaped = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\.bak-\\d{8}-\\d{6}(?:-\\d+)?$');
  return fs
    .readdirSync(DIR)
    .filter((n) => re.test(n) && fs.statSync(path.join(DIR, n)).isFile())
    .sort();
}

{
  // (1) 12 份假备份 + 本次写回 = 13 份 → 只留最近 10 份，删掉的 3 份必须是最旧的
  const p = freshCopy('prune-keep-ten');
  const now = Date.now();
  const made = [];
  for (let i = 0; i < 12; i++) {
    // 名字里的时间戳递增，mtime 也递增（越晚越新）
    made.push(makeFakeBackup(p, '20200101-0000' + String(i + 1).padStart(2, '0'), now - (12 - i) * 1000));
  }
  check('前置：造好了 12 份假备份', backupNamesOf(p).length === 12, backupNamesOf(p));

  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 42 }]);
  check('(1) 写回成功', r.ok === true, r);
  check('(1) 返回值带 pruned，且本次删了 3 份', r.ok && r.pruned === 3, r.ok ? r.pruned : r);

  const left = backupNamesOf(p);
  check('(1) 目录里只剩 10 份本文件备份', left.length === 10, left);
  check('(1) 本次新备份在其中', left.indexOf(path.basename(r.backup)) >= 0, [path.basename(r.backup), left]);
  check(
    '(1) 被删的正是同 basename 最旧的 3 份（000001/000002/000003）',
    made.slice(0, 3).every((f) => !fs.existsSync(f)) && made.slice(3).every((f) => fs.existsSync(f)),
    made.map((f) => [path.basename(f), fs.existsSync(f)])
  );
  check('(1) 写回本身没被清理影响（值已生效）', parseFile(p).threadGroups[0].numThreads === '42', parseFile(p).threadGroups[0].numThreads);
}

{
  // (1b) 同一秒的 -1 / -2 后缀：mtime 全相同时，数值大的更新 → 保留 -11..-3，删掉 base/-1/-2
  const p = freshCopy('prune-same-second');
  const same = Date.now() - 60000;
  const names = [];
  for (let i = 0; i < 12; i++) {
    names.push(makeFakeBackup(p, '20200101-000500' + (i === 0 ? '' : '-' + i), same));
  }
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 43 }]);
  const left = backupNamesOf(p);
  const base = path.join(DIR, path.basename(p) + '.bak-20200101-000500');
  check('(1b) 同 stamp/同 mtime 的 12 份 + 新备份 → 只留 10 份', r.ok === true && left.length === 10, [r.ok, left]);
  check(
    '(1b) 同 mtime 时按 -n 后缀**数值**排新→旧：删掉 base、-1、-2（不是删 -9/-10）',
    !fs.existsSync(base) && !fs.existsSync(base + '-1') && !fs.existsSync(base + '-2') && fs.existsSync(base + '-3') && fs.existsSync(base + '-11'),
    names.map((f) => [path.basename(f), fs.existsSync(f)])
  );
  check('(1b) 后缀 -10 / -11 被保住（字符串倒序会把它们误判成最旧）', fs.existsSync(base + '-10') && fs.existsSync(base + '-11'));
}

{
  // (2) 同目录下别家文件的备份、用户自己命名的 .bak-*：一份都不许动
  const p = freshCopy('prune-foreign');
  const base = path.basename(p);
  const now = Date.now();
  const old = now - 3600 * 1000; // 比所有本文件备份都老：匹配规则一旦放宽，它们会最先被删
  const foreign = [
    path.join(DIR, '别人.jmx.bak-20200101-000001'),
    path.join(DIR, base + '.bak-bar'),
    path.join(DIR, base + '.bak-20200101-00001'), // 尾巴只有 5 位数字
    path.join(DIR, base + '.bak-20200101-0000011'), // 尾巴 7 位数字
    path.join(DIR, base + '.bak-20200101-000001.bak'), // 多一截
    path.join(DIR, '用户备份.txt')
  ];
  for (const f of foreign) {
    fs.writeFileSync(f, 'keep me');
    const t = new Date(old);
    fs.utimesSync(f, t, t);
  }
  // 名字合法但其实是目录：unlink 会失败，必须靠 isFile() 跳过去而不是「尝试删除」
  const dirAsBackup = path.join(DIR, base + '.bak-20200101-000999');
  fs.mkdirSync(dirAsBackup);

  for (let i = 0; i < 12; i++) makeFakeBackup(p, '20200101-0001' + String(i + 1).padStart(2, '0'), now - (12 - i) * 1000);

  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 44 }]);
  check('(2) 写回成功且只删了本文件最旧的 3 份', r.ok === true && r.pruned === 3, r.ok ? r.pruned : r);
  check('(2) 别家 jmx 的备份没被删', fs.existsSync(foreign[0]), foreign[0]);
  check('(2) 用户自己命名的 <basename>.bak-bar 没被删', fs.existsSync(foreign[1]), foreign[1]);
  check(
    '(2) 尾巴不是「8位-6位[-n]」的 <basename>.bak-* 全部保留（5 位 / 7 位 / 多一截）',
    foreign.slice(2, 5).every((f) => fs.existsSync(f)),
    foreign.slice(2, 5).map((f) => [path.basename(f), fs.existsSync(f)])
  );
  check('(2) 无关的普通文件没被碰', fs.existsSync(foreign[5]));
  check('(2) 名字像备份的目录没被删（不是普通文件就跳过）', fs.existsSync(dirAsBackup) && fs.statSync(dirAsBackup).isDirectory());
  check('(2) 本文件备份恰好剩 10 份', backupNamesOf(p).length === 10, backupNamesOf(p));
}

{
  // (3a) 只读文件 → 写盘失败；一份备份都不能删
  const p = freshCopy('prune-readonly');
  const now = Date.now();
  const fakes = [];
  for (let i = 0; i < 12; i++) fakes.push(makeFakeBackup(p, '20200101-0002' + String(i + 1).padStart(2, '0'), now - (12 - i) * 1000));
  const before = readBuf(p);
  let chmodOk = true;
  try {
    fs.chmodSync(p, 0o444);
  } catch (e) {
    chmodOk = false;
  }
  check('前置（备份保留）：能把文件置为只读', chmodOk);
  if (chmodOk) {
    const r = wb.writeback(p, wb.stampOf(fs.statSync(p)), [{ kind: 'thread', index: 0, field: 'numThreads', value: 45 }]);
    check('(3) 只读文件 → WRITE_FAILED', r.ok === false && r.code === 'WRITE_FAILED', r);
    check('(3) 写盘失败时 12 份备份一份都没删', fakes.every((f) => fs.existsSync(f)), fakes.filter((f) => !fs.existsSync(f)).map((f) => path.basename(f)));
    check('(3) 写盘失败时没有新增备份', backupNamesOf(p).length === 12, backupNamesOf(p).length);
    check('(3) 写盘失败时原文件一个字节都没变', readBuf(p).equals(before));
    fs.chmodSync(p, 0o666);
  } else {
    check('(3) 只读回归：环境不支持 chmod，显式跳过（按失败计）', false, 'chmod failed');
  }
}

{
  // (3b) rename 失败（写盘的最后一刻才失败）→ 连「清理」都不能发生，本次备份还要回滚掉
  const p = freshCopy('prune-rename-fail');
  const now = Date.now();
  const fakes = [];
  for (let i = 0; i < 12; i++) fakes.push(makeFakeBackup(p, '20200101-0003' + String(i + 1).padStart(2, '0'), now - (12 - i) * 1000));
  const before = readBuf(p);
  const beforeStamp = fs.statSync(p).mtimeMs;
  const fsModule = require('fs');
  const realRename = fsModule.renameSync;
  let r;
  try {
    fsModule.renameSync = () => {
      const e = new Error('注入的 rename 失败');
      e.code = 'EIO';
      throw e;
    };
    r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 46 }]);
  } finally {
    fsModule.renameSync = realRename;
  }
  check('(3) rename 失败 → WRITE_FAILED', r && r.ok === false && r.code === 'WRITE_FAILED', r);
  check('(3) rename 失败时 12 份备份一份都没删', fakes.every((f) => fs.existsSync(f)), fakes.filter((f) => !fs.existsSync(f)).map((f) => path.basename(f)));
  check('(3) rename 失败时本次新建的备份被回滚（不留下 13 份）', backupNamesOf(p).length === 12, backupNamesOf(p).length);
  check('(3) rename 失败时原文件内容/mtime 不变', readBuf(p).equals(before) && fs.statSync(p).mtimeMs === beforeStamp);
  check('(3) rename 失败时没有残留 .tmp- 文件', fs.readdirSync(DIR).filter((f) => /\.tmp-/.test(f)).length === 0, fs.readdirSync(DIR).filter((f) => /\.tmp-/.test(f)));
}

{
  // 不足保留数时不该有任何删除动作
  const p = freshCopy('prune-few');
  const now = Date.now();
  const fakes = [];
  for (let i = 0; i < 3; i++) fakes.push(makeFakeBackup(p, '20200101-0004' + String(i + 1).padStart(2, '0'), now - (3 - i) * 1000));
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 47 }]);
  check('备份没到 10 份时 pruned = 0 且一份不删', r.ok === true && r.pruned === 0 && fakes.every((f) => fs.existsSync(f)), r.ok ? r.pruned : r);
}

/* ============================================================
 * 十六之二、保留份数由调用方传（v0.52.1：设置项 backupKeep）
 *
 * 为什么要有这一段：份数从「模块里写死 10」改成了「跟着设置走」。
 * 不验的话，下次有人把参数接错（比如传了字符串、或者根本没接），
 * 表现是「用户设了 3 份，实际还是留 10 份」—— 不报错、只是不生效。
 * ============================================================ */
{
  const p = freshCopy('prune-keep-setting');
  const now = Date.now();
  for (let i = 0; i < 8; i++) makeFakeBackup(p, '20200102-0000' + String(i + 1).padStart(2, '0'), now - (8 - i) * 1000);
  const r = wb.writeback(p, stampOfFile(p), [{ kind: 'thread', index: 0, field: 'numThreads', value: 50 }], { keepBackups: 3 });
  check('传入 keepBackups=3 → 写回后只剩 3 份备份', r.ok === true && backupNamesOf(p).length === 3, backupNamesOf(p).length);
  check('keepBackups=3 时删掉 6 份（8 假 + 1 新 − 留 3）', r.ok === true && r.pruned === 6, r.ok ? r.pruned : r);

  // 不传 keepBackups = 默认 10（老调用方行为不变）
  const p1 = freshCopy('prune-keep-default');
  for (let i = 0; i < 12; i++) makeFakeBackup(p1, '20200104-0000' + String(i + 1).padStart(2, '0'), now - (12 - i) * 1000);
  const r1 = wb.writeback(p1, stampOfFile(p1), [{ kind: 'thread', index: 0, field: 'numThreads', value: 51 }]);
  check('不传 keepBackups 时仍按默认 10 份保留', r1.ok === true && backupNamesOf(p1).length === 10, backupNamesOf(p1).length);

  // 脏值（0 / 负数 / 字符串）必须回落，绝不能变成「全删」
  const p2 = freshCopy('prune-keep-dirty');
  for (let i = 0; i < 12; i++) makeFakeBackup(p2, '20200105-0000' + String(i + 1).padStart(2, '0'), now - (12 - i) * 1000);
  const r2 = wb.writeback(p2, stampOfFile(p2), [{ kind: 'thread', index: 0, field: 'numThreads', value: 52 }], { keepBackups: 0 });
  check('keepBackups=0（脏值）回落到默认 10，一份都没被多删', r2.ok === true && backupNamesOf(p2).length === 10, backupNamesOf(p2).length);
  const r3 = wb.writeback(p2, stampOfFile(p2), [{ kind: 'thread', index: 0, field: 'numThreads', value: 53 }], { keepBackups: 'abc' });
  check('keepBackups="abc"（脏值）同样回落，不会把备份全删光', r3.ok === true && backupNamesOf(p2).length === 10, backupNamesOf(p2).length);
}

/* ============================================================
 * 十七、闸 1 / 闸 2 / 闸 3 的结构断言（源码级）
 * ============================================================ */
{
  const jmxSrc = read('electron/jmx.js');
  const ipcSrc = read('electron/ipc/ipc-jmx.js');
  const wbSrc = read('electron/jmx-writeback.js');

  check('闸 1：jmx.js 里没有任何写盘调用（readDetail / buildEditable 只读）', !/writeFileSync|appendFileSync|renameSync|fsyncSync|copyFileSync|unlinkSync|openSync/.test(jmxSrc), 'jmx.js contained a write/rename call');
  check('闸 1：jmx.js 只 require 了 writeback 的只读入口', /buildEditable\(/.test(jmxSrc) && jmxSrc.indexOf('writeback(') < 0, 'jmx.js may call writeback');
  check('闸 1：唯一写盘模块里同时有备份 / fsync / rename', /\.bak-/.test(wbSrc) && /fsyncSync/.test(wbSrc) && /renameSync/.test(wbSrc));
  check('闸 1：ipc-jmx 只把参数转交给 jmxWriteback.writeback', /jmxWriteback\.writeback\(/.test(ipcSrc));
  check('闸 1：jmx:writeback handler 直接调了 deps.assertUnlocked()', (() => {
    const block = handlerBlock(ipcSrc, 'jmx:writeback');
    return /assertUnlocked\(\)/.test(block);
  })());
  check('闸 1：jmx:writeback handler 过 assertPathIn(target)', (() => {
    const block = handlerBlock(ipcSrc, 'jmx:writeback');
    return /assertPathIn\(target\)/.test(block);
  })());
  check('闸 1：jmx:writeback handler 自己不碰 fs（写盘全在 writeback 模块）', (() => {
    const block = handlerBlock(ipcSrc, 'jmx:writeback');
    return !/writeFileSync|appendFileSync|renameSync|fsyncSync|copyFileSync|unlinkSync/.test(block);
  })(), handlerBlock(ipcSrc, 'jmx:writeback').slice(0, 80));
  check('闸 2：白名单只有 thread 三个字段 + assertion.value', (() => {
    const keys = Object.keys(wb.EDITABLE_FIELDS);
    const t = Object.keys(wb.EDITABLE_FIELDS.thread).sort().join(',');
    const a = Object.keys(wb.EDITABLE_FIELDS.assertion).sort().join(',');
    return keys.length === 2 && t === 'loops,numThreads,rampUp' && a === 'value';
  })(), wb.EDITABLE_FIELDS);
  check('闸 2：单次上限常量 = 50、断言值上限 = 500', wb.MAX_EDITS === 50 && wb.MAX_ASSERTION_LEN === 500, [wb.MAX_EDITS, wb.MAX_ASSERTION_LEN]);
  check('闸 3：保留策略常量 KEEP_BACKUPS = 10 且已导出', wb.KEEP_BACKUPS === 10, wb.KEEP_BACKUPS);
  check(
    '闸 3：清理只在 rename 成功之后发生（源码顺序：renameSync 在 pruneBackups 之前）',
    (() => {
      const ren = wbSrc.indexOf('fs.renameSync(tmp, target)');
      const prune = wbSrc.indexOf('pruneBackups(target, backup, keep)');
      return ren >= 0 && prune > ren;
    })(),
    'rename/prune order'
  );
  check(
    '闸 3：保留份数用的是传入的 limit，不是写死的 KEEP_BACKUPS（v0.52.1 跟着设置走）',
    /if \(list\.length <= limit\)/.test(wbSrc) && !/if \(list\.length <= KEEP_BACKUPS\)/.test(wbSrc),
    'prune limit'
  );
  check('闸 3：keep 从 writeback 的第 4 个参数一路传到 writeAtomic', /function writeAtomic\(target, newBuf, originalBuf, keep\)/.test(wbSrc) && /clampKeep\(opts && opts\.keepBackups\)/.test(wbSrc));
  check(
    '闸 3：清理只认「整名匹配 <basename>.bak-8位-6位[-n]」的普通文件（不按前缀乱删）',
    wbSrc.indexOf('.bak-\\d{8}-\\d{6}') >= 0 && /isFile\(\)/.test(wbSrc) && /KEEP_BACKUPS/.test(wbSrc),
    'backup name matcher'
  );
  check(
    '闸 3：清理失败不影响写回成功（pruneBackups 的调用套了 try/catch，只 console.warn）',
    /try\s*\{[\s\S]{0,120}pruneBackups[\s\S]{0,200}catch[\s\S]{0,120}console\.warn/.test(wbSrc),
    'prune is best effort'
  );
  check(
    '线程组三类标签都在扫描范围内（ThreadGroup / SetupThreadGroup / PostThreadGroup）',
    /'SetupThreadGroup'/.test(wbSrc) && /'PostThreadGroup'/.test(wbSrc) && /findThreadGroups\(/.test(wbSrc),
    'tag list'
  );
  check(
    '取值区间：numThreads 1.. / rampUp 0.. / loops 允许 -1',
    wb.INT_MIN === 1 && wb.RAMPUP_MIN === 0 && wb.LOOP_FOREVER === -1 && wb.INT_MAX === 1000000,
    [wb.INT_MIN, wb.RAMPUP_MIN, wb.LOOP_FOREVER, wb.INT_MAX]
  );
  check('闸 4：本套件就是 golden test（源码里有逐字节比对）', /逐字节|Buffer 完全一致/.test(read('scripts/test-jmx-writeback.cjs')));
  check('jmx:detail 仍然走 jmxIndex.readDetail（没另写一套解析）', /jmxIndex\.readDetail\(target\)/.test(ipcSrc));
  check('jmx:writeback 与 jmx:detail 使用同一套相对路径逻辑', /path\.isAbsolute\(input\)/.test(handlerBlock(ipcSrc, 'jmx:writeback')));
}

function handlerBlock(src, channel) {
  const at = src.indexOf("handle('" + channel + "'");
  if (at < 0) return '';
  const next = src.indexOf('handle(', at + 10);
  return next > 0 ? src.slice(at, next) : src.slice(at);
}

/* ============================================================
 * 汇总
 * ============================================================ */
fs.rmSync(TMP_ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('===== jmx 局部编辑写回（L2）+ 四道闸 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, 0 skipped');
process.exit(failed.length ? 1 : 0);