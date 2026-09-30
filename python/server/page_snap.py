# -*- coding: utf-8 -*-
"""page_snap.py — 对 app 的每个 Activity 逐个启动 + 截图, 上传到电脑 <out>/ 并以 Activity 类名为图片名。
可复用(任意 app, 改 --pkg/--acts 即可)。

两种启动模式:
  --mode hook  (默认)  进程内 frida hook 启动, 可开【非导出】Activity(绕过 exported SecurityException)。
                      需目标 app 上跑 gadget/frida-server, 且 Java 桥接可用。端口用 --port(默认14725, 本机 gadget)。
  --mode am           adb am start -n (root), 只能开导出 Activity; 无需 frida, 更通用但对非导出无效。

截图: `adb exec-out screencap -p > <out>/<ActivityFQN>.png`(二进制安全, Windows 可用)。
数据: dast-scan/activities.json(由 activities_map.py 生成)。每个 Activity 的启动状态记到 <out>/capture_log.json。

用法:
  python -u scripts/page_snap.py --pkg com.example.app --acts dast-scan/activities.json --out screen --mode hook
  python -u scripts/page_snap.py --pkg com.example.app --acts dast-scan/activities.json --out screen --max 8   # 快速试跑
  python -u scripts/page_snap.py --pkg com.example.app --acts dast-scan/activities.json --mode am --max 5
"""
import argparse, json, os, re, subprocess, sys, time

PKG = "com.example.app"
ADB = r"C:\Users\13245\Desktop\yongde\scrcpy\adb.exe"
INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

def adb(*a, root=True):
    return subprocess.run([ADB, "shell"] + (["su", "-c"] if root else []) + list(a),
                          capture_output=True, text=True, encoding="utf-8", errors="replace")

def sh(*a):
    return subprocess.run([ADB, "shell", *a], capture_output=True, text=True, encoding="utf-8", errors="replace")

def foreground():
    c = sh("dumpsys", "activity", "activities").stdout or ""
    m = re.search(r"mResumedActivity:.*?com\.\S+/(\S+)", c, re.S)
    if not m:
        m = re.search(r"ResumedActivity:.*?/(\S+)", c, re.S)
    return m.group(1).split("/")[-1] if m else "?"

def pidof(pkg):
    r = sh("pidof", pkg)
    return r.stdout.split()[0] if r.stdout.split() else None

def find_gadget_pid(port):
    r = sh("su", "-c", "ss -tlnp | grep %s" % port)
    m = re.search(r'",pid=(\d+)', r.stdout or "")
    return m.group(1) if m else None

def sanitize(name):
    return INVALID.sub("_", name)

def screencap(out_path):
    # exec-out 直接以二进制写文件(Windows 下安全)
    with open(out_path, "wb") as f:
        subprocess.run([ADB, "exec-out", "screencap", "-p"], stdout=f, stderr=subprocess.DEVNULL, shell=False)
    return os.path.exists(out_path) and os.path.getsize(out_path) > 100

