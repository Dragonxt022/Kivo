/**
 * Gera os packs de ícones pagos da loja de temas do Kivo Cloud.
 *
 * Lê o conjunto canônico de `src/public/icons` e escreve, para cada segmento, uma pasta em
 * `cloud/seed-themes/<slug>/` com os mesmos nomes de arquivo (contrato: cart.svg → "cart") e
 * uma `capa.svg`. O seed do cloud (`cloud/src/seed-themes.ts`) lê essas pastas e cadastra os
 * temas como PAGOS.
 *
 * Estilo: cada ícone vira um "tile" — um quadrado arredondado com um tom claro de fundo e o
 * traço na cor do segmento. Roda localmente: `node scripts/gen-theme-packs.js`.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'src', 'public', 'icons');
const OUT_DIR = path.join(ROOT, 'cloud', 'seed-themes');

const PACKS = [
  {
    slug: 'vitrine-viva',
    name: 'Vitrine Viva',
    tagline: 'Para lojas e comércio',
    description: 'Ícones para lojas e comércio: vitrine, vendas, caixa e estoque com um toque moderno.',
    price_cents: 3990,
    color: '#4f46e5',
    tint: '#eef2ff',
    accent: '#818cf8',
  },
  {
    slug: 'bem-estar-verde',
    name: 'Bem Estar Verde',
    tagline: 'Para farmácias e drogarias',
    description: 'Para farmácias e drogarias: saúde, cuidado e confiança em verde.',
    price_cents: 3990,
    color: '#0d9488',
    tint: '#ecfdf5',
    accent: '#2dd4bf',
  },
  {
    slug: 'maos-a-obra',
    name: 'Mãos à Obra',
    tagline: 'Para prestadores de serviço',
    description: 'Para prestadores de serviço: orçamento, agenda e execução com energia.',
    price_cents: 3490,
    color: '#ea580c',
    tint: '#fff7ed',
    accent: '#fb923c',
  },
  {
    slug: 'sabor-na-chapa',
    name: 'Sabor na Chapa',
    tagline: 'Para lanchonetes e hamburguerias',
    description: 'Para lanchonetes e hamburguerias: sabor, velocidade e pedidos na cozinha.',
    price_cents: 3490,
    color: '#dc2626',
    tint: '#fef2f2',
    accent: '#f87171',
  },
  {
    slug: 'patinha-feliz',
    name: 'Patinha Feliz',
    tagline: 'Para pet shops e veterinárias',
    description: 'Para pet shops e veterinárias: ração, banho e tosa com carinho.',
    price_cents: 2990,
    color: '#7c3aed',
    tint: '#f5f3ff',
    accent: '#a78bfa',
  },
  {
    slug: 'gelato-doce',
    name: 'Gelato Doce',
    tagline: 'Para sorveterias e açaí',
    description: 'Para sorveterias e açaí: cores doces para um cardápio divertido.',
    price_cents: 2990,
    color: '#db2777',
    tint: '#fdf2f8',
    accent: '#f472b6',
  },
];

function innerOf(svg) {
  return svg.slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'));
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** Tile: fundo arredondado + traço na cor do segmento. */
function styledIcon(svg, pack) {
  const body = innerOf(svg).replace(/currentColor/g, pack.color);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${pack.color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="${pack.tint}"/>${body}</svg>`
  );
}

/** Capa 720×420: gradiente do segmento, nome, tagline e uma fileira de ícones. */
function coverSvg(pack, icons) {
  const samples = ['cart', 'users', 'package', 'wallet', 'chart']
    .map((n) => icons[n])
    .filter(Boolean)
    .slice(0, 5);
  const tiles = samples
    .map((svg, i) => {
      const x = 60 + i * 120;
      const body = innerOf(svg).replace(/currentColor/g, '#ffffff');
      return (
        `<g transform="translate(${x},244)">` +
        `<rect x="0" y="0" width="88" height="88" rx="20" fill="rgba(255,255,255,0.16)"/>` +
        `<g transform="translate(20,20) scale(2)" stroke="#ffffff">${body}</g></g>`
      );
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${pack.color}"/><stop offset="1" stop-color="${pack.accent}"/>` +
    `</linearGradient></defs>` +
    `<rect width="720" height="420" fill="url(#bg)"/>` +
    `<circle cx="640" cy="70" r="140" fill="rgba(255,255,255,0.08)"/>` +
    `<text x="60" y="130" font-family="system-ui, -apple-system, sans-serif" font-size="56" font-weight="800" fill="#ffffff">${escapeXml(pack.name)}</text>` +
    `<text x="60" y="176" font-family="system-ui, -apple-system, sans-serif" font-size="22" fill="rgba(255,255,255,0.9)">${escapeXml(pack.tagline)}</text>` +
    tiles +
    `<text x="60" y="392" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" letter-spacing="1" fill="rgba(255,255,255,0.9)">KIVO · TEMA PREMIUM</text>` +
    `</svg>`
  );
}

function main() {
  const iconFiles = fs.readdirSync(ICONS_DIR).filter((f) => f.toLowerCase().endsWith('.svg'));
  if (!iconFiles.length) {
    console.error('Nenhum ícone em', ICONS_DIR);
    process.exit(1);
  }
  const originals = {};
  for (const f of iconFiles) originals[f.slice(0, -4)] = fs.readFileSync(path.join(ICONS_DIR, f), 'utf8');

  fs.rmSync(OUT_DIR, { recursive: true, force: true });

  for (const pack of PACKS) {
    const dir = path.join(OUT_DIR, pack.slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, svg] of Object.entries(originals)) {
      fs.writeFileSync(path.join(dir, `${name}.svg`), styledIcon(svg, pack));
    }
    fs.writeFileSync(path.join(dir, 'capa.svg'), coverSvg(pack, originals));
    fs.writeFileSync(
      path.join(dir, 'theme.json'),
      JSON.stringify(
        { slug: pack.slug, name: pack.name, description: pack.description, price_cents: pack.price_cents },
        null,
        2,
      ),
    );
    console.log(`${pack.slug}: ${iconFiles.length} ícones + capa`);
  }
  console.log('Pronto em', path.relative(ROOT, OUT_DIR));
}

main();
