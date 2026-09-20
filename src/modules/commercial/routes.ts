import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import { requirePermission, requireAnyPermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { audit } from '../../core/audit/service';
import { createCategorySchema, updateCategorySchema, deleteCategorySchema, grantStoreCreditSchema, createComplementGroupSchema, updateComplementGroupSchema, createComplementItemSchema, updateComplementItemSchema } from '../../shared/schemas';
import { validateBody } from '../../shared/validateBody';
import productsRouter from './productsRoutes';
import productsImportRouter from './productsImportRoutes';
import { toCsv } from './productsImport';
import stockRouter from './stockRoutes';
import { makeCrudRouter, buildCrudListWhere, type CrudConfig } from './crud';
import { grant as grantStoreCredit, listCreditMovements } from './storeCredit';
import { listLoyaltyMovements } from './loyalty';
import purchasesRouter from './purchasesRoutes';
import { categoryRepository } from './repositories/CategoryRepository';
import { customerRepository } from './repositories/CustomerRepository';
import { complementGroupRepository, complementItemRepository, productComplementGroupRepository } from './repositories/ComplementRepository';
import { productRepository } from './repositories/ProductRepository';
import { validateImageBuffer } from '../../core/catalog/imageValidation';
import { saveLocalCategoryImage, categoryImagesDir } from '../../core/catalog/submissionQueue';

const router = Router();

// ---------- Clientes (CRUD via fábrica + ficha/segmentação) ----------

/**
 * Filtros de segmentação que não são simples igualdade: devedores (recebível em aberto),
 * aniversariantes do mês, sem compra há N dias e etiqueta. Combinam com a busca (`q`) e os
 * filtros exatos tratados pela fábrica de CRUD.
 */
function customerExtraWhere(req: Request): { sql: string; params: unknown[] } | null {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (req.query.debtors === '1' || req.query.debtors === 'true') {
    clauses.push(`EXISTS (SELECT 1 FROM receivables r WHERE r.customer_id = t.id AND r.deleted_at IS NULL AND r.status = 'aberta')`);
  }

  const birthdayMonth = Number(req.query.birthdayMonth);
  if (Number.isInteger(birthdayMonth) && birthdayMonth >= 1 && birthdayMonth <= 12) {
    clauses.push(`substr(t.birthday, 6, 2) = ?`);
    params.push(String(birthdayMonth).padStart(2, '0'));
  }

  const inactiveDays = Number(req.query.inactiveDays);
  if (Number.isFinite(inactiveDays) && inactiveDays > 0) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = t.id AND s.deleted_at IS NULL
         AND s.status = 'concluida' AND s.created_at >= datetime('now', ?))`,
    );
    params.push(`-${Math.floor(inactiveDays)} days`);
  }

  const tag = String(req.query.tag ?? '').trim();
  if (tag) {
    clauses.push(`(',' || REPLACE(COALESCE(t.tags, ''), ' ', '') || ',') LIKE ?`);
    params.push(`%,${tag},%`);
  }

  return clauses.length ? { sql: clauses.join(' AND '), params } : null;
}

const CUSTOMERS_CRUD: CrudConfig = {
  table: 'customers', entity: 'customer', permPrefix: 'commercial.customers',
  fields: ['name', 'document', 'email', 'phone', 'address', 'notes', 'price_list_id', 'cep', 'agreement_company_id', 'birthday', 'tags'],
  required: ['name'],
  readOnlyFields: ['store_credit_cents', 'loyalty_points'],
  searchFields: ['name', 'document', 'phone', 'email'],
  digitSearchFields: ['document', 'phone'],
  filterFields: ['active', 'price_list_id', 'agreement_company_id'],
  dateFields: ['birthday'],
  uniqueDocument: true,
  bulkUpdateFields: ['active', 'price_list_id', 'agreement_company_id'],
  // Métricas calculadas usadas na listagem (última compra, ticket médio, nº de compras).
  computedSelect: [
    `(SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = t.id AND s.deleted_at IS NULL AND s.status = 'concluida') AS last_purchase`,
    `(SELECT CAST(AVG(s.total_cents) AS INTEGER) FROM sales s WHERE s.customer_id = t.id AND s.deleted_at IS NULL AND s.status = 'concluida') AS avg_ticket_cents`,
    `(SELECT COUNT(*) FROM sales s WHERE s.customer_id = t.id AND s.deleted_at IS NULL AND s.status = 'concluida') AS purchase_count`,
  ],
  customListWhere: (req) => customerExtraWhere(req),
};

// Exportação precisa vir ANTES do CRUD genérico: a rota `/:id` capturaria "export.csv".
router.get('/customers/export.csv', requirePermission('commercial.customers.view'), (req, res) => {
  const { where, params } = buildCrudListWhere(CUSTOMERS_CRUD, req);
  const rows = customerRepository.raw(
    `SELECT t.name, t.document, t.phone, t.email, t.cep, t.address, t.birthday, t.tags,
            pl.name AS price_list, ac.name AS agreement,
            t.store_credit_cents, t.loyalty_points, t.active,
            (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = t.id AND s.deleted_at IS NULL AND s.status = 'concluida') AS last_purchase,
            (SELECT CAST(AVG(s.total_cents) AS INTEGER) FROM sales s WHERE s.customer_id = t.id AND s.deleted_at IS NULL AND s.status = 'concluida') AS avg_ticket_cents
       FROM customers t
       LEFT JOIN price_lists pl ON pl.id = t.price_list_id
       LEFT JOIN agreement_companies ac ON ac.id = t.agreement_company_id
      WHERE ${where}
      ORDER BY t.name`,
    ...params,
  ) as unknown as {
    name: string; document: string | null; phone: string | null; email: string | null;
    cep: string | null; address: string | null; birthday: string | null; tags: string | null;
    price_list: string | null; agreement: string | null;
    store_credit_cents: number; loyalty_points: number; active: number;
    last_purchase: string | null; avg_ticket_cents: number | null;
  }[];

  const cents = (c: unknown): string => (Number(c ?? 0) / 100).toFixed(2).replace('.', ',');
  const csv = toCsv([
    ['Nome', 'Documento', 'Telefone', 'E-mail', 'CEP', 'Endereço', 'Aniversário', 'Etiquetas',
      'Lista de preço', 'Convênio', 'Crédito (R$)', 'Pontos', 'Última compra', 'Ticket médio (R$)', 'Situação'],
    ...rows.map((r) => [
      r.name, r.document ?? '', r.phone ?? '', r.email ?? '', r.cep ?? '', r.address ?? '',
      r.birthday ?? '', r.tags ?? '', r.price_list ?? '', r.agreement ?? '',
      cents(r.store_credit_cents), String(r.loyalty_points ?? 0),
      r.last_purchase ?? '', r.avg_ticket_cents != null ? cents(r.avg_ticket_cents) : '',
      r.active ? 'ativo' : 'inativo',
    ]),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="clientes-${stamp}.csv"`);
  audit(req, 'exportar', 'customer', 0, null, { total: rows.length });
  res.send(csv);
});

