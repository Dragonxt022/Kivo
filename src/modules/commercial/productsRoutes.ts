import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
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
import { productRepository } from './repositories/ProductRepository';
import { categoryRepository } from './repositories/CategoryRepository';
import { complementGroupRepository, complementItemRepository, productComplementGroupRepository } from './repositories/ComplementRepository';
import { kitItemRepository } from './repositories/KitRepository';
import { recipeItemRepository } from './repositories/RecipeRepository';
import { productAttributeRepository, productAttributeValueRepository, productVariantValueRepository } from './repositories/AttributeRepository';
import { priceListRepository, priceListItemRepository } from './repositories/PriceListRepository';
import { settingsRepository } from '../../core/repositories/SettingsRepository';

const router = Router();

const PRODUCT_COLS = `p.id, p.name, p.description, p.sku, p.barcode, p.category_id, c.name AS category,
  p.unit, p.price_cents, p.cost_cents, p.track_stock, p.stock_qty, p.min_stock, p.favorite, p.active,
  p.image_url, p.updated_at, p.product_type, p.parent_product_id, p.visivel_cardapio`;

function autoSkuEnabled(): boolean {
  return settingsRepository.getBool('estoque.auto_sku', true);
}

function friendlyUniqueError(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!msg.includes('UNIQUE constraint failed')) return null;
  if (msg.includes('products.barcode')) return 'Código de barras já cadastrado em outro produto.';
  if (msg.includes('products.sku')) return 'SKU já cadastrado em outro produto.';
  return null;
}

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
  const includeParents = req.query.includeParents === 'true';
  if (includeParents) {
    if (q) {
      res.json(productRepository.searchAll(q));
    } else {
      res.json(productRepository.listAll());
    }
  } else {
    if (q) {
      res.json(productRepository.search(q));
    } else {
      res.json(productRepository.listTopLevel());
    }
  }
});

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
    res.json({ results: results.map((it) => ({ id: it.id, name: it.name, url: `/api/commercial/products/catalog-image/${it.id}` })) });
  } catch {
    res.json({ results: [], offline: true });
  }
});

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
  const trackStock = productType === 'variante' ? 0 : (b.trackStock === false ? 0 : 1);
  let info: { lastInsertRowid: number | bigint };
  try {
    info = productRepository.rawRun(
      `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, image_url, product_type, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    productRepository.generateAutoSku(newId);
  }
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
  const created = productRepository.findDetailed(newId);
  audit(req, 'criar', 'product', newId, null, created);
  res.status(201).json(created);
});

router.put('/products/:id', requirePermission('commercial.products.edit'), validateBody(updateProductSchema), (req, res) => {
  assertAuth(req);
  const id = String(req.params.id);
  const before = productRepository.findDetailed(id) as { price_cents: number; image_url: string | null } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const b = req.body;
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
  const productType = b.productType ?? (before as unknown as Record<string, unknown>).product_type ?? 'fisico';
  const trackStock = productType === 'variante' ? 0 : (b.trackStock != null ? (b.trackStock ? 1 : 0) : null);
  try {
    productRepository.rawRun(
      `UPDATE products SET
         name = COALESCE(?, name), description = COALESCE(?, description), sku = COALESCE(?, sku),
         barcode = COALESCE(?, barcode), category_id = COALESCE(?, category_id), unit = COALESCE(?, unit),
         price_cents = COALESCE(?, price_cents), cost_cents = COALESCE(?, cost_cents),
         track_stock = COALESCE(?, track_stock), min_stock = COALESCE(?, min_stock),
         active = COALESCE(?, active), image_url = ?, product_type = ?, updated_at = datetime('now')
       WHERE id = ?`,
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
  const after = productRepository.findDetailed(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.delete('/products/:id', requirePermission('commercial.products.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = productRepository.findByIdWithColumns(id, 'product_type, parent_product_id') as
    | { product_type: string; parent_product_id: number | null }
    | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  productRepository.transaction(() => {
    if (before.product_type === 'variante' && before.parent_product_id == null) {
      productRepository.rawRun(
        `UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE parent_product_id = ?`,
        id,
      );
    }
    productRepository.softDelete(id);
  });
  audit(req, 'excluir', 'product', id, before, null);
  res.json({ ok: true });
});

router.post('/products/bulk-delete', requirePermission('commercial.products.delete'), (req, res) => {
  const bodyIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids: string[] = [...new Set(bodyIds.map((id) => String(id)))];
  if (!ids.length) {
    res.status(400).json({ error: 'Informe ao menos um id.' });
    return;
  }
  const deletedIds: string[] = [];
  const skipped: string[] = [];
  productRepository.transaction(() => {
    for (const id of ids) {
      const before = productRepository.findByIdWithColumns(id, 'product_type, parent_product_id') as
        | { product_type: string; parent_product_id: number | null }
        | undefined;
      if (!before) {
        skipped.push(id);
        continue;
      }
      if (before.product_type === 'variante' && before.parent_product_id == null) {
        productRepository.rawRun(
          `UPDATE products SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE parent_product_id = ?`,
          id,
        );
      }
      productRepository.softDelete(id);
      audit(req, 'excluir', 'product', id, before, null);
      deletedIds.push(id);
    }
  });
  res.json({ deleted: deletedIds.length, deletedIds, skipped });
});

router.put('/products/:id/favorite', requirePermission('commercial.products.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = productRepository.findByIdWithColumns(id, 'favorite') as { favorite: number } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const favorite = req.body?.favorite ? 1 : 0;
  productRepository.setFavorite(id, !!favorite);
  const after = productRepository.findDetailed(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.put('/products/:id/cardapio-online', requirePermission('commercial.products.edit'), requireCapability('commercial.cardapio_online'), (req, res) => {
  const id = String(req.params.id);
  const before = productRepository.findByIdWithColumns(id, 'visivel_cardapio') as { visivel_cardapio: number } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const visivelCardapio = req.body?.visivelCardapio ? 1 : 0;
  productRepository.setCardapioOnline(id, !!visivelCardapio);
  const after = productRepository.findDetailed(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

router.post('/products/:id/duplicate', requirePermission('commercial.products.create'), (req, res) => {
  const id = String(req.params.id);
  const source = productRepository.findByIdWithColumns(id,
    'name, description, category_id, unit, price_cents, cost_cents, track_stock, min_stock, product_type, parent_product_id',
  ) as
    | { name: string; description: string | null; category_id: number | null; unit: string; price_cents: number; cost_cents: number; track_stock: number; min_stock: number; product_type: string; parent_product_id: number | null }
    | undefined;
  if (!source) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const info = productRepository.rawRun(
    `INSERT INTO products (name, description, sku, barcode, category_id, unit, price_cents, cost_cents, track_stock, min_stock, product_type, parent_product_id, uuid)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `${source.name} (cópia)`, source.description, source.category_id, source.unit,
    source.price_cents, source.cost_cents, source.track_stock, source.min_stock,
    source.product_type ?? 'fisico', source.parent_product_id ?? null, randomUUID(),
  );
  const created = productRepository.findDetailed(Number(info.lastInsertRowid));
  audit(req, 'criar', 'product', Number(info.lastInsertRowid), null, created);
  res.status(201).json(created);
});

