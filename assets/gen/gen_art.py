#!/usr/bin/env python3
"""斜钉 (Gokigen Naname) 的全套位图资产，一条命令重新生成。

为什么是脚本而不是手画的 PNG：图标要在 16px 到 1024px、maskable 安全区、og 卡、
胜利粒子的 sprite、纸纹理之间保持同一个母题。手画会画成六张互不相干的图；脚本让
"改一处母题、全家族跟着改"成为唯一可能的改法。生成过程无随机源（自带 LCG），
同一份代码在任何机器上产出同样尺寸的同一张图。

母题（和玩法同源，不凭空装饰）：
  2×2 的四格里各放一条斜线，四条线的端点全部收在中间那个交点上 —— 这正是规则里的
  "四面归一"，而中间那个环里写着 4。琥珀色那条是玩家自己刚放下的钉，蓝色是已经
  安分的线，深蓝是纸。图标、og 卡、粒子 sprite、纸纹理用的都是这一套几何与配色。

用法: python3 assets/gen/gen_art.py            # 全量重建
      python3 assets/gen/gen_art.py --only icons
依赖: Pillow（与组合级 make_icons.py 同一个库）。缺 Pillow 时脚本会明确报错而不是
产出 0 字节占位 —— 空图标在货架上比没有图标更糟。
"""

import argparse
import json
import os
import struct
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    sys.stderr.write('需要 Pillow：python3 -m pip install Pillow\n')
    raise SystemExit(2)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ASSETS = os.path.join(ROOT, 'assets')

# 与 js/theme.js 的 Palette 同一批值 —— 图标和游戏长得不像一个东西，是货架上最刺眼的 bug。
INK_BG_TOP = (8, 11, 22)
INK_BG_BOTTOM = (19, 26, 46)
INK_FIELD = (16, 22, 39)
SURFACE_LIFT = (24, 32, 54)
LINE = (36, 48, 80)
LINE_HEAVY = (58, 74, 114)
ACCENT = (255, 200, 92)
ACCENT_EDGE = (255, 227, 166)
INFO = (123, 184, 255)
PENCIL = (143, 166, 204)
SUCCESS = (61, 220, 145)
ERROR = (255, 92, 124)
PAPER_INK = (242, 245, 251)

