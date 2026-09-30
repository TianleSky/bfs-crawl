# bfs-clicker — 通用自动点击 Web 控制台爬虫

用 Playwright 驱动真实浏览器，从入口页出发 **自动点击所有可点击控件**，逐个钻入子页面后
关闭标签回退，自动掰开「点按钮 / 展开菜单才触发」的动态路由——这些是静态解析（读 HTML/JS）
和被动爬虫（katana 等）抓不到的接口，适合做**授权范围内**的 Web 控制台完整路线/攻击面地图。

所有流量可经 **Burp 代理**（默认 `127.0.0.1:8080`）全程记录，配合 Burp HTTP History 完整还原。

> ⚠️ **仅限授权测试**。本工具会真实点击页面上的可交互元素，只应作用于**你拥有或已获得明确授权的目标**。
> 用于未授权目标属于违法行为，作者与使用者一概免责。

## 特性

- **真浏览器自动点击**：真实点击所有可点控件，发现动态路由/接口（SPA 菜单、按钮、弹窗触发的请求）。
- **DFS / BFS 双遍历**：`config.order` 选 `bfs`（逐层全览，快速收集 URL 地图，默认）或 `dfs`（子树耗尽式深入）。
- **标签页即状态**：每个状态独立标签页，探索子节点在新标签页从根重放路径到达，父标签不被导航 → 回退零成本。
- **URL 直达**：元素 `href` 是真实目标 URL 时直接 `goto`（跳过根页重载 + 父路径重放）。
- **协议弹窗自动同意**：滚到底 → 勾选复选框 → 点「同意」→ 确认关闭。
- **付款/授权类控件跳过**：`skipTextPatterns` 匹配的按钮**只记录不点击**（防误触购买/授权），在树里橙色标记留待人工处理。
- **状态指纹去重**：`md5(URL+标题+交互面描述)`，Spa 轮询数字不引发状态爆炸；重复路径记入 `backEdges`。
- **断点续跑**：每探索一个状态写 `checkpoint.json`，随时 `Ctrl+C`，`npm run resume` 接着跑。
- **流量捕获 + 去重**：`captureTraffic` 记 traffic.jsonl + `traffic.har`；去重键 = 归一化 URL + 状态 + POST body 指纹，过滤噪声 query 参数。

## 快速开始

```bash
npm install                       # 首次（装 Playwright）
npm run login                     # 手动登录一次，保存会话到 output/session.json
npm run crawl                     # 用会话开始遍历（默认 BFS，maxStates=500）
npm run resume                    # 从断点续跑（output/checkpoint.json）
npm run demo                      # 本地演示站冒烟测试（不走代理、无头、无登录）
npm run dedup-traffic             # 对已有 traffic.jsonl 重新去重（可选）
```

环境变量覆盖（不改 config.json）：

```bash
MAX_STATES=20 npm run crawl       # 限制状态总数（小范围试点）
MAX_DEPTH=3 npm run crawl         # 限制最大深度
RESUME=1 npm run crawl            # 等价于 npm run resume
```

## 通用化（换目标站点）

代码不绑定任何站点——**只改 `config.json` 三项**即可换目标：

| 项 | 说明 |
|---|---|
| `startUrl` | 入口 URL（建议指到具体产品控制台，整站太大） |
| `includeUrlPattern` | 正则；只有 URL 匹配的子状态才继续深入，防爬野 |
| `loginUrl` | 登录页 URL；手动登录一次保存会话后复用 |

登录成功检测也是通用的：URL 不再是登录页 + 存在会话类 cookie（`auth/session/token/sid/uid/jwt/login`）。
要用更精确的特征，可设 `loginLoggedInUrlContains`（登录后 URL 必含片段）。

## 配置（config.json）

| 项 | 说明 | 默认 |
|---|---|---|
| `order` | `bfs`（逐层全览）或 `dfs`（深度优先） | `bfs` |
| `maxDepth` / `maxStates` | 最大深度 / 状态总数上限（`0` 或不设 → 不限） | `4` / `500` |
| `headless` | `false` 用有头窗口（更接近真人，减 WAF 风控） | `false` |
| `channel` | Playwright 浏览器通道（如 `msedge`/`chrome`） | `msedge` |
| `useProxy` / `proxy` | 走 Burp 代理；`demo` 模式自动关闭 | `true` / `127.0.0.1:8080` |
| `storageState` | 登录态文件路径 | `output/session.json` |
| `skipTextPatterns` | **只记录不点击**的控件（付款/授权/开通类），树里橙色标记 | 见下 |
| `agreeKeywords` / `consentKeywords` | 协议弹窗「同意」按钮 / 协议内容关键词 | 中文+英文 |
| `modalSelectors` | 页内弹窗容器选择器 | 常用 dialog/modal |
| `dedupeByUrl` | URL 级全局去重：撞上任何已访问节点 → 判走错路，只记边 | `true` |
| `rediscoverOnReturn` | 回父标签页时重新发现控件（补动态新增按钮） | `true` |
| `fillText` / `fillTextValue` | 是否填充文本框（触发表单类流程） | `false` |
| `captureTraffic` | 是否记录流量 JSONL | `true` |
| `trafficStripQueryParams` | 去重时剥离的噪声 query 参数（时间戳/随机数/sessionId…） | 见 config |
| `trafficExcludeHost` | 去重时排除的主机正则（埋点/遥测域名） | `[]` |

