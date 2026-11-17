'use strict';
/**
 * 知识库索引（只读）
 *
 * 和用例索引同一套思路：md 是资产，平台只读不写。
 * 但知识库的形态不同——它是「业务规则沉淀」，一份文档讲一个模块，
 * 所以索引粒度是「文档 + 章节」，不是「用例」。
 *
 * 支持：
 *   - 扫描目录（可配置），跳过 _archive / _review 这类归档目录
 *   - 提取标题、更新时间、章节树（## / ###）
 *   - 全文搜索（标题 + 正文）
 *   - 详情里按章节渲染 markdown
 */
const fs = require('fs');
const path = require('path');

/** 归档/备份目录默认跳过：它们不是「当前有效」的知识 */
const SKIP_DIR_RE = /^(_archive|_review|_backup|\.)/i;

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 从文件头几行里找「更新时间」这类元信息 */
function extractMeta(lines) {
  const meta = { updatedAt: '', tags: [] };
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    const m = /^>\s*(?:更新时间|更新日期|最后更新)[:：]\s*(.+)$/.exec(line.trim());
    if (m) {
      meta.updatedAt = m[1].trim();
      continue;
    }
    const t = /^>\s*(?:标签|tags?)[:：]\s*(.+)$/i.exec(line.trim());
    if (t) {
      meta.tags = t[1]
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return meta;
}

/**
 * 提取章节树。
 * 只认 ## 和 ###（知识库文档一般两级够用），#### 及更深归到最近的 ### 下。
 */
function extractSections(lines) {
  const sections = [];
  let cur = null;
  let curSub = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);

    if (h2) {
      cur = { title: h2[1].trim(), line: i + 1, children: [], body: [] };
      sections.push(cur);
      curSub = null;
      continue;
    }
    if (h3 && cur) {
      curSub = { title: h3[1].trim(), line: i + 1, body: [] };
      cur.children.push(curSub);
      continue;
    }
    if (curSub) curSub.body.push(line);
    else if (cur) cur.body.push(line);
  }

  // 去掉首尾空行，算字数
  const trim = (arr) => {
    let a = 0;
    let b = arr.length;
    while (a < b && !arr[a].trim()) a++;
    while (b > a && !arr[b - 1].trim()) b--;
    return arr.slice(a, b);
  };

  for (const s of sections) {
    s.body = trim(s.body);
    s.text = s.body.join('\n');
    for (const c of s.children) {
      c.body = trim(c.body);
      c.text = c.body.join('\n');
    }
  }
  return sections;
}

/** 解析一份知识库 md */
function parseDoc(raw, filePath) {
  const text = stripBom(String(raw || '')).replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  const h1 = lines.find((l) => /^#\s+/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, '').trim() : path.basename(filePath).replace(/\.md$/i, '');
  const meta = extractMeta(lines);
  const sections = extractSections(lines);

  // 正文（去掉一级标题和元信息引用块）
  const bodyStart = h1 ? lines.indexOf(h1) + 1 : 0;
  const body = lines.slice(bodyStart).join('\n');

  return {
    title,
    meta,
    sections,
    body,
    chars: text.length,
    lines: lines.length
  };
}

/** 扫描知识库目录 */
function scanKnowledge(root, opts) {
  const options = opts || {};
  const out = { root: root || '', docs: [], totalDocs: 0, errors: [] };
  if (!root) {
    out.error = '未配置知识库目录';
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
        const parsed = parseDoc(fs.readFileSync(full, 'utf8'), full);
        out.docs.push({
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
  out.docs.sort((a, b) => b.mtime - a.mtime);
  out.totalDocs = out.docs.length;
  return out;
}

module.exports = { parseDoc, scanKnowledge, extractSections, extractMeta };