router.get('/products/by-barcode/:code', requirePermission('commercial.products.view'), (req, res) => {
  const row = productRepository.findByBarcode(String(req.params.code));
  if (!row) {
    res.status(404).json({ error: 'Nenhum produto com este código.' });
    return;
  }
  res.json(row);
});

router.post('/products/:id/barcode/generate', requirePermission('commercial.products.edit'), (req, res) => {
  const id = Number(req.params.id);
  const before = productRepository.findDetailed(id);
  if (!before) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const barcode = generateInternalBarcode(id);
  try {
    productRepository.rawRun("UPDATE products SET barcode = ?, updated_at = datetime('now') WHERE id = ?", barcode, id);
  } catch (e) {
    const friendly = friendlyUniqueError(e);
    res.status(409).json({ error: friendly ?? 'Conflito ao gerar código interno — tente novamente.' });
    return;
  }
  const after = productRepository.findDetailed(id);
  audit(req, 'editar', 'product', id, before, after);
  res.json(after);
});

// ---------- Complementos / Opcionais ----------
router.get('/complement-groups', requirePermission('commercial.products.view'), requireCapability('commercial.complementos'), (_req, res) => {
  res.json(complementGroupRepository.listAll());
});

router.post('/complement-groups', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const { name, minSelect, maxSelect } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const id = complementGroupRepository.create({ name: String(name).trim(), min_select: Math.round(Number(minSelect ?? 0)), max_select: maxSelect != null ? Math.round(Number(maxSelect)) : null, uuid: randomUUID() });
  const created = complementGroupRepository.findById(id);
  audit(req, 'criar', 'complement_group', id, null, created);
  res.status(201).json(created);
});