### 付款/授权类按钮：跳过但保留

`skipTextPatterns`（默认含：付款、支付、购买、下单、充值、续费、开通、升级 + 英文 payment/purchase/checkout/authorize 等）——
匹配的按钮**不会被点击**，但出现在 `tree.json` 对应状态的 `clickables`（`skipped: true`）里，截图照常保存。
想让它自动点 → 从 `skipTextPatterns` 删掉关键词再续跑；纯手工处理 → 看截图操作。

## 重复路径检测

- **URL 级全局去重**：子节点 URL（去 hash、去末尾斜杠）只要撞上**任何**已访问节点——不管多早多深——
  即判定「当前路走错了」，不展开、只记一条边，回父节点继续发现兄弟。解决「点了外链被重定向回首页但表面微变、
  指纹级去重抓不到」的问题。
- 重复路径记录在 `output/tree.json` 的 `backEdges` 和 `output/overview.html` 的「重复路径」表
  （来源状态 → 点击控件 → 命中已访问状态）。

## 节点全览图（overview.html）

`output/overview.html` 实时生成：
- 可折叠状态树（每个状态：标题 / URL / 点击路径 / 截图缩略图 / 可点控件清单）
- 控件状态标记：`已点` / `跳过`（付款类，橙）/ `失败`（前置缺失，红，留待人工）
- 「重复路径」表：一眼看出哪些子节点回到了老节点

## 断点续跑

每探索一个新状态就写 `output/checkpoint.json`（visited 指纹 + 全部状态 + 当前 DFS 栈 / BFS 队列），
随时 `Ctrl+C` 停掉，之后 `npm run resume` 从上次位置继续（已耗尽的状态不重跑）。

## 输出

| 文件 | 说明 |
|---|---|
| `output/tree.json` | 嵌套状态树（URL/标题/点击路径/控件清单/子节点）+ `backEdges` 重复路径 |
| `output/overview.html` | 节点全览图（可折叠状态树 + 截图 + 跳过/失败标记 + 重复路径表） |
| `output/states/*.png` | 每个新状态一张截图 |
| `output/checkpoint.json` | 断点状态（断点续跑用） |
| `output/traffic.jsonl` | 捕获的请求流量（method/url/status/headers/postData/body） |
| `output/traffic.har` | HAR 格式流量（可导入 Burp/其他工具） |

## 工作原理

- **标签页即状态**：每个状态一个独立标签页；探索子节点时在**新标签页**里从根重放路径到达，
  父标签页永不被导航 → 回退零成本，天然实现「页面没更深的就关闭 / 子页面都耗尽则上一级也关闭」。
- **状态指纹**：`md5(URL + 标题 + 交互面描述)`，「能点什么」没变即同一状态，SPA 轮询数字不引发状态爆炸。
- **交互面启发**：`isExpansion`/`expansionMinRatio`/`expansionMinDelta` 判断当前页是否值得深入。
- **返回再发现**：`rediscoverOnReturn` 回到父标签时重新采集控件，补动态新增的按钮。

## python/ — Android App 逆向 / DAST 自动化（frida + adb）

> 与上面的 Web 爬虫**互补**：Web 爬虫打「网页」(Playwright 真浏览器)，`python/` 打「**Android App**」(frida gadget 注入 + adb)。两者共用"自动点击/枚举 → 抓动态加载接口"的思路，一个面向 Web、一个面向原生 App。

| 子目录 | 作用 |
|---|---|
| `enum/` | **自动枚举 activity + 跳转 + 抓动态 JS/接口**：`web_enum.py`(驱动器: 逐目标 cold-start + rpc.launch/jump + 长等待收集 `[URL]`) + `web_enum_hook.js`(frida: WebView.loadUrl/onPageStarted = 动态 JS URL + okhttp3 Request/Builder.url = 接口 URL + 全套 bypass) |
| `jump/` | **frida 进程内跳转所有 Activity/组件**：`control_hook.js`(rpc.launch(pkg,cls) 绕过非导出/SecurityException + rpc.jump(path) ARouter) + `jump_via_hook.py` 遍历驱动 |
| `server/` | **通用控制台**：`control_server_any.py`(配置驱动 `--app <json>` 网页面板: 点 Activity 即 rpc.launch + /hosts 实时主机捕获 + 截图判定) + `page_snap.py`/`classify_screenshot.py`(VALID/BLACK/WHITE/LOADING) |
| `dump/` | **内存 dump → PC 正则提敏感**(新 JS/API/key)：`dump_mem_regex.py` + `mem_dump.js`(frida) + `hae_jskey_rules.json` |
| `agent/` | 通用注入 frida agent 示例(rpc exports: launch/hosts/enumacts) |
| `app_crawl.py` | ADB UI BFS 爬虫(独立, `--pkg` 参数化) |

**复用条件(任何 app)**：① 设备 adb 可见 + root(shell input)；② app 到可导航 Main；③ **标准可 attach 的 frida gadget**(14725；⚠️ knox-frida 等反检测 gadget 会让标准 attach 失败=attach墙，控制台用不了，需换标准 gadget)。

**用法示例**：
```bash
python python/enum/web_enum.py --pkg com.example.app --out out/
python python/server/control_server_any.py --app app.json   # app.json: {pkg,process,port,activities_path,hook_js_path,title}
```
详见 `python/README.md`。
