/* 笔记索引 + 导入 md 测试 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseNote, scanNotes, importNotes } = require('../electron/notes.js');

const results = [];
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra: cond ? '' : JSON.stringify(extra) });

/* ---------- 1. 解析 ---------- */
const md = `# 我的笔记

> 更新时间: 2026-11-18

## 一、背景

这是背景说明。

## 二、方案

### 2.1 方案 A

方案 A 的细节。

### 2.2 方案 B

方案 B 的细节。
`;

const parsed = parseNote(md, '/tmp/test.md');
check('提取标题', parsed.title === '我的笔记', parsed.title);
check('提取更新时间', /2026-11-18/.test(parsed.meta.updatedAt), parsed.meta);
check('提取章节', parsed.sections.length === 2, parsed.sections.length);
check('章节有子章节', parsed.sections[1].children.length === 2, parsed.sections[1].children);
check('章节正文非空', parsed.sections[0].text.indexOf('背景说明') >= 0, parsed.sections[0].text);
check('字数统计', parsed.chars > 50, parsed.chars);

// 没有 h1 时用文件名
const noH1 = parseNote('## 只有二级标题\n\n内容', '/tmp/文件名笔记.md');
check('没有 h1 时用文件名当标题', noH1.title === '文件名笔记', noH1.title);

/* ---------- 2. 扫描 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-notes-'));
const notesDir = path.join(tmp, 'notes');
fs.mkdirSync(notesDir, { recursive: true });
fs.writeFileSync(path.join(notesDir, 'a.md'), '# 笔记A\n\n内容A', 'utf8');
fs.writeFileSync(path.join(notesDir, 'b.md'), '# 笔记B\n\n内容B', 'utf8');
fs.mkdirSync(path.join(notesDir, '_archive'), { recursive: true });
fs.writeFileSync(path.join(notesDir, '_archive', 'old.md'), '# 旧笔记', 'utf8');
fs.writeFileSync(path.join(notesDir, 'ignore.txt'), 'not md', 'utf8');

const scan = scanNotes(notesDir);
check('扫到 2 篇笔记', scan.totalNotes === 2, scan.totalNotes);
check('跳过 _archive 目录', scan.notes.every((n) => n.dir.indexOf('_archive') < 0), scan.notes.map((n) => n.relPath));
check('跳过非 md 文件', scan.notes.every((n) => /\.md$/i.test(n.name)), scan.notes.map((n) => n.name));
check('没有扫描错误', scan.errors.length === 0, scan.errors);

/* ---------- 3. 导入 md ---------- */
const srcDir = path.join(tmp, 'desktop');
fs.mkdirSync(srcDir, { recursive: true });
const src1 = path.join(srcDir, '新笔记.md');
fs.writeFileSync(src1, '# 新笔记\n\n从桌面导入', 'utf8');

const imp1 = importNotes([src1], notesDir, 'rename');
check('导入成功', imp1.moved.length === 1, imp1);
check('源文件已移走', !fs.existsSync(src1), '源文件还在');
check('目标文件存在', fs.existsSync(path.join(notesDir, '新笔记.md')), fs.readdirSync(notesDir));

// 冲突：rename
const src2 = path.join(srcDir, '新笔记.md');
fs.writeFileSync(src2, '# 新笔记 v2', 'utf8');
const imp2 = importNotes([src2], notesDir, 'rename');
check('冲突时重命名', imp2.renamed.length === 1 && imp2.renamed[0] === '新笔记-1.md', imp2);

// 冲突：skip
const src3 = path.join(srcDir, '新笔记.md');
fs.writeFileSync(src3, '# 新笔记 v3', 'utf8');
const imp3 = importNotes([src3], notesDir, 'skip');
check('冲突时跳过', imp3.skipped.length === 1 && imp3.moved.length === 0, imp3);
check('跳过时源文件保留', fs.existsSync(src3), '源文件被删了');

// 冲突：overwrite
const src4 = path.join(srcDir, '新笔记.md');
fs.writeFileSync(src4, '# 新笔记 v4 覆盖版', 'utf8');
const imp4 = importNotes([src4], notesDir, 'overwrite');
check('冲突时覆盖', imp4.moved.length === 1, imp4);
const afterOverwrite = fs.readFileSync(path.join(notesDir, '新笔记.md'), 'utf8');
check('覆盖后内容是新版', afterOverwrite.indexOf('v4 覆盖版') >= 0, afterOverwrite.slice(0, 40));

// 非 md 文件被拒
const txt = path.join(srcDir, 'x.txt');
fs.writeFileSync(txt, 'not md', 'utf8');
const imp5 = importNotes([txt], notesDir, 'rename');
check('非 md 文件被拒绝', imp5.errors.length === 1 && /只支持/.test(imp5.errors[0].message), imp5);

// 源文件不存在
const imp6 = importNotes([path.join(srcDir, '不存在.md')], notesDir, 'rename');
check('源文件不存在报错', imp6.errors.length === 1 && /不存在/.test(imp6.errors[0].message), imp6);

// 目录不存在时自动创建
const newDir = path.join(tmp, 'auto-created');
const src7 = path.join(srcDir, 'auto.md');
fs.writeFileSync(src7, '# auto', 'utf8');
const imp7 = importNotes([src7], newDir, 'rename');
check('目录不存在时自动创建', imp7.moved.length === 1 && fs.existsSync(newDir), imp7);

// 导入后能被扫描到
const scan2 = scanNotes(notesDir);
check('导入后能被扫描到', scan2.totalNotes >= 4, scan2.totalNotes);

/* ---------- 4. 容错 ---------- */
const empty = scanNotes('');
check('未配置目录返回 error', !!empty.error, empty.error);
const bad = scanNotes(path.join(tmp, '不存在'));
check('目录不存在返回 error', !!bad.error, bad.error);

fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('===== 笔记索引测试 =====');
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '  -> ' + r.extra : ''));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
