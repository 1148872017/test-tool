'use strict';
/**
 * 示例数据（demo）。
 *
 * ============================================================
 * 为什么需要
 * ============================================================
 * 新用户装完打开，所有页面都是空的，不知道每块功能长什么样、
 * 该填什么。放 1-2 条真实的示例数据，看一眼就懂。
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **只写一次**：meta.demoSeeded 标记，删了不会自己长回来
 * 2. **可识别**：每条都打标签「示例」，列表里一眼能认出来
 * 3. **可一键清空**：设置 → 数据与备份 → 「清除示例数据」
 * 4. **配套文件**：代码体检要代码目录、报告分析要 allure-results，
 *    所以内置一个迷你项目和一份迷你报告，写到数据目录下
 */

const fs = require('fs');
const path = require('path');

/** 示例标签：所有 demo 记录都带这个标签 */
const DEMO_TAG = '示例';

/* ============================================================
 * 资产示例：5 个集合
 * ============================================================ */

const DEMO_RECORDS = [
  /* ---------- 1. 网站管理 ---------- */
  {
    collection: 'sites',
    data: {
      name: '示例商城-管理后台',
      url: 'https://demo-shop.example.com/admin',
      env: ['test'],
      accounts: JSON.stringify([
        {
          label: '管理员',
          account: 'admin',
          password: 'Admin@123',
          role: ['admin'],
          isDefault: true,
          note: '示例账号，可删'
        },
        {
          label: '运营',
          account: 'operator',
          password: 'Oper@123',
          role: ['user'],
          isDefault: false,
          note: ''
        }
      ]),
      note: '这是示例数据，看懂了可以直接删。点地球图标会打开地址并复制默认账号密码。'
    }
  },
  {
    collection: 'sites',
    data: {
      name: '示例商城-运营端',
      url: 'https://demo-shop.example.com/ops',
      env: ['test', 'staging'],
      accounts: JSON.stringify([
        {
          label: '运营专员',
          account: 'ops01',
          password: 'Ops@123',
          role: ['user'],
          isDefault: true,
          note: ''
        }
      ]),
      note: '一个站点可以有多个环境标签，列表里能按环境筛。'
    }
  },

  /* ---------- 2. SQL 片段 ---------- */
  {
    collection: 'sqls',
    data: {
      name: '按订单号查订单',
      db: 'demo_shop',
      sql: "SELECT * FROM t_order WHERE order_no = '{{orderNo}}' AND create_time > '{{startDate}}';",
      vars: JSON.stringify([
        { name: 'orderNo', value: '', desc: '订单号' },
        { name: 'startDate', value: '2026-01-01', desc: '起始日期' }
      ]),
      note: '点「复制」会弹窗让你填变量，拼接预览里变量会标色。'
    }
  },
  {
    collection: 'sqls',
    data: {
      name: '清理过期订单日志',
      db: 'demo_shop',
      sql: 'DELETE FROM t_order_log WHERE create_time < DATE_SUB(NOW(), INTERVAL {{days}} DAY) LIMIT {{limit}};',
      vars: JSON.stringify([
        { name: 'days', value: '30', desc: '保留天数' },
        { name: 'limit', value: '1000', desc: '单次删除上限' }
      ]),
      note: '带 LIMIT 的删除更安全，避免一次锁太多行。'
    }
  },

  /* ---------- 3. 接口记录 ---------- */
  {
    collection: 'apis',
    data: {
      name: '用户登录',
      method: 'POST',
      url: 'https://demo-shop.example.com/api/login',
      module: '用户认证',
      headers: 'Content-Type: application/json',
      bodyType: 'json',
      body: '{\n  "username": "admin",\n  "password": "Admin@123"\n}',
      paramTable: '[]',
      respExample:
        '{\n  "code": 0,\n  "msg": "success",\n  "data": {\n    "token": "eyJhbGciOi...",\n    "userId": 1001\n  }\n}',
      note: '示例接口。可以点「复制 cURL」直接粘到终端跑；也能到「代码生成」一键生成测试类。'
    }
  },
  {
    collection: 'apis',
    data: {
      name: '查订单详情',
      method: 'GET',
      url: 'https://demo-shop.example.com/api/order/{orderNo}',
      module: '订单',
      headers: 'Authorization: Bearer {{token}}',
      bodyType: 'none',
      body: '',
      paramTable: JSON.stringify([
        { name: 'orderNo', in: 'path', type: 'string', required: true, example: 'SO20261124001', desc: '订单号' }
      ]),
      respExample: '{\n  "code": 0,\n  "data": {\n    "orderNo": "SO20261124001",\n    "amount": 199.00,\n    "status": "PAID"\n  }\n}',
      note: 'URL 里的 {orderNo} 是路径参数，会自动识别。'
    }
  },
  {
    collection: 'apis',
    data: {
      name: '创建退款单',
      method: 'POST',
      url: 'https://demo-shop.example.com/api/refund',
      module: '退款',
      headers: 'Content-Type: application/json\nAuthorization: Bearer {{token}}',
      bodyType: 'json',
      body: '{\n  "orderNo": "SO20261124001",\n  "amount": 99.00,\n  "reason": "用户申请"\n}',
      paramTable: '[]',
      respExample: '{\n  "code": 0,\n  "data": {\n    "refundNo": "RF20261124001"\n  }\n}',
      note: '带 Token 的接口，示例里用 {{token}} 占位，压测时可以配 CSV 参数化。'
    }
  },

  /* ---------- 4. 测试执行 ---------- */
  {
    collection: 'runs',
    data: {
      name: '登录接口验证',
      kind: 'api',
      result: 'ok',
      ranAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      env: 'test',
      apiRef: '',
      passCount: 12,
      failCount: 0,
      conclusion: '示例记录：登录接口返回 200，token 正常，业务 code=0。\n\n这一条展示「接口测试」记录怎么填。'
    }
  },
  {
    collection: 'runs',
    data: {
      name: '商品详情压测-50并发',
      kind: 'perf',
      result: 'ok',
      ranAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      env: 'test',
      concurrency: 50,
      duration: '30s',
      tps: 480.5,
      p90: 85,
      p95: 120,
      p99: 210,
      errRate: 0,
      samples: 14400,
      conclusion: '示例记录：50 并发跑 30 秒，TPS 稳定在 480 左右，错误率 0。\n\n指标表是横向 2 行显示（第一行字段名，第二行值）。'
    }
  },

  /* ---------- 5. 页面元素 ---------- */
  {
    collection: 'pages',
    data: {
      name: '登录页',
      url: '/login',
      project: '示例项目',
      elements: JSON.stringify([
        { name: 'usernameInput', selector: '#username', desc: '用户名输入框' },
        { name: 'passwordInput', selector: '#password', desc: '密码输入框' },
        { name: 'submitBtn', selector: '[data-testid=login-submit]', desc: '登录按钮' },
        { name: 'errorTip', selector: '.ant-form-item-explain-error', desc: '错误提示' }
      ]),
      note: '示例页面。到「代码生成」选 Playwright POM，能一键生成页面对象类。'
    }
  },
  {
    collection: 'pages',
    data: {
      name: '订单列表页',
      url: '/order/list',
      project: '示例项目',
      elements: JSON.stringify([
        { name: 'searchInput', selector: '[data-testid=order-search]', desc: '订单号搜索框' },
        { name: 'statusSelect', selector: '.ant-select-status', desc: '状态筛选' },
        { name: 'orderTable', selector: '[data-testid=order-table]', desc: '订单表格' }
      ]),
      note: '定位器优先用 data-testid，比 XPath 稳定得多。'
    }
  }
];