CJK_FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
]
LATIN_FONT_CANDIDATES = [
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


class Rand:
    """确定性 LCG：纹理噪声与粒子抖动都走这里，绝不用 random 的进程种子。"""

    def __init__(self, seed=20260929):
        self.x = seed & 0xFFFFFFFF

    def next(self):
        self.x = (1103515245 * self.x + 12345) & 0x7FFFFFFF
        return self.x / 0x7FFFFFFF

    def span(self, a, b):
        return a + (b - a) * self.next()


def lerp(c1, c2, k):
    return tuple(round(c1[i] + (c2[i] - c1[i]) * k) for i in range(3))


def vertical_gradient(size, top, bottom, radius=0.0):
    """Linear top→bottom fill, optionally masked to a squircle."""
    w, h = size
    img = Image.new('RGB', (w, h), top)
    dr = ImageDraw.Draw(img)
    for y in range(h):
        dr.line([(0, y), (w, y)], fill=lerp(top, bottom, y / max(1, h - 1)))
    if radius:
        mask = Image.new('L', (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
        out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        return out
    return img.convert('RGBA')


def font(paths, px):
    for p in paths:
        if not os.path.exists(p):
            continue
        try:
            f = ImageFont.truetype(p, px)
            # A font that cannot draw a single CJK glyph is worse than none: it renders tofu.
            if f.getbbox('斜')[2] > 0:
                return f, p
        except Exception:
            continue
    return None, None


def draw_slant(draw, box, back, color, width):
    """One cell's diagonal. back=False is ╱ , back=True is ╲ ."""
    x0, y0, x1, y1 = box
    if back:
        draw.line([(x0, y0), (x1, y1)], fill=color, width=width)
    else:
        draw.line([(x0, y1), (x1, y0)], fill=color, width=width)


def motif(img, S, detail=True, inset=0.0, grid=True):
    """Paint the 2×2 "四面归一" mark onto `img` (RGBA, size S×S) in place.

    inset is the fraction of the field kept clear around the mark — maskable icons need it
    because launchers crop to the inner 80%.
    """
    dr = ImageDraw.Draw(img)
    field = S * (1.0 - 2 * inset)
    ox = (S - field) / 2.0
    oy = (S - field) / 2.0
    cw = field / 2.0
    lw = max(2, round(S * (0.055 if detail else 0.085)))
    # The mark is a little airier than the field so the corner nodes do not touch the edge.
    pad = field * 0.06
    bx = [
        (ox + pad, oy + pad, ox + cw - pad * 0.4, oy + cw - pad * 0.4),
        (ox + cw + pad * 0.4, oy + pad, ox + field - pad, oy + cw - pad * 0.4),
        (ox + pad, oy + cw + pad * 0.4, ox + cw - pad * 0.4, oy + field - pad),
        (ox + cw + pad * 0.4, oy + cw + pad * 0.4, ox + field - pad, oy + field - pad),
    ]
    cx, cy = ox + cw, oy + cw

    if grid:
        gw = max(1, round(S * 0.012))
        dr.line([(bx[0][0], cy), (bx[1][2], cy)], fill=LINE + (255,), width=gw)
        dr.line([(cx, bx[0][1]), (cx, bx[3][3])], fill=LINE + (255,), width=gw)
        for x, y in [(bx[0][0], bx[0][1]), (bx[1][2], bx[1][1]), (bx[0][0], bx[2][3]), (bx[1][2], bx[2][3])]:
            dr.ellipse([x - S * 0.012, y - S * 0.012, x + S * 0.012, y + S * 0.012], fill=LINE_HEAVY + (255,))

    # TL ╲, TR ╱, BL ╱, BR ╲ — all four endpoints land on the centre node.
    draw_slant(dr, bx[0], True, INFO, lw)
    draw_slant(dr, bx[1], False, PENCIL, lw)
    draw_slant(dr, bx[2], False, INFO, lw)
    draw_slant(dr, bx[3], True, ACCENT, lw)  # the player's own nail

    r = S * (0.108 if detail else 0.13)
    ring = max(2, round(S * (0.022 if detail else 0.05)))
    dr.ellipse([cx - r, cy - r, cx + r, cy + r], fill=INK_BG_TOP + (255,), outline=ACCENT + (255,), width=ring)
    if detail and S >= 150:
        f, _ = font(CJK_FONT_CANDIDATES, round(S * 0.152))
        if f:
            dr.text((cx, cy + S * 0.004), '4', font=f, fill=ACCENT_EDGE + (255,), anchor='mm')
    return img


def build_icon(S, maskable=False, grid=True):
    radius = 0 if maskable else round(S * 0.2237)
    img = vertical_gradient((S, S), INK_BG_TOP, INK_BG_BOTTOM, radius=radius)
    if maskable:  # full bleed, and the mark lives inside the safe zone
        img = vertical_gradient((S, S), INK_BG_TOP, INK_BG_BOTTOM)
        return motif(img, S, detail=S >= 150, inset=0.20, grid=grid)
    return motif(img, S, detail=S >= 150, inset=0.11 if S >= 96 else 0.08, grid=grid and S >= 48)


def write(img, rel):
    path = os.path.join(ASSETS, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    return rel


def png_ihdr(path):
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('不是 PNG: ' + path)
    w, h = struct.unpack('>II', head[16:24])
    return w, h


def gen_icons():
    out = []
    for S in (1024, 512, 384, 320, 256, 192, 180, 167, 152, 144, 128, 120, 96, 72, 48, 32, 16):
        out.append(write(build_icon(S), f'icons/icon-{S}.png'))
    for S in (512, 192):
        out.append(write(build_icon(S, maskable=True), f'icons/icon-maskable-{S}.png'))
    # apple-touch-icon 必须是 180 且不带圆角透明：iOS 自己贴模板，透明边缘会变成白边。
    touch = vertical_gradient((180, 180), INK_BG_TOP, INK_BG_BOTTOM)
    out.append(write(motif(touch, 180, detail=True, inset=0.10), 'icons/apple-touch-icon.png'))
    out.append(write(build_icon(32), 'icons/favicon-32.png'))
    out.append(write(build_icon(16), 'icons/favicon-16.png'))
    return out


def gen_paper():
    """256 的无缝纸纹理：深蓝底 + 极淡的格 + 低频亮度噪声。给 CSS 层用，不碰画布像素。

    噪声来自自带 LCG，不用 Pillow 的 effect_noise —— 后者走未播种的 C rand()，
    同一份脚本两次运行会产出两张不同的图，那就不叫"可复现的资产"。
    """
    S, step, n = 256, 64, 32
    rnd = Rand(77)
    low = Image.new('L', (n, n))
    low.putdata([round(rnd.span(108, 148)) for _ in range(n * n)])
    field = low.resize((S, S), Image.BILINEAR).filter(ImageFilter.GaussianBlur(3))

    img = Image.new('RGB', (S, S), INK_FIELD)
    dr = ImageDraw.Draw(img)
    for i in range(0, S, step):  # 只在左/上画线，平铺后每个格恰好有一条，接缝看不出来
        dr.line([(i, 0), (i, S)], fill=lerp(INK_FIELD, LINE, 0.9), width=1)
        dr.line([(0, i), (S, i)], fill=lerp(INK_FIELD, LINE, 0.9), width=1)
    lit = Image.new('RGB', (S, S), lerp(INK_FIELD, SURFACE_LIFT, 0.55))
    mask = field.point(lambda v: max(0, min(255, round((v - 118) * 0.42))))
    out = Image.composite(lit, img, mask)
    return [write(out.convert('RGBA'), 'textures/paper-256.png')]


def gen_fx():
    """粒子 sprite：一枚放射光点 + 一枚斜线碎片（钉）。都是带 alpha 的真 PNG。"""
    out = []
    for name, col in (('spark-amber', ACCENT), ('spark-blue', INFO), ('spark-green', SUCCESS)):
        S = 64
        img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        dr = ImageDraw.Draw(img)
        cx = cy = S / 2
        for i in range(S // 2, 0, -1):
            k = i / (S / 2)
            a = int(255 * (1 - k) ** 2.6)
            c = lerp(col, ACCENT_EDGE if col == ACCENT else (255, 255, 255), (1 - k) * 0.55)
            dr.ellipse([cx - i, cy - i, cx + i, cy + i], fill=c + (a,))
        # 一点高光，让它在深蓝底上读起来像金属钉的反光而不是一团糊
        dr.ellipse([cx - S * 0.10, cy - S * 0.14, cx + S * 0.06, cy - S * 0.02], fill=(255, 255, 255, 150))
        out.append(write(img, f'fx/{name}.png'))

    S = 48
    shard = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(shard)
    dr.line([(S * 0.18, S * 0.82), (S * 0.82, S * 0.18)], fill=ACCENT + (255,), width=round(S * 0.20))
    dr.line([(S * 0.18, S * 0.82), (S * 0.82, S * 0.18)], fill=ACCENT_EDGE + (255,), width=round(S * 0.07))
    dr.ellipse([S * 0.70, S * 0.10, S * 0.94, S * 0.34], fill=(255, 255, 255, 210))
    out.append(write(shard, 'fx/shard-amber.png'))
    return out


def gen_og():
    """1200×630 的社交卡：左边一句话讲玩法，右边就是图标那枚母题。"""
    W, H = 1200, 630
    img = vertical_gradient((W, H), (6, 9, 18), (21, 30, 56))
    dr = ImageDraw.Draw(img)
    paper_path = os.path.join(ASSETS, 'textures', 'paper-256.png')
    if not os.path.exists(paper_path):
        gen_paper()  # --only og 单独跑时也要能出图
    paper = Image.open(paper_path).convert('RGBA')
    tile = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for y in range(0, H, 256):
        for x in range(0, W, 256):
            tile.paste(paper, (x, y))
    tile.putalpha(70)  # 就地改 alpha：整层压到 27% 不透明度
    img = Image.alpha_composite(img, tile)
    dr = ImageDraw.Draw(img)

    f_cjk, cjk_path = font(CJK_FONT_CANDIDATES, 92)
    f_mid, _ = font(CJK_FONT_CANDIDATES, 34)
    f_sml, _ = font(CJK_FONT_CANDIDATES, 26)
    f_lat, _ = font(LATIN_FONT_CANDIDATES, 30)

    x0, y0 = 74, 96
    if f_cjk:
        dr.text((x0, y0), '斜钉', font=f_cjk, fill=PAPER_INK + (255,))
    if f_lat:
        dr.text((x0 + 6, y0 + 128), 'GOKIGEN  NANAME', font=f_lat, fill=INFO + (255,))
    if f_mid:
        dr.text((x0, y0 + 196), '每格一条斜线，交点上的数字', font=f_mid, fill=lerp(PAPER_INK, (255, 255, 255), 0) + (255,))
        dr.text((x0, y0 + 244), '数着有几条线收在这里', font=f_mid, fill=PAPER_INK + (255,))
    if f_sml:
        dr.text((x0, y0 + 322), '每局唯一解 · 每局都能用逻辑推到底', font=f_sml, fill=ACCENT + (255,))
        dr.text((x0, y0 + 362), '提示只说推得出的那一步', font=f_sml, fill=PENCIL + (255,))

    mark = build_icon(392)
    img.paste(mark, (W - 392 - 86, (H - 392) // 2), mark)
    dr = ImageDraw.Draw(img)
    dr.line([(0, H - 14), (W, H - 14)], fill=ACCENT + (255,), width=14)
    out = write(img, 'og/og-image.png')
    return [out], {'cjk': cjk_path}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', choices=('icons', 'paper', 'fx', 'og'), action='append', default=None)
    args = ap.parse_args()
    want = set(args.only or ('icons', 'paper', 'fx', 'og'))
    made = []
    if 'icons' in want:
        made += gen_icons()
    if 'paper' in want:
        made += gen_paper()
    if 'fx' in want:
        made += gen_fx()
    meta = {}
    if 'og' in want:
        og, meta = gen_og()
        made += og

    rows = []
    for rel in sorted(made):
        p = os.path.join(ASSETS, rel)
        w, h = png_ihdr(p)
        if w == 0 or h == 0:
            raise SystemExit('零尺寸资产: ' + rel)
        rows.append({'file': f'assets/{rel}', 'w': w, 'h': h, 'bytes': os.path.getsize(p)})
    print(json.dumps({'font': meta, 'assets': rows, 'count': len(rows),
                      'total_bytes': sum(r['bytes'] for r in rows)}, ensure_ascii=False, indent=2))
    for r in rows:
        print('%-34s %5dx%-5d %8d B' % (r['file'], r['w'], r['h'], r['bytes']))


if __name__ == '__main__':
    main()
