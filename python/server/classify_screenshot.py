# -*- coding: utf-8 -*-
"""classify_screenshot.py — 自动判定截图是「有效内容页」还是「黑屏/白屏/加载转圈」。
把 <dir> 下每张 PNG 分类:
  VALID   真实内容页 (内容丰富: 多色彩/多边缘, 非黑非白)
  BLACK   黑屏 (亮度极低/近黑占比高)
  WHITE   白屏 (亮度极高/近白占比高)
  LOADING 加载转圈/启动页 (内容贫瘠: 单一背景色 + 小元素/转圈)
可复用(任意截图目录)。用法:
  python scripts/classify_screenshot.py <dir> [--json out.json] [--dump]
"""
import argparse, glob, json, os, sys

import numpy as np
from PIL import Image

def analyze(path):
    im = Image.open(path).convert("RGB")
    # 下采样, 提速 + 抑制噪点
    im = im.resize((160, 160), Image.BILINEAR)
    a = np.asarray(im, dtype=np.int16)           # HxWx3
    gray = np.asarray(im.convert("L"), dtype=np.float32)
    H, W = gray.shape
    mean_lum = float(gray.mean())
    std_lum = float(gray.std())

    black_frac = float((gray < 30).mean())
    white_frac = float((gray > 235).mean())

    # 量化色彩数(内容多样性的粗测)
    q = (a // 32)                               # 每通道 8 级
    flat = q.reshape(-1, 3)
    distinct = int(len(np.unique(flat, axis=0)))

    # 饱和度(彩色元素占比)
    mx = a.max(axis=2).astype(np.int16)
    mn = a.min(axis=2).astype(np.int16)
    sat = (mx - mn)
    colorful_frac = float((sat > 40).mean())

    # 边缘密度(相邻像素亮度差 > 20 的比例) —— 内容是否丰富
    gx = np.abs(np.diff(gray, axis=1))
    gy = np.abs(np.diff(gray, axis=0))
    edge = np.concatenate([gx.ravel(), gy.ravel()])
    edge_density = float((edge > 20).mean())

    return dict(path=path, mean_lum=round(mean_lum, 1), std_lum=round(std_lum, 1),
                black_frac=round(black_frac, 3), white_frac=round(white_frac, 3),
                distinct=distinct, colorful_frac=round(colorful_frac, 3),
                edge_density=round(edge_density, 3))

def classify(m):
    # 黑屏: 近全黑
    if m["mean_lum"] < 25 or m["black_frac"] > 0.85:
        return "BLACK"
    # 白屏: 近全白
    if m["mean_lum"] > 235 or m["white_frac"] > 0.85:
        return "WHITE"
    # 内容贫瘠(启动页/加载转圈: 单一背景色 + 居中小元素): 边缘少 且 色彩少。
    # ⚠️ 不依赖“彩色占比”—— 品牌纯色启动页(如深绿logo)也是饱和色, 但 edge/distinct 很低。
    if m["edge_density"] < 0.05 and m["distinct"] < 70:
        return "LOADING"
    return "VALID"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("imgdir", help="PNG 目录 (或单个 PNG)")
    ap.add_argument("--json", default=None, help="写分类结果 JSON")
    ap.add_argument("--dump", action="store_true", help="打印每张原始指标(不汇总)")
    args = ap.parse_args()

    if os.path.isfile(args.imgdir):
        files = [args.imgdir]
    else:
        files = sorted(glob.glob(os.path.join(args.imgdir, "*.png")))
    if not files:
        print("[!] 无 PNG"); sys.exit(1)

    rows = []
    for f in files:
        m = analyze(f) if os.path.getsize(f) > 10 else {"path": f, "error": "empty"}
        if "error" in m:
            m["label"] = "EMPTY"; rows.append(m); continue
        m["label"] = classify(m)
        rows.append(m)

    if args.dump:
        for m in rows:
            if "error" in m:
                print("%-8s  -- 0-byte/empty --  %s" % (m["label"], os.path.basename(m["path"])), flush=True)
                continue
            print("%-8s lum=%-6s std=%-6s black=%.2f white=%.2f col=%d edge=%.3f sat=%.3f  %s"
                  % (m["label"], m.get("mean_lum"), m.get("std_lum"),
                     m.get("black_frac"), m.get("white_frac"), m.get("distinct"),
                     m.get("edge_density"), m.get("colorful_frac"), os.path.basename(m["path"])), flush=True)

    from collections import Counter
    cnt = Counter(m.get("label") for m in rows)
    print("\n=== 汇总 (%d 张) ===" % len(rows))
    for k in ("VALID", "BLACK", "WHITE", "LOADING", "EMPTY", "ERR"):
        if cnt.get(k):
            print("  %-7s %d" % (k, cnt[k]))
    print("  VALID 名单:", [os.path.basename(m["path"]) for m in rows if m.get("label") == "VALID"], flush=True)

    if args.json:
        json.dump(rows, open(args.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("\n[*] 结果 -> %s" % args.json, flush=True)

if __name__ == "__main__":
    main()
