import fs from 'node:fs';
import path from 'node:path';
import { getPool, closePool } from './db';
import { THEMES_STORAGE_DIR } from './routes/themes';

/**
 * Cadastra na loja de temas os packs empacotados em `cloud/seed-themes/<slug>/`.
 *
 * Cada pasta traz os SVGs (nomes canônicos, iguais aos do app: cart.svg → "cart"), uma capa
 * (`capa.svg`/jpg/png/webp) e um `theme.json` com nome, descrição e preço. Todos entram como
 * PAGOS — o preço vem do theme.json. É idempotente (upsert por slug), então pode rodar no
 * deploy sem duplicar.
 *
 *   npm run seed:themes
 */
const SEED_DIR = path.resolve(__dirname, '..', 'seed-themes');

interface ThemeMeta {
  slug: string;
  name: string;
  description?: string;
  price_cents?: number;
}

const COVER_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function main(): Promise<void> {
  if (!fs.existsSync(SEED_DIR)) {
    console.log(`[seed-themes] nada em ${SEED_DIR}`);
    return;
  }
  fs.mkdirSync(THEMES_STORAGE_DIR, { recursive: true });
  const pool = getPool();

  for (const entry of fs.readdirSync(SEED_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SEED_DIR, entry.name);
    const metaPath = path.join(dir, 'theme.json');
    if (!fs.existsSync(metaPath)) continue;

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ThemeMeta;
    if (!meta.slug || !meta.name) {
      console.warn(`[seed-themes] ${entry.name}: theme.json sem slug/name — ignorado`);
      continue;
    }

    // Pack = todos os .svg, menos a capa.
    const files: Record<string, string> = {};
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.svg')) continue;
      if (f.toLowerCase().startsWith('capa')) continue;
      files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
    const count = Object.keys(files).length;
    if (!count) {
      console.warn(`[seed-themes] ${meta.slug}: sem ícones — ignorado`);
      continue;
    }

    // Capa: copia para o storage do cloud e guarda o nome do arquivo + mime.
    let coverPath: string | null = null;
    let coverMime: string | null = null;
    const coverName = ['capa.svg', 'capa.jpg', 'capa.jpeg', 'capa.png', 'capa.webp'].find((f) =>
      fs.existsSync(path.join(dir, f)),
    );
    if (coverName) {
      const ext = path.extname(coverName).toLowerCase();
      coverPath = `${meta.slug}-capa${ext}`;
      fs.copyFileSync(path.join(dir, coverName), path.join(THEMES_STORAGE_DIR, coverPath));
      coverMime = COVER_MIME[ext] ?? 'application/octet-stream';
    }

    await pool.query(
      `INSERT INTO themes (slug, name, description, price_cents, cover_path, cover_mime, pack_json, files_count, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), description = VALUES(description), price_cents = VALUES(price_cents),
         cover_path = VALUES(cover_path), cover_mime = VALUES(cover_mime),
         pack_json = VALUES(pack_json), files_count = VALUES(files_count), active = 1`,
      [meta.slug, meta.name, meta.description ?? null, Math.max(0, Math.round(meta.price_cents ?? 0)), coverPath, coverMime, JSON.stringify(files), count],
    );
    console.log(`[seed-themes] ${meta.slug}: ${count} ícones, capa=${coverName ?? '—'}`);
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
