# -*- coding: utf-8 -*-
"""dump_mem_regex.py — 把 app 进程内存 dump 到 PC 本地, 按 hae_jskey_rules.json 正则匹配敏感信息。
重点提取 JS 里的: 新JS / API路径 / key(MAC_key/app_key/token/secret/JWT/签名)。
可复用: 直接跑即可, 换 app 改 --pkg。产物 <out>/sensitive_findings.json + 汇总打印。
用法: python -u scripts/dump_mem_regex.py --pkg com.example.app --out dast-scan/sens
"""
import argparse, json, os, re, subprocess, sys, time
import frida

ADB = r"C:\Users\13245\Desktop\yongde\scrcpy\adb.exe"
ADDR = "127.0.0.1:14725"
HERE = os.path.dirname(os.path.abspath(__file__))
MEMJS = os.path.join(HERE, "mem_dump.js")
RULES = os.path.join(HERE, "hae_jskey_rules.json")
DEVFILE = "/data/data/com.example.app/files/memdump.bin"

def adb_ssh(*a):
    return subprocess.run([ADB, "shell", *a], capture_output=True, text=True, encoding="utf-8", errors="replace")

def run(*a):
    return subprocess.run([ADB, *a], capture_output=True, text=True, encoding="utf-8", errors="replace")

def attach(pkg):
    subprocess.run([ADB, "forward", "tcp:14725", "tcp:14725"], stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dev = frida.get_device_manager().add_remote_device(ADDR)
    pid = None
    r = adb_ssh("su", "-c", "ss -tlnp | grep 14725").stdout
    m = re.search(r'app[^"]*",pid=(\d+)', r)
    pid = m.group(1) if m else None
    if not pid:
        print("[X] 无 gadget 进程(先开 app)"); sys.exit(2)
    sess = dev.attach(int(pid))
    return dev, sess, int(pid)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pkg", default="com.example.app")
    ap.add_argument("--out", default="dast-scan/sens")
    ap.add_argument("--wait", type=int, default=30, help="等 dump 完成秒数")
    ap.add_argument("--bin", default=None, help="已有 memdump.bin 路径(跳过 dump/pull, 只跑正则)")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    if args.bin:
        data = open(args.bin, "rb").read()
        print("[*] 用已有 bin %s (%d bytes), 只跑正则" % (args.bin, len(data)), flush=True)
    else:
        dev, sess, pid = attach(args.pkg)
        print("[*] attach pid=%d, 加载 mem_dump.js -> 等 %ds 完成 dump..." % (pid, args.wait), flush=True)
        def on_msg(m, d):
            pl = m.get("payload")
            if isinstance(pl, str) and pl.startswith("[MD]"):
                print("  %s" % pl, flush=True)
        sc = sess.create_script(open(MEMJS, encoding="utf-8").read())
        sc.on("message", on_msg); sc.load()
        try: sess.resume()
        except Exception: pass
        time.sleep(args.wait)
        print(">>> pull 内存文件", flush=True)
        run("shell", "su", "-c", "cp %s /sdcard/memdump.bin" % DEVFILE)
        time.sleep(1)
        r = run("pull", "/sdcard/memdump.bin", os.path.join(args.out, "memdump.bin"))
        if not os.path.exists(os.path.join(args.out, "memdump.bin")):
            print("[X] pull 失败: %s %s" % (r.stdout, r.stderr)); sys.exit(2)
        data = open(os.path.join(args.out, "memdump.bin"), "rb").read()
        print("[*] pulled %d bytes" % len(data), flush=True)

    # 提取可打印字符串(ASCII 连续 len>=6) 再按规则正则
    strings = re.findall(rb"[ -~]{6,}", data)
    strings = [s.decode("latin1", "ignore") for s in strings]
    rules = json.load(open(RULES, encoding="utf-8"))["rules"]
    findings = []
    for s in strings:
        for rule in rules:
            rx = rule["firstRegex"]
            try:
                for mm in re.finditer(rx, s):
                    if rule.get("format") and re.search(r"\{(?:\d+)\}", rule["format"]):
                        try:
                            txt = rule["format"].replace("{0}", mm.group(0))
                            for i in range(1, mm.groups() + 1):
                                txt = txt.replace("{%d}" % i, mm.group(i) or "")
                        except Exception:
                            txt = mm.group(0)
                    else:
                        txt = mm.group(0)
                    if len(txt) > 1500:
                        txt = txt[:1500]
                    findings.append({"name": rule["name"], "value": txt,
                                     "sensitive": rule.get("sensitive", False)})
            except re.error:
                pass
    # 去重(按 name+value)
    seen = set(); dedup = []
    for f in findings:
        k = (f["name"], f["value"])
        if k in seen: continue
        seen.add(k); dedup.append(f)

    sens = [f for f in dedup if f["sensitive"]]
    out = {"pkg": args.pkg, "bytes": len(data), "total_matches": len(dedup),
           "sensitive_count": len(sens), "findings": dedup, "sensitive": sens}
    with open(os.path.join(args.out, "sensitive_findings.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print("\n===== 敏感信息汇总 =====", flush=True)
    print("内存 %d 字节, 总命中 %d, 敏感 %d" % (len(data), len(dedup), len(sens)), flush=True)
    by_name = {}
    for f in dedup:
        by_name.setdefault(f["name"], []).append(f["value"])
    for name, vals in by_name.items():
        print("\n[%s] %d 条" % (name, len(vals)), flush=True)
        for v in vals[:8]:
            print("   " + v[:110], flush=True)
    print("\n敏感(key/token/secret):", flush=True)
    for f in sens[:30]:
        print("   [%s] %s" % (f["name"], f["value"][:140]), flush=True)

if __name__ == "__main__":
    main()
