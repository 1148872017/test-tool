'use strict';
/**
 * JMeter jmx 索引（只读）
 *
 * jmx 是 XML，平台只解析不修改 —— 编辑器归 JMeter GUI。
 * 解析规格按 xdclass《玩转 Jmeter5.X》教程讲的组件来：
 *   线程组（含 setUp/tearDown）、HTTP 采样器、HTTP 请求默认值、信息头管理器、
 *   用户定义变量、CSV Data Set Config、响应断言、持续时间断言、BeanShell 三类、
 *   JSON 提取器、同步定时器（集合点）、监听器、循环控制器。
 *
 * 解析失败不抛错：返回 raw 片段，界面显示原文，别让一个坏文件毁掉整个列表。
 */
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

/* ------------------------------------------------------------------ *
 * DOM 小工具
 * ------------------------------------------------------------------ */

function children(el) {
  const out = [];
  if (!el || !el.childNodes) return out;
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n.nodeType === 1) out.push(n);
  }
  return out;
}

function byTag(el, tag) {
  return children(el).filter((n) => n.tagName === tag);
}

function textOf(el) {
  if (!el) return '';
  return String(el.textContent === undefined || el.textContent === null ? '' : el.textContent);
}

/** 取 <stringProp name="X">v</stringProp> 的值 */
function prop(el, name) {
  for (const n of byTag(el, 'stringProp')) {
    if (n.getAttribute('name') === name) return textOf(n);
  }
  return '';
}

function boolProp(el, name) {
  for (const n of byTag(el, 'boolProp')) {
    if (n.getAttribute('name') === name) return textOf(n) === 'true';
  }
  return null;
}

function intProp(el, name) {
  for (const n of byTag(el, 'intProp')) {
    if (n.getAttribute('name') === name) return Number(textOf(n));
  }
  return null;
}

function longProp(el, name) {
  for (const n of byTag(el, 'longProp')) {
    if (n.getAttribute('name') === name) return Number(textOf(n));
  }
  return null;
}

/** 所有 stringProp 摊平成对象 */
function props(el) {
  const out = {};
  for (const n of byTag(el, 'stringProp')) out[n.getAttribute('name')] = textOf(n);
  return out;
}

