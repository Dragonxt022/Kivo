import zlib from 'node:zlib';

/**
 * Imagens e laudo da demonstração do Odonto.
 *
 * Por que desenhar em código em vez de guardar arquivos no repositório: o Kivo é instalado por
 * um `.exe` de ~96MB e não precisa carregar mais alguns MB de radiografia fictícia. Aqui as
 * imagens nascem na hora, em memória, a partir de formas geométricas — o suficiente para a
 * galeria de exames abrir com conteúdo de verdade (miniatura, zoom, download, impressão) em vez
 * de uma lista vazia.
 *
 * Tudo é DETERMINÍSTICO: mesma entrada, mesmos bytes. Sem isso, o teste automatizado não
 * conseguiria comparar nada entre duas execuções.
 *
 * Nada aqui é dado clínico: são desenhos esquemáticos, não uma radiografia de pessoa alguma.
 */

type Rgb = readonly [number, number, number];

interface PngChunk { type: string; data: Buffer }

/** CRC-32 da especificação do PNG (polinômio 0xEDB88320), montado uma vez. */
let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  // O CRC cobre o TIPO + os dados, sem o campo de tamanho.
  const corpo = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo), 0);
  return Buffer.concat([length, corpo, crc]);
}

/** Tela de desenho simples: fundo, retângulo, elipse e "rabisco" com ruído determinístico. */
class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly px: Uint8Array;

  constructor(width: number, height: number, fill: Rgb) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      this.px[i * 3] = fill[0];
      this.px[i * 3 + 1] = fill[1];
      this.px[i * 3 + 2] = fill[2];
    }
  }

  set(x: number, y: number, color: Rgb, mix = 1): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const i = (yi * this.width + xi) * 3;
    const m = mix < 0 ? 0 : mix > 1 ? 1 : mix;
    this.px[i] = Math.round(this.px[i] + (color[0] - this.px[i]) * m);
    this.px[i + 1] = Math.round(this.px[i + 1] + (color[1] - this.px[i + 1]) * m);
    this.px[i + 2] = Math.round(this.px[i + 2] + (color[2] - this.px[i + 2]) * m);
  }

  /**
   * Ruído determinístico (0..1) — dá textura de tecido em vez de cor chapada.
   *
   * Os chamadores passam coordenadas JÁ divididas (`x >> 2`), de propósito: ruído pixel a pixel
   * é incompressível e fazia a panorâmica passar de 460KB. Em blocos de 4x4 o PNG cai para uma
   * fração disso e a textura continua lá.
   */
  static noise(x: number, y: number): number {
    let h = (x * 73856093) ^ (y * 19349663);
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb, mix = 1): void {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, color, mix);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: Rgb, mix = 1): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const d = nx * nx + ny * ny;
        if (d > 1) continue;
        // Borda suave: dentro de 12% do raio a opacidade cai, evitando serrilhado duro.
        this.set(x, y, color, mix * Math.min(1, (1 - d) * 12));
      }
    }
  }

  /** Retângulo com cantos arredondados — a coroa do dente no desenho. */
  roundRect(x: number, y: number, w: number, h: number, r: number, color: Rgb, mix = 1): void {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = dx < r ? r - dx : dx >= w - r ? dx - (w - r - 1) : 0;
        const cy = dy < r ? r - dy : dy >= h - r ? dy - (h - r - 1) : 0;
        if (cx * cx + cy * cy > r * r) continue;
        this.set(x + dx, y + dy, color, mix);
      }
    }
  }

  /** Triângulo com base em (x, y) e ponta em (x + w/2, y + h) — a raiz do dente. */
  rootTriangle(x: number, y: number, w: number, h: number, color: Rgb, mix = 1): void {
    for (let dy = 0; dy < h; dy++) {
      const largura = w * (1 - dy / h);
      const inicio = x + (w - largura) / 2;
      for (let dx = 0; dx < largura; dx++) this.set(inicio + dx, y + dy, color, mix);
    }
  }

  toPng(): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // 8 bits por canal
    ihdr[9] = 2; // cor verdadeira (RGB)
    ihdr[10] = 0; // compressão deflate
    ihdr[11] = 0; // filtro adaptativo
    ihdr[12] = 0; // sem entrelaçamento

    // Uma linha = 1 byte de filtro (0 = nenhum) + width*3 bytes de pixel.
    const linhas = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      const destino = y * (this.width * 3 + 1);
      linhas[destino] = 0;
      Buffer.from(this.px.buffer, this.px.byteOffset + y * this.width * 3, this.width * 3)
        .copy(linhas, destino + 1);
    }

    const chunks: PngChunk[] = [
      { type: 'IHDR', data: ihdr },
      { type: 'IDAT', data: zlib.deflateSync(linhas, { level: 9 }) },
      { type: 'IEND', data: Buffer.alloc(0) },
    ];
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ...chunks.map((c) => pngChunk(c.type, c.data)),
    ]);
  }
}

