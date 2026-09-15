#!/usr/bin/env python3
"""Pingory logo PNG generator (方案A · 声呐脉冲).

Regenerates all raster assets in public/ from the SVG geometry.
Rerun after any logo change:  python tools/make_icons.py
Requires: pillow
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public")
ACCENT = (31, 170, 107, 255)        # #1faa6b
WHITE = (255, 255, 255, 255)
WHITE_HALF = (255, 255, 255, 128)
BASE = 1024                          # supersample canvas (16x of 64 viewBox)

def draw_sonar(full_bleed=False):
    """Draw the 方案A sonar mark on a transparent canvas."""
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = 0 if full_bleed else int(2 / 64 * BASE)
    radius = 0 if full_bleed else int(14 / 64 * BASE)
    d.rounded_rectangle([m, m, BASE - m, BASE - m], radius=radius, fill=ACCENT)

    # overlay layer for the semi-transparent outer arc
    overlay = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    cx = cy = BASE // 2
    dot_r = int(5.5 / 64 * BASE)
    inner_r = int(14.5 / 64 * BASE)
    outer_r = int(23.5 / 64 * BASE)
    lw = int(4.5 / 64 * BASE)
    # PIL angles: 0 = 3 o'clock, clockwise; quarter arc top-right = 270 -> 360
    od.arc([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r],
           start=270, end=360, fill=WHITE, width=lw)
    od.arc([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r],
           start=270, end=360, fill=WHITE_HALF, width=lw)
    od.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=WHITE)
    img = Image.alpha_composite(img, overlay)
    return img

def save(img, name, size, src=None):
    im = (src or img).resize((size, size), Image.LANCZOS)
    im.save(os.path.join(OUT, name))
    print(f"  {name} ({size}x{size})")

rounded = draw_sonar(full_bleed=False)
fullbleed = draw_sonar(full_bleed=True)

print("Generating Pingory icon assets ->", os.path.abspath(OUT))
save(rounded, "favicon-16.png", 16)
save(rounded, "favicon-32.png", 32)
save(rounded, "favicon-48.png", 48)
save(rounded, "icon-192.png", 192)
save(rounded, "icon-512.png", 512)
save(rounded, "logo-email.png", 240)
save(fullbleed, "apple-touch-icon.png", 180)

# multi-size favicon.ico (16/32/48)
ico_sizes = [(16, 16), (32, 32), (48, 48)]
imgs = [rounded.resize(s, Image.LANCZOS) for s in ico_sizes]
imgs[0].save(os.path.join(OUT, "favicon.ico"), sizes=ico_sizes)
print("  favicon.ico (16/32/48)")
print("Done.")
