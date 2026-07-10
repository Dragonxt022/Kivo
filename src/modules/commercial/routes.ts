import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { validateBarcode, generateInternalBarcode } from '../../shared/barcode';
import { makeCrudRouter } from './crud';
import { moveStock, moveStockRaw, listMovements, type MovementType } from './stock';
import { resolveMany } from './pricing';
import { grant as grantStoreCredit } from './storeCredit';
import { validateImageBuffer } from '../../core/catalog/imageValidation';
import {
  productImagesDir, saveLocalProductImage, queueProductImageSubmission, trySubmitPending,
  cloudBaseUrl, cloudAuthHeaders,
} from '../../core/catalog/submissionQueue';

const router = Router();
const db = () => getSqlite();

// ---------- Clientes e fornecedores (CRUD via fábrica) ----------
router.use('/customers', makeCrudRouter({
  table: 'customers', entity: 'customer', permPrefix: 'commercial.customers',
  fields: ['name', 'document', 'email', 'phone', 'address', 'notes', 'price_list_id', 'cep', 'agreement_company_id'],
  required: ['name'], readOnlyFields: ['store_credit_cents', 'loyalty_points'],
}));
router.use('/suppliers', makeCrudRouter({
  table: 'suppliers', entity: 'supplier', permPrefix: 'commercial.suppliers',
  fields: ['name', 'trade_name', 'document', 'email', 'phone', 'address', 'notes'], required: ['name'],
}));
router.use('/agreement-companies', makeCrudRouter({
  table: 'agreement_companies', entity: 'agreement_company', permPrefix: 'commercial.agreements',
  fields: ['name', 'document', 'billing_day', 'contact_name', 'contact_phone', 'contact_email'], required: ['name'],
}));

router.post('/customers/:id/credit', requirePermission('commercial.customers.creditgrant'), (req, res) => {
  const customerId = Number(req.params.id);
  const { amountCents, reason } = req.body ?? {};
  const customer = db().prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId);
  if (!customer) {
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  let result: ReturnType<typeof grantStoreCredit>;
  db().transaction(() => {
    result = grantStoreCredit(req, customerId, Math.round(Number(amountCents)), reason, 'manual');
  })();
  if (!result!.ok) {
    res.status(400).json(result!);
    return;
  }
  res.status(201).json(result!);
});

