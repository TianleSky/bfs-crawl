# -*- coding: utf-8 -*-
"""app_crawl.py — 可复用的 Android App 「UI BFS 爬虫」 (触发所有动态加载流程 / WebView-H5 页)

用途: 对任意 Android app 做 UI 广度优先遍历, 自动逐一点击可点控件 / 切换 tab / 进入菜单,
      触发出静态分析看不到的「动态加载 flow」(WebView/H5/懒加载 JS → 新接口)。
      遍历过程产生的网络流量由 Burp 代理捕获(外部), 本脚本产出:
        1. 所有去重 UI 状态指纹(state_hash)
        2. 命中的 Activity / Fragment
        3. 检测到的 WebView 宿(整屏 WebView 或 X5 内核), 及可解析出的 HTTP(S) 链接
        4. 遍历路径 / 点击历史, 便于分析导航图

「在别的 app 也可复用」: 只需改 --pkg (可选 --start-activity), 其余逻辑通用。

用法(需 adb + root 或可 shell input):
  python -u scripts/app_crawl.py --pkg com.example.app
  python -u scripts/app_crawl.py --pkg com.example.app --start-activity .MainActivity --max-states 80 --delay 3

输出: reports/crawl_<pkg>.json
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

FILTER_IDS = ("action_bar_root", "content", "viewPagerLayout")  # 容器节点, 不作点击目标
TAP_FALLBACK = (540, 1200)   # 若某状态找不到可点控件, 试探中心


def adb(*a, use_root=True):
    # 关键: su -c 后必须单字符串命令, 否则 su 只取第一个词当命令、丢后面参数(如 input tap x y 会退化成 input)。
    # 本 app 屏蔽 shell(uid2000) 的 input 注入, 必须走 su 且拼成单字符串才生效。
    cmd = ["adb", "shell"]
    if use_root:
        cmd += ["su", "-c", " ".join(a)]
    else:
        cmd += list(a)
    return subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")


def sh(*a):
    return subprocess.run(["adb", "shell", *a], capture_output=True, encoding="utf-8", errors="replace")


def is_rooted():
    return sh("id").stdout.strip().startswith("uid=0") or "su" in sh("which su").stdout


def ui_dump(pkg):
    """uiautomator dump → (xmltext, [node dict])。返回空列表表示 dump 失败。"""
    path = "/data/local/tmp/udump.xml"
    xml = ""
    for _try in range(4):          # dump 偶发写空文件 -> 重试
        adb("uiautomator", "dump", path)
        time.sleep(0.3)
        xml = sh("cat", path).stdout
        if xml and "<hierarchy" in xml:
            break
        time.sleep(0.6)
    if not xml or "<hierarchy" not in xml:
        return xml, []
    nodes = []
    for m in re.finditer(r"<node[^>]*>", xml):
        n = m.group(0)
        def g(attr):
            mm = re.search(attr + r'="([^"]*)"', n)
            return mm.group(1) if mm else ""
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        text = g("text") or g("content-desc") or ""
        clickable = g("clickable") == "true"
        cls = g("class")
        rid = g("resource-id")
        w, h = x2 - x1, y2 - y1
        # 忽略过小/容器/纯背景节点
        if w < 8 or h < 8:
            continue
        nodes.append({
            "text": text, "class": cls, "rid": rid,
            "clickable": clickable, "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "cx": (x1 + x2) // 2, "cy": (y1 + y2) // 2,
            "w": w, "h": h,
        })
    return xml, nodes


def state_hash(xml):
    """由 view 层级(类+text+resource-id) 生成归一化指纹, 用于去重。"""
    body = re.findall(r'class="([^"]*)"[^>]*?resource-id="([^"]*)"', xml)
    s = "|".join("%s#%s" % (c.split(".")[-1], rid) for c, rid in body)
    return hashlib.md5(s.encode("utf-8", "ignore")).hexdigest()[:12]


def foreground(pkg):
    out = sh("dumpsys", "activity", "activities").stdout
    m = re.search(r"mResumedActivity:.*?com\.\S+/(\S+)", out)
    if not m:
        m = re.search(r"ResumedActivity:.*?/(\S+)", out)
    return m.group(1).split("/")[-1] if m else "?"


def webview_hosts(nodes, xml):
    """是否本屏存在 WebView 宿(或有可解析 URL)。返回 (has_webview, urls[])。"""
    has_wv = any(("WebView" in n["class"]) or ("SmttWebView" in n["class"]) or ("X5WebView" in n["class"]) for n in nodes)
    urls = re.findall(r'https?://[^\s"\'<>\\]+', xml)
    return has_wv, urls


def tap(x, y):
    adb("input", "tap", str(int(x)), str(int(y)))


def back():
    adb("input", "keyevent", "4")


def swipe(x1, y1, x2, y2, ms=300):
    adb("input", "swipe", str(int(x1)), str(int(y1)), str(int(x2)), str(int(y2)), str(int(ms)))


def launch(pkg, activity=None):
    comp = pkg + "/" + activity if activity else pkg
    adb("am", "start", "-n", comp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", required=True)
    ap.add_argument("--start-activity")
    ap.add_argument("--max-states", type=int, default=60)
    ap.add_argument("--max-depth", type=int, default=5)
    ap.add_argument("--delay", type=float, default=2.5)
    ap.add_argument("--root", action="store_true", default=False)
    ap.add_argument("--out", default="reports")
    args = ap.parse_args()

    # 根探测: 优先尝试普通 shell, 失败再 su
    rooted = is_rooted()
    global _use_root
    _use_root = rooted or args.root
    print("[*] rooted=%s  pkg=%s" % (rooted, args.pkg), flush=True)

    if args.start_activity:
        launch(args.pkg, args.start_activity)
        time.sleep(2)

    visited = {}       # state_hash -> dump of info
    frontier = []      # (state_hash, url_or_None, urls, has_wv, nodes) 未验证
    seen_urls = set()
    webviews = set()
    max_states = args.max_states

    queue = []

    def enqueue(new_nodes, depth):
        # 选择点击候选: 优先可点 + 有文字 + 面积中等
        cands = [n for n in new_nodes if n["clickable"]]
        if not cands:
            cands = [n for n in new_nodes if n["text"].strip()]
        # 排序: 底部 tab(y 靠底=主导航)优先, 再 text, 再面积。本 app 主导航在底部 tab 栏,
        #   不优先点它就会停在点文本死胡同(如"用户空态/个人页"), BFS 卡 1 state。
        cands.sort(key=lambda n: (-n["cy"], 0 if n["text"].strip() else 1, n["w"] * n["h"]))
        for n in cands[:14]:
            queue.append(((n["cx"], n["cy"]), n["text"][:24], depth, n))

    xml, nodes = ui_dump(args.pkg)
    h = state_hash(xml or "")
    visited[h] = {"activity": foreground(args.pkg), "urls": [], "count": nodes.__len__()}
    enqueue(nodes, 0)

    # 加入 sw变/返回 作为兜底导航
    state_count = 1
    steps = 0
    max_steps = max_states * 10
    while queue and state_count < max_states and steps < max_steps:
        steps += 1
        (x, y), label, depth, node = queue.pop(0)
        if label and ("back" in label.lower() or "return" in label.lower()):
            continue
        # 记录点击前
        pre = foreground(args.pkg)
        tap(x, y)
        time.sleep(args.delay)

        xml2, nodes2 = ui_dump(args.pkg)
        if not nodes2:
            back()
            time.sleep(1)
            continue
        h2 = state_hash(xml2)
        act = foreground(args.pkg)
        has_wv, urls = webview_hosts(nodes2, xml2)
        for u in urls:
            if u:
                seen_urls.add(u)
        if has_wv:
            webviews.add((act, len(urls)))
        if h2 in visited:
            # 死胡同/重复: 返回再继续
            # 但如果本次点击打开了 WebView 且为新 URL, 仍记录
            back()
            time.sleep(0.8)
            continue
        visited[h2] = {
            "activity": act, "count": len(nodes2),
            "webview": has_wv, "urls": urls, "depth": depth,
            "parent_state": h, "tapped": label,
        }
        state_count += 1
        print("[%d] %-28s act=%s webview=%s url=%s" % (
            state_count, label[:26] or "(tap)", act, has_wv, urls[0][:60] if urls else ""), flush=True)
        # 记录可达 URL / 尝试深入
        if depth < args.max_depth:
            enqueue(nodes2, depth + 1)
        else:
            back()
            time.sleep(0.8)

    os.makedirs(args.out, exist_ok=True)
    slug = args.pkg.replace(".", "_")
    report = {
        "pkg": args.pkg, "states_visited": len(visited),
        "activities": sorted({v["activity"] for v in visited.values()}),
        "webview_screens": sorted(webviews),
        "urls_seen": sorted(seen_urls),
        "states": visited,
    }
    outp = os.path.join(args.out, "crawl_%s.json" % slug)
    with open(outp, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print("\n[*] DONE states=%d webview_screens=%d urls=%d" % (
        len(visited), len(webviews), len(seen_urls)), flush=True)
    print("[*] report:", outp, flush=True)
    print("[*] H5/web urls:", flush=True)
    for u in sorted(seen_urls):
        print("   ", u, flush=True)


if __name__ == "__main__":
    _use_root = False
    main()
