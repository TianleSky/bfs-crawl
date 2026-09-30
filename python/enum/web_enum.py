# -*- coding: utf-8 -*-
"""web_enum.py — 自愈枚举: 用 frida 跳转每个 Activity/ARouter 路由, 长等待加载, 抓动态加载的 H5/JS/API URL。
   全程监控: 若 app 死在 logo/启动页(卡死) -> 自动 force-stop+cold-start+竞速重附着(复用 capture_race 思路)续跑。
   输出: <out>/web_enum_report.json + 汇总打印(activity + label + URL)。
用法: python -u scripts/web_enum.py --pkg com.example.app --out dast-scan/web_enum
"""
import argparse, json, os, re, subprocess, sys, time
import frida
from page_snap import (ADB, adb, foreground, pidof, screencap, sanitize, attach_hook)
from classify_screenshot import analyze as _an, classify as _cl

HEREDIR = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HEREDIR, "web_enum_hook.js")
ADDR = "127.0.0.1:14725"

def sh(*a, **k):
    return subprocess.run([ADB, "shell", *a], capture_output=True, text=True, encoding="utf-8", errors="replace", **k)

def find_pid():
    # 复用 capture_race: 从 gadget 监听端口 14725 的 ss 输出解析 pid(勿匹配 da2)
    r = subprocess.run([ADB, "shell", "su", "-c", "ss -tlnp | grep 14725"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    m = re.search(r'app[^"]*",pid=(\d+)', r)
    return m.group(1) if m else None

def is_splash_like(metrics):
    """目标app logo 启动页(深绿, 目标app标志): 低亮度 + 低纹理, 判定 LOADING/BLACK 且 lum<60。"""
    if not metrics:
        return False
    lab = metrics.get("label")
    lum = metrics.get("mean_lum", 999)
    return (lab in ("LOADING", "BLACK", "EMPTY")) and lum < 60

def restart_launch(pkg, act_component, on_msg=None, setup_done=False):
    """force-stop + am start + 竞速 attach + load/resume。内部重试直到 app 活过 AMS 窗口。
       返回已就绪的 (dev, sess, sc, pid); 全部失败返回 None。"""
    for t in range(7):
        subprocess.run([ADB, "forward", "tcp:14725", "tcp:14725"],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run([ADB, "shell", "su", "-c", "am force-stop " + pkg], stdout=subprocess.DEVNULL)
        subprocess.run([ADB, "shell", "logcat", "-c"], stdout=subprocess.DEVNULL)
        subprocess.run([ADB, "shell", "am", "start", "-n", act_component], stdout=subprocess.DEVNULL)
        pid = None; t0 = time.time()
        while time.time() - t0 < 12:
            pid = find_pid()
            if pid:
                break
            time.sleep(0.15)
        if not pid:
            print("[.] restart 尝试 %d: 无 pid, 重试" % (t + 1)); continue
        try:
            dev = frida.get_device_manager().add_remote_device(ADDR)
            sess = dev.attach(int(pid))
            sc = sess.create_script(open(HOOK, encoding="utf-8").read())
            if on_msg:
                sc.on("message", on_msg)
            sc.load()
            try: sess.resume()
            except Exception: pass
            time.sleep(11)          # 等过 ~10s AMS 窗口
            if pidof(pkg):          # 存活 -> 就绪
                print("[+] restart 成功(尝试 %d) pid=%s" % (t + 1, pid))
                return dev, sess, sc, pid
            print("[.] restart 尝试 %d: pid=%s 被 AMS 杀, 重试" % (t + 1, pid))
            try: sess.detach()
            except Exception: pass
        except Exception as e:
            print("[.] restart 尝试 %d err %s" % (t + 1, e))
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", default="com.example.app")
    ap.add_argument("--acts", default="dast-scan/activities.json")
    ap.add_argument("--routes", default="dast-scan/routes.json")
    ap.add_argument("--out", default="dast-scan/web_enum")
    ap.add_argument("--wait", type=float, default=6.0, help="每页长等待(等加载)")
    ap.add_argument("--max-pages", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    acts = json.load(open(args.acts, encoding="utf-8"))["activities"]
    routes = [r for r in json.load(open(args.routes, encoding="utf-8"))["routes"] if r["class"].endswith("Activity")]
    launcher = next((a["component"] for a in acts if a.get("launcher")), args.pkg)
    home_comp = args.pkg + "/" + launcher.split("/")[-1] if "/" not in launcher else launcher

    # ---- 收集 URL(先定义, 供 attach/restart 使用) ----
    urls = set(); visited = {}
    def on_msg(m, d):
        p = m.get("payload")
        if isinstance(p, str) and p.startswith("[URL]"):
            url = p.split(" ", 2)[-1].strip()
            if len(url) > 10 and not url.startswith("??"):
                urls.add(p)
                print("  [URL] %s" % p[:140], flush=True)

    # ---- 附着(优先当前已跑进程, 无则重启) ----
    dev = sess = sc = None; pid = None; HOW = "attach"
    if pidof(args.pkg):
        try:
            dev = frida.get_device_manager().add_remote_device(ADDR)
            sess = dev.attach(int(pidof(args.pkg)))
            sc = sess.create_script(open(HOOK, encoding="utf-8").read())
            sc.on("message", on_msg); sc.load()
            try: sess.resume()
            except Exception: pass
            pid = pidof(args.pkg); time.sleep(1.5)
        except Exception as e:
            print("[!] attach fail %s -> restart" % e); dev = sess = sc = None
    if sess is None:
        r = restart_launch(args.pkg, launcher, on_msg=on_msg); HOW = "restart"
        if r is None:
            print("[X] 无法启动/附着 app"); sys.exit(2)
        dev, sess, sc, pid = r
    print("[*] %s pid=%s 页数(routes=%d) wait=%.1fs" % (HOW, pid, len(routes), args.wait), flush=True)

    # ---- 逐路由跳转 + 长等待 + 采集 ----
    def snap(name):
        fname = sanitize(name) + ".png"
        fpath = os.path.join(args.out, fname)
        ok = screencap(fpath)
        label, metrics = "", None
        if ok:
            try: metrics = _an(fpath); label = _cl(metrics)
            except Exception as e: label = "ERR"; metrics = {"error": str(e)}
        return fpath, label, metrics

    HOME_ACT = "com.app.oc.business.home.ui.HomeActivity"

    def bring_app_front():
        """若 app 退到桌面(launcher 在前台), 用 am start 起 exported 的 LoginActivity 把 app 任务带回来。
           (进程内 startActivity 被 Android10+ 后台启动限制拦, 且 app 多数活动非 exported 起不了; launcher LoginActivity 是 exported。)"""
        try:
            cf = foreground() or ""
            if "miui.home" in cf or "app" not in cf:
                subprocess.run([ADB, "shell", "am", "start", "-n",
                                "com.example.app/.business.home.LoginActivity"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                time.sleep(3.0)
                return True
            return False
        except Exception as e:
            print("[!] bring_front %s" % e); return False

    report = []
    N = 0
    stuck_run = 0; restarts = 0
    for r in routes:
        path = r["path"]; cls = r["class"]
        if args.max_pages and N >= args.max_pages:
            break
        N += 1
        bring_app_front()          # 确保 app 在前台再跳
        before = len(urls)
        try:
            res = sc.exports_sync.jump(path, None)
        except Exception as e:
            print("[%d] %-40s jump ERR %s" % (N, path, e), flush=True); continue
        time.sleep(args.wait)
        fg = foreground()
        fpath, label, metrics = snap(path.strip("/").replace("/", "__"))
        got = list(urls)[before:]
        rec = {"idx": N, "route": path, "class": cls, "foreground": fg,
               "label": label, "image": os.path.basename(fpath), "urls": got}
        report.append(rec)
        print("[%02d] %-42s -> %-30s label=%-7s urls=+%d %s" % (
            N, path, fg, label, len(got), ("".join(got)[:70] if got else "")), flush=True)
        visited.setdefault(fg, 0); visited[fg] += 1

        # ---- 自愈: 连续 2 条路由 splash(卡 logo) 或进程死 -> 自动重启(按用户指令: 卡 logo 就重启) ----
        splash_like = is_splash_like({"label": label, "mean_lum": (metrics or {}).get("mean_lum", 999)})
        if pidof(args.pkg) is None or splash_like:
            stuck_run += 1
        else:
            stuck_run = 0
        if pidof(args.pkg) is None or stuck_run >= 2:
            restarts += 1
            print("[+] 自愈重启 #%d (%s)" % (restarts, "dead" if pidof(args.pkg) is None else "splash"), flush=True)
            try: sess.detach()
            except Exception: pass
            r2 = restart_launch(args.pkg, launcher, on_msg=on_msg)
            if r2 is None:
                print("[X] 重启失败 终止", flush=True); break
            dev, sess, sc, pid = r2       # 已就绪(load+resume 完成)
            time.sleep(2.0)
            stuck_run = 0
        time.sleep(0.6)

    # ---- 汇总 ----
    agg_acts = {}
    for rec in report:
        agg_acts.setdefault(rec["foreground"], {"count": 0, "labels": set(), "urls": set()})
        a = agg_acts[rec["foreground"]]
        a["count"] += 1
        a["labels"].add(rec["label"]); a["urls"].update(rec["urls"])
    unique_urls = sorted(set(u for rec in report for u in rec["urls"]))
    summary = {
        "pkg": args.pkg, "pages_tested": len(report),
        "restarts": 0,  # 简单计数(可由日志统计)
        "activities_reached": sorted(agg_acts.keys()),
        "activities_detail": {k: {"count": v["count"], "labels": sorted(v["labels"])} for k, v in agg_acts.items()},
        "unique_urls": unique_urls, "unique_url_count": len(unique_urls),
        "pages": report,
    }
    with open(os.path.join(args.out, "web_enum_report.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print("\n===== 枚举汇总 =====", flush=True)
    print("测试页数=%d  到达不同 Activity=%d  去重URL=%d" % (len(report), len(agg_acts), len(unique_urls)), flush=True)
    print("活动列表:", ", ".join(sorted(agg_acts.keys())), flush=True)
    print("\n动态加载 URL(去重):", flush=True)
    for u in unique_urls:
        print("  " + u[:160], flush=True)

if __name__ == "__main__":
    main()