/* ============================================================
 * 配套文件：迷你项目（代码体检用）+ 迷你 allure 报告（报告分析用）
 * ============================================================ */

/** 迷你 Maven 项目（故意留了几个"问题"给代码体检抓） */
const DEMO_PROJECT = {
  'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example.demo</groupId>
  <artifactId>demo-autotest</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
  </properties>
  <dependencies>
    <dependency>
      <groupId>io.rest-assured</groupId>
      <artifactId>rest-assured</artifactId>
      <version>5.3.0</version>
      <scope>test</scope>
    </dependency>
    <!-- 测试框架：TestNG + REST Assured，和「代码生成」里导出的接口测试类同一套技术栈 -->
    <dependency>
      <groupId>org.testng</groupId>
      <artifactId>testng</artifactId>
      <version>7.9.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <!-- TestNG 用例由 surefire 执行；指定 suite 文件（testng.xml）才会按套件顺序跑。
           要用套件就把下面 configuration 的注释去掉，并在 src/test/resources 里放 testng.xml。 -->
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.1.2</version>
        <!--
        <configuration>
          <suiteXmlFiles>
            <suiteXmlFile>src/test/resources/testng.xml</suiteXmlFile>
          </suiteXmlFiles>
        </configuration>
        -->
      </plugin>
    </plugins>
  </build>
</project>
`,
  'src/test/java/com/example/demo/LoginApiTest.java': `package com.example.demo;

import io.restassured.response.Response;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

import static io.restassured.RestAssured.given;
import static org.testng.Assert.assertEquals;

/**
 * 示例测试类 —— 代码体检会在这里抓到几个问题：
 *   1. 硬编码密码
 *   2. 硬编码地址
 *   3. Thread.sleep
 *   4. 断言过弱（只断言状态码）
 *
 * 框架是 TestNG：@DataProvider 数据驱动是它相比 JUnit4 的优势 ——
 * 同一段用例逻辑喂 2 组数据，不用为每组数据再写一个包装类。
 */
public class LoginApiTest {

    private static final String USERNAME = "admin";

    // 【代码体检会报】硬编码密码
    private static final String PASSWORD = "admin123";

    // 【代码体检会报】硬编码地址（example.com 是占位域名，规则会跳过，下面那条才是真正会被报的）
    private static final String BASE_URL = "https://demo-shop.example.com";

    // 【代码体检会报】硬编码地址：预发环境地址写死在代码里，换环境只能改代码
    private static final String STAGING_URL = "https://demo-shop-staging.testhub.cn";

    /**
     * TestNG 相比 JUnit4 的优势：@DataProvider 把 2 组数据直接喂给同一个测试方法，
     * 不用继承 TestCase，也不用 @RunWith 包装。
     */
    @DataProvider(name = "loginData")
    public Object[][] loginData() {
        return new Object[][] {
            { USERNAME, PASSWORD },
            { USERNAME, "wrong-password" }
        };
    }

    @Test(dataProvider = "loginData")
    public void testLoginWithDataProvider(String username, String password) {
        given()
            .contentType("application/json")
            .body("{\\"username\\":\\"" + username + "\\",\\"password\\":\\"" + password + "\\"}")
        .when()
            .post(STAGING_URL + "/api/login")
        .then()
            .statusCode(200)
            // 有具体字段断言，不会被报「断言过弱」
            .body("code", org.hamcrest.Matchers.equalTo(0));
    }

    @Test
    public void testLoginOk() {
        Response response = given()
            .contentType("application/json")
            .body("{\\"username\\":\\"admin\\",\\"password\\":\\"" + PASSWORD + "\\"}")
        .when()
            .post(BASE_URL + "/api/login")
        .then()
            .statusCode(200)
            .extract().response();

        // 这条用 TestNG 的断言校验业务字段，不会被报「断言过弱」
        assertEquals(response.jsonPath().getInt("code"), 0);
    }

    @Test
    public void testUserInfoWeakAssertion() {
        // 【代码体检会报】断言过弱：只校验状态码，响应体对不对完全不知道
        given().when().get(BASE_URL + "/api/user").then().statusCode(200);
    }

    @Test
    public void testLoginSlow() throws Exception {
        // 【代码体检会报】硬编码 sleep
        Thread.sleep(2000);
        given().when().get(BASE_URL + "/api/user").then().statusCode(200);
    }
}
`,
  'src/test/java/com/example/demo/OrderPage.java': `package com.example.demo;

/**
 * 示例页面对象 —— 代码体检会抓到「绝对 XPath」。
 */
public class OrderPage {

    // 【代码体检会报】绝对 XPath
    public static final String SEARCH_INPUT = "/html/body/div[1]/div[2]/input";

    // 这条不会报（用了 data-testid）
    public static final String ORDER_TABLE = "[data-testid=order-table]";
}
`
};

/** 迷你 allure 报告：3 个用例，2 个失败（同一种错误，演示失败聚类） */
function buildDemoAllure() {
  const now = Date.now();
  const mk = (uuid, name, status, message, durationMs, labels) =>
    JSON.stringify(
      {
        uuid,
        name,
        status,
        statusDetails: message ? { known: false, muted: false, flaky: false, message, trace: '' } : {},
        stage: 'finished',
        start: now - durationMs,
        stop: now,
        labels: labels.map(([n, v]) => ({ name: n, value: v })),
        attachments: []
      },
      null,
      2
    );

  return {
    'a1b2c3d4-0001-4000-8000-000000000001-result.json': mk(
      'a1b2c3d4-0001-4000-8000-000000000001',
      '正确用户名密码登录成功',
      'passed',
      '',
      1200,
      [
        ['suite', '登录接口测试'],
        ['testClass', 'com.example.demo.LoginApiTest'],
        ['testMethod', 'testLoginOk'],
        ['feature', '用户认证'],
        ['severity', 'critical'],
        ['framework', 'testng']
      ]
    ),
    'a1b2c3d4-0002-4000-8000-000000000002-result.json': mk(
      'a1b2c3d4-0002-4000-8000-000000000002',
      '空用户名登录应返回 400',
      'failed',
      '期望 400，实际 500：服务端没做空参数校验，疑似参数校验缺失',
      2100,
      [
        ['suite', '登录接口测试'],
        ['testClass', 'com.example.demo.LoginApiTest'],
        ['testMethod', 'testLoginWithEmptyUsername'],
        ['feature', '用户认证'],
        ['severity', 'normal'],
        ['framework', 'testng']
      ]
    ),
    'a1b2c3d4-0003-4000-8000-000000000003-result.json': mk(
      'a1b2c3d4-0003-4000-8000-000000000003',
      '空密码登录应返回 400',
      'failed',
      '期望 400，实际 500：服务端没做空参数校验，疑似参数校验缺失',
      1800,
      [
        ['suite', '登录接口测试'],
        ['testClass', 'com.example.demo.LoginApiTest'],
        ['testMethod', 'testLoginWithEmptyPassword'],
        ['feature', '用户认证'],
        ['severity', 'normal'],
        ['framework', 'testng']
      ]
    )
  };
}

/* ============================================================
 * 写入 / 清除
 * ============================================================ */

/** 写配套文件（项目 + 报告） */
function writeDemoFiles(demoRoot) {
  const results = [];

  // 1. 迷你 Maven 项目
  const projDir = path.join(demoRoot, 'project');
  try {
    fs.mkdirSync(projDir, { recursive: true });
    for (const [rel, content] of Object.entries(DEMO_PROJECT)) {
      const full = path.join(projDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    results.push({ kind: 'project', dir: projDir });
  } catch (e) {
    results.push({ kind: 'project', error: String(e && e.message) });
  }

  // 2. 迷你 allure 报告
  const allureDir = path.join(demoRoot, 'allure-results');
  try {
    fs.mkdirSync(allureDir, { recursive: true });
    for (const [name, content] of Object.entries(buildDemoAllure())) {
      fs.writeFileSync(path.join(allureDir, name), content, 'utf8');
    }
    results.push({ kind: 'allure', dir: allureDir });
  } catch (e) {
    results.push({ kind: 'allure', error: String(e && e.message) });
  }

  return results;
}

/**
 * 首次启动时写入示例数据。
 *
 * @param {object} store store 模块
 * @param {string} demoRoot 配套文件放哪（一般是 %APPDATA%/测试工作台/demo）
 * @returns {{seeded: boolean, records: number, files: any[]}}
 */
function seedDemo(store, demoRoot) {
  // 已经写过就不重复写（用户删了也不该自己长回来）
  if (store.getMeta('demoSeeded', false)) {
    return { seeded: false, records: 0, files: [] };
  }

  /**
   * 老用户（库里已有自己的数据）不塞示例。
   *
   * 为什么：升级到有 demo 的版本时，如果库里已经有 50 条自己的记录，
   * 再混进 11 条示例是打扰。只有「全新装」才需要示例。
   */
  const existing = ['sites', 'sqls', 'apis', 'runs', 'pages'].reduce((n, k) => {
    try {
      return n + (store.list(k) || []).length;
    } catch (e) {
      return n;
    }
  }, 0);
  if (existing > 0) {
    store.setMeta('demoSeeded', true);
    return { seeded: false, records: 0, files: [], skippedBecauseHasData: existing };
  }

  let count = 0;
  const errors = [];
  for (const rec of DEMO_RECORDS) {
    try {
      store.save({
        collection: rec.collection,
        data: rec.data,
        tags: [DEMO_TAG],
        favorite: false
      });
      count++;
    } catch (e) {
      errors.push({ collection: rec.collection, error: String(e && e.message) });
    }
  }

  const files = writeDemoFiles(demoRoot);

  store.setMeta('demoSeeded', true);
  store.setMeta('demoSeedAt', new Date().toISOString());

  return { seeded: true, records: count, files, errors };
}

/**
 * 清除所有示例数据（记录 + 配套文件）。
 *
 * @param {object} store
 * @param {string} demoRoot
 */
function clearDemo(store, demoRoot) {
  let removed = 0;
  const errors = [];

  // 1. 删带「示例」标签的记录
  for (const conf of Object.keys(require('../shared/collections').COLLECTION_MAP)) {
    let rows;
    try {
      rows = store.list(conf) || [];
    } catch (e) {
      continue;
    }
    for (const r of rows) {
      const tags = Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(',');
      if (tags.map((t) => String(t).trim()).includes(DEMO_TAG)) {
        try {
          store.remove(r.id);
          removed++;
        } catch (e) {
          errors.push(String(e && e.message));
        }
      }
    }
  }

  // 2. 删配套文件
  try {
    if (fs.existsSync(demoRoot)) {
      fs.rmSync(demoRoot, { recursive: true, force: true });
    }
  } catch (e) {
    errors.push('删除示例文件失败：' + (e && e.message));
  }

  // 3. 标记已清除（不再自动写入）
  store.setMeta('demoSeeded', true);

  return { removed, errors };
}

/** 有多少条示例记录 */
function countDemo(store) {
  let n = 0;
  for (const conf of Object.keys(require('../shared/collections').COLLECTION_MAP)) {
    let rows;
    try {
      rows = store.list(conf) || [];
    } catch (e) {
      continue;
    }
    for (const r of rows) {
      const tags = Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(',');
      if (tags.map((t) => String(t).trim()).includes(DEMO_TAG)) n++;
    }
  }
  return n;
}

module.exports = { seedDemo, clearDemo, countDemo, DEMO_RECORDS, DEMO_TAG, DEMO_PROJECT };