'use strict';
/**
 * 代码骨架生成器。
 *
 * 输入：接口记录（apis 集合的 data）
 * 输出：Java / Python 的测试代码骨架
 *
 * ============================================================
 * 设计要点
 * ============================================================
 * 1. **纯模板替换，不做 AST**
 *    读 OpenAPI 拿到的 path/method/参数，直接替换到模板字符串里。
 *    不做语法树逆向生成（成本高、易出错）。
 *
 * 2. **生成的是「骨架」不是「完整代码」**
 *    方法签名、请求路径、参数占位符、基础断言。
 *    业务逻辑和数据要用户自己填。
 *
 * 3. **用 EJS 模板**
 *    Node 生态最简单，语法接近 HTML。
 */

const ejs = require('ejs');
const { parseCreateTable } = require('./sqlschema');
const {
  LOCATOR_MODES,
  normalizeLocatorMode,
  splitRoleSelector,
  previewLocatorCode
} = require('./locatorModes');

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 首字母大写 */
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

/** 转驼峰：pet-detail → petDetail */
function camel(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

/** 转帕斯卡：pet-detail → PetDetail */
function pascal(s) {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** 从 URL 猜类名：/pet/{petId} → Pet */
function classNameFromUrl(url) {
  const parts = String(url || '')
    .split('?')[0]
    .split('/')
    .filter((p) => p && !p.startsWith('{'));
  const last = parts[parts.length - 1] || 'Api';
  return pascal(last);
}

/**
 * 只保留 ASCII 字母数字（其余按分隔符处理）。
 *
 * 为什么要这一步：类名 / 文件名必须是合法标识符。
 * 中文页面名（如「登录页」）直接丢给 camel/pascal 会被吃成「页」，
 * 生成的文件名就成了 `页Page.java` —— 这就是「预览文件名不完整」的根因。
 */
function asciiWords(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
}

/** 转下划线小写：LoginPage → login_page（Python 文件名用） */
function snake(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * 页面对象的基名（不含 Page 后缀，模板和文件名会自己补）。
 *
 * 取值优先级：类名输入框 > 页面名 > URL 路径 > 'My'
 * 中文/特殊字符会被丢弃，丢干净了就顺延到下一个来源，
 * 避免出现 `页Page.java` 这种只剩一个字的文件名。
 */
function pageBaseName(page, override) {
  const urlBase = classNameFromUrl(page && page.url);
  const candidates = [override, page && page.name, urlBase === 'Api' ? '' : urlBase];
  for (const c of candidates) {
    const raw = asciiWords(c);
    if (!raw) continue;
    // 模板里写死了 `<%= className %>Page`，这里先去掉结尾的 Page，避免 LoginPagePage
    const base = pascal(raw).replace(/Page$/, '');
    if (base) return base;
  }
  return 'My';
}

/** 从 URL 猜方法名：POST /pet → createPet */
function methodNameFromApi(method, url) {
  const m = String(method || 'GET').toUpperCase();
  const prefix = { GET: 'get', POST: 'create', PUT: 'update', DELETE: 'delete', PATCH: 'patch' }[m] || 'call';
  const parts = String(url || '')
    .split('?')[0]
    .split('/')
    .filter((p) => p && !p.startsWith('{'));
  const last = parts[parts.length - 1] || 'api';
  return prefix + pascal(last);
}

/** 解析 paramTable（JSON 字符串） */
function parseParams(raw) {
  try {
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/** 解析 body（form-urlencoded → 键值对） */
function parseFormBody(body) {
  const out = [];
  for (const seg of String(body || '').split('&')) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = decodeURIComponent(s.slice(0, i));
    const v = decodeURIComponent(s.slice(i + 1));
    out.push({ key: k, value: v });
  }
  return out;
}

/** 解析 body（JSON → 顶层键） */
function parseJsonBody(body) {
  try {
    const obj = JSON.parse(String(body || '{}'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return Object.keys(obj).map((k) => ({ key: k, value: obj[k] }));
    }
  } catch (e) {
    /* ignore */
  }
  return [];
}

/**
 * 把接口记录转成模板上下文。
 * @param {object} api apis 记录的 data
 */
function buildContext(api) {
  const method = String(api.method || 'GET').toUpperCase();
  const url = String(api.url || '/');
  const params = parseParams(api.paramTable);
  const bodyType = String(api.bodyType || 'none');

  // body 参数
  let bodyParams = [];
  if (bodyType === 'x-www-form-urlencoded' || bodyType === 'form-data') {
    bodyParams = parseFormBody(api.body);
  } else if (bodyType === 'json') {
    bodyParams = parseJsonBody(api.body);
  }

  return {
    name: String(api.name || ''),
    method,
    url,
    module: String(api.module || ''),
    className: classNameFromUrl(url),
    methodName: methodNameFromApi(method, url),
    // query/path/header 参数
    params: params.map((p) => ({
      name: p.name,
      in: p.in,
      type: p.type || 'string',
      required: !!p.required,
      example: p.example || '',
      desc: p.desc || ''
    })),
    // body 参数
    bodyParams: bodyParams.map((p) => ({
      key: p.key,
      value: typeof p.value === 'string' ? p.value : JSON.stringify(p.value)
    })),
    bodyType,
    hasBody: bodyParams.length > 0,
    // path 参数（URL 里的 {xxx}）
    pathParams: (String(url).match(/\{([^}]+)\}/g) || []).map((m) => m.slice(1, -1))
  };
}

/* ============================================================
 * 模板
 * ============================================================ */

/** Java + REST Assured */
const TPL_JAVA_RESTASSURED = `package com.test.api;

import io.restassured.RestAssured;
import io.restassured.response.Response;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import static io.restassured.RestAssured.given;
import static org.testng.Assert.*;

/**
 * <%= name %>
 * <%= method %> <%= url %>
 * 模块：<%= module %>
 *
 * 由「测试工作台」生成骨架，业务逻辑和数据请自行补充。
 */
public class <%= className %>ApiTest {

    @BeforeClass
    public void setUp() {
        RestAssured.baseURI = System.getProperty("baseUrl", "http://localhost:8080");
    }

    @Test
    public void test<%= methodName.charAt(0).toUpperCase() + methodName.slice(1) %>() {
        Response response = given()
<% if (hasBody && bodyType === 'x-www-form-urlencoded') { -%>
            .contentType("application/x-www-form-urlencoded")
<% } else if (hasBody && bodyType === 'json') { -%>
            .contentType("application/json")
<% } else { -%>
            .contentType("application/json")
<% } -%>
<% if (params.length) { -%>
<% params.forEach(function (p) { -%>
<% if (p.in === 'query') { -%>
            .queryParam("<%= p.name %>", "<%= p.example || 'TODO' %>")
<% } else if (p.in === 'header') { -%>
            .header("<%= p.name %>", "<%= p.example || 'TODO' %>")
<% } -%>
<% }); -%>
<% } -%>
<% if (hasBody && bodyType === 'x-www-form-urlencoded') { -%>
<% bodyParams.forEach(function (p) { -%>
            .formParam("<%= p.key %>", "<%= p.value %>")
<% }); -%>
<% } else if (hasBody && bodyType === 'json') { -%>
            .body("{\\n" +
<% bodyParams.forEach(function (p, i) { -%>
                  "  \\"<%= p.key %>\\": \\"<%= p.value %>\\"<%= i < bodyParams.length - 1 ? ',' : '' %>" + "\\n" +
<% }); -%>
                  "}")
<% } -%>
        .when()
            .<%= method.toLowerCase() %>("<%= url %>")
        .then()
            .statusCode(200)
            .extract().response();

        // TODO: 补充业务断言
        // assertEquals(response.jsonPath().getString("code"), "0");
    }
}
`;

/** Python + pytest + requests */
const TPL_PYTHON_PYTEST = `# -*- coding: utf-8 -*-
"""
<%= name %>
<%= method %> <%= url %>
模块：<%= module %>

由「测试工作台」生成骨架，业务逻辑和数据请自行补充。
"""
import pytest
import requests


BASE_URL = "http://localhost:8080"


class Test<%= className %>:
    """<%= name %>"""

    def test_<%= methodName.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }) %>(self):
        """<%= method %> <%= url %>"""
        url = BASE_URL + "<%= url %>"
<% if (params.length) { -%>
        params = {
<% params.forEach(function (p) { -%>
<% if (p.in === 'query') { -%>
            "<%= p.name %>": "<%= p.example || 'TODO' %>",
<% } -%>
<% }); -%>
        }
<% } else { -%>
        params = {}
<% } -%>
<% if (params.some(function (p) { return p.in === 'header'; })) { -%>
        headers = {
<% params.forEach(function (p) { -%>
<% if (p.in === 'header') { -%>
            "<%= p.name %>": "<%= p.example || 'TODO' %>",
<% } -%>
<% }); -%>
        }
<% } else { -%>
        headers = {}
<% } -%>
<% if (hasBody && bodyType === 'x-www-form-urlencoded') { -%>
        data = {
<% bodyParams.forEach(function (p) { -%>
            "<%= p.key %>": "<%= p.value %>",
<% }); -%>
        }
        resp = requests.<%= method.toLowerCase() %>(url, params=params, headers=headers, data=data)
<% } else if (hasBody && bodyType === 'json') { -%>
        json_body = {
<% bodyParams.forEach(function (p) { -%>
            "<%= p.key %>": "<%= p.value %>",
<% }); -%>
        }
        resp = requests.<%= method.toLowerCase() %>(url, params=params, headers=headers, json=json_body)
<% } else { -%>
        resp = requests.<%= method.toLowerCase() %>(url, params=params, headers=headers)
<% } -%>

        assert resp.status_code == 200, f"期望 200，实际 {resp.status_code}：{resp.text[:200]}"

        # TODO: 补充业务断言
        # body = resp.json()
        # assert body["code"] == 0
`;

/** Playwright Page Object（Java） */
const TPL_PLAYWRIGHT_JAVA = `package com.test.pages;

import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
<% if (hasRole) { -%>
import com.microsoft.playwright.options.AriaRole;
<% } -%>

/**
 * <%= className %> 页面对象
 *
 * 由「测试工作台」生成骨架。
 * 元素定位器请在平台里维护后重新生成，或手动补充。
 */
public class <%= className %>Page {

    private final Page page;

    public <%= className %>Page(Page page) {
        this.page = page;
    }

    // ===== 元素定位器 =====
<% elements.forEach(function (el) { -%>
    /** <%= el.desc || el.name %>（定位方式：<%= el.mode %>） */
    public Locator <%= el.name %>() {
        return <%= el.locator %>;
    }

<% }); -%>
    // ===== 常用操作 =====
    public void open(String baseUrl) {
        page.navigate(baseUrl + "<%= url %>");
    }
}
`;

/** Playwright Page Object（Python） */
const TPL_PLAYWRIGHT_PYTHON = `# -*- coding: utf-8 -*-
"""
<%= className %> 页面对象

由「测试工作台」生成骨架。
元素定位器请在平台里维护后重新生成，或手动补充。
"""
from playwright.sync_api import Page, Locator


class <%= className %>Page:
    """<%= className %> 页面"""

    def __init__(self, page: Page):
        self.page = page

    # ===== 元素定位器 =====
<% elements.forEach(function (el) { -%>
    @property
    def <%= el.name %>(self) -> Locator:
        """<%= el.desc || el.name %>（定位方式：<%= el.mode %>）"""
        return <%= el.locator %>

<% }); -%>
    # ===== 常用操作 =====
    def open(self, base_url: str):
        self.page.goto(base_url + "<%= url %>")
`;

/** Java POJO（带 Lombok） */
const TPL_POJO_JAVA = `package com.test.model;

import lombok.Data;

/**
 * <%= className %>
 *
 * 由「测试工作台」生成（数据来源：JSON 或建表语句）。
 */
@Data
public class <%= className %> {
<% fields.forEach(function (f) { -%>

    /** <%- f.comment || f.key %> */
    private <%- f.javaType %> <%= f.name %>;
<% }); -%>
}
`;

/** Python Pydantic 模型 */
const TPL_DATACLASS_PYTHON = `# -*- coding: utf-8 -*-
"""
<%= className %>

由「测试工作台」生成（数据来源：JSON 或建表语句）。
"""
from typing import Any, List, Optional
from pydantic import BaseModel, Field


class <%= className %>(BaseModel):
<% fields.forEach(function (f) { -%>
    <%= f.name %>: <%- f.pyType %> = Field(default=None, description="<%- f.comment || f.key %>")
<% }); -%>
`;

/* ============================================================
 * 生成入口
 * ============================================================ */

/**
 * v0.64：自动化测试基类（Java + Playwright）。
 *
 * 用户那段「每个自动化启动的第一步」的代码，做成一个生成目标。
 * 为什么不放积木里：积木产物是**一个方法体**，而这段是**类级别**的东西
 * （静态字段 + 生命周期方法），塞进方法体会编译不过。
 *
 * 按用户要求做得尽量短：不读配置文件、不做 firefox/webkit 分支，
 * 就是 chromium + headless=false + slowMo=500（边调边看）。想改行为改这两行注释处。
 * 比原稿多的只有 @AfterClass —— 不然每跑一次就留一个浏览器进程。
 */
const TPL_JAVA_PLAYWRIGHT_BASE = `package com.test.base;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.BrowserType;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;

import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;

/**
 * 自动化测试基类：起浏览器 + 收尾。
 *
 * 用法：测试类继承它，方法体里直接用 page / context：
 *   public class LoginTest extends <%= className %> {
 *       @Test
 *       public void testLogin() {
 *           page.navigate("/login");
 *       }
 *   }
 */
public class <%= className %> {

    // 整个测试类共享：Playwright / Browser 起一次就够（很重）
    protected static Playwright playwright;
    protected static Browser browser;

    // 每个测试方法一套
    protected BrowserContext context;
    protected Page page;

    @BeforeClass(alwaysRun = true)
    public void setUpClass() {
        playwright = Playwright.create();
        browser = playwright.chromium().launch(
                new BrowserType.LaunchOptions()
                        .setHeadless(false)   // 想后台跑就改 true
                        .setSlowMo(500));     // 每步慢 500ms，方便看；正式跑改 0
        context = browser.newContext();
        page = context.newPage();
    }

    /**
     * 收尾：先关 context（连带 page），再关 browser，最后关 playwright。
     * 少关一层就留一个后台进程；alwaysRun 保证用例失败时也执行。
     */
    @AfterClass(alwaysRun = true)
    public void tearDownClass() {
        try {
            if (context != null) context.close();
        } catch (Exception ignore) {
            // 浏览器已经崩了也不影响收尾
        }
        try {
            if (browser != null) browser.close();
        } catch (Exception ignore) {
            // 同上
        }
        try {
            if (playwright != null) playwright.close();
        } catch (Exception ignore) {
            // 同上
        }
    }
}
`;

/** 可用的生成目标 */
const TARGETS = [
  {
    key: 'java-restassured',
    label: 'Java · REST Assured',
    desc: '接口测试类骨架（TestNG + REST Assured）',
    lang: 'java',
    ext: '.java',
    tpl: TPL_JAVA_RESTASSURED,
    kind: 'api'
  },
  {
    key: 'python-pytest',
    label: 'Python · pytest + requests',
    desc: '接口测试类骨架（pytest + requests）',
    lang: 'python',
    ext: '.py',
    tpl: TPL_PYTHON_PYTEST,
    kind: 'api'
  },
  {
    key: 'playwright-java',
    label: 'Java · Playwright POM',
    desc: '页面对象类（Page Object Model）',
    lang: 'java',
    ext: '.java',
    tpl: TPL_PLAYWRIGHT_JAVA,
    kind: 'page'
  },
  {
    key: 'playwright-python',
    label: 'Python · Playwright POM',
    desc: '页面对象类（Page Object Model）',
    lang: 'python',
    ext: '.py',
    tpl: TPL_PLAYWRIGHT_PYTHON,
    kind: 'page'
  },
  {
    key: 'pojo-java',
    label: 'Java · POJO（Lombok）',
    desc: '从 JSON 生成实体类',
    lang: 'java',
    ext: '.java',
    tpl: TPL_POJO_JAVA,
    kind: 'model'
  },
  {
    key: 'dataclass-python',
    label: 'Python · Pydantic 模型',
    desc: '从 JSON 生成数据模型',
    lang: 'python',
    ext: '.py',
    tpl: TPL_DATACLASS_PYTHON,
    kind: 'model'
  },
  {
    /**
     * v0.64：自动化测试基类。
     * 不需要任何数据源 —— 它就是「新建一个自动化项目时的第一个文件」。
     */
    key: 'java-playwright-base',
    label: 'Java · Playwright 测试基类',
    desc: '浏览器生命周期 + 配置读取（新建自动化项目先要这个）',
    lang: 'java',
    ext: '.java',
    tpl: TPL_JAVA_PLAYWRIGHT_BASE,
    kind: 'base'
  }
];

/**
 * v0.63：一个测试类里放多个接口。
 *
 * 做法：把「类头」和「单个方法」拆开，多接口时循环渲染方法。
 * **单接口路径一行没动**（仍然用下面那个整份模板），所以老产物的字节完全不变；
 * 这里是额外的一条模板 + 一个「方法片」，两者共用同一份 EJS 变量，
 * 不会出现「单接口改了一处、多接口没跟上」。
 */
const TPL_JAVA_API_HEAD = `package com.test.api;

import io.restassured.RestAssured;
import io.restassured.response.Response;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import static io.restassured.RestAssured.given;
import static org.testng.Assert.*;

/**
 * <%= name %>
 * <%= method %> <%= url %>
 * 模块：<%= module %>
 *
 * 由「测试工作台」生成骨架，业务逻辑和数据请自行补充。
 */
public class <%= className %>ApiTest {

    @BeforeClass
    public void setUp() {
        RestAssured.baseURI = System.getProperty("baseUrl", "http://localhost:8080");
    }

`;

const PART_JAVA_API_METHOD = `    @Test
    public void test<%= methodName.charAt(0).toUpperCase() + methodName.slice(1) %>() {
        Response response = given()
<% if (hasBody && bodyType === 'x-www-form-urlencoded') { -%>
            .contentType("application/x-www-form-urlencoded")
<% } else if (hasBody && bodyType === 'json') { -%>
            .contentType("application/json")
<% } else { -%>
            .contentType("application/json")
<% } -%>
<% if (params.length) { -%>
<% params.forEach(function (p) { -%>
<% if (p.in === 'query') { -%>
            .queryParam("<%= p.name %>", "<%= p.example || 'TODO' %>")
<% } else if (p.in === 'header') { -%>
            .header("<%= p.name %>", "<%= p.example || 'TODO' %>")
<% } -%>
<% }); -%>
<% } -%>
<% if (hasBody && bodyType === 'x-www-form-urlencoded') { -%>
<% bodyParams.forEach(function (p) { -%>
            .formParam("<%= p.key %>", "<%= p.value %>")
<% }); -%>
<% } else if (hasBody && bodyType === 'json') { -%>
            .body("{\\n" +
<% bodyParams.forEach(function (p, i) { -%>
                  "  \\"<%= p.key %>\\": \\"<%= p.value %>\\"<%= i < bodyParams.length - 1 ? ',' : '' %>" + "\\n" +
<% }); -%>
                  "}")
<% } -%>
        .when()
            .<%= method.toLowerCase() %>("<%= url %>")
        .then()
            .statusCode(200)
            .extract().response();

        // TODO: 补充业务断言
        // assertEquals(response.jsonPath().getString("code"), "0");
    }

`;

const TPL_JAVA_RESTASSURED_MULTI = TPL_JAVA_API_HEAD + `<%- methods %>}
`;

const TPL_PYTHON_PYTEST_HEAD = `# -*- coding: utf-8 -*-
"""
<%= name %>
<%= method %> <%= url %>
模块：<%= module %>

由「测试工作台」生成骨架，业务逻辑和数据请自行补充。
"""
import pytest
import requests


BASE_URL = "http://localhost:8080"


class Test<%= className %>:
    """<%= name %>"""

`;

const PART_PYTHON_PYTEST_METHOD = `    def test_<%= methodName.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }) %>(self):
        """<%= method %> <%= url %>"""
        url = BASE_URL + "<%= url %>"
<% if (params.length) { -%>
        params = {
<% params.forEach(function (p) { -%>
<% if (p.in === 'query') { -%>
            "<%= p.name %>": "<%= p.example || 'TODO' %>",
<% } -%>
<% }); -%>
        }
<% } else { -%>
        params = {}
<% } -%>
<% if (params.some(function (p) { return p.in === 'header'; })) { -%>
        headers = {
<% params.forEach(function (p) { -%>
<% if (p.in === 'header') { -%>
            "<%= p.name %>": "<%= p.example || 'TODO' %>",
<% } -%>
<% }); -%>
        }
<% } else { -%>
        headers = {}
<% } -%>
<% if (hasBody && bodyType === 'x-www-form-urlencoded') { -%>
        data = {
<% bodyParams.forEach(function (p) { -%>
            "<%= p.key %>": "<%= p.value %>",
<% }); -%>
        }
        resp = requests.<%= method.toLowerCase() %>(url, params=params, headers=headers, data=data)
<% } else if (hasBody && bodyType === 'json') { -%>
        json_body = {
<% bodyParams.forEach(function (p) { -%>
            "<%= p.key %>": "<%= p.value %>",
<% }); -%>
        }
        resp = requests.<%= method.toLowerCase() %>(url, params=params, headers=headers, json=json_body)
<% } else { -%>
        resp = requests.<%= method.toLowerCase() %>(url, params=params, headers=headers)
<% } -%>

        assert resp.status_code == 200, f"期望 200，实际 {resp.status_code}：{resp.text[:200]}"

        # TODO: 补充业务断言
        # body = resp.json()
        # assert body["code"] == 0

`;

const TPL_PYTHON_PYTEST_MULTI = TPL_PYTHON_PYTEST_HEAD + `<%- methods %>`;

/** JSON 值 → Java 类型 */
function javaTypeOf(v) {
  if (v === null || v === undefined) return 'Object';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Integer' : 'Double';
  if (Array.isArray(v)) return 'java.util.List<Object>';
  if (typeof v === 'object') return 'Object';
  return 'String';
}

/** JSON 值 → Python 类型 */
function pyTypeOf(v) {
  if (v === null || v === undefined) return 'Optional[Any]';
  if (typeof v === 'boolean') return 'Optional[bool]';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Optional[int]' : 'Optional[float]';
  if (Array.isArray(v)) return 'Optional[List[Any]]';
  if (typeof v === 'object') return 'Optional[dict]';
  return 'Optional[str]';
}

/**
 * 从 JSON 生成模型字段。
 * @param {string} jsonText
 */
function fieldsFromJson(jsonText) {
  let obj;
  try {
    obj = JSON.parse(String(jsonText || '{}'));
  } catch (e) {
    return [];
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).map((k) => ({
    key: k,
    name: camel(k),
    javaType: javaTypeOf(obj[k]),
    pyType: pyTypeOf(obj[k]),
    comment: k
  }));
}

/**
 * 生成代码。
 *
 * @param {string} targetKey 生成目标
 * @param {object} input
 *   - api      接口记录（kind=api 用）
 *   - page     页面信息（kind=page 用）：{ name, url, elements: [{name, mode?, selector, desc}] }
 *              mode 缺省 = css；语义化定位由 shared/locatorModes.js 生成 getByXXX 调用
 *   - json     JSON 文本（kind=model 用）
 *   - className 类名（可选，覆盖自动推断）
 * @returns {{ok: boolean, code?: string, filename?: string, message?: string}}
 */
function generate(targetKey, input = {}) {
  const target = TARGETS.find((t) => t.key === targetKey);
  if (!target) return { ok: false, message: '不认识的生成目标：' + targetKey };

  let ctx;

  if (target.kind === 'api') {
    /**
     * v0.63：一次勾多个接口 → 一个测试类里放 N 个 @Test 方法。
     *
     * 为什么这么做：真实接口测试很少「一个接口一个类」——登录、下单、查订单
     * 往往写在同一个业务类里共用 setUp。以前只能一次生成一个，用户还得自己
     * 手工把方法挪到一起。
     *
     * 单接口**不走这里**（仍然用原来那份整份模板），所以老产物的字节一字不变。
     */
    const apiList = Array.isArray(input.apis)
      ? input.apis.filter((a) => a && typeof a === 'object')
      : null;
    if (apiList && apiList.length > 1) {
      const spec =
        target.key === 'java-restassured'
          ? { tpl: TPL_JAVA_RESTASSURED_MULTI, part: PART_JAVA_API_METHOD }
          : target.key === 'python-pytest'
            ? { tpl: TPL_PYTHON_PYTEST_MULTI, part: PART_PYTHON_PYTEST_METHOD }
            : null;
      if (!spec) return { ok: false, message: '这个生成目标不支持一次生成多个接口' };

      const ctxs = apiList.map((a) => buildContext(a));
      // 方法名去重：同一路径不同 method 语种不同时也得是两个方法
      const seen = new Map();
      const methods = ctxs
        .map((c) => {
          const base = c.methodName || 'api';
          const n = (seen.get(base) || 0) + 1;
          seen.set(base, n);
          const ctx = n > 1 ? Object.assign({}, c, { methodName: base + n }) : c;
          return ejs.render(spec.part, ctx, { escape: (v) => v });
        })
        .join('\n');

      // 类名优先用户填的；否则用模块名（多个接口通常属于同一个模块），再退回第一个接口。
      // 模块名可能是中文（「用户」），pascal 之后只剩空串 —— 那种情况必须退回接口名，
      // 否则会生成 `public class 户ApiTest`（非法标识符）。
      const moduleClass = ctxs[0].module ? pascal(ctxs[0].module) : '';
      const headCtx = Object.assign({}, ctxs[0], {
        className:
          input.className || (/^[A-Za-z][\w$]*$/.test(moduleClass) ? moduleClass : ctxs[0].className),
        methods
      });

      let code;
      try {
        code = ejs.render(spec.tpl, headCtx, { rmWhitespace: false, escape: (v) => v });
      } catch (e) {
        return { ok: false, message: '模板渲染失败：' + (e && e.message) };
      }
      return {
        ok: true,
        code,
        filename: `${headCtx.className || 'Api'}ApiTest${target.ext}`,
        target,
        count: apiList.length
      };
    }

    if (!input.api) return { ok: false, message: '缺少接口数据' };
    ctx = buildContext(input.api);
    if (input.className) ctx.className = input.className;
  } else if (target.kind === 'page') {
    const page = input.page || {};
    /**
     * 元素的定位代码在这里就生成好（模板只贴 <%= el.locator %>）。
     *
     * 好处：Java / Python 两套模板共用 shared/locatorModes.js 的同一份逻辑，
     * 前端表格里的实时预览也是这个函数 —— 预览和真生成不会说谎。
     */
    const elements = (page.elements || []).map((el) => {
      const mode = normalizeLocatorMode(el && el.mode);
      const selector = String((el && el.selector) || '');
      return {
        name: camel((el && el.name) || 'element'),
        mode,
        selector,
        desc: String((el && el.desc) || ''),
        locator: previewLocatorCode(mode, selector, target.lang)
      };
    });
    ctx = {
      className: pageBaseName(page, input.className),
      url: String(page.url || '/'),
      elements,
      // 只有真的用到 role 才 import AriaRole，避免生成一堆没用的 import
      hasRole: elements.some((el) => el.mode === 'role')
    };
  } else if (target.kind === 'model') {
    /**
     * 两种输入：
     *   input.json  → 从 JSON 响应体推断
     *   input.sql   → 从 CREATE TABLE 建表语句解析（规划要求「DB → POJO」，
     *                 这里不直连数据库，改成粘贴建表语句）
     */
    let fields;

    if (input.sql && String(input.sql).trim()) {
      const parsed = parseCreateTable(input.sql);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      fields = parsed.columns.map((c) => ({
        key: c.name,
        name: c.camel,
        javaType: c.javaType,
        pyType: c.pyType,
        // 字段注释写进 @Schema / comment
        comment: c.comment || c.name
      }));
      // 表名推断类名：t_order → Order，user_info → UserInfo
      if (!input.className) {
        const t = parsed.table || '';
        const stripped = t.replace(/^t_/i, '');
        if (stripped) input.className = pascal(stripped);
      }
    } else {
      fields = fieldsFromJson(input.json);
      if (!fields.length) return { ok: false, message: 'JSON 里没有可生成的字段（或粘贴建表语句）' };
    }

    ctx = {
      className: input.className || 'DataModel',
      fields
    };
  } else if (target.kind === 'base') {
    // v0.64：测试基类不需要数据源，只有类名（默认 BaseTest）
    ctx = { className: input.className || 'BaseTest' };
  } else {
    return { ok: false, message: '未知的生成类型' };
  }

  let code;
  try {
    // 代码生成不需要 HTML 转义（否则 List<Object> 会变成 List&lt;Object&gt;）
    code = ejs.render(target.tpl, ctx, { rmWhitespace: false, escape: (v) => v });
  } catch (e) {
    return { ok: false, message: '模板渲染失败：' + (e && e.message) };
  }

  // 文件名
  //
  // 页面对象必须带上页面名，否则每个页面都叫 `Page.java`；
  // Java 用 PascalCase（LoginPage.java），Python 用 snake_case（login_page.py），
  // 这样文件名和类名/模块名都对得上，一眼能看出是哪个页面。
  let filename;
  if (target.kind === 'api') {
    filename = `${ctx.className || 'Api'}ApiTest${target.ext}`;
  } else if (target.kind === 'page') {
    const base = String(ctx.className || 'My').replace(/Page$/, '') || 'My';
    filename = target.lang === 'python' ? `${snake(base)}_page${target.ext}` : `${base}Page${target.ext}`;
  } else {
    filename = `${ctx.className || 'DataModel'}${target.ext}`;
  }

  return { ok: true, code, filename, target };
}

/** 生成目标列表（给前端下拉） */
function listTargets() {
  return TARGETS.map((t) => ({
    key: t.key,
    label: t.label,
    desc: t.desc,
    lang: t.lang,
    ext: t.ext,
    kind: t.kind
  }));
}

module.exports = {
  generate,
  listTargets,
  buildContext,
  fieldsFromJson,
  classNameFromUrl,
  methodNameFromApi,
  pageBaseName,
  snake,
  camel,
  pascal,
  // 定位方式相关（统一从 shared/locatorModes.js 来，前端预览用的也是同一份）
  LOCATOR_MODES,
  normalizeLocatorMode,
  splitRoleSelector,
  previewLocatorCode
};
