---
name: bfs-crawl
description: 用 bfs-clicker 静态爬虫对指定域名做登录后全交互面爬取（读族接口），流量经 mitmproxy listener 实时入 SRC 库（不再落本地 HAR），再由 LLM 经 MCP 浏览器定点补盲写族接口（语义表单/文件上传/多步向导）。Use when 用户给出一个域名/站点要做接口发现、爬取触发请求、接口入 SRC 库，或提到 bfs-crawl / bfs-clicker。
---

# bfs-crawl：域名登录后全交互面爬取 → SRC 库

输入：域名或完整 URL（如 `console.volcengine.com` 或 `https://console.volcengine.com/home`）+ **项目名**（用户每次下发任务时给，如"火山引擎"；入库 project 字段与 JS 落盘目录用它，每次任务可能不同）。
工具根目录：`D:/Tools/AI/Ai/Frida/bfs-clicker-main`（下称 `$BFS`）。所有命令工作目录均为 `$BFS`，Windows 用 cmd 语法。

## 架构（不落本地，走代理入库）

```
bfs-clicker(Edge) → mitmproxy listener(127.0.0.1:<port>) → SRC PG 库 src@127.0.0.1:15432
                         ├─ 接口 → endpoint 表 kind=动态（去重键 host+method+path+kind，重复命中只更新数据包）
                         ├─ JS → js 表 + 落盘 js_files/<项目>/ + Apifinder 提取 → endpoint kind=静态
                         └─ 白名单闸门：host 根域名不在 scope.md 一律拒绝（遥测域天然被拦）
```

本地配置已固定 `captureTraffic: false` / `harCapture: false`（config.json），不再产出 HAR。

## 流程

### 1. 规范化与配置

- `host` = 输入剥掉协议和路径；`startUrl` = 用户给的完整 URL，否则 `https://<host>/`。
- 编辑 `$BFS/config.json`：
  - `startUrl`：上一步结果。
  - `includeUrlPattern`：转义后的 host + `/.*`（如 `console\\.volcengine\\.com/.*`）。
  - `loginUrl`：站点登录页 URL。**注意营销首页陷阱**：若站点首页是营销页（URL 不含 login 关键词，如 buyin.jinritemai.com），拿不准就仍用 startUrl，但登录检测靠 cookie 基线差异数判定（见第 3 步）。若知道登录成功后的 URL 特征（如落到 console/workbench 路径），在 config.json 加 `loginSuccessUrlPattern`（正则字符串，如 `console\\.xxx\\.com`），检测最可靠。
  - `storageState` 保持 `output/session.json`。
- 换站必须备份旧 `output/`（如重命名为 `output-bak-<host>`）：旧 session.json 是旧站登录态，旧 checkpoint/tree 会污染新站产物。

### 2. 建/复用 SRC 监听（必做，不做流量不入库）

listener 面板：`D:\Tools\AI\AIsrc\Apifinder\listener\app.py` @ `http://127.0.0.1:8766`。先确认在跑：

```cmd
netstat -ano | findstr :8766 | findstr LISTENING
```

无输出则先起面板：`python D:\Tools\AI\AIsrc\Apifinder\listener\app.py`（后台）。

**查该项目名下是否已有存活监听**：

```cmd
curl -s http://127.0.0.1:8766/api/listeners
```

- `listeners[]` 里有 `project=<项目名>` 且 `alive=true` → 复用其 `port`。
- 没有 → 创建（端口自动分配）：

```cmd
curl -s -X POST http://127.0.0.1:8766/api/start -H "Content-Type: application/json" -d "{\"project\": \"<项目名>\"}"
```

返回 `listener.port` 即监听端口。**不要复用别的项目的监听**（project 字段会污染）。

**白名单预检**：host 根域名必须在 `C:\Users\Administrator\.claude\commands\scope.md` 内，否则流量过代理也一律拒绝入库（拦截计数见 `/api/listeners` 的 blocked）。不在名单先加 scope 再继续。

