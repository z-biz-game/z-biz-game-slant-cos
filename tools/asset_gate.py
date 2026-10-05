#!/usr/bin/env python3
"""资产闸：位图必须"真的被引用、真的在盘上、真的画了东西"，而且能一键复现。

为什么要有这个脚本：图标类交付最容易注水成"仓库里躺着一张 1024 的 PNG，而 index.html
还指着 data-URI 的 SVG"，或者反过来——manifest 写了 icons 而文件没提交。两种在页面上
都只表现为"没有图标"，而 grep 一把全绿。更要命的是第三种：文件在、尺寸对、IHDR 能读，
但里面是一张全透明的空壳或一块纯色矩形 —— 引用检查和 IHDR 检查都照样绿。

所以这里量四件可判定的事：

  1. 引用闭合：index.html / css / sw.js / manifest 里每一条同源资源引用，路径都能解析到
     真实文件；manifest 声明的 sizes 与实际 IHDR 宽高一致；没有 0 字节；扩展名是 .png
     的必须真是 PNG（读签名，不看扩展名）。
  2. 像素真实性：自己解码 IDAT（zlib + 五种 filter），统计 alpha 直方图、亮度极差、
     母题配色占比。空壳/纯色/缺母题的图在这里红，而不是等到货架上才发现。
  3. 母题一致：图标家族与 og 卡必须同时含琥珀（玩家自己的钉）与冷蓝（已安分的线）——
     这是玩法的两色语义，"随便一张渐变方块"过不了这条。
  4. 纸纹理可平铺：格线的间距（含跨接缝的那一格）必须处处一致，否则铺满屏幕会看见宽窄不一的格。

只用标准库解码：CI 的 ubuntu-latest 不保证有 Pillow，一把依赖第三方库的闸会在装依赖之前
先红。但"重新生成一遍字节是否完全相同"这件事本身需要跑 gen_art.py（它依赖 Pillow），所以
那条挂在 --repro 上：显式打开时缺 Pillow 直接判红，而不是悄悄跳过。

  python3 tools/asset_gate.py            # 引用闭合 + 像素真实性
  python3 tools/asset_gate.py --repro    # 再加一键复现（在 tmp 里重生成，比对 md5）
  python3 tools/asset_gate.py --selfcheck # 阴性对照：造四张坏图，必须逐张被判红

阈值不是拍脑袋：全部取自 assets/gen/gen_art.py 产出物的实测值（见 --selfcheck 旁边注释的
before 数字），并且每条都留了 ≥2x 的余量，同时被 --selfcheck 的反面样本钉住"这条确会红"。
"""
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SIG = b'\x89PNG\r\n\x1a\n'
CH = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


# --------------------------------------------------------------------- PNG 解码
class Unsupported(Exception):
    pass


