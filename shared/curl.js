'use strict';
/**
 * cURL 命令解析器
 *
 * 目标：把从 Chrome DevTools / Postman / Apifox 复制的 cURL 命令，
 * 解析成接口记录需要的字段（方法 / URL / Headers / Body）。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **先归一化，再分词**
 *    不能直接正则匹配——引号嵌套、续行符、转义字符会让正则失效。
 *
 * 2. **只覆盖常见子集**
 *    cURL 有 200+ 参数，全支持不现实。不认识的参数**忽略并记录到 warnings**，
 *    让用户知道「有什么没被解析」。
 *
 * 3. **解析失败不抛异常**
 *    返回 { ok: false, message }，UI 层决定怎么提示。
 *
 * 4. **warnings 带 field**
 *    每条警告标明属于哪个字段（url/headers/body），
 *    表单里可以精确挂到对应字段旁。
 */

/** 支持的 HTTP 方法 */
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** 无副作用、可安全忽略的参数 */
const IGNORED_FLAGS = new Set([
  '--compressed',
  '-k',
  '--insecure',
  '-L',
  '--location',
  '-s',
  '--silent',
  '-v',
  '--verbose',
  '-i',
  '--include',
  '--no-buffer',
  '-N',
  '--globoff',
  '-g',
  '--http1.1',
  '--http2',
  '--tlsv1.2',
  '--tlsv1.3',
  '--fail',
  '-f',
  '--show-error',
  '-S',
  '--progress-bar',
  '-#'
]);

/**
 * 归一化：去掉续行符、多余空白
 * - Windows: `^` 在行尾
 * - Linux/macOS: `\` 在行尾
 * - 也处理 `\\` 转义（bash 的 $'...' 里）
 */
function normalize(raw) {
  let s = String(raw || '');
  // 去掉 BOM
  s = s.replace(/^\uFEFF/, '');
  // Windows 续行：行尾的 ^（可能带空格）
  s = s.replace(/\^\s*\r?\n/g, ' ');
  // Linux 续行：行尾的 \（但要注意 \\ 是转义，不是续行）
  // 用负向断言：前面不是反斜杠的单个反斜杠 + 换行
  s = s.replace(/(?<!\\)\\\s*\r?\n/g, ' ');
  // 压缩连续空白（但保留引号内的，这个在分词时处理）
  s = s.replace(/\r\n/g, '\n');
  return s.trim();
}

/**
 * 分词：按空格切，但引号内的空格不切。
 *
 * 支持：
 *   'single quoted'   → 原样（bash 里单引号内不转义）
 *   "double quoted"   → 处理 \" \\ \$ 等转义
 *   $'ansi-c'         → 处理 \n \t \r 等
 *   裸词              → 原样
 */
