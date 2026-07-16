import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requirePermission, requireAnyPermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { audit } from '../../core/audit/service';
import { createCategorySchema, updateCategorySchema, deleteCategorySchema, grantStoreCreditSchema, createComplementGroupSchema, updateComplementGroupSchema, createComplementItemSchema, updateComplementItemSchema } from '../../shared/schemas';
import { validateBody } from '../../shared/validateBody';
import productsRouter from './productsRoutes';
import productsImportRouter from './productsImportRoutes';
import stockRouter from './stockRoutes';
import { makeCrudRouter } from './crud';
import { grant as grantStoreCredit } from './storeCredit';
import purchasesRouter from './purchasesRoutes';
import { categoryRepository } from './repositories/CategoryRepository';
import { customerRepository } from './repositories/CustomerRepository';
import { complementGroupRepository, complementItemRepository, productComplementGroupRepository } from './repositories/ComplementRepository';
import { productRepository } from './repositories/ProductRepository';
import { validateImageBuffer } from '../../core/catalog/imageValidation';
import { saveLocalCategoryImage, categoryImagesDir } from '../../core/catalog/submissionQueue';

const router = Router();

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

router.post('/customers/:id/credit', requirePermission('commercial.customers.creditgrant'), validateBody(grantStoreCreditSchema), (req, res) => {
  const customerId = Number(req.params.id);
  const { amountCents, reason } = req.body;
  const customer = customerRepository.findById(customerId);
  if (!customer) {
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  let result: ReturnType<typeof grantStoreCredit>;
  customerRepository.transaction(() => {
    result = grantStoreCredit(req, customerId, Math.round(Number(amountCents)), reason, 'manual');
  });
  if (!result!.ok) {
    res.status(400).json(result!);
    return;
  }
  res.status(201).json(result!);
});

// ---------- Categorias ----------
router.get('/categories', requirePermission('commercial.products.view'), (_req, res) => {
  res.json(categoryRepository.listAll());
});
router.post('/categories', requirePermission('commercial.products.create'), validateBody(createCategorySchema), (req, res) => {
  const { name, parentId } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const id = categoryRepository.create({ name, parent_id: parentId ?? null, uuid: randomUUID() });
  audit(req, 'criar', 'category', id, null, { name });
  res.status(201).json({ id, name });
});
router.put('/categories/:id', requirePermission('commercial.products.edit'), validateBody(updateCategorySchema), (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const before = categoryRepository.findByIdWithColumns(id, 'id, name');
  if (!before) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  categoryRepository.update(id, { name: String(name).trim() } as Record<string, unknown>);
  audit(req, 'editar', 'category', id, before, { name: String(name).trim() });
  res.json({ id, name: String(name).trim() });
});
router.delete('/categories/:id', requirePermission('commercial.products.delete'), validateBody(deleteCategorySchema), (req, res) => {
  const id = Number(req.params.id);
  const before = categoryRepository.findByIdWithColumns(id, 'id, name');
  if (!before) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  const { migrateToId } = req.body;
  if (migrateToId != null) {
    if (Number(migrateToId) === id) {
      res.status(400).json({ error: 'Categoria de destino não pode ser a mesma que está sendo excluída.' });
      return;
    }
    const target = categoryRepository.findById(migrateToId);
    if (!target) {
      res.status(400).json({ error: 'Categoria de destino não encontrada.' });
      return;
    }
  }
  categoryRepository.transaction(() => {
    categoryRepository.migrateProducts(id, migrateToId ?? null);
    categoryRepository.softDelete(id);
  });
  audit(req, 'excluir', 'category', id, before, { migratedTo: migrateToId ?? null });
  res.json({ ok: true });
});

// ---------- Categoria: upload de imagem ----------
router.post('/categories/:id/image', requirePermission('commercial.products.edit'), async (req, res) => {
  const id = Number(req.params.id);
  const cat = categoryRepository.findByIdWithColumns(id, 'id, name, image_url') as { id: number; name: string; image_url: string | null } | undefined;
  if (!cat) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  const b64 = req.body?.imageBase64;
  if (!b64) {
    res.status(400).json({ error: 'Campo obrigatório: imageBase64' });
    return;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(String(b64), 'base64');
  } catch {
    res.status(400).json({ error: 'Imagem inválida (base64).' });
    return;
  }
  const check = validateImageBuffer(buf);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  // Remove imagem antiga se existir
  if (cat.image_url && cat.image_url.startsWith('/uploads/categories/')) {
    const oldPath = path.join(categoryImagesDir(), path.basename(cat.image_url));
    try { fs.unlinkSync(oldPath); } catch {}
  }
  const imageUrl = saveLocalCategoryImage(buf, check.format);
  categoryRepository.update(id, { image_url: imageUrl } as Record<string, unknown>);
  audit(req, 'editar', 'category', id, { image_url: cat.image_url }, { image_url: imageUrl });
  res.json({ imageUrl });
});

router.delete('/categories/:id/image', requirePermission('commercial.products.edit'), (req, res) => {
  const id = Number(req.params.id);
  const cat = categoryRepository.findByIdWithColumns(id, 'id, name, image_url') as { id: number; name: string; image_url: string | null } | undefined;
  if (!cat) {
    res.status(404).json({ error: 'Categoria não encontrada.' });
    return;
  }
  if (cat.image_url && cat.image_url.startsWith('/uploads/categories/')) {
    const oldPath = path.join(categoryImagesDir(), path.basename(cat.image_url));
    try { fs.unlinkSync(oldPath); } catch {}
  }
  categoryRepository.update(id, { image_url: null } as Record<string, unknown>);
  audit(req, 'editar', 'category', id, { image_url: cat.image_url }, { image_url: null });
  res.json({ ok: true });
});

// ---------- Complementos / Opcionais ----------
router.get('/complement-groups', requirePermission('commercial.products.view'), requireCapability('commercial.complementos'), (_req, res) => {
  res.json(complementGroupRepository.listAll());
});

router.post('/complement-groups', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), validateBody(createComplementGroupSchema), (req, res) => {
  const { name, minSelect, maxSelect } = req.body;
  const id = complementGroupRepository.create({ name: String(name).trim(), min_select: minSelect ?? 0, max_select: maxSelect ?? null, uuid: randomUUID() });
  const created = complementGroupRepository.findById(id);
  audit(req, 'criar', 'complement_group', id, null, created);
  res.status(201).json(created);
});