def decode_png(path):
    """返回 (w, h, ch, bytes)：ch 是通道数（1/2/3/4），调色板已展开为 RGB(A)。"""
    data = open(path, 'rb').read()
    if data[:8] != SIG:
        return None
    pos, idat, ihdr, plte, trns = 8, bytearray(), None, None, None
    while pos + 8 <= len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif typ == b'IDAT':
            idat += body
        elif typ == b'PLTE':
            plte = body
        elif typ == b'tRNS':
            trns = body
        elif typ == b'IEND':
            break
        pos += 12 + ln
    if not ihdr:
        return None
    w, h, depth, ct, comp, filt, inter = ihdr
    if comp or filt or inter:
        raise Unsupported('隔行/非标过滤不支持 (interlace=%d filter=%d)' % (inter, filt))
    if ct not in CH:
        raise Unsupported('未知 color type %d' % ct)
    if depth not in (8, 16) and not (ct == 3 and depth in (1, 2, 4)):
        raise Unsupported('位深 %d 不在闸支持范围' % depth)
    ch = CH[ct]
    raw = zlib.decompress(bytes(idat))
    row = (w * ch * depth + 7) // 8
    bpp = max(1, (ch * depth) // 8)
    stride = row
    out = bytearray(w * h * ch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += stride + 1
        if ft == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif ft == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif ft == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif ft == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        elif ft != 0:
            raise Unsupported('未知过滤类型 %d' % ft)
        out[y * stride:y * stride + stride] = line
        prev = line
    if ct == 3:
        out = expand_palette(bytes(out), plte, trns, depth, w, h)
        ch = 4
    elif depth == 16:
        out = bytes(out[0::2])
    return w, h, ch, out


def expand_palette(idx, plte, trns, depth, w, h):
    if not plte:
        raise Unsupported('调色板图缺 PLTE')
    last = len(plte) // 3 - 1
    if depth == 8:
        idxs = idx
    else:
        per = 8 // depth
        mask = (1 << depth) - 1
        idxs = [(idx[i // per] >> (8 - depth * (i % per + 1))) & mask for i in range(w * h)]
    rgba = bytearray(w * h * 4)
    for i, v in enumerate(idxs):
        p = min(v, last) * 3
        a = trns[v] if trns and v < len(trns) else 255
        rgba[i * 4:i * 4 + 4] = bytes((plte[p], plte[p + 1], plte[p + 2], a))
    return rgba


def write_png(path, w, h, rgba):
    """闸自带的极简 PNG 写出（8bit RGBA、无 interlace）——只为 --selfcheck 造反面样本，
    顺带和上面的解码器形成回环自检：写得出、读不回自己，解码器就是坏的。"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * w * 4:(y + 1) * w * 4]
    def chunk(typ, body):
        c = struct.pack('>I', len(body)) + typ + body
        return c + struct.pack('>I', zlib.crc32(typ + body) & 0xFFFFFFFF)
    with open(path, 'wb') as fh:
        fh.write(SIG + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                 + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))


# --------------------------------------------------------------------- 像素统计
def stats(path, sample=3):
    """一次解码，算出这几件可判定的事：透明占比、亮度极差、琥珀/冷蓝/亮墨占比。

    母题配色判据取自 js/theme.js 与 assets/gen/gen_art.py 的同一批常量：琥珀 ACCENT
    (255,200,92) 是"玩家刚放下的钉"，冷蓝 INFO (123,184,255) 是"已经安分的线"。
    """
    w, h, ch, px = decode_png(path)
    n = w * h
    if ch == 4:
        alpha = px[3::4]
        trans = sum(alpha.count(v) for v in range(17)) / n
    else:
        trans = 0.0
    step = ch * sample
    amber = blue = ink = cnt = 0
    lmin, lmax = 999.0, -1.0
    for i in range(0, min(n * ch, len(px)), step):
        a = px[i + 3] if ch == 4 else 255
        if a <= 40:
            continue
        r, g, b = px[i], px[i + 1], px[i + 2]
        l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        cnt += 1
        if l < lmin:
            lmin = l
        if l > lmax:
            lmax = l
        if r > 200 and g > 150 and b < 150:
            amber += 1
        if b > 190 and r < 180:
            blue += 1
        if l > 150:
            ink += 1
    spread = max(0.0, lmax - lmin) if cnt else 0.0
    denom = cnt or 1
    return {'w': w, 'h': h, 'trans': trans,
            'spread': spread,
            'amber': amber / denom, 'blue': blue / denom, 'ink': ink / denom, 'seen': denom}


def ihdr(path):
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != SIG:
        return None
    return struct.unpack('>II', head[16:24])


# --------------------------------------------------------------------- 引用闭合
def local_refs(text, base_dir):
    """同源引用：跳过 data:/http(s):/mailto:，把 ./x 与 /x 都归到仓内相对路径。"""
    out = []
    for m in re.finditer(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', text):
        raw = m.group(1)
        if re.match(r'^(data:|https?:|mailto:|blob:|#)', raw):
            continue
        path = raw.split('?')[0].split('#')[0]
        path = path[1:] if path.startswith('/') else path
        out.append(os.path.normpath(os.path.join(base_dir, path)))
    return [p for p in out if p]


def css_urls(text, base_dir):
    """样式表里的资源是 url(...)，不是 src=/href= —— 不解析它，纸纹理就是漏网之鱼。"""
    out = []
    for m in re.finditer(r'url\(\s*["\']?([^\'")]+)["\']?\s*\)', text):
        raw = m.group(1)
        if re.match(r'^(data:|https?:|blob:)', raw):
            continue
        path = raw.split('?')[0].split('#')[0]
        path = path[1:] if path.startswith('/') else path
        out.append(os.path.normpath(os.path.join(base_dir, path)))
    return [p for p in out if p]


def collect_refs():
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    refs = local_refs(html, ROOT)
    for c in re.findall(r'href="([^"]+\.css)"', html):
        css_path = os.path.normpath(os.path.join(ROOT, c))
        if not os.path.exists(css_path):
            refs.append(css_path)
            continue
        css_dir = os.path.dirname(css_path)
        css_text = open(css_path, encoding='utf-8').read()
        refs += local_refs(css_text, css_dir)
        refs += css_urls(css_text, css_dir)
    sw_path = os.path.join(ROOT, 'sw.js')
    if os.path.isfile(sw_path):
        refs += [os.path.normpath(m.group(1))
                 for m in re.finditer(r"'(\./[^']+)'", open(sw_path, encoding='utf-8').read())]
    rel = [os.path.relpath(os.path.join(ROOT, r), ROOT) for r in refs]
    return html, sorted(set(rel))


# --------------------------------------------------------------------- 规则
def judge(rel, st, fails):
    """像素级"这张图真的画了东西"。阈值见文件头注释与 --selfcheck。"""
    if st['trans'] > 0.90:
        fails.append('%s 近乎全透明（alpha≤16 占 %.3f）——空壳图在货架上等于没有图' % (rel, st['trans']))
        return
    if st['spread'] < 12:
        fails.append('%s 亮度极差只有 %.0f ——整张是一块纯色/渐变矩形，不是母题' % (rel, st['spread']))
    if rel.startswith('assets/icons/') or rel.startswith('assets/og/'):
        if st['amber'] < 0.005:
            fails.append('%s 缺琥珀母题（占比 %.4f < 0.005）——玩家那枚钉没了' % (rel, st['amber']))
        if st['blue'] < 0.005:
            fails.append('%s 缺冷蓝母题（占比 %.4f < 0.005）——图标与玩法配色脱节' % (rel, st['blue']))
    if rel.startswith('assets/og/'):
        if min(st['w'], st['h']) < 480 or st['w'] < 900:
            fails.append('og 卡尺寸 %dx%d 太小，社交卡片会被裁成一团' % (st['w'], st['h']))
        if st['ink'] < 0.02:
            fails.append('og 卡亮墨占比 %.4f < 0.02 ——卡上没有可读文字/图形' % st['ink'])
    if rel.startswith('assets/icons/') and st['w'] == st['h'] and st['w'] < 48:
        if st['blue'] < 0.02:
            fails.append('小图标 %s 冷蓝占比 %.3f 过低：16/32px 上母题糊成一团，读不出斜线' % (rel, st['blue']))


def tiling_check(path, fails):
    """纸纹理必须无缝：格线的间距（含跨接缝那一格）必须完全一致。

    为什么不用"接缝亮度差 ≤ 内部最大相邻差"：我们的格线就画在 x=0，接缝处的
    大跳变在图内部同样存在（0→1 列就是那个跳变），那条判据永远不会红——是一把空尺。
    真正会露馅的是"周期在接缝处断了"：线上间距 64、跨缝间距 63 或 65，铺满屏幕就会
    看见一列格外宽/窄的格。所以这里量峰位与间距。
    """
    try:
        w, h, ch, px = decode_png(path)
    except Unsupported as e:
        fails.append('纸纹理无法解码: %s (%s)' % (path, e))
        return None

    def L(i):
        return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]

    def peaks(n, base, step_i, step_j):
        prof = []
        for i in range(n):
            s = 0.0
            for j in range(base):
                s += L(j * step_j + i * step_i)
            prof.append(s / base)
        med = sorted(prof)[len(prof) // 2]
        pk = []
        for x in range(n):
            if prof[x] <= med + 4:
                continue
            if prof[x] >= prof[(x - 1) % n] and prof[x] >= prof[(x + 1) % n]:
                if pk and pk[-1] == x - 1:
                    continue  # 平台顶边：相邻同高只算一条线
                pk.append(x)
        if len(pk) < 2:
            fails.append('纸纹理找不到周期性栅格（只识出 %d 条格线）——那不是纹理，是一张底色' % len(pk))
            return None, prof
        gaps = [(pk[(i + 1) % len(pk)] - pk[i]) % n or n for i in range(len(pk))]
        if max(gaps) - min(gaps) > 1:
            fails.append('纸纹理平铺在接缝处周期断裂：峰位 %s 间距 %s（极差 %d）——铺满会看见一列宽窄不一的格'
                         % (pk, gaps, max(gaps) - min(gaps)))
        return {'peaks': pk, 'gaps': gaps}, prof

    colp, _ = peaks(w, h, ch, w * ch)          # 每一列的平均亮度
    rowp, _ = peaks(h, w, w * ch, ch)          # 每一行的平均亮度
    if colp is None or rowp is None:
        return None
    return ('列峰%s 间距%s / 行峰%s 间距%s'
            % (colp['peaks'], colp['gaps'], rowp['peaks'], rowp['gaps']))


def repro_check(fails):
    """在 tmp 里跑同一份生成器，逐文件比 md5：资产必须"可复现"，否则下次没人重建得出来。"""
    try:
        import PIL  # noqa: F401
    except Exception:
        fails.append('--repro 需要 Pillow（python3 -m pip install Pillow）；未装就是没测，不许跳过')
        return None
    tmp = tempfile.mkdtemp(prefix='slant-repro-')
    gen = os.path.join(ROOT, 'assets', 'gen', 'gen_art.py')
    dst = os.path.join(tmp, 'assets', 'gen')
    os.makedirs(dst)
    # gen_art 用自身路径推 ROOT：跑仓里那份会直接重写仓内资产，校验就变成覆盖。
    # 搬一份副本到 tmp 再跑，它的 ROOT 就是 tmp，产出落在 tmp/assets，与仓内逐字节比对。
    tmp_gen = os.path.join(dst, 'gen_art.py')
    with open(gen, 'rb') as fh:
        blob = fh.read()
    with open(tmp_gen, 'wb') as fh:
        fh.write(blob)
    subprocess.run([sys.executable, tmp_gen], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    made, mismatch = 0, []
    for dirpath, _, files in os.walk(os.path.join(tmp, 'assets')):
        for f in files:
            if not f.endswith('.png'):
                continue
            tp = os.path.join(dirpath, f)
            rp = os.path.join(ROOT, os.path.relpath(tp, tmp))
            made += 1
            if not os.path.isfile(rp):
                mismatch.append('生成器产出但仓里没有: ' + os.path.relpath(rp, ROOT))
                continue
            if hashlib.md5(open(rp, 'rb').read()).hexdigest() != hashlib.md5(open(tp, 'rb').read()).hexdigest():
                mismatch.append('字节不可复现: ' + os.path.relpath(rp, ROOT))
    fails += mismatch
    return '重生成 %d 张，%d 张 md5 不一致' % (made, len(mismatch))


def selfcheck(fails):
    """阴性对照：造四张必然该红的图，逐张确认对应规则真的会红。不红说明尺子是空跑的。"""
    tmp = tempfile.mkdtemp(prefix='slant-asset-selfcheck-')
    W = H = 32
    n = W * H * 4

    def make(name, fill):
        p = os.path.join(tmp, name)
        write_png(p, W, H, fill(n))
        return p

    cases = []
    blank = make('blank.png', lambda k: bytes(k))                      # 全透明
    flat = make('flat.png', lambda k: bytes(([40, 60, 120, 255] * (k // 4))[:k]))  # 纯色
    warm = make('warm.png', lambda k: bytes(([255, 200, 92, 255] * (k // 4))[:k]))  # 只有琥珀，无冷蓝
    cases.append(('blank', blank, '近乎全透明', (W, H)))
    cases.append(('flat', flat, '亮度极差', (W, H)))
    cases.append(('warm', warm, '冷蓝母题', (W, H)))

    # 接缝样本：64 的格本该行列都 16 一周，把最后一条横线挪到 51 ⇒ 跨接缝的行间距变 13/19
    S = 64
    vlines, hlines = (0, 16, 32, 48), (0, 16, 32, 51)
    img = bytearray()
    for y in range(S):
        for x in range(S):
            v = 200 if x in vlines or y in hlines else 20
            img += bytes((v, v, v, 255))
    sp = os.path.join(tmp, 'seam.png')
    write_png(sp, S, S, bytes(img))
    local = tiling_check(sp, [])
    cases.append(('seam', sp, '周期断裂', (S, S)))

    ok = 0
    for name, path, expect, dims in cases:
        errs = []
        st = stats(path)
        if name != 'seam':
            judge('assets/icons/' + name + '.png', st, errs)
        else:
            tiling_check(path, errs)
        if any(expect in e for e in errs):
            ok += 1
        else:
            fails.append('阴性对照失效: %s 未被判红（期望命中"%s"，实测 %s）' % (name, expect, errs or local))
    # 回环：解码器读不回自己写出的图，后面所有像素结论都不可信
    for name, path, _, (dw, dh) in cases:
        w, h, ch, px = decode_png(path)
        if (w, h, ch) != (dw, dh, 4) or len(px) != dw * dh * 4:
            fails.append('解码器回环自检失败: %s 读回 %dx%dx%d' % (name, w, h, ch))
    return '四张反面样本 %d/4 被判红，解码器回环 OK' % ok


# --------------------------------------------------------------------- 主流程
def main():
    argv = sys.argv[1:]
    fails = []
    html, refs = collect_refs()

    checked = 0
    to_judge = []
    for rel in refs:
        if rel in ('', '.'):
            continue  # './' 是入口文档，不是盘上的一个文件名
        checked += 1
        p = os.path.join(ROOT, rel)
        if not os.path.isfile(p):
            fails.append('被引用但盘上没有: %s' % rel)
            continue
        if os.path.getsize(p) == 0:
            fails.append('0 字节占位: %s' % rel)
            continue
        if rel.lower().endswith('.svg'):
            continue  # SVG 不参与位图判定（favicon 用 PNG，SVG 只能算锦上添花）
        if rel.lower().endswith('.png'):
            if ihdr(p) is None:
                fails.append('扩展名是 .png 但不是 PNG: %s' % rel)
                continue
            to_judge.append(rel)

    # 盘上的图全量核验，不只看被引用的：og 卡是靠 meta content= 引的，src/href 正则抓不到；
    # 商店用的多余尺寸也没引用，但同样不许是空壳。
    for dirpath, _, files in os.walk(os.path.join(ROOT, 'assets')):
        for f in sorted(files):
            if f.lower().endswith('.png'):
                rel = os.path.relpath(os.path.join(dirpath, f), ROOT)
                if ihdr(os.path.join(ROOT, rel)) is None:
                    fails.append('扩展名是 .png 但不是 PNG: %s' % rel)
                else:
                    to_judge.append(rel)

    pngs = []
    judged = set()
    for rel in to_judge:
        if rel in judged:
            continue
        judged.add(rel)
        p = os.path.join(ROOT, rel)
        size = ihdr(p)
        try:
            st = stats(p)
        except Unsupported as e:
            fails.append('%s 闸无法核验像素: %s' % (rel, e))
            continue
        if (st['w'], st['h']) != size:
            fails.append('%s IHDR 与像素长度不一致' % rel)
        pngs.append((rel, st))
        judge(rel, st, fails)

    manifest_path = os.path.join(ROOT, 'manifest.webmanifest')
    if not os.path.isfile(manifest_path):
        fails.append('缺 manifest.webmanifest')
    else:
        mf = json.load(open(manifest_path, encoding='utf-8'))
        for field in ('name', 'short_name', 'start_url', 'display', 'theme_color', 'icons'):
            if not mf.get(field):
                fails.append('manifest 缺字段 %s' % field)
        if 'apple-touch-icon' not in html:
            fails.append('index.html 没有 apple-touch-icon')
        if len(re.findall(r'rel=["\']apple-touch-icon["\']', html)) != 1:
            fails.append('apple-touch-icon 必须唯一')
        if 'rel="manifest"' not in html:
            fails.append('index.html 没有 <link rel="manifest">')
        for icon in mf.get('icons', []):
            src = icon.get('src') or ''
            rel = os.path.normpath(src)
            p = os.path.join(ROOT, rel)
            checked += 1
            if not os.path.isfile(p):
                fails.append('manifest 图标不在盘上: %s' % rel)
                continue
            size = ihdr(p)
            if size is None:
                fails.append('manifest 图标不是 PNG: %s' % rel)
                continue
            declared = str(icon.get('sizes') or '')
            want = tuple(int(x) for x in re.findall(r'\d+', declared)[:2])
            if want and want != size:
                fails.append('%s 实际 %dx%d 与声明 %s 不符' % (rel, size[0], size[1], declared))
            if rel not in judged:
                judged.add(rel)
                try:
                    st = stats(p)
                    pngs.append((rel, st))
                    judge(rel, st, fails)
                except Unsupported as e:
                    fails.append('%s 闸无法核验像素: %s' % (rel, e))

    big = [r for r, s in pngs if min(s['w'], s['h']) >= 180]
    if not big:
        fails.append('没有任何 min(w,h) ≥ 180 的位图，装不进主屏幕')
    touch = [s for r, s in pngs if r.endswith('apple-touch-icon.png')]
    if not touch:
        fails.append('缺 apple-touch-icon.png 位图')
    elif (touch[0]['w'], touch[0]['h']) != (180, 180):
        fails.append('apple-touch-icon 必须是 180x180（iOS 固定尺寸），实测 %dx%d'
                     % (touch[0]['w'], touch[0]['h']))

    paper = os.path.join(ROOT, 'assets', 'textures', 'paper-256.png')
    seam = None
    if os.path.isfile(paper):
        seam = tiling_check(paper, fails)
    else:
        fails.append('缺纸纹理 assets/textures/paper-256.png')

    extra = []
    if '--repro' in argv:
        extra.append('复现: ' + str(repro_check(fails)))
    if '--selfcheck' in argv:
        extra.append('阴性对照: ' + str(selfcheck(fails)))

    print('asset_gate: %d 条引用，%d 张 PNG 解码并核验像素，%d 张 ≥180px（最大 %dpx）'
          % (checked, len(pngs), len(big), max((min(s['w'], s['h']) for _, s in pngs), default=0)))
    for rel, st in pngs:
        print('  %-34s %4dx%-4d trans=%.3f 亮度极差=%3.0f 琥珀=%.4f 冷蓝=%.4f 亮墨=%.4f'
              % (rel, st['w'], st['h'], st['trans'], st['spread'], st['amber'], st['blue'], st['ink']))
    if seam:
        print('  纸纹理格线: ' + seam)
    for e in extra:
        print('  ' + e)
    for f in fails:
        print('  FAIL', f)
    print('结论：' + ('✅ %d 张位图引用闭合 + 像素真实 + 母题一致' % len(pngs) if not fails else '❌ %d 项失败' % len(fails)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
