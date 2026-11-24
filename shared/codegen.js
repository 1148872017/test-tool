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
                  "  \\"<%= p.key %>\\": \\"<%= p.value %>\\"" + (i < bodyParams.length - 1 ? "," : "") + "\\n" +
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
    /** <%= el.desc || el.name %> */
    public Locator <%= el.name %>() {
        return page.locator("<%= el.selector %>");
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
        """<%= el.desc || el.name %>"""
        return self.page.locator("<%= el.selector %>")

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
 * 由「测试工作台」从 JSON 生成。
 */
@Data
public class <%= className %> {
<% fields.forEach(function (f) { -%>

    /** <%= f.key %> */
    private <%- f.javaType %> <%= f.name %>;
<% }); -%>
}
`;

/** Python Pydantic 模型 */
const TPL_DATACLASS_PYTHON = `# -*- coding: utf-8 -*-
"""
<%= className %>

由「测试工作台」从 JSON 生成。
"""
from typing import Any, List, Optional
from pydantic import BaseModel, Field


class <%= className %>(BaseModel):
<% fields.forEach(function (f) { -%>
    <%= f.name %>: <%= f.pyType %> = Field(default=None, description="<%= f.key %>")
<% }); -%>
`;

/* ============================================================
 * 生成入口
 * ============================================================ */

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
  }
];

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
    pyType: pyTypeOf(obj[k])
  }));
}

/**
 * 生成代码。
 *
 * @param {string} targetKey 生成目标
 * @param {object} input
 *   - api      接口记录（kind=api 用）
 *   - page     页面信息（kind=page 用）：{ name, url, elements: [{name, selector, desc}] }
 *   - json     JSON 文本（kind=model 用）
 *   - className 类名（可选，覆盖自动推断）
 * @returns {{ok: boolean, code?: string, filename?: string, message?: string}}
 */
function generate(targetKey, input = {}) {
  const target = TARGETS.find((t) => t.key === targetKey);
  if (!target) return { ok: false, message: '不认识的生成目标：' + targetKey };

  let ctx;

  if (target.kind === 'api') {
    if (!input.api) return { ok: false, message: '缺少接口数据' };
    ctx = buildContext(input.api);
    if (input.className) ctx.className = input.className;
  } else if (target.kind === 'page') {
    const page = input.page || {};
    ctx = {
      className: input.className || pascal(page.name || 'Page'),
      url: String(page.url || '/'),
      elements: (page.elements || []).map((el) => ({
        name: camel(el.name || 'element'),
        selector: String(el.selector || ''),
        desc: String(el.desc || '')
      }))
    };
  } else if (target.kind === 'model') {
    const fields = fieldsFromJson(input.json);
    if (!fields.length) return { ok: false, message: 'JSON 里没有可生成的字段' };
    ctx = {
      className: input.className || 'DataModel',
      fields
    };
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
  let filename;
  if (target.kind === 'api') {
    filename = `${ctx.className}ApiTest${target.ext}`;
  } else if (target.kind === 'page') {
    filename = `${ctx.className}Page${target.ext}`;
  } else {
    filename = `${ctx.className}${target.ext}`;
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
  camel,
  pascal
};
