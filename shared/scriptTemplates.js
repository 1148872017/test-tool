'use strict';

/**
 * JMeter 脚本模板库（只读，纯数据）
 *
 * 定位：不是生成器，是带注释的起点。
 * 用户「能看懂示例、在示例上改」，所以每个模板都是完整可跑的代码 + 逐行注释，
 * 而不是「填参数出代码」的黑盒。
 *
 * 语言默认 Groovy（JMeter 官方推荐，BeanShell 已停止维护且性能差）。
 * 每个模板都标了「这件事要不要写代码」——很多需求用内置组件就够了。
 */

/** 先给一张「不用写代码」的对照表：这是模板库最重要的一条 */
const NO_CODE_NEEDED = [
  {
    need: '从响应里提取一个字段（token、id、订单号）',
    use: 'JSON 提取器（JSON Extractor）',
    how: '右键采样器 → 添加 → 后置处理器 → JSON 提取器；Names 填变量名，JSON Path 填 $.data.token',
    note: '不用写任何代码。只有 JSON 结构特别怪（数组套数组、需要条件判断）才用脚本'
  },
  {
    need: '校验 HTTP 状态码是 200',
    use: '响应断言（Response Assertion）',
    how: '右键采样器 → 添加 → 断言 → 响应断言；测试字段选「响应代码」，模式填 200',
    note: '你 demo 里的「响应断言-状态码200」就是这个'
  },
  {
    need: '校验响应体包含某段文字',
    use: '响应断言',
    how: '测试字段选「响应文本」，匹配规则选「包含」，模式填 "code":0',
    note: '你 demo 里的「响应断言-业务码」就是这个'
  },
  {
    need: '校验响应时间不超过 500ms',
    use: '持续时间断言（Duration Assertion）',
    how: '右键采样器 → 添加 → 断言 → 持续时间断言；毫秒填 500',
    note: '你 demo 里的「持续时间断言-500ms」就是这个'
  },
  {
    need: '从 CSV 读参数',
    use: 'CSV Data Set Config',
    how: '右键线程组 → 添加 → 配置元件 → CSV 数据文件设置；文件名、变量名、分隔符',
    note: '路径建议用相对路径或 ${__P(csvFile,默认值)}，别写死绝对路径'
  },
  {
    need: '让并发真正同时发起（集合点）',
    use: '同步定时器（Synchronizing Timer）',
    how: '右键采样器 → 添加 → 定时器 → 同步定时器；模拟用户数填线程数',
    note: '人数不能大于线程数，否则一直等超时'
  },
  {
    need: '设置请求头（token、Content-Type）',
    use: 'HTTP 信息头管理器',
    how: '右键线程组 → 添加 → 配置元件 → HTTP 信息头管理器',
    note: '值里可以直接写 ${token} 引用变量'
  },
  {
    need: '多环境切换（测试/预发/生产）',
    use: '用户定义的变量 + ${__P()}',
    how: '用户定义的变量里写 host = ${__P(host,127.0.0.1)}，命令行 -Jhost=xxx 覆盖',
    note: '比每次改 jmx 文件安全'
  },
  {
    need: '每个线程用不同的账号/参数',
    use: 'CSV Data Set Config',
    how: '文件名填 csv 路径，变量名填列名（如 account,pwd），共享模式选「所有线程」',
    note: '比脚本读文件简单得多；注意「循环读取」要勾上，否则线程数超过行数会取空'
  },
  {
    need: '请求之间等待一会儿（模拟思考时间）',
    use: '固定定时器（Constant Timer）',
    how: '右键采样器 → 添加 → 定时器 → 固定定时器；毫秒填 1000',
    note: '压测时加定时器会降低 TPS，这是预期的——它模拟真实用户行为'
  },
  {
    need: '只跑一部分请求（调试时）',
    use: '禁用节点 / 线程组',
    how: '右键节点 → 禁用（Disable）；或在线程组上右键禁用整个线程组',
    note: '禁用的节点在 jmx 里 enabled="false"，平台健康检查会标出来'
  },
  {
    need: '失败后重试',
    use: '不用做',
    how: '压测场景下重试会污染数据（比如重复下单）。失败就让它失败，看错误率',
    note: '功能测试才需要重试；压测要的是「真实失败率」'
  },
  {
    need: '查看某个请求的响应内容',
    use: '察看结果树（View Results Tree）',
    how: '右键线程组 → 添加 → 监听器 → 察看结果树',
    note: '压测时一定要禁用！它会把每个响应存内存，几千请求就 OOM'
  },
  {
    need: '统计 TPS / 响应时间分布',
    use: '聚合报告（Aggregate Report）',
    how: '右键线程组 → 添加 → 监听器 → 聚合报告',
    note: '压测时也建议禁用，改用命令行 -l result.jtl 记录，跑完再分析'
  },
  {
    need: '生成 HTML 可视化报告',
    use: '命令行 -e -o',
    how: 'jmeter -n -t x.jmx -l result.jtl -e -o report/',
    note: '输出目录必须为空，否则报错。这就是「压测结果」目录里 html-report 的来源'
  },
  {
    need: '参数化文件路径不写死',
    use: '${__P(变量名,默认值)}',
    how: 'CSV 文件名填 ${__P(csvFile,user.csv)}，命令行 -JcsvFile=D:/data/user.csv',
    note: '换机器只改命令行参数，jmx 文件不用动'
  },
  {
    need: '断言响应是合法 JSON',
    use: 'JSON 断言（JSON Assertion）',
    how: '右键采样器 → 添加 → 断言 → JSON 断言；勾选「Additionally assert value」可校验字段',
    note: '比写脚本简单，而且失败信息更清楚'
  },
  {
    need: '断言响应符合 JSON Schema',
    use: 'JSON Schema 断言',
    how: '右键采样器 → 添加 → 断言 → JSON Schema 断言；填 schema 文件路径',
    note: '契约测试用；需要额外装 json-schema-validator jar'
  },
  {
    need: '提取 HTML 里的内容（正则）',
    use: '正则表达式提取器',
    how: '右键采样器 → 添加 → 后置处理器 → 正则表达式提取器',
    note: '能用 JSON 提取器就别用正则，正则难维护'
  },
  {
    need: '跨线程组共享变量',
    use: '${__setProperty()} / ${__P()}',
    how: '前一个线程组用 ${__setProperty(token,${token},)} 写属性，后一个用 ${__P(token)} 读',
    note: 'vars 是线程级、props 是全局——这是 JMeter 最容易搞混的地方'
  },
  {
    need: '按比例分配流量（80% 查、20% 下单）',
    use: '吞吐量控制器（Throughput Controller）',
    how: '右键线程组 → 添加 → 逻辑控制器 → 吞吐量控制器；选「百分比」填 80',
    note: '比写脚本判断随机数简单'
  },
  {
    need: '只在第一次迭代执行（如登录）',
    use: '仅一次控制器（Once Only Controller）',
    how: '右键线程组 → 添加 → 逻辑控制器 → 仅一次控制器；把登录请求放进去',
    note: '压测常见模式：登录一次，然后循环压业务接口'
  },
];

