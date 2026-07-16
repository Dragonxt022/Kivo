/**
 * Rotas de importação/exportação de produtos (v1 — só produto simples 'fisico').
 *
 * O parse e a validação vivem em productsImport.ts (lógica pura). Aqui só entra o
 * que precisa de banco: ler o catálogo, resolver categorias e gravar.
 *
 * Duas garantias que valem o desenho:
 *  1. Estoque inicial entra por moveStockRaw('entrada'), nunca escrevendo stock_qty —
 *     o saldo é derivado do ledger stock_movements (ver stock.ts).
 *  2. O commit é tudo-ou-nada: uma transação só. Importação pela metade deixa o
 *     cliente sem saber quais linhas entraram.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { validateBarcode } from '../../shared/barcode';
import { moveStockRaw } from './stock';
import { productRepository } from './repositories/ProductRepository';
import { categoryRepository } from './repositories/CategoryRepository';
import {
  buildPreview, templateCsv, toCsv, IMPORT_COLUMNS, EXPORT_ONLY_COLUMNS,
  type ParsedRow, type ExistingProduct,
} from './productsImport';

const router = Router();

/** Limite de linhas: o commit roda numa transação só e trava o processo enquanto grava. */
const MAX_ROWS = 5000;

function centsToBr(cents: number): string {
  return (Number(cents ?? 0) / 100).toFixed(2).replace('.', ',');
}

function loadExisting(): ExistingProduct[] {
  return productRepository.raw(
    'SELECT id, uuid, sku, barcode FROM products WHERE deleted_at IS NULL',
  ) as unknown as ExistingProduct[];
}

function loadCategories(): { id: number; name: string }[] {
  return productRepository.raw(
    'SELECT id, name FROM categories WHERE deleted_at IS NULL',
  ) as { id: number; name: string }[];
}

function readPreview(body: unknown): { csv: string } | { error: string } {
  const csv = (body as { csv?: unknown })?.csv;
  if (typeof csv !== 'string' || !csv.trim()) return { error: 'Envie o conteúdo do arquivo CSV no campo "csv".' };
  if (csv.length > 8_000_000) return { error: 'Arquivo grande demais (máx. ~8 MB).' };
  return { csv };
}

// ─────────────────────────── Exportar ───────────────────────────