def go_home(pkg, home_comp, sleep=2.0):
    """回到 app 的 launcher(Home 或已登录状态)。
    ⚠️ 勿用 am start -n <非导出 MainActivity>: HomeActivity 非导出 -> SecurityException, 栈不清理, 产生黑/过渡帧。
    改用 monkey LAUNCHER intent: 无论 launcher 是否 exported 都能把 app 带回前台。"""
    subprocess.run([ADB, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
    time.sleep(sleep)

def attach_hook(port, pkg):
    """返回 (sess, script) 或 None。优先 USB frida-server, 其次 remote gadget 端口。"""
    import frida
    # 1) USB frida-server / gadget 自动附着
    try:
        dev = frida.get_usb_device(timeout=4)
        sess = dev.attach(pkg)
        return dev, sess, "usb"
    except Exception:
        pass
    # 2) remote gadget(本机场景)
    subprocess.run([ADB, "forward", "tcp:%s" % port, "tcp:%s" % port],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        dev = frida.get_device_manager().add_remote_device("127.0.0.1:%s" % port)
        # 主进程 pid: 优先 adb pidof(最通用); ss 可能匹配到 da2/gadget 线程(勿用)
        pid = pidof(pkg) or find_gadget_pid(port)
        if not pid:
            return None, None, None
        sess = dev.attach(int(pid))
        return dev, sess, "remote"
    except Exception:
        return None, None, None

HOOK_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jump_hook.js")

def main():
    gl = argparse.ArgumentParser()
    gl.add_argument("--pkg", default=PKG)
    gl.add_argument("--acts", default="dast-scan/activities.json")
    gl.add_argument("--out", default="screen")
    gl.add_argument("--mode", default="hook", choices=["hook", "am"])
    gl.add_argument("--port", type=int, default=14725)
    gl.add_argument("--home", default=None, help="HomeActivity 完整类名, 默认取 launcher")
    gl.add_argument("--sleep", type=float, default=3.0)
    gl.add_argument("--max", type=int, default=0, help="0=全部")
    gl.add_argument("--only", default="all", choices=["all", "exported", "nonexported"])
    gl.add_argument("--exclude", default="", help="逗号分隔的类名子串, 跳过")
    gl.add_argument("--adb", default=r"C:\Users\13245\Desktop\yongde\scrcpy\adb.exe")
    args = gl.parse_args()
    globals()["ADB"] = args.adb

    data = json.load(open(args.acts, encoding="utf-8"))
    acts = data["activities"]
    if args.only == "exported":
        acts = [a for a in acts if a["exported"]]
    elif args.only == "nonexported":
        acts = [a for a in acts if not a["exported"]]
    if args.exclude:
        ex = args.exclude.split(",")
        acts = [a for a in acts if not any(e in a["name"] for e in ex)]
    if args.max:
        acts = acts[:args.max]

    launcher = next((a["component"] for a in data["activities"] if a.get("launcher")), None)
    home_comp = args.home or launcher or (args.pkg + "/" + args.pkg)

    os.makedirs(args.out, exist_ok=True)
    sess = sc = None
    if args.mode == "hook":
        dev, sess, how = attach_hook(args.port, args.pkg)
        if sess is None:
            print("[!] frida attach 失败, 回退 am 模式(仅导出)"); args.mode = "am"
        else:
            print("[*] attach via %s" % how, flush=True)
            sc = sess.create_script(open(HOOK_JS, encoding="utf-8").read())
            def on_msg(m, d):
                if m.get("type") in ("send", "log"):
                    pass
                elif m.get("type") == "error":
                    print("[err]", (m.get("stack") or m.get("description"))[:200], flush=True)
            sc.on("message", on_msg); sc.load()
            try: sess.resume()
            except Exception: pass
            time.sleep(0.6)

    log = []
    try:
        for i, a in enumerate(acts, 1):
            name = a["name"]
            fg0 = foreground()
            if args.mode == "hook":
                try:
                    sc.exports_sync.launch(args.pkg, name, None)
                except Exception as e:
                    print("[!] launch err %s: %s" % (name, e), flush=True); continue
            else:
                adb("am", "start", "-n", a["component"])
            time.sleep(args.sleep)
            cur = foreground()
            state = "OPEN" if ("Activity" in cur and "HomeActivity" not in cur and cur not in ("?", "")) else "REDIR"
            fname = "%s.png" % sanitize(name)
            fpath = os.path.join(args.out, fname)
            ok_img = screencap(fpath)
            log.append({"activity": name, "foreground": cur, "state": state, "image": fname, "captured": ok_img})
            print("[%02d/%02d %-6s] %-66s -> %-26s img=%s" % (
                i, len(acts), state, name, cur, ("OK" if ok_img else "FAIL")), flush=True)
            # 回到 Home, 避免堆栈
            go_home(args.pkg, home_comp, 1.2)
    finally:
        if sc:
            try: sc.unload()
            except Exception: pass
        if sess:
            try: sess.detach()
            except Exception: pass

    with open(os.path.join(args.out, "capture_log.json"), "w", encoding="utf-8") as f:
        json.dump({"pkg": args.pkg, "mode": args.mode, "out": args.out,
                   "open": sum(1 for x in log if x["state"] == "OPEN"),
                   "total": len(log), "captures": log}, f, ensure_ascii=False, indent=1)
    print("\n[*] DONE total=%d open=%d imgs=%d" % (
        len(log), sum(1 for x in log if x["state"] == "OPEN"),
        sum(1 for x in log if x.get("captured"))), flush=True)
    print("[*] images -> %s/" % args.out)

if __name__ == "__main__":
    main()
