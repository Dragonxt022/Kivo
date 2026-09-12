import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

/**
 * Loja de temas (pacotes de ícones) — lado do desktop.
 *
 * O desktop não fala com o cloud direto pelo navegador (a CSP só deixa `'self'`); quem chama
 * estas rotas é o servidor local, que já tem as credenciais de licença. Por isso o contrato é
 * simples: lista o que a empresa pode usar, serve a capa e entrega o pack.
 *
 * Tema grátis (price_cents = 0) vale para todos; tema pago só para quem o admin liberou em
 * `theme_grants`. A checagem do pack repete a regra de propósito — não dá para confiar só no
 * que a listagem mostrou.
 */

export const THEMES_STORAGE_DIR = path.resolve(__dirname, '..', '..', 'storage', 'themes');

const router = Router();

interface ThemeRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  price_cents: number;
  cover_path: string | null;
  cover_mime: string | null;
  files_count: number;
}

router.get('/', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  const [themeRows] = await pool.query(
    `SELECT id, slug, name, description, price_cents, cover_path, cover_mime, files_count
       FROM themes WHERE active = 1
      ORDER BY price_cents ASC, name ASC`,
  );
  const [grantRows] = await pool.query('SELECT theme_id FROM theme_grants WHERE company_uuid = ?', [
    req.companyUuid,
  ]);
  const granted = new Set((grantRows as { theme_id: number }[]).map((g) => Number(g.theme_id)));

  res.json({
    themes: (themeRows as ThemeRow[]).map((t) => {
      const free = t.price_cents === 0;
      const isGranted = granted.has(Number(t.id));
      return {
        id: Number(t.id),
        slug: t.slug,
        name: t.name,
        description: t.description,
        priceCents: t.price_cents,
        free,
        granted: isGranted,
        // `available` = pode baixar. O desktop usa isso para escolher entre "Baixar e usar"
        // e o estado bloqueado (pago sem liberação).
        available: free || isGranted,
        cover: t.cover_path ? `/api/themes/${t.id}/cover` : null,
        filesCount: t.files_count,
      };
    }),
  });
});

router.get('/:id/cover', requireCompanyAuth, async (req, res) => {
  const [rows] = await getPool().query('SELECT cover_path, cover_mime FROM themes WHERE id = ? AND active = 1', [
    req.params.id,
  ]);
  const row = (rows as { cover_path: string | null; cover_mime: string | null }[])[0];
  // `basename` barra qualquer caminho vindo do banco.
  const filePath = row?.cover_path ? path.join(THEMES_STORAGE_DIR, path.basename(row.cover_path)) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', row!.cover_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(fs.readFileSync(filePath));
});

router.get('/:id/pack', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT id, slug, name, price_cents, pack_json FROM themes WHERE id = ? AND active = 1',
    [req.params.id],
  );
  const row = (rows as { id: number; slug: string; name: string; price_cents: number; pack_json: string }[])[0];
  if (!row) {
    res.status(404).json({ error: 'Tema não encontrado.' });
    return;
  }
  if (row.price_cents > 0) {
    const [g] = await pool.query('SELECT 1 FROM theme_grants WHERE company_uuid = ? AND theme_id = ?', [
      req.companyUuid,
      row.id,
    ]);
    if (!(g as unknown[]).length) {
      res.status(403).json({ error: 'Tema pago não liberado para esta empresa.' });
      return;
    }
  }
  let files: Record<string, string>;
  try {
    files = JSON.parse(row.pack_json) as Record<string, string>;
  } catch {
    res.status(500).json({ error: 'Pacote do tema corrompido no servidor.' });
    return;
  }
  res.json({ id: Number(row.id), slug: row.slug, name: row.name, files });
});

export default router;
