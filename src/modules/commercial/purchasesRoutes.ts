import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { validateBody } from '../../shared/validateBody';
import { createPurchaseSchema, updatePurchaseSchema } from '../../shared/schemas';
import { moveStockRaw } from './stock';
import { createPurchaseInbound, postPurchaseItems } from './purchaseInbound';
import { purchaseRepository, purchaseItemRepository } from './repositories/PurchaseRepository';
import { supplierRepository } from './repositories/SupplierRepository';

const router = Router();

/**
 * Custo médio e postagem de entrada/estoque vivem em `purchaseInbound.ts` (usados
 * também pela importação de NF-e) — a rota de compra só delega para ele.
 */
function replacePurchaseItems(
  purchaseId: number,
  items: { productId: number; qty: number; unitCostCents: number; lot?: { code: string; expiresAt?: string | null } | null }[],
): number {
  purchaseItemRepository.deleteByPurchase(purchaseId);
  const total = sumCents(...items.map((i) => Math.round(i.qty * i.unitCostCents)));
  for (const item of items) {
    purchaseItemRepository.create({
      purchase_id: purchaseId, product_id: item.productId, qty: item.qty,
      unit_cost_cents: Math.round(item.unitCostCents),
      lot_code: item.lot?.code ?? null, lot_expires_at: item.lot?.expiresAt ?? null,
    });
  }
  purchaseRepository.updateTotal(purchaseId, total);
  return total;
}

router.get('/', requirePermission('commercial.purchases.view'), (_req, res) => {
  res.json(purchaseRepository.listAll());
});

router.get('/:id/items', requirePermission('commercial.purchases.view'), (req, res) => {
  res.json(purchaseItemRepository.listByPurchase(Number(req.params.id)));
});

router.get('/products/:id/last-price', requirePermission('commercial.purchases.view'), (req, res) => {
  const cents = purchaseItemRepository.lastUnitCostByProduct(Number(req.params.id));
  res.json({ unitCostCents: cents });
});

router.post('/', requirePermission('commercial.purchases.create'), validateBody(createPurchaseSchema), (req, res) => {
  const { supplierId, items, notes, status, paymentMethodId, installmentCount, firstDueDate, lateFeeCents, dailyInterestBps } = req.body;
  const asDraft = status === 'rascunho';
  const supplier = supplierRepository.findById(supplierId);
  if (!supplier) {
    res.status(400).json({ error: 'Fornecedor inexistente.' });
    return;
  }

  let purchaseId: number;
  try {
    // Cria a compra e (se recebida) posta estoque/custo — ver purchaseInbound.ts.
    purchaseId = createPurchaseInbound(req, {
      supplierId,
      items,
      notes: notes ?? null,
      status: asDraft ? 'rascunho' : 'recebida',
      paymentMethodId,
      installmentCount,
      firstDueDate,
      lateFeeCents,
      dailyInterestBps,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
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
  const rows = purchaseItemRepository.listByPurchaseRaw(id);
  if (!rows.length) {
    res.status(400).json({ error: 'Adicione ao menos um item antes de receber.' });
    return;
  }
  const items = rows.map((i) => ({
    productId: i.productId, qty: i.qty, unitCostCents: i.unitCostCents,
    lot: i.lotCode ? { code: i.lotCode, expiresAt: i.lotExpiresAt } : null,
  }));

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
  const source = purchaseRepository.findByIdWithColumns(id, 'id, supplier_id, notes, payment_method_id, installment_count, first_due_date, late_fee_cents, daily_interest_bps') as
    | { id: number; supplier_id: number; notes: string | null; payment_method_id: number | null; installment_count: number; first_due_date: string | null; late_fee_cents: number; daily_interest_bps: number } | undefined;
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
      payment_method_id: source.payment_method_id,
      installment_count: source.installment_count,
      first_due_date: source.first_due_date,
      late_fee_cents: source.late_fee_cents,
      daily_interest_bps: source.daily_interest_bps,
    });
    for (const item of items) {
      purchaseItemRepository.create({
        purchase_id: purchaseId, product_id: item.productId, qty: item.qty, unit_cost_cents: item.unitCostCents,
        lot_code: item.lotCode ?? null, lot_expires_at: item.lotExpiresAt ?? null,
      });
    }
  });
  const created = purchaseRepository.rawOne(
    `SELECT pu.id, pu.supplier_id, s.name AS supplier, pu.status, pu.total_cents, pu.notes, pu.received_at, pu.updated_at,
            pu.payment_method_id, pu.installment_count, pu.first_due_date,
            pu.late_fee_cents, pu.daily_interest_bps,
            pm.name AS payment_method_name
     FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN payment_methods pm ON pm.id = pu.payment_method_id WHERE pu.id = ?`,
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
          // Reverte o ESTOQUE, mas não o custo: média móvel não tem volta confiável.
          // Desfazer a média exigiria que nada tivesse acontecido desde a compra, e
          // pode ter havido vendas no meio — a "des-média" produziria um número
          // inventado. Cancelar uma compra recebida deixa o custo médio como está;
          // para corrigir de fato, lance um ajuste de custo no produto.
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