const PRETO: Rgb = [8, 10, 14];
const TECIDO: Rgb = [92, 86, 80];
const OSSO: Rgb = [208, 202, 186];
const ESMALTE: Rgb = [246, 246, 240];

/**
 * Radiografia panorâmica: arco dentário completo (14 dentes com coroa e raízes), seios maxilares
 * escuros e a linha da mandíbula. É o exame de boca toda.
 */
export function radiografiaPanoramica(): Buffer {
  const c = new Canvas(1200, 600, PRETO);
  const centroX = 600;
  const topo = 250;

  // Tecido mole ao fundo, com textura: sem isso a imagem fica um retângulo preto.
  for (let y = 0; y < 600; y++) {
    for (let x = 0; x < 1200; x++) {
      c.set(x, y, TECIDO, 0.18 + Canvas.noise(x >> 2, y >> 2) * 0.08);
    }
  }
  // Seios maxilares: duas cavidades escuras acima dos dentes.
  c.ellipse(360, 170, 175, 105, PRETO, 0.85);
  c.ellipse(840, 170, 175, 105, PRETO, 0.85);

  // Osso alveolar: faixa clara que acompanha o arco (parábola suave).
  for (let x = 40; x < 1160; x++) {
    const t = (x - centroX) / 560;
    const y = topo + 120 + t * t * 150;
    c.rect(x, y, 1, 70, OSSO, 0.75);
  }

  // 14 dentes ao longo do arco: coroa para cima, raízes para baixo (como na panorâmica).
  for (let i = 0; i < 14; i++) {
    const t = (i - 6.5) / 6.5;
    const x = centroX + t * 520;
    const y = topo + t * t * 150;
    const largura = 52 - Math.abs(t) * 10;
    c.roundRect(x - largura / 2, y - 6, largura, 58, 12, ESMALTE, 0.95);
    // Raízes: 1 nos dentes posteriores, 2 nos anteriores (aproximação grosseira e suficiente).
    const raizes = Math.abs(t) > 0.45 ? 2 : 1;
    for (let r = 0; r < raizes; r++) {
      const desloc = raizes === 1 ? 0 : (r === 0 ? -largura / 4 : largura / 4);
      c.rootTriangle(x + desloc - largura / 4, y + 50, largura / 2, 120 - Math.abs(t) * 30, OSSO, 0.9);
    }
  }

  // Mandíbula: duas linhas escuras que fecham o arco por baixo.
  for (let x = 60; x < 1140; x++) {
    const t = (x - centroX) / 560;
    const y = topo + 235 + t * t * 150;
    c.rect(x, y, 1, 8, PRETO, 0.7);
    c.rect(x, y + 26, 1, 6, PRETO, 0.5);
  }
  return c.toPng();
}

/** Radiografia periapical: três dentes grandes, um deles com lesão escura na raiz. */
export function radiografiaPeriapical(): Buffer {
  const c = new Canvas(700, 900, PRETO);
  for (let y = 0; y < 900; y++) {
    for (let x = 0; x < 700; x++) c.set(x, y, TECIDO, 0.15 + Canvas.noise(x >> 2, y >> 2) * 0.07);
  }
  c.rect(0, 300, 700, 26, OSSO, 0.7); // crista óssea

  [180, 350, 520].forEach((cx, i) => {
    c.roundRect(cx - 62, 190, 124, 130, 26, ESMALTE, 0.96);
    c.rootTriangle(cx - 34, 310, 68, 300, OSSO, 0.92);
    c.rootTriangle(cx + 4, 310, 40, 250, OSSO, 0.85);
    if (i === 1) {
      // Lesão periapical: mancha escura arredondada no ápice do dente do meio.
      c.ellipse(cx - 10, 640, 62, 48, PRETO, 0.8);
    }
  });

  // Ligamento periodontal: linhas escuras finas contornando as raízes.
  [180, 350, 520].forEach((cx) => c.rect(cx + 40, 320, 5, 260, PRETO, 0.45));
  return c.toPng();
}

/** Tomografia: seis cortes axiais (a "fatia" cinza) em fundo preto, como o visualizador mostra. */
export function tomografia(): Buffer {
  const c = new Canvas(900, 600, PRETO);
  for (let i = 0; i < 6; i++) {
    const cx = 160 + (i % 3) * 290;
    const cy = 165 + Math.floor(i / 3) * 275;
    c.ellipse(cx, cy, 118, 92, TECIDO, 0.9);
    c.ellipse(cx - 8, cy + 4, 86, 66, OSSO, 0.55);
    // Arco dentário visto de cima: pequenos pontos claros em "U".
    for (let d = 0; d < 12; d++) {
      const ang = Math.PI * (0.15 + (d / 11) * 0.7);
      c.ellipse(cx - Math.cos(ang) * 62, cy + Math.sin(ang) * 48, 9, 9, ESMALTE, 0.9);
    }
    c.ellipse(cx, cy, 118, 92, PRETO, 0.12 * i); // cortes mais profundos, um pouco mais escuros
  }
  return c.toPng();
}

