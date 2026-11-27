'use strict';

/**
 * OpenAPI 3 → 工作台接口记录
 *
 * 只做「读文件 → 变成结构化记录」，不联网、不调 Apifox 接口、不写任何文件。
 * 目的是把开发在 Apifox 里建好的接口搬进本地库，再叠一层自己的备注。
 *
 * 约定：
 *   - 只支持 OpenAPI 3（Apifox 导出的时候选这个）；Swagger 2.0 给明确报错，别让它静默少字段
 *   - url = servers[0].url + path（servers 里的 {变量} 用 variables 的 default 填）
 *   - 同一 method+url 只留一条（去重，防导出文件里重复）
 *   - Schema 超过 MAX_SCHEMA_CHARS 截断并注明，不把几 MB 的 JSON 塞进库
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_SCHEMA_CHARS = 6000;
const PARAM_ORDER = { path: 0, query: 1, header: 2, cookie: 3 };

/**
 * 「没写进库的条目」明细最多留几条（解析层和 store 层共用这一个数）。
 *
 * 为什么要限条数：一次同步几百个接口时，把每条「为什么没进库」都塞进结果卡片，
 * 弹窗会被刷爆，用户真正要看的「影响面」反而被挤到看不见。
 * 8 条够覆盖小项目里的全部异常；超出的只留总数，界面显示「还有 N 条」。
 */
const MAX_SKIP_DETAIL = 8;

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 把 #/components/... 这类本地 $ref 就地展开（限深 + 防循环） */
function resolveRefs(node, root, depth = 0, seen = new Set()) {
  if (depth > 12 || node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, root, depth + 1, seen));
  if (!isObj(node)) return node;

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (ref.charAt(0) !== '#' || seen.has(ref)) return node; // 外部引用/循环：原样留着，不猜
    const target = ref
      .slice(1)
      .split('/')
      .filter(Boolean)
      .reduce((acc, seg) => (isObj(acc) || Array.isArray(acc) ? acc[seg] : undefined), root);
    if (target === undefined) return node;
    const next = new Set(seen);
    next.add(ref);
    return resolveRefs(target, root, depth + 1, next);
  }

  const out = {};
  for (const k of Object.keys(node)) out[k] = resolveRefs(node[k], root, depth + 1, seen);
  return out;
}

function inlineSchema(schema, root) {
  if (!schema) return '';
  let text = '';
  try {
    text = JSON.stringify(resolveRefs(schema, root), null, 2);
  } catch (e) {
    text = '';
  }
  if (!text) return '';
  if (text.length > MAX_SCHEMA_CHARS) {
    text = text.slice(0, MAX_SCHEMA_CHARS) + '\n…（Schema 过长，已截断；完整内容看 Apifox）';
  }
  return text;
}

/** servers[] → base url，把 {var} 换成 variables[var].default */
function joinBase(servers) {
  if (!Array.isArray(servers) || !servers.length) return '';
  const s = isObj(servers[0]) ? servers[0] : {};
  const vars = isObj(s.variables) ? s.variables : {};
  const url = String(s.url || '').replace(/\{([^}]+)\}/g, (all, name) => {
    const v = vars[name];
    return isObj(v) && v.default !== undefined ? String(v.default) : all;
  });
  return url.replace(/\/+$/, '');
}

function buildUrl(base, path) {
  const p = String(path || '');
  if (!base) return p;
  return base + (p === '/' ? '/' : '/' + p.replace(/^\/+/, ''));
}

/** path 级参数 + operation 级参数合并，同名同位置以 operation 为准 */
function mergedParams(pathItem, op, root) {
  const map = new Map();
  for (const src of [pathItem && pathItem.parameters, op.parameters]) {
    if (!Array.isArray(src)) continue;
    for (const raw of src) {
      const p = resolveRefs(raw, root);
      if (!isObj(p) || !p.name) continue;
      map.set(`${p.in || 'query'}:${p.name}`, p);
    }
  }
  return Array.from(map.values());
}

/**
 * 参数表格数据（给详情页的「参数」表格用）。
 *
 * 和 paramLines 的区别：
 *   paramLines 是给人看的文本摘要（一行一个）
 *   paramTable 是结构化数据（JSON），详情页可以渲染成表格
 *
 * 字段：
 *   in        位置（query/path/header/cookie）
 *   name      参数名
 *   required  是否必填
 *   type      类型
 *   example   示例值（有就用，没有留空）
 *   desc      描述
 */
