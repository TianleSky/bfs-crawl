// control_hook.js — 控制服务(control_server.py)用:
//   1) 剥 FLAG_SECURE(0x2000): 支付/钥匙/二维码等"防截屏"页面, screencap 才拍得到内容(否则黑帧)。
//   2) rpc.exports.launch(pkg, cls, extrasJson): 进程内 startActivity 任意组件 —— 绕过非导出 SecurityException。
//   3) rpc.exports.jump(path, paramsJson): ALIBABA ARouter 带参跳转 —— 数据依赖页能带参数渲染真实内容。
// 复用 page_snap.py 的 gadget 14725 attach。
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
  // --- 全局剥 FLAG_SECURE: 只剥 Window 层面不够, 还要在 SurfaceControl 层面按 false,
  //     否则一个防截屏页(支付/钥匙/启动页)会把表面的 secure 位点亮并"毒化"整个进程,
  //     导致此后每个页面的 screencap 都是 0 字节(这就是"有些页面不能直接截图")。 ---
  function hookForceFalse(cls, method, argCount) {
    try {
      var C = Java.use(cls);
      C[method].overloads.forEach(function (o) {
        o.implementation = function () {
          // 把最后一个 boolean 参数强制为 false
          var args = Array.prototype.slice.call(arguments);
          for (var i = args.length - 1; i >= 0; i--) {
            if (typeof args[i] === "boolean") { args[i] = false; break; }
          }
          return o.apply(this, args);
        };
      });
    } catch (e) { send("hook " + cls + "." + method + " skip: " + e); }
  }
  var Window = Java.use("android.view.Window");
  Window.addFlags.implementation = function (f) {
    return this.addFlags(f & ~FLAG_SECURE);
  };
  Window.setFlags.implementation = function (fl, mask) {
    return this.setFlags(fl & ~FLAG_SECURE, mask & ~FLAG_SECURE);
  };
  // SurfaceControl.setSecure(true) 是 screencap 0 字节的直接原因(raw surface secure 位)
  try { Java.use("android.view.SurfaceControl").setSecure.overloads.forEach(function (o) {
    o.implementation = function () {
      var a = Array.prototype.slice.call(arguments);
      a[a.length - 1] = false;                      // 强制 un-secure surface
      return o.apply(this, a);
    };
  }); } catch (e) { send("sc.setSecure skip: " + e); }
  // SurfaceControl$Builder.setSecure(boolean) —— 创建 surface 时的标记
  try { Java.use("android.view.SurfaceControl$Builder").setSecure.overloads.forEach(function (o) {
    o.implementation = function () {
      var a = Array.prototype.slice.call(arguments);
      a[a.length - 1] = false;
      return o.apply(this, a);
    };
  }); } catch (e) { send("builder.setSecure skip: " + e); }
  // View.setSecure / ViewRootImpl 层面兜底
  try { Java.use("android.view.View").setSecure.overloads.forEach(function (o) {
    o.implementation = function () {
      var a = Array.prototype.slice.call(arguments);
      a[a.length - 1] = false;
      return o.apply(this, a);
    };
  }); } catch (e) { send("view.setSecure skip: " + e); }

  // --- 记录 app 真实导航(还原跳转地图) ---
  var Activity = Java.use("android.app.Activity");
  ["startActivity", "startActivityForResult"].forEach(function (fnName) {
    Activity[fnName].overloads.forEach(function (o) {
      o.implementation = function () {
        try {
          var it = arguments[0];
          if (it && it.getComponent) send("NAV " + fnName + " -> " + descIntent(it));
        } catch (e) {}
        return o.apply(this, arguments);
      };
    });
  });

  // --- SSL 放行(完整版, 复刻 ssl_bypass_okhttp.js): 关键在 native BoringSSL
  //     SSL_get_verify_result->0(真正消掉 "Hostname not verified" —— hostname/cert 校验在 BoringSSL 内,
  //     光 hook 上层 Java HostnameVerifier 够不到)。否则登录页连裸 IP(180.76.76.200) -> 网络异常。 ---
  function hookNativeSSL() {
    ["libssl.so", "libcrypto.so"].forEach(function (name) {
      if (!Module.findBaseAddress(name)) return;
      try {
        var gvr = Module.findExportByName(name, "SSL_get_verify_result");
        if (gvr) { Interceptor.replace(gvr, new NativeCallback(function () { return 0; }, "long", ["pointer"])); }
        var setv = Module.findExportByName(name, "SSL_CTX_set_verify");
        if (setv) { Interceptor.attach(setv, { onEnter: function (a) { try { this.context.x1 = ptr(0); } catch (e) {} } }); }
      } catch (e) {}
    });
    send("ssl: native SSL backstop(verify_result=0) armed");
  }
  function hookJavaSSL() {
    ["com.huawei.secure.android.common.ssl.SecureX509TrustManager",
     "com.huawei.secure.android.common.HiCloudX509TrustManager",
     "com.huawei.secure.android.common.ssl.SecureSSLSocketFactory",
     "com.sample.fed.sdk.track.network.utils.FedHttpsUtils"].forEach(function (cls) {
      try {
        var C = Java.use(cls);
        try { C.checkServerTrusted.overload("[Ljava.security.cert.X509Certificate;", "java.lang.String").implementation = function (certs, auth) {}; } catch (e) {}
        try { C.checkServerTrusted.overload("[Ljava.security.cert.X509Certificate;", "java.lang.String", "java.lang.String").implementation = function (certs, auth, host) { return Java.use("java.util.ArrayList").$new(); }; } catch (e) {}
        try { C.checkClientTrusted.overload("[Ljava.security.cert.X509Certificate;", "java.lang.String").implementation = function (certs, auth) {}; } catch (e) {}
        try { C.getAcceptedIssuers.implementation = function () { return []; }; } catch (e) {}
      } catch (e) {}
    });
    try { Java.use("javax.net.ssl.HostnameVerifier").verify.implementation = function (h, s) { return true; }; } catch (e) {}
    send("ssl: app trust managers + HostnameVerifier armed");
  }
  function hookOkHttp() {
    ["okhttp3.internal.platform.android.AndroidCertificateChainCleaner",
     "okhttp3.internal.platform.android.d"].forEach(function (cls) {
      try {
        var OC = Java.use(cls);
        try { OC.get.overload("javax.net.ssl.SSLSocketFactory").implementation = function (f) { return null; }; } catch (e) {}
      } catch (e) {}
    });
  }
  hookNativeSSL(); hookJavaSSL(); hookOkHttp();

  // --- root 检测 + watchdog + 风险弹窗 bypass(复用 sample_bypass_final / ssl_bypass_okhttp):
  //     没有这些, app 的 root/watchdog 会在导航时把进程杀掉(之前反复死的原因)。 ---
  (function () {
    try {
      var B = Java.use("com.sample.android.util.android.b");
      try { B.b.implementation = function (sb) { return false; }; } catch (e) {}
      try { B.c.implementation = function (sb) { return false; }; } catch (e) {}
      try { B.d.implementation = function () { return 0; }; B.e.implementation = function (s) { return 0; }; } catch (e) {}
      send("bypass: root b/c/d/e => false");
    } catch (e) { send("bypass root skip: " + e); }
    try { Java.use("com.ampmind.apigetway.utils.a").i.implementation = function () { return false; }; } catch (e) {}
    try { Java.use("android.os.Process").killProcess.implementation = function (p) {}; } catch (e) {}
    try {
      ["com.example.app.business.home.RiskDialogActivity",
       "com.example.app.business.home.LoginActivity$a$a",
       "com.example.app.business.home.LoginActivity$a"].forEach(function (cls) {
        try {
          var C = Java.use(cls);
          try { C.onDestroy.implementation = function () {}; } catch (e) {}
          try { C.a.implementation = function (b) {}; } catch (e) {}
          try { C.c.implementation = function (b) {}; } catch (e) {}
        } catch (e) {}
      });
      send("bypass: risk-dialog no-op");
    } catch (e) {}
    send("bypass: root+watchdog+risk armed");
  })();

  send("control_hook ready: Java active, FLAG_SECURE stripped");

  rpc.exports = {
    // 进程内启动任意 Activity(绕过 exported 校验)
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
            resolve("OK " + cls);
            send("LAUNCHED " + cls);
          } catch (e) { resolve("ERR " + e); send("launch err: " + e); }
        });
      });
    },

    // ARouter 带参跳转
    jump: function (path, paramsJson) {
      return new Promise(function (resolve) {
        Java.perform(function () {
          try {
            var ARouter = Java.use("com.alibaba.android.arouter.launcher.ARouter");
            var pc = ARouter.getInstance().build(path);
            var params = paramsJson ? JSON.parse(paramsJson) : {};
            Object.keys(params).forEach(function (k) {
              var v = params[k];
              if (typeof v === "number") { pc.withInt(k, v | 0); }
              else if (typeof v === "boolean") { pc.withBoolean(k, v); }
              else { pc.withString(k, String(v)); }
            });
            pc.navigation();
            resolve("OK " + path);
            send("ROUTE " + path);
          } catch (e) { resolve("ERR " + e); send("rerr " + e); }
        });
      });
    }
  };
});
