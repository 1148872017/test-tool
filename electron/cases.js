'use strict';
/**
 * 用例索引（只读）
 * 把用例目录里的 markdown 解析成结构化用例，供界面检索/查看。
 * 绝不写回文件——md 是唯一事实源。
 *
 * 支持两种格式：
 *  1) 标准 TC：## 模块 / ### 分支 / #### [风险] [类型] 标题
 *              - 前置：/ - 操作：/ - 预期：（含 三维断言迹）
 *  2) 极简链路：## C1 标题 [冒烟] + - **前置**: / - **操作**:（有序列表）/ - **预期**: + - [ ] 检查项
 */
const fs = require('fs');
const path = require('path');

const RISK_RE = /(🔴|🟡|🟢|高风险|中风险|低风险|高|中|低)/;
const CATS = ['冒烟', '功能', '异常', '边界', '兼容', '性能', '安全', '高级', '回归', '数据', '接口', 'UI', '可用性'];
const SECTION_RE =
  /^\s*[-*]\s*(?:\*\*)?(前置条件|前置|操作步骤|操作|步骤|预期结果|预期|备注|检查项)(?:\*\*)?\s*[：:]\s*(.*)$/;
const CHECK_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/;
const ITEM_RE = /^\s*(?:\d+[.、)]|[-*])\s+(.*)$/;
const SECTION_MAP = {
  前置条件: 'pre',
  前置: 'pre',
  操作: 'steps',
  操作步骤: 'steps',
  步骤: 'steps',
  预期: 'expects',
  预期结果: 'expects',
  备注: 'notes',
  检查项: 'checklist'
};

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseTitleTags(raw) {
  const tags = [];
  const re = /\[([^\]]{1,14})\]/g;
  let m;
  while ((m = re.exec(raw))) tags.push(m[1].trim());
  let risk = '';
  let type = '';
  for (const t of tags) {
    if (!risk && RISK_RE.test(t)) {
      risk = t;
      continue;
    }
    if (!type && CATS.some((c) => t.indexOf(c) >= 0)) type = t;
  }
  const corePath = raw.indexOf('🛤') >= 0;
  const title = raw
    .replace(/\[[^\]]{1,14}\]/g, ' ')
    .replace(/🛤️?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, risk, type, corePath, tags };
}

function depthOf(line) {
  const m = /^(\s*)/.exec(line);
  return Math.min(3, Math.floor((m ? m[1].length : 0) / 2));
}

function itemText(line) {
  const m = ITEM_RE.exec(line.replace(CHECK_RE, '$2'));
  return (m ? m[1] : line).trim();
}

function pushItem(list, line, section, checked) {
  const text = itemText(line);
  if (!text) return;
  const item = { depth: depthOf(line), text };
  if (section === 'checklist') {
    item.done = !!checked;
  }
  list.push(item);
}

