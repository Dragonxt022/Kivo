import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { validateBody } from '../../shared/validateBody';
import { stockMoveSchema, createCategorySchema, updateCategorySchema, deleteCategorySchema, grantStoreCreditSchema } from '../../shared/schemas';
import productsRouter from './productsRoutes';
import { makeCrudRouter } from './crud';
import { moveStock, listMovements, type MovementType } from './stock';
import { grant as grantStoreCredit } from './storeCredit';
import purchasesRouter from './purchasesRoutes';

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

router.post('/customers/:id/credit', requirePermission('commercial.customers.creditgrant'), validateBody(grantStoreCreditSchema), (req, res) => {
  const customerId = Number(req.params.id);
  const { amountCents, reason } = req.body;
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
router.post('/categories', requirePermission('commercial.products.create'), validateBody(createCategorySchema), (req, res) => {
  const { name, parentId } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Campo obrigatório: name' });
    return;
  }
  const info = db().prepare('INSERT INTO categories (name, parent_id, uuid) VALUES (?, ?, ?)').run(name, parentId ?? null, randomUUID());
  audit(req, 'criar', 'category', Number(info.lastInsertRowid), null, { name });
  res.status(201).json({ id: Number(info.lastInsertRowid), name });
});
router.put('/categories/:id', requirePermission('commercial.products.edit'), validateBody(updateCategorySchema), (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
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
router.delete('/categories/:id', requirePermission('commercial.products.delete'), validateBody(deleteCategorySchema), (req, res) => {
  const id = Number(req.params.id);
  const before = db().prepare('SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; name: string } | undefined;
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

router.use(productsRouter);

// ---------- Estoque ----------
router.get('/stock/movements', requirePermission('commercial.stock.view'), (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : undefined;
  res.json(listMovements(productId, Math.min(Number(req.query.limit ?? 100), 500)));
});

router.use('/stock/move', requirePermission('commercial.stock.move'), validateBody(stockMoveSchema), (req, res) => {
  const { productId, type, qty, reason } = req.body;
  const result = moveStock(req, productId, type as MovementType, qty, reason);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.use('/purchases', purchasesRouter);

export default router;
