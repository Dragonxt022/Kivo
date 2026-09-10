import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';
import { validateCatalogImage, normalizeKeywords, sha256, type ImageFormat } from '../catalogValidation';

/**
 * Banco de imagens do Kivo Cloud: qualquer empresa pode contribuir uma foto de produto
 * (POST /submit) — best-effort, sem custo de storage relevante, cresce o catálogo pra
 * todo mundo. Só entra no catálogo pesquisável depois de aprovada por um admin em
 * /admin/catalog (ver routes/admin.ts).
 *
 * A busca (GET /search) JÁ FOI um benefício de plano pago (gate `requireCloudSavePlan`,
 * como sync/backup). Foi liberada para todos os planos, inclusive trial, porque o catálogo
 * vive de contribuição: quem está avaliando o sistema é justamente quem cadastra produto em
 * volume, e bloquear a busca para esse público reduzia as fotos que entram sem proteger
 * receita nenhuma — POST /submit nunca teve gate de plano. Continua exigindo empresa
 * autenticada (`requireCompanyAuth`), então não é um endpoint aberto.
 */

const router = Router();
const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' });

export const CATALOG_STORAGE_DIR = path.resolve(__dirname, '..', '..', 'storage', 'catalog');
export const CATALOG_EXT_BY_FORMAT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
export const CATALOG_MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
const STORAGE_DIR = CATALOG_STORAGE_DIR;
const EXT_BY_FORMAT = CATALOG_EXT_BY_FORMAT;
const MIME_BY_FORMAT = CATALOG_MIME_BY_FORMAT;

interface CatalogImageRow {
  id: number;
  status: 'pendente' | 'aprovada' | 'rejeitada';
  image_path: string;
  format: ImageFormat;
}

router.post('/submit', rawImage, requireCompanyAuth, async (req: AuthedRequest, res) => {
  const productName = req.header('X-Kivo-Product-Name');
  const submissionUuid = req.header('X-Kivo-Submission-Uuid');
  const body = req.body as Buffer;
  if (!productName || !submissionUuid || !Buffer.isBuffer(body) || !body.length) {
    res.status(400).json({ error: 'Cabeçalhos obrigatórios: X-Kivo-Product-Name, X-Kivo-Submission-Uuid, corpo binário (imagem).' });
    return;
  }

  const check = validateCatalogImage(body);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }

  const hash = sha256(body);
  const [existingRows] = await getPool().query('SELECT id, status FROM catalog_images WHERE sha256 = ?', [hash]);
  const existing = (existingRows as { id: number; status: string }[])[0];
  if (existing) {
    if (existing.status === 'rejeitada') {
      res.status(409).json({ error: 'Imagem já foi avaliada e rejeitada anteriormente.' });
      return;
    }
    res.status(200).json({ status: existing.status === 'aprovada' ? 'ja_aprovada' : 'ja_pendente', catalogImageId: existing.id });
    return;
  }

  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const filename = `${hash}.${EXT_BY_FORMAT[check.format]}`;
  fs.writeFileSync(path.join(STORAGE_DIR, filename), body);

  const [info] = await getPool().query(
    `INSERT INTO catalog_images
       (company_uuid, product_name, keywords, image_path, sha256, width, height, format, size_bytes, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', 'submissao')`,
    [req.companyUuid, productName, normalizeKeywords(productName), filename, hash, check.width, check.height, check.format, body.length],
  );
  const catalogImageId = (info as { insertId: number }).insertId;
  res.status(201).json({ status: 'pendente', catalogImageId });
});

