"""Gera as artes do instalador NSIS do Kivo (Pillow do runtime do DSH).

O electron-builder usa dois bitmaps do NSIS:
  - `installer-sidebar.bmp`  164x314 — faixa lateral das telas de boas-vindas/fim;
  - `installer-header.bmp`   150x57  — faixa do topo das telas internas.

Identidade: laranja da marca (#FF8000) sobre fundo escuro, mesma dupla do splash e do ícone.
São arquivos gerados (não versionados por engano): o `build/` guarda o resultado.
"""
from PIL import Image, ImageDraw, ImageFont
import os

ORANGE = (255, 128, 0)
DARK = (22, 24, 29)
DARK2 = (34, 37, 45)
WHITE = (255, 255, 255)
MUTED = (168, 172, 182)

BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build')
FONT_BOLD = r'C:\Windows\Fonts\arialbd.ttf'
FONT_REG = r'C:\Windows\Fonts\arial.ttf'


def fonte(caminho, tamanho):
    try:
        return ImageFont.truetype(caminho, tamanho)
    except OSError:
        return ImageFont.load_default()


def fundo(w, h):
    """Fundo escuro com um degrade suave e uma faixa laranja na diagonal."""
    img = Image.new('RGB', (w, h), DARK)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        cor = tuple(int(DARK[i] + (DARK2[i] - DARK[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=cor)
    # Faixa diagonal da marca, saindo do canto superior direito.
    d.polygon([(w, 0), (w, int(h * 0.34)), (int(w * 0.18), 0)], fill=ORANGE)
    return img, d


def marca(d, x, y, escala=1.0):
    """O 'K' da logo desenhado com dois traços — sem depender de rasterizar o SVG."""
    l = int(26 * escala)
    e = max(2, int(5 * escala))
    d.line([(x, y), (x, y + l)], fill=WHITE, width=e)
    d.line([(x, y + l // 2), (x + l * 0.8, y)], fill=WHITE, width=e)
    d.line([(x, y + l // 2), (x + l * 0.8, y + l)], fill=ORANGE, width=e)


def sidebar():
    w, h = 164, 314
    img, d = fundo(w, h)
    marca(d, 22, 26, 1.5)
    d.text((22, 92), 'Kivo', font=fonte(FONT_BOLD, 34), fill=WHITE)
    d.line([(22, 138), (78, 138)], fill=ORANGE, width=3)
    for i, linha in enumerate(['Sistema de', 'gestão para o', 'seu negócio']):
        d.text((22, 152 + i * 20), linha, font=fonte(FONT_REG, 15), fill=MUTED)
    d.text((22, h - 34), 'Instalador', font=fonte(FONT_REG, 12), fill=MUTED)
    img.save(os.path.join(BUILD, 'installer-sidebar.bmp'))
    print('build/installer-sidebar.bmp', img.size)


def header():
    w, h = 150, 57
    img, d = fundo(w, h)
    marca(d, 12, 14, 0.85)
    d.text((52, 17), 'Kivo', font=fonte(FONT_BOLD, 22), fill=WHITE)
    img.save(os.path.join(BUILD, 'installer-header.bmp'))
    print('build/installer-header.bmp', img.size)


os.makedirs(BUILD, exist_ok=True)
sidebar()
header()
