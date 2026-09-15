import fs from 'node:fs';
import path from 'node:path';
import { settingsRepository } from '../repositories/SettingsRepository';

/**
 * Pacotes de ícones (temas visuais) do Kivo.
 *
 * O app sempre usou um único conjunto de SVGs em public/icons, resolvido por `svgIcon()`.
 * Aqui os nomes desses arquivos viram o CONTRATO: cada pacote é uma pasta em
 * storage/peck-icon/<id>/ com SVGs de mesmo nome — ou um manifest.json traduzindo o nome
 * lógico para o arquivo (`{ "cart": "carrinho.svg" }`). O ícone que não existir no pacote
 * cai no conjunto padrão, então um pacote incompleto nunca deixa a tela com buracos.
 *
 * Só SVG de propósito: os ícones entram inline e usam `currentColor`, então acompanham a cor
 * do tema e ficam nítidos em qualquer tamanho. Raster (PNG) não recolore nem escala — por
 * isso pastas só com PNG são listadas como ignoradas, não como pacote.
 */

export const ICON_PACK_SETTING = 'interface.pacote_icones';
/**
 * Id do pacote padrão. É um valor REAL (e não string vazia) de propósito: `<option value="">`
 * faz o navegador devolver o TEXTO da opção como valor do select, então "voltar ao padrão"
 * mandava "Padrão Kivo (36 ícones)" para a API e era recusado. Vazio continua aceito na
 * leitura (instalações antigas/semeadas) e é normalizado para este id.
 */
export const DEFAULT_PACK_ID = 'padrao';
const DEFAULT_PACK_NAME = 'Padrão Kivo';

/** Vazio, o id reservado ou lixo → conjunto padrão. */
function isDefaultPack(id: string): boolean {
  return !id || id === DEFAULT_PACK_ID;
}

const DEFAULT_ICONS_DIR = path.resolve(__dirname, '..', '..', 'public', 'icons');

/** Mesma raiz de dados de backups/imagens: o diretório do banco, dois níveis acima. */
export function iconPacksDir(): string {
  const dbPath = process.env.KIVO_DB_PATH ?? path.resolve(process.cwd(), 'database', 'kivo.db');
  return path.join(path.dirname(path.dirname(dbPath)), 'storage', 'peck-icon');
}

export interface IconPackInfo {
  id: string;
  name: string;
  icons: number;
  /** Se o pacote tem uma capa (capa.jpg/png/webp/svg) para mostrar no card. */
  hasCover: boolean;
}

/** Nomes aceitos para a capa do pacote, na ordem de preferência. */
const COVER_NAMES = ['capa.jpg', 'capa.jpeg', 'capa.png', 'capa.webp', 'capa.svg'];

const COVER_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Aceita só ids "seguros" — barra `..`, `/` e qualquer coisa fora do alfabeto conhecido. */
function safePackId(id: string): string | null {
  const limpo = id.trim();
  if (!limpo || limpo === '.' || limpo === '..') return null;
  return /^[A-Za-z0-9._-]+$/.test(limpo) ? limpo : null;
}

/** Caminho da capa de um pacote (para servir no card). `null` no padrão ou se não houver. */
export function iconPackCover(packId: string): { path: string; contentType: string } | null {
  const id = safePackId(packId);
  if (!id || isDefaultPack(id)) return null;
  const dir = path.join(iconPacksDir(), id);
  for (const nome of COVER_NAMES) {
    const arquivo = path.join(dir, nome);
    if (fs.existsSync(arquivo)) return { path: arquivo, contentType: COVER_MIME[path.extname(nome)] };
  }
  return null;
}

export interface IconHelpers {
  packId: string;
  mapJson: string;
  svgIcon: (name: string, width?: number, height?: number) => string;
}

function readSvgs(dir: string): Record<string, string> {
  const map: Record<string, string> = {};
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return map;
  }

  // Base: cada SVG vale pelo próprio nome (contrato canônico: cart.svg → "cart").
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.svg')) continue;
    map[f.slice(0, -4)] = fs.readFileSync(path.join(dir, f), 'utf8');
  }

  // manifest.json (opcional) sobrepõe/adiciona nomes lógicos — é o que permite um pacote
  // usar nomes de arquivo próprios (ex.: "carrinho.svg" servindo "cart"). Antes, um pacote
  // com manifest IGNORAVA os SVGs fora dele; agora os dois modos convivem.
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, string>;
      for (const [logical, file] of Object.entries(manifest)) {
        if (typeof file !== 'string') continue;
        // `basename` barra qualquer caminho relativo/absoluto vindo do manifest.
        const filePath = path.join(dir, path.basename(file));
        if (fs.existsSync(filePath)) map[logical] = fs.readFileSync(filePath, 'utf8');
      }
    } catch {
      // Manifest ilegível: vale só o modo por nome de arquivo.
    }
  }
  return map;
}

let defaultCache: Record<string, string> | null = null;

function defaultMap(): Record<string, string> {
  if (!defaultCache) defaultCache = readSvgs(DEFAULT_ICONS_DIR);
  return defaultCache;
}

