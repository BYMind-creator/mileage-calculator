#!/usr/bin/env python3
"""把 Tabler 圖示直接寫進每個 HTML 頁面（不依賴 CDN，斷網也會顯示）。

用法：
  npm pack @tabler/icons@3.19.0 && tar xzf tabler-icons-3.19.0.tgz
  python3 tools/icons.py package/icons

會做兩件事：
  1. HTML 裡的 <i class="ti ti-xxx"></i> 換成 <svg class="ic"><use href="#ti-xxx"/></svg>
  2. 掃描所有 HTML 與 assets/*.js 用到的 ti-xxx，產生 SVG sprite，
     寫進每個 HTML 的 <!--ICONS:START--> 與 <!--ICONS:END--> 之間
新增圖示時，在 HTML 或 JS 寫上 ti-名稱，再執行一次即可。
"""
import glob, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG = sys.argv[1] if len(sys.argv) > 1 else 'package/icons'

htmls = glob.glob(os.path.join(ROOT, '*.html'))
jss = glob.glob(os.path.join(ROOT, 'assets', '*.js'))
NAME = re.compile(r'(?<=["\'#\s])ti-[a-z0-9-]+')

def svg_symbol(name):
    base = name[3:]
    filled = base.endswith('-filled')
    path = os.path.join(PKG, 'filled' if filled else 'outline', (base[:-7] if filled else base) + '.svg')
    src = open(path, encoding='utf-8').read()
    inner = re.search(r'<svg[^>]*>(.*)</svg>', src, re.S).group(1)
    inner = re.sub(r'<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*/>', '', inner)
    inner = re.sub(r'\s+', ' ', inner).strip()
    g = '<g fill="currentColor" stroke="none">' if filled else '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    return f'<symbol id="{name}" viewBox="0 0 24 24">{g}{inner}</g></symbol>'

names = set()
for f in htmls:
    s = open(f, encoding='utf-8').read()
    s = re.sub(r'<i class="ti (ti-[a-z0-9-]+)((?: [a-z-]+)*)"([^>]*)></i>', r'<svg class="ic\2"\3><use href="#\1"/></svg>', s)
    s = re.sub(r'<!--ICONS:START-->.*?<!--ICONS:END-->', '<!--ICONS:START--><!--ICONS:END-->', s, flags=re.S)
    open(f, 'w', encoding='utf-8').write(s)
    names |= set(NAME.findall(s))
for f in jss:
    names |= set(NAME.findall(open(f, encoding='utf-8').read()))
names = sorted(n for n in names if n != 'ti-')

sprite = ('<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">'
          + ''.join(svg_symbol(n) for n in names) + '</svg>')
for f in htmls:
    s = open(f, encoding='utf-8').read()
    if '<!--ICONS:START-->' in s:
        s = s.replace('<!--ICONS:START--><!--ICONS:END-->', '<!--ICONS:START-->' + sprite + '<!--ICONS:END-->')
        open(f, 'w', encoding='utf-8').write(s)
print(f'{len(names)} icons -> {len(htmls)} pages')
