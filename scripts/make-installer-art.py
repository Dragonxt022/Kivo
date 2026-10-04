"""Gera as duas artes do instalador NSIS a partir das fontes em `build/art/`.

O QUE O NSIS EXIGE (e o motivo de este script existir):

  - `installer-sidebar.bmp` — 164x314, usado em `MUI_WELCOMEFINISHPAGE_BITMAP` (boas-vindas e
    fim da instalação) e em `MUI_UNWELCOMEFINISHPAGE_BITMAP` (as mesmas telas na desinstalação);
  - `installer-header.bmp`  — 150x57, usado em `MUI_HEADERIMAGE_BITMAP` (faixa do topo das
    telas internas);
  - **24 bits, sem canal alfa, sem compressão** (`BI_RGB`).

Por que não dá para entregar o BMP que sai de uma ferramenta de design: o MUI carrega essas
imagens com `LoadImage` do Windows, e um BMP de **32 bits com alpha/bitfields** simplesmente não
carrega — `LoadImage` devolve 0 e a tela aparece SEM a imagem, sem erro nenhum no build, sem
aviso no instalador. Foi exatamente o que aconteceu quando as artes foram trocadas por versões
em alta resolução (RGBA 690x1326 e 1404x537): o instalador e o desinstalador ficaram sem arte e
nada indicava o motivo. Tamanho fora da medida também não ajuda: o NSIS não redimensiona.

Por isso a arte vive em PNG (com transparência, em qualquer resolução) e este script entrega o
BMP no formato exato — e CONFERE o arquivo que gravou, falhando alto se algo sair diferente.

Uso:  python scripts/make-installer-art.py
"""

from PIL import Image
import os
import struct
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTE = os.path.join(RAIZ, 'build', 'art')
SAIDA = os.path.join(RAIZ, 'build')

# Fundo da marca: é sobre ele que a transparência da arte é achatada (o NSIS não tem alpha).
FUNDO = (22, 24, 29)

# (fonte, destino, (largura, altura), descrição)
ALVOS = [
    ('installer-sidebar.png', 'installer-sidebar.bmp', (164, 314), 'barra lateral (boas-vindas/fim)'),
    ('installer-header.png', 'installer-header.bmp', (150, 57), 'faixa do topo das telas internas'),
]


def achatar(img):
    """Funde o alpha sobre o fundo da marca — sem isso as áreas transparentes saem pretas."""
    img = img.convert('RGBA')
    fundo = Image.new('RGB', img.size, FUNDO)
    fundo.paste(img, mask=img.getchannel('A'))
    return fundo


def conferir(caminho, largura, altura):
    """Relê o BMP gravado e valida o que o NSIS realmente precisa."""
    with open(caminho, 'rb') as f:
        b = f.read()
    if b[:2] != b'BM':
        raise SystemExit(f'{caminho}: não é um BMP.')
    deslocamento, = struct.unpack('<I', b[10:14])
    tamanho_cabecalho, = struct.unpack('<I', b[14:18])
    l, a = struct.unpack('<ii', b[18:26])
    bits, = struct.unpack('<H', b[28:30])
    compressao, = struct.unpack('<I', b[30:34])
    if (l, a) != (largura, altura):
        raise SystemExit(f'{caminho}: {l}x{a} — o NSIS exige {largura}x{altura}.')
    if bits != 24 or compressao != 0:
        raise SystemExit(
            f'{caminho}: {bits} bits, compressão {compressao} — o instalador só carrega BMP de '
            '24 bits sem compressão (32 bits com alpha não aparece, e não dá erro nenhum).',
        )
    if tamanho_cabecalho < 40 or deslocamento < 54:
        raise SystemExit(f'{caminho}: cabeçalho de BMP inesperado.')
    return len(b)


def main():
    if not os.path.isdir(ARTE):
        raise SystemExit(f'faltando a pasta de fontes {ARTE} (a arte original em PNG).')
    for origem, destino, (largura, altura), descricao in ALVOS:
        caminho_origem = os.path.join(ARTE, origem)
        if not os.path.exists(caminho_origem):
            raise SystemExit(f'faltando a fonte {caminho_origem}.')
        img = achatar(Image.open(caminho_origem))
        # LANCZOS porque a fonte é bem maior que o alvo (ex.: 690x1326 -> 164x314).
        img = img.resize((largura, altura), Image.LANCZOS).convert('RGB')
        caminho_saida = os.path.join(SAIDA, destino)
        img.save(caminho_saida, format='BMP')
        tamanho = conferir(caminho_saida, largura, altura)
        print(f'{destino}: {largura}x{altura}, 24 bits, sem compressão, {tamanho} bytes — {descricao}')


if __name__ == '__main__':
    main()
    sys.exit(0)
