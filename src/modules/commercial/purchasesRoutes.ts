import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { validateBody } from '../../shared/validateBody';
import { createPurchaseSchema, updatePurchaseSchema } from '../../shared/schemas';
import { moveStockRaw } from './stock';
import { purchaseRepository, purchaseItemRepository } from './repositories/PurchaseRepository';
import { supplierRepository } from './repositories/SupplierRepository';
import { productRepository } from './repositories/ProductRepository';

const router = Router();

function replacePurchaseItems(purchaseId: number, items: { productId: number; qty: number; unitCostCents: number }[]): number {
  purchaseItemRepository.deleteByPurchase(purchaseId);
  const total = sumCents(...items.map((i) => Math.round(i.qty * i.unitCostCents)));
  for (const item of items) {
    purchaseItemRepository.create({ purchase_id: purchaseId, product_id: item.productId, qty: item.qty, unit_cost_cents: Math.round(item.unitCostCents) });
  }
  purchaseRepository.updateTotal(purchaseId, total);
  return total;
}

function postPurchaseItems(req: import('express').Request, purchaseId: number, items: { productId: number; qty: number; unitCostCents: number }[]): void {
  for (const item of items) {
    productRepository.updateCost(item.productId, Math.round(item.unitCostCents));
    const move = moveStockRaw(req, Number(item.productId), 'entrada', Number(item.qty), 'compra', 'purchase', purchaseId);
    if (!move.ok) throw new Error(move.error);
  }
}

router.get('/', requirePermission('commercial.purchases.view'), (_req, res) => {
  res.json(purchaseRepository.listAll());
});

router.get('/:id/items', requirePermission('commercial.purchases.view'), (req, res) => {
  res.json(purchaseItemRepository.listByPurchase(Number(req.params.id)));
});