router.put('/complement-groups/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = complementGroupRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const { name, minSelect, maxSelect } = req.body ?? {};
  complementGroupRepository.update(id, {
    name: name ? String(name).trim() : null,
    min_select: minSelect != null ? Math.round(Number(minSelect)) : null,
    max_select: maxSelect !== undefined ? (maxSelect != null ? Math.round(Number(maxSelect)) : null) : null,
  } as Record<string, unknown>);
  const after = complementGroupRepository.findById(id);
  audit(req, 'editar', 'complement_group', id, before, after);
  res.json(after);
});

router.delete('/complement-groups/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = complementGroupRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  complementGroupRepository.softDeleteWithItems(id);
  audit(req, 'excluir', 'complement_group', id, before, null);
  res.json({ ok: true });
});

router.get('/complement-groups/:id/items', requirePermission('commercial.products.view'), requireCapability('commercial.complementos'), (req, res) => {
  res.json(complementItemRepository.listByGroup(Number(req.params.id)));
});

router.post('/complement-groups/:id/items', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const groupId = Number(req.params.id);
  const group = complementGroupRepository.findById(groupId);
  if (!group) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const { productId, priceOverrideCents, sortOrder } = req.body ?? {};
  if (!productId) {
    res.status(400).json({ error: 'Campo obrigatório: productId.' });
    return;
  }
  const prod = productRepository.findById(productId);
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const id = complementItemRepository.create({ group_id: groupId, product_id: productId, price_override_cents: priceOverrideCents != null ? Math.round(Number(priceOverrideCents)) : null, sort_order: Math.round(Number(sortOrder ?? 0)), uuid: randomUUID() });
  const created = complementItemRepository.findDetailed(id);
  audit(req, 'criar', 'complement_group_item', id, null, created);
  res.status(201).json(created);
});

router.put('/complement-groups/:groupId/items/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = complementItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de complemento não encontrado.' });
    return;
  }
  const { productId, priceOverrideCents, sortOrder } = req.body ?? {};
  complementItemRepository.update(id, {
    product_id: productId ?? null,
    price_override_cents: priceOverrideCents !== undefined ? (priceOverrideCents != null ? Math.round(Number(priceOverrideCents)) : null) : null,
    sort_order: sortOrder != null ? Math.round(Number(sortOrder)) : null,
  } as Record<string, unknown>);
  const after = complementItemRepository.findById(id);
  audit(req, 'editar', 'complement_group_item', id, before, after);
  res.json(after);
});

router.delete('/complement-groups/:groupId/items/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const id = Number(req.params.id);
  const before = complementItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de complemento não encontrado.' });
    return;
  }
  complementItemRepository.softDelete(id);
  audit(req, 'excluir', 'complement_group_item', id, before, null);
  res.json({ ok: true });
});

