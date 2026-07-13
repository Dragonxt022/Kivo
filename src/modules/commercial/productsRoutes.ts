import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission, requireAnyPermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { validateBarcode, generateInternalBarcode } from '../../shared/barcode';
import { assertAuth } from '../../shared/auth';
import { validateBody } from '../../shared/validateBody';
import { createProductSchema, updateProductSchema } from '../../shared/schemas';
import { moveStock, type MovementType } from './stock';
import { resolveMany } from './pricing';
import { grant as grantStoreCredit } from './storeCredit';
import { validateImageBuffer } from '../../core/catalog/imageValidation';
import {
  productImagesDir, saveLocalProductImage, queueProductImageSubmission, trySubmitPending,
  cloudBaseUrl, cloudAuthHeaders,
} from '../../core/catalog/submissionQueue';

const router = Router();
const db = () => getSqlite();

// ---------- Produtos (RBAC fino: preço separado de edição) ----------
const PRODUCT_COLS = `p.id, p.name, p.description, p.sku, p.barcode, p.category_id, c.name AS category,
  p.unit, p.price_cents, p.cost_cents, p.track_stock, p.stock_qty, p.min_stock, p.favorite, p.active,
  p.image_url, p.updated_at, p.product_type, p.parent_product_id, p.visivel_cardapio`;
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

router.get('/products', requireAnyPermission('commercial.products.view', 'commercial.products.search'), (req, res) => {
  const q = String(req.query.q ?? '').trim();
  // Grade de cadastro: só produtos de topo (simples ou pais de variante), nunca variantes filhas.
  // Busca (q presente): variantes filhas aparecem, mas produto-pai nao (nao e vendavel).
  const excludeParent = `AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`;
  if (q) {
    const stmt = `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
                  WHERE p.deleted_at IS NULL ${excludeParent} AND (p.name LIKE ? OR p.barcode = ? OR p.sku = ?)
                  ORDER BY p.favorite DESC, p.name`;
    res.json(db().prepare(stmt).all(`%${q}%`, q, q));
  } else {
    const stmt = `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
                  WHERE p.deleted_at IS NULL AND p.parent_product_id IS NULL ${excludeParent}
                  ORDER BY p.favorite DESC, p.name`;
    res.json(db().prepare(stmt).all());
  }
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
    // URL local, não a da nuvem direto: <img src> não consegue mandar os headers
    // X-Katsu-Company/X-Katsu-License-Key exigidos por /api/catalog/image — só o
    // servidor local tem essas credenciais, então ele faz o proxy dos bytes.
    res.json({ results: results.map((it) => ({ id: it.id, name: it.name, url: `/api/commercial/products/catalog-image/${it.id}` })) });
  } catch {
    res.json({ results: [], offline: true });
  }
});