router.post('/', requirePermission('commercial.purchases.create'), validateBody(createPurchaseSchema), (req, res) => {
  const { supplierId, items, notes, status } = req.body;
  const asDraft = status === 'rascunho';
  const supplier = supplierRepository.findById(supplierId);
  if (!supplier) {
    res.status(400).json({ error: 'Fornecedor inexistente.' });
    return;
  }

  let purchaseId = 0;
  let error: string | null = null;
  try {
    purchaseRepository.transaction(() => {
      const total = sumCents(...items.map((i: { qty: number; unitCostCents: number }) => Math.round(i.qty * i.unitCostCents)));
      purchaseId = purchaseRepository.create({
        supplier_id: supplierId,
        status: asDraft ? 'rascunho' : 'recebida',
        total_cents: total,
        notes: notes ?? null,
        received_at: asDraft ? null : new Date().toISOString(),
        uuid: randomUUID(),
      });
      for (const item of items) {
        purchaseItemRepository.create({ purchase_id: purchaseId, product_id: item.productId, qty: item.qty, unit_cost_cents: Math.round(item.unitCostCents) });
      }
      if (!asDraft) postPurchaseItems(req, purchaseId, items);
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    res.status(400).json({ error });
    return;
  }
  audit(req, 'criar', 'purchase', purchaseId, null, { supplierId, items, status: asDraft ? 'rascunho' : 'recebida' });
  res.status(201).json({ id: purchaseId });
});

router.post('/:id/receive', requirePermission('commercial.purchases.create'), (req, res) => {
  const id = Number(req.params.id);
  const purchase = purchaseRepository.findByIdWithColumns(id, 'id, status') as { id: number; status: string } | undefined;
  if (!purchase) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  if (purchase.status !== 'rascunho') {
    res.status(400).json({ error: 'Só rascunhos podem ser recebidos.' });
    return;
  }
  const items = purchaseItemRepository.listByPurchaseRaw(id);
  if (!items.length) {
    res.status(400).json({ error: 'Adicione ao menos um item antes de receber.' });
    return;
  }

  let error: string | null = null;
  try {
    purchaseRepository.transaction(() => {
      postPurchaseItems(req, id, items);
      purchaseRepository.receive(id);
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    res.status(400).json({ error });
    return;
  }
  audit(req, 'receber', 'purchase', id, { status: 'rascunho' }, { status: 'recebida' });
  res.json({ ok: true });
});

router.post('/:id/duplicate', requirePermission('commercial.purchases.create'), (req, res) => {
  const id = Number(req.params.id);
  const source = purchaseRepository.findByIdWithColumns(id, 'id, supplier_id, notes') as
    | { id: number; supplier_id: number; notes: string | null } | undefined;
  if (!source) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  const items = purchaseItemRepository.listByPurchaseRaw(id);

  let purchaseId = 0;
  purchaseRepository.transaction(() => {
    const total = sumCents(...items.map((i) => Math.round(i.qty * i.unitCostCents)));
    purchaseId = purchaseRepository.create({
      supplier_id: source.supplier_id,
      status: 'rascunho',
      total_cents: total,
      notes: source.notes,
      received_at: null,
      uuid: randomUUID(),
    });
    for (const item of items) {
      purchaseItemRepository.create({ purchase_id: purchaseId, product_id: item.productId, qty: item.qty, unit_cost_cents: item.unitCostCents });
    }
  });
  const created = purchaseRepository.rawOne(
    `SELECT pu.id, pu.supplier_id, s.name AS supplier, pu.status, pu.total_cents, pu.notes, pu.received_at, pu.updated_at
     FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id WHERE pu.id = ?`,
    purchaseId,
  );
  audit(req, 'criar', 'purchase', purchaseId, null, { duplicatedFrom: id });
  res.status(201).json(created);
});

router.put('/:id', requirePermission('commercial.purchases.edit'), validateBody(updatePurchaseSchema), (req, res) => {
  const id = String(req.params.id);
  const before = purchaseRepository.findByIdWithColumns(id, 'id, supplier_id, status, notes') as
    | { id: number; supplier_id: number; status: string; notes: string | null } | undefined;
  if (!before) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  if (before.status === 'cancelada') {
    res.status(400).json({ error: 'Compra cancelada não pode ser editada.' });
    return;
  }
  const { supplierId, notes, items } = req.body;
  if (Array.isArray(items) && before.status !== 'rascunho') {
    res.status(400).json({ error: 'Só rascunhos podem ter os itens editados — compras recebidas já geraram estoque/custo.' });
    return;
  }
  if (supplierId != null) {
    const supplier = supplierRepository.findById(supplierId);
    if (!supplier) {
      res.status(400).json({ error: 'Fornecedor inexistente.' });
      return;
    }
  }
  purchaseRepository.update(id, { supplier_id: supplierId ?? null, notes: notes ?? null } as Record<string, unknown>);
  if (Array.isArray(items) && items.length) replacePurchaseItems(Number(id), items);
  const after = purchaseRepository.rawOne('SELECT id, supplier_id, status, notes, total_cents FROM purchases WHERE id = ?', id);
  audit(req, 'editar', 'purchase', id, before, after);
  res.json(after);
});

router.post('/:id/cancel', requirePermission('commercial.purchases.cancel'), (req, res) => {
  const id = Number(req.params.id);
  const purchase = purchaseRepository.findByIdWithColumns(id, 'id, status') as { id: number; status: string } | undefined;
  if (!purchase) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  if (purchase.status === 'cancelada') {
    res.status(400).json({ error: 'Compra já está cancelada.' });
    return;
  }

  let error: string | null = null;
  try {
    purchaseRepository.transaction(() => {
      if (purchase.status === 'recebida') {
        const items = purchaseItemRepository.listProductQtys(id);
        for (const item of items) {
          const move = moveStockRaw(req, item.product_id, 'saida', item.qty, 'cancelamento de compra', 'purchase', id, true);
          if (!move.ok) throw new Error(move.error);
        }
      }
      purchaseRepository.cancel(id);
    });
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