/** elementProp 里的 name/value 对（变量、header、参数都用这个结构） */
function elementPairs(el, collectionName, nameKey, valueKey) {
  const out = [];
  for (const cp of byTag(el, 'collectionProp')) {
    if (collectionName && cp.getAttribute('name') !== collectionName) continue;
    for (const ep of byTag(cp, 'elementProp')) {
      const p = props(ep);
      const name = p[nameKey];
      if (name === undefined) continue;
      out.push({ name, value: p[valueKey] === undefined ? '' : p[valueKey] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 组件解析
 * ------------------------------------------------------------------ */

const THREAD_GROUP_TYPES = {
  ThreadGroup: 'thread',
  SetupThreadGroup: 'setup',
  PostThreadGroup: 'teardown'
};

function parseThreadGroup(el) {
  const p = props(el);
  const type = THREAD_GROUP_TYPES[el.tagName] || 'thread';
  // 循环控制器是 ThreadGroup 的 elementProp 子元素，不是独立节点
  let loops = p['LoopController.loops'] || '';
  if (!loops) {
    for (const ep of byTag(el, 'elementProp')) {
      if (ep.getAttribute('testclass') !== 'LoopController') continue;
      loops = prop(ep, 'LoopController.loops') || '';
    }
  }
  return {
    type,
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    numThreads: p['ThreadGroup.num_threads'] || '',
    rampUp: p['ThreadGroup.ramp_time'] || '',
    duration: p['ThreadGroup.duration'] || '',
    delay: p['ThreadGroup.delay'] || '',
    scheduler: p['ThreadGroup.scheduler'] === 'true',
    loops,
    onSampleError: p['ThreadGroup.on_sample_error'] || ''
  };
}

function parseHttpSampler(el) {
  const p = props(el);
  const args = [];
  for (const ep of byTag(el, 'elementProp')) {
    if (ep.getAttribute('elementType') !== 'Arguments') continue;
    for (const cp of byTag(ep, 'collectionProp')) {
      for (const arg of byTag(cp, 'elementProp')) {
        const ap = props(arg);
        if (ap['Argument.name'] !== undefined) {
          args.push({ name: ap['Argument.name'], value: ap['Argument.value'] || '' });
        }
      }
    }
  }
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    method: p['HTTPSampler.method'] || 'GET',
    domain: p['HTTPSampler.domain'] || '',
    port: p['HTTPSampler.port'] || '',
    protocol: p['HTTPSampler.protocol'] || '',
    path: p['HTTPSampler.path'] || '',
    args,
    body: p['HTTPSampler.postBodyRaw'] ? '(raw)' : '',
    followRedirects: p['HTTPSampler.follow_redirects'] === 'true'
  };
}

function parseDefaults(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    domain: p['HTTPSampler.domain'] || '',
    port: p['HTTPSampler.port'] || '',
    protocol: p['HTTPSampler.protocol'] || '',
    path: p['HTTPSampler.path'] || '',
    contentEncoding: p['HTTPSampler.contentEncoding'] || ''
  };
}

function parseCsv(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    filename: p['filename'] || '',
    variableNames: p['variableNames'] || '',
    delimiter: p['delimiter'] || '',
    fileEncoding: p['fileEncoding'] || '',
    shareMode: p['shareMode'] || '',
    recycle: p['recycle'] === 'true',
    stopThread: p['stopThread'] === 'true'
  };
}

function parseResponseAssertion(el) {
  const p = props(el);
  const patterns = [];
  for (const cp of byTag(el, 'collectionProp')) {
    if (cp.getAttribute('name') !== 'Asserion.test_strings') continue;
    for (const sp of byTag(cp, 'stringProp')) patterns.push(textOf(sp));
  }
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    field: p['Assertion.test_field'] || '',
    matchRule: p['Assertion.test_type'] || '',
    patterns,
    customMessage: p['Assertion.custom_message'] || ''
  };
}

function parseDurationAssertion(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    duration: p['DurationAssertion.duration'] || ''
  };
}

function parseBeanShell(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    script: p['BeanShell.script'] || '',
    filename: p['BeanShell.filename'] || ''
  };
}

function parseJsonExtractor(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    varName: p['JSONPostProcessor.referenceNames'] || '',
    jsonPath: p['JSONPostProcessor.jsonPathExprs'] || '',
    defaultValue: p['JSONPostProcessor.defaultValues'] || ''
  };
}

function parseSyncTimer(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    groupSize: p['groupSize'] || '',
    timeout: p['timeout'] || ''
  };
}

function parseHeaderManager(el) {
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    headers: elementPairs(el, 'HeaderManager.headers', 'Header.name', 'Header.value')
  };
}

function parseArguments(el) {
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    vars: elementPairs(el, 'Arguments.arguments', 'Argument.name', 'Argument.value').map((v) => {
      // 描述在 Argument.desc 里，单独捞一次
      let desc = '';
      for (const cp of byTag(el, 'collectionProp')) {
        for (const ep of byTag(cp, 'elementProp')) {
          const p = props(ep);
          if (p['Argument.name'] === v.name) desc = p['Argument.desc'] || '';
        }
      }
      return { name: v.name, value: v.value, desc };
    })
  };
}

function parseListener(el, scope) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    enabled: el.getAttribute('enabled') !== 'false',
    class: el.getAttribute('testclass') || '',
    guiClass: el.getAttribute('guiclass') || '',
    filename: p['filename'] || '',
    // 挂在谁下面：采样器名 / 线程组名 / 测试计划。同名监听器靠这个区分
    scope: scope || ''
  };
}

/** 监听器类型的中文名（JMeter 的 guiclass 是稳定的，testname 会被用户改） */
const LISTENER_KIND = {
  ViewResultsFullVisualizer: '察看结果树',
  StatVisualizer: '聚合报告',
  SummaryReport: '汇总报告',
  GraphVisualizer: '图形结果',
  RespTimeGraphVisualizer: '响应时间图',
  SimpleDataWriter: '简单数据写入器',
  BackendListenerGui: '后端监听器',
  ResultCollector: '监听器'
};