// Mesma permissão da busca de produtos (GET /products) — quem consegue achar o produto no
// PDV precisa conseguir ler os complementos dele, senão o caixa com apenas
// `commercial.products.search` levava 403 aqui e a modal de complementos (ex.: açaí)
// nunca abria, entrando o produto direto sem os opcionais.
router.get('/products/:id/complement-groups', requireAnyPermission('commercial.products.view', 'commercial.products.search'), (req, res) => {
  res.json(productComplementGroupRepository.listByProduct(Number(req.params.id)));
});

router.post('/products/:id/complement-groups', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const productId = Number(req.params.id);
  const { groupId, sortOrder } = req.body ?? {};
  if (!groupId) {
    res.status(400).json({ error: 'Campo obrigatório: groupId.' });
    return;
  }
  const prod = productRepository.findById(productId);
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const group = complementGroupRepository.findById(groupId);
  if (!group) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const existing = productComplementGroupRepository.findExisting(productId, groupId);
  if (existing) {
    res.status(409).json({ error: 'Este grupo já está vinculado ao produto.' });
    return;
  }
  const id = productComplementGroupRepository.create({ product_id: productId, group_id: groupId, sort_order: Math.round(Number(sortOrder ?? 0)), uuid: randomUUID() });
  const created = productComplementGroupRepository.findById(id);
  audit(req, 'criar', 'product_complement_group', id, null, created);
  res.status(201).json(created);
});

router.delete('/products/:id/complement-groups/:linkId', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), (req, res) => {
  const linkId = Number(req.params.linkId);
  const before = productComplementGroupRepository.findById(linkId);
  if (!before) {
    res.status(404).json({ error: 'Vínculo não encontrado.' });
    return;
  }
  productComplementGroupRepository.softDelete(linkId);
  audit(req, 'excluir', 'product_complement_group', linkId, before, null);
  res.json({ ok: true });
});

// ---------- Kits & Combos (componentes fixos) ----------
router.get('/products/:id/kit-items', requirePermission('commercial.products.view'), requireCapability('commercial.kits'), (req, res) => {
  res.json(kitItemRepository.listByProduct(Number(req.params.id)));
});

router.post('/products/:id/kit-items', requirePermission('commercial.products.kits.manage'), requireCapability('commercial.kits'), (req, res) => {
  const productId = Number(req.params.id);
  const prod = productRepository.findByIdWithColumns(productId, 'id, product_type, name') as
    | { id: number; product_type: string; name: string } | undefined;
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
  const comp = productRepository.findByIdWithColumns(componentProductId, 'id, product_type') as
    | { id: number; product_type: string } | undefined;
  if (!comp) {
    res.status(404).json({ error: 'Componente não encontrado.' });
    return;
  }
  if (comp.product_type === 'kit' || comp.product_type === 'combo') {
    res.status(400).json({ error: 'Kit-dentro-de-kit não é suportado (use produtos simples como componentes).' });
    return;
  }
  const id = kitItemRepository.create({ kit_product_id: productId, component_product_id: componentProductId, qty: Number(qty ?? 1), sort_order: Math.round(Number(sortOrder ?? 0)), uuid: randomUUID() });
  const created = kitItemRepository.findDetailed(id);
  audit(req, 'criar', 'kit_item', id, null, created);
  res.status(201).json(created);
});

router.put('/kit-items/:id', requirePermission('commercial.products.kits.manage'), requireCapability('commercial.kits'), (req, res) => {
  const id = Number(req.params.id);
  const before = kitItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de kit não encontrado.' });
    return;
  }
  const { qty, sortOrder } = req.body ?? {};
  kitItemRepository.update(id, { qty: qty != null ? Number(qty) : null, sort_order: sortOrder != null ? Math.round(Number(sortOrder)) : null } as Record<string, unknown>);
  const after = kitItemRepository.findDetailed(id);
  audit(req, 'editar', 'kit_item', id, before, after);
  res.json(after);
});