function parseAssertions(lines) {
  const out = [];
  let covers = [];
  for (const line of lines) {
    const m = /(?:三维)?断言[迹证][：:]\s*(.+)$/.exec(line);
    if (m) {
      const body = m[1];
      for (const seg of body.split(/[｜|]/)) {
        const part = seg.replace(/\[覆盖[^\]]*\]/g, '').trim();
        if (!part) continue;
        const dm = /^([A-Za-z\u4e00-\u9fa5]{1,6})\s*[:：]\s*(.*)$/.exec(part);
        if (dm) out.push({ dim: dm[1], text: dm[2].trim() });
        else out.push({ dim: '', text: part });
      }
    }
    const cm = /\[覆盖\s*([^\]]+)\]/.exec(line);
    if (cm) {
      covers = covers.concat(
        cm[1]
          .split(/[+＋,，、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  }
  return { assertions: out, covers: Array.from(new Set(covers)) };
}

function parseMarkdown(raw, filePath) {
  const text = stripBom(String(raw || '')).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const fileTitle = h1 ? h1.replace(/^#\s+/, '').trim() : path.basename(filePath).replace(/\.md$/i, '');
  const fileMeta = [];
  for (const l of lines) {
    if (/^##\s+/.test(l)) break;
    if (/^>\s?/.test(l)) fileMeta.push(l.replace(/^>\s?/, '').trim());
  }

  const hasH4 = lines.some((l) => /^####\s+/.test(l));
  const caseLevel = hasH4 ? 4 : 3;

  const cases = [];
  let module = '';
  let branch = '';
  let cur = null;
  let section = '';
  let chainMeta = [];

  const startCase = (kind, rawTitle, lineNo, id) => {
    const tags = parseTitleTags(rawTitle);
    cur = {
      kind,
      index: cases.length + 1,
      id: id || `#${cases.length + 1}`,
      module,
      branch,
      title: tags.title || rawTitle.trim(),
      risk: tags.risk,
      type: tags.type,
      corePath: tags.corePath,
      tags: tags.tags,
      pre: [],
      steps: [],
      expects: [],
      notes: [],
      checklist: [],
      chainMeta: [],
      line: lineNo,
      _lines: []
    };
    section = '';
    chainMeta = [];
  };

  const flush = () => {
    if (!cur) return;
    cur.chainMeta = chainMeta.slice();
    const scan = cur._lines;
    const { assertions, covers } = parseAssertions(scan);
    cur.assertions = assertions;
    cur.covers = covers;
    delete cur._lines;
    cases.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = /^(#{1,5})\s+(.*)$/.exec(line);
    if (hm) {
      const level = hm[1].length;
      const heading = hm[2].trim();
      if (level === 1) {
        flush();
        module = '';
        branch = '';
        continue;
      }
      if (level === 2) {
        flush();
        branch = '';
        const chain = /^(C\d+)\b\s*(.*)$/.exec(heading);
        if (chain) {
          startCase('chain', chain[2] || heading, i + 1, chain[1]);
          module = '';
        } else {
          const tags = parseTitleTags(heading);
          module = tags.title || heading;
        }
        continue;
      }
      if (level === 3) {
        if (caseLevel === 3) {
          flush();
          startCase('standard', heading, i + 1);
        } else {
          const tags = parseTitleTags(heading);
          branch = tags.title || heading;
        }
        continue;
      }
      if (level === 4) {
        if (caseLevel === 4) {
          flush();
          startCase('standard', heading, i + 1);
        }
        continue;
      }
      continue;
    }

    if (!cur) continue;
    cur._lines.push(line);

    // 引用块：链路用例的「覆盖回归流程」
    if (/^>\s?/.test(line)) {
      if (cur.chainMeta.length < 6) chainMeta.push(line.replace(/^>\s?/, '').trim());
      continue;
    }
    if (!line.trim()) continue;
    if (/^---+$/.test(line.trim())) continue;

    const cm = CHECK_RE.exec(line);
    if (cm) {
      pushItem(cur.checklist, line, 'checklist', cm[1].toLowerCase() === 'x');
      continue;
    }

    const sm = SECTION_RE.exec(line);
    if (sm) {
      const label = SECTION_MAP[sm[1]];
      section = label || '';
      const rest = (sm[2] || '').trim();
      if (rest) {
        if (section === 'pre' || section === 'steps' || section === 'expects' || section === 'notes') {
          pushItem(cur[section], '- ' + rest, section);
        }
      }
      continue;
    }

    if (section === 'pre' || section === 'steps' || section === 'expects' || section === 'notes') {
      pushItem(cur[section], line, section);
    }
  }
  flush();

  return { fileTitle, fileMeta, cases };
}

function scanCases(root, opts) {
  const options = opts || {};
  const out = { root: root || '', files: [], totalCases: 0, totalFiles: 0, errors: [] };
  if (!root) {
    out.error = '未配置用例目录';
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
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        if (!options.includeReview && ent.name.startsWith('_')) continue;
        walk(full, relPath);
        continue;
      }
      if (!/\.md$/i.test(ent.name)) continue;
      try {
        const stat = fs.statSync(full);
        const parsed = parseMarkdown(fs.readFileSync(full, 'utf8'), full);
        // 评审报告/基线/台账这类文件里也会出现 #### 标题，别当用例文件
        const docHint = /(评审报告|评审基准|评审意见|检查报告|迁移报告|差异比对|台账|_diff)/.test(ent.name);
        const isCaseFile = parsed.cases.length > 0 && !docHint;
        if (!options.includeDocs && !isCaseFile) continue;
        out.files.push({
          relPath,
          name: ent.name,
          dir: rel || '',
          fullPath: full,
          title: parsed.fileTitle,
          meta: parsed.fileMeta,
          kind: isCaseFile ? 'cases' : 'doc',
          cases: parsed.cases,
          mtime: stat.mtimeMs,
          size: stat.size
        });
        out.totalCases += parsed.cases.length;
      } catch (e) {
        out.errors.push({ file: relPath, message: String((e && e.message) || e) });
      }
    }
  };
  walk(root, '');
  out.files.sort((a, b) => b.mtime - a.mtime);
  out.totalFiles = out.files.length;
  return out;
}

module.exports = { parseMarkdown, scanCases };