function listenerKind(l) {
  return LISTENER_KIND[l.guiClass] || l.name || '监听器';
}

/* ------------------------------------------------------------------ *
 * 主解析
 * ------------------------------------------------------------------ */

function parseJmx(raw, filePath) {
  const text = String(raw || '');
  const out = {
    file: path.basename(filePath || ''),
    fullPath: filePath || '',
    jmeterVersion: '',
    xmlVersion: '',
    testPlanName: '',
    threadGroups: [],
    samplers: [],
    defaults: [],
    headers: [],
    variables: [],
    csvs: [],
    responseAssertions: [],
    durationAssertions: [],
    beanShell: { pre: [], post: [], assert: [] },
    jsonExtractors: [],
    syncTimers: [],
    listeners: [],
    loops: [],
    placeholders: [],
    parseError: ''
  };

  let doc;
  try {
    doc = new DOMParser({
      // 坏文件不往控制台喷警告，交给 parseError 处理
      errorHandler: {
        warning: () => {},
        error: () => {},
        fatalError: () => {}
      }
    }).parseFromString(text, 'text/xml');
  } catch (e) {
    out.parseError = String((e && e.message) || e);
    return out;
  }
  const root = doc && doc.documentElement;
  if (!root || root.tagName !== 'jmeterTestPlan') {
    out.parseError = '不是 JMeter 脚本（根节点不是 jmeterTestPlan）';
    return out;
  }

  out.jmeterVersion = root.getAttribute('jmeter') || '';
  out.xmlVersion = root.getAttribute('version') || '';

  /**
   * jmx 的结构是「元素 + 紧跟一个 hashTree，hashTree 里是它的子元素」。
   * 平铺遍历拿不到父子关系，而监听器/CSV/断言都挂在具体采样器下——
   * 4 个都叫「察看结果树」的监听器，只能靠 scope 区分。
   */
  const visit = (hashTree, scope) => {
    const kids = children(hashTree);
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (el.tagName === 'hashTree') continue;
      const tc = el.getAttribute('testclass') || '';
      const tag = el.tagName;
      const name = el.getAttribute('testname') || '';

      // 下一个兄弟是 hashTree → 它是 el 的子树
      const sub = i + 1 < kids.length && kids[i + 1].tagName === 'hashTree' ? kids[i + 1] : null;

      if (tag === 'TestPlan') {
        out.testPlanName = name;
        if (sub) visit(sub, name);
        if (sub) i++;
        continue;
      }
      if (THREAD_GROUP_TYPES[tag]) {
        out.threadGroups.push(parseThreadGroup(el));
        // 线程组下还有循环控制器、采样器等，必须继续往下走
        if (sub) visit(sub, name);
        if (sub) i++;
        continue;
      }

      switch (tc) {
        case 'HTTPSamplerProxy':
          out.samplers.push(parseHttpSampler(el));
          // 采样器下的监听器/CSV/断言，scope 记成这个采样器
          if (sub) visit(sub, name);
          break;
        case 'ConfigTestElement':
          out.defaults.push(parseDefaults(el));
          if (sub) visit(sub, scope);
          break;
        case 'HeaderManager':
          out.headers.push(parseHeaderManager(el));
          if (sub) visit(sub, scope);
          break;
        case 'Arguments':
          out.variables.push(parseArguments(el));
          if (sub) visit(sub, scope);
          break;
        case 'CSVDataSet':
          out.csvs.push(Object.assign(parseCsv(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'ResponseAssertion':
          out.responseAssertions.push(Object.assign(parseResponseAssertion(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'DurationAssertion':
          out.durationAssertions.push(Object.assign(parseDurationAssertion(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'BeanShellPreProcessor':
          out.beanShell.pre.push(Object.assign(parseBeanShell(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'BeanShellPostProcessor':
          out.beanShell.post.push(Object.assign(parseBeanShell(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'BeanShellAssertion':
          out.beanShell.assert.push(Object.assign(parseBeanShell(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'JSONPostProcessor':
          out.jsonExtractors.push(Object.assign(parseJsonExtractor(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'SyncTimer':
          out.syncTimers.push(Object.assign(parseSyncTimer(el), { scope }));
          if (sub) visit(sub, scope);
          break;
        case 'ResultCollector':
          out.listeners.push(parseListener(el, scope));
          if (sub) visit(sub, scope);
          break;
        case 'LoopController':
          out.loops.push({ name, loops: prop(el, 'LoopController.loops'), scope });
          if (sub) visit(sub, scope);
          break;
        default:
          if (sub) visit(sub, scope);
          break;
      }
      if (sub) i++;
    }
  };

  const topTree = root.getElementsByTagName('hashTree');
  if (topTree.length) visit(topTree[0], '');
  else visit(root, '');

  // ${...} 占位符（教程第五章：引用方式 ${XXX}）
  const seen = new Set();
  const re = /\$\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.placeholders.push(name);
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * 健康检查（按教程规格）
 * ------------------------------------------------------------------ */

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

/**
 * 检查项都来自教程里明确讲过的规则，不自己发明：
 *  - 第四章：响应断言 + 持续时间断言是常规必备
 *  - 第五章：CSV 路径上传压测机器要改；集合点人数不能大于线程数
 *  - 第八章：HTTP 请求默认值可以复用，采样器留空是正常的
 */
function checkHealth(jmx, opts) {
  const options = opts || {};
  const issues = [];
  const add = (level, code, title, detail) => issues.push({ level, code, title, detail: detail || '' });

  // 1) 断言（教程第四章）
  const hasResp = jmx.responseAssertions.length > 0;
  const hasDur = jmx.durationAssertions.length > 0;
  if (!hasResp && !hasDur) {
    add('warn', 'no-assertion', '没有任何断言', '教程第四章：响应断言 + 持续时间断言是常规必备，否则压测跑完无法判断对错');
  } else if (!hasResp) {
    add('warn', 'no-response-assertion', '没有响应断言', '状态码/响应文本无法校验');
  } else if (!hasDur) {
    add('info', 'no-duration-assertion', '没有持续时间断言', 'RT 上限没有约束（教程第四章）');
  }

  // 2) CSV 文件（教程第五章：上传压测机器要改路径）
  for (const c of jmx.csvs) {
    if (!c.enabled || !c.filename) continue;
    const base = path.basename(c.filename);
    // 绝对路径 = 写死了某台机器的位置，换机器/换人必挂
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(c.filename) || c.filename.startsWith('\\\\') || c.filename.startsWith('/');
    const exists = fs.existsSync(c.filename);
    const sibling = jmx.fullPath ? path.join(path.dirname(jmx.fullPath), base) : '';
    const siblingExists = !!sibling && fs.existsSync(sibling);

    if (!exists) {
      // 不存在时只报一条，别让「绝对路径」和「不存在」刷两遍
      if (siblingExists) {
        add('warn', 'csv-path-stale', `CSV 路径失效但同目录有同名文件：${base}`, `脚本里写的是 ${c.filename}，实际在 ${sibling}`);
      } else {
        add('error', 'csv-missing', `CSV 文件不存在：${base}`, c.filename);
      }
      continue;
    }

    // 文件在，但路径写死了：现在能用，换机器就挂
    if (isAbsolute) {
      add(
        'warn',
        'csv-absolute-path',
        `CSV 用了绝对路径：${base}`,
        `当前机器上能找到（${c.filename}），但换机器/换人必挂。建议改成相对路径（相对 jmx 所在目录）或 \${__P(user.dir)}，让脚本和数据一起搬`
      );
    }
  }

  // 3) 集合点人数不能大于线程数（教程第五章）
  const maxThreads = jmx.threadGroups
    .filter((t) => t.enabled && t.type === 'thread')
    .reduce((max, t) => Math.max(max, Number(t.numThreads) || 0), 0);
  for (const t of jmx.syncTimers) {
    if (!t.enabled) continue;
    const size = Number(t.groupSize) || 0;
    if (maxThreads && size > maxThreads) {
      add('error', 'sync-over-threads', `集合点人数 ${size} 大于线程数 ${maxThreads}`, '教程第五章：设置的值不能大于线程组数量，否则会一直等超时');
    }
  }

  // 4) 采样器 path 为空：默认值有 domain 就是正常复用（教程第八章）
  const defaultDomain = jmx.defaults.map((d) => d.domain).find(Boolean) || '';
  const emptyPath = jmx.samplers.filter((s) => s.enabled && !s.path);
  if (emptyPath.length) {
    if (!defaultDomain) {
      add(
        'error',
        'sampler-no-path',
        `${emptyPath.length} 个启用的采样器没有 path，且默认值里也没配 domain`,
        emptyPath.map((s) => s.name).join('、')
      );
    } else {
      add(
        'info',
        'sampler-inherit',
        `${emptyPath.length} 个采样器 path 为空（继承 HTTP 请求默认值）`,
        `默认值 domain=${defaultDomain}；这些采样器靠默认值补全，属正常用法`
      );
    }
  }

  // 5) 占位符是否都有定义（教程第五章：${XXX} 引用）
  const defined = new Set();
  for (const v of jmx.variables) for (const item of v.vars) defined.add(item.name.trim());
  for (const c of jmx.csvs) {
    for (const n of String(c.variableNames || '').split(',')) if (n.trim()) defined.add(n.trim());
  }
  for (const e of jmx.jsonExtractors) {
    for (const n of String(e.varName || '').split(',')) if (n.trim()) defined.add(n.trim());
  }
  const undefinedVars = jmx.placeholders.filter((p) => !defined.has(p) && !/^__/.test(p));
  if (undefinedVars.length) {
    add('warn', 'undefined-var', `占位符没有定义：${undefinedVars.join('、')}`, '可能是漏配了用户定义变量或 CSV 变量名');
  }

  // 6) 线程组启用情况（信息）
  const enabledGroups = jmx.threadGroups.filter((t) => t.enabled);
  if (jmx.threadGroups.length && !enabledGroups.length) {
    add('error', 'no-enabled-group', '所有线程组都是禁用的', '跑起来不会有任何请求');
  } else if (jmx.threadGroups.length > 1 && enabledGroups.length < jmx.threadGroups.length) {
    add(
      'info',
      'partial-groups',
      `${jmx.threadGroups.length} 个线程组只启用了 ${enabledGroups.length} 个`,
      enabledGroups.map((t) => t.name).join('、')
    );
  }

  // 7) 版本（信息）
  if (options.jmeterVersion && jmx.jmeterVersion && options.jmeterVersion !== jmx.jmeterVersion) {
    add('warn', 'version-mismatch', `脚本是 JMeter ${jmx.jmeterVersion}，本机是 ${options.jmeterVersion}`, '跨版本打开可能丢组件');
  }

  const worst = issues.reduce((w, i) => (SEVERITY_ORDER[i.level] < SEVERITY_ORDER[w] ? i.level : w), 'info');
  return { level: issues.length ? worst : 'ok', issues };
}

/* ------------------------------------------------------------------ *
 * 目录扫描
 * ------------------------------------------------------------------ */

function scanJmx(root, opts) {
  const options = opts || {};
  const out = { root: root || '', files: [], totalFiles: 0, errors: [], jmeterVersion: options.jmeterVersion || '' };
  if (!root) {
    out.error = '未配置 jmx 目录';
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
        walk(full, relPath);
        continue;
      }
      if (!/\.jmx$/i.test(ent.name)) continue;
      try {
        const stat = fs.statSync(full);
        const parsed = parseJmx(fs.readFileSync(full, 'utf8'), full);
        parsed.relPath = relPath;
        parsed.dir = rel || '';
        parsed.mtime = stat.mtimeMs;
        parsed.size = stat.size;
        parsed.health = parsed.parseError
          ? { level: 'error', issues: [{ level: 'error', code: 'parse', title: '解析失败', detail: parsed.parseError }] }
          : checkHealth(parsed, { jmeterVersion: options.jmeterVersion });
        out.files.push(parsed);
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

module.exports = { parseJmx, checkHealth, scanJmx, listenerKind, LISTENER_KIND };