router.delete('/kit-items/:id', requirePermission('commercial.products.kits.manage'), requireCapability('commercial.kits'), (req, res) => {
  const id = Number(req.params.id);
  const before = kitItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de kit não encontrado.' });
    return;
  }
  kitItemRepository.softDelete(id);
  audit(req, 'excluir', 'kit_item', id, before, null);
  res.json({ ok: true });
});

// ---------- Ficha técnica (produto produzido) ----------
router.get('/products/:id/recipe-items', requirePermission('commercial.products.view'), requireCapability('commercial.producao'), (req, res) => {
  res.json(recipeItemRepository.listByProduct(Number(req.params.id)));
});

router.post('/products/:id/recipe-items', requirePermission('commercial.products.recipe.manage'), requireCapability('commercial.producao'), (req, res) => {
  const productId = Number(req.params.id);
  const prod = productRepository.findByIdWithColumns(productId, 'id, product_type, name') as
    | { id: number; product_type: string; name: string } | undefined;
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
  const input = productRepository.findByIdWithColumns(inputProductId, 'id, product_type, active, track_stock') as
    | { id: number; product_type: string; active: number; track_stock: number } | undefined;
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
  const id = recipeItemRepository.create({ produced_product_id: productId, input_product_id: inputProductId, qty: Number(qty ?? 1), sort_order: Math.round(Number(sortOrder ?? 0)), uuid: randomUUID() });
  const created = recipeItemRepository.findDetailed(id);
  audit(req, 'criar', 'product_recipe_item', id, null, created);
  res.status(201).json(created);
});

router.put('/recipe-items/:id', requirePermission('commercial.products.recipe.manage'), requireCapability('commercial.producao'), (req, res) => {
  const id = Number(req.params.id);
  const before = recipeItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de ficha técnica não encontrado.' });
    return;
  }
  const { qty, sortOrder } = req.body ?? {};
  recipeItemRepository.update(id, { qty: qty != null ? Number(qty) : null, sort_order: sortOrder != null ? Math.round(Number(sortOrder)) : null } as Record<string, unknown>);
  const after = recipeItemRepository.findDetailed(id);
  audit(req, 'editar', 'product_recipe_item', id, before, after);
  res.json(after);
});

router.delete('/recipe-items/:id', requirePermission('commercial.products.recipe.manage'), requireCapability('commercial.producao'), (req, res) => {
  const id = Number(req.params.id);
  const before = recipeItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de ficha técnica não encontrado.' });
    return;
  }
  recipeItemRepository.softDelete(id);
  audit(req, 'excluir', 'product_recipe_item', id, before, null);
  res.json({ ok: true });
});

// ---------- Variantes de produto ----------
router.get('/products/:id/variants', requirePermission('commercial.products.view'), requireCapability('commercial.variantes'), (req, res) => {
  res.json(productRepository.findVariants(Number(req.params.id)));
});

