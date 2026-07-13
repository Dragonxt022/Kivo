import { Router } from 'express';
import { getPool } from '../db';

const router = Router();

interface MenuItemRow {
  name: string;
  description: string | null;
  price_cents: number;
  category_uuid: string | null;
  category_payload: string | Record<string, unknown> | null;
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

  const [companyRows] = await pool.query('SELECT company_uuid, name FROM companies WHERE company_uuid = ?', [
    companyUuid,
  ]);
  const company = (companyRows as { company_uuid: string; name: string | null }[])[0];
  if (!company) {
    res.status(404).render('cardapio', { company: null, categories: [] });
    return;
  }

  const [rows] = await pool.query(
    `SELECT mi.name, mi.description, mi.price_cents, mi.category_uuid, sr.payload AS category_payload
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
        typeof row.category_payload === 'string' ? JSON.parse(row.category_payload) : row.category_payload;
      if (payload?.name) categoryName = String(payload.name);
    }
    const key = row.category_uuid ?? '__none__';
    if (!grouped.has(key)) grouped.set(key, { name: categoryName, items: [] });
    grouped.get(key)!.items.push(row);
  }
  const categories = [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));

  res.render('cardapio', { company, categories });
});

export default router;
