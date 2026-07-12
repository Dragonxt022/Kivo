import { Router, type Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { audit } from '../../core/audit/service';
import { openComanda, addItem, voidItem, transfer, split, merge, closeComanda, cancelComanda } from './comandas';
import { makeCrudRouter } from '../commercial/crud';

const router = Router();
const db = () => getSqlite();

// ─── Mesas (CRUD via fabrica, com suporte a sort_order) ───
router.use('/tables', requireCapability('comandas.mesas'), makeCrudRouter({
  table: 'store_tables', entity: 'table', permPrefix: 'comandas.tables',
  fields: ['label', 'sort_order'], required: ['label'],
}));

// ─── Status da mesa (GET avulso para o grid) ───
router.get('/tables/status', requireCapability('comandas.mesas'), requirePermission('comandas.view'), (_req, res) => {
  const tables = db().prepare('SELECT * FROM store_tables WHERE deleted_at IS NULL ORDER BY sort_order, label').all();
  res.json(tables);
});

// ─── Comandas CRUD ───
router.get('/comandas', requireCapability('comandas.mesas'), requirePermission('comandas.view'), (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  let sql = `SELECT c.*, t.label AS table_label
    FROM comandas c
    LEFT JOIN store_tables t ON t.id = c.table_id
    WHERE c.deleted_at IS NULL`;
  const params: any[] = [];
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  sql += ' ORDER BY c.id DESC';
  res.json(db().prepare(sql).all(...params));
});

router.get('/comandas/:id', requireCapability('comandas.mesas'), requirePermission('comandas.view'), (req, res) => {
  const id = Number(req.params.id);
  const comanda = db().prepare(
    `SELECT c.*, t.label AS table_label
     FROM comandas c
     LEFT JOIN store_tables t ON t.id = c.table_id
     WHERE c.id = ? AND c.deleted_at IS NULL`,
  ).get(id);
  if (!comanda) { res.status(404).json({ error: 'Comanda nao encontrada.' }); return; }
  const items = db().prepare(
    "SELECT * FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL ORDER BY id",
  ).all(id);
  res.json({ ...comanda, items });
});

router.post('/comandas', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const { tableId, customerId, notes } = req.body ?? {};
  const result = openComanda(req, { tableId, customerId, notes });
  if (!result.ok) { res.status(400).json(result); return; }
  res.status(201).json(result);
});

router.post('/comandas/:id/items', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const { productId, qty, notes, lineGroupUuid } = req.body ?? {};
  if (!productId || !qty) { res.status(400).json({ error: 'productId e qty obrigatorios.' }); return; }
  const result = addItem(req, comandaId, { productId, qty, notes, lineGroupUuid });
  if (!result.ok) { res.status(400).json(result); return; }
  res.status(201).json(result);
});

router.delete('/comandas/:id/items/:itemId', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const result = voidItem(req, comandaId, itemId);
  if (!result.ok) { res.status(400).json(result); return; }
  res.json({ ok: true });
});

router.post('/comandas/:id/transfer', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const { tableId } = req.body ?? {};
  if (!tableId) { res.status(400).json({ error: 'tableId obrigatorio.' }); return; }
  const result = transfer(req, comandaId, tableId);
  if (!result.ok) { res.status(400).json(result); return; }
  res.json({ ok: true });
});

router.post('/comandas/:id/split', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const { itemIds } = req.body ?? {};
  if (!itemIds?.length) { res.status(400).json({ error: 'itemIds obrigatorio.' }); return; }
  const result = split(req, comandaId, itemIds);
  if (!result.ok) { res.status(400).json(result); return; }
  res.json(result);
});

router.post('/comandas/:id/merge', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const { sourceComandaId } = req.body ?? {};
  if (!sourceComandaId) { res.status(400).json({ error: 'sourceComandaId obrigatorio.' }); return; }
  const result = merge(req, comandaId, sourceComandaId);
  if (!result.ok) { res.status(400).json(result); return; }
  res.json({ ok: true });
});

router.post('/comandas/:id/close', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const { payments, discountCents, surchargeCents, customerId } = req.body ?? {};
  if (!payments?.length) { res.status(400).json({ error: 'payments obrigatorio.' }); return; }
  const result = closeComanda(req, comandaId, { payments, discountCents, surchargeCents, customerId });
  if (!result.ok) { res.status(400).json(result); return; }
  res.json(result);
});

router.post('/comandas/:id/cancel', requireCapability('comandas.mesas'), requirePermission('comandas.manage'), (req, res) => {
  const comandaId = Number(req.params.id);
  const result = cancelComanda(req, comandaId);
  if (!result.ok) { res.status(400).json(result); return; }
  res.json({ ok: true });
});

export default router;