// ---------- Categorias ----------
router.get('/categories', requirePermission('commercial.products.view'), (_req, res) => {
  res.json(db().prepare('SELECT id, name, parent_id FROM categories WHERE deleted_at IS NULL ORDER BY name').all());
});
router.post('/categories', requirePermission('commercial.products.create'), (req, res) => {
  const { name, parentId } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const info = db().prepare('INSERT INTO categories (name, parent_id, uuid) VALUES (?, ?, ?)').run(name, parentId ?? null, randomUUID());
  audit(req, 'criar', 'category', Number(info.lastInsertRowid), null, { name });
  res.status(201).json({ id: Number(info.lastInsertRowid), name });
});
router.put('/categories/:id', requirePermission('commercial.products.edit'), (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const before = db().prepare('SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; name: string } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  db().prepare("UPDATE categories SET name = ?, updated_at = datetime('now') WHERE id = ?").run(String(name).trim(), id);
  audit(req, 'editar', 'category', id, before, { name: String(name).trim() });
  res.json({ id, name: String(name).trim() });
});
router.delete('/categories/:id', requirePermission('commercial.products.delete'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; name: string } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  const { migrateToId } = req.body ?? {};
  if (migrateToId != null) {
    if (Number(migrateToId) === id) {
      res.status(400).json({ error: 'Categoria de destino não pode ser a mesma que está sendo excluída.' });
      return;
    }
    const target = db().prepare('SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL').get(migrateToId);
    if (!target) {
      res.status(400).json({ error: 'Categoria de destino não encontrada.' });
      return;
    }
  }
  db().transaction(() => {
    if (migrateToId != null) {
      db().prepare('UPDATE products SET category_id = ? WHERE category_id = ?').run(migrateToId, id);
    } else {
      db().prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
    }
    db().prepare("UPDATE categories SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  })();
  audit(req, 'excluir', 'category', id, before, { migratedTo: migrateToId ?? null });
  res.json({ ok: true });
});

// ---------- Produtos (RBAC fino: preço separado de edição) ----------
const PRODUCT_COLS = `p.id, p.name, p.description, p.sku, p.barcode, p.category_id, c.name AS category,
  p.unit, p.price_cents, p.cost_cents, p.track_stock, p.stock_qty, p.min_stock, p.favorite, p.active,
  p.image_url, p.updated_at`;
const getProduct = (id: string | number) =>
  db().prepare(`SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.id = ? AND p.deleted_at IS NULL`).get(id);

/** "estoque.auto_sku": ligado por padrão (ausente = ativo), como as demais preferências de UX do app. */
function autoSkuEnabled(): boolean {
  const row = db().prepare("SELECT value FROM settings WHERE key = 'estoque.auto_sku' AND deleted_at IS NULL").get() as
    { value: string | null } | undefined;
  return row?.value !== '0';
}

/**
 * Traduz violação dos índices únicos de barcode/sku (0014) em erro amigável, em vez de
 * vazar o SQLITE_CONSTRAINT cru. SQLite reporta o nome da COLUNA (products.barcode), não
 * o nome do índice, mesmo quando a unicidade vem de um CREATE UNIQUE INDEX parcial.
 */
function friendlyUniqueError(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes('UNIQUE constraint failed')) return null;
  if (msg.includes('products.barcode')) return 'Código de barras já cadastrado em outro produto.';
  if (msg.includes('products.sku')) return 'SKU já cadastrado em outro produto.';
  return null;
}

/**
 * Foto do produto: body pode trazer `imageBase64` (upload novo, salvo localmente e
 * enfileirado para o banco de imagens do Cloud), `imageUrl` (sugestão já escolhida do
 * catálogo aprovado — nada a salvar aqui) ou `removeImage: true`. Nenhum dos três →
 * `{}` (não mexe na imagem atual). Ver src/core/catalog/.
 */
function prepareProductImage(b: Record<string, unknown>): {
  imageUrl?: string | null; buf?: Buffer; submit?: boolean; error?: string;
} {
  if (b.removeImage) return { imageUrl: null };
  if (b.imageUrl) return { imageUrl: String(b.imageUrl) };
  if (b.imageBase64) {
    let buf: Buffer;
    try {
      buf = Buffer.from(String(b.imageBase64), 'base64');
    } catch {
      return { error: 'Imagem inválida.' };
    }
    const check = validateImageBuffer(buf);
    if (!check.ok) return { error: check.error };
    const imageUrl = saveLocalProductImage(buf, check.format);
    return { imageUrl, buf, submit: b.submitToCatalog !== false };
  }
  return {};
}

/** Apaga o arquivo local antigo (se houver) quando a imagem é trocada/removida — evita acúmulo no disco. */
function deleteLocalImageIfOwned(imageUrl: string | null | undefined): void {
  if (!imageUrl || !imageUrl.startsWith('/uploads/products/')) return;
  try {
    fs.unlinkSync(path.join(productImagesDir(), path.basename(imageUrl)));
  } catch {
    // arquivo já não existe / já foi limpo — sem problema
  }
}

router.get('/products', requirePermission('commercial.products.view'), (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const where = q ? 'AND (p.name LIKE ? OR p.barcode = ? OR p.sku = ?)' : '';
  const stmt = `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.deleted_at IS NULL ${where} ORDER BY p.favorite DESC, p.name`;
  res.json(q ? db().prepare(stmt).all(`%${q}%`, q, q) : db().prepare(stmt).all());
});

/**
 * Busca no banco de imagens aprovado do Katsu Cloud (até 3 sugestões) — usado pelo
 * formulário de produto para evitar que o usuário precise ter/subir uma foto própria.
 * Sem internet/licença configurada, devolve lista vazia com `offline: true` (a tela
 * trata isso como "recurso indisponível agora", não como erro).
 */
router.get('/products/image-search', requirePermission('commercial.products.view'), async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) {
    res.json({ results: [], error: 'Digite ao menos 3 letras para buscar.' });
    return;
  }
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) {
    res.json({ results: [], offline: true });
    return;
  }
  try {
    const r = await fetch(`${base}/api/catalog/search?q=${encodeURIComponent(q)}`, {
      headers: auth, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      res.json({ results: [], offline: true });
      return;
    }
    const results = (await r.json()) as { id: number; name: string; url: string }[];
    res.json({ results: results.map((it) => ({ id: it.id, name: it.name, url: base + it.url })) });
  } catch {
    res.json({ results: [], offline: true });
  }
});

