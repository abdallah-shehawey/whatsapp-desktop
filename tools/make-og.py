#!/usr/bin/env python3
"""Draw docs/assets/og.png, the link-preview card for the landing page.

Chat apps and search engines fetch one 1200x630 image and never the page's CSS,
so the card is drawn here rather than composed in the browser. It reuses the
launcher icon and the site's own palette, and is committed alongside the page --
run this only when the wording or the icon changes.
"""
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON = ROOT / "data/icons/256/apps/io.github.shehawey.whatsapp-desktop.png"
OUT = ROOT / "docs/assets/og.png"

W, H = 1200, 630
BG = (10, 16, 13)
FG = (233, 242, 236)
DIM = (147, 168, 159)
ACCENT = (37, 211, 102)

FONTS = "/usr/share/fonts/dejavu-sans-fonts"


def font(name, size):
    return ImageFont.truetype(f"{FONTS}/{name}", size)


def mono(size):
    """DejaVu ships sans and mono in separate packages on Fedora."""
    path = pathlib.Path("/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf")
    return ImageFont.truetype(str(path), size) if path.exists() else font(
        "DejaVuSans.ttf", size
    )


def glow(img, centre, radius, colour, strength):
    """A soft radial wash, painted per-band so it costs no blur pass."""
    overlay = Image.new("RGB", img.size, colour)
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    steps = 48
    for i in range(steps, 0, -1):
        r = radius * i / steps
        value = int(strength * 255 * (1 - i / steps) ** 2)
        draw.ellipse(
            [centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r], fill=value
        )
    return Image.composite(overlay, img, mask)


card = Image.new("RGB", (W, H), BG)
card = glow(card, (140, 90), 720, (18, 140, 126), 0.55)
card = glow(card, (1120, 610), 620, (37, 211, 102), 0.30)

draw = ImageDraw.Draw(card)

# A hairline of accent down the left edge, the same green as the page's buttons.
draw.rectangle([0, 0, 7, H], fill=ACCENT)

icon = Image.open(ICON).convert("RGBA").resize((176, 176), Image.LANCZOS)
card.paste(icon, (88, 96), icon)

draw.text((88, 312), "whatsapp-desktop", font=font("DejaVuSans-Bold.ttf", 74), fill=FG)
draw.text(
    (88, 404),
    "WhatsApp for Linux — tray, notifications,\ncalls, and your desktop's own font.",
    font=font("DejaVuSans.ttf", 34),
    fill=DIM,
    spacing=14,
)

draw.text(
    (88, 536), "sudo dnf install whatsapp-desktop", font=mono(27), fill=ACCENT
)

OUT.parent.mkdir(parents=True, exist_ok=True)
card.save(OUT, optimize=True)
print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
