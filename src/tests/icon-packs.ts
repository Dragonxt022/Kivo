/**
 * Pacotes de ícones: descoberta da pasta storage/peck-icon, override sobre o conjunto
 * padrão, fallback do ícone ausente e ignoro de pastas só com raster (PNG).
 */
import fs from 'node:fs';
import path from 'node:path';
import { iconPacksDir, listIconPacks, resolveIconHelpers } from '../core/icons/service';

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

const SVG_MARCADO = '<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>';
const packDir = path.join(iconPacksDir(), 'teste-pack');
const rasterDir = path.join(iconPacksDir(), 'so-png');

function main() {
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'cart.svg'), SVG_MARCADO);
  fs.writeFileSync(path.join(packDir, 'leia-me.txt'), 'ignorar');
  fs.mkdirSync(rasterDir, { recursive: true });
  fs.writeFileSync(path.join(rasterDir, 'carrinho.png'), 'nao-e-svg');

  try {
    const { packs, ignorados } = listIconPacks();
    check('conjunto padrão sempre listado', packs.some((p) => p.id === 'padrao'));
    const t = packs.find((p) => p.id === 'teste-pack');
    check('pacote com SVG é descoberto', !!t && t.icons === 1, t ? `${t.icons} ícone(s)` : 'ausente');
    check('pasta só com PNG é ignorada', ignorados.includes('so-png'), ignorados.join(','));

    const h = resolveIconHelpers('teste-pack');
    check('override do pacote vale', h.svgIcon('cart').includes('M1 1'));
    check('ícone ausente cai no padrão', h.svgIcon('users').includes('<svg') && !h.svgIcon('users').includes('M1 1'));
    check('dimensões são aplicadas', h.svgIcon('cart', 16, 16).includes('width="16"'));

    const padrao = resolveIconHelpers('');
    check('pacote padrão não tem o override', !padrao.svgIcon('cart').includes('M1 1'));
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.rmSync(rasterDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nPacotes de ícones: TODOS OS TESTES PASSARAM' : `\n${failures} falha(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
