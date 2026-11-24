"""Generate the SolarOS and SolarDeck for Proxmox VE logos (SVG): sun + orbit arrows mark and a stroke-drawn wordmark.
Usage: python3 frontend/scripts/generate-logos.py frontend/public/brand"""
import math
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- stroke font (centerline box: 0..w x 0..100)
R_ROUND = 40
def rr(w, r=R_ROUND):  # rounded rectangle
    return (f"M{r},0 H{w-r} A{r},{r} 0 0 1 {w},{r} V{100-r} A{r},{r} 0 0 1 {w-r},100 H{r} "
            f"A{r},{r} 0 0 1 0,{100-r} V{r} A{r},{r} 0 0 1 {r},0 Z")

def bowl(w):  # P/R upper bowl
    return f"M0,100 V0 H{w-25} A25,25 0 0 1 {w},25 A25,25 0 0 1 {w-25},50 H0"

GLYPHS = {
    "O": (112, rr(112)),
    "C": (98, f"M98,0 H40 A40,40 0 0 0 0,40 V60 A40,40 0 0 0 40,100 H98"),
    "G": (104, f"M104,0 H40 A40,40 0 0 0 0,40 V60 A40,40 0 0 0 40,100 H104 V56 H66"),
    "S": (100, "M100,0 H25 A25,25 0 0 0 0,25 A25,25 0 0 0 25,50 H75 A25,25 0 0 1 100,75 A25,25 0 0 1 75,100 H0"),
    "L": (84, "M0,0 V100 H84"),
    "A": (106, "M0,100 V40 A40,40 0 0 1 40,0 H66 A40,40 0 0 1 106,40 V100 M0,62 H106"),
    "R": (100, bowl(100) + " M62,50 L100,100"),
    "P": (96, bowl(96)),
    "D": (106, "M0,0 H66 A40,40 0 0 1 106,40 V60 A40,40 0 0 1 66,100 H0 Z"),
    "E": (88, "M88,0 H0 V100 H88 M0,50 H74"),
    "F": (84, "M84,0 H0 V100 M0,50 H70"),
    "K": (94, "M0,0 V100 M94,0 L0,52 M30,36 L94,100"),
    "X": (100, "M0,0 L100,100 M100,0 L0,100"),
    "M": (116, "M0,100 V0 L58,58 L116,0 V100"),
    "V": (106, "M0,0 L53,100 L106,0"),
    "H": (96, "M0,0 V100 M96,0 V100 M0,50 H96"),
    "Y": (100, "M0,0 L50,52 L100,0 M50,52 V100"),
    "I": (0, "M0,0 V100"),
    "T": (96, "M0,0 H96 M48,0 V100"),
    "N": (100, "M0,100 V0 L100,100 V0"),
    "U": (100, "M0,0 V60 A40,40 0 0 0 40,100 H60 A40,40 0 0 0 100,60 V0"),
    " ": (36, ""),
}

def word(text, x0, top, cap, stroke_units, gap_units):
    """Paths for text whose outer cap height is `cap` px with its top edge at `top`. Returns (svg paths, width px)."""
    k = cap / (100 + stroke_units)
    off = stroke_units / 2
    x, parts = 0.0, []
    for i, ch in enumerate(text):
        w, d = GLYPHS[ch]
        if d:
            parts.append(f'<path transform="translate({x0 + (x + off) * k:.2f} {top + off * k:.2f}) scale({k:.4f})" d="{d}"/>')
        x += w + (stroke_units if d else 0) + (gap_units if i < len(text) - 1 else 0)
    return "\n    ".join(parts), x * k, stroke_units * k

# ---------------------------------------------------------------- mark (240 x 240)
C = 120
def pt(r, deg):
    a = math.radians(deg)
    return C + r * math.cos(a), C + r * math.sin(a)

def arrow_arc(r, start, end, width, head_len, head_w):
    """Clockwise arc start->end (degrees, SVG orientation) ending in a filled arrowhead."""
    stop = end - math.degrees(head_len * 0.55 / r)
    x1, y1 = pt(r, start)
    x2, y2 = pt(r, stop)
    large = 1 if (stop - start) % 360 > 180 else 0
    arc = f"M{x1:.2f},{y1:.2f} A{r},{r} 0 {large} 1 {x2:.2f},{y2:.2f}"
    a = math.radians(stop)
    tx, ty = -math.sin(a), math.cos(a)  # clockwise tangent
    nx, ny = math.cos(a), math.sin(a)
    tip = (x2 + tx * head_len, y2 + ty * head_len)
    b1 = (x2 + nx * head_w / 2 - tx * 2, y2 + ny * head_w / 2 - ty * 2)
    b2 = (x2 - nx * head_w / 2 - tx * 2, y2 - ny * head_w / 2 - ty * 2)
    head = f"M{tip[0]:.2f},{tip[1]:.2f} L{b1[0]:.2f},{b1[1]:.2f} L{b2[0]:.2f},{b2[1]:.2f} Z"
    return arc, head