function paramTable(params) {
  return params
    .slice()
    .sort(
      (a, b) =>
        (PARAM_ORDER[a.in] === undefined ? 9 : PARAM_ORDER[a.in]) -
        (PARAM_ORDER[b.in] === undefined ? 9 : PARAM_ORDER[b.in])
    )
    .map((p) => {
      const schema = isObj(p.schema) ? p.schema : {};
      const type = schema.type || (schema.$ref ? 'ref' : '');
      let example = '';
      if (p.example !== undefined) example = String(p.example);
      else if (schema.example !== undefined) example = String(schema.example);
      else if (schema.default !== undefined) example = String(schema.default);
      return {
        in: p.in || 'query',
        name: String(p.name || ''),
        required: !!p.required,
        type,
        example,
        desc: String(p.description || '').replace(/\s+/g, ' ').trim()
      };
    });
}

function paramLines(params) {
  return params
    .slice()
    .sort((a, b) => (PARAM_ORDER[a.in] === undefined ? 9 : PARAM_ORDER[a.in]) - (PARAM_ORDER[b.in] === undefined ? 9 : PARAM_ORDER[b.in]))
    .map((p) => {
      const schema = isObj(p.schema) ? p.schema : {};
      const type = schema.type || (schema.$ref ? 'ref' : '—');
      const desc = String(p.description || '').replace(/\s+/g, ' ').trim();
      return `${p.in || 'query'}: ${p.name}${p.required ? '*' : ''} (${type})${desc ? ' ' + desc : ''}`;
    });
}

/** schema 树里有没有 example / examples / default（判断「缺示例」） */
function hasExample(node, depth = 0) {
  if (!node || depth > 10) return false;
  if (Array.isArray(node)) return node.some((n) => hasExample(n, depth + 1));
  if (!isObj(node)) return false;
  if (node.example !== undefined || node.examples !== undefined || node.default !== undefined) return true;
  for (const k of ['properties', 'items', 'allOf', 'oneOf', 'anyOf', 'schema', 'additionalProperties']) {
    if (node[k] && hasExample(node[k], depth + 1)) return true;
  }
  return false;
}

/**
 * 把 OpenAPI 的媒体类型映射成我们的 bodyType 枚举。
 * 和 shared/collections.js 的 BODY_TYPE_OPTIONS 对应。
 */