router.post('/products/:id/attributes/generate-variants', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const parentId = Number(req.params.id);
  const parent = productRepository.findDetailed(parentId) as
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
  const values = productAttributeValueRepository.findByIds(attributeValueIds) as
    { id: number; attribute_id: number; attribute_name: string; value: string }[];
  if (values.length !== attributeValueIds.length) {
    res.status(400).json({ error: 'Um ou mais IDs de valor de atributo inválidos.' });
    return;
  }
  const groups = new Map<number, { attribute_id: number; attribute_name: string; value_id: number; value: string }[]>();
  for (const v of values) {
    const arr = groups.get(v.attribute_id) ?? [];
    arr.push({ attribute_id: v.attribute_id, attribute_name: v.attribute_name, value_id: v.id, value: v.value });
    groups.set(v.attribute_id, arr);
  }
  const combos = cartesian([...groups.values()]);
  const attrNames = [...groups.values()].map((g) => g[0].attribute_name);
  const created: number[] = [];
  const skipped: number[] = [];
  productRepository.transaction(() => {
    for (const combo of combos) {
      const valueIds = combo.map((c) => c.value_id).sort();
      const existing = productVariantValueRepository.findExistingCombination(parentId, valueIds);
      if (existing) {
        skipped.push((existing as { product_id: number }).product_id);
        continue;
      }
      const suffix = combo.map((c) => c.value).join(', ');
      const variantName = `${parent.name} - ${suffix}`;
      const info = productRepository.rawRun(
        `INSERT INTO products (name, parent_product_id, product_type, category_id, unit, price_cents, cost_cents, track_stock, min_stock, active, uuid)
         VALUES (?, ?, 'variante', (SELECT category_id FROM products WHERE id = ?), (SELECT unit FROM products WHERE id = ?), ?, ?, 1, 0, 1, ?)`,
        variantName, parentId, parentId, parentId, parent.price_cents, parent.cost_cents, randomUUID(),
      );
      const newId = Number(info.lastInsertRowid);
      for (const c of combo) {
        productRepository.rawRun(
          `INSERT INTO product_variant_values (product_id, attribute_id, attribute_value_id, uuid) VALUES (?, ?, ?, ?)`,
          newId, c.attribute_id, c.value_id, randomUUID(),
        );
      }
      created.push(newId);
    }
  });
  audit(req, 'gerar_variantes', 'product', parentId, null, { created: created.length, skipped: skipped.length });
  res.status(201).json({ created, skipped, total: combos.length });
});

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])), [[]]);
}

// ---------- Atributos de variante (CRUD) ----------
router.get('/attributes', requirePermission('commercial.products.view'), requireCapability('commercial.variantes'), (_req, res) => {
  res.json(productAttributeRepository.listAll());
});

router.post('/attributes', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const id = productAttributeRepository.create({ name: String(name).trim(), uuid: randomUUID() });
  const created = productAttributeRepository.findById(id);
  audit(req, 'criar', 'product_attribute', id, null, created);
  res.status(201).json(created);
});

router.put('/attributes/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = productAttributeRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Atributo não encontrado.' });
    return;
  }
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  productAttributeRepository.update(id, { name: String(name).trim() } as Record<string, unknown>);
  const after = productAttributeRepository.findById(id);
  audit(req, 'editar', 'product_attribute', id, before, after);
  res.json(after);
});

router.delete('/attributes/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = productAttributeRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Atributo não encontrado.' });
    return;
  }
  productAttributeRepository.softDeleteWithValues(id);
  audit(req, 'excluir', 'product_attribute', id, before, null);
  res.json({ ok: true });
});

// ---------- Valores de atributo (CRUD) ----------
router.get('/attributes/:id/values', requirePermission('commercial.products.view'), requireCapability('commercial.variantes'), (req, res) => {
  res.json(productAttributeValueRepository.listByAttribute(Number(req.params.id)));
});

router.post('/attributes/:id/values', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const attributeId = Number(req.params.id);
  const attr = productAttributeRepository.findById(attributeId);
  if (!attr) {
    res.status(404).json({ error: 'Atributo não encontrado.' });
    return;
  }
  const { value, sortOrder } = req.body ?? {};
  if (!value || !String(value).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: value' });
    return;
  }
  const id = productAttributeValueRepository.create({ attribute_id: attributeId, value: String(value).trim(), sort_order: sortOrder ?? 0, uuid: randomUUID() });
  const created = productAttributeValueRepository.findById(id);
  audit(req, 'criar', 'product_attribute_value', id, null, created);
  res.status(201).json(created);
});

router.put('/attributes/:attrId/values/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = productAttributeValueRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Valor de atributo não encontrado.' });
    return;
  }
  const { value, sortOrder } = req.body ?? {};
  productAttributeValueRepository.update(id, { value: value ? String(value).trim() : null, sort_order: sortOrder != null ? Number(sortOrder) : null } as Record<string, unknown>);
  const after = productAttributeValueRepository.findById(id);
  audit(req, 'editar', 'product_attribute_value', id, before, after);
  res.json(after);
});

