import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getPool } from '../db';
import { CATALOG_MIME_BY_FORMAT, CATALOG_STORAGE_DIR } from './catalog';

const router = Router();

interface MenuItemRow {
  name: string;
  description: string | null;
  price_cents: number;
  category_uuid: string | null;
  product_uuid: string;
  category_payload: string | Record<string, unknown> | null;
  image_id: number | null;
}

/**
 * Cardápio online público (Fase 6) — sem autenticação, de propósito: é a vitrine que
 * o cliente final acessa sem login. `company_uuid` já é um UUID (não sequencial/não
 * adivinhável), então expor por ele não vaza empresas de terceiros. Só mostra o
 * subconjunto seguro já projetado em `menu_items` pelo push de sync (nome/descrição/
 * preço/categoria) — nunca toca `sync_records` diretamente para produtos (lá tem
 * custo/estoque) exceto para resolver o NOME da categoria a partir do uuid.
 */
router.get('/:companyUuid', async (req, res) => {
  const { companyUuid } = req.params;
  const pool = getPool();

  const [companyRows] = await pool.query(
    'SELECT company_uuid, name FROM companies WHERE company_uuid = ?',
    [companyUuid],
  );
  const company = (companyRows as { company_uuid: string; name: string | null }[])[0];
  if (!company) {
    res.status(404).render('cardapio', { company: null, categories: [] });
    return;
  }

  const [rows] = await pool.query(
    `SELECT mi.name, mi.description, mi.price_cents, mi.category_uuid, mi.product_uuid,
            sr.payload AS category_payload,
            -- 1) foto vinculada pelo app local (id do catálogo) — caminho principal;
            -- 2) foto da própria empresa casada pelo nome — legado de quem contribuiu;
            -- 3) foto aprovada do banco compartilhado com o mesmo nome — para fotos que
            --    vieram das sugestões automáticas antes do vínculo por id existir.
            COALESCE(
              (SELECT ci.id
                 FROM catalog_images ci
                WHERE ci.id = mi.catalog_image_id
                  AND ci.status <> 'rejeitada'
                LIMIT 1),
              (SELECT ci.id
                 FROM catalog_images ci
                WHERE ci.company_uuid = mi.company_uuid
                  AND ci.product_name = mi.name
                  AND ci.status <> 'rejeitada'
                ORDER BY (ci.status = 'aprovada') DESC, ci.id DESC
                LIMIT 1),
              (SELECT ci.id
                 FROM catalog_images ci
                WHERE ci.status = 'aprovada'
                  AND ci.product_name = mi.name
                ORDER BY ci.pick_count DESC, ci.id DESC
                LIMIT 1)
            ) AS image_id
     FROM menu_items mi
     LEFT JOIN sync_records sr
       ON sr.company_uuid = mi.company_uuid AND sr.entity_type = 'commercial.categories'
       AND sr.uuid = mi.category_uuid AND sr.deleted_at IS NULL
     WHERE mi.company_uuid = ?
     ORDER BY mi.name`,
    [companyUuid],
  );

  const grouped = new Map<string, { name: string; items: MenuItemRow[] }>();
  for (const row of rows as MenuItemRow[]) {
    let categoryName = 'Outros';
    if (row.category_payload) {
      const payload =
        typeof row.category_payload === 'string'
          ? JSON.parse(row.category_payload)
          : row.category_payload;
      if (payload?.name) categoryName = String(payload.name);
    }
    const key = row.category_uuid ?? '__none__';
    if (!grouped.has(key)) grouped.set(key, { name: categoryName, items: [] });
    grouped.get(key)!.items.push(row);
  }
  const categories = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));

  res.render('cardapio', { company, categories });
});

/**
 * Foto pública de um item do cardápio.
 *
 * O app local guarda a foto em `/uploads/products/...` (arquivo que só existe naquela
 * máquina) e, ao cadastrar o produto, envia uma cópia para o banco de imagens do Cloud.
 * Aqui servimos essa cópia — mas só quando ela está REALMENTE vinculada a um item
 * publicado no cardápio da empresa: pelo id (`catalog_image_id`, inclusive fotos de
 * sugestões) ou, no legado, pelo nome (foto da própria empresa ou aprovada do banco
 * compartilhado). Assim a rota é pública sem virar um mural de imagens de terceiros.
 */
router.get('/:companyUuid/imagem/:imageId', async (req, res, next) => {
  const { companyUuid } = req.params;
  const imageId = Number(req.params.imageId);
  if (!Number.isInteger(imageId) || imageId <= 0) {
    res.status(404).end();
    return;
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ci.image_path, ci.format
         FROM catalog_images ci
         JOIN menu_items mi
           ON mi.company_uuid = ?
          AND (mi.catalog_image_id = ci.id
               OR (mi.name = ci.product_name
                   AND (ci.company_uuid = mi.company_uuid OR ci.status = 'aprovada')))
        WHERE ci.id = ? AND ci.status <> 'rejeitada'
        LIMIT 1`,
      [companyUuid, imageId],
    );
    const row = (rows as { image_path: string; format: keyof typeof CATALOG_MIME_BY_FORMAT }[])[0];
    if (!row?.image_path) {
      res.status(404).end();
      return;
    }

    // `image_path` é gerado pelo próprio servidor (hash + extensão), nunca vem do cliente;
    // o basename é só uma trava extra contra caminhos inesperados no banco.
    const filePath = path.join(CATALOG_STORAGE_DIR, path.basename(row.image_path));
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }

    res.setHeader('Content-Type', CATALOG_MIME_BY_FORMAT[row.format] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  } catch (e) {
    next(e);
  }
});

export default router;
