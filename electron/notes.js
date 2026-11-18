'use strict';
/**
 * 笔记索引（只读）+ 导入 md
 *
 * 和用例、知识库同一套模式：md 是资产，平台只读不写。
 * 但笔记多一个动作：**导入 md** —— 把外部 md 移动进笔记目录，之后被扫描到。
 *
 * 为什么是「移动」不是「复制」：
 *   复制会产生两份真源（桌面一份、笔记目录一份），改了不同步。
 *   移动是「归档」语义，符合「把散落的 md 收进来」的实际动作。
 */
const fs = require('fs');
const path = require('path');
const knowledge = require('./knowledge');

/** 归档/备份目录默认跳过 */
const SKIP_DIR_RE = /^(_archive|_review|_backup|\.)/i;

/**
 * 解析一份笔记 md。
 * 复用知识库的章节提取（## / ### 两级），但笔记的标题规则不同：
 *   - 有 `# 标题` → 用它
 *   - 没有 → 用文件名（去掉 .md）
 */
function parseNote(raw, filePath) {
  const doc = knowledge.parseDoc(raw, filePath);
  const baseName = path.basename(filePath).replace(/\.md$/i, '');
  // knowledge.parseDoc 在没有 h1 时已经回退到文件名，这里保持一致
  return {
    title: doc.title || baseName,
    meta: doc.meta,
    sections: doc.sections,
    body: doc.body,
    chars: doc.chars,
    lines: doc.lines
  };
}

/** 扫描笔记目录 */
function scanNotes(root) {
  const out = { root: root || '', notes: [], totalNotes: 0, errors: [] };
  if (!root) {
    out.error = '未配置笔记目录';
    return out;
  }
  if (!fs.existsSync(root)) {
    out.error = '目录不存在：' + root;
    return out;
  }

  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      out.errors.push({ file: rel || '.', message: String((e && e.message) || e) });
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIR_RE.test(ent.name)) continue;
        if (ent.name === 'node_modules') continue;
        walk(full, relPath);
        continue;
      }
      if (!/\.(md|markdown)$/i.test(ent.name)) continue;
      try {
        const stat = fs.statSync(full);
        const parsed = parseNote(fs.readFileSync(full, 'utf8'), full);
        out.notes.push({
          relPath,
          name: ent.name,
          dir: rel || '',
          fullPath: full,
          title: parsed.title,
          meta: parsed.meta,
          sections: parsed.sections,
          body: parsed.body,
          chars: parsed.chars,
          lines: parsed.lines,
          mtime: stat.mtimeMs,
          size: stat.size
        });
      } catch (e) {
        out.errors.push({ file: relPath, message: String((e && e.message) || e) });
      }
    }
  };

  walk(root, '');
  out.notes.sort((a, b) => b.mtime - a.mtime);
  out.totalNotes = out.notes.length;
  return out;
}

/**
 * 导入 md：把外部文件**移动**进笔记目录。
 *
 * @param {string[]} files 源文件绝对路径
 * @param {string} root 笔记目录
 * @param {string} onConflict 'overwrite' | 'skip' | 'rename'
 * @returns {{moved: string[], skipped: string[], renamed: string[], errors: {file,message}[]}}
 */
function importNotes(files, root, onConflict) {
  const result = { moved: [], skipped: [], renamed: [], errors: [] };
  if (!root) {
    result.errors.push({ file: '', message: '未配置笔记目录' });
    return result;
  }
  if (!fs.existsSync(root)) {
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (e) {
      result.errors.push({ file: root, message: '创建笔记目录失败：' + ((e && e.message) || e) });
      return result;
    }
  }

  const mode = ['overwrite', 'skip', 'rename'].indexOf(onConflict) >= 0 ? onConflict : 'rename';

  for (const src of Array.isArray(files) ? files : []) {
    const from = String(src || '').trim();
    if (!from) continue;
    if (!fs.existsSync(from)) {
      result.errors.push({ file: from, message: '源文件不存在' });
      continue;
    }
    if (!/\.(md|markdown)$/i.test(from)) {
      result.errors.push({ file: from, message: '只支持 .md / .markdown' });
      continue;
    }

    const baseName = path.basename(from);
    let target = path.join(root, baseName);

    // 源文件已经在笔记目录里 → 跳过（避免自己移自己）
    if (path.resolve(from) === path.resolve(target)) {
      result.skipped.push(baseName);
      continue;
    }

    if (fs.existsSync(target)) {
      if (mode === 'skip') {
        result.skipped.push(baseName);
        continue;
      }
      if (mode === 'rename') {
        const stem = baseName.replace(/\.(md|markdown)$/i, '');
        const ext = path.extname(baseName);
        let i = 1;
        while (fs.existsSync(path.join(root, `${stem}-${i}${ext}`))) i++;
        target = path.join(root, `${stem}-${i}${ext}`);
        result.renamed.push(path.basename(target));
      }
      // overwrite 模式：直接覆盖
    }

    try {
      fs.renameSync(from, target);
      result.moved.push(path.basename(target));
    } catch (e) {
      // 跨盘符 rename 会失败（EXDEV），退化成「复制 + 删除」
      if (e && e.code === 'EXDEV') {
        try {
          fs.copyFileSync(from, target);
          fs.unlinkSync(from);
          result.moved.push(path.basename(target));
        } catch (e2) {
          result.errors.push({ file: from, message: String((e2 && e2.message) || e2) });
        }
      } else {
        result.errors.push({ file: from, message: String((e && e.message) || e) });
      }
    }
  }

  return result;
}

module.exports = { parseNote, scanNotes, importNotes };
