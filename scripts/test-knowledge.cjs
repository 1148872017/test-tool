/* 知识库解析测试：跑真实 D:\AI_Workspace\知识库 */
const fs = require('fs');
const path = require('path');
const { parseDoc, scanKnowledge } = require('../electron/knowledge.js');

const ROOT = process.env.KB_ROOT || 'D:\\AI_Workspace\\知识库';
const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

const res = scanKnowledge(ROOT);
console.log('root =', res.root);
console.log('docs =', res.totalDocs, ' errors =', res.errors.length);
if (res.errors.length) console.log(res.errors);

check('扫到知识库文档', res.totalDocs >= 10, res.totalDocs);
check('没有扫描错误', res.errors.length === 0, res.errors);

const byName = (part) => res.docs.find((d) => d.name.indexOf(part) >= 0);
const notice = byName('公告管理');

check('找到「公告管理」', !!notice, res.docs.map((d) => d.name).slice(0, 5));

if (notice) {
  check('提取标题', notice.title === '业务规则沉淀_公告管理', notice.title);
  check('提取更新时间', /2026-05-27/.test(notice.meta.updatedAt), notice.meta);
  check('提取章节', notice.sections.length >= 4, notice.sections.length);
  check('章节标题正确', notice.sections[0].title.indexOf('用户类型') >= 0, notice.sections[0].title);
  check('二级章节有子章节', notice.sections.some((s) => s.children.length > 0), notice.sections.map((s) => s.children.length));
  check('章节带行号', notice.sections.every((s) => s.line > 0), notice.sections.map((s) => s.line));
  check('章节正文非空', notice.sections.some((s) => s.text.length > 10), notice.sections.map((s) => s.text.length));
  check('正文包含关键内容', notice.body.indexOf('已读人数') >= 0, notice.body.slice(0, 100));
  check('字数统计合理', notice.chars > 500, notice.chars);
  console.log('\n[公告管理 章节]');
  for (const s of notice.sections) {
    console.log(`  ${s.title}  (${s.children.length} 子章节, ${s.text.length} 字)`);
  }
}

// 归档目录要跳过
const archived = res.docs.filter((d) => d.dir.indexOf('_archive') >= 0);
check('跳过 _archive 目录', archived.length === 0, archived.map((d) => d.relPath));

// 大文档
const big = res.docs.find((d) => d.chars > 30000);
check('能解析大文档（>3 万字）', !!big, res.docs.map((d) => d.chars).sort((a, b) => b - a).slice(0, 3));
if (big) {
  console.log(`\n[大文档] ${big.name}  ${big.chars} 字 / ${big.lines} 行 / ${big.sections.length} 章节`);
}

// 容错
const empty = parseDoc('', 'x.md');
check('空文件不抛异常', !!empty && empty.title === 'x', empty.title);

const noH2 = parseDoc('# 只有标题\n\n正文内容', 'y.md');
check('没有章节的文档也能解析', noH2.sections.length === 0 && noH2.body.indexOf('正文') >= 0, noH2);

const bad = scanKnowledge('D:\\不存在的知识库');
check('目录不存在返回 error', !!bad.error, bad.error);

// 性能
const t0 = Date.now();
scanKnowledge(ROOT);
const ms = Date.now() - t0;
console.log(`\n全量扫描耗时: ${ms}ms`);
check('全量扫描 1 秒内完成', ms < 1000, ms);

const failed = results.filter((r) => !r.ok);
console.log('\n===== 知识库解析测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