def mark(glyph, light):
    white_arc = "#1C2A45" if light else "url(#gWhite)"
    o_arc, o_head = arrow_arc(106, 140, 292, 12, 30, 34)
    w_arc, w_head = arrow_arc(106, 322, 470, 12, 30, 34)
    rays = "".join(
        f'<line x1="{pt(62, a)[0]:.2f}" y1="{pt(62, a)[1]:.2f}" x2="{pt(78, a)[0]:.2f}" y2="{pt(78, a)[1]:.2f}"/>'
        for a in [i * 22.5 + 11.25 for i in range(16)])
    if glyph == "power":
        gx1, gy1 = pt(21, 312)
        gx2, gy2 = pt(21, 228)
        center = (f'<path d="M{gx1:.2f},{gy1:.2f} A21,21 0 1 1 {gx2:.2f},{gy2:.2f}" fill="none"/>'
                  f'<line x1="120" y1="92" x2="120" y2="119"/>')
        center = f'<g stroke="#fff" stroke-width="8" stroke-linecap="round" fill="none">{center}</g>'
    else:  # app grid
        center = "".join(f'<rect x="{x}" y="{y}" width="17" height="17" rx="4.5"/>'
                         for x in (100.5, 122.5) for y in (100.5, 122.5))
        center = f'<g fill="#fff">{center}</g>'
    return f"""<g>
    <path d="{o_arc}" fill="none" stroke="url(#gOrange)" stroke-width="12" stroke-linecap="round"/>
    <path d="{o_head}" fill="#FF8A1F"/>
    <path d="{w_arc}" fill="none" stroke="{white_arc}" stroke-width="12" stroke-linecap="round"/>
    <path d="{w_head}" fill="{'#1C2A45' if light else '#E9EEF6'}"/>
    <g stroke="url(#gRay)" stroke-width="7.5" stroke-linecap="round">{rays}</g>
    <circle cx="120" cy="120" r="50" fill="url(#gSun)"/>
    <circle cx="120" cy="120" r="50" fill="url(#gShine)"/>
    {center}
  </g>"""

DEFS = """<defs>
    <linearGradient id="gOrange" x1="0" y1="1" x2="0.6" y2="0"><stop offset="0" stop-color="#FF6A00"/><stop offset="1" stop-color="#FFB23E"/></linearGradient>
    <linearGradient id="gWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9D3E3"/></linearGradient>
    <linearGradient id="gRay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFB23E"/><stop offset="1" stop-color="#FF7414"/></linearGradient>
    <radialGradient id="gSun" cx="0.42" cy="0.38" r="0.7"><stop offset="0" stop-color="#FFD45C"/><stop offset="0.55" stop-color="#FF9A26"/><stop offset="1" stop-color="#FF6A00"/></radialGradient>
    <radialGradient id="gShine" cx="0.35" cy="0.28" r="0.45"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.35"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
    <linearGradient id="gText" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFB23E"/><stop offset="1" stop-color="#FF7414"/></linearGradient>
  </defs>"""

def logo(name, title, glyph, accent, subtitle, light=False):
    text_main = "#13203A" if light else "#FFFFFF"
    x0 = 268
    p1, w1, s1 = word("SOLAR", x0, 62, 82, 32, 26)
    p2, w2, _ = word(accent, x0 + w1 + 26 * 82 / 132, 62, 82, 32, 26)
    p3, w3, s3 = word(subtitle, x0 + 4, 168, 27, 24, 56)
    width = int(x0 + max(w1 + 26 * 82 / 132 + w2, w3 + 4) + 16)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 240" width="{width}" height="240" role="img" aria-label="{title}">
  <title>{title}</title>
  {DEFS}
  {mark(glyph, light)}
  <g fill="none" stroke="{text_main}" stroke-width="{s1:.2f}" stroke-linecap="round" stroke-linejoin="round">
    {p1}
  </g>
  <g fill="none" stroke="url(#gText)" stroke-width="{s1:.2f}" stroke-linecap="round" stroke-linejoin="round">
    {p2}
  </g>
  <g fill="none" stroke="#FF9A2E" stroke-width="{s3:.2f}" stroke-linecap="round" stroke-linejoin="round">
    {p3}
  </g>
</svg>
"""

def mark_svg(title, glyph):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240" role="img" aria-label="{title}">
  <title>{title}</title>
  {DEFS}
  {mark(glyph, False)}
</svg>
"""

PRODUCTS = [
    ("solaros", "SolarOS", "power", "OS", "HYPERVISOR PLATFORM"),
    ("solardeck-proxmox", "SolarDeck for Proxmox VE", "grid", "DECK", "FOR PROXMOX VE"),
]
for slug, title, glyph, accent, sub in PRODUCTS:
    (OUT / f"{slug}-logo.svg").write_text(logo(slug, title, glyph, accent, sub))
    (OUT / f"{slug}-logo-light.svg").write_text(logo(slug, title, glyph, accent, sub, light=True))
    (OUT / f"{slug}-mark.svg").write_text(mark_svg(title, glyph))
print("\n".join(sorted(p.name for p in OUT.iterdir())))
