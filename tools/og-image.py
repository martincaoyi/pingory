#!/usr/bin/env python3
"""生成对比页社交分享图（1200x630，Open Graph / Twitter Card 的 summary_large_image 规格）。

背景（P2 对比页 OG 修复，2026-09-23）：
  三个对比页原先 og:image 指向 icon-512.png（1:1 方图），却声明 twitter:card=summary_large_image
  （约 1.91:1）⇒ 平台会裁切/留白，与首页统一使用的 summary 卡型也不一致。
  这里改为「生成真正的 1200x630 横版图 + 保留 summary_large_image」，两端都正确。

为什么用代码画而不是 AI 生成：图上文字必须零错字（品牌名 / 价格），代码渲染可精确控制、可复现。
依赖：Python 3 + Pillow（Windows 上用 C:/Windows/Fonts/segoeui*.ttf）。
用法：python tools/og-image.py        # 从仓库根执行，输出到 public/img/og-*.png
"""

import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
PAD = 64

# 品牌色（与 public/*.html 的 :root 变量一致）
BG_TOP = (11, 15, 13)
BG_BOTTOM = (20, 30, 24)
ACCENT = (43, 213, 133)      # [data-theme="dark"] 的 --accent
TEXT = (230, 239, 233)       # --text（暗色）
MUTED = (159, 176, 166)      # --muted（暗色）
DARK = (14, 19, 16)          # --bg（暗色），用于亮色图形上的文字/线条

FONT_DIR = "C:/Windows/Fonts"
F_BOLD = os.path.join(FONT_DIR, "segoeuib.ttf")
F_REG = os.path.join(FONT_DIR, "segoeui.ttf")

# 页面 → （标题行、副标题行）
PAGES = {
    "uptimerobot": ("Pingory vs UptimeRobot", "Price per monitor, 8 UI languages, honest limits"),
    "betterstack": ("Pingory vs Better Stack", "Price, simplicity — and where it still wins"),
    "pingdom": ("Pingory vs Pingdom", "Price per monitor in 2026"),
}
SUB_COMMON = "Uptime monitoring from $4/month  ·  Free plan with 50 monitors"


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (1, size[1]))
    px = img.load()
    for y in range(size[1]):
        t = y / max(1, size[1] - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize(size, Image.BILINEAR)


def add_glow(img, center, radius, color, max_alpha=46):
    """在右上角加一层柔和的绿色光晕（同心圆叠加，避免依赖 numpy）。"""
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    steps = 60
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(max_alpha * (1 - i / steps) ** 1.6)
        if a <= 0:
            continue
        d.ellipse(
            [center[0] - r, center[1] - r, center[0] + r, center[1] + r],
            fill=(color[0], color[1], color[2], a),
        )
    return Image.alpha_composite(img.convert("RGBA"), overlay)


def draw_logo(d, x, y):
    """品牌标记：绿色圆角方块 + 心跳折线（= 可用性）。返回标记右边界。"""
    size = 64
    d.rounded_rectangle([x, y, x + size, y + size], radius=16, fill=ACCENT)
    pts = [
        (x + 11, y + 34), (x + 22, y + 34), (x + 28, y + 20),
        (x + 37, y + 46), (x + 43, y + 34), (x + 53, y + 34),
    ]
    d.line(pts, fill=DARK, width=5, joint="curve")
    return x + size


def build(slug, title, sub):
    img = vertical_gradient((W, H), BG_TOP, BG_BOTTOM)
    img = add_glow(img, (1005, 96), 560, ACCENT, max_alpha=52).convert("RGB")
    d = ImageDraw.Draw(img)

    # 顶部品牌行
    right = draw_logo(d, PAD, 70)
    fb = ImageFont.truetype(F_BOLD, 40)
    d.text((right + 20, 80), "Pingory", font=fb, fill=TEXT)

    # 右上角站点域名
    fr = ImageFont.truetype(F_REG, 26)
    dom = "pingory.com"
    dw = d.textlength(dom, font=fr)
    d.text((W - PAD - dw, 92), dom, font=fr, fill=ACCENT)

    # 主标题
    fh = ImageFont.truetype(F_BOLD, 66)
    d.text((PAD, 232), title, font=fh, fill=(255, 255, 255))

    # 副标题（页脚上方的两行）
    fs = ImageFont.truetype(F_REG, 30)
    d.text((PAD, 332), sub, font=fs, fill=TEXT)
    fm = ImageFont.truetype(F_REG, 27)
    d.text((PAD, 382), SUB_COMMON, font=fm, fill=MUTED)

    # 分隔线 + 页脚
    d.line([(PAD, 512), (W - PAD, 512)], fill=(42, 54, 47), width=2)
    d.text((PAD, 546), "Open source (AGPL-3.0)  ·  Self-hostable", font=fm, fill=MUTED)
    tag = "30-second checks"
    tw = d.textlength(tag, font=fm)
    # 绿色描边小标签
    bx0, by0 = W - PAD - tw - 36, 538
    d.rounded_rectangle([bx0, by0, W - PAD, by0 + 44], radius=22, outline=ACCENT, width=2)
    d.text((bx0 + 18, 546), tag, font=fm, fill=ACCENT)

    out = os.path.join("public", "img", f"og-{slug}.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out}  ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    for s, (t, sb) in PAGES.items():
        build(s, t, sb)
