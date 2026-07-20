import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, requireCloudSavePlan, type AuthedRequest } from '../auth';
import { validateCatalogImage, normalizeKeywords, sha256, type ImageFormat } from '../catalogValidation';

/**
 * Banco de imagens do Kivo Cloud: qualquer empresa pode contribuir uma foto de produto
 * (POST /submit) — best-effort, sem custo de storage relevante, cresce o catálogo pra
 * todo mundo. Só entra no catálogo pesquisável depois de aprovada por um admin em
 * /admin/catalog (ver routes/admin.ts). A busca (GET /search) é um benefício de plano
 * pago, como sync/backup — mesmo gate de `requireCloudSavePlan`.
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

router.get('/search', requireCompanyAuth, requireCloudSavePlan, async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) {
    res.status(400).json({ error: 'Informe ao menos 3 caracteres para buscar.' });
    return;
  }
  const pool = getPool();
  let [rows] = await pool.query(
    `SELECT id, product_name FROM catalog_images
     WHERE status = 'aprovada' AND MATCH(product_name, keywords) AGAINST (? IN NATURAL LANGUAGE MODE)
     LIMIT 3`,
    [q],
  );
  let results = rows as { id: number; product_name: string }[];
  if (!results.length) {
    // Fallback para termos raros/curtos que o FULLTEXT (stopwords, tamanho mínimo de token) não pega.
    [rows] = await pool.query(
      `SELECT id, product_name FROM catalog_images WHERE status = 'aprovada' AND (product_name LIKE ? OR keywords LIKE ?) LIMIT 3`,
      [`%${q}%`, `%${normalizeKeywords(q)}%`],
    );
    results = rows as { id: number; product_name: string }[];
  }
  res.json(results.map((r) => ({ id: r.id, name: r.product_name, url: `/api/catalog/image/${r.id}` })));
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
