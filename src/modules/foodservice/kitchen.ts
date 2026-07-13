import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { kitchenRoutingRepository, kitchenTicketRepository, kitchenTicketItemRepository } from './repositories/KitchenRepository';

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
  const routingRows = kitchenRoutingRepository.findAllActive() as
    { product_id: number; station: string | null; estimated_minutes: number | null }[];
  if (!routingRows.length) return;
  const routing = new Map(routingRows.map((r) => [r.product_id, r]));
  const matched = params.items.filter((i) => routing.has(i.productId));
  if (!matched.length) return;
  const r = routing.get(matched[0].productId)!;
  const ticketUuid = randomUUID();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  kitchenTicketRepository.transaction(() => {
    kitchenTicketRepository.create({
      source_type: params.sourceType,
      source_id: params.sourceId,
      table_label: params.tableLabel ?? null,
      status: 'pendente',
      uuid: ticketUuid,
      updated_at: now,
      origin_machine: req.headers['x-machine'] ?? null,
    });
    const ticketId = (kitchenTicketRepository.rawOne('SELECT id FROM kitchen_tickets WHERE uuid = ?', ticketUuid) as { id: number }).id;
    for (const item of matched) {
      const route = routing.get(item.productId)!;
      kitchenTicketItemRepository.create({
        ticket_id: ticketId,
        product_id: item.productId,
        product_name: item.name,
        qty: item.qty,
        notes: item.notes ?? null,
        station: route.station,
        estimated_minutes: route.estimated_minutes,
        status: 'pendente',
        uuid: randomUUID(),
        updated_at: now,
        origin_machine: req.headers['x-machine'] ?? null,
      });
    }
    audit(req, 'criar_ticket_cozinha', 'kitchen_ticket', ticketId, null, {
      sourceType: params.sourceType, sourceId: params.sourceId, items: matched.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty })),
    });
  });
}

export function listTickets(statusFilter?: string[]): unknown[] {
  return kitchenTicketRepository.listByStatus(statusFilter) as unknown[];
}

export function getTicketItems(ticketId: number): unknown[] {
  return kitchenTicketItemRepository.listByTicket(ticketId) as unknown[];
}

export function advanceItemStatus(req: Request, ticketId: number, itemId: number, newStatus: 'pendente' | 'preparo' | 'pronto' | 'entregue'): { ok: true } | { ok: false; error: string } {
  const item = kitchenTicketItemRepository.findInTicket(itemId, ticketId) as { id: number; status: string } | undefined;
  if (!item) return { ok: false, error: 'Item nao encontrado.' };
  kitchenTicketItemRepository.updateItemStatus(itemId, newStatus);
  audit(req, 'avancar_item_cozinha', 'kitchen_ticket_item', itemId, { status: item.status }, { status: newStatus });
  recalcTicketStatus(req, ticketId);
  return { ok: true };
}

export function advanceTicketStatus(req: Request, ticketId: number, newStatus: 'pendente' | 'preparo' | 'pronto' | 'entregue'): { ok: true } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as { id: number; status: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  kitchenTicketRepository.updateStatus(ticketId, newStatus);
  audit(req, 'avancar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: newStatus });
  return { ok: true };
}

function recalcTicketStatus(req: Request, ticketId: number): void {
  const rows = kitchenTicketItemRepository.distinctStatusesByTicket(ticketId) as { status: string }[];
  if (!rows.length) return;
  const statuses = new Set(rows.map((r) => r.status));
  let ticketStatus: string;
  if (statuses.size === 1 && statuses.has('entregue')) ticketStatus = 'entregue';
  else if (statuses.size === 1 && statuses.has('pronto')) ticketStatus = 'pronto';
  else if (statuses.has('preparo') || statuses.has('pronto') || statuses.has('entregue')) ticketStatus = 'preparo';
  else ticketStatus = 'pendente';
  const ticket = kitchenTicketRepository.rawOne('SELECT status FROM kitchen_tickets WHERE id = ?', ticketId) as { status: string };
  if (ticket.status !== ticketStatus) {
    kitchenTicketRepository.updateStatus(ticketId, ticketStatus);
    audit(req, 'reavaliar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: ticketStatus });
  }
}
