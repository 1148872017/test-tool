'use strict';
/**
 * JMeter .jmx 脚本生成器。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **纯 XML 模板，不用 JMeter Java API**
 *    Node 里没有 Java API，而且 XML 模板更简单可控。
 *    生成的是标准 jmx，JMeter GUI 能直接打开。
 *
 * 2. **生成的结构必须能被自己的解析器解析**
 *    electron/jmx.js 的 parseJmx 是校验标准。
 *    结构：元素 + 紧跟一个 hashTree，hashTree 里是子元素。
 *
 * 3. **支持多接口组合**
 *    一个线程组下挂多个采样器（按顺序执行）。
 *
 * 4. **域名/端口用 JMeter 属性占位**
 *    `${__P(host,127.0.0.1)}` 可以在命令行用 -Jhost=xxx 覆盖，
 *    这样同一份 jmx 能跑不同环境。
 */

/** XML 转义 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 缩进 */
function pad(n) {
  return ' '.repeat(n * 2);
}

/**
 * 解析 URL，拆成 domain / port / path / protocol。
 * @param {string} raw
 */
function splitUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return { protocol: 'http', domain: '', port: '', path: '/', query: '' };

  // 没有协议时补 http://
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;

  try {
    const u = new URL(s);
    const protocol = u.protocol.replace(':', '') || 'http';
    const domain = u.hostname || '';
    const port = u.port || (protocol === 'https' ? '443' : '80');
    const path = u.pathname || '/';
    const query = u.search ? u.search.slice(1) : '';
    return { protocol, domain, port, path, query };
  } catch (e) {
    // URL 不合法，退回手工拆
    const m = /^(?:([a-z]+):\/\/)?([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?/i.exec(s);
    return {
      protocol: (m && m[1]) || 'http',
      domain: (m && m[2]) || '',
      port: '',
      path: (m && m[3]) || '/',
      query: (m && m[4]) || ''
    };
  }
}

/**
 * 解析接口记录的 body，转成 JMeter 参数对。
 * @param {object} api
 */
function bodyParams(api) {
  const bodyType = String(api.bodyType || 'none');
  const body = String(api.body || '');
  const out = [];

  if (bodyType === 'x-www-form-urlencoded' || bodyType === 'form-data') {
    for (const seg of body.split('&')) {
      const s = seg.trim();
      if (!s) continue;
      const i = s.indexOf('=');
      if (i <= 0) continue;
      out.push({
        name: decodeURIComponent(s.slice(0, i)),
        value: decodeURIComponent(s.slice(i + 1)),
        // form-data 有文件字段时用 FILE 类型
        useEquals: true
      });
    }
    return out;
  }

  if (bodyType === 'json' && body) {
    // JSON body 整段作为一个参数（JMeter 里叫 body_data）
    out.push({ name: '', value: body, useEquals: false, isBody: true });
    return out;
  }

  // 其他类型：原样作为 body
  if (body) out.push({ name: '', value: body, useEquals: false, isBody: true });
  return out;
}

/**
 * 解析 headers 文本成键值对。
 * @param {string} text
 */
function headerPairs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    out.push({ name: t.slice(0, i).trim(), value: t.slice(i + 1).trim() });
  }
  return out;
}

/**
 * 生成 HTTP 采样器的 XML。
 *
 * @param {object} api 接口记录 data
 * @param {number} depth 缩进层级
 * @returns {string}
 */
