#!/usr/bin/env python3
"""Generate GTSS Growth Engine icons (PNG, ICO, ICNS, tray-icon.png).

Creates a branded square icon with a gradient background and a "G" mark,
in all the sizes electron-builder needs.

Output:
  desktop/build/icon.png        512x512 PNG  (Linux + electron-builder source)
  desktop/build/icon.ico        Multi-size ICO (16/24/32/48/64/128/256)
  desktop/build/icon.icns       Multi-size ICNS (16..512 + 1024)
  desktop/build/tray-icon.png   32x32 PNG (monochrome-ish, for system tray)
"""

import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow is required: pip install Pillow", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
BUILD_DIR = os.path.join(REPO_ROOT, "desktop", "build")
os.makedirs(BUILD_DIR, exist_ok=True)


def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def draw_gradient(size, top_color, bottom_color):
    """Vertical gradient from top_color to bottom_color."""
    img = Image.new("RGB", (size, size), top_color)
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        c = lerp_color(top_color, bottom_color, t)
        for x in range(size):
            px[x, y] = c
    return img


def rounded_mask(size, radius):
    """Return an L-mode mask with rounded corners."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def find_font(size_px):
    """Find a usable bold sans-serif font on the system."""
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:\\Windows\\Fonts\\arialbd.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size_px)
            except Exception:
                continue
    return ImageFont.load_default()


def make_icon(size, with_rounded=True):
    """Render the GTSS icon at the requested size."""
    # Brand gradient: indigo (#6366f1) → violet (#8b5cf6)
    img = draw_gradient(size, (99, 102, 241), (139, 92, 246))

    # Apply rounded corners if requested.
    if with_rounded and size >= 32:
        mask = rounded_mask(size, int(size * 0.18))
        bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bg.paste(img, (0, 0), mask)
        img = bg.convert("RGB")
        img.putalpha(mask)

    # Draw the "G" glyph centered.
    draw = ImageDraw.Draw(img)
    font_size = int(size * 0.62)
    font = find_font(font_size)
    text = "G"
    # Compute text bounding box.
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = (size - tw) // 2 - bbox[0]
        ty = (size - th) // 2 - bbox[1] - int(size * 0.02)
    except AttributeError:
        # Older Pillow without textbbox.
        tw, th = draw.textsize(text, font=font)
        tx = (size - tw) // 2
        ty = (size - th) // 2 - int(size * 0.05)
    draw.text((tx, ty), text, fill=(255, 255, 255), font=font)
    return img


def make_tray_icon(size=32):
    """Render a simplified, high-contrast icon for the system tray."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Solid indigo square with rounded corners.
    draw.rounded_rectangle([1, 1, size - 2, size - 2], radius=int(size * 0.2),
                           fill=(99, 102, 241, 255))
    # White "G".
    font = find_font(int(size * 0.6))
    text = "G"
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = (size - tw) // 2 - bbox[0]
        ty = (size - th) // 2 - bbox[1]
    except AttributeError:
        tw, th = draw.textsize(text, font=font)
        tx = (size - tw) // 2
        ty = (size - th) // 2
    draw.text((tx, ty), text, fill=(255, 255, 255, 255), font=font)
    return img


def main():
    # 1. PNG — 512x512, used by Linux + as electron-builder's source-of-truth.
    png_path = os.path.join(BUILD_DIR, "icon.png")
    make_icon(512).save(png_path, "PNG")
    print(f"Wrote {png_path}")

    # 2. ICO — multi-size for Windows. Pillow generates all sizes from a
    #    single source image when you pass the `sizes` parameter.
    ico_path = os.path.join(BUILD_DIR, "icon.ico")
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    make_icon(256).save(ico_path, format="ICO", sizes=ico_sizes)
    print(f"Wrote {ico_path}")

    # 3. ICNS — multi-size for macOS. Same pattern: one source, multiple sizes.
    icns_path = os.path.join(BUILD_DIR, "icon.icns")
    make_icon(1024).save(icns_path, format="ICNS")
    print(f"Wrote {icns_path}")

    # 4. Tray icon — 32x32 PNG with alpha.
    tray_path = os.path.join(BUILD_DIR, "tray-icon.png")
    make_tray_icon(32).save(tray_path, "PNG")
    print(f"Wrote {tray_path}")

    # 5. Also save a 1024x1024 PNG — useful for marketing / website.
    big_path = os.path.join(BUILD_DIR, "icon-1024.png")
    make_icon(1024).save(big_path, "PNG")
    print(f"Wrote {big_path}")


if __name__ == "__main__":
    main()