router.delete('/attributes/:attrId/values/:id', requirePermission('commercial.products.variants.manage'), requireCapability('commercial.variantes'), (req, res) => {
  const id = Number(req.params.id);
  const before = productAttributeValueRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Valor de atributo não encontrado.' });
    return;
  }
  productAttributeValueRepository.softDelete(id);
  audit(req, 'excluir', 'product_attribute_value', id, before, null);
  res.json({ ok: true });
});

// ---------- Listas de preço ----------
router.get('/price-lists', requirePermission('commercial.pricelists.view'), (_req, res) => {
  res.json(priceListRepository.listAll());
});

router.get('/price-lists/:id', requirePermission('commercial.pricelists.view'), (req, res) => {
  const id = Number(req.params.id);
  const list = priceListRepository.findDetail(id);
  if (!list) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  const items = priceListItemRepository.listByPriceList(id);
  res.json({ ...list, items });
});

router.post('/price-lists', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const { name, isDefault } = req.body ?? {};
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  let newId = 0;
  priceListRepository.transaction(() => {
    if (isDefault) priceListRepository.unsetOtherDefaults();
    newId = priceListRepository.create({ name: String(name).trim(), is_default: isDefault ? 1 : 0, uuid: randomUUID() });
  });
  const created = priceListRepository.findById(newId);
  audit(req, 'criar', 'price_list', newId, null, created);
  res.status(201).json(created);
});

router.put('/price-lists/:id', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = priceListRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  const { name, active, isDefault } = req.body ?? {};
  priceListRepository.transaction(() => {
    if (isDefault) priceListRepository.unsetOtherDefaults();
    priceListRepository.update(id, {
      name: name ?? null,
      active: active != null ? (active ? 1 : 0) : null,
      is_default: isDefault != null ? (isDefault ? 1 : 0) : null,
    } as Record<string, unknown>);
  });
  const after = priceListRepository.findById(id);
  audit(req, 'editar', 'price_list', id, before, after);
  res.json(after);
});

router.delete('/price-lists/:id', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = priceListRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Lista de preço não encontrada.' });
    return;
  }
  priceListRepository.transaction(() => {
    priceListRepository.migrateCustomers(id);
    priceListRepository.softDelete(id);
  });
  audit(req, 'excluir', 'price_list', id, before, null);
  res.json({ ok: true });
});

router.post('/price-lists/bulk-delete', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const bodyIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids: number[] = [...new Set(bodyIds.map((id) => Number(id)))];
  if (!ids.length) {
    res.status(400).json({ error: 'Informe ao menos um id.' });
    return;
  }
  const deletedIds: number[] = [];
  const skipped: number[] = [];
  priceListRepository.transaction(() => {
    for (const id of ids) {
      const before = priceListRepository.findById(id);
      if (!before) {
        skipped.push(id);
        continue;
      }
      priceListRepository.migrateCustomers(id);
      priceListRepository.softDelete(id);
      audit(req, 'excluir', 'price_list', id, before, null);
      deletedIds.push(id);
    }
  });
  res.json({ deleted: deletedIds.length, deletedIds, skipped });
});

router.put('/price-lists/:id/items', requirePermission('commercial.pricelists.manage'), (req, res) => {
  const id = Number(req.params.id);
  const list = priceListRepository.findById(id);
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
    priceListRepository.transaction(() => {
      priceListItemRepository.deleteByPriceList(id);
      for (const item of items) {
        priceListItemRepository.create({ price_list_id: id, product_id: Number(item.productId), min_qty: Number(item.minQty ?? 1), unit_price_cents: Math.round(item.unitPriceCents) });
      }
      priceListRepository.update(id, {} as Record<string, unknown>);
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const after = priceListItemRepository.listByPriceList(id);
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
