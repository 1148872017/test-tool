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
/**
 * L2 局部编辑：详情要返回 `editable`（可改字段 + 乐观锁 stamp）。
 * 这里只 require 它的**只读**入口 buildEditable；本文件仍然一个写盘调用都没有，
 * 真正写用户文件的只有 jmx-writeback.js 的 writeback（闸 1）。
 */
const jmxWriteback = require('./jmx-writeback');

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

/**
 * 所有 Prop 摊平成对象（stringProp / boolProp / intProp / longProp）。
 *
 * 为什么不能只读 stringProp：
 *   JMeter 的 jmx 里不同类型用不同标签，比如
 *     ThreadGroup.scheduler → boolProp
 *     Assertion.test_type  → intProp
 *   只读 stringProp 会漏掉这些。
 */
function props(el) {
  const out = {};
  for (const tag of ['stringProp', 'boolProp', 'intProp', 'longProp']) {
    for (const n of byTag(el, tag)) out[n.getAttribute('name')] = textOf(n);
  }
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
    followRedirects: p['HTTPSampler.follow_redirects'] === 'true',
    /**
     * 挂在这个采样器下面的元件桶（parseJmx 递归时填充）。
     * 详情页要能按采样器回答「我加的断言真的进了这个请求吗」，
     * 而不是把所有断言平铺在文件级 —— 那是 4 个采样器共享 3 条断言时分不清。
     */
    assertions: [],
    preProcessors: [],
    postProcessors: [],
    timers: []
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
 * 元件分类（v0.45.0：JSR223 等通用识别）
 * ------------------------------------------------------------------ */

/**
 * 配置类元件（testclass）：这些不算断言/前后置，但详情页要单独列。
 * 只收 JMeter 自带、教程里出现过的；不认识的元件一律忽略，不会误报。
 */
const CONFIG_TYPES = new Set([
  'ConfigTestElement', // HTTP 请求默认值
  'HeaderManager', // HTTP 信息头管理器
  'Arguments', // 用户定义的变量
  'CSVDataSet', // CSV Data Set Config
  'CookieManager', // HTTP Cookie 管理器
  'CacheManager', // HTTP 缓存管理器
  'JDBCConnectionConfiguration', // JDBC 连接配置
  'RandomVariableConfig', // 随机变量
  'CounterConfig', // 计数器
  'KeystoreConfig', // 证书
  'LDAPArguments', // LDAP 请求默认值
  'LoginConfig', // 登录配置
  'RegExUserParameters', // 正则提取的 URL 参数
  'SampleTimeout' // 超时配置
]);

/**
 * 按 testclass 后缀判断元件属于哪一类。
 *
 * 为什么按后缀而不是写死一张大表（踩过的坑）：
 *   用户会从 JMeter GUI 里拖各种元件进来（JSR223Assertion / JSONPathAssertion /
 *   XPath2Assertion / BeanShellTimer …）。写死表的话，新元件在详情里就看不见，
 *   而这正是 L1「看得见 jmx 里有什么」要解决的问题。
 *   JMeter 的类名命名很稳定：断言都以 Assertion 结尾，前后置分别是
 *   PreProcessor / PostProcessor，定时器以 Timer 结尾 —— 按这条规律认得全。
 *
 * @param {string} tc testclass 属性
 * @returns {'' | 'assertion' | 'preProcessor' | 'postProcessor' | 'timer' | 'sampler' | 'config'}
 */
function componentKind(tc) {
  const t = String(tc || '');
  if (!t) return '';
  if (/Assertion$/.test(t)) return 'assertion';
  if (/PreProcessor$/.test(t)) return 'preProcessor';
  if (/PostProcessor$/.test(t)) return 'postProcessor';
  // SyncTimer 也以 Timer 结尾，正好一起收
  if (/Timer$/.test(t)) return 'timer';
  // HTTPSamplerProxy 不以 Sampler 结尾，单独点名
  if (/Sampler$/.test(t) || t === 'HTTPSamplerProxy') return 'sampler';
  if (CONFIG_TYPES.has(t)) return 'config';
  return '';
}

/**
 * JSR223 元件（断言 / 前置 / 后置 / 定时器 / 采样器）的脚本信息。
 * JSR223 系列的属性名是通用的（script / scriptLanguage），不像 BeanShell 带前缀。
 */
function parseJsr223(el) {
  const p = props(el);
  return {
    name: el.getAttribute('testname') || '',
    type: el.getAttribute('testclass') || el.tagName,
    enabled: el.getAttribute('enabled') !== 'false',
    language: p.scriptLanguage || '',
    script: p.script || ''
  };
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
    /** 所有断言 / 前后置 / 定时器 / 配置元件的统一清单（v0.45.0） */
    components: [],
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
  const visit = (hashTree, scope, owner) => {
    const kids = children(hashTree);
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (el.tagName === 'hashTree') continue;
      const tc = el.getAttribute('testclass') || '';
      const tag = el.tagName;
      const name = el.getAttribute('testname') || '';
      const kind = componentKind(tc);

      // 下一个兄弟是 hashTree → 它是 el 的子树
      const sub = i + 1 < kids.length && kids[i + 1].tagName === 'hashTree' ? kids[i + 1] : null;

      /**
       * 通用元件登记：断言 / 前后置 / 定时器 / 配置。
       *
       * 这一层是 v0.45.0 的「L1 只读详情」新增的：
       *   原解析器只认写死在 switch 里的那几个元件，v0.44.0 新加进 jmx 的
       *   JSR223Assertion / JSR223PreProcessor / JSR223PostProcessor 全被 default 丢掉，
       *   用户没办法在界面上验证「我加的断言到底进没进脚本」。
       *   现在按 testclass 后缀认（见 componentKind），并在 owner 存在时直接挂到
       *   当前采样器对象上 —— 详情页按采样器展示，不是全局平铺。
       */
      if (kind && kind !== 'sampler') {
        const item = { name, type: tc || tag, kind, enabled: el.getAttribute('enabled') !== 'false', scope };
        // JSR223 三类额外带脚本语言 + 代码首行预览（详情里能认出「这段是不是我加的」）
        if (tc.indexOf('JSR223') === 0) {
          const js = parseJsr223(el);
          item.language = js.language;
          item.scriptPreview = String(js.script || '').split('\n')[0].slice(0, 120);
        }
        out.components.push(item);
        if (owner) {
          if (kind === 'assertion') owner.assertions.push(item);
          else if (kind === 'preProcessor') owner.preProcessors.push(item);
          else if (kind === 'postProcessor') owner.postProcessors.push(item);
          else if (kind === 'timer') owner.timers.push(item);
        }
      }

      if (tag === 'TestPlan') {
        out.testPlanName = name;
        if (sub) visit(sub, name, null);
        if (sub) i++;
        continue;
      }
      if (THREAD_GROUP_TYPES[tag]) {
        out.threadGroups.push(parseThreadGroup(el));
        // 线程组下还有循环控制器、采样器等，必须继续往下走
        if (sub) visit(sub, name, null);
        if (sub) i++;
        continue;
      }

      switch (tc) {
        case 'HTTPSamplerProxy':
          out.samplers.push(parseHttpSampler(el));
          // 采样器对象传下去：子孙里的断言/前后置/定时器直接进它自己的桶
          if (sub) visit(sub, name, out.samplers[out.samplers.length - 1]);
          break;
        case 'ConfigTestElement':
          out.defaults.push(parseDefaults(el));
          if (sub) visit(sub, scope, owner);
          break;
        case 'HeaderManager':
          out.headers.push(parseHeaderManager(el));
          if (sub) visit(sub, scope, owner);
          break;
        case 'Arguments':
          out.variables.push(parseArguments(el));
          if (sub) visit(sub, scope, owner);
          break;
        case 'CSVDataSet':
          out.csvs.push(Object.assign(parseCsv(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'ResponseAssertion':
          out.responseAssertions.push(Object.assign(parseResponseAssertion(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'DurationAssertion':
          out.durationAssertions.push(Object.assign(parseDurationAssertion(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'BeanShellPreProcessor':
          out.beanShell.pre.push(Object.assign(parseBeanShell(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'BeanShellPostProcessor':
          out.beanShell.post.push(Object.assign(parseBeanShell(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'BeanShellAssertion':
          out.beanShell.assert.push(Object.assign(parseBeanShell(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'JSONPostProcessor':
          out.jsonExtractors.push(Object.assign(parseJsonExtractor(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'SyncTimer':
          out.syncTimers.push(Object.assign(parseSyncTimer(el), { scope }));
          if (sub) visit(sub, scope, owner);
          break;
        case 'ResultCollector':
          out.listeners.push(parseListener(el, scope));
          if (sub) visit(sub, scope, owner);
          break;
        case 'LoopController':
          out.loops.push({ name, loops: prop(el, 'LoopController.loops'), scope });
          if (sub) visit(sub, scope, owner);
          break;
        default:
          if (sub) visit(sub, scope, owner);
          break;
      }
      if (sub) i++;
    }
  };

  const topTree = root.getElementsByTagName('hashTree');
  if (topTree.length) visit(topTree[0], '', null);
  else visit(root, '', null);

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
  // v0.45.0：JSR223 断言也算「响应断言」。之前只认 ResponseAssertion，
  // 于是「脚本生成时附加了 JSR223 断言」的脚本会被误报「没有任何断言」。
  // 注意只认 JSR223Assertion：BeanShell 断言的既有判定保持不变（有回归测试守着）。
  const components = Array.isArray(jmx.components) ? jmx.components : [];
  const hasJsr223Assertion = components.some((c) => c.kind === 'assertion' && c.type === 'JSR223Assertion');
  const hasResp = jmx.responseAssertions.length > 0 || hasJsr223Assertion;
  const hasDur = jmx.durationAssertions.length > 0;
  const hasAny = hasResp || hasDur;
  if (!hasAny) {
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
 * 只读详情（v0.45.0 L1）
 * ------------------------------------------------------------------ */

/** jmx 正常只有几十 KB；超过 5MB 一定是选错文件了（比如 jtl / 日志） */
const MAX_DETAIL_BYTES = 5 * 1024 * 1024;

/** 字符串 → 数字（空 / 非数字 → null，别把 '' 变成 0 骗人） */
function toNum(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把 parseJmx 的结果整理成「详情页」结构。
 *
 * 为什么不直接把 parseJmx 的原始结构回给界面：
 *   原始结构是给健康检查/index 用的，字段偏工程化（数字是字符串、
 *   断言/前后置平铺在文件级）。详情页关心的是「这个采样器上挂了什么」，
 *   所以这里做一层收敛：数字转 number、断言按采样器归位、给出 summary。
 *
 * @param {object} parsed parseJmx 的返回值
 * @param {{size?: number, mtimeMs?: number}} stat 文件信息
 */
function buildDetail(parsed, stat) {
  const st = stat || {};
  const components = Array.isArray(parsed.components) ? parsed.components : [];
  const assertionComponents = components.filter((c) => c.kind === 'assertion');

  // 配置元件（CSV / 信息头 / 请求默认值 / 用户变量…）
  const configs = components
    .filter((c) => c.kind === 'config')
    .map((c) => ({ name: c.name, type: c.type, enabled: c.enabled, scope: c.scope }));

  /**
   * ${xxx} 变量：从所有文本节点里抽出来的（parseJmx 已去重）。
   * 过滤 ${__P(...)} / ${__time(...)} 这类 JMeter 函数 —— 它们是函数调用，不是变量；
   * 留在「变量」里会让用户以为脚本少定义了东西。
   */
  const variables = [];
  const seen = new Set();
  for (const raw of parsed.placeholders || []) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name || name.indexOf('__') === 0 || seen.has(name)) continue;
    seen.add(name);
    variables.push(name);
  }

  const threadGroups = (parsed.threadGroups || []).map((t) => ({
    name: t.name,
    type: t.type,
    enabled: t.enabled,
    numThreads: toNum(t.numThreads),
    rampUp: toNum(t.rampUp),
    loops: toNum(t.loops),
    // duration 空串 = 没用调度器，按 0 展示（0 秒不代表跑 0 秒，而是「不限时」）
    duration: toNum(t.duration) || 0,
    scheduler: !!t.scheduler
  }));

  const samplers = (parsed.samplers || []).map((s) => ({
    name: s.name,
    method: s.method,
    path: s.path,
    domain: s.domain,
    enabled: s.enabled,
    assertions: s.assertions || [],
    preProcessors: s.preProcessors || [],
    postProcessors: s.postProcessors || [],
    timers: s.timers || []
  }));

  return {
    file: path.basename(parsed.fullPath || ''),
    fullPath: parsed.fullPath || '',
    size: Number(st.size) || 0,
    modifiedAt: Number(st.mtimeMs) || 0,
    jmeterVersion: parsed.jmeterVersion || '',
    testPlan: { name: parsed.testPlanName || '' },
    threadGroups,
    samplers,
    configs,
    variables,
    assertionCount: assertionComponents.length,
    summary: {
      threadGroups: threadGroups.length,
      samplers: samplers.length,
      assertions: assertionComponents.length,
      configs: configs.length
    }
  };
}

/**
 * 读取并解析一个 jmx 的详情（只读，绝不写文件）。
 *
 * 错误一律返回 { ok:false, code, message }，不抛异常：
 *   Electron 的 handler 抛错会被包成 "Error invoking remote method"，
 *   界面拿不到能直接展示的中文原因。
 *
 * @param {string} filePath 绝对路径（调用方负责路径白名单校验）
 * @param {{maxBytes?: number}} [opts]
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
function readDetail(filePath, opts) {
  const options = opts || {};
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_DETAIL_BYTES;
  const target = String(filePath == null ? '' : filePath).trim();
  if (!target) return { ok: false, code: 'BAD_PATH', message: '缺少文件路径' };

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (e) {
    return { ok: false, code: 'NOT_FOUND', message: '文件不存在或无法访问：' + target };
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'NOT_A_FILE', message: '不是文件：' + target };
  }
  if (stat.size > maxBytes) {
    const mb = (stat.size / 1024 / 1024).toFixed(1);
    const limit = (maxBytes / 1024 / 1024).toFixed(0);
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `文件 ${mb} MB，超过 ${limit} MB 上限，已拒绝解析（jmx 正常只有几十 KB，别选成 jtl / 日志）`
    };
  }

  let raw = '';
  let rawBuf = null;
  try {
    // 同时留一份 Buffer：editable 要按**字节偏移**定位值，不能被 utf8 解码/再编码影响
    rawBuf = fs.readFileSync(target);
    raw = rawBuf.toString('utf8');
  } catch (e) {
    return { ok: false, code: 'READ_FAILED', message: '读取失败：' + String((e && e.message) || e) };
  }

  const parsed = parseJmx(raw, target);
  if (parsed.parseError) {
    return { ok: false, code: 'BAD_JMX', message: '不是合法的 jmx 文件：' + parsed.parseError };
  }
  const detail = Object.assign({ ok: true }, buildDetail(parsed, stat));
  /**
   * L2（v0.51.0）：把「可编辑字段」一起返回。
   *
   * 只返回白名单内的字段与值，**不返回字节位置** —— span 只在 writeback 内部按
   * 原文重新计算（文件在两次请求之间被 JMeter 另存过，旧的偏移就是错的）。
   * stamp = `<mtimeMs>:<size>`，写回时用它做乐观锁。
   */
  detail.editable = jmxWriteback.buildEditable(rawBuf, stat);
  return detail;
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

module.exports = {
  parseJmx,
  checkHealth,
  scanJmx,
  buildDetail,
  readDetail,
  componentKind,
  parseJsr223,
  MAX_DETAIL_BYTES,
  listenerKind,
  LISTENER_KIND
};
