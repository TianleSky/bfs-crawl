# -*- coding: utf-8 -*-
"""control_server_any.py — 通用(任意 app)的本地控制台: 浏览器里指定打开 Activity + 实时主机捕获 + 截图判定。
由 control_server.py(目标app专用)泛化而来: 不硬编码任何 app 专属字段, 全部走配置文件。

配置驱动(JSON 配置文件, 用 `--app <json>` 指定; 命令行参数优先级更高):
  {
    "pkg":            "com.example.app",   # 要启动的 App 包名(launch/回首页用)
    "process":        "com.example.app",   # 要检查/附着的进程名(缺省可等于 pkg)
    "port":           14725,                        # gadget 监听端口
    "activities_path":"./activities.txt",      # Activity 静态列表(每行一个类名, 或 JSON {"activities":[...]})
    "hook_js_path":   "./hook.js",    # frida hook/agent 脚本(提供 rpc.exports)
    "title":          "目标app 页面控制台",             # 网页标题
    "launch_mode":    "cls"                         # 可选: 覆盖 launch 调用签名(见下); "auto" 自动探测
  }

launch_mode 说明(自动探测: 看 hook 是否有 rpc.exports.jump 导出 → 有=目标app风格(带 pkg), 无=目标app风格):
  "auto"            自动(canvas: jump 存在 => pkg_cls_extras, 否则 cls)
  "cls"             ->  sc.exports.launch(cls)                        (目标app bypass_agent.js)
  "pkg_cls"         ->  sc.exports.launch(pkg, cls)
  "pkg_cls_extras"  ->  sc.exports.launch(pkg, cls, extrasJson|null)   (目标app control_hook.js)
其余字段(config 缺省): out(截图目录, 默认 screen), sleep(打开后等待秒, 默认 3.0), adb(默认项目 ADB 路径)。

端点:
  GET  /           控制面板(主机列表 + Activity 列表 + 点击跳转 + 截图)
  GET  /state      当前前台 + 是否附着 + 最近截图判定 {attached,how,fg,last}
  GET  /acts       JSON 全部 Activity
  GET  /hosts      JSON 实时捕获主机(若 hook 支持 rpc.exports.hosts)
  GET  /screen     当前屏幕实时判定(一帧)
  GET  /shot?name=X&wait=1   截图并判定 -> 保存 <out>/X.png
  GET  /img/<name>           读取 <out>/<name> 的 png
  POST /open       {cls, extras?}    打开 Activity
  POST /relaunch   重启应用 + 重新附着
  POST /home       回首页(monkey launcher)

用法:
  python -u scripts/control_server_any.py --app app.json
  python -u scripts/control_server_any.py --app app.json   # 或直接缺省用默认
  python -u scripts/control_server_any.py --pkg com.example.app         # 无配置, 用目标app默认
浏览器: http://127.0.0.1:8000/
"""
import argparse, json, os, re, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import page_snap as ps
from classify_screenshot import analyze as _an, classify as _cl

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ACT = "dast-scan/activities.json"
DEFAULT_HOOK = os.path.join(HERE, "control_hook.js")

# --- 全局 frida 会话(单线程持有) ---
LOCK = threading.Lock()
SESS = SC = DEV = None
ATTACHED = False
HOW = ""
LAUNCH_MODE = "cls"
HAS_HOSTS = False
STATE = {"last": None}
ARGS = None

# 运行期解析出的 app 身份(由 config < CLI < 默认 合成)
PKG = PROC = PORT = ACT_PATH = HOOK = TITLE = None


def on_msg(m, d):
    if m.get("type") == "error":
        print("[err]", (m.get("stack") or m.get("description"))[:200], flush=True)
    elif m.get("type") == "send":
        print("[app]", str(m.get("payload"))[:160], flush=True)