router.use('/customers', makeCrudRouter(CUSTOMERS_CRUD));

/**
 * Resumo da ficha: agrega no servidor o que antes a tela calculava carregando todas as
 * compras e recebíveis do cliente. `monthly` traz o histórico completo (uma linha por mês,
 * barato) para o gráfico; a tela só recorta a janela de 12 meses que quer mostrar.
 */
router.get('/customers/:id/summary', requirePermission('commercial.customers.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!customerRepository.findById(id)) {
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  const purchases = customerRepository.rawOne(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents,
            COALESCE(CAST(AVG(total_cents) AS INTEGER), 0) AS avg_ticket_cents,
            MAX(created_at) AS last_purchase
       FROM sales WHERE customer_id = ? AND deleted_at IS NULL AND status = 'concluida'`,
    id,
  );
  const openReceivables = customerRepository.rawOne(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM receivables WHERE customer_id = ? AND deleted_at IS NULL AND status = 'aberta'`,
    id,
  );
  const overdueReceivables = customerRepository.rawOne(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM receivables WHERE customer_id = ? AND deleted_at IS NULL AND status = 'aberta' AND due_date < date('now', 'localtime')`,
    id,
  );
  const monthly = customerRepository.raw(
    `SELECT substr(created_at, 1, 7) AS month, COALESCE(SUM(total_cents), 0) AS total_cents, COUNT(*) AS count
       FROM sales WHERE customer_id = ? AND deleted_at IS NULL AND status = 'concluida'
      GROUP BY month ORDER BY month`,
    id,
  );
  res.json({ purchases, receivables: openReceivables, overdue: overdueReceivables, monthly });
});

router.get('/customers/:id/credit-movements', requirePermission('commercial.customers.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!customerRepository.findById(id)) {
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  res.json(listCreditMovements(id, limit));
});

router.get('/customers/:id/loyalty-movements', requirePermission('commercial.customers.view'), (req, res) => {
  const id = Number(req.params.id);
  if (!customerRepository.findById(id)) {
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  res.json(listLoyaltyMovements(id, limit));
});

/** Exportação da ficha em CSV (dados do cliente + compras + financeiro + extratos). */
router.get('/customers/:id/export.csv', requirePermission('commercial.customers.view'), (req, res) => {
  const id = Number(req.params.id);
  const customer = customerRepository.findById(id) as Record<string, unknown> | undefined;
  if (!customer) {
    res.status(404).json({ error: 'Cliente não encontrado.' });
    return;
  }
  const cents = (c: unknown): string => (Number(c ?? 0) / 100).toFixed(2).replace('.', ',');
  const purchases = customerRepository.raw(
    `SELECT id, created_at, status, payment_method, total_cents FROM sales
      WHERE customer_id = ? AND deleted_at IS NULL ORDER BY id DESC`,
    id,
  ) as Record<string, unknown>[];
  const receivables = customerRepository.raw(
    `SELECT description, due_date, status, amount_cents FROM receivables
      WHERE customer_id = ? AND deleted_at IS NULL ORDER BY due_date DESC`,
    id,
  ) as Record<string, unknown>[];
  const credit = listCreditMovements(id, 500) as Record<string, unknown>[];
  const loyalty = listLoyaltyMovements(id, 500) as Record<string, unknown>[];

  const rows: (string | number)[][] = [
    ['Cliente'], ['Nome', String(customer.name ?? '')], ['Documento', String(customer.document ?? '')],
    ['Telefone', String(customer.phone ?? '')], ['E-mail', String(customer.email ?? '')],
    ['Aniversário', String(customer.birthday ?? '')], ['Etiquetas', String(customer.tags ?? '')],
    ['Crédito de troca (R$)', cents(customer.store_credit_cents)], ['Pontos', String(customer.loyalty_points ?? 0)],
    [],
    ['Compras'], ['#', 'Data', 'Situação', 'Forma', 'Total (R$)'],
    ...purchases.map((p) => [p.id as number, String(p.created_at), String(p.status), String(p.payment_method), cents(p.total_cents)]),
    [],
    ['Financeiro'], ['Descrição', 'Vencimento', 'Situação', 'Valor (R$)'],
    ...receivables.map((r) => [String(r.description), String(r.due_date ?? ''), String(r.status), cents(r.amount_cents)]),
    [],
    ['Extrato de crédito'], ['Data', 'Tipo', 'Valor (R$)', 'Saldo após', 'Motivo'],
    ...credit.map((m) => [String(m.created_at), String(m.type), cents(m.amount), cents(m.balance_after), String(m.reason ?? '')]),
    [],
    ['Extrato de pontos'], ['Data', 'Tipo', 'Pontos', 'Saldo após', 'Motivo'],
    ...loyalty.map((m) => [String(m.created_at), String(m.type), String(m.amount), String(m.balance_after), String(m.reason ?? '')]),
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cliente-${id}-${stamp}.csv"`);
  audit(req, 'exportar', 'customer', id, null, { compras: purchases.length, recebiveis: receivables.length });
  res.send(toCsv(rows));
});
router.use('/suppliers', makeCrudRouter({
  table: 'suppliers', entity: 'supplier', permPrefix: 'commercial.suppliers',
  fields: [
    'name', 'trade_name', 'document', 'email', 'phone', 'address', 'notes',
    'ie', 'cep', 'street', 'number', 'complement', 'district', 'city', 'state',
    'contact_name', 'contact_phone', 'contact_email', 'default_markup_bps',
  ],
  required: ['name'],
  searchFields: ['name', 'trade_name', 'document', 'email', 'phone', 'city'],
  digitSearchFields: ['document', 'phone', 'cep'],
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