function sampleXml(api, depth, rtLimit) {
  const p = pad(depth);
  const parts = splitUrl(api.url);
  const method = String(api.method || 'GET').toUpperCase();
  const name = String(api.name || `${method} ${parts.path}`);
  const headers = headerPairs(api.headers);
  const bps = bodyParams(api);

  const L = [];
  L.push(`${p}<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${esc(name)}" enabled="true">`);

  // ---- 基本配置 ----
  L.push(`${p}  <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">`);
  L.push(`${p}    <collectionProp name="Arguments.arguments">`);
  for (const bp of bps) {
    L.push(`${p}      <elementProp name="${esc(bp.name)}" elementType="HTTPArgument">`);
    L.push(`${p}        <boolProp name="HTTPArgument.always_encode">false</boolProp>`);
    L.push(`${p}        <stringProp name="Argument.value">${esc(bp.value)}</stringProp>`);
    L.push(`${p}        <stringProp name="Argument.metadata">=</stringProp>`);
    L.push(`${p}        <boolProp name="HTTPArgument.use_equals">${bp.useEquals ? 'true' : 'false'}</boolProp>`);
    if (bp.name) L.push(`${p}        <stringProp name="Argument.name">${esc(bp.name)}</stringProp>`);
    L.push(`${p}      </elementProp>`);
  }
  L.push(`${p}    </collectionProp>`);
  L.push(`${p}  </elementProp>`);

  // ---- 域名/端口用属性占位（可命令行覆盖）----
  L.push(`${p}  <stringProp name="HTTPSampler.domain">\${__P(host,${esc(parts.domain || '127.0.0.1')})}</stringProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.port">\${__P(port,${esc(parts.port || '8080')})}</stringProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.protocol">${esc(parts.protocol)}</stringProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.path">${esc(parts.path)}</stringProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.method">${esc(method)}</stringProp>`);
  L.push(`${p}  <boolProp name="HTTPSampler.follow_redirects">true</boolProp>`);
  L.push(`${p}  <boolProp name="HTTPSampler.auto_redirects">false</boolProp>`);
  L.push(`${p}  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>`);
  L.push(`${p}  <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.embedded_url_re"></stringProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.connect_timeout"></stringProp>`);
  L.push(`${p}  <stringProp name="HTTPSampler.response_timeout"></stringProp>`);
  L.push(`${p}</HTTPSamplerProxy>`);

  // ---- 子元素：HeaderManager + 断言 ----
  L.push(`${p}<hashTree>`);

  if (headers.length) {
    L.push(`${p}  <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP 信息头管理器" enabled="true">`);
    L.push(`${p}    <collectionProp name="HeaderManager.headers">`);
    for (const h of headers) {
      L.push(`${p}      <elementProp name="" elementType="Header">`);
      L.push(`${p}        <stringProp name="Header.name">${esc(h.name)}</stringProp>`);
      L.push(`${p}        <stringProp name="Header.value">${esc(h.value)}</stringProp>`);
      L.push(`${p}      </elementProp>`);
    }
    L.push(`${p}    </collectionProp>`);
    L.push(`${p}  </HeaderManager>`);
    L.push(`${p}  <hashTree/>`);
  }

  // 响应断言：状态码 200
  L.push(`${p}  <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="响应断言-状态码200" enabled="true">`);
  L.push(`${p}    <collectionProp name="Asserion.test_strings">`);
  L.push(`${p}      <stringProp name="49586">200</stringProp>`);
  L.push(`${p}    </collectionProp>`);
  L.push(`${p}    <stringProp name="Assertion.custom_message"></stringProp>`);
  L.push(`${p}    <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>`);
  L.push(`${p}    <boolProp name="Assertion.assume_success">false</boolProp>`);
  L.push(`${p}    <intProp name="Assertion.test_type">8</intProp>`);
  L.push(`${p}  </ResponseAssertion>`);
  L.push(`${p}  <hashTree/>`);

  // 持续时间断言（RT 上限）：压测必备，否则跑完不知道性能是否达标
  if (rtLimit > 0) {
    L.push(`${p}  <DurationAssertion guiclass="DurationAssertionGui" testclass="DurationAssertion" testname="持续时间断言-${rtLimit}ms" enabled="true">`);
    L.push(`${p}    <stringProp name="DurationAssertion.duration">${rtLimit}</stringProp>`);
    L.push(`${p}  </DurationAssertion>`);
    L.push(`${p}  <hashTree/>`);
  }

  L.push(`${p}</hashTree>`);

  return L.join('\n');
}

/**
 * 生成完整的 jmx。
 *
 * @param {object} opts
 *   - apis        接口记录数组 [{data: {method,url,headers,body,bodyType,name}}]
 *   - name        测试计划名
 *   - threads     线程数
 *   - rampUp      Ramp-Up（秒）
 *   - loops        循环次数
 *   - duration    持续时长（秒，0 = 不用调度器）
 *   - domain      默认域名（空 = 从第一个接口的 URL 取）
 *   - port        默认端口
 *   - onError     出错时（continue / startnextloop / stopthread）
 *   - rtLimit     RT 上限（毫秒，0 = 不生成持续时间断言）
 * @returns {{ok: boolean, xml?: string, filename?: string, message?: string}}
 */