function mapBodyType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (!ct) return 'none';
  if (ct.includes('x-www-form-urlencoded')) return 'x-www-form-urlencoded';
  if (ct.includes('multipart/form-data')) return 'form-data';
  if (ct.includes('application/json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('graphql')) return 'graphql';
  if (ct.includes('msgpack')) return 'msgpack';
  if (ct.includes('octet-stream') || ct.includes('image/') || ct.includes('application/pdf')) return 'binary';
  if (ct.startsWith('text/')) return 'text';
  return 'text';
}

/** 在 content 里挑一个媒体类型（优先 application/json） */
function pickContent(node, root) {
  const content = node && node.content;
  if (!isObj(content)) return null;
  const types = Object.keys(content);
  if (!types.length) return null;
  const type = types.indexOf('application/json') >= 0 ? 'application/json' : types[0];
  const media = resolveRefs(content[type], root);
  if (!isObj(media)) return null;
  return {
    type,
    schema: media.schema,
    hasExample: hasExample(media),
    // 保留 example 原文，用来填 body（Apifox 的「示例值」就在这里）
    example: media.example,
    examples: media.examples
  };
}

/**
 * 从 requestBody 生成 body 文本。
 *
 * 优先级：
 *   1. media.example（Apifox 导出的示例值，最有用）
 *   2. media.examples 里第一个
 *   3. schema 里的 example / default 拼一个
 *   4. 空
 *
 * 格式：
 *   - application/json → 格式化 JSON
 *   - x-www-form-urlencoded → key=value&key=value
 *   - 其他 → JSON 字符串
 */
function buildBodyText(req) {
  if (!req) return '';
  const ct = String(req.type || '').toLowerCase();

  // 1/2. 直接有 example
  let ex = req.example;
  if (ex === undefined && isObj(req.examples)) {
    const first = Object.keys(req.examples)[0];
    if (first) {
      const e = req.examples[first];
      ex = isObj(e) && e.value !== undefined ? e.value : e;
    }
  }

  // 3. 从 schema 里挖 example
  if (ex === undefined && isObj(req.schema)) {
    ex = exampleFromSchema(req.schema);
  }

  if (ex === undefined || ex === null) return '';

  // 按媒体类型格式化
  if (ct.includes('x-www-form-urlencoded')) {
    if (isObj(ex)) {
      return Object.keys(ex)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(ex[k]))}`)
        .join('&');
    }
    return String(ex);
  }

  if (typeof ex === 'string') return ex;
  try {
    return JSON.stringify(ex, null, 2);
  } catch (e) {
    return String(ex);
  }
}

/** 从 schema 树里挖一个示例对象（递归，最多 3 层） */
function exampleFromSchema(schema, depth = 0) {
  if (!isObj(schema) || depth > 3) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  if (schema.type === 'object' && isObj(schema.properties)) {
    const out = {};
    let any = false;
    for (const k of Object.keys(schema.properties)) {
      const v = exampleFromSchema(schema.properties[k], depth + 1);
      if (v !== undefined) {
        out[k] = v;
        any = true;
      }
    }
    return any ? out : undefined;
  }
  if (schema.type === 'array' && isObj(schema.items)) {
    const v = exampleFromSchema(schema.items, depth + 1);
    return v !== undefined ? [v] : undefined;
  }
  return undefined;
}

/**
 * 从 parameters 里提取 header 参数，生成 headers 文本。
 * 只取 in=header 的，query/path 不算。
 */
function buildHeadersText(paramList) {
  const lines = [];
  for (const p of paramList || []) {
    if (String(p.in || '').toLowerCase() !== 'header') continue;
    const name = String(p.name || '').trim();
    if (!name) continue;
    // 有 example 用 example，否则用类型占位
    let val = '';
    if (isObj(p.schema)) {
      if (p.schema.example !== undefined) val = String(p.schema.example);
      else if (p.schema.default !== undefined) val = String(p.schema.default);
      else if (p.schema.type) val = `<${p.schema.type}>`;
    }
    if (!val && p.example !== undefined) val = String(p.example);
    lines.push(`${name}: ${val}`);
  }
  return lines.join('\n');
}

/**
 * 从响应里生成示例文本（和 buildBodyText 同逻辑，但用于 response）。
 * 优先 media.example → examples 第一个 → schema 递归挖。
 */
function buildResponseExample(resp) {
  if (!resp) return '';
  let ex = resp.example;
  if (ex === undefined && isObj(resp.examples)) {
    const first = Object.keys(resp.examples)[0];
    if (first) {
      const e = resp.examples[first];
      ex = isObj(e) && e.value !== undefined ? e.value : e;
    }
  }
  if (ex === undefined && isObj(resp.schema)) {
    ex = exampleFromSchema(resp.schema);
  }
  if (ex === undefined || ex === null) return '';
  if (typeof ex === 'string') return ex;
  try {
    return JSON.stringify(ex, null, 2);
  } catch (e) {
    return String(ex);
  }
}

function pickResponse(op, root) {
  const responses = op.responses;
  if (!isObj(responses)) return null;
  const codes = Object.keys(responses);
  const code = codes.indexOf('200') >= 0 ? '200' : codes.filter((c) => /^2\d\d$/.test(c)).sort()[0] || (codes.indexOf('default') >= 0 ? 'default' : '');
  if (!code) return null;
  return pickContent(resolveRefs(responses[code], root), root);
}

function apiKey(method, url) {
  const m = String(method || '').trim().toUpperCase();
  const u = String(url || '').trim().replace(/\/+$/, '');
  return m && u ? `${m} ${u}` : '';
}

/* ------------------------------ 变更 diff ------------------------------ *
 * 只回答一个问题：这次同步里，哪些变化会让已经写好的用例失效？
 * 所以只挑「参数 / 请求体 / 响应体」的结构变化；描述文案改了不算（那是噪音）。
 * 老记录没有镜像字段（手写接口第一次同步）时一律不算变更，避免虚报。
 * -------------------------------------------------------------------- */

const KIND_ORDER = [
  'req-param-add',
  'req-required-add',
  'param-type',
  'req-param-remove',
  'req-required-remove',
  'param-add',
  'param-remove',
  'req-field-type',
  'req-field-add',
  'req-field-remove',
  'resp-field-type',
  'resp-field-add',
  'resp-field-remove'
];

function asJson(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** schema 的「形状」：顶层字段名 → 类型，加必填清单（数组 schema 往里钻一层） */
function schemaShape(text) {
  let obj = asJson(text);
  if (obj && obj.type === 'array' && obj.items) obj = obj.items;
  if (!obj || typeof obj !== 'object') return null;
  const props = obj.properties && typeof obj.properties === 'object' ? obj.properties : {};
  const fields = {};
  for (const key of Object.keys(props)) {
    const p = props[key] || {};
    fields[key] = String(p.type || (p.$ref ? 'ref' : '') || (p.enum ? 'enum' : '') || 'any');
  }
  return { fields, required: Array.isArray(obj.required) ? obj.required.slice() : [] };
}

function diffParamList(before, after) {
  const index = (list) => {
    const m = new Map();
    for (const p of list || []) {
      if (!p || !p.name) continue;
      m.set(`${p.in || 'query'}:${p.name}`, p);
    }
    return m;
  };
  const b = index(before);
  const a = index(after);
  const addReq = [];
  const addOpt = [];
  const delReq = [];
  const delOpt = [];
  const typed = [];

  for (const [key, p] of a) {
    const old = b.get(key);
    if (!old) {
      (p.required ? addReq : addOpt).push(p.name);
      continue;
    }
    if (String(old.type || '') !== String(p.type || '')) {
      typed.push(`${p.name}: ${old.type || '?'}→${p.type || '?'}`);
    } else if (!old.required && p.required) {
      addReq.push(p.name); // 可选变必填：最容易让老用例直接挂，排最前
    } else if (old.required && !p.required) {
      delReq.push(p.name);
    }
  }
  for (const [key, p] of b) if (!a.has(key)) (p.required ? delReq : delOpt).push(p.name);

  const out = [];
  if (addReq.length) out.push({ kind: 'req-param-add', label: `必填参数 +${addReq.length}`, detail: addReq.join(', ') });
  if (delReq.length) out.push({ kind: 'req-param-remove', label: `必填参数 -${delReq.length}`, detail: delReq.join(', ') });
  if (typed.length) out.push({ kind: 'param-type', label: `参数类型变 ${typed.length}`, detail: typed.join(', ') });
  if (addOpt.length) out.push({ kind: 'param-add', label: `参数 +${addOpt.length}`, detail: addOpt.join(', ') });
  if (delOpt.length) out.push({ kind: 'param-remove', label: `参数 -${delOpt.length}`, detail: delOpt.join(', ') });
  return out;
}

function diffSchemaPair(beforeText, afterText, which) {
  const b = schemaShape(beforeText);
  const a = schemaShape(afterText);
  if (!b || !a) return [];

  const prefix = which === 'req' ? 'req' : 'resp';
  const name = which === 'req' ? '请求体' : '响应体';
  const addFields = [];
  const delFields = [];
  const typed = [];

  for (const key of Object.keys(a.fields)) {
    if (b.fields[key] === undefined) addFields.push(key);
    else if (b.fields[key] !== a.fields[key]) typed.push(`${key}: ${b.fields[key]}→${a.fields[key]}`);
  }
  for (const key of Object.keys(b.fields)) if (a.fields[key] === undefined) delFields.push(key);

  const addReq = a.required.filter((k) => b.required.indexOf(k) < 0);
  const delReq = b.required.filter((k) => a.required.indexOf(k) < 0);

  const out = [];
  if (addReq.length) out.push({ kind: `${prefix}-required-add`, label: `${name}必填字段 +${addReq.length}`, detail: addReq.join(', ') });
  if (delReq.length) out.push({ kind: `${prefix}-required-remove`, label: `${name}必填字段 -${delReq.length}`, detail: delReq.join(', ') });
  if (typed.length) out.push({ kind: `${prefix}-field-type`, label: `${name}字段类型变 ${typed.length}`, detail: typed.join(', ') });
  if (addFields.length) out.push({ kind: `${prefix}-field-add`, label: `${name}字段 +${addFields.length}`, detail: addFields.join(', ') });
  if (delFields.length) out.push({ kind: `${prefix}-field-remove`, label: `${name}字段 -${delFields.length}`, detail: delFields.join(', ') });
  return out;
}

/**
 * 比对库里旧记录与这次解析出来的新条目，只返回影响面相关的变更。
 * @param {object} before records.data（可能没有镜像字段）
 * @param {object} after  解析出来的新 item
 * @returns {{kind:string,label:string,detail?:string}[]}
 */
function diffApi(before, after) {
  if (!before || !after) return [];
  const changes = [];
  const beforeParams = asJson(before.paramSpec);
  const afterParams = asJson(after.paramSpec);
  if (Array.isArray(beforeParams) && Array.isArray(afterParams)) {
    changes.push(...diffParamList(beforeParams, afterParams));
  }
  changes.push(...diffSchemaPair(before.reqSchema, after.reqSchema, 'req'));
  changes.push(...diffSchemaPair(before.respSchema, after.respSchema, 'resp'));

  const rank = (c) => {
    const i = KIND_ORDER.indexOf(c.kind);
    return i < 0 ? 99 : i;
  };
  changes.sort((x, y) => rank(x) - rank(y));
  return changes.slice(0, 8);
}

/**
 * @param {object} doc   JSON.parse 之后的 OpenAPI 文档
 * @returns {{items: object[], stats: object, doc: object}}
 */
function parseOpenApi(doc) {
  if (!isObj(doc)) throw new Error('不是合法的 JSON 对象');
  if (doc.swagger) throw new Error('这是 Swagger 2.0，请在 Apifox 里重新导出为 OpenAPI 3');
  if (!String(doc.openapi || '').startsWith('3')) {
    throw new Error(`只支持 OpenAPI 3（文件里的 openapi 字段是「${doc.openapi || '空'}」）`);
  }
  if (!isObj(doc.paths) || !Object.keys(doc.paths).length) {
    throw new Error('文档里没有 paths，可能是空项目导出的');
  }

  const items = [];
  const seen = new Set();
  /**
   * 被去重掉的条目（最多 MAX_SKIP_DETAIL 条）。
   *
   * 原来这里只累加一个 div 计数（「重复 N 条」），用户永远不知道重复的是哪几个、
   * 该去 Apifox 里改哪条 —— 和 v0.69 修的「忽略 N 行」是同一类信息不透明，
   * 所以顺手把「接口名 + 同方法同地址」带上，界面上能直接指认。
   */
  const dupList = [];
  let dup = 0;

  for (const path of Object.keys(doc.paths)) {
    const pathItem = resolveRefs(doc.paths[path], doc);
    if (!isObj(pathItem)) continue;
    for (const m of HTTP_METHODS) {
      const op = pathItem[m];
      if (!isObj(op)) continue;

      const method = m.toUpperCase();
      const base = joinBase(op.servers) || joinBase(pathItem.servers) || joinBase(doc.servers);
      const url = buildUrl(base, path);
      const desc = String(op.description || '').trim();
      const summary = String(op.summary || '').trim();
      const name = summary || desc.split('\n')[0].trim() || String(op.operationId || '').trim() || `${method} ${path}`;
      const tags = Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
      const module = (tags[0] || '未分组').trim();

      const paramList = mergedParams(pathItem, op, doc);
      const params = paramLines(paramList);
      const req = pickContent(op.requestBody, doc);
      const resp = pickResponse(op, doc);
      const hasEx = !!((req && req.hasExample) || (resp && resp.hasExample));

      const key = apiKey(method, url);
      if (!key) continue;
      if (seen.has(key)) {
        dup++;
        if (dupList.length < MAX_SKIP_DETAIL) {
          dupList.push({
            name,
            method,
            url,
            kind: 'dup',
            reason: '同一个文件里重复定义（同方法同地址），只留了第一条'
          });
        }
        continue;
      }
      seen.add(key);

      items.push({
        name,
        method,
        url,
        module,
        summary: desc,
        params: params.join('\n'),
        // 给 diff 用的机器可读快照（params 那行是给人看的）
        paramSpec: JSON.stringify(
          paramList.map((p) => ({
            in: p.in || 'query',
            name: p.name,
            required: !!p.required,
            type: (isObj(p.schema) && p.schema.type) || (isObj(p.schema) && p.schema.$ref ? 'ref' : '')
          }))
        ),
        reqSchema: req ? inlineSchema(req.schema, doc) : '',
        respSchema: resp ? inlineSchema(resp.schema, doc) : '',
        // 响应示例（Apifox 的「响应示例」页签内容）
        respExample: buildResponseExample(resp),
        // 参数表格（结构化，详情页渲染成表格）
        paramTable: JSON.stringify(paramTable(paramList)),
        // body / headers：从 requestBody 的 example 和 header 参数生成
        // （之前完全没填，导致详情页 Body/Headers 是空的，和 Apifox 差很多）
        body: buildBodyText(req),
        // body 的媒体类型（x-www-form-urlencoded / JSON / form-data …）
        bodyType: req ? mapBodyType(req.type) : 'none',
        headers: buildHeadersText(paramList),
        completeness: !summary && !desc ? 'missing-desc' : hasEx ? 'ok' : 'missing-example',
        source: 'openapi'
      });
    }
  }

  if (!items.length) throw new Error('文档里一个接口都没解析出来（paths 里没有 GET/POST/PUT/PATCH/DELETE）');

  const info = isObj(doc.info) ? doc.info : {};
  return {
    items,
    // dupList 是 dup 的明细（可能被截断）；dup 始终是准确总数，界面用「总数 + 前 8 条」
    stats: { total: items.length, dup, dupList },
    doc: {
      title: String(info.title || ''),
      version: String(info.version || ''),
      baseUrl: joinBase(doc.servers)
    }
  };
}

module.exports = { parseOpenApi, apiKey, joinBase, buildUrl, diffApi, MAX_SCHEMA_CHARS, MAX_SKIP_DETAIL };