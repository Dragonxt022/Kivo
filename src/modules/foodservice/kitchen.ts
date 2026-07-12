import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { audit } from '../../core/audit/service';

export interface NotifyOrderItem {
  productId: number;
  name: string;
  qty: number;
  notes?: string;
}

export function notifyOrder(
  req: Request,
  params: { sourceType: 'sale' | 'comanda'; sourceId: number; tableLabel?: string; items: NotifyOrderItem[] },
): void {
  const db = getSqlite();
  // Quais desses itens estao roteados para a cozinha?
  const routingRows = db
    .prepare('SELECT product_id, station, estimated_minutes FROM kitchen_routing WHERE deleted_at IS NULL')
    .all() as { product_id: number; station: string | null; estimated_minutes: number | null }[];
  if (!routingRows.length) return; // nenhum produto roteado, nada a fazer
  const routing = new Map(routingRows.map((r) => [r.product_id, r]));
  const matched = params.items.filter((i) => routing.has(i.productId));
  if (!matched.length) return;
  const r = routing.get(matched[0].productId)!;
  const ticketUuid = randomUUID();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.transaction(() => {
    db.prepare(
      `INSERT INTO kitchen_tickets (source_type, source_id, table_label, status, uuid, updated_at, origin_machine)
       VALUES (?, ?, ?, 'pendente', ?, ?, ?)`,
    ).run(params.sourceType, params.sourceId, params.tableLabel ?? null, ticketUuid, now, req.headers['x-machine'] ?? null);
    const ticketId = (db.prepare('SELECT id FROM kitchen_tickets WHERE uuid = ?').get(ticketUuid) as { id: number }).id;
    for (const item of matched) {
      const route = routing.get(item.productId)!;
      db.prepare(
        `INSERT INTO kitchen_ticket_items (ticket_id, product_id, product_name, qty, notes, station, estimated_minutes, status, uuid, updated_at, origin_machine)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)`,
      ).run(
        ticketId, item.productId, item.name, item.qty, item.notes ?? null,
        route.station, route.estimated_minutes,
        randomUUID(), now, req.headers['x-machine'] ?? null,
      );
    }
    audit(req, 'criar_ticket_cozinha', 'kitchen_ticket', ticketId, null, {
      sourceType: params.sourceType, sourceId: params.sourceId, items: matched.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty })),
    });
  })();
}

export function listTickets(statusFilter?: string[]): unknown[] {
  const db = getSqlite();
  if (statusFilter?.length) {
    const placeholders = statusFilter.map(() => '?').join(',');
    return db
      .prepare(`SELECT * FROM kitchen_tickets WHERE deleted_at IS NULL AND status IN (${placeholders}) ORDER BY updated_at DESC`)
      .all(...statusFilter);
  }
  return db.prepare('SELECT * FROM kitchen_tickets WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
}

export function getTicketItems(ticketId: number): unknown[] {
  const db = getSqlite();
  return db
    .prepare('SELECT * FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL ORDER BY id')
    .all(ticketId);
}

export function advanceItemStatus(req: Request, ticketId: number, itemId: number, newStatus: 'pendente' | 'preparo' | 'pronto' | 'entregue'): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  const item = db.prepare('SELECT id, status FROM kitchen_ticket_items WHERE id = ? AND ticket_id = ? AND deleted_at IS NULL').get(itemId, ticketId) as { id: number; status: string } | undefined;
  if (!item) return { ok: false, error: 'Item nao encontrado.' };
  db.prepare("UPDATE kitchen_ticket_items SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, itemId);
  audit(req, 'avancar_item_cozinha', 'kitchen_ticket_item', itemId, { status: item.status }, { status: newStatus });
  // Reavaliar status do ticket
  recalcTicketStatus(req, ticketId);
  return { ok: true };
}

export function advanceTicketStatus(req: Request, ticketId: number, newStatus: 'pendente' | 'preparo' | 'pronto' | 'entregue'): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  const ticket = db.prepare('SELECT id, status FROM kitchen_tickets WHERE id = ? AND deleted_at IS NULL').get(ticketId) as { id: number; status: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  db.prepare("UPDATE kitchen_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, ticketId);
  audit(req, 'avancar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: newStatus });
  return { ok: true };
}

function recalcTicketStatus(req: Request, ticketId: number): void {
  const db = getSqlite();
  const rows = db
    .prepare('SELECT DISTINCT status FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL')
    .all(ticketId) as { status: string }[];
  if (!rows.length) return;
  const statuses = new Set(rows.map((r) => r.status));
  let ticketStatus: string;
  if (statuses.size === 1 && statuses.has('entregue')) ticketStatus = 'entregue';
  else if (statuses.size === 1 && statuses.has('pronto')) ticketStatus = 'pronto';
  else if (statuses.has('preparo') || statuses.has('pronto') || statuses.has('entregue')) ticketStatus = 'preparo';
  else ticketStatus = 'pendente';
  const ticket = db.prepare('SELECT status FROM kitchen_tickets WHERE id = ?').get(ticketId) as { status: string };
  if (ticket.status !== ticketStatus) {
    db.prepare("UPDATE kitchen_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(ticketStatus, ticketId);
    audit(req, 'reavaliar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: ticketStatus });
  }
}
