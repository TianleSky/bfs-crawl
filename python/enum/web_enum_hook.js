// web_enum_hook.js — 自愈枚举用: control_hook.js 全部(SSL/root/FLAG_SECURE/control)
//   + 抓动态加载的 H5/JS URL (WebView.loadUrl / onPageStarted / shouldOverrideUrlLoading)
//   + OkHttp 请求 URL(接口层)。URL 经 send("[URL] <kind> <url>") 上报, runner 收集。
var NEW_TASK = 0x10000000;
var FLAG_SECURE = 0x2000;

function descIntent(i) {
  try {
    var c = i.getComponent();
    var comp = c ? (c.getClassName() || String(c)) : "?";
    var data = i.getDataString ? i.getDataString() : null;
    return comp + (data ? " data=" + data : "");
  } catch (e) { return "err:" + e; }
}

Java.perform(function () {
  // ---- FLAG_SECURE 剥(同 control_hook) ----
  function hookForceFalse(cls, method) {
    try {
      var C = Java.use(cls);
      C[method].overloads.forEach(function (o) {
        o.implementation = function () {
          var args = Array.prototype.slice.call(arguments);
          for (var i = args.length - 1; i >= 0; i--) {
            if (typeof args[i] === "boolean") { args[i] = false; break; }
          }
          return o.apply(this, args);
        };
      });
    } catch (e) {}
  }
  var W = Java.use("android.view.Window");
  W.addFlags.implementation = function (f) { return this.addFlags(f & ~FLAG_SECURE); };
  W.setFlags.implementation = function (fl, mask) { return this.setFlags(fl & ~FLAG_SECURE, mask & ~FLAG_SECURE); };
  ["android.view.SurfaceControl", "android.view.SurfaceControl$Builder"].forEach(function (c) { hookForceFalse(c, "setSecure"); });

  // ---- SSL 放行(同 control_hook) ----
  ["libssl.so", "libcrypto.so"].forEach(function (name) {
    if (!Module.findBaseAddress(name)) return;
    try {
      var gvr = Module.findExportByName(name, "SSL_get_verify_result");
      if (gvr) { Interceptor.replace(gvr, new NativeCallback(function () { return 0; }, "long", ["pointer"])); }
    } catch (e) {}
  });
  try { Java.use("javax.net.ssl.HostnameVerifier").verify.implementation = function (h, s) { return true; }; } catch (e) {}

  // ---- root / watchdog / risk bypass(同 control_hook) ----
  try {
    var B = Java.use("com.sample.android.util.android.b");
    try { B.b.implementation = function () { return false; }; } catch (e) {}
    try { B.c.implementation = function () { return false; }; } catch (e) {}
    try { B.d.implementation = function () { return 0; }; } catch (e) {}
  } catch (e) {}
  try { Java.use("com.ampmind.apigetway.utils.a").i.implementation = function () { return false; }; } catch (e) {}
  try { Java.use("android.os.Process").killProcess.implementation = function () {}; } catch (e) {}
  try {
    var SD = Java.use("com.example.app.business.home.RiskDialogActivity");
    SD.onDestroy.implementation = function () {};
  } catch (e) {}

  // ---- 抓动态加载的 H5/JS URL ----
  try {
    var WV = Java.use("android.webkit.WebView");
    try { WV.loadUrl.overload("java.lang.String").implementation = function (u) { send("[URL] web-load " + u); return WV.loadUrl.overload("java.lang.String").call(this, u); }; } catch (e) {}
  } catch (e) {}
  try {
    var WVC = Java.use("android.webkit.WebViewClient");
    try {
      WVC.onPageStarted.overload("android.webkit.WebView", "java.lang.String", "android.graphics.Bitmap").implementation =
        function (wv, url, fav) { send("[URL] page-start " + url); return this.onPageStarted(wv, url, fav); };
    } catch (e) {}
    try {
      WVC.onReceivedSslError.implementation = function (wv, handler, err) {
        send("[URL] ssl-error-proceed " + (err && err.getUrl ? err.getUrl() : "?"));
        try { handler.proceed(); } catch (e) {}
      };
    } catch (e) {}
    try {
      WVC.shouldOverrideUrlLoading.overload("android.webkit.WebView", "java.lang.String").implementation =
        function (wv, url) { send("[URL] override " + url); return this.shouldOverrideUrlLoading(wv, url); };
    } catch (e) {}
  } catch (e) {}

  // ---- OkHttp 接口 URL(抓服务/JS 接口 layer) ----
  try {
    var RC = Java.use("okhttp3.internal.connection.RealCall");
    try {
      RC.execute.implementation = function () {
        try { var r = this.request(); send("[URL] api " + r.method() + " " + r.url().toString()); } catch (e) {}
        return RC.execute.call(this);
      };
    } catch (e) {}
    try {
      RC.enqueue.implementation = function (cb) {
        try { var r = this.request(); send("[URL] api " + r.method() + " " + r.url().toString()); } catch (e) {}
        return RC.enqueue.call(this, cb);
      };
    } catch (e) {}
  } catch (e) {}
  try {
    var BUILDER = Java.use("okhttp3.Request$Builder");
    try {
      BUILDER.url.overload("java.lang.String").implementation = function (u) { send("[URL] rq " + u); return BUILDER.url.overload("java.lang.String").call(this, u); };
    } catch (e) {}
  } catch (e) {}

  send("web_enum_hook ready: bypass(ssl/root/secure) + URL capture armed");

  // ---- rpc: launch / jump(同 control_hook) ----
  rpc.exports = {
    launch: function (pkg, cls, extrasJson) {
      return new Promise(function (resolve) {
        Java.perform(function () {
          try {
            var at = Java.use("android.app.ActivityThread"), app = at.currentApplication(), ctx = app.getApplicationContext();
            var Intent = Java.use("android.content.Intent"), it = Intent.$new();
            it.setClassName(pkg, cls); it.addFlags(NEW_TASK);
            if (extrasJson) {
              try {
                var o = JSON.parse(extrasJson);
                Object.keys(o).forEach(function (k) { var v = o[k]; if (typeof v === "number") it.putExtra(k, v); else if (typeof v === "boolean") it.putExtra(k, v); else it.putExtra(k, String(v)); });
              } catch (e) {}
            }
            ctx.startActivity(it); resolve("OK " + cls); send("LAUNCHED " + cls);
          } catch (e) { resolve("ERR " + e); send("launch err: " + e); }
        });
      });
    },
    jump: function (path, paramsJson) {
      return new Promise(function (resolve) {
        Java.perform(function () {
          try {
            var ARouter = Java.use("com.alibaba.android.arouter.launcher.ARouter"), pc = ARouter.getInstance().build(path);
            var params = paramsJson ? JSON.parse(paramsJson) : {};
            Object.keys(params).forEach(function (k) { var v = params[k]; if (typeof v === "number") pc.withInt(k, v | 0); else if (typeof v === "boolean") pc.withBoolean(k, v); else pc.withString(k, String(v)); });
            pc.navigation(); resolve("OK " + path); send("ROUTE " + path);
          } catch (e) { resolve("ERR " + e); send("rerr " + e); }
        });
      });
    }
  };
});
