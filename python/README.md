# bfs-clicker / python — 通用 Android 逆向/DAST 自动化工具(去 app 特定)
## 目录
### enum/   自动枚举 activity + 跳转 + 抓动态 JS/接口
  - web_enum.py(驱动器): 逐目标 restart/cold-start + rpc.launch/jump + 长等待收集 [URL] -> web_enum_report.json; 自愈(AMS卡死重试)
  - web_enum_hook.js(frida agent): WebView.loadUrl/onPageStarted/shouldOverrideUrlLoading(动态JS URL) + okhttp3 Request/Builder.url(接口URL) + rpc.exports.launch/jump + 全套 bypass(SSL/root/FLAG_SECURE)
### jump/   进程内跳转
  - control_hook.js: rpc.exports.launch(pkg,cls)(startActivity绕非导出) + rpc.exports.jump(path)(ARouter带参) + bypass base
  - jump_hook.js / jump_via_hook.py: 遍历驱动 + 截图
### server/  通用本地控制台
  - control_server_any.py(配置驱动 --app <json>): 网页面板(activity列表+点跳转+/hosts主机捕获+截图判定)
  - page_snap.py / classify_screenshot.py: 截图 + 判定(VALID/BLACK/WHITE/LOADING)
### dump/    内存 dump -> PC 正则提敏感(新JS/API/key)
  - dump_mem_regex.py + mem_dump.js(frida) + hae_jskey_rules.json
### agent/   通用注入 agent 示例(A型 jump / B型 launch 风格)
  - bypass_agent.js(示例: rpc.exports enumacts+launch+hosts)

## 复用条件(任何 app)
1) 设备 adb 可见 + root(shell input)  2) app 到可导航 UI(Main)  3) 标准可 attach 的 frida gadget(14725, 非 knox-frida attach 墙)
## 用法示例
  python enum/web_enum.py --pkg com.example.app --out out/
  python server/control_server_any.py --app app.json   # app.json: {pkg,process,port,activities_path,hook_js_path,title}
