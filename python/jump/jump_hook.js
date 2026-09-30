// jump_hook.js — 在 app 进程内 hook Activity 导航 + 提供"从 app 上下文启动任意 Activity"的 RPC。
//
// 目的（用户需求: 通过 hook 跳转所有页面）:
//   1) hook android.app.Activity.startActivity / startActivityForResult,
//      记录 app 每一次真实导航 (目标组件 + 携带的 Intent extras) -> 还原"所有页面"的跳转地图与必需参数。
//   2) rpc.exports.launch(pkg, cls, extrasJson): 在 app 自己 uid 内 startActivity(任意组件),
//      从而绕过非 exported 的 SecurityException -> 能冷启动任何页面(含导出表看不到的非导出 Activity)。
//
// 运行: python scripts/jump_via_hook.py   (attach gadget 14725 -> 打印 NAV 日志 / 触发 --launch)
var NEW_TASK = 0x10000000;

function descIntent(i) {
  try {
    var c = i.getComponent();
    var comp = c ? (c.getClassName() || String(c)) : "?";
    var filter = i.getAction ? i.getAction() : null;
    var data = i.getDataString ? i.getDataString() : null;
    var extra = "{}";
    try { extra = String(i.getExtras ? i.getExtras() : null); } catch (e) {}
    return comp + (filter ? " action=" + filter : "") + (data ? " data=" + data : "") + " extras=" + (extra.length > 400 ? extra.slice(0, 400) : extra);
  } catch (e) { return "err:" + e; }
}

Java.perform(function () {
  var Activity = Java.use("android.app.Activity");

  function hookMarshalled(fnName, intentIdx) {
    // startActivity(Intent) / startActivity(Intent, int)
    var ovs = Activity[fnName].overloads;
    ovs.forEach(function (o) {
      o.implementation = function () {
        var it = null;
        try { it = (arguments.length > intentIdx) ? arguments[intentIdx] : null; } catch (e) {}
        try { if (it && !it.isJava? false : true) send("NAV " + fnName + " -> " + (it ? descIntent(it) : "?")); } catch (e) {}
        return o.apply(this, arguments);
      };
    });
  }
  hookMarshalled("startActivity", 0);
  hookMarshalled("startActivityForResult", 0);

  // 也 hook 更高层的 route 入口: 很多 app 用自己的 Router.open(url|routerName), 这里先透传 Intent 版本。
  send("hook installed: Java bridge active");

  // --- RPC: 从 app 上下文启动任意组件 ---
  rpc.exports = {
    launch: function (pkg, cls, extrasJson) {
      return new Promise(function (resolve) {
        Java.perform(function () {
          try {
            var ActivityThread = Java.use("android.app.ActivityThread");
            var app = ActivityThread.currentApplication();
            var ctx = app.getApplicationContext();
            var Intent = Java.use("android.content.Intent");
            var it = Intent.$new();
            it.setClassName(pkg, cls);
            it.addFlags(NEW_TASK);
            if (extrasJson) {
              try {
                var o = JSON.parse(extrasJson);
                Object.keys(o).forEach(function (k) {
                  var v = o[k];
                  if (typeof v === "number") it.putExtra(k, v);
                  else if (typeof v === "boolean") it.putExtra(k, v);
                  else it.putExtra(k, String(v));
                });
              } catch (e) { send("extras parse err: " + e); }
            }
            ctx.startActivity(it);
            resolve("OK launched " + cls);
            send("LAUNCHED " + cls);
          } catch (e) { resolve("ERR " + e); send("launch err: " + e); }
        });
      });
    }
  };
  send("rpc.exports ready");
});