def resolve_launch_mode():
    """确定 launch 调用签名。config 显式指定优先, 否则按 hook 是否导出 jump 探测。"""
    m = (ARGS.launch_mode or "auto").lower()
    if m and m != "auto":
        return m
    try:
        if hasattr(SC.exports_sync, "jump"):     # 目标app control_hook.js 有 jump -> 带 pkg
            return "pkg_cls_extras"
    except Exception:
        pass
    return "cls"


def ensure_attached():
    """确保 frida 已附着到 gadget(端口 PORT, 注入进程 = 监听该端口的进程)。返回 bool。
    优先 attach 到 gadget socket 的持有进程(即被注入的 app 进程), 其次 pidof(process)。"""
    global SESS, SC, DEV, ATTACHED, HOW, LAUNCH_MODE, HAS_HOSTS
    import frida
    with LOCK:
        if SESS is not None:
            try:
                if ps.pidof(PROC):
                    return True
            except Exception:
                pass
            SESS = SC = None
            ATTACHED = False
        subprocess.run([ps.ADB, "forward", "tcp:%s" % PORT, "tcp:%s" % PORT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pid = ps.find_gadget_pid(PORT) or ps.pidof(PROC)
        if not pid:
            ATTACHED = False
            return False
        try:
            dev = frida.get_device_manager().add_remote_device("127.0.0.1:%s" % PORT)
            sess = dev.attach(int(pid))
        except Exception as e:
            print("[!] attach err: %s" % e, flush=True)
            ATTACHED = False
            return False
        try:
            sc = sess.create_script(open(HOOK, encoding="utf-8").read())
            sc.on("message", on_msg)
            sc.load()
            try:
                sess.resume()
            except Exception:
                pass
            time.sleep(0.5)
            SESS, SC, DEV, ATTACHED, HOW = sess, sc, dev, True, "remote"
            LAUNCH_MODE = resolve_launch_mode()
            HAS_HOSTS = bool(hasattr(sc.exports_sync, "hosts"))
        except Exception as e:
            print("[!] create_script/load err: %s" % e, flush=True)
            ATTACHED = False
            return False
        print("[*] attached via %s pid=%s launch_mode=%s" % (HOW, pid, LAUNCH_MODE), flush=True)
        return True


def get_hosts():
    """实时捕获主机(仅当 hook 有 rpc.exports.hosts)。"""
    if not ensure_attached():
        return {"ok": False, "hosts": []}
    if not HAS_HOSTS:
        return {"ok": False, "hosts": [], "err": "此 hook 无 hosts() 导出"}
    try:
        return {"ok": True, "hosts": SC.exports_sync.hosts()}
    except Exception as e:
        return {"ok": False, "hosts": [], "err": str(e)}


def do_open(d):
    cls = d.get("cls")
    if not cls:
        return {"ok": False, "err": "缺少 cls"}
    if not ensure_attached():
        return {"ok": False, "err": "未附着: 请先打开 app 或点'重启应用'"}
    extras = d.get("extras")
    try:
        with LOCK:
            if LAUNCH_MODE == "pkg_cls_extras":
                res = SC.exports_sync.launch(PKG, cls, json.dumps(extras) if extras else None)
            elif LAUNCH_MODE == "pkg_cls":
                res = SC.exports_sync.launch(PKG, cls)
            else:  # cls
                res = SC.exports_sync.launch(cls)
    except Exception as e:
        return {"ok": False, "err": str(e)}
    time.sleep(ARGS.sleep)
    fg = ps.foreground()
    s = str(res).lower()
    # 成功 = 非 "ERR"/"no-java"(错误); 目标app异步返回 "queued" 也算成功; 目标app返回 "OK ..."
    ok = (not s.startswith("err")) and (not s.startswith("no-java"))
    return {"ok": ok, "res": str(res), "foreground": fg}


def do_shot(name, wait):
    """截图 + 判定。wait 时对非 VALID 帧(尤其 BLACK/LOADING)重截慢慢放大间隔。"""
    if not ensure_attached():
        return {"ok": False, "err": "未附着"}
    os.makedirs(ARGS.out, exist_ok=True)
    fname = ps.sanitize(name or "current") + ".png"
    fpath = os.path.join(ARGS.out, fname)
    label, metrics, ok = "", None, False
    reps = max(int(ARGS.shot_reps), 1) if wait else 1
    gap = float(ARGS.shot_gap)
    for t in range(reps):
        ok = ps.screencap(fpath)
        if ok:
            try:
                metrics = _an(fpath)
                label = _cl(metrics)
            except Exception as e:
                label = "ERR"
                metrics = {"error": str(e)}
            if label == "VALID":
                break
        if not wait and t == 0:
            break
        time.sleep(gap)
        gap = min(gap * 1.6, 6.0)
    STATE["last"] = {"file": fname, "label": label, "metrics": metrics, "ok": ok}
    return {"ok": ok, "file": fname, "label": label, "metrics": metrics}


def do_screen(name="live"):
    """当前屏幕实时判定(一帧)。"""
    if not ensure_attached():
        return {"ok": False, "err": "未附着"}
    os.makedirs(ARGS.out, exist_ok=True)
    fpath = os.path.join(ARGS.out, "live.png")
    ok = ps.screencap(fpath)
    label, metrics = "", None
    if ok:
        try:
            metrics = _an(fpath)
            label = _cl(metrics)
        except Exception as e:
            label = "ERR"
            metrics = {"error": str(e)}
    return {"ok": ok, "label": label or ("EMPTY" if not ok else ""),
            "fg": ps.foreground(), "metrics": metrics, "file": "live.png"}


def load_activities(path, pkg):
    """从 activities_path 读 Activity 列表: 支持 JSON({"activities":[..]}) 或纯文本(每行一个类名)。
    JSON 项可为 {name/class/component, exported, launcher}; 纯文本每行一个 FQN(空行/#注释跳过)。"""
    if not os.path.exists(path):
        return []
    raw = open(path, encoding="utf-8").read()
    lst = None
    try:
        data = json.loads(raw)
    except Exception:
        data = None
    if isinstance(data, dict):
        lst = data.get("activities") or data.get("acts") or data.get("items") or []
    elif isinstance(data, list):
        lst = data
    entries = []
    if lst is not None:
        for it in lst:
            if isinstance(it, str):
                entries.append({"name": it, "exported": True, "launcher": False})
            elif isinstance(it, dict):
                nm = it.get("name") or it.get("class") or it.get("cls") or it.get("component")
                if not nm:
                    continue
                nm = str(nm)
                if "/" in nm:                      # component "pkg/cls" -> 取 cls
                    nm = nm.rsplit("/", 1)[-1]
                entries.append({"name": nm, "exported": bool(it.get("exported", True)),
                                "launcher": bool(it.get("launcher", False))})
    else:
        for line in raw.splitlines():              # 纯文本: 每行一个类名
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            entries.append({"name": s, "exported": True, "launcher": False})
    seen, out = set(), []
    for e in entries:
        if e["name"] and e["name"] not in seen:
            seen.add(e["name"])
            out.append(e)
    return out


# ------------------------------------------------------------------ HTTP
def render_page():
    acts = load_activities(ACT_PATH, PKG)
    a_rows = "".join(
        '<div class="row"><span class="nm%s">%s</span>'
        '<span class="badge %s">%s</span>'
        '<button class="btn" data-cls="%s">打开</button></div>\n'
        % (" launcher" if a.get("launcher") else "",
           a["name"].split(".")[-1],
           "ex" if a.get("exported") else "nx",
           "导出" if a.get("exported") else "非导出",
           a["name"].replace('"', '&quot;'))
        for a in acts)

    P = """<!doctype html><html><head><meta charset="utf-8">
<title>__TITLE__</title>
<style>
*{box-sizing:border-box}body{font-family:Segoe UI,system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e6e6;font-size:13px}
header{position:sticky;top:0;background:#171a22;padding:10px 16px;display:flex;gap:14px;align-items:center;border-bottom:1px solid #2a2f3a;z-index:5}
header b{font-size:15px} header .dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:5px}
.dot.on{background:#2ecc71}.dot.off{background:#e74c3c}
button{cursor:pointer}
.btn{background:#2b6cb0;color:#fff;border:0;border-radius:4px;padding:4px 9px;font-size:12px}
.btn:hover{background:#3b82c4}.btn.ex{background:#2f7d52}.btn.warn{background:#b03a2e}
#wrap{display:flex;height:calc(100vh - 45px)}
#list{width:56%;overflow:auto;padding:10px 16px;border-right:1px solid #2a2f3a}
#side{flex:1;padding:12px 16px;display:flex;flex-direction:column;gap:12px;overflow:auto}
h3{margin:10px 0 6px;color:#9aa4b5;font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.row{display:flex;gap:8px;align-items:center;padding:3px 4px;border-radius:4px}
.row:hover{background:#1c2530}
.nm{color:#9fe0b0;flex:0 0 auto;min-width:120px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nm.launcher{color:#ffd06b}
.badge{font-size:10px;padding:1px 5px;border-radius:8px;background:#2a2f3a;color:#c3cad6;min-width:42px;text-align:center}
.badge.ex{background:#12462b;color:#7be8a3}.badge.nx{background:#4a3020;color:#f0c28a}
#preview img{max-width:100%;max-height:56vh;border:1px solid #2a2f3a;border-radius:6px;background:#000}
#preview{background:#12151c;border:1px solid #2a2f3a;border-radius:6px;padding:10px;text-align:center}
#fg{color:#c3cad6;font-family:consolas,monospace;font-size:13px}
#hosts{color:#7cc0ff;font-family:consolas,monospace;font-size:12px;list-style:none;margin:0;padding:0;max-height:200px;overflow:auto}
#hosts li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
label{color:#9aa4b5}
.metric{color:#9aa4b5;font-size:12px;white-space:pre-wrap}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tag{display:inline-block;padding:2px 8px;border-radius:8px;font-weight:bold;font-size:12px}
.tag.VALID{background:#12462b;color:#7be8a3}.tag.BLACK{background:#111;color:#888}
.tag.WHITE{background:#222;color:#fff}.tag.LOADING{background:#4a3020;color:#f0c28a}
.tag.EMPTY{background:#4a3020;color:#f0c28a}.tag.ERR{background:#4a3020;color:#f0c28a}
.tag.NA{background:#222;color:#666}
</style></head><body>
<header>
  <b>__TITLE__</b>
  <span>PKG <code>__PKG__</code> PORT <code>__PORT__</code></span>
  <span id="attdot" class="dot off"></span><span id="att">未附着</span>
  <span>前台: <span id="fg">?</span></span>
  <span>当前屏幕: <span id="scr" class="tag NA">?</span></span>
  <span class="tools">
    <button class="btn warn" onclick="relaunch()">重启应用</button>
    <button class="btn" onclick="home()">回首页</button>
    <button class="btn ex" onclick="shot(true)">截图(等真内容)</button>
  </span>
</header>
<div id="wrap">
<div id="list">
  <h3>Activity 直接打开（__NACTS__ 个，点按钮即经 gadget 进程内 startActivity）</h3>
  <div id="acts">__AROWS__</div>
</div>
<div id="side">
  <div>
    <h3>实时捕获主机（rpc.exports.hosts）</h3>
    <ul id="hosts"><li>…</li></ul>
  </div>
  <div id="panel">
    <h3>当前画面（黑屏会标注，非 VALID 可重截）</h3>
    <div id="preview"><img id="im" src=""><div id="imstate" style="margin-top:6px"></div></div>
  </div>
</div>
</div>
<script>
function $(s){return document.querySelector(s)}
function setFg(f){ $('#fg').textContent = f; }
function showMeta(l){
  var c = (l||{}).metrics||{};
  var t = c.error ? '' : ('亮度'+(c.mean_lum??'-')+' 边缘'+(c.edge_density??'-')+' 色数'+(c.distinct??'-')+' 黑'+(c.black_frac??'-')+' 白'+(c.white_frac??'-'));
  $('#imstate').innerHTML = '<span class="tag '+(l.label||'EMPTY')+'">'+(l.label||'EMPTY')+'</span> '+t;
}
async function state(){
  var r = await fetch('/state'); var d = await r.json();
  $('#attdot').className = 'dot ' + (d.attached?'on':'off');
  $('#att').textContent = d.attached? ('已附着['+(d.how||'')+']') : '未附着';
  if(d.fg) setFg(d.fg);
  if(d.last){ $('#im').src = '/img/'+d.last.file+'?t='+Date.now(); showMeta(d.last); }
}
async function hosts(){
  var r = await fetch('/hosts'); var d = await r.json();
  if(!d.ok){ $('#hosts').innerHTML = '<li>'+(d.err||'无 hosts() 导出')+'</li>'; return; }
  if(!d.hosts || !d.hosts.length){ $('#hosts').innerHTML = '<li>（尚未捕获到主机）</li>'; return; }
  $('#hosts').innerHTML = d.hosts.map(function(h){ return '<li>'+h+'</li>'; }).join('');
}
async function screen(){
  var r = await fetch('/screen'); var d = await r.json();
  var lab = d.label || '?'; $('#scr').textContent = lab; $('#scr').className = 'tag '+lab;
  if(d.fg) setFg(d.fg);
}
async function post(url, body){
  var r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
  var d = await r.json(); if(d.foreground) setFg(d.foreground);
  if(!d.ok) alert((d.err||d.res||'失败')); return d;
}
document.addEventListener('click', function(e){
  var b = e.target.closest('button'); if(!b) return;
  if(b.dataset.cls !== undefined){ openCls(b.dataset.cls); }
});
async function openCls(cls){
  var short = cls.split('.').pop();
  var d = await post('/open', {cls:cls});
  if(d.ok){
    var s = await fetch('/shot?name='+encodeURIComponent(short)+'&wait=1').then(function(r){return r.json()});
    if(s.file){ $('#im').src = '/img/'+s.file+'?t='+Date.now(); showMeta(s); }
  }
}
async function shot(wait){
  var s = await fetch('/shot?name='+encodeURIComponent($('#fg').textContent||'cur')+(wait?'&wait=1&reps=8':''));
  var d = await s.json(); if(d.file){ $('#im').src = '/img/'+d.file+'?t='+Date.now(); showMeta(d); }
}
async function relaunch(){ await post('/relaunch'); }
async function home(){ await post('/home'); }
state(); setInterval(state, 5000);
hosts(); setInterval(hosts, 5000);
screen(); setInterval(screen, 3000);
</script>
</body></html>"""
    return (P.replace("__TITLE__", TITLE)
             .replace("__PKG__", PKG)
             .replace("__PORT__", str(PORT))
             .replace("__NACTS__", "%d" % len(acts))
             .replace("__AROWS__", a_rows))


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def _json(self, obj, status=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _serve_png(self, fpath):
        try:
            with open(fpath, "rb") as f:
                data = f.read()
        except OSError:
            self._json({"err": "no image"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)
        if p == "/":
            page = render_page().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
        elif p == "/state":
            self._json({"attached": ATTACHED, "how": HOW, "fg": ps.foreground(), "last": STATE["last"]})
        elif p == "/acts":
            self._json({"pkg": PKG, "activities": load_activities(ACT_PATH, PKG)})
        elif p == "/hosts":
            self._json(get_hosts())
        elif p == "/screen":
            self._json(do_screen())
        elif p == "/shot":
            name = (q.get("name") or ["cur"])[0]
            wait = (q.get("wait") or ["0"])[0] == "1"
            self._json(do_shot(name, wait))
        elif p.startswith("/img/"):
            name = os.path.basename(p[len("/img/"):])
            fpath = os.path.join(ARGS.out, name)
            if not os.path.exists(fpath):
                self._json({"err": "no image"}, 404)
                return
            self._serve_png(fpath)
        else:
            self._json({"err": "404"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length", 0))
        try:
            d = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            d = {}
        if u.path == "/open":
            self._json(do_open(d))
        elif u.path == "/relaunch":
            subprocess.run([ps.ADB, "shell", "monkey", "-p", PKG, "-c",
                            "android.intent.category.LAUNCHER", "1"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
            time.sleep(1.5)
            ok = ensure_attached()
            time.sleep(1.0)
            self._json({"ok": ok, "foreground": ps.foreground()})
        elif u.path == "/home":
            ps.go_home(PKG, None, 1.5)
            self._json({"ok": True, "foreground": ps.foreground()})
        else:
            self._json({"err": "404"}, 404)


def _resolve(base, p):
    """相对路径用 base 解析(不存在则回退 cwd), 绝对路径原样。"""
    p = os.path.expanduser(p)
    if os.path.isabs(p):
        return p
    cand = os.path.join(base, p)
    if os.path.exists(cand):
        return cand
    return p


def main():
    global ARGS, PKG, PROC, PORT, ACT_PATH, HOOK, TITLE
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default=None, help="配置文件 JSON(含 pkg/process/port/activities_path/hook_js_path/title)")
    ap.add_argument("--pkg", default=None)
    ap.add_argument("--process", default=None)
    ap.add_argument("--port", type=int, default=None)          # gadget 端口(配置的 port)
    ap.add_argument("--acts", default=None, help="activities 列表文件(JSON 或 每行一个类名)")
    ap.add_argument("--hook", default=None, help="frida hook/agent 脚本路径")
    ap.add_argument("--title", default=None)
    ap.add_argument("--launch-mode", default=None, choices=["auto", "cls", "pkg_cls", "pkg_cls_extras"])
    ap.add_argument("--out", default="screen")
    ap.add_argument("--sleep", type=float, default=3.0)
    ap.add_argument("--shot-reps", type=int, default=6)
    ap.add_argument("--shot-gap", type=float, default=2.5)
    ap.add_argument("--adb", default=r"C:\Users\13245\Desktop\yongde\scrcpy\adb.exe")
    ARGS = ap.parse_args()

    conf = {}
    base = os.getcwd()
    if ARGS.app:
        conf = json.load(open(ARGS.app, encoding="utf-8"))
        base = os.path.dirname(os.path.abspath(ARGS.app))

    PKG = ARGS.pkg or conf.get("pkg") or "com.example.app"
    PROC = ARGS.process or conf.get("process") or PKG
    PORT = int(ARGS.port or conf.get("port") or 14725)
    ACT_PATH = ARGS.acts or conf.get("activities_path") or DEFAULT_ACT
    HOOK = ARGS.hook or conf.get("hook_js_path") or DEFAULT_HOOK
    TITLE = ARGS.title or conf.get("title") or "页面控制台"
    # 相对路径以配置文件目录(无配置则 cwd)为准
    ACT_PATH = _resolve(base, ACT_PATH)
    HOOK = _resolve(base, HOOK)
    ARGS.launch_mode = ARGS.launch_mode or conf.get("launch_mode", "auto")

    ps.ADB = ARGS.adb
    os.makedirs(ARGS.out, exist_ok=True)

    try:
        ensure_attached()
    except Exception as e:
        print("[!] startup attach: %s" % e, flush=True)

    srv = ThreadingHTTPServer(("127.0.0.1", 8000), H)
    print("[*] 控制台: http://127.0.0.1:8000/  (Ctrl+C 退出)  pkg=%s port=%s" % (PKG, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with LOCK:
            if SC:
                try:
                    SC.unload()
                except Exception:
                    pass
            if SESS:
                try:
                    SESS.detach()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