router.post('/products', requirePermission('commercial.products.create'), (req, res) => {
  const b = req.body ?? {};
  if (!b.name) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  if (b.priceCents != null && !req.user!.permissions.has('commercial.products.price')) {
    res.status(403).json({ error: 'Permissão negada: commercial.products.price (definir preço).' });
    return;
  }
  if (b.barcode && !validateBarcode(String(b.barcode))) {
    res.status(400).json({ error: 'Código de barras inválido (dígito verificador não confere).' });
    return;
  }
  const img = prepareProductImage(b);
  if (img.error) {
    res.status(400).json({ error: img.error });
    return;
  }
  let info: { lastInsertRowid: number | bigint };
  try {
    info = db().prepare(
      `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, image_url, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.name, b.description ?? null, b.sku ?? null, b.barcode ?? null, b.categoryId ?? null,
      b.unit ?? 'un', Math.round(b.priceCents ?? 0), Math.round(b.costCents ?? 0),
      b.trackStock === false ? 0 : 1, b.minStock ?? 0, img.imageUrl ?? null, randomUUID(),
    );
  } catch (e) {
    const friendly = friendlyUniqueError(e);
    if (!friendly) throw e;
    res.status(409).json({ error: friendly });
    return;
  }
  const newId = Number(info.lastInsertRowid);
  if (img.buf && img.submit) {
    queueProductImageSubmission(newId, String(b.name), img.imageUrl!, img.buf);
    trySubmitPending().catch(() => {});
  }
  if (!b.sku && autoSkuEnabled()) {
    db().prepare("UPDATE products SET sku = ? WHERE id = ?").run(`P${String(newId).padStart(6, '0')}`, newId);
  }
  // Estoque inicial opcional já no cadastro (vira movimentação de entrada auditada)
  if (b.initialStock != null && Number(b.initialStock) > 0) {
    if (!req.user!.permissions.has('commercial.stock.move')) {
      res.status(403).json({ error: 'Permissão negada: commercial.stock.move (estoque inicial).' });
      return;
    }
    const move = moveStock(req, newId, 'entrada', Number(b.initialStock), 'estoque inicial');
    if (!move.ok) {
      res.status(400).json({ error: move.error });
      return;
    }
  }
  const created = getProduct(newId);
  audit(req, 'criar', 'product', newId, null, created);
  res.status(201).json(created);
});

router.put('/products/:id', requirePermission('commercial.products.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = getProduct(id) as { price_cents: number; image_url: string | null } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const b = req.body ?? {};
  // RBAC fino (plano Fase 1): alterar preço é permissão separada de editar produto
  if (b.priceCents != null && Math.round(b.priceCents) !== before.price_cents
      && !req.user!.permissions.has('commercial.products.price')) {
    res.status(403).json({ error: 'Permissão negada: commercial.products.price (alterar preço).' });
    return;
  }
  if (b.stockQty != null) {
    res.status(400).json({ error: 'Saldo de estoque não é editável: use movimentações (/stock/move).' });
    return;
  }
  if (b.barcode && !validateBarcode(String(b.barcode))) {
    res.status(400).json({ error: 'Código de barras inválido (dígito verificador não confere).' });
    return;
  }
  const img = prepareProductImage(b);
  if (img.error) {
    res.status(400).json({ error: img.error });
    return;
  }
  const finalImageUrl = img.imageUrl !== undefined ? img.imageUrl : before.image_url;
  try {
    db().prepare(
      `UPDATE products SET
         name = COALESCE(?, name), description = COALESCE(?, description), sku = COALESCE(?, sku),
         barcode = COALESCE(?, barcode), category_id = COALESCE(?, category_id), unit = COALESCE(?, unit),
         price_cents = COALESCE(?, price_cents), cost_cents = COALESCE(?, cost_cents),
         track_stock = COALESCE(?, track_stock), min_stock = COALESCE(?, min_stock),
         active = COALESCE(?, active), image_url = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      b.name ?? null, b.description ?? null, b.sku ?? null, b.barcode ?? null, b.categoryId ?? null,
      b.unit ?? null, b.priceCents != null ? Math.round(b.priceCents) : null,
      b.costCents != null ? Math.round(b.costCents) : null,
      b.trackStock != null ? (b.trackStock ? 1 : 0) : null, b.minStock ?? null,
      b.active != null ? (b.active ? 1 : 0) : null, finalImageUrl, id,
    );
  } catch (e) {
    const friendly = friendlyUniqueError(e);
    if (!friendly) throw e;
    res.status(409).json({ error: friendly });
    return;
  }
  if (img.imageUrl !== undefined && img.imageUrl !== before.image_url) {
    deleteLocalImageIfOwned(before.image_url);
  }
  if (img.buf && img.submit) {
    queueProductImageSubmission(Number(id), String(b.name ?? (before as unknown as { name: string }).name), img.imageUrl!, img.buf);
    trySubmitPending().catch(() => {});
  }
  const after = getProduct(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.delete('/products/:id', requirePermission('commercial.products.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = getProduct(id);
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  db().prepare(`UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  audit(req, 'excluir', 'product', id, before, null);
  res.json({ ok: true });
});

router.put('/products/:id/favorite', requirePermission('commercial.products.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = getProduct(id) as { favorite: number } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const favorite = req.body?.favorite ? 1 : 0;
  db().prepare(`UPDATE products SET favorite = ?, updated_at = datetime('now') WHERE id = ?`).run(favorite, id);
  const after = getProduct(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.post('/products/:id/duplicate', requirePermission('commercial.products.create'), (req, res) => {
  const id = String(req.params.id);
  const source = getProduct(id) as
    | { name: string; description: string | null; category_id: number | null; unit: string; price_cents: number; cost_cents: number; track_stock: number; min_stock: number }
    | undefined;
  if (!source) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  // sku/barcode não são copiados: duplicá-los junto criaria dois produtos com o
  // mesmo código de barras, ambíguo na hora de escanear no PDV.
  const info = db().prepare(
    `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, uuid)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${source.name} (cópia)`, source.description, source.category_id, source.unit,
    source.price_cents, source.cost_cents, source.track_stock, source.min_stock, randomUUID(),
  );
  const created = getProduct(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.get('/products/by-barcode/:code', requirePermission('commercial.products.view'), (req, res) => {
  const row = db().prepare(
    `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.barcode = ? AND p.deleted_at IS NULL`,
  ).get(req.params.code);
  if (!row) {
    res.status(404).json({ error: 'Nenhum produto com este código.' });
    return;
  }
  res.json(row);
});

router.post('/products/:id/barcode/generate', requirePermission('commercial.products.edit'), (req, res) => {
  const id = Number(req.params.id);
  const before = getProduct(id);
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const barcode = generateInternalBarcode(id);
  try {
    db().prepare(`UPDATE products SET barcode = ?, updated_at = datetime('now') WHERE id = ?`).run(barcode, id);
  } catch (e) {
    const friendly = friendlyUniqueError(e);
    res.status(409).json({ error: friendly ?? 'Conflito ao gerar código interno — tente novamente.' });
    return;
  }
  const after = getProduct(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

// ---------- Listas de preço ----------
router.get('/price-lists', requirePermission('commercial.pricelists.view'), (_req, res) => {
  res.json(db().prepare(
    `SELECT pl.id, pl.name, pl.is_default, pl.active,
            (SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = pl.id) AS item_count
     FROM price_lists pl WHERE pl.deleted_at IS NULL ORDER BY pl.name`,
  ).all());
});

router.get('/price-lists/:id', requirePermission('commercial.pricelists.view'), (req, res) => {
  const id = Number(req.params.id);
  const list = db().prepare('SELECT id, name, is_default, active, updated_at FROM price_lists WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!list) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  const items = db().prepare(
    `SELECT i.id, i.product_id, p.name AS product_name, i.min_qty, i.unit_price_cents
     FROM price_list_items i JOIN products p ON p.id = i.product_id
     WHERE i.price_list_id = ? ORDER BY p.name, i.min_qty`,
  ).all(id);
  res.json({ ...list, items });
});

function unsetOtherDefaults(): void {
  db().prepare("UPDATE price_lists SET is_default = 0, updated_at = datetime('now') WHERE is_default = 1").run();
}

router.post('/price-lists', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const { name, isDefault } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  let newId = 0;
  db().transaction(() => {
    if (isDefault) unsetOtherDefaults();
    const info = db().prepare('INSERT INTO price_lists (name, is_default, uuid) VALUES (?, ?, ?)')
      .run(String(name).trim(), isDefault ? 1 : 0, randomUUID());
    newId = Number(info.lastInsertRowid);
  })();
  const created = db().prepare('SELECT id, name, is_default, active FROM price_lists WHERE id = ?').get(newId);
  audit(req, 'criar', 'price_list', newId, null, created);
  res.status(201).json(created);
});

router.put('/price-lists/:id', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name, is_default, active FROM price_lists WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  const { name, active, isDefault } = req.body ?? {};
  db().transaction(() => {
    if (isDefault) unsetOtherDefaults();
    db().prepare(
      `UPDATE price_lists SET name = COALESCE(?, name), active = COALESCE(?, active),
         is_default = COALESCE(?, is_default), updated_at = datetime('now') WHERE id = ?`,
    ).run(name ?? null, active != null ? (active ? 1 : 0) : null, isDefault != null ? (isDefault ? 1 : 0) : null, id);
  })();
  const after = db().prepare('SELECT id, name, is_default, active FROM price_lists WHERE id = ?').get(id);
  audit(req, 'editar', 'price_list', id, before, after);
  res.json(after);
});

router.delete('/price-lists/:id', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name FROM price_lists WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  db().transaction(() => {
    db().prepare("UPDATE customers SET price_list_id = NULL, updated_at = datetime('now') WHERE price_list_id = ?").run(id);
    db().prepare("UPDATE price_lists SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  })();
  audit(req, 'excluir', 'price_list', id, before, null);
  res.json({ ok: true });
});

router.put('/price-lists/:id/items', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const id = Number(req.params.id);
  const list = db().prepare('SELECT id FROM price_lists WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!list) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  const { items } = req.body ?? {};
  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'Campo obrigatório: items[{productId, minQty, unitPriceCents}].' });
    return;
  }
  try {
    db().transaction(() => {
      db().prepare('DELETE FROM price_list_items WHERE price_list_id = ?').run(id);
      for (const item of items) {
        db().prepare(
          'INSERT INTO price_list_items (price_list_id, product_id, min_qty, unit_price_cents) VALUES (?, ?, ?, ?)',
        ).run(id, Number(item.productId), Number(item.minQty ?? 1), Math.round(item.unitPriceCents));
      }
      // Bump obrigatório: o motor de sync só reenvia o pai quando updated_at avança —
      // sem isso, mudanças nos itens (filhos) não seriam propagadas para outras máquinas.
      db().prepare("UPDATE price_lists SET updated_at = datetime('now') WHERE id = ?").run(id);
    })();
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const after = db().prepare(
    `SELECT i.id, i.product_id, p.name AS product_name, i.min_qty, i.unit_price_cents
     FROM price_list_items i JOIN products p ON p.id = i.product_id WHERE i.price_list_id = ? ORDER BY p.name, i.min_qty`,
  ).all(id);
  audit(req, 'editar', 'price_list_items', id, null, after);
  res.json({ items: after });
});

router.post('/pricing/resolve', requirePermission('store.sales.create'), (req, res) => {
  const { customerId, items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Campo obrigatório: items[{productId, qty}].' });
    return;
  }
  const prices = resolveMany(
    items.map((i: { productId: number; qty: number }) => ({ productId: Number(i.productId), qty: Number(i.qty) })),
    customerId ?? null,
  ).map((p, idx) => ({ productId: Number(items[idx].productId), ...p }));
  res.json({ prices });
});

// ---------- Estoque ----------
router.get('/stock/movements', requirePermission('commercial.stock.view'), (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  res.json(listMovements(productId, Math.min(Number(req.query.limit ?? 100), 500)));
});

router.post('/stock/move', requirePermission('commercial.stock.move'), (req, res) => {
  const { productId, type, qty, reason } = req.body ?? {};
  if (!productId || !['entrada', 'saida', 'ajuste'].includes(type)) {
    res.status(400).json({ error: 'Campos obrigatórios: productId, type (entrada|saida|ajuste), qty.' });
    return;
  }
  const result = moveStock(req, Number(productId), type as MovementType, Number(qty), reason);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

// ---------- Compras (recebimento gera entrada de estoque) ----------
router.get('/purchases', requirePermission('commercial.purchases.view'), (_req, res) => {
  res.json(db().prepare(
    `SELECT pu.id, pu.supplier_id, s.name AS supplier, pu.status, pu.total_cents, pu.notes, pu.received_at, pu.updated_at
     FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
     WHERE pu.deleted_at IS NULL ORDER BY pu.id DESC`,
  ).all());
});

router.post('/purchases', requirePermission('commercial.purchases.create'), (req, res) => {
  const { supplierId, items, notes } = req.body ?? {};
  if (!supplierId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Campos obrigatórios: supplierId, items[{productId, qty, unitCostCents}].' });
    return;
  }
  const database = db();
  const supplier = database.prepare('SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(supplierId);
  if (!supplier) {
    res.status(400).json({ error: 'Fornecedor inexistente.' });
    return;
  }

  let purchaseId = 0;
  let error: string | null = null;
  try {
    database.transaction(() => {
      const total = sumCents(...items.map((i: { qty: number; unitCostCents: number }) => Math.round(i.qty * i.unitCostCents)));
      const info = database.prepare(
        `INSERT INTO purchases (supplier_id, status, total_cents, notes, received_at, uuid)
         VALUES (?, 'recebida', ?, ?, datetime('now'), ?)`,
      ).run(supplierId, total, notes ?? null, randomUUID());
      purchaseId = Number(info.lastInsertRowid);

      for (const item of items) {
        database.prepare(
          `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)`,
        ).run(purchaseId, item.productId, item.qty, Math.round(item.unitCostCents));
        database.prepare(`UPDATE products SET cost_cents = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(Math.round(item.unitCostCents), item.productId);
        const move = moveStockRaw(req, Number(item.productId), 'entrada', Number(item.qty), 'compra', 'purchase', purchaseId);
        if (!move.ok) throw new Error(move.error);
      }
    })();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    res.status(400).json({ error });
    return;
  }
  audit(req, 'criar', 'purchase', purchaseId, null, { supplierId, items });
  res.status(201).json({ id: purchaseId });
});