/**
 * 模板分类：左侧列表按这个分组，每组一个颜色。
 * order 决定显示顺序（提取 → 断言 → 生成 → 加密 → 流程）。
 */
const TEMPLATE_CATEGORIES = [
  { key: 'extract', name: '提取', color: 'green', order: 1 },
  { key: 'assert', name: '断言', color: 'gold', order: 2 },
  { key: 'generate', name: '生成', color: 'blue', order: 3 },
  { key: 'crypto', name: '加密', color: 'purple', order: 4 },
  { key: 'flow', name: '流程', color: 'cyan', order: 5 },
  { key: 'api-assert', name: '接口断言', color: 'geekblue', order: 6 },
  { key: 'ui-assert', name: 'UI 断言', color: 'magenta', order: 7 }
];

const CATEGORY_MAP = TEMPLATE_CATEGORIES.reduce((acc, c) => {
  acc[c.key] = c;
  return acc;
}, {});

/**
 * 模板列表。
 * 每个模板：
 *   id / category / name / when（什么时候用）/ where（JMeter 里怎么加）
 *   code（Groovy 代码，带注释）
 *   gotcha（坑）
 */
const TEMPLATES = [
  {
    id: 'assert-code',
    category: 'assert',
    name: '断言：HTTP 状态码',
    when: '想确认接口返回 200。其实用响应断言就行，不用写代码——这个模板是给你看「脚本版长什么样」的',
    where: '右键采样器 → 添加 → 断言 → JSR223 断言；语言选 Groovy',
  vars: [{"name":"expectedCode","value":"200","desc":"期望的 HTTP 状态码"}],
    code: `// 断言 HTTP 状态码是 200
// prev 是 JMeter 内置对象，代表「上一个采样器的结果」
String code = prev.getResponseCode();

// 期望的状态码（复制时填）
String expected = "{{expectedCode}}";

if (!expected.equals(code)) {
    // 断言失败：标记失败 + 写清原因（报告里能看到）
    AssertionResult.setFailure(true);
    AssertionResult.setFailureMessage("状态码不是 " + expected + "，实际是：" + code);
} else {
    AssertionResult.setFailure(false);
}`,
    gotcha: '状态码是字符串不是数字，用 "200".equals(code) 而不是 code == 200'
  },
  {
    id: 'assert-body-contains',
    category: 'assert',
    name: '断言：响应体包含关键字',
    when: '想确认返回内容里有 "code":0 或某个业务标识。响应断言能覆盖大部分场景',
    where: '右键采样器 → 添加 → 断言 → JSR223 断言；语言选 Groovy',
  vars: [{"name":"keyword","value":"\\\"code\\\":0","desc":"响应体里要查找的文字（注意 JSON 里的引号要转义）"}],
    code: `// 断言响应体包含指定文字
String body = prev.getResponseDataAsString();

// 要查找的内容（复制时填）
String keyword = "{{keyword}}";

if (body == null || !body.contains(keyword)) {
    AssertionResult.setFailure(true);
    AssertionResult.setFailureMessage("响应体里没找到：" + keyword);
    // 把响应体前 200 字打进报告，方便排查
    AssertionResult.setFailureMessage(
        "响应体里没找到：" + keyword + "，实际响应：" +
        (body == null ? "null" : body.substring(0, Math.min(200, body.length())))
    );
} else {
    AssertionResult.setFailure(false);
}`,
    gotcha: 'JSON 里的引号要转义成 \\"，否则字符串会断'
  },
  {
    id: 'assert-json-field',
    category: 'assert',
    name: '断言：JSON 字段值等于预期',
    when: '想确认 data.status == "SUCCESS" 这种。简单取值用 JSON 提取器 + 响应断言组合，不用脚本',
    where: '右键采样器 → 添加 → 断言 → JSR223 断言；语言选 Groovy',
  vars: [{"name":"fieldPath","value":"data.status","desc":"JSON 字段路径，如 data.status / data.list[0].id"},{"name":"expectedValue","value":"SUCCESS","desc":"期望的字段值"}],
    code: `// 断言 JSON 响应里的某个字段值
// 用 JMeter 内置的 JSON 解析（不需要额外 jar）
import groovy.json.JsonSlurper

String body = prev.getResponseDataAsString();

try {
    def json = new JsonSlurper().parseText(body)

    // 字段路径（复制时填，如 data.status）
    def actual = json.{{fieldPath}}
    def expected = "{{expectedValue}}"

    if (actual != expected) {
        AssertionResult.setFailure(true);
        AssertionResult.setFailureMessage("data.status 期望 " + expected + "，实际 " + actual);
    } else {
        AssertionResult.setFailure(false);
    }
} catch (Exception e) {
    AssertionResult.setFailure(true);
    AssertionResult.setFailureMessage("响应不是合法 JSON：" + e.getMessage());
}`,
    gotcha: 'JsonSlurper 是 Groovy 自带的，不用 import 任何 jar；BeanShell 里没有这个，得用 org.json'
  },
  {
    id: 'assert-response-time',
    category: 'assert',
    name: '断言：响应时间上限',
    when: '想确认单次请求不超过 800ms。持续时间断言能覆盖，不用代码',
    where: '右键采样器 → 添加 → 断言 → JSR223 断言；语言选 Groovy',
  vars: [{"name":"limitMs","value":"800","desc":"响应时间上限（毫秒）"}],
    code: `// 断言响应时间不超过指定毫秒
long elapsed = prev.getTime();   // 单位：毫秒
long limit = {{limitMs}};         // 响应时间上限（毫秒，复制时填）

if (elapsed > limit) {
    AssertionResult.setFailure(true);
    AssertionResult.setFailureMessage("响应时间 " + elapsed + "ms 超过上限 " + limit + "ms");
} else {
    AssertionResult.setFailure(false);
}`,
    gotcha: 'prev.getTime() 是 long，别和 Integer 直接比'
  },
  {
    id: 'extract-token',
    category: 'extract',
    name: '提取：从响应拿 token 存变量',
    when: '登录后拿到 token，后续接口要用。优先用 JSON 提取器，这个模板是脚本版',
    where: '右键采样器 → 添加 → 后置处理器 → JSR223 后置处理程序；语言选 Groovy',
  vars: [{"name":"jsonPath","value":"data.token","desc":"token 在响应 JSON 里的路径"}],
    code: `// 从登录响应里提取 token，存进线程变量
import groovy.json.JsonSlurper

String body = prev.getResponseDataAsString();

try {
    def json = new JsonSlurper().parseText(body)

    // JSON 路径（复制时填，如 data.token）
    def token = json.{{jsonPath}}

    if (token == null || token.toString().isEmpty()) {
        // 提取失败：存个标记值，让后续接口明显报错（而不是用空 token 静默失败）
        vars.put("token", "TOKEN_NOT_FOUND");
        log.error("token 提取失败，响应：" + body);
    } else {
        vars.put("token", token.toString());
        log.info("token 已提取：" + token);
    }
} catch (Exception e) {
    vars.put("token", "TOKEN_PARSE_ERROR");
    log.error("解析响应失败：" + e.getMessage());
}`,
    gotcha: 'vars 是线程级（每个线程独立），props 是全局（跨线程组共享）。token 一般用 vars'
  },
  {
    id: 'extract-write-file',
    category: 'extract',
    name: '提取：token 写入文件',
    when: '想把每次登录的 token 攒起来，给别的脚本用。这是你现有脚本在做的事',
    where: '右键采样器 → 添加 → 后置处理器 → JSR223 后置处理程序；语言选 Groovy',
  vars: [{"name":"filePath","value":"D:/test/token.txt","desc":"写入的文件路径（Windows 用 / 或 \\\\）"}],
    code: `// 把 token 追加写入文件（每次一行）
import groovy.json.JsonSlurper

String body = prev.getResponseDataAsString();

try {
    def json = new JsonSlurper().parseText(body)
    def code = json.code
    def token = json.data

    // 文件路径（复制时填）。注意：Windows 用 / 或 \\\\，别用单个 \\
    String filePath = "{{filePath}}";

    if (code == 0) {
        // true = 追加模式，不覆盖已有内容
        new File(filePath).append(token.toString() + "\\n")
        log.info("token 已写入：" + filePath + "，内容：" + token)
    } else {
        log.warn("code 不为 0，不写文件。code=" + code)
    }
} catch (Exception e) {
    log.error("写文件失败：" + e.getMessage())
}`,
    gotcha: '路径必须用 / 或 \\\\；用单个 \\ 会被当转义符。文件所在目录要已存在，脚本不会自动建目录'
  },
  {
    id: 'read-file-to-var',
    category: 'extract',
    name: '读取：从文件读 token 到变量',
    when: '压测时每个线程从文件读一个 token。其实 CSV Data Set Config 更合适，这个模板是脚本版',
    where: '右键采样器 → 添加 → 前置处理器 → JSR223 预处理程序；语言选 Groovy',
  vars: [{"name":"filePath","value":"D:/test/token.txt","desc":"读取的文件路径"}],
    code: `// 从文件读第一行，存进变量
// 文件路径（复制时填）
String filePath = "{{filePath}}";

try {
    def file = new File(filePath)
    if (!file.exists()) {
        vars.put("token", "TOKEN_FILE_MISSING")
        log.error("文件不存在：" + filePath)
    } else {
        String token = file.readLines().get(0)   // 读第一行
        if (token == null || token.trim().isEmpty()) {
            vars.put("token", "TOKEN_EMPTY")
            log.error("文件第一行是空的：" + filePath)
        } else {
            vars.put("token", token.trim())
            log.info("token 已读取：" + token)
        }
    }
} catch (Exception e) {
    vars.put("token", "TOKEN_READ_ERROR")
    log.error("读文件失败：" + e.getMessage())
}`,
    gotcha: '多线程同时读同一个文件没问题（只读）；但如果别的脚本在写这个文件，可能读到半行'
  },
  {
    id: 'random-data',
    category: 'generate',
    name: '生成：随机数 / 时间戳 / UUID',
    when: '下单号、流水号这类需要唯一值。JMeter 有内置函数 __Random / __UUID / __time，不用脚本',
    where: '右键采样器 → 添加 → 前置处理器 → JSR223 预处理程序；语言选 Groovy',
  vars: [{"name":"orderPrefix","value":"ORD","desc":"订单号前缀"}],
    code: `// 生成常用随机数据存进变量
// 提示：JMeter 内置函数更简单，见下方 gotcha

// 1. 时间戳（毫秒）
vars.put("ts", String.valueOf(System.currentTimeMillis()))

// 2. 随机 6 位数字
def rand = new Random().nextInt(900000) + 100000
vars.put("randNum", String.valueOf(rand))

// 3. UUID（去掉横线）
vars.put("uuid", UUID.randomUUID().toString().replace("-", ""))

// 4. 订单号 = 前缀 + 时间戳 + 随机数
// 订单号前缀（复制时填）
String prefix = "{{orderPrefix}}"
vars.put("orderNo", prefix + System.currentTimeMillis() + rand)

log.info("生成：orderNo=" + vars.get("orderNo"))`,
    gotcha: '内置函数更快：${__time(,ts)} ${__Random(100000,999999,randNum)} ${__UUID()}。脚本版只在需要组合逻辑时用'
  },
  {
    id: 'sign-md5',
    category: 'crypto',
    name: '加密：MD5 / Base64 签名',
    when: '接口要求签名（sign = md5(参数拼接 + 密钥)）',
    where: '右键采样器 → 添加 → 前置处理器 → JSR223 预处理程序；语言选 Groovy',
  vars: [{"name":"appSecret","value":"your_secret_here","desc":"签名密钥"},{"name":"paramsTemplate","value":"userId=\" + vars.get(\"userId\") + \"&ts=\" + vars.get(\"ts","desc":"参与签名的参数拼接（Groovy 表达式片段）"}],
    code: `// 生成 MD5 签名
import java.security.MessageDigest

// 签名规则（复制时填）
String appSecret = "{{appSecret}}"
String params = "{{paramsTemplate}}"
String raw = params + "&key=" + appSecret

// MD5
def md = MessageDigest.getInstance("MD5")
String sign = md.digest(raw.getBytes("UTF-8")).encodeHex().toString()

vars.put("sign", sign)
log.info("签名原文：" + raw)
log.info("签名结果：" + sign)

// Base64（如果需要）
// vars.put("b64", raw.getBytes("UTF-8").encodeBase64().toString())`,
    gotcha: 'encodeHex() 是 Groovy 给 byte[] 加的方法，BeanShell 里没有，得手写循环转十六进制'
  },
  {
    id: 'conditional-skip',
    category: 'flow',
    name: '流程：满足条件才执行后续',
    when: '比如「只有登录成功才继续下单」。优先用 If Controller，不用脚本',
    where: '右键线程组 → 添加 → 逻辑控制器 → 如果（If）控制器；条件填 ${__groovy(vars.get("token") != null)}',
  vars: [{"name":"varName","value":"token","desc":"要判断的变量名"}],
    code: `// 这个模板演示「用脚本设置一个标志变量，给 If Controller 用」
// 放在前置处理器里

// 判断条件（示例：token 存在且不是失败标记）
// 判断条件（复制时填变量名）
String token = vars.get("{{varName}}")
boolean ok = token != null && !token.startsWith("TOKEN_")

vars.put("canContinue", String.valueOf(ok))
log.info("canContinue = " + ok)

// 然后在 If Controller 里写：\${canContinue} == "true"`,
    gotcha: 'If Controller 默认会把条件当字符串比较，写 ${canContinue} 时要注意引号'
  },

  /* ========== 接口断言（RestAssured / pytest）========== */
  {
    id: 'api-assert-status',
    category: 'api-assert',
    name: 'RestAssured：状态码断言',
    when: '最简单的接口断言：确认返回 200',
    where: 'IDEA 里，.then() 后面',
    vars: [{ name: 'expectedCode', value: '200', desc: '期望的 HTTP 状态码' }],
    code: [
      '// 期望的状态码（改成你的）',
      '.then()',
      '    .statusCode({{expectedCode}});',
      '',
      '// 允许多个状态码：',
      '// .statusCode(anyOf(is(200), is(201)));'
    ].join('\n'),
    gotcha: '只校验状态码不算合格的接口测试——业务失败也可能返回 200'
  },

  {
    id: 'api-assert-json-field',
    category: 'api-assert',
    name: 'RestAssured：JSON 字段值断言',
    when: '要校验业务字段（code / msg / data.xxx）',
    where: 'IDEA 里，.then() 后面',
    vars: [
      { name: 'fieldPath', value: 'code', desc: 'JSON 路径（支持 data.id 嵌套）' },
      { name: 'expected', value: '0', desc: '期望值' }
    ],
    code: [
      'import static org.hamcrest.Matchers.*;',
      '',
      '.then()',
      '    .statusCode(200)',
      '    .body("{{fieldPath}}", equalTo({{expected}}));',
      '',
      '// 只要求字段存在：',
      '// .body("{{fieldPath}}", notNullValue());'
    ].join('\n'),
    gotcha: '数字用 equalTo(0)，字符串用 equalTo("0")——类型不匹配会失败'
  },

  {
    id: 'api-assert-json-schema',
    category: 'api-assert',
    name: 'RestAssured：JSON 结构校验（Schema）',
    when: '要确认返回结构没变（字段齐全、类型正确）',
    where: 'IDEA 里；Schema 放 src/test/resources/schemas/',
    vars: [
      { name: 'schemaFile', value: 'login-response.json', desc: 'schemas 下的文件名' }
    ],
    code: [
      '// 校验返回结构和 Schema 文件一致（字段齐全、类型正确）',
      'import static io.restassured.module.jsv.JsonSchemaValidator.*;',
      '',
      '.then()',
      '    .statusCode(200)',
      '    .body(matchesJsonSchemaInClasspath("schemas/{{schemaFile}}"));'
    ].join('\n'),
    gotcha: '要加依赖 io.rest-assured:json-schema-validator，否则类找不到'
  },

  {
    id: 'api-assert-pytest-json',
    category: 'api-assert',
    name: 'pytest：JSON 字段断言',
    when: 'Python 接口测试里校验业务字段',
    where: 'PyCharm 里，requests 之后',
    vars: [
      { name: 'field', value: 'code', desc: '字段名' },
      { name: 'expected', value: '0', desc: '期望值' }
    ],
    code: [
      '# 先断状态码（失败时把响应前 200 字打出来）',
      'assert resp.status_code == 200, f"HTTP {resp.status_code}: {resp.text[:200]}"',
      '',
      '# 再断业务字段（field 改成你的字段名）',
      'body = resp.json()',
      'assert body["{{field}}"] == {{expected}}, f"字段值不对：{body}"'
    ].join('\n'),
    gotcha: '断言里带上实际值（f-string），失败时不用再手动打印'
  },

  {
    id: 'api-assert-pytest-schema',
    category: 'api-assert',
    name: 'pytest：JSON Schema 校验',
    when: 'Python 里校验返回结构',
    where: 'PyCharm 里；pip install jsonschema',
    vars: [],
    code: [
      '# 校验返回结构和 SCHEMA 一致（pip install jsonschema）',
      'import jsonschema',
      '',
      '# 改成你的接口结构',
      'SCHEMA = {',
      '    "type": "object",',
      '    "required": ["code", "data"],',
      '    "properties": {',
      '        "code": {"type": "integer"},',
      '        "data": {"type": "object"},',
      '    },',
      '}',
      '',
      'jsonschema.validate(resp.json(), SCHEMA)'
    ].join('\n'),
    gotcha: '校验失败抛 ValidationError，pytest 会当成失败'
  },

  /* ========== UI 断言（Playwright）========== */
  {
    id: 'ui-assert-visible',
    category: 'ui-assert',
    name: 'Playwright：元素可见 / 隐藏',
    when: '确认元素出现或消失',
    where: 'Playwright 测试方法里',
    vars: [
      { name: 'selector', value: '[data-testid=submit]', desc: '定位器（优先 data-testid）' }
    ],
    code: [
      '// 可见（自动等待，最多 30s）',
      'await expect(page.locator("{{selector}}")).toBeVisible();',
      '',
      '// 隐藏 / 不存在',
      'await expect(page.locator("{{selector}}")).toBeHidden();'
    ].join('\n'),
    gotcha: '不要用 isVisible() 再 assert——它不等待，元素没渲染就返回 false'
  },

  {
    id: 'ui-assert-text',
    category: 'ui-assert',
    name: 'Playwright：文本包含 / 相等',
    when: '校验元素文字',
    where: 'Playwright 测试方法里',
    vars: [
      { name: 'selector', value: '.toast', desc: '定位器' },
      { name: 'text', value: '保存成功', desc: '期望文字' }
    ],
    code: [
      '// 包含（最常用）',
      'await expect(page.locator("{{selector}}")).toContainText("{{text}}");',
      '',
      '// 完全相等（支持正则）',
      'await expect(page.locator("{{selector}}")).toHaveText(/^保存成功$/);'
    ].join('\n'),
    gotcha: 'toContainText 会自动 trim + 等待；toHaveText 要求完全一致'
  },

  {
    id: 'ui-assert-attr',
    category: 'ui-assert',
    name: 'Playwright：属性值 / 输入框值',
    when: '校验 href / disabled / class，或输入框内容',
    where: 'Playwright 测试方法里',
    vars: [
      { name: 'selector', value: '#username', desc: '定位器' },
      { name: 'attr', value: 'value', desc: '属性名' },
      { name: 'expected', value: 'admin', desc: '期望值' }
    ],
    code: [
      '// 属性值',
      'await expect(page.locator("{{selector}}")).toHaveAttribute("{{attr}}", "{{expected}}");',
      '',
      '// 输入框的值（专用断言，比 toHaveAttribute 更准）',
      'await expect(page.locator("{{selector}}")).toHaveValue("{{expected}}");',
      '',
      '// 禁用状态',
      'await expect(page.locator("{{selector}}")).toBeDisabled();'
    ].join('\n'),
    gotcha: '用户输入的值不在 attribute 里，要用 toHaveValue()'
  },
];

module.exports = { NO_CODE_NEEDED, TEMPLATES, TEMPLATE_CATEGORIES, CATEGORY_MAP };
