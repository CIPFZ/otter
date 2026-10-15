#!/usr/bin/env python3
"""Build the Otter icon pack from the SVG masters.

Outputs (under Assets/icon/dist):
  png/icon-{size}.png        16 20 24 29 32 40 48 58 60 64 76 80 87 120 128 152 167 180 192 256 512 1024
  favicon.ico                16 32 48
  favicon.svg                symbol with prefers-color-scheme
  otter.icns                 macOS (via icnsutil)
  otter.ico                  16 24 32 48 64 128 256
  pwa/icon-192.png, icon-512.png, maskable-512.png
  social/og-1200x630.png
Sizes <= 48 use otter-icon-small.svg, larger use otter-icon.svg.
"""
from __future__ import annotations
import io, os, shutil, subprocess, sys
from pathlib import Path
import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "Assets" / "icon"
DIST = ROOT / "dist"
MASTER = ROOT / "otter-icon.svg"
SMALL = ROOT / "otter-icon-small.svg"
SYMBOL = ROOT / "otter-symbol.svg"

SIZES = [16, 20, 24, 29, 32, 40, 48, 58, 60, 64, 76, 80, 87, 120, 128, 152, 167, 180, 192, 256, 512, 1024]
SMALL_MAX = 48


def render(svg: Path, size: int) -> Image.Image:
    png = cairosvg.svg2png(url=str(svg), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main() -> int:
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "png").mkdir(parents=True)
    (DIST / "pwa").mkdir()
    (DIST / "social").mkdir()

    cache: dict[int, Image.Image] = {}
    for s in SIZES:
        img = render(SMALL if s <= SMALL_MAX else MASTER, s)
        img.save(DIST / "png" / f"icon-{s}.png", optimize=True)
        cache[s] = img

    # favicon.ico + Windows otter.ico
    cache[16].save(DIST / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
                   append_images=[cache[32], cache[48]])
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    cache[16].save(DIST / "otter.ico", format="ICO", sizes=[(s, s) for s in ico_sizes],
                   append_images=[cache[s] for s in ico_sizes[1:]])

    # favicon.svg: symbol that follows color scheme
    sym = SYMBOL.read_text()
    sym = sym.replace('color="#1EE9E6"', 'color="#12C9D4"')
    sym = sym.replace("<defs>", "<style>@media (prefers-color-scheme: dark){g{color:#1EE9E6 !important}}</style><defs>", 1)
    (DIST / "favicon.svg").write_text(sym)

    # PWA
    shutil.copy(DIST / "png" / "icon-192.png", DIST / "pwa" / "icon-192.png")
    shutil.copy(DIST / "png" / "icon-512.png", DIST / "pwa" / "icon-512.png")
    # maskable: safe zone is central 80%, so render master at 80% on full bg
    mask = Image.new("RGBA", (512, 512), "#243447")
    inner = render(MASTER, 410)
    # remove rounded corners of the inner tile by compositing on bg: already bg-colored, fine
    mask.alpha_composite(inner, ((512 - 410) // 2, (512 - 410) // 2))
    mask.save(DIST / "pwa" / "maskable-512.png", optimize=True)

    # Social OG image
    og = Image.new("RGBA", (1200, 630), "#243447")
    tile = render(MASTER, 400)
    og.alpha_composite(tile, (120, 115))
    og.save(DIST / "social" / "og-1200x630.png", optimize=True)

    # macOS icns via icnsutil (needs Apple iconset naming to infer types)
    tmp = DIST / "_icns"
    tmp.mkdir()
    args = []
    for base in (16, 32, 128, 256, 512):
        p1 = tmp / f"icon_{base}x{base}.png"
        p2 = tmp / f"icon_{base}x{base}@2x.png"
        cache[base].save(p1)
        cache[base * 2].save(p2)
        args += [str(p1), str(p2)]
    try:
        subprocess.run(["icnsutil", "compose", str(DIST / "otter.icns"), *args], check=True, capture_output=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print("icns skipped:", getattr(e, "stderr", b"").decode() or e, file=sys.stderr)
    shutil.rmtree(tmp)

    print("icon pack written to", DIST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