router.get('/search', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) {
    res.status(400).json({ error: 'Informe ao menos 3 caracteres para buscar.' });
    return;
  }
  const pool = getPool();
  const norm = normalizeKeywords(q);

  const seen = new Set<number>();
  const results: { id: number; product_name: string }[] = [];
  const add = (rows: { id: number; product_name: string }[]): void => {
    for (const r of rows) {
      if (results.length >= 3) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      results.push(r);
    }
  };

  // 1. FULLTEXT no nome/keywords cadastrados.
  const [ftRows] = await pool.query(
    `SELECT id, product_name FROM catalog_images
     WHERE status = 'aprovada' AND MATCH(product_name, keywords) AGAINST (? IN NATURAL LANGUAGE MODE)
     LIMIT 5`,
    [q],
  );
  add(ftRows as { id: number; product_name: string }[]);

  // 2. Aliases aprendidos — sinônimos que o cadastro original não tinha. É FULLTEXT por
  //    tokens, então "coca lata 350" casa "refrigerante cola lata 350ml".
  if (results.length < 3 && norm) {
    const [aliasRows] = await pool.query(
      `SELECT ci.id, ci.product_name, MAX(a.occurrences) AS pop
         FROM catalog_image_aliases a JOIN catalog_images ci ON ci.id = a.catalog_image_id
        WHERE ci.status = 'aprovada' AND MATCH(a.alias) AGAINST (? IN NATURAL LANGUAGE MODE)
        GROUP BY ci.id, ci.product_name ORDER BY pop DESC LIMIT 5`,
      [q],
    );
    add(aliasRows as { id: number; product_name: string }[]);
  }

  // 3. Fallback LIKE para termos raros/curtos que o FULLTEXT (stopwords, token mínimo) não pega.
  if (results.length < 3) {
    const [likeRows] = await pool.query(
      `SELECT id, product_name FROM catalog_images
        WHERE status = 'aprovada' AND (product_name LIKE ? OR keywords LIKE ?) LIMIT 5`,
      [`%${q}%`, `%${norm}%`],
    );
    add(likeRows as { id: number; product_name: string }[]);
  }

  // 4. Demanda anônima: busca sem resultado vira sinal para a curadoria (sem empresa).
  if (!results.length && norm) {
    await pool.query(
      `INSERT INTO catalog_demand (term) VALUES (?)
       ON DUPLICATE KEY UPDATE misses = misses + 1, last_seen_at = CURRENT_TIMESTAMP(3)`,
      [norm.slice(0, 255)],
    );
  }

  res.json(results.map((r) => ({ id: r.id, name: r.product_name, url: `/api/catalog/image/${r.id}` })));
});

/**
 * Aprende um alias: o nome que a empresa usou para uma imagem aprovada. Anônimo (não guarda
 * quem mandou) e idempotente — a mesma associação só incrementa o contador. Faz a busca
 * casar sinônimos com o uso real.
 */
router.post('/learn', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const body = (req.body ?? {}) as { imageId?: unknown; name?: unknown };
  const imageId = Number(body.imageId);
  const alias = normalizeKeywords(String(body.name ?? '')).slice(0, 255);
  if (!Number.isInteger(imageId) || imageId <= 0 || alias.length < 3) {
    res.status(400).json({ error: 'imageId e name (>=3 caracteres) são obrigatórios.' });
    return;
  }
  const [imgRows] = await getPool().query("SELECT id FROM catalog_images WHERE id = ? AND status = 'aprovada'", [imageId]);
  if (!(imgRows as unknown[]).length) {
    res.status(404).json({ error: 'Imagem não encontrada.' });
    return;
  }
  await getPool().query(
    `INSERT INTO catalog_image_aliases (catalog_image_id, alias) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE occurrences = occurrences + 1, updated_at = CURRENT_TIMESTAMP(3)`,
    [imageId, alias],
  );
  res.json({ ok: true });
});

router.get('/image/:id', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query(
    "SELECT id, status, image_path, format FROM catalog_images WHERE id = ? AND status = 'aprovada'",
    [req.params.id],
  );
  const row = (rows as CatalogImageRow[])[0];
  const filePath = row && path.join(STORAGE_DIR, row.image_path);
  if (!row || !filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Imagem não encontrada.' });
    return;
  }
  res.setHeader('Content-Type', MIME_BY_FORMAT[row.format]);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.send(fs.readFileSync(filePath));
});

export default router;