router.get('/products/export.csv', requirePermission('commercial.products.view'), (req, res) => {
  // Só produto simples: variantes/kits/combos não têm representação de uma linha
  // só neste formato e entram numa fase posterior.
  const rows = productRepository.raw(
    `SELECT p.uuid, p.sku, p.barcode, p.name, p.description, c.name AS category, p.unit,
            p.price_cents, p.cost_cents, p.min_stock, p.stock_qty
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.deleted_at IS NULL AND p.product_type = 'fisico' AND p.parent_product_id IS NULL
     ORDER BY p.name`,
  ) as unknown as {
    uuid: string; sku: string | null; barcode: string | null; name: string; description: string | null;
    category: string | null; unit: string; price_cents: number; cost_cents: number;
    min_stock: number; stock_qty: number;
  }[];

  const csv = toCsv([
    [...IMPORT_COLUMNS, ...EXPORT_ONLY_COLUMNS],
    ...rows.map((p) => [
      // uuid vai preenchido: é o que faz o reimport deste arquivo ATUALIZAR em vez
      // de duplicar, mesmo em produto sem SKU nem código de barras.
      p.uuid,
      p.sku ?? '', p.barcode ?? '', p.name, p.description ?? '', p.category ?? '', p.unit ?? 'un',
      centsToBr(p.price_cents), centsToBr(p.cost_cents), String(p.min_stock ?? 0),
      '', // estoque_inicial: em branco de propósito — só vale para produto novo
      String(p.stock_qty ?? 0),
    ]),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="produtos-${stamp}.csv"`);
  audit(req, 'exportar', 'product', 0, null, { total: rows.length });
  res.send(csv);
});

router.get('/products/import-template.csv', requirePermission('commercial.products.create'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-produtos.csv"');
  res.send(templateCsv());
});

// ─────────────────────── Importar: pré-visualização ───────────────────────

router.post('/products/import/preview', requirePermission('commercial.products.create'), (req, res) => {
  const parsed = readPreview(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const result = buildPreview({
    csv: parsed.csv,
    existing: loadExisting(),
    existingCategories: loadCategories(),
    validateBarcode,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  if (result.report.totals.total > MAX_ROWS) {
    res.status(400).json({ error: `Arquivo com ${result.report.totals.total} linhas — o limite é ${MAX_ROWS}. Divida em partes.` });
    return;
  }
  res.json(result.report);
});

// ─────────────────────── Importar: gravar ───────────────────────

router.post('/products/import/commit', requirePermission('commercial.products.create'), (req, res) => {
  assertAuth(req);
  const parsed = readPreview(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  // Revalida do zero em vez de confiar num preview vindo do cliente: o preview é
  // informativo, esta é a decisão. Se o arquivo mudou entre os dois passos, é aqui
  // que se descobre.
  const result = buildPreview({
    csv: parsed.csv,
    existing: loadExisting(),
    existingCategories: loadCategories(),
    validateBarcode,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const report = result.report;
  if (report.totals.total > MAX_ROWS) {
    res.status(400).json({ error: `Arquivo com ${report.totals.total} linhas — o limite é ${MAX_ROWS}.` });
    return;
  }
  if (report.totals.erros > 0) {
    res.status(400).json({
      error: `O arquivo tem ${report.totals.erros} linha(s) com erro. Corrija e importe de novo — nada foi gravado.`,
      totals: report.totals,
    });
    return;
  }

  const wantsPrice = report.rows.some((r) => r.data.priceCents > 0 || r.data.costCents > 0);
  if (wantsPrice && !req.user.permissions.has('commercial.products.price')) {
    res.status(403).json({ error: 'Permissão negada: commercial.products.price (definir preço).' });
    return;
  }
  const wantsStock = report.rows.some((r) => (r.data.initialStock ?? 0) > 0);
  if (wantsStock && !req.user.permissions.has('commercial.stock.move')) {
    res.status(403).json({ error: 'Permissão negada: commercial.stock.move (estoque inicial).' });
    return;
  }

  const created: number[] = [];
  const updated: number[] = [];
  let categoriesCreated = 0;
  let error: string | null = null;

  try {
    productRepository.transaction(() => {
      // Mapa de categorias montado dentro da transação: as criadas aqui precisam
      // valer para as linhas seguintes do mesmo arquivo.
      const catIdByName = new Map<string, number>();
      for (const c of loadCategories()) catIdByName.set(c.name.trim().toLowerCase(), c.id);

      const resolveCategory = (name: string | null): number | null => {
        if (!name) return null;
        const key = name.trim().toLowerCase();
        const hit = catIdByName.get(key);
        if (hit) return hit;
        const id = Number(
          categoryRepository.rawRun(
            'INSERT INTO categories (name, uuid) VALUES (?, ?)',
            name.trim(), randomUUID(),
          ).lastInsertRowid,
        );
        catIdByName.set(key, id);
        categoriesCreated++;
        return id;
      };

      for (const row of report.rows as ParsedRow[]) {
        const d = row.data;
        const categoryId = resolveCategory(d.categoryName);

        if (row.matchedId) {
          // Update não mexe em estoque nem cria produto — só os campos do arquivo.
          productRepository.rawRun(
            `UPDATE products SET name = ?, description = ?, sku = ?, barcode = ?, category_id = ?,
               unit = ?, price_cents = ?, cost_cents = ?, min_stock = ?, updated_at = datetime('now')
             WHERE id = ?`,
            d.name, d.description, d.sku, d.barcode, categoryId,
            d.unit, d.priceCents, d.costCents, d.minStock, row.matchedId,
          );
          updated.push(row.matchedId);
          continue;
        }

        const info = productRepository.rawRun(
          `INSERT INTO products (name, description, sku, barcode, category_id, unit,
             price_cents, cost_cents, track_stock, min_stock, product_type, uuid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'fisico', ?)`,
          d.name, d.description, d.sku, d.barcode, categoryId, d.unit,
          d.priceCents, d.costCents, d.minStock, randomUUID(),
        );
        const newId = Number(info.lastInsertRowid);
        created.push(newId);

        if (d.initialStock != null && d.initialStock > 0) {
          // Caminho oficial do estoque: gera movimentação e deixa o saldo derivar dela.
          const move = moveStockRaw(req, newId, 'entrada', d.initialStock, 'importação de produtos');
          if (!move.ok) throw new Error(`linha ${row.line}: ${move.error}`);
        }
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // O índice único pode pegar algo que o preview não viu (ex.: outro usuário
    // gravou o mesmo SKU no intervalo entre pré-visualizar e confirmar).
    error = msg.includes('UNIQUE constraint failed')
      ? 'Conflito de SKU ou código de barras com um produto gravado por outra pessoa enquanto você conferia. Pré-visualize de novo.'
      : msg;
  }

  if (error) {
    res.status(400).json({ error });
    return;
  }

  audit(req, 'importar', 'product', 0, null, {
    criados: created.length, atualizados: updated.length, categoriasCriadas: categoriesCreated,
  });
  res.json({
    ok: true,
    criados: created.length,
    atualizados: updated.length,
    categoriasCriadas: categoriesCreated,
  });
});

export default router;