/** Proxy dos bytes da imagem aprovada do Cloud — evita expor as credenciais da licença ao navegador. */
router.get('/products/catalog-image/:id', requirePermission('commercial.products.view'), async (req, res) => {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) {
    res.status(404).end();
    return;
  }
  try {
    const r = await fetch(`${base}/api/catalog/image/${encodeURIComponent(String(req.params.id))}`, {
      headers: auth, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      res.status(r.status).end();
      return;
    }
    res.setHeader('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

router.post('/products', requirePermission('commercial.products.create'), validateBody(createProductSchema), (req, res) => {
  assertAuth(req);
  const b = req.body;
  if (b.priceCents != null && !req.user.permissions.has('commercial.products.price')) {
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
  const productType = String(b.productType ?? 'fisico');
  // Produto-pai de variante nao controla estoque (estoque vive nas variantes filhas)
  const trackStock = productType === 'variante' ? 0 : (b.trackStock === false ? 0 : 1);
  let info: { lastInsertRowid: number | bigint };
  try {
    info = db().prepare(
      `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, image_url, product_type, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.name, b.description ?? null, b.sku ?? null, b.barcode ?? null, b.categoryId ?? null,
      b.unit ?? 'un', Math.round(b.priceCents ?? 0), Math.round(b.costCents ?? 0),
      trackStock, b.minStock ?? 0, img.imageUrl ?? null, productType, randomUUID(),
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
    trySubmitPending().catch((e) => console.error('[submit] erro ao enviar imagem:', e));
  }
  if (!b.sku && autoSkuEnabled()) {
    db().prepare("UPDATE products SET sku = ? WHERE id = ?").run(`P${String(newId).padStart(6, '0')}`, newId);
  }
  // Estoque inicial opcional já no cadastro (vira movimentação de entrada auditada)
  if (b.initialStock != null && Number(b.initialStock) > 0) {
    if (!req.user.permissions.has('commercial.stock.move')) {
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

router.put('/products/:id', requirePermission('commercial.products.edit'), validateBody(updateProductSchema), (req, res) => {
  assertAuth(req);
  const id = String(req.params.id);
  const before = getProduct(id) as { price_cents: number; image_url: string | null } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const b = req.body;
  // RBAC fino (plano Fase 1): alterar preço é permissão separada de editar produto
  if (b.priceCents != null && Math.round(b.priceCents) !== before.price_cents
      && !req.user.permissions.has('commercial.products.price')) {
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
  // Forcar track_stock = 0 em produto-pai de variante
  const productType = b.productType ?? (before as unknown as Record<string, unknown>).product_type ?? 'fisico';
  const trackStock = productType === 'variante' ? 0 : (b.trackStock != null ? (b.trackStock ? 1 : 0) : null);
  try {
    db().prepare(
      `UPDATE products SET
         name = COALESCE(?, name), description = COALESCE(?, description), sku = COALESCE(?, sku),
         barcode = COALESCE(?, barcode), category_id = COALESCE(?, category_id), unit = COALESCE(?, unit),
         price_cents = COALESCE(?, price_cents), cost_cents = COALESCE(?, cost_cents),
         track_stock = COALESCE(?, track_stock), min_stock = COALESCE(?, min_stock),
         active = COALESCE(?, active), image_url = ?, product_type = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      b.name ?? null, b.description ?? null, b.sku ?? null, b.barcode ?? null, b.categoryId ?? null,
      b.unit ?? null, b.priceCents != null ? Math.round(b.priceCents) : null,
      b.costCents != null ? Math.round(b.costCents) : null,
      trackStock, b.minStock ?? null,
      b.active != null ? (b.active ? 1 : 0) : null, finalImageUrl, productType, id,
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
    trySubmitPending().catch((e) => console.error('[submit] erro ao enviar imagem:', e));
  }
  const after = getProduct(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.delete('/products/:id', requirePermission('commercial.products.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = getProduct(id) as
    | { product_type: string; parent_product_id: number | null }
    | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const dbLocal = db();
  dbLocal.transaction(() => {
    // Cascade: se for produto-pai, soft-delete todas as variantes filhas
    if (before.product_type === 'variante' && before.parent_product_id == null) {
      dbLocal.prepare(
        `UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE parent_product_id = ?`,
      ).run(id);
    }
    dbLocal.prepare(`UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  })();
  audit(req, 'excluir', 'product', id, before, null);
  res.json({ ok: true });
});

// POST (não DELETE) para não colidir com a rota '/products/:id' acima.
router.post('/products/bulk-delete', requirePermission('commercial.products.delete'), (req, res) => {
  const bodyIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids: string[] = [...new Set(bodyIds.map((id) => String(id)))];
  if (!ids.length) {
    res.status(400).json({ error: 'Informe ao menos um id.' });
    return;
  }
  const deletedIds: string[] = [];
  const skipped: string[] = [];
  db().transaction(() => {
    for (const id of ids) {
      const before = getProduct(id) as { product_type: string; parent_product_id: number | null } | undefined;
      if (!before) {
        skipped.push(id);
        continue;
      }
      // Cascade: se for produto-pai, soft-delete variantes filhas
      if (before.product_type === 'variante' && before.parent_product_id == null) {
        db().prepare(`UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE parent_product_id = ?`).run(id);
      }
      db().prepare(`UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
      audit(req, 'excluir', 'product', id, before, null);
      deletedIds.push(id);
    }
  })();
  res.json({ deleted: deletedIds.length, deletedIds, skipped });
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

/**
 * Marca/desmarca o produto pro cardápio online público (Fase 6) — endpoint dedicado
 * (mesmo padrão de /favorite) em vez de misturar no PUT genérico, pra poder exigir a
 * capability sem travar a edição normal do produto quando ela estiver desligada.
 */
router.put('/products/:id/cardapio-online', requirePermission('commercial.products.edit'), requireCapability('commercial.cardapio_online'), (req, res) => {
  const id = String(req.params.id);
  const before = getProduct(id) as { visivel_cardapio: number } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const visivelCardapio = req.body?.visivelCardapio ? 1 : 0;
  db().prepare(`UPDATE products SET visivel_cardapio = ?, updated_at = datetime('now') WHERE id = ?`).run(visivelCardapio, id);
  const after = getProduct(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.post('/products/:id/duplicate', requirePermission('commercial.products.create'), (req, res) => {
  const id = String(req.params.id);
  const source = getProduct(id) as
    | { name: string; description: string | null; category_id: number | null; unit: string; price_cents: number; cost_cents: number; track_stock: number; min_stock: number; product_type: string; parent_product_id: number | null }
    | undefined;
  if (!source) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  // sku/barcode não são copiados: duplicá-los junto criaria dois produtos com o
  // mesmo código de barras, ambíguo na hora de escanear no PDV.
  const info = db().prepare(
    `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, product_type, parent_product_id, uuid)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${source.name} (cópia)`, source.description, source.category_id, source.unit,
    source.price_cents, source.cost_cents, source.track_stock, source.min_stock,
    source.product_type ?? 'fisico', source.parent_product_id ?? null, randomUUID(),
  );
  const created = getProduct(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.get('/products/by-barcode/:code', requirePermission('commercial.products.view'), (req, res) => {
  const row = db().prepare(
    `SELECT ${PRODUCT_COLS} FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.barcode = ? AND p.deleted_at IS NULL AND NOT (p.product_type = 'variante' AND p.parent_product_id IS NULL)`,
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

// ---------- Complementos / Opcionais ----------
router.get('/complement-groups', requirePermission('commercial.products.view'), requireCapability('commercial.complementos'), (_req, res) => {
  res.json(db().prepare(
    `SELECT id, name, min_select, max_select, uuid, updated_at FROM complement_groups WHERE deleted_at IS NULL ORDER BY name`,
  ).all());
});

router.post('/complement-groups', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const { name, minSelect, maxSelect } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const info = db().prepare(
    'INSERT INTO complement_groups (name, min_select, max_select, uuid) VALUES (?, ?, ?, ?)',
  ).run(String(name).trim(), Math.round(Number(minSelect ?? 0)), maxSelect != null ? Math.round(Number(maxSelect)) : null, randomUUID());
  const created = db().prepare('SELECT id, name, min_select, max_select FROM complement_groups WHERE id = ?').get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'complement_group', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/complement-groups/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name, min_select, max_select FROM complement_groups WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const { name, minSelect, maxSelect } = req.body ?? {};
  db().prepare(
    `UPDATE complement_groups SET name = COALESCE(?, name), min_select = COALESCE(?, min_select), max_select = COALESCE(?, max_select), updated_at = datetime('now') WHERE id = ?`,
  ).run(name ? String(name).trim() : null, minSelect != null ? Math.round(Number(minSelect)) : null, maxSelect !== undefined ? (maxSelect != null ? Math.round(Number(maxSelect)) : null) : null, id);
  const after = db().prepare('SELECT id, name, min_select, max_select FROM complement_groups WHERE id = ?').get(id);
  audit(req, 'editar', 'complement_group', id, before, after);
  res.json(after);
});

router.delete('/complement-groups/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name FROM complement_groups WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  db().transaction(() => {
    db().prepare("UPDATE complement_group_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE group_id = ?").run(id);
    db().prepare("UPDATE product_complement_groups SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE group_id = ?").run(id);
    db().prepare("UPDATE complement_groups SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  })();
  audit(req, 'excluir', 'complement_group', id, before, null);
  res.json({ ok: true });
});

router.get('/complement-groups/:id/items', requirePermission('commercial.products.view'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  res.json(db().prepare(
    `SELECT i.id, i.group_id, i.product_id, p.name AS product_name, p.sku, i.price_override_cents, i.sort_order, i.uuid, i.updated_at
     FROM complement_group_items i JOIN products p ON p.id = i.product_id
     WHERE i.group_id = ? AND i.deleted_at IS NULL ORDER BY i.sort_order, p.name`,
  ).all(id));
});

router.post('/complement-groups/:id/items', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const groupId = Number(req.params.id);
  const group = db().prepare('SELECT id FROM complement_groups WHERE id = ? AND deleted_at IS NULL').get(groupId);
  if (!group) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const { productId, priceOverrideCents, sortOrder } = req.body ?? {};
  if (!productId) {
    res.status(400).json({ error: 'Campo obrigatório: productId.' });
    return;
  }
  const prod = db().prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(productId);
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const info = db().prepare(
    'INSERT INTO complement_group_items (group_id, product_id, price_override_cents, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
  ).run(groupId, productId, priceOverrideCents != null ? Math.round(Number(priceOverrideCents)) : null, Math.round(Number(sortOrder ?? 0)), randomUUID());
  const created = db().prepare(
    `SELECT i.id, i.group_id, i.product_id, p.name AS product_name, i.price_override_cents, i.sort_order
     FROM complement_group_items i JOIN products p ON p.id = i.product_id WHERE i.id = ?`,
  ).get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'complement_group_item', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/complement-groups/:groupId/items/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, product_id, price_override_cents, sort_order FROM complement_group_items WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Item de complemento não encontrado.' });
    return;
  }
  const { productId, priceOverrideCents, sortOrder } = req.body ?? {};
  db().prepare(
    `UPDATE complement_group_items SET product_id = COALESCE(?, product_id), price_override_cents = COALESCE(?, price_override_cents), sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`,
  ).run(productId ?? null, priceOverrideCents !== undefined ? (priceOverrideCents != null ? Math.round(Number(priceOverrideCents)) : null) : null, sortOrder != null ? Math.round(Number(sortOrder)) : null, id);
  const after = db().prepare('SELECT id, group_id, product_id, price_override_cents, sort_order FROM complement_group_items WHERE id = ?').get(id);
  audit(req, 'editar', 'complement_group_item', id, before, after);
  res.json(after);
});

router.delete('/complement-groups/:groupId/items/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, product_id FROM complement_group_items WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Item de complemento não encontrado.' });
    return;
  }
  db().prepare("UPDATE complement_group_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  audit(req, 'excluir', 'complement_group_item', id, before, null);
  res.json({ ok: true });
});

// Vincula/desvincula grupos de complemento a um produto
router.get('/products/:id/complement-groups', requirePermission('commercial.products.view'), (req, res) => {
  const productId = Number(req.params.id);
  const links = db().prepare(
    `SELECT pcg.id, pcg.group_id, cg.name AS group_name, cg.min_select, cg.max_select, pcg.sort_order,
            json_group_array(json_object('id', i.id, 'product_id', i.product_id, 'product_name', p.name, 'price_override_cents', i.price_override_cents, 'sort_order', i.sort_order)) AS items
     FROM product_complement_groups pcg
     JOIN complement_groups cg ON cg.id = pcg.group_id AND cg.deleted_at IS NULL
     LEFT JOIN complement_group_items i ON i.group_id = pcg.group_id AND i.deleted_at IS NULL
     LEFT JOIN products p ON p.id = i.product_id
     WHERE pcg.product_id = ? AND pcg.deleted_at IS NULL
     GROUP BY pcg.id ORDER BY pcg.sort_order, cg.name`,
  ).all(productId);
  res.json(links);
});

router.post('/products/:id/complement-groups', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const productId = Number(req.params.id);
  const { groupId, sortOrder } = req.body ?? {};
  if (!groupId) {
    res.status(400).json({ error: 'Campo obrigatório: groupId.' });
    return;
  }
  const prod = db().prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').get(productId);
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const group = db().prepare('SELECT id FROM complement_groups WHERE id = ? AND deleted_at IS NULL').get(groupId);
  if (!group) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const existing = db().prepare('SELECT id FROM product_complement_groups WHERE product_id = ? AND group_id = ? AND deleted_at IS NULL').get(productId, groupId);
  if (existing) {
    res.status(409).json({ error: 'Este grupo já está vinculado ao produto.' });
    return;
  }
  const info = db().prepare(
    'INSERT INTO product_complement_groups (product_id, group_id, sort_order, uuid) VALUES (?, ?, ?, ?)',
  ).run(productId, groupId, Math.round(Number(sortOrder ?? 0)), randomUUID());
  const created = db().prepare(
    'SELECT id, product_id, group_id, sort_order FROM product_complement_groups WHERE id = ?',
  ).get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product_complement_group', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.delete('/products/:id/complement-groups/:linkId', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const linkId = Number(req.params.linkId);
  const before = db().prepare('SELECT id, product_id, group_id FROM product_complement_groups WHERE id = ? AND deleted_at IS NULL').get(linkId);
  if (!before) {
    res.status(404).json({ error: 'Vínculo não encontrado.' });
    return;
  }
  db().prepare("UPDATE product_complement_groups SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(linkId);
  audit(req, 'excluir', 'product_complement_group', linkId, before, null);
  res.json({ ok: true });
});

// ---------- Kits & Combos (componentes fixos) ----------
router.get('/products/:id/kit-items', requirePermission('commercial.products.view'), requireCapability('commercial.kits'), (req, res) => {
  const productId = Number(req.params.id);
  res.json(db().prepare(
    `SELECT ki.id, ki.kit_product_id, ki.component_product_id, p.name AS component_name, p.sku, ki.qty, ki.sort_order, ki.uuid, ki.updated_at
     FROM kit_items ki JOIN products p ON p.id = ki.component_product_id
     WHERE ki.kit_product_id = ? AND ki.deleted_at IS NULL ORDER BY ki.sort_order, p.name`,
  ).all(productId));
});

router.post('/products/:id/kit-items', requirePermission('commercial.products.kits.manage'), requireCapability('commercial.kits'), (req, res) => {
  const productId = Number(req.params.id);
  const prod = db().prepare('SELECT id, product_type, name FROM products WHERE id = ? AND deleted_at IS NULL').get(productId) as
    { id: number; product_type: string; name: string } | undefined;
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  if (prod.product_type !== 'kit' && prod.product_type !== 'combo') {
    res.status(400).json({ error: 'Produto não é do tipo kit/combo.' });
    return;
  }
  const { componentProductId, qty, sortOrder } = req.body ?? {};
  if (!componentProductId) {
    res.status(400).json({ error: 'Campo obrigatório: componentProductId.' });
    return;
  }
  if (Number(componentProductId) === productId) {
    res.status(400).json({ error: 'Um kit não pode ser componente dele mesmo.' });
    return;
  }
  const comp = db().prepare('SELECT id, product_type FROM products WHERE id = ? AND deleted_at IS NULL').get(componentProductId) as
    { id: number; product_type: string } | undefined;
  if (!comp) {
    res.status(404).json({ error: 'Componente não encontrado.' });
    return;
  }
  if (comp.product_type === 'kit' || comp.product_type === 'combo') {
    res.status(400).json({ error: 'Kit-dentro-de-kit não é suportado (use produtos simples como componentes).' });
    return;
  }
  const info = db().prepare(
    'INSERT INTO kit_items (kit_product_id, component_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
  ).run(productId, componentProductId, Number(qty ?? 1), Math.round(Number(sortOrder ?? 0)), randomUUID());
  const created = db().prepare(
    `SELECT ki.id, ki.kit_product_id, ki.component_product_id, p.name AS component_name, ki.qty, ki.sort_order
     FROM kit_items ki JOIN products p ON p.id = ki.component_product_id WHERE ki.id = ?`,
  ).get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'kit_item', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/kit-items/:id', requirePermission('commercial.products.kits.manage'), requireCapability('commercial.kits'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, qty, sort_order FROM kit_items WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Item de kit não encontrado.' });
    return;
  }
  const { qty, sortOrder } = req.body ?? {};
  db().prepare(
    `UPDATE kit_items SET qty = COALESCE(?, qty), sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`,
  ).run(qty != null ? Number(qty) : null, sortOrder != null ? Math.round(Number(sortOrder)) : null, id);
  const after = db().prepare('SELECT id, kit_product_id, component_product_id, qty, sort_order FROM kit_items WHERE id = ?').get(id);
  audit(req, 'editar', 'kit_item', id, before, after);
  res.json(after);
});

router.delete('/kit-items/:id', requirePermission('commercial.products.kits.manage'), requireCapability('commercial.kits'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, kit_product_id, component_product_id FROM kit_items WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Item de kit não encontrado.' });
    return;
  }
  db().prepare("UPDATE kit_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  audit(req, 'excluir', 'kit_item', id, before, null);
  res.json({ ok: true });
});

// ---------- Ficha técnica (produto produzido) ----------
router.get('/products/:id/recipe-items', requirePermission('commercial.products.view'), requireCapability('commercial.producao'), (req, res) => {
  const productId = Number(req.params.id);
  res.json(db().prepare(
    `SELECT ri.id, ri.produced_product_id, ri.input_product_id, p.name AS input_name, p.sku, ri.qty, ri.sort_order, ri.uuid, ri.updated_at,
            p.cost_cents, (ri.qty * p.cost_cents) AS total_cost_cents
     FROM product_recipe_items ri JOIN products p ON p.id = ri.input_product_id
     WHERE ri.produced_product_id = ? AND ri.deleted_at IS NULL ORDER BY ri.sort_order, p.name`,
  ).all(productId));
});

router.post('/products/:id/recipe-items', requirePermission('commercial.products.recipe.manage'), requireCapability('commercial.producao'), (req, res) => {
  const productId = Number(req.params.id);
  const prod = db().prepare('SELECT id, product_type, name FROM products WHERE id = ? AND deleted_at IS NULL').get(productId) as
    { id: number; product_type: string; name: string } | undefined;
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  if (prod.product_type !== 'produzido') {
    res.status(400).json({ error: 'Produto não é do tipo produzido.' });
    return;
  }
  const { inputProductId, qty, sortOrder } = req.body ?? {};
  if (!inputProductId) {
    res.status(400).json({ error: 'Campo obrigatório: inputProductId.' });
    return;
  }
  if (Number(inputProductId) === productId) {
    res.status(400).json({ error: 'Um produto não pode ser insumo dele mesmo.' });
    return;
  }
  const input = db().prepare('SELECT id, product_type, active, track_stock FROM products WHERE id = ? AND deleted_at IS NULL').get(inputProductId) as
    { id: number; product_type: string; active: number; track_stock: number } | undefined;
  if (!input) {
    res.status(404).json({ error: 'Insumo não encontrado.' });
    return;
  }
  if (!input.active) {
    res.status(400).json({ error: 'Insumo inativo não pode ser usado na ficha técnica.' });
    return;
  }
  if (!input.track_stock) {
    res.status(400).json({ error: 'Insumo não controla estoque — obrigatório para ficha técnica.' });
    return;
  }
  if (input.product_type === 'kit' || input.product_type === 'combo' || input.product_type === 'produzido') {
    res.status(400).json({ error: 'Insumo não pode ser kit, combo ou produzido (use produtos simples).' });
    return;
  }
  const info = db().prepare(
    'INSERT INTO product_recipe_items (produced_product_id, input_product_id, qty, sort_order, uuid) VALUES (?, ?, ?, ?, ?)',
  ).run(productId, inputProductId, Number(qty ?? 1), Math.round(Number(sortOrder ?? 0)), randomUUID());
  const created = db().prepare(
    `SELECT ri.id, ri.produced_product_id, ri.input_product_id, p.name AS input_name, ri.qty, ri.sort_order
     FROM product_recipe_items ri JOIN products p ON p.id = ri.input_product_id WHERE ri.id = ?`,
  ).get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product_recipe_item', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/recipe-items/:id', requirePermission('commercial.products.recipe.manage'), requireCapability('commercial.producao'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, qty, sort_order FROM product_recipe_items WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Item de ficha técnica não encontrado.' });
    return;
  }
  const { qty, sortOrder } = req.body ?? {};
  db().prepare(
    `UPDATE product_recipe_items SET qty = COALESCE(?, qty), sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`,
  ).run(qty != null ? Number(qty) : null, sortOrder != null ? Math.round(Number(sortOrder)) : null, id);
  const after = db().prepare('SELECT id, produced_product_id, input_product_id, qty, sort_order FROM product_recipe_items WHERE id = ?').get(id);
  audit(req, 'editar', 'product_recipe_item', id, before, after);
  res.json(after);
});

router.delete('/recipe-items/:id', requirePermission('commercial.products.recipe.manage'), requireCapability('commercial.producao'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, produced_product_id, input_product_id FROM product_recipe_items WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Item de ficha técnica não encontrado.' });
    return;
  }
  db().prepare("UPDATE product_recipe_items SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  audit(req, 'excluir', 'product_recipe_item', id, before, null);
  res.json({ ok: true });
});

// ---------- Variantes de produto ----------
router.get('/products/:id/variants', requirePermission('commercial.products.view'), requireCapability('commercial.variantes'), (req, res) => {
  const parentId = Number(req.params.id);
  const variants = db().prepare(
    `SELECT ${PRODUCT_COLS},
            (SELECT json_group_array(json_object('attribute_id', pvv.attribute_id, 'attribute_name', pa.name, 'value_id', pvv.attribute_value_id, 'value', pav.value))
             FROM product_variant_values pvv
             LEFT JOIN product_attributes pa ON pa.id = pvv.attribute_id
             LEFT JOIN product_attribute_values pav ON pav.id = pvv.attribute_value_id
             WHERE pvv.product_id = p.id AND pvv.deleted_at IS NULL) AS variant_attrs
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.parent_product_id = ? AND p.deleted_at IS NULL
     ORDER BY p.name`,
  ).all(parentId);
  res.json(variants);
});

router.post('/products/:id/attributes/generate-variants', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const parentId = Number(req.params.id);
  const parent = getProduct(parentId) as
    | { product_type: string; name: string; price_cents: number; cost_cents: number }
    | undefined;
  if (!parent) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  if (parent.product_type !== 'variante') {
    res.status(400).json({ error: 'Produto não é do tipo "variante".' });
    return;
  }
  const { attributeValueIds } = req.body ?? {};
  if (!Array.isArray(attributeValueIds) || attributeValueIds.length === 0) {
    res.status(400).json({ error: 'Informe attributeValueIds (array de IDs de valores de atributo).' });
    return;
  }
  // Validar que todos os valores existem
  const placeholders = attributeValueIds.map(() => '?').join(',');
  const values = db().prepare(
    `SELECT pav.id, pav.attribute_id, pa.name AS attribute_name, pav.value
     FROM product_attribute_values pav
     JOIN product_attributes pa ON pa.id = pav.attribute_id
     WHERE pav.id IN (${placeholders}) AND pav.deleted_at IS NULL AND pa.deleted_at IS NULL`,
  ).all(...attributeValueIds) as { id: number; attribute_id: number; attribute_name: string; value: string }[];
  if (values.length !== attributeValueIds.length) {
    res.status(400).json({ error: 'Um ou mais IDs de valor de atributo inválidos.' });
    return;
  }
  // Agrupar por attribute_id para calcular produto cartesiano
  const groups = new Map<number, { attribute_id: number; attribute_name: string; value_id: number; value: string }[]>();
  for (const v of values) {
    const arr = groups.get(v.attribute_id) ?? [];
    arr.push({ attribute_id: v.attribute_id, attribute_name: v.attribute_name, value_id: v.id, value: v.value });
    groups.set(v.attribute_id, arr);
  }
  // Produto cartesiano
  const combos = cartesian([...groups.values()]);
  // Nomes de atributo usados para gerar o sufixo da variante
  const attrNames = [...groups.values()].map((g) => g[0].attribute_name);
  const dbLocal = db();
  const created: number[] = [];
  const skipped: number[] = [];
  dbLocal.transaction(() => {
    for (const combo of combos) {
      const valueIds = combo.map((c) => c.value_id).sort();
      // Checar se combinacao ja existe
      const existing = dbLocal.prepare(
        `SELECT pv.product_id FROM product_variant_values pv
         WHERE pv.product_id IN (SELECT id FROM products WHERE parent_product_id = ? AND deleted_at IS NULL)
         AND pv.deleted_at IS NULL
         GROUP BY pv.product_id HAVING COUNT(*) = ? AND SUM(CASE WHEN pv.attribute_value_id IN (${valueIds.map(() => '?').join(',')}) THEN 1 ELSE 0 END) = ?`,
      ).get(parentId, combo.length, ...valueIds, combo.length) as { product_id: number } | undefined;
      if (existing) {
        skipped.push(existing.product_id);
        continue;
      }
      // Gerar nome da variante: "Camiseta - P, Azul"
      const suffix = combo.map((c) => c.value).join(', ');
      const variantName = `${parent.name} - ${suffix}`;
      const info = dbLocal.prepare(
        `INSERT INTO products (name, parent_product_id, product_type, category_id, unit, price_cents, cost_cents, track_stock, min_stock, active, uuid)
         VALUES (?, ?, 'variante', (SELECT category_id FROM products WHERE id = ?), (SELECT unit FROM products WHERE id = ?), ?, ?, 1, 0, 1, ?)`,
      ).run(variantName, parentId, parentId, parentId, parent.price_cents, parent.cost_cents, randomUUID());
      const newId = Number(info.lastInsertRowid);
      // Inserir vinculos de atributo
      for (const c of combo) {
        dbLocal.prepare(
          `INSERT INTO product_variant_values (product_id, attribute_id, attribute_value_id, uuid)
           VALUES (?, ?, ?, ?)`,
        ).run(newId, c.attribute_id, c.value_id, randomUUID());
      }
      created.push(newId);
    }
  })();
  audit(req, 'gerar_variantes', 'product', parentId, null, { created: created.length, skipped: skipped.length });
  res.status(201).json({ created, skipped, total: combos.length });
});

/** Produto cartesiano: [[a,b],[c,d]] -> [[a,c],[a,d],[b,c],[b,d]] */
function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])), [[]]);
}

// ---------- Atributos de variante (CRUD) ----------
router.get('/attributes', requirePermission('commercial.products.view'), requireCapability('commercial.variantes'), (_req, res) => {
  res.json(db().prepare(
    `SELECT id, name, uuid, updated_at FROM product_attributes WHERE deleted_at IS NULL ORDER BY name`,
  ).all());
});

router.post('/attributes', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const info = db().prepare('INSERT INTO product_attributes (name, uuid) VALUES (?, ?)').run(String(name).trim(), randomUUID());
  const created = db().prepare('SELECT id, name FROM product_attributes WHERE id = ?').get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product_attribute', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/attributes/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name FROM product_attributes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Atributo não encontrado.' });
    return;
  }
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  db().prepare("UPDATE product_attributes SET name = ?, updated_at = datetime('now') WHERE id = ?").run(String(name).trim(), id);
  const after = db().prepare('SELECT id, name FROM product_attributes WHERE id = ?').get(id);
  audit(req, 'editar', 'product_attribute', id, before, after);
  res.json(after);
});

router.delete('/attributes/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name FROM product_attributes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Atributo não encontrado.' });
    return;
  }
  db().transaction(() => {
    db().prepare("UPDATE product_attribute_values SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE attribute_id = ?").run(id);
    db().prepare("UPDATE product_attributes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  })();
  audit(req, 'excluir', 'product_attribute', id, before, null);
  res.json({ ok: true });
});

// ---------- Valores de atributo (CRUD) ----------
router.get('/attributes/:id/values', requirePermission('commercial.products.view'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  res.json(db().prepare(
    `SELECT id, attribute_id, value, sort_order, uuid, updated_at
     FROM product_attribute_values WHERE attribute_id = ? AND deleted_at IS NULL ORDER BY sort_order, value`,
  ).all(id));
});

router.post('/attributes/:id/values', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const attributeId = Number(req.params.id);
  const attr = db().prepare('SELECT id FROM product_attributes WHERE id = ? AND deleted_at IS NULL').get(attributeId);
  if (!attr) {
    res.status(404).json({ error: 'Atributo não encontrado.' });
    return;
  }
  const { value, sortOrder } = req.body ?? {};
  if (!value || !String(value).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: value' });
    return;
  }
  const info = db().prepare(
    'INSERT INTO product_attribute_values (attribute_id, value, sort_order, uuid) VALUES (?, ?, ?, ?)',
  ).run(attributeId, String(value).trim(), sortOrder ?? 0, randomUUID());
  const created = db().prepare('SELECT id, attribute_id, value, sort_order FROM product_attribute_values WHERE id = ?').get(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product_attribute_value', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.put('/attributes/:attrId/values/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, value, sort_order FROM product_attribute_values WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Valor de atributo não encontrado.' });
    return;
  }
  const { value, sortOrder } = req.body ?? {};
  db().prepare(
    `UPDATE product_attribute_values SET value = COALESCE(?, value), sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`,
  ).run(value ? String(value).trim() : null, sortOrder != null ? Number(sortOrder) : null, id);
  const after = db().prepare('SELECT id, attribute_id, value, sort_order FROM product_attribute_values WHERE id = ?').get(id);
  audit(req, 'editar', 'product_attribute_value', id, before, after);
  res.json(after);
});

router.delete('/attributes/:attrId/values/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, value FROM product_attribute_values WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Valor de atributo não encontrado.' });
    return;
  }
  db().prepare("UPDATE product_attribute_values SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  audit(req, 'excluir', 'product_attribute_value', id, before, null);
  res.json({ ok: true });
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

// POST (não DELETE) para não colidir com a rota '/price-lists/:id' acima.
router.post('/price-lists/bulk-delete', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const bodyIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids: number[] = [...new Set(bodyIds.map((id) => Number(id)))];
  if (!ids.length) {
    res.status(400).json({ error: 'Informe ao menos um id.' });
    return;
  }
  const deletedIds: number[] = [];
  const skipped: number[] = [];
  db().transaction(() => {
    for (const id of ids) {
      const before = db().prepare('SELECT id, name FROM price_lists WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) {
        skipped.push(id);
        continue;
      }
      db().prepare("UPDATE customers SET price_list_id = NULL, updated_at = datetime('now') WHERE price_list_id = ?").run(id);
      db().prepare("UPDATE price_lists SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
      audit(req, 'excluir', 'price_list', id, before, null);
      deletedIds.push(id);
    }
  })();
  res.json({ deleted: deletedIds.length, deletedIds, skipped });
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

export default router;