/** Pacotes válidos (com SVG) e pastas ignoradas (só raster), para a tela explicar. */
export function listIconPacks(): { packs: IconPackInfo[]; ignorados: string[] } {
  const packs: IconPackInfo[] = [
    { id: DEFAULT_PACK_ID, name: DEFAULT_PACK_NAME, icons: Object.keys(defaultMap()).length, hasCover: false },
  ];
  const ignorados: string[] = [];
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(iconPacksDir(), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    // Pasta ainda não existe: só o padrão.
  }
  for (const d of dirs) {
    if (d.name === DEFAULT_PACK_ID) continue; // id reservado ao padrão
    // Conta ARQUIVOS .svg, não chaves do mapa: com manifest, cada arquivo pode responder por
    // mais de um nome lógico, e o card deve dizer quantos ícones o pacote traz de verdade.
    let svgs: string[] = [];
    try {
      svgs = fs.readdirSync(path.join(iconPacksDir(), d.name)).filter((f) => f.toLowerCase().endsWith('.svg'));
    } catch {
      // Pasta ilegível: trata como pacote vazio.
    }
    const count = svgs.length;
    if (count > 0) packs.push({ id: d.name, name: d.name, icons: count, hasCover: !!iconPackCover(d.name) });
    else ignorados.push(d.name);
  }
  return { packs, ignorados };
}

/** Id do pacote escolhido, sempre normalizado (padrão em vez de vazio). */
export function getSelectedPackId(): string {
  try {
    const bruto = (settingsRepository.get(ICON_PACK_SETTING) ?? '').trim();
    return isDefaultPack(bruto) ? DEFAULT_PACK_ID : bruto;
  } catch {
    return DEFAULT_PACK_ID;
  }
}

/** Resolve o pacote uma vez e devolve os helpers já ligados ao mapa — sem I/O por ícone. */
export function resolveIconHelpers(packId: string): IconHelpers {
  const id = safePackId(packId);
  const overrides = !id || isDefaultPack(id) ? {} : readSvgs(path.join(iconPacksDir(), id));
  const map = { ...defaultMap(), ...overrides };
  return {
    packId,
    mapJson: JSON.stringify(map),
    svgIcon: (name, width = 24, height = 24) => {
      const svg = map[name];
      if (!svg) return '';
      return svg.replace(/<svg\b/, `<svg width="${width}" height="${height}"`);
    },
  };
}

/** Fallback sem banco (ex.: render fora de requisição): sempre o pacote padrão. */
export function defaultIconHelpers(): IconHelpers {
  return resolveIconHelpers(DEFAULT_PACK_ID);
}

let cache: { packId: string; helpers: IconHelpers } | null = null;

/** Uma leitura de `settings` por requisição; o mapa em si fica em cache por pacote. */
export function getIconHelpers(): IconHelpers {
  const packId = getSelectedPackId();
  if (!cache || cache.packId !== packId) cache = { packId, helpers: resolveIconHelpers(packId) };
  return cache.helpers;
}

export function invalidateIconPackCache(): void {
  cache = null;
}

/**
 * Instala um pacote baixado da loja em `storage/peck-icon/<slug>/`, sobrescrevendo o que
 * houver com o mesmo nome. Grava só `.svg` e `manifest.json` — é o formato que o cloud
 * aceita. Escreve num diretório temporário e só então troca, para uma falha no meio não
 * deixar o tema atual pela metade. Devolve quantos ícones foram gravados.
 */
export function installIconPack(slug: string, files: Record<string, string>): number {
  const id = safePackId(slug);
  if (!id || isDefaultPack(id)) throw new Error('Nome de pacote inválido.');
  const dir = path.join(iconPacksDir(), id);
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  let count = 0;
  for (const [nome, conteudo] of Object.entries(files)) {
    const base = path.basename(nome);
    const ehSvg = base.toLowerCase().endsWith('.svg');
    const ehManifest = base.toLowerCase() === 'manifest.json';
    if ((!ehSvg && !ehManifest) || typeof conteudo !== 'string') continue;
    fs.writeFileSync(path.join(tmp, base), conteudo);
    if (ehSvg) count++;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  invalidateIconPackCache();
  return count;
}

const COVER_EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Grava a capa de um pacote já instalado (`capa.<ext>`) a partir do que a nuvem mandou.
 *
 * A capa NÃO viaja dentro do pack de ícones (só os SVGs + manifest), então sem isto o card
 * do pacote recém-baixado caía no placeholder genérico — o `capa.jpg` do tema nunca chegava
 * ao `storage/peck-icon/<slug>/`. Remove capas antigas de outra extensão para não acumular.
 */
export function saveIconPackCover(slug: string, mime: string, base64: string): boolean {
  const id = safePackId(slug);
  if (!id || isDefaultPack(id)) return false;
  const ext = COVER_EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()];
  if (!ext || !base64) return false;
  const dir = path.join(iconPacksDir(), id);
  if (!fs.existsSync(dir)) return false;
  for (const nome of COVER_NAMES) fs.rmSync(path.join(dir, nome), { force: true });
  fs.writeFileSync(path.join(dir, `capa.${ext}`), Buffer.from(base64, 'base64'));
  invalidateIconPackCache();
  return true;
}
