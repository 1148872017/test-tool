'use strict';
/**
 * OpenAPI 文件解析（JSON / YAML）。
 *
 * 和 electron/openapi.js 的区别：
 *   openapi.js   是「同步到接口记录」用（写数据库）
 *   本文件       是「直接生成代码骨架」用（不写库，只读文件）
 *
 * 为什么要单独做：
 *   用户可能只有一份 openapi.json/yaml，不想污染接口记录表，
 *   只想生成几个测试类骨架。
 */

const fs = require('fs');
const yaml = require('js-yaml');
const openapi = require('./openapi');

/** 文件大小上限（和 apis:sync 一致） */
const MAX_SIZE = 40 * 1024 * 1024;

/**
 * 读文件并解析成对象。
 * @param {string} filePath
 * @returns {{ok: boolean, doc?: any, message?: string}}
 */
function loadFile(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return { ok: false, message: '没给文件路径' };
  if (!fs.existsSync(p)) return { ok: false, message: '文件不存在' };

  let raw;
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_SIZE) return { ok: false, message: '文件超过 40MB，先在 Apifox 里只导出要测的目录' };
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, message: '读文件失败：' + (e && e.message) };
  }

  // 去 BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const ext = String(p).toLowerCase().slice(String(p).lastIndexOf('.'));
  const isYaml = ext === '.yaml' || ext === '.yml';

  try {
    if (isYaml) {
      return { ok: true, doc: yaml.load(raw) };
    }
    return { ok: true, doc: JSON.parse(raw) };
  } catch (e) {
    try {
      // 扩展名可能不对（.txt / 无扩展名）→ 再试 yaml
      return { ok: true, doc: yaml.load(raw) };
    } catch (e2) {
      return { ok: false, message: '解析失败：' + (e2 && e2.message) };
    }
  }
}

/**
 * 解析 OpenAPI 文件，返回接口列表（**不写数据库**）。
 *
 * @param {string} filePath
 * @returns {{ok: boolean, items?: any[], doc?: string, message?: string}}
 */
function parseFile(filePath) {
  const loaded = loadFile(filePath);
  if (!loaded.ok) return loaded;

  const doc = loaded.doc;
  if (!doc || typeof doc !== 'object') {
    return { ok: false, message: '文件内容不是合法的 OpenAPI 文档' };
  }

  // 先做版本检查（parseOpenApi 对 Swagger 2.0 会抛错）
  const ver = String(doc.openapi || doc.swagger || '');
  if (doc.swagger && !doc.openapi) {
    return { ok: false, message: '这是 Swagger 2.0，请在 Apifox 里重新导出为 OpenAPI 3' };
  }
  if (!ver.startsWith('3.')) {
    return { ok: false, message: '不是 OpenAPI 3 文档（openapi 字段：' + (ver || '缺失') + '）' };
  }
  if (!doc.paths || !Object.keys(doc.paths).length) {
    return { ok: false, message: '文档里没有 paths（没有接口）' };
  }

  // 交给既有的解析器（它返回 {items, stats, doc}，失败时抛异常）
  let parsed;
  try {
    parsed = openapi.parseOpenApi(doc);
  } catch (e) {
    return { ok: false, message: '解析失败：' + (e && e.message) };
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    return { ok: false, message: '解析结果为空' };
  }
  if (!parsed.items.length) {
    return { ok: false, message: '文档里没有可用的接口' };
  }

  // 给每个 item 一个稳定的临时 id（前端选完直接用它生成，不用查库）
  const items = (parsed.items || []).map((it, i) => Object.assign({}, it, { tmpId: `tmp-${i}` }));

  return {
    ok: true,
    items,
    doc: parsed.doc || '',
    file: filePath
  };
}

module.exports = { parseFile, loadFile };