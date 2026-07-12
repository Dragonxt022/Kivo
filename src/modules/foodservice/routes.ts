import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { audit } from '../../core/audit/service';
import { advanceItemStatus, advanceTicketStatus, getTicketItems, listTickets } from './kitchen';

const router = Router();
const db = () => getSqlite();

// ─── Kitchen Routing (CRUD) ───
router.get('/kitchen-routing', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), (_req, res) => {
  res.json(
    db()
      .prepare(
        `SELECT kr.*, p.name AS product_name, p.sku
         FROM kitchen_routing kr
         JOIN products p ON p.id = kr.product_id
         WHERE kr.deleted_at IS NULL
         ORDER BY p.name`,
      )
      .all(),
  );
});

router.post('/kitchen-routing', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), (req, res) => {
  const { productId, station, estimatedMinutes } = req.body ?? {};
  if (!productId) { res.status(400).json({ error: 'productId obrigatorio.' }); return; }
  const product = db().prepare('SELECT id, deleted_at FROM products WHERE id = ?').get(productId) as { id: number; deleted_at: string | null } | undefined;
  if (!product || product.deleted_at) { res.status(404).json({ error: 'Produto nao encontrado.' }); return; }
  const existing = db().prepare('SELECT id FROM kitchen_routing WHERE product_id = ? AND deleted_at IS NULL').get(productId);
  if (existing) { res.status(409).json({ error: 'Produto ja esta roteado para a cozinha.' }); return; }
  const id = db()
    .prepare(
      `INSERT INTO kitchen_routing (product_id, station, estimated_minutes, uuid, origin_machine)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(productId, station ?? null, estimatedMinutes ?? null, randomUUID(), req.headers['x-machine'] ?? null).lastInsertRowid;
  audit(req, 'criar_roteamento_cozinha', 'kitchen_routing', Number(id));
  res.status(201).json({ id });
});

router.put('/kitchen-routing/:id', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db().prepare('SELECT id FROM kitchen_routing WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) { res.status(404).json({ error: 'Roteamento nao encontrado.' }); return; }
  const { station, estimatedMinutes } = req.body ?? {};
  db()
    .prepare("UPDATE kitchen_routing SET station = ?, estimated_minutes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(station ?? null, estimatedMinutes ?? null, id);
  audit(req, 'editar_roteamento_cozinha', 'kitchen_routing', id);
  res.json({ ok: true });
});

router.delete('/kitchen-routing/:id', requireCapability('foodservice.cozinha'), requirePermission('foodservice.routing.manage'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db().prepare('SELECT id FROM kitchen_routing WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) { res.status(404).json({ error: 'Roteamento nao encontrado.' }); return; }
  db().prepare("UPDATE kitchen_routing SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
  audit(req, 'remover_roteamento_cozinha', 'kitchen_routing', id);
  res.json({ ok: true });
});

// ─── Tickets ───
router.get('/kitchen/tickets', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.view'), (req, res) => {
  const statusFilter = req.query.status ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const tickets = listTickets(statusFilter) as any[];
  // Pre-carregar itens de cada ticket
  const result = tickets.map((t) => ({ ...t, items: getTicketItems(t.id) }));
  res.json(result);
});

router.put('/kitchen/tickets/:ticketId/items/:itemId/status', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.manage'), (req, res) => {
  const ticketId = Number(req.params.ticketId);
  const itemId = Number(req.params.itemId);
  const { status } = req.body ?? {};
  if (!['pendente', 'preparo', 'pronto', 'entregue'].includes(status)) { res.status(400).json({ error: 'Status invalido.' }); return; }
  const result = advanceItemStatus(req, ticketId, itemId, status);
  if (!result.ok) { res.status(404).json(result); return; }
  res.json({ ok: true });
});

router.put('/kitchen/tickets/:id/status', requireCapability('foodservice.cozinha'), requirePermission('foodservice.kitchen.manage'), (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  if (!['pendente', 'preparo', 'pronto', 'entregue'].includes(status)) { res.status(400).json({ error: 'Status invalido.' }); return; }
  const result = advanceTicketStatus(req, id, status);
  if (!result.ok) { res.status(404).json(result); return; }
  res.json({ ok: true });
});

export default router;
