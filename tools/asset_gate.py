#!/usr/bin/env python3
"""资产闸：盘上的位图必须真的被引用，被引用的路径必须真的在盘上。

为什么要有这个脚本：图标类交付最容易注水成"仓库里躺着一张 1024 的 PNG，而 index.html
还指着 data-URI 的 SVG"，或者反过来——manifest 写了 icons 而文件没提交。两种在页面上
都只表现为"没有图标"，而 grep 一把全绿。这里量三件可判定的事：

  1. index.html / css / manifest 里每一条同源资源引用，路径都能解析到真实文件；
  2. 每个被引用的 PNG 是真 PNG（读 IHDR），尺寸与 manifest 声明的 sizes 一致，且不为 0 字节；
  3. 至少存在一张 min(w,h) ≥ 180 的位图 —— 否则装不进主屏幕，也上不了商店截图。

只用标准库：CI 的 ubuntu-latest 不保证有 Pillow，一把依赖第三方库的闸会在装依赖之前先红。
"""
import json
import os
import re
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def ihdr(path):
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', head[16:24])


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


def main():
    fails = []
    checked = 0
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()

    refs = local_refs(html, ROOT)
    css_files = re.findall(r'href="([^"]+\.css)"', html)
    for c in css_files:
        css_path = os.path.normpath(os.path.join(ROOT, c))
        if not os.path.exists(css_path):
            fails.append(f'样式表不存在: {c}')
            continue
        css_dir = os.path.dirname(css_path)
        css_text = open(css_path, encoding='utf-8').read()
        refs += local_refs(css_text, css_dir)
        refs += css_urls(css_text, css_dir)

    sw_path = os.path.join(ROOT, 'sw.js')
    if os.path.isfile(sw_path):
        sw_text = open(sw_path, encoding='utf-8').read()
        refs += [
            os.path.normpath(m.group(1)) for m in re.finditer(r"'(\./[^']+)'", sw_text)
        ]

    refs = [os.path.relpath(os.path.join(ROOT, r), ROOT) for r in refs]

    pngs_seen = []
    for rel in sorted(set(refs)):
        if rel in ('', '.'):
            continue  # './' 是入口文档，不是盘上的一个文件名
        p = os.path.join(ROOT, rel)
        checked += 1
        if not os.path.isfile(p):
            fails.append(f'被引用但盘上没有: {rel}')
            continue
        if os.path.getsize(p) == 0:
            fails.append(f'0 字节占位: {rel}')
        if rel.lower().endswith('.png'):
            size = ihdr(p)
            if size is None:
                fails.append(f'扩展名是 .png 但不是 PNG: {rel}')
            else:
                pngs_seen.append((rel, size))

    manifest_path = os.path.join(ROOT, 'manifest.webmanifest')
    if not os.path.isfile(manifest_path):
        fails.append('缺 manifest.webmanifest')
    else:
        mf = json.load(open(manifest_path, encoding='utf-8'))
        for field in ('name', 'short_name', 'start_url', 'display', 'theme_color', 'icons'):
            if not mf.get(field):
                fails.append(f'manifest 缺字段 {field}')
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
                fails.append(f'manifest 图标不在盘上: {rel}')
                continue
            size = ihdr(p)
            if size is None:
                fails.append(f'manifest 图标不是 PNG: {rel}')
                continue
            declared = str(icon.get('sizes') or '')
            want = tuple(int(x) for x in re.findall(r'\d+', declared)[:2])
            if want and want != size:
                fails.append(f'{rel} 实际 {size[0]}x{size[1]} 与声明 {declared} 不符')
            pngs_seen.append((rel, size))

    big = [r for r, s in pngs_seen if min(s) >= 180]
    if not big:
        fails.append('没有任何 min(w,h) ≥ 180 的位图，装不进主屏幕')

    print(f'asset_gate: {checked} 条引用，{len(pngs_seen)} 张 PNG 过 IHDR，'
          f'{len(big)} 张 ≥180px（最大 {max((min(s) for _, s in pngs_seen), default=0)}px）')
    for f in fails:
        print('  FAIL', f)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
