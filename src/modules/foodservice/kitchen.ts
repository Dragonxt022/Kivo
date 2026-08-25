import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { kitchenRoutingRepository, kitchenTicketRepository, kitchenTicketItemRepository } from './repositories/KitchenRepository';

/**
 * Status do TICKET inclui 'cancelado': venda/comanda cancelada não pode deixar o
 * pedido eternamente pendente na cozinha. Itens não têm 'cancelado' — quando o
 * ticket é cancelado eles ficam como estão e somem junto (a UI não lista ticket
 * cancelado); quando um ITEM é anulado (item da comanda estornado antes de ir pra
 * produção) ele é removido e o ticket é reavaliado/cancelado.
 */
export const KITCHEN_TICKET_STATUSES = ['pendente', 'preparo', 'pronto', 'entregue', 'cancelado'] as const;
export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];

/** Status avançável pela UI/API da cozinha — 'cancelado' não é setado por ela. */
export const KITCHEN_ACTIONABLE_STATUSES = ['pendente', 'preparo', 'pronto', 'entregue'] as const;
export type KitchenActionableStatus = (typeof KITCHEN_ACTIONABLE_STATUSES)[number];

export interface NotifyOrderItem {
  productId: number;
  name: string;
  qty: number;
  notes?: string;
  /**
   * Item de origem em `comanda_items` (só quando sourceType='comanda'). Permite ao
   * voidItem da comanda localizar e remover o item correspondente na cozinha.
   */
  comandaItemId?: number;
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
        comanda_item_id: item.comandaItemId ?? null,
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

export function getItemsForTickets(ticketIds: number[]): unknown[] {
  return kitchenTicketItemRepository.listByTickets(ticketIds) as unknown[];
}

export function advanceItemStatus(req: Request, ticketId: number, itemId: number, newStatus: KitchenActionableStatus): { ok: true } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as { status: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  if (ticket.status === 'cancelado') return { ok: false, error: 'Ticket cancelado.' };
  const item = kitchenTicketItemRepository.findInTicket(itemId, ticketId) as { id: number; status: string } | undefined;
  if (!item) return { ok: false, error: 'Item nao encontrado.' };
  kitchenTicketItemRepository.updateItemStatus(itemId, newStatus);
  audit(req, 'avancar_item_cozinha', 'kitchen_ticket_item', itemId, { status: item.status }, { status: newStatus });
  recalcTicketStatus(req, ticketId);
  return { ok: true };
}

export function advanceTicketStatus(req: Request, ticketId: number, newStatus: KitchenActionableStatus): { ok: true } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as { status: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  if (ticket.status === 'cancelado') return { ok: false, error: 'Ticket cancelado.' };
  kitchenTicketRepository.updateStatus(ticketId, newStatus);
  // Propaga para os itens que ainda não terminaram: sem isso o recalc (que roda no
  // próximo avanço de item) recalcula pelos itens antigos e REVERTE o status que a
  // cozinha acabou de definir no ticket inteiro — ticket "entregue" voltava a aparecer
  // como "em preparo".
  kitchenTicketItemRepository.advanceOpenItems(ticketId, newStatus);
  audit(req, 'avancar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: newStatus });
  return { ok: true };
}

/**
 * Cancela todos os tickets ainda em aberto de uma venda/comanda cancelada.
 * Best-effort pelos chamadores (PDV/mesas não podem falhar porque a cozinha falhou),
 * mas cada mudança é auditada. Tickets já 'entregue' ficam como estão — o que foi
 * servido foi servido; 'cancelado' idem (idempotente).
 */
export function cancelTicketsForSource(req: Request, sourceType: 'sale' | 'comanda', sourceId: number): void {
  const tickets = kitchenTicketRepository.raw(
    `SELECT id, status FROM kitchen_tickets
     WHERE source_type = ? AND source_id = ? AND deleted_at IS NULL AND status IN ('pendente','preparo','pronto')`,
    sourceType, sourceId,
  ) as { id: number; status: string }[];
  for (const t of tickets) {
    kitchenTicketRepository.updateStatus(t.id, 'cancelado');
    audit(req, 'cancelar_ticket_cozinha', 'kitchen_ticket', t.id, { status: t.status }, { motivo: `${sourceType === 'sale' ? 'venda' : 'comanda'} #${sourceId} cancelada` });
  }
}

/**
 * Item da comanda foi anulado: remove o item correspondente do ticket se ele ainda
 * não entrou em produção ('pendente'). Se o ticket ficar sem nenhum item ativo,
 * o próprio ticket é cancelado via recalc.
 */
export function voidComandaItem(req: Request, comandaItemId: number): void {
  const link = kitchenTicketItemRepository.rawOne(
    'SELECT id, ticket_id, status FROM kitchen_ticket_items WHERE comanda_item_id = ? AND deleted_at IS NULL',
    comandaItemId,
  ) as { id: number; ticket_id: number; status: string } | undefined;
  // Sem vínculo (ticket criado antes da migração / venda direta) ou já em preparo:
  // o que saiu pra produção não desaparece da tela da cozinha silenciosamente.
  if (!link || link.status !== 'pendente') return;
  kitchenTicketItemRepository.softDelete(link.id);
  audit(req, 'anular_item_cozinha', 'kitchen_ticket_item', link.id, null, { comandaItemId });
  recalcTicketStatus(req, link.ticket_id);
}

function recalcTicketStatus(req: Request, ticketId: number): void {
  const ticket = kitchenTicketRepository.rawOne('SELECT status FROM kitchen_tickets WHERE id = ?', ticketId) as { status: string } | undefined;
  // Estados finais não rebaixam: um ticket entregue não volta a "em preparo" porque
  // alguém avançou um item esquecido depois; e cancelado só sai de lá por decisão explícita.
  if (!ticket || ticket.status === 'entregue' || ticket.status === 'cancelado') return;
  const rows = kitchenTicketItemRepository.distinctStatusesByTicket(ticketId) as { status: string }[];
  let ticketStatus: KitchenTicketStatus;
  if (!rows.length) {
    // Todos os itens anulados: não há mais nada para produzir neste ticket.
    ticketStatus = 'cancelado';
  } else {
    const statuses = new Set(rows.map((r) => r.status));
    if (statuses.size === 1 && statuses.has('entregue')) ticketStatus = 'entregue';
    else if (statuses.size === 1 && statuses.has('pronto')) ticketStatus = 'pronto';
    else if (statuses.has('preparo') || statuses.has('pronto') || statuses.has('entregue')) ticketStatus = 'preparo';
    else ticketStatus = 'pendente';
  }
  if (ticket.status !== ticketStatus) {
    kitchenTicketRepository.updateStatus(ticketId, ticketStatus);
    audit(req, 'reavaliar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: ticketStatus });
  }
}