router.put('/complement-groups/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), validateBody(updateComplementGroupSchema), (req, res) => {
  const id = Number(req.params.id);
  const before = complementGroupRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const { name, minSelect, maxSelect } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = String(name).trim();
  if (minSelect !== undefined) updates.min_select = minSelect;
  if (maxSelect !== undefined) updates.max_select = maxSelect;
  if (Object.keys(updates).length) complementGroupRepository.update(id, updates);
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

// ---------- Itens de complemento ----------
router.get('/complement-groups/:id/items', requirePermission('commercial.products.view'), requireCapability('commercial.complementos'), (req, res) => {
  res.json(complementItemRepository.listByGroup(Number(req.params.id)));
});

router.post('/complement-groups/:id/items', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), validateBody(createComplementItemSchema), (req, res) => {
  const groupId = Number(req.params.id);
  const group = complementGroupRepository.findById(groupId);
  if (!group) {
    res.status(404).json({ error: 'Grupo de complementos não encontrado.' });
    return;
  }
  const { productId, priceOverrideCents, sortOrder } = req.body;
  const prod = productRepository.findById(productId);
  if (!prod) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }
  const id = complementItemRepository.create({ group_id: groupId, product_id: productId, price_override_cents: priceOverrideCents ?? null, sort_order: sortOrder ?? 0, uuid: randomUUID() });
  const created = complementItemRepository.findDetailed(id);
  audit(req, 'criar', 'complement_group_item', id, null, created);
  res.status(201).json(created);
});

router.put('/complement-groups/:groupId/items/:id', requirePermission('commercial.products.complements.manage'), requireCapability('commercial.complementos'), validateBody(updateComplementItemSchema), (req, res) => {
  const id = Number(req.params.id);
  const before = complementItemRepository.findById(id);
  if (!before) {
    res.status(404).json({ error: 'Item de complemento não encontrado.' });
    return;
  }
  const { productId, priceOverrideCents, sortOrder } = req.body;
  const updates: Record<string, unknown> = {};
  if (productId !== undefined) updates.product_id = productId;
  if (priceOverrideCents !== undefined) updates.price_override_cents = priceOverrideCents;
  if (sortOrder !== undefined) updates.sort_order = sortOrder;
  if (Object.keys(updates).length) complementItemRepository.update(id, updates);
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
// PDV precisa conseguir ler os complementos dele
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

// Antes do productsRouter: rotas literais ('/products/export.csv') têm que ser
// avaliadas antes de qualquer '/products/:algo' que possa capturá-las.
router.use(productsImportRouter);
router.use(productsRouter);

router.use('/stock', stockRouter);

router.use('/purchases', purchasesRouter);

export default router;
