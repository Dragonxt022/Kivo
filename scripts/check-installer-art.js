/**
 * Guarda das artes do instalador (barra lateral e faixa do topo).
 *
 * POR QUE ISTO EXISTE: o MUI do NSIS carrega esses bitmaps com `LoadImage` do Windows, e um BMP
 * de 32 bits (com alpha/bitfields) NÃO carrega — a tela do instalador simplesmente aparece sem a
 * imagem, sem erro no build, sem aviso, e sem nada no log para investigar. Foi o que aconteceu
 * quando a arte foi trocada por versões em alta resolução (RGBA 690x1326 / 1404x537): instalador
 * e desinstalador ficaram sem arte e ninguém sabia por quê. Tamanho diferente do exigido também
 * não é corrigido pelo NSIS — ele não redimensiona.
 *
 * A regra é curta:
 *   installer-sidebar.bmp  164x314   (MUI_WELCOMEFINISHPAGE_BITMAP / MUI_UNWELCOMEFINISHPAGE_BITMAP)
 *   installer-header.bmp   150x57    (MUI_HEADERIMAGE_BITMAP)
 *   24 bits, sem compressão (BI_RGB), sem canal alfa.
 *
 * A arte de origem mora em `build/art/*.png` (em qualquer resolução, com transparência) e o
 * script `scripts/make-installer-art.py` gera os BMPs no formato certo. Roda no `pre` de
 * `dist:win` e `release:win`, para o instalador nunca mais sair sem imagem sem ninguém notar.
 *
 * Uso: node scripts/check-installer-art.js
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');

const REGRAS = [
  {
    arquivo: 'build/installer-sidebar.bmp',
    largura: 164,
    altura: 314,
    onde: 'boas-vindas e fim, na instalação e na desinstalação',
  },
  {
    arquivo: 'build/installer-header.bmp',
    largura: 150,
    altura: 57,
    onde: 'faixa do topo das telas internas',
  },
];

/** Bits por pixel que o NSIS aceita nestas imagens (32 bits com alpha é o caso que não aparece). */
const BITS_ACEITOS = [1, 4, 8, 24];

const COMO_CORRIGIR = [
  'A arte de origem é `build/art/*.png` (pode ter qualquer tamanho e transparência).',
  'Gere os BMPs no formato do NSIS com:',
  '',
  '    python scripts/make-installer-art.py',
  '',
  'O gerador redimensiona, achata a transparência sobre o fundo da marca e grava 24 bits.',
].join('\n');

function lerBmp(caminho) {
  const b = fs.readFileSync(caminho);
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) {
    throw new Error('não é um arquivo BMP (assinatura "BM" ausente).');
  }
  const tamanhoCabecalho = b.readUInt32LE(14);
  if (tamanhoCabecalho < 40) {
    throw new Error(`cabeçalho de BMP inesperado (${tamanhoCabecalho} bytes).`);
  }
  return {
    largura: b.readInt32LE(18),
    altura: Math.abs(b.readInt32LE(22)),
    bits: b.readUInt16LE(28),
    compressao: b.readUInt32LE(30),
    bytes: b.length,
  };
}

function main() {
  const problemas = [];

  for (const regra of REGRAS) {
    const caminho = path.join(RAIZ, regra.arquivo);
    const esperado = `${regra.largura}x${regra.altura}`;

    if (!fs.existsSync(caminho)) {
      problemas.push(`${regra.arquivo}: arquivo não encontrado (esperado ${esperado}, ${regra.onde}).`);
      continue;
    }

    let info;
    try {
      info = lerBmp(caminho);
    } catch (e) {
      problemas.push(`${regra.arquivo}: ${e.message}`);
      continue;
    }

    if (info.largura !== regra.largura || info.altura !== regra.altura) {
      problemas.push(
        `${regra.arquivo}: ${info.largura}x${info.altura} — o NSIS exige ${esperado} ` +
        `(e não redimensiona: o resto da imagem é cortado).`,
      );
      continue;
    }
    if (!BITS_ACEITOS.includes(info.bits)) {
      problemas.push(
        `${regra.arquivo}: ${info.bits} bits por pixel — o instalador só carrega ` +
        `${BITS_ACEITOS.join(', ')} bits. BMP de 32 bits (mesmo "sem compressão") não aparece.`,
      );
      continue;
    }
    if (info.compressao !== 0) {
      problemas.push(
        `${regra.arquivo}: compressão ${info.compressao} — o instalador só carrega BMP sem ` +
        'compressão (BI_RGB = 0).',
      );
      continue;
    }

    console.log(
      `  ok  ${regra.arquivo.padEnd(30)} ${esperado}, ${info.bits} bits, ` +
      `${Math.round(info.bytes / 1024)}KB — ${regra.onde}`,
    );
  }

  if (problemas.length) {
    console.error('\nArte do instalador fora do formato que o NSIS aceita:\n');
    for (const p of problemas) console.error(`  - ${p}`);
    console.error(`\nSintoma quando isso passa batido: a imagem NÃO aparece na instalação nem na\n` +
      'desinstalação, e o build termina sem erro nenhum.\n');
    console.error(`${COMO_CORRIGIR}\n`);
    process.exit(1);
  }

  console.log('\nArte do instalador: OK');
}

main();
