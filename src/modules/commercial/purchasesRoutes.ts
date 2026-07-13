import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { moveStockRaw } from './stock';

const router = Router();
const db = () => getSqlite();

function replacePurchaseItems(purchaseId: number, items: { productId: number; qty: number; unitCostCents: number }[]): number {
  const database = db();
  database.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purchaseId);
  const total = sumCents(...items.map((i) => Math.round(i.qty * i.unitCostCents)));
  const insert = database.prepare(
    `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)`,
  );
  for (const item of items) insert.run(purchaseId, item.productId, item.qty, Math.round(item.unitCostCents));
  database.prepare(`UPDATE purchases SET total_cents = ?, updated_at = datetime('now') WHERE id = ?`).run(total, purchaseId);
  return total;
}

function postPurchaseItems(req: import('express').Request, purchaseId: number, items: { productId: number; qty: number; unitCostCents: number }[]): void {
  const database = db();
  for (const item of items) {
    database.prepare(`UPDATE products SET cost_cents = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(Math.round(item.unitCostCents), item.productId);
    const move = moveStockRaw(req, Number(item.productId), 'entrada', Number(item.qty), 'compra', 'purchase', purchaseId);
    if (!move.ok) throw new Error(move.error);
  }
}

router.get('/', requirePermission('commercial.purchases.view'), (_req, res) => {
  res.json(db().prepare(
    `SELECT pu.id, pu.supplier_id, s.name AS supplier, pu.status, pu.total_cents, pu.notes, pu.received_at, pu.updated_at
     FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
     WHERE pu.deleted_at IS NULL ORDER BY pu.id DESC`,
  ).all());
});

router.get('/:id/items', requirePermission('commercial.purchases.view'), (req, res) => {
  res.json(db().prepare(
    `SELECT pi.id, pi.product_id, p.name AS product_name, pi.qty, pi.unit_cost_cents
     FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?`,
  ).all(req.params.id));
});

router.post('/', requirePermission('commercial.purchases.create'), (req, res) => {
  const { supplierId, items, notes, status } = req.body ?? {};
  const asDraft = status === 'rascunho';
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
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(supplierId, asDraft ? 'rascunho' : 'recebida', total, notes ?? null, asDraft ? null : new Date().toISOString(), randomUUID());
      purchaseId = Number(info.lastInsertRowid);

      const insert = database.prepare(
        `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)`,
      );
      for (const item of items) insert.run(purchaseId, item.productId, item.qty, Math.round(item.unitCostCents));

      if (!asDraft) postPurchaseItems(req, purchaseId, items);
    })();
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
  const purchase = db().prepare('SELECT id, status FROM purchases WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; status: string } | undefined;
  if (!purchase) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  if (purchase.status !== 'rascunho') {
    res.status(400).json({ error: 'Só rascunhos podem ser recebidos.' });
    return;
  }
  const items = db().prepare('SELECT product_id AS productId, qty, unit_cost_cents AS unitCostCents FROM purchase_items WHERE purchase_id = ?')
    .all(id) as { productId: number; qty: number; unitCostCents: number }[];
  if (!items.length) {
    res.status(400).json({ error: 'Adicione ao menos um item antes de receber.' });
    return;
  }

  const database = db();
  let error: string | null = null;
  try {
    database.transaction(() => {
      postPurchaseItems(req, id, items);
      database.prepare(`UPDATE purchases SET status = 'recebida', received_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
    })();
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
  const source = db().prepare('SELECT id, supplier_id, notes FROM purchases WHERE id = ? AND deleted_at IS NULL').get(id) as
    { id: number; supplier_id: number; notes: string | null } | undefined;
  if (!source) {
    res.status(404).json({ error: 'Compra não encontrada.' });
    return;
  }
  const items = db().prepare('SELECT product_id, qty, unit_cost_cents FROM purchase_items WHERE purchase_id = ?').all(id) as
    { product_id: number; qty: number; unit_cost_cents: number }[];

  const database = db();
  let purchaseId = 0;
  database.transaction(() => {
    const total = sumCents(...items.map((i) => Math.round(i.qty * i.unit_cost_cents)));
    const info = database.prepare(
      `INSERT INTO purchases (supplier_id, status, total_cents, notes, received_at, uuid) VALUES (?, 'rascunho', ?, ?, NULL, ?)`,
    ).run(source.supplier_id, total, source.notes, randomUUID());
    purchaseId = Number(info.lastInsertRowid);
    const insert = database.prepare(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)`,
    );
    for (const item of items) insert.run(purchaseId, item.product_id, item.qty, item.unit_cost_cents);
  })();
  const created = db().prepare(
    `SELECT pu.id, pu.supplier_id, s.name AS supplier, pu.status, pu.total_cents, pu.notes, pu.received_at, pu.updated_at
     FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id WHERE pu.id = ?`,
  ).get(purchaseId);
  audit(req, 'criar', 'purchase', purchaseId, null, { duplicatedFrom: id });
  res.status(201).json(created);
});

router.put('/:id', requirePermission('commercial.purchases.edit'), (req, res) => {
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
  const { supplierId, notes, items } = req.body ?? {};
  if (Array.isArray(items) && before.status !== 'rascunho') {
    res.status(400).json({ error: 'Só rascunhos podem ter os itens editados — compras recebidas já geraram estoque/custo.' });
    return;
  }
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
  if (Array.isArray(items) && items.length) replacePurchaseItems(Number(id), items);
  const after = db().prepare('SELECT id, supplier_id, status, notes, total_cents FROM purchases WHERE id = ?').get(id);
  audit(req, 'editar', 'purchase', id, before, after);
  res.json(after);
});

router.post('/:id/cancel', requirePermission('commercial.purchases.cancel'), (req, res) => {
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

  const database = db();
  let error: string | null = null;
  try {
    database.transaction(() => {
      if (purchase.status === 'recebida') {
        const items = database.prepare('SELECT product_id, qty FROM purchase_items WHERE purchase_id = ?').all(id) as
          { product_id: number; qty: number }[];
        for (const item of items) {
          const move = moveStockRaw(req, item.product_id, 'saida', item.qty, 'cancelamento de compra', 'purchase', id, true);
          if (!move.ok) throw new Error(move.error);
        }
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