/**
 * Fotografia clínica intraoral (arcada superior vista de frente). `antes` sai com tom amarelado e
 * um dente desalinhado; `depois` sai com esmalte mais claro e a arcada alinhada — é o par que a
 * tela de exames usa para a comparação antes/depois da PR §17.
 */
export function fotoClinica(fase: 'antes' | 'depois'): Buffer {
  const c = new Canvas(1000, 700, [40, 22, 24]);
  const antes = fase === 'antes';
  const gengiva: Rgb = antes ? [168, 84, 92] : [186, 102, 108];
  const dente: Rgb = antes ? [236, 230, 206] : [250, 250, 246];

  // Gengiva em duas faixas: fundo mais escuro no céu da boca, gengiva viva na frente.
  for (let y = 0; y < 700; y++) {
    for (let x = 0; x < 1000; x++) c.set(x, y, gengiva, 0.5 + Canvas.noise(x >> 2, y >> 2) * 0.1);
  }
  c.rect(0, 0, 1000, 210, [92, 44, 50], 0.75);
  c.rect(0, 520, 1000, 180, [78, 38, 44], 0.7);

  // Espaçamento de 88px entre os CENTROS, com dente de ~62px: é a fresta de gengiva entre um e
  // outro que faz a arcada parecer arcada. Na primeira versão a posição saiu de `t` (que vai de
  // -1 a 1) multiplicado por 88, então os dez dentes nasceram empilhados num bloco branco só.
  for (let i = 0; i < 10; i++) {
    const t = (i - 4.5) / 4.5;
    const largura = 62 - Math.abs(t) * 8;
    const altura = 172 - Math.abs(t) * 26;
    const x = 500 + (i - 4.5) * 88 - largura / 2;
    // O incisivo central esquerdo nasce torto na foto "antes" — é o "defeito" que a comparação
    // antes/depois da PR §17 mostra corrigido.
    const torto = antes && i === 4 ? 18 : 0;
    const y = 250 + torto + Math.abs(t) * 28;
    c.roundRect(x, y, largura, altura, 14, dente, 0.97);
    // Reflexo da luz na face vestibular: o que dá volume ao dente.
    c.roundRect(x + 10, y + 12, largura - 20, 34, 8, [255, 255, 255], antes ? 0.05 : 0.14);
    // Sombra na borda: separa o dente do vizinho mesmo quando o fundo é claro.
    c.rect(x - 3, y, 3, altura, [60, 24, 28], 0.35);
    c.rect(x + largura, y, 3, altura, [60, 24, 28], 0.35);
  }
  return c.toPng();
}

/**
 * Laudo radiológico em PDF — um PDF válido de uma página, com o texto em Helvetica.
 *
 * Fica aqui, e não como arquivo pronto, pela mesma razão das imagens. E o tipo `documento` do
 * exame precisa de um arquivo que NÃO é imagem: é assim que o botão "abrir em nova aba" e a
 * impressão têm o que testar (a tela trata imagem e PDF por caminhos diferentes).
 */
export function laudoRadiograficoPdf(): Buffer {
  const linhas = [
    'LAUDO RADIOLOGICO - DOCUMENTO DE EXEMPLO',
    '',
    'Este arquivo foi gerado pelo Kivo apenas para demonstracao.',
    'Nao corresponde a nenhum paciente real e nao tem valor clinico.',
    '',
    'Exame: radiografia panoramica',
    'Achados (ficticios):',
    '  - Terceiro molar inferior direito incluso (38).',
    '  - Restauracao em resina no primeiro molar inferior esquerdo (36).',
    '  - Reabsorcao ossea horizontal leve em regiao posterior.',
    '',
    'Conduta (ficticia): avaliacao cirurgica do elemento 38.',
  ];

  const conteudo = [
    'BT',
    '/F1 12 Tf',
    '56 780 Td',
    '18 TL',
    ...linhas.flatMap((linha, i) => (i === 0 ? [`(${linha}) Tj`] : ['T*', `(${linha}) Tj`])),
    'ET',
  ].join('\n');

  // Montagem com offsets reais: o xref precisa da posição exata de cada objeto no arquivo.
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objetos.forEach((corpo, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${corpo}\nendobj\n`;
  });
  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;

  // latin1 (e não utf8): é o que o /Encoding /WinAnsiEncoding do PDF espera.
  return Buffer.from(pdf, 'latin1');
}
