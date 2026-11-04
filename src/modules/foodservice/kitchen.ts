import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { broadcastReadyAlert } from '../../core/ready-alerts/events';
import { findReadyAlert } from '../../core/ready-alerts/service';
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

/** Ordem das etapas — voltar uma etapa é permitido e usa esta régua. */
const STATUS_RANK: Record<KitchenActionableStatus, number> = {
  pendente: 0,
  preparo: 1,
  pronto: 2,
  entregue: 3,
};

function rank(status: string): number {
  return STATUS_RANK[status as KitchenActionableStatus] ?? -1;
}

/** Etapas à frente do alvo — só elas descem quando o pedido volta de etapa. */
function statusesAheadOf(status: KitchenActionableStatus): KitchenActionableStatus[] {
  return KITCHEN_ACTIONABLE_STATUSES.slice(rank(status) + 1);
}

/** Identificador do aparelho que fez a requisição (ver theme-init.ejs). */
function actorDevice(req: Request): string | null {
  const raw = req.headers['x-kivo-device'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const clean = value.trim().slice(0, 80);
  return clean || null;
}

/**
 * Anuncia no canal global que o ticket está pronto. Só emite se o status ATUAL no banco
 * já for 'pronto' — assim um recalc que não mudou nada não duplica o alerta.
 */
function announceReady(ticketId: number, req: Request): void {
  const alert = findReadyAlert(ticketId);
  if (!alert) return;
  broadcastReadyAlert({
    ...alert,
    actorUserId: req.user?.id ?? null,
    actorDevice: actorDevice(req),
  });
}

/**
 * Onde o pedido vai ser consumido. `local` é o padrão histórico (mesa/balcão) e
 * `entrega` é o delivery — o KDS troca o ícone (prato/garfo x motinha) sem depender
 * de adivinhar pelo nome da mesa ou pelo texto do pedido.
 */
export type KitchenServiceType = 'local' | 'entrega';

export interface NotifyOrderItem {
  productId: number;
  name: string;
  qty: number;
  notes?: string;
  /** Complementos do grupo (ex.: "Granola", "1x Leite condensado") para o KDS. */
  complements?: string[];
  /**
   * Item de origem em `comanda_items` (só quando sourceType='comanda'). Permite ao
   * voidItem da comanda localizar e remover o item correspondente na cozinha.
   */
  comandaItemId?: number;
}

/**
 * Cria ticket com os itens roteados para a cozinha. Devolve quantos itens geraram
 * produção e o maior tempo estimado entre eles (para o garçom poder dizer ao cliente
 * "pronto em ~X min") — produtos fora do roteamento são ignorados silenciosamente
 * (é isso que permite enviar "a comanda inteira" sem saber o que é da cozinha).
 */
export function notifyOrder(
  req: Request,
  params: {
    sourceType: 'sale' | 'comanda';
    sourceId: number;
    tableLabel?: string;
    serviceType?: KitchenServiceType;
    items: NotifyOrderItem[];
  },
): { items: number; maxEstimatedMinutes: number | null } {
  const routingRows = kitchenRoutingRepository.findAllActive() as
    { product_id: number; station: string | null; estimated_minutes: number | null }[];
  if (!routingRows.length) return { items: 0, maxEstimatedMinutes: null };
  const routing = new Map(routingRows.map((r) => [r.product_id, r]));
  const matched = params.items.filter((i) => routing.has(i.productId));
  if (!matched.length) return { items: 0, maxEstimatedMinutes: null };
  const maxEstimate = Math.max(0, ...matched.map((i) => routing.get(i.productId)?.estimated_minutes ?? 0));
  const ticketUuid = randomUUID();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  kitchenTicketRepository.transaction(() => {
    kitchenTicketRepository.create({
      source_type: params.sourceType,
      source_id: params.sourceId,
      table_label: params.tableLabel ?? null,
      service_type: params.serviceType === 'entrega' ? 'entrega' : 'local',
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
        complements: item.complements?.length ? item.complements.join(', ') : null,
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
  return { items: matched.length, maxEstimatedMinutes: maxEstimate > 0 ? maxEstimate : null };
}

export function listTickets(statusFilter?: string[]): unknown[] {
  return kitchenTicketRepository.listByStatus(statusFilter) as unknown[];
}

/** Tickets 'pronto' por comanda — a grade de mesas usa para sinalizar "pedido pronto". */
export function readyTicketCountByComanda(comandaIds: number[]): { comandaId: number; readyCount: number }[] {
  return kitchenTicketRepository.readyCountByComanda(comandaIds).map((r) => ({
    comandaId: r.comanda_id,
    readyCount: Number(r.ready_count),
  }));
}

export function getTicketItems(ticketId: number): unknown[] {
  return kitchenTicketItemRepository.listByTicket(ticketId) as unknown[];
}

export function getItemsForTickets(ticketIds: number[]): unknown[] {
  return kitchenTicketItemRepository.listByTickets(ticketIds) as unknown[];
}

/**
 * Confirma que a cozinha viu o pedido — é o que faz o alarme de novo pedido parar.
 * Idempotente: confirmar de novo (ou em outro aparelho) não muda nada. Fica no
 * servidor, e não só no navegador, para a confirmação valer para todos os painéis e
 * sobreviver a um F5 no meio do expediente.
 */
export function acknowledgeTicket(req: Request, ticketId: number): { ok: true } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as { acknowledged_at: string | null } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  if (!ticket.acknowledged_at) {
    kitchenTicketRepository.acknowledge(ticketId);
    audit(req, 'confirmar_visualizacao_ticket', 'kitchen_ticket', ticketId);
  }
  return { ok: true };
}

export function advanceItemStatus(req: Request, ticketId: number, itemId: number, newStatus: KitchenActionableStatus): { ok: true } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as { status: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  if (ticket.status === 'cancelado') return { ok: false, error: 'Ticket cancelado.' };
  const item = kitchenTicketItemRepository.findInTicket(itemId, ticketId) as { id: number; status: string } | undefined;
  if (!item) return { ok: false, error: 'Item nao encontrado.' };
  // Qualquer ação da cozinha no pedido vale como "eu vi". Sem isso o alarme de novo
  // pedido continuaria apitando mesmo depois de alguém já ter começado a preparar.
  kitchenTicketRepository.acknowledge(ticketId);
  // Voltar etapa é uma correção explícita da cozinha ("marquei pronto sem querer"), então
  // o recalc do ticket pode rebaixar — inclusive um ticket já 'entregue'.
  const goingBack = rank(newStatus) < rank(item.status);
  kitchenTicketItemRepository.updateItemStatus(itemId, newStatus);
  audit(req, 'avancar_item_cozinha', 'kitchen_ticket_item', itemId, { status: item.status }, { status: newStatus });
  recalcTicketStatus(req, ticketId, { allowDowngrade: goingBack });
  return { ok: true };
}

export function advanceTicketStatus(req: Request, ticketId: number, newStatus: KitchenActionableStatus): { ok: true } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as { status: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  if (ticket.status === 'cancelado') return { ok: false, error: 'Ticket cancelado.' };
  // Mesma regra do item: avançar o pedido confirma que a cozinha o viu.
  kitchenTicketRepository.acknowledge(ticketId);
  const goingBack = rank(newStatus) < rank(ticket.status);
  kitchenTicketRepository.updateStatus(ticketId, newStatus);
  if (goingBack) {
    // Pedido inteiro volta uma etapa: os itens que já tinham passado do alvo descem
    // junto. Itens ainda atrasados ficam onde estão — voltar o pedido não é "reiniciar".
    kitchenTicketItemRepository.revertItemsAbove(ticketId, newStatus, statusesAheadOf(newStatus));
  } else {
    // Propaga para os itens que ainda não terminaram: sem isso o recalc (que roda no
    // próximo avanço de item) recalcula pelos itens antigos e REVERTE o status que a
    // cozinha acabou de definir no ticket inteiro — ticket "entregue" voltava a aparecer
    // como "em preparo".
    kitchenTicketItemRepository.advanceOpenItems(ticketId, newStatus);
  }
  audit(req, 'avancar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, { status: newStatus });
  // O garçom/PDV precisa saber na hora — inclusive se estiver em outra página. Voltar de
  // etapa não reanuncia: o pedido já era conhecido e o aviso viraria ruído.
  if (!goingBack && newStatus === 'pronto' && ticket.status !== 'pronto') announceReady(ticketId, req);
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
 * A comanda foi dividida: os tickets da cozinha precisam seguir os itens, não a
 * comanda antiga. Sem isso, `cancelTicketsForSource` cancelava no KDS produção que
 * já tinha sido movida para outra comanda (e o card continuava com a mesa antiga).
 *
 * - Ticket inteiro movido: só reaponta `source_id` para a comanda nova.
 * - Ticket misto: cria um ticket novo para a comanda nova e move só os itens
 *   selecionados. Os status individuais são preservados e `recalcTicketStatus`
 *   reavalia o status dos dois tickets.
 */
export function moveComandaItemTickets(
  req: Request,
  params: { itemIds: number[]; toComandaId: number },
): number {
  const ids = [...new Set(params.itemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const tickets = kitchenTicketRepository.raw(
    `SELECT DISTINCT kt.id, kt.source_id, kt.service_type
       FROM kitchen_tickets kt
       JOIN kitchen_ticket_items kti ON kti.ticket_id = kt.id
      WHERE kti.comanda_item_id IN (${ph})
        AND kti.deleted_at IS NULL
        AND kt.deleted_at IS NULL`,
    ...ids,
  ) as { id: number; source_id: number; service_type: string | null }[];
  if (!tickets.length) return 0;

  const selected = new Set(ids);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let movidos = 0;

  kitchenTicketRepository.transaction(() => {
    for (const ticket of tickets) {
      const items = kitchenTicketItemRepository.raw(
        'SELECT id, comanda_item_id FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL',
        ticket.id,
      ) as { id: number; comanda_item_id: number | null }[];
      const moving = items.filter((i) => i.comanda_item_id != null && selected.has(Number(i.comanda_item_id)));
      const staying = items.filter((i) => !i.comanda_item_id || !selected.has(Number(i.comanda_item_id)));
      if (!moving.length) continue;

      if (!staying.length) {
        // Todo o ticket pertence aos itens movidos: acompanha a comanda nova.
        kitchenTicketRepository.rawRun(
          "UPDATE kitchen_tickets SET source_id = ?, table_label = NULL, updated_at = datetime('now') WHERE id = ?",
          params.toComandaId, ticket.id,
        );
      } else {
        // Ticket misto: a produção dos itens movidos ganha ticket próprio, para o
        // cancelamento de uma comanda não derrubar a outra.
        const uuid = randomUUID();
        kitchenTicketRepository.create({
          source_type: 'comanda',
          source_id: params.toComandaId,
          table_label: null,
          service_type: ticket.service_type === 'entrega' ? 'entrega' : 'local',
          status: 'pendente',
          uuid,
          updated_at: now,
          origin_machine: req.headers['x-machine'] ?? null,
        });
        const novoId = Number((kitchenTicketRepository.rawOne(
          'SELECT id FROM kitchen_tickets WHERE uuid = ?', uuid,
        ) as { id: number }).id);
        const itemIds = moving.map((i) => i.id);
        const iph = itemIds.map(() => '?').join(',');
        kitchenTicketItemRepository.rawRun(
          `UPDATE kitchen_ticket_items SET ticket_id = ?, updated_at = datetime('now') WHERE id IN (${iph})`,
          novoId, ...itemIds,
        );
        recalcTicketStatus(req, novoId);
      }

      recalcTicketStatus(req, ticket.id);
      movidos += moving.length;
      audit(req, 'mover_ticket_comanda', 'kitchen_ticket', ticket.id,
        { sourceId: ticket.source_id },
        { sourceId: params.toComandaId, itens: moving.map((i) => i.comanda_item_id) });
    }
  });

  return movidos;
}

/**
 * O PDV pode mandar itens para a cozinha ANTES de a venda existir, usando um id
 * negativo de rascunho. Quando a venda é concluída, os tickets desse rascunho passam
 * a apontar para o id real — é o que faz o cancelamento da venda cancelar a produção.
 */
export function adoptSaleDraft(draftId: number, saleId: number): number {
  const from = -Math.abs(Math.trunc(draftId));
  if (!Number.isInteger(from) || from >= 0 || !Number.isInteger(saleId) || saleId <= 0) return 0;
  const result = kitchenTicketRepository.rawRun(
    `UPDATE kitchen_tickets SET source_id = ?, updated_at = datetime('now')
      WHERE source_type = 'sale' AND source_id = ? AND deleted_at IS NULL`,
    saleId, from,
  );
  return Number(result.changes ?? 0);
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

/**
 * A observação de um item de comanda foi editada DEPOIS do envio: espelha no item do
 * ticket enquanto ele ainda está 'pendente' (não foi pra produção). Depois disso o
 * item já está na frente da cozinha — a mudança fica registrada só na comanda.
 */
export function syncItemNotes(req: Request, comandaItemId: number, notes: string | null): void {
  const link = kitchenTicketItemRepository.rawOne(
    'SELECT id, status FROM kitchen_ticket_items WHERE comanda_item_id = ? AND deleted_at IS NULL',
    comandaItemId,
  ) as { id: number; status: string } | undefined;
  if (!link || link.status !== 'pendente') return;
  kitchenTicketItemRepository.rawRun(
    "UPDATE kitchen_ticket_items SET notes = ?, updated_at = datetime('now') WHERE id = ?",
    notes, link.id,
  );
  audit(req, 'editar_obs_item_cozinha', 'kitchen_ticket_item', link.id, null, { comandaItemId, notes });
}

function recalcTicketStatus(
  req: Request,
  ticketId: number,
  opts: { allowDowngrade?: boolean } = {},
): void {
  const ticket = kitchenTicketRepository.rawOne('SELECT status FROM kitchen_tickets WHERE id = ?', ticketId) as { status: string } | undefined;
  // 'cancelado' é definitivo. 'entregue' também não rebaixa por acidente (avançar um item
  // esquecido depois da entrega não pode "reabrir" a mesa) — mas uma correção explícita da
  // cozinha, que volta a etapa de um item, manda reavaliar (`allowDowngrade`).
  if (!ticket || ticket.status === 'cancelado') return;
  if (ticket.status === 'entregue' && !opts.allowDowngrade) return;
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
    // Avançar item por item também pode fechar o ticket como pronto.
    if (ticketStatus === 'pronto' && ticket.status !== 'pronto') announceReady(ticketId, req);
  }
}
