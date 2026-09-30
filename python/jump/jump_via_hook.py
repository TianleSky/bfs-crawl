# -*- coding: utf-8 -*-
"""jump_via_hook.py — 经 gadget(14725) 挂 Java 桥接 jump_hook.js:
  - 实时打印 app 内部的 Activity 导航日志 (hook startActivity) -> 还原跳转地图+必需 extras
  - --launch <pkg> <cls> [extrasJson]: 在 app 自己 uid 内启动任意 Activity(绕过非 exported)
  - --sweep [--exported]: 从 app 上下文逐个启动 (可越过 SecurityException)
用法:
  python scripts/jump_via_hook.py                 # 只打印 NAV 日志(挂 30s)+ 起一个本地监听
  python scripts/jump_via_hook.py --launch com.example.app com.app.oc.business.message.ui.MessageActivity '{"chatId":"1"}'
  python scripts/jump_via_hook.py --sweep --exported
"""
import frida, time, re, sys, subprocess, json, os

ADB = r"C:\Users\13245\Desktop\yongde\scrcpy\adb.exe"
ADDR = "127.0.0.1:14725"
PKG = "com.example.app"
HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jump_hook.js")


def adb(*a):
    return subprocess.run([ADB, "shell", *a], capture_output=True, text=True, encoding="utf-8", errors="replace")


def foreground():
    c = adb("dumpsys", "activity", "activities").stdout or ""
    m = re.search(r"mResumedActivity:.*?com\.\S+/(\S+)", c, re.S)
    return m.group(1).split("/")[-1] if m else "?"


def find_pid():
    r = adb("su", "-c", "ss -tlnp | grep 14725")
    m = re.search(r'app[^"]*",pid=(\d+)', r.stdout)
    return int(m.group(1)) if m else None


def main():
    args = sys.argv[1:]
    subprocess.run([ADB, "forward", "tcp:14725", "tcp:14725"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pid = find_pid()
    if not pid:
        print("[-] no gadget pid"); sys.exit(2)
    print("[*] attach pid=%s" % pid, flush=True)
    dev = frida.get_device_manager().add_remote_device(ADDR)
    sess = dev.attach(pid)

    def on_msg(m, d):
        t = m.get("type")
        if t == "send":
            print("[send]", m.get("payload"), flush=True)
        elif t == "log":
            s = str(m.get("message", "")).strip()
            if s: print("  " + s, flush=True)
        elif t == "error":
            print("[err]", (m.get("stack") or m.get("description") or "")[:300], flush=True)

    sc = sess.create_script(open(HOOK, encoding="utf-8").read())
    sc.on("message", on_msg)
    sc.load()
    try: sess.resume()
    except Exception: pass
    print("[*] hook loaded.", flush=True)

    # 触发远程命令
    if args and args[0] == "--launch":
        pkg = args[1] if len(args) > 1 else PKG
        cls = args[2]
        ex = args[3] if len(args) > 3 else None
        if ex:
            ex = ex.replace("\\\"", "\"")
        res = sc.exports_sync.launch(pkg, cls, ex)
        print("[*] launch rv=", res, flush=True)
        time.sleep(2.5)
        print("[*] foreground=", foreground(), flush=True)
        time.sleep(2)
        return

    if args and args[0] == "--sweep":
        data = json.load(open(os.path.join("..", "dast-scan", "activities.json"), encoding="utf-8"))
        targets = data["activities"]
        if "--exported" in args:
            targets = [a for a in targets if a["exported"]]
        print("[*] sweep %d activities from app context" % len(targets), flush=True)
        ok = fail = 0
        for a in targets:
            fg0 = foreground()
            try:
                res = sc.exports_sync.launch(PKG, a["name"], None)
            except Exception as e:
                res = "ERR " + str(e)
            time.sleep(2)
            cur = foreground()
            # 成功=前台是目标 Activity(字符串含 "Activity" 且不是 Home/占位); 失败=回到 Home 或读不到
            good = ("Activity" in cur) and ("HomeActivity" not in cur) and cur not in ("?", "", "null")
            print("  %-4s %-70s -> %-28s (%s)" % ("OK" if good else ".. ", a["name"], cur, (res or "")[:30]), flush=True)
            ok += good; fail += (not good)
            adb("am", "start", "-n", PKG + "/com.app.oc.business.home.ui.HomeActivity"); time.sleep(0.8)
        print("[*] OK=%d fail=%d" % (ok, fail), flush=True)
        return

    # 默认: 只打印 NAV 日志 HOLD 秒
    hold = int(float(args[1])) if len(args) > 1 else 30
    print("[*] logging NAV for %ds ... (drive the app with app_crawl.py in parallel)" % hold, flush=True)
    time.sleep(hold)
    print("[*] done", flush=True)


if __name__ == "__main__":
    main()
