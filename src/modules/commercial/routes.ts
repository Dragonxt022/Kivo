import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { createCategorySchema, updateCategorySchema, deleteCategorySchema, grantStoreCreditSchema } from '../../shared/schemas';
import { validateBody } from '../../shared/validateBody';
import productsRouter from './productsRoutes';
import stockRouter from './stockRoutes';
import { makeCrudRouter } from './crud';
import { grant as grantStoreCredit } from './storeCredit';
import purchasesRouter from './purchasesRoutes';
import { categoryRepository } from './repositories/CategoryRepository';
import { customerRepository } from './repositories/CustomerRepository';
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

router.use(productsRouter);

router.use('/stock', stockRouter);

router.use('/purchases', purchasesRouter);

export default router;