**注入代理**：login/crawl/assist 前设环境变量（覆盖 config.json 的 proxy.server）：

```cmd
set BFS_PROXY=http://127.0.0.1:<port>&& node src/index.js crawl
```

（`set` 与 `&&` 之间不能有空格。cmd 会话内设一次，后续 login/crawl 命令同会话有效。）

### 3. 登录

目标站不变且 `output/session.json` 存在 → 问用户是否复用；复用则跳到第 4 步。

否则执行（同一会话已设 BFS_PROXY，登录流量同样入库）：

```cmd
node src/index.js login
```

- 弹出真实 Edge 窗口。明确告知用户："请在弹出的浏览器窗口里完成登录；**完成登录后请自己关闭浏览器窗口**，关窗瞬间自动保存登录态并结束。窗口打开期间绝不会自动退出"。
- 登录检测 v2（无自动检测）：任何 cookie 启发式都会被营销首页站的 SSO 静默握手 cookie（bd_sso_*）和风控指纹 cookie（x-web-secsdk-uid）骗到秒误判关窗，因此**用户关窗是唯一"登录完成"信号**；每 1s 快照 cookie，关窗后用快照落盘 session.json。10 分钟未关窗兜底保存。
- 等该命令结束后确认 `output/session.json` 时间晚于 login 启动时间。
- 保险起见，crawl 前可用无头脚本验证登录态（加载 session.json 打开 startUrl，看是否跳登录页/出现登录后 cookie）。
- mitmproxy CA 已装系统根证书库（CurrentUser+LocalMachine 均有），Edge 直连即可；万一页面报证书错误，检查 `%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem` 是否需重装。

### 4. 爬取

```cmd
node src/index.js crawl
```

- 调范围用环境变量（cmd：`set MAX_STATES=200&& node src/index.js crawl`，`&&` 前不能有空格；`MAX_DEPTH` 同理）。
- 中断后续跑：`node src/index.js resume`（checkpoint 每状态落盘）。
- 产物：`output/tree.json`、`output/overview.html`（全览图）、`output/states/*.png`（每状态截图）。**流量不入本地**，实时进 SRC 库。
- 爬取特性：iframe 全遍历；滚动懒加载（config `scrollMaxSteps` 默认 8，0 关闭）；语义危险门禁（带安全 href 的导航链接放行，危险按钮跳过并记录）。

### 5. 统计与报告

唯一接口数（库行数 = 去重后口径）：

```cmd
python query_srcdb.py <主域>
```

- `主域` = 域族口径（如 `volcengine.com`，覆盖全部子域）。拿不准（`co.jp`/`com.cn` 类后缀）问用户。
- 输出动态/静态分列与合计；`--all` 出全部明细。

触发次数（含重复命中）：查 `D:\Tools\AI\AIsrc\Apifinder\listener\state\<port>.json` 的 `counts.endpoint`（每次 upsert +1）；`counts.js`/`counts.static` 为新 JS 数与静态提取接口数；`counts.blocked` 为白名单拦截数。

**本次新增口径**：库按 `(host,method,path,kind)` 全局去重、跨项目合并——同站历史数据会并入。报"本次新增"用跑前/跑后各查一次 `query_srcdb.py <主域> --count` 取差值；报"本次触发"用 state 计数差值。

**与旧 HAR 基线对比**：旧口径（count_requests.cjs 剥噪声参数后含 query）比库口径（去重不含 query）宽松，同一份流量库口径数字偏小属正常，不要直接比绝对值。

### 6. LLM 定点补盲（写族接口：静态爬虫覆盖不了的能力）

静态爬虫吃读族（导航/列表/查询）；写族（语义表单/文件上传/多步向导）由你（LLM）通过 MCP 浏览器定点突破。任务形态是"这个页面把表单填到提交成功"，不是开放探索。assist 模式同样走 BFS_PROXY 代理，补盲流量实时入库。

#### 6.1 生成任务清单

```cmd
node extract_tasks.cjs
```

读 `output/checkpoint.json` → 产出 `output/assist-tasks.json`（failed 元素 + 含表单控件的页面）。优先级：failed 多 > 表单控件多。

