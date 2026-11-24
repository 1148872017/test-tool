# 测试工作台

> 一个**本地运行、数据不出机器**的测试工作台。
> 把测试日常里那些「散落在各处、每次都要重新找」的东西收进一个地方：账号密码、接口记录、SQL 片段、用例索引、压测脚本、知识库、笔记，再加上代码生成 / 调试 / 体检 / 报告分析。

**适合谁用**：手工测试、接口测试、自动化测试、性能测试的同学。
**不适合谁**：需要多人协作、权限管理、云端同步的团队（这个工具是单人本地用的）。

---

## 目录

- [5 分钟上手](#5-分钟上手)
- [功能总览](#功能总览)
- [核心功能详解](#核心功能详解)
  - [1. 资产库：网站 / 账号 / 接口 / SQL / 执行记录](#1-资产库网站--账号--接口--sql--执行记录)
  - [2. 只读索引：用例 / 压测脚本 / 知识库 / 笔记](#2-只读索引用例--压测脚本--知识库--笔记)
  - [3. 自动化工具链：生成 → 调试 → 体检 → 报告](#3-自动化工具链生成--调试--体检--报告)
  - [4. 辅助工具：测试数据 / JSON / 工具箱](#4-辅助工具测试数据--json--工具箱)
- [数据放哪 / 怎么备份](#数据放哪--怎么备份)
- [皮肤设置](#皮肤设置)
- [环境要求](#环境要求)
- [常见问题](#常见问题)
- [开发](#开发)

---

## 5 分钟上手

### 第一步：装

下载 `test-tool-Setup-x.y.z-x64.exe`，双击安装。

> 安装需要管理员权限（装到 `Program Files`），会弹 UAC 确认框。

### 第二步：配目录

打开后点左下角 **设置 → 目录配置**，把目录指到你自己的文件夹：

> 设置页已按 6 类整合：**目录配置 / 开发环境 / 外观 / 行为与安全 / 数据与备份 / 关于**。
> 顶部有快速导航，点一下直接跳过去。

| 设置项 | 放什么 | 例子 |
|---|---|---|
| **测试用例** | markdown 用例文件 | `D:\你的工作区\test_cases` |
| **压测（JMeter）** | `.jmx` 脚本 + JMeter 安装路径 + 压测报告目录 + **Allure 报告目录** | `D:\你的工作区\jmx` |
| **知识库** | 业务规则 markdown | `D:\你的工作区\知识库` |
| **测试笔记** | Typora 导出的笔记 | `D:\你的工作区\notes` |

> 不配也能用——只是「用例 / 压测 / 知识库 / 笔记」四个页面会是空的。

### 第三步：录第一条数据

点 **网站管理 → 新增**，填个测试环境地址 + 账号密码。

然后点列表里的 🌐 图标——**浏览器打开 + 密码自动复制到剪贴板**，切过去 Ctrl+V 就能登录。

---

## 功能总览

侧边栏按「测试工作流」分成四组：

```
资产      网站管理 / SQL 片段 / 接口记录 / 测试执行 / 页面元素  ← 存什么
索引      测试用例 / 压测脚本 / 知识库 / 测试笔记       ← 读什么（只读，不改你的文件）
自动化    代码生成 / 代码调试 / 代码体检 / 脚本生成 / 报告分析  ← 写代码 / 跑 / 查
辅助      测试数据 / JSON 工具 / 工具箱                ← 日常小工具
```

| 功能 | 一句话说明 |
|---|---|
| **网站管理** | 一个站点存多个账号，一键打开 + 复制密码 |
| **页面元素** | **表格化维护** Playwright 定位器，一键生成 Page Object |
| **SQL 片段** | 存常用 SQL，变量填完复制 |
| **接口记录** | 从 Apifox 同步 / 粘贴 cURL 导入，一键复制成 cURL |
| **测试执行** | 接口测试 / 压测跑一次记一笔，指标自动汇总成表 |
| **测试用例** | 只读索引你的 markdown 用例 |
| **压测脚本** | 只读解析 jmx，看线程组 / 采样器 / 断言 |
| **知识库** | 只读索引业务规则文档 |
| **测试笔记** | 只读索引 markdown 笔记，支持从桌面导入 |
| **代码生成** | 接口 / JSON / 页面元素 → Java/Python 代码骨架 |
| **代码调试** | 在平台里跑 Groovy / Python / pytest / Maven，看输出 |
| **代码体检** | 接口**和页面**覆盖矩阵 + 硬编码 / 脆弱定位 / 断言质量扫描 |
| **脚本生成** | JMeter `.jmx` 生成 + MySQL/SQLite 快照清理 SQL |
| **报告分析** | Allure 失败聚类 + Flaky 追踪 |
| **测试数据** | 手机号 / 身份证 / 银行卡等批量生成，导出 CSV/JSON |
| **JSON 工具** | 格式化 / 压缩 / 转义 / 校验 |
| **工具箱** | Base64 / 时间戳 / 哈希 / UUID |

---

## 核心功能详解

### 1. 资产库：网站 / 账号 / 接口 / SQL / 执行记录

#### 网站管理：一个站点多个账号

**痛点**：测试环境有 3 个账号（管理员 / 商家 / 普通用户），以前要记在 Excel 里，每次翻。

**现在**：一个站点下挂多个账号，每个账号带角色标签。

```
┌─ 网站管理 ─────────────────────────────────────────┐
│ 名称              环境   账号列表          更新时间 │
│ 资产管理系统-后台  测试   管理员 admin +2   11-24   │
│ 退款服务-运营端    预发   测试账号 qa_refund 11-24  │
└─────────────────────────────────────────────────────┘
```

**用法**：

1. 点 **新增** → 填名称、地址、环境
2. 点 **添加账号** → 填用途（管理员/商家）、账号、密码、角色
3. 勾一个「设为默认」——一键启动时用这个
4. 保存

**一键启动**：点列表里的 🌐 图标

| 情况 | 行为 |
|---|---|
| 有默认账号 | 打开 URL + 复制默认账号密码 |
| 只有一个账号 | 自动用那个 |
| 多个账号没设默认 | **弹窗让你选** |
| 没账号 | 只打开 URL |

> **密码加密**：用 Windows DPAPI（`safeStorage`）加密，数据库里是 `enc:` 开头的密文。
> **搜索搜不到密码**——搜索范围排除了密码字段。

#### 接口记录：从 Apifox 同步 / 粘贴 cURL

**三种录入方式**：

| 方式 | 操作 |
|---|---|
| **从 Apifox 同步** | 点「新增 ▼」→「从 Apifox 同步」→ 选导出的 `openapi.json` |
| **粘贴 cURL** | 点「新增 ▼」→「粘贴 cURL 导入」→ 粘 Chrome/Postman/Apifox 复制的命令 |
| **手动新增** | 点「新增 ▼」→「手动新增」 |

**粘贴 cURL 的效果**：

```
粘贴：
curl 'https://api.example.com/v1/user' \
  -H 'Content-Type: application/json' \
  -d '{"id":1,"name":"test"}'

解析结果：
  方法    POST
  URL     https://api.example.com/v1/user
  名称    user
  请求头  1 个
  请求体  json 24 字符
```

点「导入并填写表单」→ 表单已填好 → 补上模块/备注 → 保存。

**详情页的表格视图**：

```
┌─ 参数 ────────────────────────────────────────┐
│ 参数名      位置    类型     说明              │
│ status *    query   string   Status values... │
└────────────────────────────────────────────────┘

┌─ Body [x-www-form-urlencoded] ────────────────┐
│ 参数名    参数值        类型                   │
│ name      Hello Kitty   string                 │
│ status    sold          string                 │
└────────────────────────────────────────────────┘
```

> `headers` 和 `body` 支持「表格 / JSON」切换，超 5 行自动折叠。

#### SQL 片段：变量填完复制

**痛点**：每次查数据都要改 `where id = xxx`，改完复制到客户端。

**现在**：存模板，变量填完一键复制。

```
SQL：
select * from t_order where order_no = {{orderNo}} and create_time > {{today}}

变量说明（表格）：
┌──────────────┬──────────┬──────────────┐
│ 变量名        │ 值(可选) │ 说明          │
│ orderNo      │          │ 订单号        │
│ today        │          │ 今天          │
└──────────────┴──────────┴──────────────┘
```

点复制 → 弹窗填值 → **拼接预览里变量标色**（未填红 / 已填绿）→ 复制。

#### 测试执行：跑一次记一笔

**接口测试**和**压测**都记在这里。

**压测指标自动汇总成表**：

```
┌─ 并发 ─ 时长 ─ TPS ── P90 ─ P95 ─ P99 ─ 错误率 ─ 样本数 ┐
│  2   │  2s  │ 29.41 │  4  │  4  │ 87  │   0%   │  50   │
└──────────────────────────────────────────────────────────┘
```

**导入压测报告**：点「导入压测报告」→ 选 `result.jtl` → 自动填好并发/TPS/分位/错误率/样本数。

---

### 2. 只读索引：用例 / 压测脚本 / 知识库 / 笔记

**这四个功能都是「只读」——平台只读你的文件，绝不修改。**

#### 测试用例

索引 markdown 用例文件，支持两种格式：

**标准格式**：
```markdown
#### [高] [功能] 优惠券核销成功
前置条件：...
步骤：...
预期：...
```

**极简链路格式**：
```markdown
## C1 下单-支付-发货 [冒烟]
```

#### 压测脚本

解析 `.jmx` 文件，展示：

- 线程组（线程数 / Ramp / 持续 / 循环）
- 采样器（方法 / 路径）
- 断言、CSV 数据源、HTTP 头
- **健康检查**（比如「CSV 文件不存在」会标红）

#### 知识库 / 测试笔记

索引 markdown，支持：

- 目录树 + 搜索
- 默认只显示第一节，可「阅读全文」
- 笔记支持**从桌面导入**（移动语义，导入后原文件消失）

---

### 3. 自动化工具链：生成 → 调试 → 体检 → 报告

这是最近加的一组功能，覆盖「写代码前 / 写代码时 / 写完后 / 跑完后」。

#### 代码生成：接口 → 代码骨架

**痛点**：写接口测试要建类、写方法签名、抄参数，一个接口 5 分钟。

**现在**：选接口 → 生成 → 复制到 IDEA。

**6 种生成目标**：

| 目标 | 生成什么 |
|---|---|
| **Java · REST Assured** | 接口测试类（TestNG + REST Assured） |
| **Python · pytest** | 接口测试类（pytest + requests） |
| **Java · Playwright POM** | 页面对象类 |
| **Python · Playwright POM** | 页面对象类 |
| **Java · POJO** | 从 JSON **或建表语句**生成实体类（Lombok） |
| **Python · Pydantic** | 从 JSON **或建表语句**生成数据模型 |

**效果示例**（Java REST Assured）：

```java
public class PetApiTest {
    @Test
    public void testCreatePet() {
        Response response = given()
            .contentType("application/x-www-form-urlencoded")
            .formParam("name", "Hello Kitty")
            .formParam("status", "sold")
        .when()
            .post("/pet")
        .then()
            .statusCode(200)
            .extract().response();

        // TODO: 补充业务断言
    }
}
```

**页面元素怎么维护**：

侧边栏 **页面元素** → 新增 → 表格里逐行填：

| 名称 | 定位器 | 说明 |
|---|---|---|
| `usernameInput` | `#username` | 用户名输入框 |
| `submitBtn` | `[data-testid=submit]` | 登录按钮 |

然后到「代码生成」选 **Playwright POM** → 从已有页面载入 → 一键生成 Page Object。

**用法**：

1. 侧边栏 **代码生成**
2. 选生成目标（如「Java · REST Assured」）
3. 左侧选接口（或粘 JSON / 填页面元素）
4. 点 **生成预览** → 右侧看代码
5. 点 **保存到文件** → 选目录 → 保存

**接口从哪来？两种数据源**：

| 数据源 | 适用 | 说明 |
|---|---|---|
| **接口记录** | 已经同步过的接口 | 从数据库选，一次一个 |
| **OpenAPI 文件** | 手上只有一份 `openapi.json` / `yaml` | **直接读文件，不写数据库** |

> **OpenAPI 文件模式的好处**：不污染「接口记录」表。
> 别人给你一份接口文档，你只想生成几个测试类，用这个模式最干净。
>
> 支持 JSON 和 YAML；Swagger 2.0 会提示「请重新导出为 OpenAPI 3」。

#### 断言模板库（复制粘贴专用）

侧边栏 **代码生成** 页右上角有个「脚本模板」入口（或从「脚本模板」抽屉进入），按分类浏览、填变量、一键复制。

| 分类 | 内容 |
|---|---|
| **接口断言** | RestAssured：状态码 / JSON 字段 / JSON Schema；pytest：JSON 字段 / JSON Schema |
| **UI 断言** | Playwright：元素可见性 / 文本包含 / 属性值 |
| 提取 | JSON 提取器、正则提取、边界提取器 |
| 断言 | JMeter 的 JSR223 断言（状态码/关键字/JSON/响应时间） |
| 生成 / 加密 / 流程 | UUID、时间戳、AES、If 控制器等 |

> 一共 18 个模板。每个都有「什么时候用」「怎么加」「有什么坑」三段说明。


**从建表语句生成**（不连数据库）：

选「Java · POJO」→ 数据源切到 **CREATE TABLE** → 粘贴建表语句：

```sql
CREATE TABLE `t_order` (
  `id` bigint(20) NOT NULL COMMENT '主键',
  `order_no` varchar(64) NOT NULL COMMENT '订单号',
  `amount` decimal(10,2) COMMENT '金额',
  `created_at` datetime COMMENT '创建时间'
);
```

生成：

```java
public class Order {
    /** 主键 */
    private Long id;
    /** 订单号 */
    private String orderNo;
    /** 金额 */
    private java.math.BigDecimal amount;
    /** 创建时间 */
    private java.time.LocalDateTime createdAt;
}
```

> 类型自动映射（bigint→Long、decimal→BigDecimal、datetime→LocalDateTime、bit→Boolean…），
> 类名按表名推断（t_order → Order），字段注释从 `COMMENT` 提取。
> MySQL 和 SQLite 的建表语句都认。
#### 代码调试：在平台里跑代码

**痛点**：调 JMeter 的 Groovy 脚本要「改 jmx → 开 JMeter → 跑 → 看日志 → 关 JMeter」，一轮 2 分钟。

**现在**：改 → Ctrl+Enter → 2 秒看输出。

**4 种运行器**：

| 运行器 | 跑什么 | 等价命令 |
|---|---|---|
| **Groovy（JMeter）** | JMeter 的 JSR223 脚本 | `java -cp {jmeter}/lib/* groovy.ui.GroovyMain x.groovy` |
| **Python** | 独立 Python 脚本 | `python x.py` |
| **Python（pytest）** | pytest 用例 | `python -m pytest x.py -v` |
| **Java（Maven）** | Maven 项目的测试类 | `mvn test -Dtest=Xxx` |

**用法**：

1. 侧边栏 **代码调试**
2. 选运行器
3. 写代码（或 Maven 模式选项目 + 测试类）
4. 点 **运行**（或 Ctrl+Enter）
5. 下方看输出

**Maven 模式**：

```
项目 [OTA-automation ▾]  测试类 [LoginTest ▾]  [▶ 运行]
```

等价于 `mvn test -Dtest=LoginTest`。

> **自动选 JDK**：从项目 `pom.xml` 读 `<java.version>`，在已装 JDK 里找匹配的。
> 比如项目要求 17，你装了 8 和 17，会自动用 17。

#### 代码体检：覆盖矩阵 + 硬编码扫描

**两个功能**：

**① 覆盖矩阵**：清单 vs 代码里的路径（**支持接口和页面两种**）

| 类型 | 左边（清单） | 右边（代码） |
|---|---|---|
| **接口覆盖** | 「接口记录」集合（从 Apifox 同步） | `.get("/api/xxx")` / `requests.post(...)` |
| **页面覆盖** | 「页面元素」集合（你维护的页面） | `page.goto("/login")` / `page.navigate(...)` |

下面以接口为例：

```
┌─ 覆盖情况 ─────────────────────────────────────┐
│  5      3        2                             │
│ 接口总数 已覆盖  未覆盖    ████████░░ 60%      │
└─────────────────────────────────────────────────┘

未覆盖（2）
  DELETE  /api/v1/user/{id}     删除用户
  GET     /api/v1/report/export 导出报表

已覆盖（3）
  POST    /api/login            登录        2 处
  GET     /api/v1/user          查用户      1 处
  POST    /api/v1/refund        退款        3 处
```

**② 硬编码扫描**：找出代码里的问题

| 严重程度 | 检查什么 |
|---|---|
| **高** | 硬编码密码、硬编码 Token/密钥 |
| **中** | 硬编码 URL、`Thread.sleep()`、**断言过弱** |
| **低** | 绝对 XPath、深层 CSS 选择器 |

**③ 依赖冲突检查**：

扫 `pom.xml` 和 `requirements.txt`，查三类问题：

| 问题 | 例子 |
|---|---|
| 同一声明出现多次 | `org.junit:junit-jupiter` 在同一个 pom 里出现 2 次 |
| 同一依赖多个版本 | `→ 5.9.0 / 5.10.0` |
| 版本占位符没定义 | `${undefined.prop}` 但 properties 里没这个键 |

> **不做传递依赖分析**——那要解析完整依赖树（含 parent、dependencyManagement、profiles）还得联网查
> Maven Central。IDE 的 `mvn dependency:tree` 更准，这里只查「肉眼能看出的冲突」。

**断言质量检查**：

只校验了状态码、没校验业务 Body → 报「断言过弱」。

```java
// ❌ 会被报：接口返回 200 但业务失败时抓不到
.then().statusCode(200);

// ✅ 不报：有 Body 校验
.then().statusCode(200).body("code", equalTo(0));
```

```python
# ❌ 会被报
assert resp.status_code == 200

# ✅ 不报
assert resp.status_code == 200
assert resp.json()["code"] == 0
```

> 实现是**启发式**（正则 + 缩进/大括号切块），不是 AST。Python 按缩进切块，Java 按大括号。

**效果示例**：

```
[高] 硬编码密码  LoginApiTest.java:38
     correctPassword = "admin123";
     密码应放配置/环境变量，不要写死在代码里

[中] 硬编码 sleep  BaseApiTest.java:64
     Thread.sleep(1000L * attempt);
     sleep 会让测试变慢且不稳定，应改用显式等待
```

#### 报告分析：失败聚类 + Flaky 追踪

**痛点**：跑完 50 个用例挂了 20 个，满屏报错看不出规律。

**现在**：自动聚类，一眼看出「都是同一个根因」。

**失败聚类效果**：

```
┌─ 汇总 ─────────────────────────────────────────┐
│  12      0       0      12      37.9s    0%    │
│ 总数   通过    失败    异常    总耗时  通过率  │
└─────────────────────────────────────────────────┘

失败聚类 (1)
┌─────────────────────────────────────────────────┐
│ [12 个用例] Cannot invoke "<STR>" because "<STR>" is null │
│ Cannot invoke "Response.getStatusCode()" because "response" is null │
│ ▸ 展开 12 个用例                                │
└─────────────────────────────────────────────────┘
```

**原理**：把错误信息里的数字 / UUID / 路径 / 引号内容替换成占位符，相同模式归一组。

```
Timeout 3000ms waiting for #btn
Timeout 5000ms waiting for #btn
  ↓ 归一化
Timeout <N>ms waiting for #btn     ← 同一组
```

**Flaky 追踪**：选 2 次以上执行记录，比对同一用例的通过/失败。

```
正确用户名和密码登录成功  ● ● ○ ●  [不稳定]
                         过 过 挂 过
```

**用法**：

1. 先去 **设置 → 压测** 配好「Allure 报告目录」（只需配一次）
2. 侧边栏 **报告分析** → 点 **扫描**（自动扫那个目录）或 **选目录**（临时换一个）
3. 看失败聚类 / 用例列表
4. Flaky：切到「Flaky」→ 选 2 个以上目录 → 点「比对」

#### 脚本生成：JMeter 脚本 + 数据库快照/清理

**痛点**：写 jmx 要在 JMeter GUI 里点半天；测试前备份、跑完清数据，每次手工敲 SQL。

**现在**：接口记录直接生成 jmx；常见数据操作生成 SQL。

##### ① JMeter 脚本生成

**用法**：

1. 侧边栏 **脚本生成** → 默认在「JMeter 脚本」Tab
2. 选一个或多个接口（按选择顺序执行）
3. 配线程组：线程数 / Ramp-Up / 循环次数 / 持续时长
4. 点 **生成预览** → 右侧看 XML
5. 点 **保存为 .jmx** → 选目录 → 直接拿去 JMeter GUI 打开跑

**生成的内容**：

| 组件 | 说明 |
|---|---|
| **测试计划** | 预置 `host` / `port` 变量，命令行可 `-Jhost=xxx` 覆盖 |
| **线程组** | 线程数 / Ramp-Up / 循环 或 持续时长（二选一） |
| **HTTP 采样器** | 按接口的 method / path / headers / body 生成 |
| **HTTP 信息头管理器** | 从接口记录的 Headers 提取 |
| **响应断言** | 状态码 200 |
| **持续时间断言** | RT 上限（可配，0 = 不生成） |

**CSV 参数化**（勾「启用 CSV 参数化」）：

| 配置 | 说明 |
|---|---|
| CSV 文件 | 相对 jmx 所在目录，如 `data.csv` |
| 变量名 | 逗号分隔，如 `userName,mobile` |
| 读完循环 | 数据用完后从头再来（压测常用） |
| 读完停止线程 | 数据用完就停（想跑完所有数据时用） |
| 忽略首行 | CSV 有表头时勾上 |

生成后在 JMeter 里用 `${userName}` 引用，和「测试数据」页导出的多字段 CSV 正好配套。

> **JMeter 版本自动对齐**：生成时会从「设置 → 压测」里配的 JMeter 路径**读出版本号**写进 jmx。
> 这样用你自己的 JMeter 打开时**不会弹「版本不一致」**。
> 生成后在「JMeter 版本」那行能看到当前用的版本。

**效果**：

```xml
<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="线程组-压测计划">
  <stringProp name="ThreadGroup.num_threads">20</stringProp>
  <stringProp name="ThreadGroup.ramp_time">3</stringProp>
  <elementProp name="ThreadGroup.main_controller" elementType="LoopController">
    <stringProp name="LoopController.loops">10</stringProp>
  </elementProp>
</ThreadGroup>
```

**关键：生成的 jmx 能被平台自己的解析器解析**——保存后到「压测脚本」页面能看到它，健康检查也是绿的。

> **域名/端口用 JMeter 属性占位**：`${__P(host,127.0.0.1)}`。
> 同一份 jmx 换环境不用改文件，命令行 `jmeter -Jhost=test2.com` 就行。

##### ② 数据库快照 / 清理 / 还原（MySQL / SQLite）

**核心原则：只生成 SQL，不连数据库、不执行、不存密码。**

**支持 MySQL 和 SQLite，可切换。**

复制到你的数据库客户端（Navicat / DBeaver / DB Browser / 命令行）执行。

**两种数据库的差异（平台会自动处理）**：

| 操作 | MySQL | SQLite |
|---|---|---|
| 建备份表 | `CREATE TABLE bak LIKE src`（含索引） | `CREATE TABLE bak AS SELECT * FROM src`（只数据） |
| 清空表 | `TRUNCATE TABLE x` | 没有 TRUNCATE → `DELETE FROM x` |
| 重置自增 | `ALTER TABLE x AUTO_INCREMENT = 1` | `DELETE FROM sqlite_sequence WHERE name='x'` |
| 外键开关 | `SET FOREIGN_KEY_CHECKS = 0` | `PRAGMA foreign_keys = OFF` |
| 标识符 | ``name`` | `"name"` |
| 库切换 | `USE db` | 没有（一个文件一个库） |
| 空间回收 | 不需要 | `VACUUM`（DELETE 后文件不会自动变小） |
| REPLACE | `REPLACE INTO` | `INSERT OR REPLACE` |

> **SQLite 的「库名」**：只用于注释（比如 `test.db`），生成的 SQL 里不会有 `USE`。

**三种操作**：

| 操作 | 生成什么 | 典型用法 |
|---|---|---|
| **快照** | `CREATE TABLE bak_xxx LIKE xxx` + `INSERT ... SELECT` | 压测前备份数据 |
| **清理** | `DELETE`（带条件）/ `TRUNCATE` / `DROP` | 跑完清脏数据 |
| **还原** | `TRUNCATE` + `INSERT ... SELECT` 从备份表灌回 | 测完恢复现场 |

**快照的两种方式**：

| 方式 | 生成 | 适用 |
|---|---|---|
| **建备份表** | `CREATE TABLE bak_t_order_20261124_113000 LIKE t_order` | 小表，快速回滚 |
| **mysqldump 命令** | `mysqldump -u root -p ... > xxx.sql` | 大表，导出文件 |

**安全设计**：

- **TRUNCATE / DROP 默认被拒**——必须勾「我确认这是测试库」才生成
- **DELETE 没条件等同于清空**——也要确认
- **表名/库名校验**——只允许字母/数字/下划线，防 SQL 注入
- 生成的 SQL 顶部有 ⚠️ 警告注释

**效果**（清理）：

```sql
-- MySQL 测试数据清理
-- 生成时间：2026/11/24 11:30:00
-- ⚠️ 执行前请确认：这是测试库，不是生产库！

USE `test_db`;

SET FOREIGN_KEY_CHECKS = 0;

-- 清理：t_order WHERE create_time < '2026-01-01'
DELETE FROM `t_order` WHERE create_time < '2026-01-01';

SET FOREIGN_KEY_CHECKS = 1;
```

---

### 4. 辅助工具：测试数据 / JSON / 工具箱

#### 测试数据

批量生成常用测试数据，**全部本地计算，不上传任何内容**。

| 类型 | 例子 |
|---|---|
| 中文姓名 | 张伟、李娜 |
| 手机号 | 13812345678 |
| 邮箱 | abc123@test.com |
| 身份证号 | 110101199001011234 |
| 银行卡号 | 6222021234567890123 |
| 地址 | 北京市朝阳区xx路xx号 |
| 公司名 | xx科技有限公司 |
| UUID | 550e8400-e29b-41d4-a716-446655440000 |
| 日期 | 2026-11-24（**可指定范围**：从 2020-01-01 到 2026-12-31 之间随机） |
| 金额 | 1234.56 |
| 订单号 | ORD20261124123456789 |

**两种模式**：

| 模式 | 生成什么 | 用在 |
|---|---|---|
| **单类型** | 每次一种（如 1000 个手机号） | 单字段参数化 |
| **多字段组合** | 一行含多个字段（姓名+手机+邮箱+身份证） | **CSV Data Set / parametrize 用** |

**多字段组合怎么用**：

1. 切到「多字段组合」
2. 填字段表：字段名 + 类型 + （可选）固定值
3. 填数量 → 点「生成」
4. 预览是表格（行=记录，列=字段）
5. 点「导出 CSV」→ 带表头的多列文件

```csv
userName,mobile,email,idCard
杨辉,13382202445,qa8769@corp.cn,420106200104133798
李娜,13987654321,test1234@test.com,110101199002022345
```

**直接喂给测试脚本**：

```python
# pytest
import csv
with open('data.csv') as f:
    for row in csv.DictReader(f):
        assert login(row['mobile'], row['idCard'])['code'] == 0
```

> 「复制（TSV）」是**制表符分隔**，可以直接粘进 Excel 自动分列。
**导出**：生成后点「导出 CSV」或「导出 JSON」，最多 10 万条。

> CSV 带 BOM，Excel 打开中文不乱码。

#### JSON 工具

格式化 / 压缩 / 转义 / 校验。

#### 工具箱

Base64 编解码、时间戳转换、哈希（MD5/SHA1/SHA256/SHA512）、UUID 生成。

---

## 与「平台整体迭代规划」的对照

如果你手上有那份六模块的规划，这里说明哪些做了、哪些没做：

| 规划模块 | 状态 | 说明 |
|---|---|---|
| **一. 代码骨架生成** | ✅ **全做了** | ① OpenAPI（JSON/YAML）→ Java/Python 骨架 ② 页面元素 → Playwright POM（**元素存库**）③ JSON → POJO/Pydantic ④ 断言模板库（脚本模板） |
| **二. 压测辅助 + 造数** | ✅ **全做了** | ① jmx 生成（线程组/断言/RT 上限/**CSV 参数化**）② 造数（单类型 + **多字段组合** + **指定时间范围**，导出 CSV/JSON）③ MySQL **和 SQLite** 快照/清理/还原 |
| **三. 代码质量体检** | ✅ **全做了** | ① UI 反模式（sleep/绝对XPath/深层CSS）② 硬编码（URL/Token/密码）+ **断言质量** ③ **依赖冲突检查** |
| **四. 覆盖矩阵** | ⚠️ **部分** | ① 接口覆盖矩阵 ✅ ② **页面覆盖矩阵** ✅ ③ 用例映射：已有「用例↔接口关联」，没做 Excel 导入 |
| **五. 报告聚合** | ✅ **全做了** | ① Allure 解析 + 失败聚类 + Flaky 追踪 ② jtl 分析（TPS/分位/**按接口错误率排序**） |
| **六. Git 变更影响面** | ❌ **不做** | 收益低（IDE 的 Find Usages 更准），成本高（要解析 import 关系） |

**4 项明确不做的原因**：

| 不做 | 原因 |
|---|---|
| Excel 用例映射 | 已有「用例 ↔ 接口关联」功能，够用；Excel 格式千变万化，导入成本高 |
| Allure 拖拽导入 | 只能「扫描/选目录」，拖拽要改 Electron 文件拖放，收益小 |
| Git 变更影响面 | IDEA 的 Find Usages 更准，做了也是重复 |
| Maven 传递依赖分析 | 要解析完整依赖树 + 联网查 Maven Central，用 `mvn dependency:tree` 更准 |

**技术栈差异**：规划里建议 FastAPI / Spring Boot，实际用的是 **Electron + Node**。
功能一样能做，只是实现方式不同（模板引擎用 EJS 而不是 FreeMarker/Jinja2）。

---

## 数据放哪 / 怎么备份

### 数据位置

| 内容 | 位置 |
|---|---|
| **数据库**（账号/接口/SQL/执行记录） | `%APPDATA%\测试工作台\data.db` |
| **备份** | `%APPDATA%\测试工作台\backups\` |
| **皮肤背景图** | `%APPDATA%\测试工作台\skin\` |
| **你的文件**（用例/jmx/知识库/笔记） | 你自己配的目录，**平台不复制** |

### 备份

**自动备份**：每次启动 + 每天一次，保留最近 10 份。

**手动备份**：设置 → 数据与备份 → **立即备份**。

**导出整库**：设置 → 数据与备份 → **导出整库**（生成 `.db` 文件，可拿去别的机器）。

### 恢复

设置 → 数据与备份 → 选备份文件 → **恢复**。

> 恢复前会自动做一次安全备份（`data-before-restore-*.db`），恢复错了能退回来。

### 搬家（换电脑）

1. 旧机器：设置 → 数据与备份 → **导出整库** → 得到 `xxx.db`
2. 新机器：装好 → 设置 → 数据与备份 → **恢复** → 选那个 `.db`
3. 新机器：把用例/jmx/知识库/笔记目录指到对应位置

> **旧备份能用**：恢复时会自动跑数据迁移（v1→v5）。

---

## 皮肤设置

设置 → **皮肤**：

| 项 | 说明 |
|---|---|
| **主题色** | 7 种：紫（默认）/ 蓝 / 青 / 绿 / 橙 / 红 / 灰 |
| **背景图** | 选本地图片（限 20MB），铺满窗口 |
| **面板透明度** | 0-100%，越低面板越透（背景图越明显）。**拖动时实时预览，松手才保存** |
| **文字颜色** | 自动 / 加深 / 默认 |
| **背景蒙版** | 0-100% + 压暗 / 提亮，背景图和面板之间的那层"薄纱" |

> 换主题只改「强调色」（按钮/选中态/链接），文字和背景不变——不会影响可读性。

**为什么要有蒙版？**

只有「背景图 + 面板」两层时，内容少的地方会大片露出背景图，很刺眼，面板也糊在背景里没有层次。加了蒙版后是三层：

```
背景图（最深）
  ↓
蒙版（半透明纯色，强度可调）
  ↓
面板（白色半透明 + 毛玻璃，浮在最上）
```

**建议值**：画面对比强的图用 35-45%，很花哨的图用 50-60%。

**透明度会不会看不清字？**

不会。平台做了三层保护：

| 层 | 做法 |
|---|---|
| **白底下限** | 面板最透也保留 **62% 白底**（不是 0%） |
| **文字阴影** | 透明度 < 80% 时自动加**白色阴影**（越低越强） |
| **自动加深** | 透明度 < 70% 时文字自动变深（`#1f2430` → `#10141f`） |

如果背景图特别花，可以在「文字颜色」里强制选 **加深**。

---

## 环境要求

**平台只检测，不下载、不安装**——不会修改你的系统环境，卸载时也不会删除它们。

| 环境 | 版本 | 用在哪 | 缺了怎么办 |
|---|---|---|---|
| **JDK** | 17+ | 代码调试（Maven）、代码生成 | 自行安装，或在设置里手动指定 |
| **Python** | 3.10+ | 代码调试（Python/pytest） | 同上 |
| **Maven** | 3.8+ | 代码调试（Maven） | 同上 |
| **JMeter** | 5.x | 代码调试（Groovy）、压测脚本 | 在设置 → 压测里配路径 |
| **Playwright 浏览器** | — | 跑 Playwright 测试 | `npx playwright install` 或 `mvn playwright:install` |

**查看环境状态**：设置 → **开发环境**，会显示每项的检测结果（✓/✗ + 路径 + 版本）。

**多版本共存**：平台会列出所有已装的 JDK / Python，按项目 `pom.xml` 自动选，也可以手动指定。

> **Java 和 Python 的 Playwright 共用同一个浏览器缓存**（`%LOCALAPPDATA%\ms-playwright`），只下一份。

---

## 常见问题

### Q：卸载时勾选「删除用户数据」，会删掉我的 JDK/Python 吗？

**不会。** 只删：

- `%APPDATA%\测试工作台`（数据库、备份、皮肤）
- `文档\测试工作台`（如果平台在里面建过目录）

**不会删**：JDK / Python / Maven / JMeter / Playwright 浏览器——这些是你自己装的环境。

### Q：搜索能搜到密码吗？

**不能。** 搜索范围排除了密码字段（后端 SQL + 前端过滤两层都排除了）。

### Q：平台会改我的 markdown / jmx 文件吗？

**不会。** 用例 / 压测脚本 / 知识库 / 笔记都是**只读索引**，平台只读不写。

唯一的例外：**测试笔记的「导入」功能**会把文件**移动**到笔记目录（这是你主动点的）。

### Q：更新版本会丢数据吗？

**不会。** 数据在 `%APPDATA%`，安装包只覆盖程序文件。

如果新版本改了数据结构，启动时会自动迁移，并先备份一份（`data-before-vN-*.db`）。

### Q：Maven 跑测试报「无效目标发行版: 17」？

**原因**：`JAVA_HOME` 指向 JDK 8，但项目要求 17。

**Maven 只认 `JAVA_HOME`，不认 PATH 里的 `java`。**

**解决**：平台会自动从 `pom.xml` 读版本并选匹配的 JDK。如果还不行，在设置 → 开发环境里手动指定 JDK 17。

### Q：代码调试提示「缺少环境：JMeter」？

去 **设置 → 压测（JMeter）** 配 JMeter 的 `jmeter.bat` 路径。

### Q：报告分析找不到 allure-results？

点「选目录」手动指定。或者确认项目跑过 `mvn test` 且配了 Allure 插件。

### Q：安装时提示「程序正在运行」，但我明明关了？

**它可能只是缩在右下角托盘里**——平台默认「点 X 缩到托盘」，不是退出程序。

> 第一次缩托盘时，右下角会弹一个气泡提醒：「已缩到托盘，程序还在跑」+ 怎么退出。只提示一次。

确认方法：

1. 看屏幕右下角托盘区（可能要点「^」展开）
2. 找到平台图标 → 右键 → **退出**
3. 或者任务管理器里搜 `test-tool.exe`，全部结束

> 不想每次都这样？设置 → 选项 → 「点 X 时」选 **退出程序**。

### Q：数据能同步到别的机器吗？

**不能自动同步**（本地工具，无云端）。用「导出整库 → 恢复」手动搬。

---

## 开发

### 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 45 |
| 前端 | React 18 + antd 5 + dayjs |
| 数据库 | sql.js（WASM SQLite）→ `data.db` |
| 打包 | electron-builder（NSIS 安装包） |
| 测试 | 自研轻量测试脚本（21 个套件，1200+ 项） |

### 本地开发

```bash
npm install
npm run dev        # 开发模式（热更新）
npm test           # 跑全部测试
npm run build:renderer  # 只构建前端
```

### 目录结构

```
electron/          主进程
  main.js          IPC + 窗口 + 设置
  store.js         SQLite 读写 + 加密
  migrations.js    数据迁移
  runner.js        代码运行器
  projects.js      项目扫描
  codescan.js      代码体检
  allure.js        Allure 解析
  openapi.js       OpenAPI 解析
  jmx.js / jtl.js  压测脚本 / 结果解析
  knowledge.js / notes.js / cases.js  只读索引
shared/            前后端共享
  collections.js   集合定义（字段/选项）
  codegen.js       代码生成模板
  runners.js       运行器配置
  themes.js        主题色
  scriptTemplates.js  脚本模板
src/               前端
  pages/           页面
  components/      组件
  mockApi.ts       浏览器预览用的 mock
scripts/           测试脚本
build/             打包资源（图标 / NSIS 脚本）
```

### 发版流程

```bash
# 1. 升版本号
#    改 package.json 的 version

# 2. 跑测试
npm test

# 3. 打安装包
npm run dist:installer

# 4. 打文档包
npm run package:docs

# 5. 提交 + 打 tag + 上传 Release
```

### 加一个集合

1. `shared/collections.js` 的 `COLLECTIONS` 加一项
2. 定义字段（`fields`）
3. 前端自动出现（`CollectionPage` 是通用的）

### 加一个工具

1. `shared/collections.js` 的 `TOOLS` 加一项（带 `group`）
2. `src/pages/` 加页面
3. `src/App.tsx` 加路由
4. `src/icons.tsx` 注册图标（如果用新图标）

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **单人本地** | 没有多用户 / 权限 / 审计 |
| **无云端同步** | 换机器要手动导出导入 |
| **jmx 只读** | 不在平台里改 jmx（用 JMeter GUI） |
| **md 只读** | 不在平台里编辑用例 / 知识库 / 笔记（用 Typora/VSCode） |
| **不下载环境** | JDK/Python/Maven 要自己装 |
| **无 AI** | 全部规则/模板驱动，不调大模型 |

---

## 许可

自用工具，未开源许可。有问题直接找我。