function tokenize(s) {
  const tokens = [];
  let cur = '';
  let i = 0;
  let quote = null; // null | "'" | '"' | 'ansi'

  const push = () => {
    if (cur !== '' || quote !== null) {
      tokens.push(cur);
      cur = '';
    }
  };

  while (i < s.length) {
    const ch = s[i];

    // $'...' 形式（bash ANSI-C 引用）
    if (quote === null && ch === '$' && s[i + 1] === "'") {
      quote = 'ansi';
      i += 2;
      continue;
    }

    if (quote === null) {
      if (ch === "'") {
        quote = "'";
        i++;
        continue;
      }
      if (ch === '"') {
        quote = '"';
        i++;
        continue;
      }
      if (/\s/.test(ch)) {
        push();
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // 在引号内
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        // 双引号内只转义这几个
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next;
          i += 2;
          continue;
        }
        // 其他情况保留反斜杠
        cur += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (quote === 'ansi') {
      if (ch === "'") {
        quote = null;
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
        if (map[next] !== undefined) {
          cur += map[next];
          i += 2;
          continue;
        }
        cur += ch;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
  }
  push();
  return tokens;
}

/** 从 URL 里猜一个名称（最后一段路径） */
function guessName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
    return u.hostname;
  } catch (e) {
    // URL 不合法（可能含占位符），用最后一段
    const m = /([^/?#]+)(?:[?#]|$)/.exec(String(url || ''));
    return m ? m[1] : '';
  }
}

/** 根据 Content-Type 和 body 内容推断类型 */
function guessBodyType(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  if (!body) return 'none';
  if (ct.includes('application/json')) return 'json';
  if (ct.includes('application/x-www-form-urlencoded')) return 'form';
  if (ct.includes('multipart/form-data')) return 'form';
  if (ct.includes('xml')) return 'xml';
  // 没 Content-Type 时按内容猜
  const t = String(body).trim();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (/^[\w.-]+=[\w.-]*(&[\w.-]+=[\w.-]*)*$/.test(t)) return 'form';
  return 'text';
}

/**
 * 解析 cURL 命令。
 *
 * @param {string} raw cURL 命令原文
 * @returns {{
 *   ok: boolean,
 *   message?: string,
 *   method?: string,
 *   url?: string,
 *   name?: string,
 *   headers?: string,
 *   body?: string,
 *   bodyType?: string,
 *   warnings?: {field: string, text: string}[]
 * }}
 */
function parseCurl(raw) {
  const text = normalize(raw);
  if (!text) {
    return { ok: false, message: '内容为空' };
  }
  if (!/^curl\b/i.test(text)) {
    return { ok: false, message: '不是 cURL 命令（应以 curl 开头）' };
  }

  const tokens = tokenize(text);
  // 去掉开头的 curl
  tokens.shift();

  const warnings = [];
  const headerLines = [];
  let method = '';
  let url = '';
  let body = '';
  let bodyType = '';
  let contentType = '';
  let hasForm = false;
  const formParts = [];
  const unknown = [];

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    // -X / --request
    if (t === '-X' || t === '--request') {
      method = String(tokens[i + 1] || '').toUpperCase();
      i += 2;
      continue;
    }

    // -H / --header
    if (t === '-H' || t === '--header') {
      const h = String(tokens[i + 1] || '');
      if (h) {
        headerLines.push(h);
        const ci = h.indexOf(':');
        if (ci > 0 && h.slice(0, ci).trim().toLowerCase() === 'content-type') {
          contentType = h.slice(ci + 1).trim();
        }
      }
      i += 2;
      continue;
    }

    // -d / --data / --data-raw / --data-binary / --data-urlencode
    if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') {
      const d = String(tokens[i + 1] || '');
      body = body ? body + '&' + d : d;
      i += 2;
      continue;
    }

    // -F / --form
    if (t === '-F' || t === '--form') {
      const f = String(tokens[i + 1] || '');
      if (f) {
        hasForm = true;
        formParts.push(f);
      }
      i += 2;
      continue;
    }

    // -u / --user
    if (t === '-u' || t === '--user') {
      const cred = String(tokens[i + 1] || '');
      if (cred) {
        const b64 = Buffer.from(cred, 'utf8').toString('base64');
        headerLines.push('Authorization: Basic ' + b64);
        warnings.push({
          field: 'headers',
          text: '已把 `-u ' + cred.split(':')[0] + ':***` 转成 Authorization: Basic 头'
        });
      }
      i += 2;
      continue;
    }

    // -b / --cookie
    if (t === '-b' || t === '--cookie') {
      const c = String(tokens[i + 1] || '');
      if (c) headerLines.push('Cookie: ' + c);
      i += 2;
      continue;
    }

    // --url
    if (t === '--url') {
      url = String(tokens[i + 1] || '');
      i += 2;
      continue;
    }

    // 无副作用参数
    if (IGNORED_FLAGS.has(t)) {
      i += 1;
      continue;
    }

    // 带值的未知参数（形如 --xxx value）
    if (/^--?[a-zA-Z]/.test(t)) {
      // 判断下一个 token 是不是值（不以 - 开头）
      const next = tokens[i + 1];
      if (next !== undefined && !/^--?[a-zA-Z]/.test(next)) {
        unknown.push(t + ' ' + next);
        i += 2;
      } else {
        unknown.push(t);
        i += 1;
      }
      continue;
    }

    // 裸词：第一个是 URL
    if (!url && /^https?:\/\//i.test(t)) {
      url = t;
      i += 1;
      continue;
    }
    // 也可能是没协议的域名
    if (!url && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) {
      url = 'https://' + t;
      i += 1;
      continue;
    }

    // 其他裸词：忽略
    unknown.push(t);
    i += 1;
  }

  // -F 表单数据：转成 key=value 文本
  if (hasForm) {
    body = formParts.join('\n');
    bodyType = 'form';
    warnings.push({
      field: 'body',
      text: '这是 multipart 表单（-F），已转成 key=value 文本，文件字段需要手动调整'
    });
  }

  // 推断方法
  if (!method) {
    if (body || hasForm) method = 'POST';
    else method = 'GET';
  }
  if (METHODS.indexOf(method) < 0) {
    warnings.push({ field: 'method', text: '不认识的方法 `' + method + '`，已按 GET 处理' });
    method = 'GET';
  }

  // 推断 body 类型
  if (!bodyType) bodyType = guessBodyType(contentType, body);

  // body 是 JSON 但解析不了
  if (bodyType === 'json' && body) {
    try {
      JSON.parse(body);
    } catch (e) {
      warnings.push({
        field: 'body',
        text: 'body 声明为 JSON 但解析失败（' + (e && e.message ? e.message : '格式错误') + '），已按原文保留'
      });
    }
  }

  // URL 检查
  if (!url) {
    warnings.push({ field: 'url', text: '没解析出 URL，请手动填写' });
  } else if (/\$\{|\{\{|%[A-Z_]+%\}/.test(url)) {
    warnings.push({ field: 'url', text: 'URL 含变量占位符，导入后需要填实际值' });
  }

  // 未知参数
  if (unknown.length) {
    warnings.push({
      field: 'headers',
      text: '忽略了 ' + unknown.length + ' 个不认识的参数：' + unknown.slice(0, 5).join(' ') + (unknown.length > 5 ? ' …' : '')
    });
  }

  return {
    ok: true,
    method,
    url,
    name: guessName(url),
    headers: headerLines.join('\n'),
    body,
    bodyType,
    warnings
  };
}

module.exports = { parseCurl, normalize, tokenize, guessName, guessBodyType, METHODS };