router.put('/purchases/:id', requirePermission('commercial.purchases.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = db().prepare('SELECT id, supplier_id, status, notes FROM purchases WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; supplier_id: number; status: string; notes: string | null } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  if (before.status === 'cancelada') {
    res.status(400).json({ error: 'Compra cancelada não pode ser editada.' });
    return;
  }
  const { supplierId, notes } = req.body ?? {};
  if (supplierId != null) {
    const supplier = db().prepare('SELECT id FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(supplierId);
    if (!supplier) {
      res.status(400).json({ error: 'Fornecedor inexistente.' });
      return;
    }
  }
  db().prepare(
    `UPDATE purchases SET supplier_id = COALESCE(?, supplier_id), notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?`,
  ).run(supplierId ?? null, notes ?? null, id);
  const after = db().prepare('SELECT id, supplier_id, status, notes FROM purchases WHERE id = ?').get(id);
  audit(req, 'editar', 'purchase', id, before, after);
  res.json(after);
});

router.post('/purchases/:id/cancel', requirePermission('commercial.purchases.cancel'), (req, res) => {
  const id = Number(req.params.id);
  const purchase = db().prepare('SELECT id, status FROM purchases WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; status: string } | undefined;
  if (!purchase) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  if (purchase.status === 'cancelada') {
    res.status(400).json({ error: 'Compra já está cancelada.' });
    return;
  }
  const items = db().prepare('SELECT product_id, qty FROM purchase_items WHERE purchase_id = ?').all(id) as
    { product_id: number; qty: number }[];

  const database = db();
  let error: string | null = null;
  try {
    database.transaction(() => {
      for (const item of items) {
        // allowNegative: a mercadoria recebida por esta compra pode já ter sido vendida.
        const move = moveStockRaw(req, item.product_id, 'saida', item.qty, 'cancelamento de compra', 'purchase', id, true);
        if (!move.ok) throw new Error(move.error);
      }
      database.prepare(`UPDATE purchases SET status = 'cancelada', updated_at = datetime('now') WHERE id = ?`).run(id);
    })();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    res.status(400).json({ error });
    return;
  }
  audit(req, 'cancelar', 'purchase', id, { status: purchase.status }, { status: 'cancelada' });
  res.json({ ok: true });
});

export default router;