#### 6.2 起 assist 浏览器（登录态平移的正解）

```cmd
node src/index.js assist <首个任务页URL>
```

- 带 `output/session.json` 登录态起真实 Edge，开 CDP 端口（config `cdpPort` 默认 9222），挂起等待。
- **不要把 session 搬进 MCP 浏览器**（HttpOnly cookie 导不出）；让 MCP 连这个已有登录态的浏览器。
- MCP 配置：chrome-devtools-mcp 的 args 加 `--browserUrl http://127.0.0.1:9222`（playwright-mcp 用 `--cdp-endpoint`），改完重载 MCP 生效。
- 同会话已设 BFS_PROXY 时 assist 流量同样入 SRC 库。

#### 6.3 逐页补盲

每个任务页：navigate 到 url（SPA 深链不通就按 pathLabels 逐层点）→ snapshot 看表单 → 按语义值表填写 → 提交 → 用 list_network_requests 确认请求发出。

语义值表（按 label/name/placeholder/type 匹配）：

| 字段语义 | 填值 |
|---|---|
| 手机号 / phone / mobile / tel | 13800000000 |
| 邮箱 / email | jsfinder@example.com |
| 密码 / password | JsFinder@2026 |
| 验证码 / code / captcha / otp | 123456（失败即放弃该页） |
| 数字 / number / 数量 | 1 |
| URL 字段 | https://example.com |
| 日期 / date | 2026-01-01 |
| 姓名 / 名称 / name | 测试名称 |
| 身份证 / idcard | 用生成器（见下） |

身份证号生成器（带合法校验位，在页面 evaluate 里跑）：

```js
(() => {
  const body = `11010119900307${String(Math.floor(Math.random() * 900) + 100)}`;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const c = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  return body + c[body.split('').reduce((s, ch, i) => s + ch * w[i], 0) % 11];
})()
```

文件上传：遇 `<input type=file>`，先造一个测试文件（如 `test.png`/`test.xlsx` 写到本地临时目录），再用 MCP 的 upload_file 工具传入。

铁律：

- 只填不毁：删除/支付/注销/真实扣费类提交按钮不点（与爬虫危险门禁同词表）。
- 业务 ID 关联：字段要求"已存在的订单号/用户 ID"时，先去对应列表页抓一个真实值再回来填。
- 每页最多尝试 3 次提交，不过就记录原因放弃，进下一页。
- 人机验证（图形验证码/滑块/短信）直接放弃该页并记录。

#### 6.4 收尾

1. 结束 assist 进程（Ctrl+C）。
2. 补盲产出同样查 `python query_srcdb.py <主域>`，与 crawl 阶段差值合并报告。
3. 恢复 MCP 配置（去掉 `--browserUrl`）并重载。
4. 监听可留可停（留着则后续同项目复用；停掉：`curl -s -X POST http://127.0.0.1:8766/api/stop -H "Content-Type: application/json" -d "{\"id\": \"<项目名>@<port>\"}"`）。

## 故障处理

- crawl 中大量撞登录页/401 → 登录态过期，重跑第 3 步。
- "找不到元素/前置缺失"失败多 → SPA 渲染慢，调大 config `surfaceSettleTimeoutMs`。
- 想全量不设限 → config `maxStates: 0`（即 Infinity，跑到队列耗尽）。
- assist 打开页面撞登录页 → session 过期，重跑第 3 步 login 后再 assist。
- MCP 连不上 9222 → 确认 assist 进程存活且 `curl http://127.0.0.1:9222/json/version` 有返回；确认 mcp.json 改动后已重载 MCP。
- 流量不入库（state 计数不涨）→ ① 确认 BFS_PROXY 已设且端口是当次监听的；② 确认根域名在 scope.md（blocked 涨=被白名单拦）；③ 确认 PG 15432 在跑。
- Edge 报证书错误 → mitmproxy CA 丢失，双击 `%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem` 装入"受信任的根证书颁发机构"。
