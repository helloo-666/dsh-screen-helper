#!/usr/bin/env python3
"""Compose the demo stills into a single GIF with annotation overlays.

Reads docs/seq0..seq4.png and docs/geo.json (token box in OCR-logical
coordinates). Scales each frame to a capped width, draws a red box around the
found token on the relevant frames, and saves docs/demo.gif.
"""
import json
import math
from PIL import Image, ImageDraw, ImageFont

DOCS = "F:\\DSHwork\\dsh-screen-helper\\docs"
GEO = json.load(open(f"{DOCS}\\geo.json"))
BOX = GEO.get("box")          # [x1, y1, x2, y2] in virtual-screen logical px
CAP_W = 1100                  # output width
DUR = 900                     # ms per frame
FONT_PATHS = [
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
]


def font(size):
    for p in FONT_PATHS:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def scale_size(w, h, cap_w):
    if w <= cap_w:
        return w, h
    r = cap_w / w
    return cap_w, int(h * r)


frames = []
CX, CY = (GEO.get("center") or [0, 0])[:2]
labels = {
    0: "① 整屏 OCR：模型读取屏幕上所有文字",
    1: "② find_exact：从词级 OCR 里精确定位「新会话」",
    2: f"③ 鼠标自己移到目标中心 ({CX},{CY})",
    3: "④ 点击——动作由真实鼠标执行",
    4: "⑤ 复位光标，一次调用结束",
}
boxes_on = {1, 2, 3}  # frames that should show the red box

for i in range(5):
    im = Image.open(f"{DOCS}\\seq{i}.png").convert("RGB")
    w, h = im.size
    nw, nh = scale_size(w, h, CAP_W)
    im = im.resize((nw, nh), Image.LANCZOS)
    if BOX and w:
        # map OCR-logical coords -> scaled pixel coords
        x1 = BOX[0] / w * nw
        y1 = BOX[1] / h * nh
        x2 = BOX[2] / w * nw
        y2 = BOX[3] / h * nh
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
    d = ImageDraw.Draw(im)
    if BOX and i in boxes_on:
        d.rectangle([x1, y1, x2, y2], outline=(255, 40, 40), width=4)
        d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(255, 40, 40))
    # banner
    d.rectangle([0, 0, nw, 34], fill=(15, 23, 42))
    d.text((12, 8), labels[i], font=font(20), fill=(240, 240, 245))
    frames.append(im)

frames[0].save(
    f"{DOCS}\\demo.gif",
    save_all=True,
    append_images=frames[1:],
    duration=DUR,
    loop=0,
    optimize=True,
)
print("saved demo.gif", frames[0].size)