function generateJmx(opts = {}) {
  const apis = Array.isArray(opts.apis) ? opts.apis : [];
  if (!apis.length) return { ok: false, message: '没有接口（至少选一个）' };

  const planName = String(opts.name || '测试计划').trim() || '测试计划';
  const threads = Math.max(1, Number(opts.threads) || 10);
  const rampUp = Math.max(0, Number(opts.rampUp) || 2);
  const loops = Math.max(1, Number(opts.loops) || 5);
  const duration = Math.max(0, Number(opts.duration) || 0);
  const useDuration = duration > 0;
  const onError = String(opts.onError || 'continue');
  // RT 上限（毫秒）：0 = 不生成持续时间断言
  const rtLimit = Math.max(0, Number(opts.rtLimit) || 0);

  // 默认域名/端口：从第一个接口取
  const first = splitUrl(apis[0].data ? apis[0].data.url : apis[0].url);
  const defaultDomain = String(opts.domain || first.domain || '127.0.0.1');
  const defaultPort = String(opts.port || first.port || '8080');

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">');
  L.push(`${pad(1)}<hashTree>`);
  L.push(`${pad(2)}<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${esc(planName)}" enabled="true">`);
  L.push(`${pad(3)}<stringProp name="TestPlan.comments"></stringProp>`);
  L.push(`${pad(3)}<boolProp name="TestPlan.functional_mode">false</boolProp>`);
  L.push(`${pad(3)}<boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>`);
  L.push(`${pad(3)}<boolProp name="TestPlan.serialize_threadgroups">false</boolProp>`);
  L.push(`${pad(3)}<elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">`);
  L.push(`${pad(4)}<collectionProp name="Arguments.arguments">`);
  // 预置 host / port 变量（方便命令行覆盖）
  L.push(`${pad(5)}<elementProp name="host" elementType="Argument">`);
  L.push(`${pad(6)}<stringProp name="Argument.name">host</stringProp>`);
  L.push(`${pad(6)}<stringProp name="Argument.value">${esc(defaultDomain)}</stringProp>`);
  L.push(`${pad(6)}<stringProp name="Argument.metadata">=</stringProp>`);
  L.push(`${pad(5)}</elementProp>`);
  L.push(`${pad(5)}<elementProp name="port" elementType="Argument">`);
  L.push(`${pad(6)}<stringProp name="Argument.name">port</stringProp>`);
  L.push(`${pad(6)}<stringProp name="Argument.value">${esc(defaultPort)}</stringProp>`);
  L.push(`${pad(6)}<stringProp name="Argument.metadata">=</stringProp>`);
  L.push(`${pad(5)}</elementProp>`);
  L.push(`${pad(4)}</collectionProp>`);
  L.push(`${pad(3)}</elementProp>`);
  L.push(`${pad(3)}<stringProp name="TestPlan.user_define_classpath"></stringProp>`);
  L.push(`${pad(2)}</TestPlan>`);

  // ---- 线程组 ----
  L.push(`${pad(2)}<hashTree>`);
  L.push(`${pad(3)}<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="线程组-${esc(planName)}" enabled="true">`);
  L.push(`${pad(4)}<stringProp name="ThreadGroup.on_sample_error">${esc(onError)}</stringProp>`);
  L.push(`${pad(4)}<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">`);
  L.push(`${pad(5)}<boolProp name="LoopController.continue_forever">${useDuration ? 'true' : 'false'}</boolProp>`);
  L.push(`${pad(5)}<stringProp name="LoopController.loops">${useDuration ? '-1' : String(loops)}</stringProp>`);
  L.push(`${pad(4)}</elementProp>`);
  L.push(`${pad(4)}<stringProp name="ThreadGroup.num_threads">${threads}</stringProp>`);
  L.push(`${pad(4)}<stringProp name="ThreadGroup.ramp_time">${rampUp}</stringProp>`);
  L.push(`${pad(4)}<boolProp name="ThreadGroup.scheduler">${useDuration ? 'true' : 'false'}</boolProp>`);
  L.push(`${pad(4)}<stringProp name="ThreadGroup.duration">${useDuration ? String(duration) : ''}</stringProp>`);
  L.push(`${pad(4)}<stringProp name="ThreadGroup.delay"></stringProp>`);
  L.push(`${pad(3)}</ThreadGroup>`);

  // ---- 采样器 ----
  L.push(`${pad(3)}<hashTree>`);
  for (const api of apis) {
    const d = api.data ? api.data : api;
    L.push(sampleXml(d, 4, rtLimit));
  }
  L.push(`${pad(3)}</hashTree>`);

  L.push(`${pad(2)}</hashTree>`);
  L.push(`${pad(1)}</hashTree>`);
  L.push('</jmeterTestPlan>');

  // 文件名：去掉不合法字符
  const safeName = planName.replace(/[\\/:*?"<>|]/g, '_');
  return { ok: true, xml: L.join('\n'), filename: `${safeName}.jmx` };
}

module.exports = { generateJmx, splitUrl, headerPairs, bodyParams };