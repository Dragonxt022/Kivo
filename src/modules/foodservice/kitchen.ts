import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { broadcastReadyAlert } from '../../core/ready-alerts/events';
import { findReadyAlert } from '../../core/ready-alerts/service';
import { getService, hasService } from '../../core/services/registry';
import { kitchenRoutingRepository, kitchenTicketRepository, kitchenTicketItemRepository } from './repositories/KitchenRepository';

/** O que a cozinha precisa do módulo de comandas ao cancelar um pedido. */
interface ComandasItemsService {
  voidItemsForKitchen: (req: Request, itemIds: number[]) => { ok: true; voided: number };
}

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
export type KitchenServiceType = 'local' | 'viagem' | 'entrega';

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
  /** Cliente no local, item embalado para viagem. */
  paraViagem?: boolean;
}

/**
 * Item de pedido do marketplace (Mais Delivery): vem como texto da própria API,
 * sem produto do catálogo. Sem estação/tempo estimado — a cozinha vê o cardápio
 * do marketplace exatamente como o cliente pediu.
 */
export interface NotifyDeliveryItem {
  name: string;
  qty: number;
  notes?: string;
  complements?: string[];
}

/**
 * Módulos que precisam reagir quando um ticket de delivery muda de etapa (ex.: o
 * Mais Delivery atualiza a situação lá no marketplace quando a cozinha marca
 * "pronto"). Registrado via service registry — a cozinha não importa módulo de
 * integração (mesma separação que `comandas.items`).
 */
interface DeliveryStatusService {
  onTicketStatusChange: (
    req: Request,
    sourceId: number,
    ticketStatus: KitchenActionableStatus,
  ) => Promise<void> | void;
}

/**
 * Propaga a etapa do ticket de delivery para o módulo de origem (fire-and-forget:
 * o KDS não pode travar porque a API do marketplace falhou; o erro fica na auditoria).
 */
function syncDeliveryStatus(
  req: Request,
  ticket: { source_type: string; source_id: number },
  newStatus: KitchenActionableStatus,
): void {
  if (ticket.source_type !== 'delivery' || !hasService('maisdelivery.kitchen')) return;
  // source_id negativo = pedido de teste (sandbox): não existe no marketplace.
  if (ticket.source_id <= 0) return;
  void Promise.resolve()
    .then(() => getService<DeliveryStatusService>('maisdelivery.kitchen').onTicketStatusChange(req, ticket.source_id, newStatus))
    .catch((error) => {
      audit(req, 'sincronizar_status_delivery', 'maisdelivery_order', ticket.source_id, null, {
        ticketStatus: newStatus,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
      service_type: params.serviceType === 'viagem'
        ? 'viagem'
        : params.serviceType === 'entrega' ? 'entrega' : 'local',
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
        para_viagem: item.paraViagem ? 1 : 0,
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

/**
 * Pedido do marketplace (Mais Delivery) virando produção: um ticket com os itens
 * TEXTUAIS do pedido (sem produto do catálogo, sem estação/tempo). Diferente de
 * `notifyOrder`, NADA é filtrado por roteamento — o marketplace define a fila, o
 * roteamento é do menu do marketplace. Duplicidade é responsabilidade de quem
 * chama (`hasOpenDeliveryTickets` — idempotência no clique).
 */
export function notifyDeliveryOrder(
  req: Request,
  params: {
    sourceId: number;
    tableLabel?: string;
    serviceType?: KitchenServiceType;
    items: NotifyDeliveryItem[];
  },
): { items: number; maxEstimatedMinutes: number | null } {
  const valid = params.items.filter((item) => item.name.trim() && item.qty > 0);
  if (!valid.length) return { items: 0, maxEstimatedMinutes: null };
  const ticketUuid = randomUUID();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  kitchenTicketRepository.transaction(() => {
    kitchenTicketRepository.create({
      source_type: 'delivery',
      source_id: params.sourceId,
      table_label: params.tableLabel ?? null,
      service_type: params.serviceType === 'viagem'
        ? 'viagem'
        : params.serviceType === 'entrega' ? 'entrega' : 'local',
      status: 'pendente',
      uuid: ticketUuid,
      updated_at: now,
      origin_machine: req.headers['x-machine'] ?? null,
    });
    const ticketId = (kitchenTicketRepository.rawOne('SELECT id FROM kitchen_tickets WHERE uuid = ?', ticketUuid) as { id: number }).id;
    for (const item of valid) {
      kitchenTicketItemRepository.create({
        ticket_id: ticketId,
        product_id: null,
        product_name: item.name.trim(),
        qty: item.qty,
        notes: item.notes ?? null,
        complements: item.complements?.length ? item.complements.join(', ') : null,
        para_viagem: 0,
        station: null,
        estimated_minutes: null,
        status: 'pendente',
        uuid: randomUUID(),
        updated_at: now,
        origin_machine: req.headers['x-machine'] ?? null,
        comanda_item_id: null,
      });
    }
    audit(req, 'criar_ticket_cozinha_delivery', 'kitchen_ticket', ticketId, null, {
      sourceId: params.sourceId, marketplace: 'maisdelivery',
      items: valid.map((i) => ({ name: i.name, qty: i.qty })),
    });
  });
  return { items: valid.length, maxEstimatedMinutes: null };
}

/** Pedidos do marketplace que JÁ têm ticket de cozinha em aberto (idempotência do botão). */
export function hasOpenDeliveryTickets(orderIds: number[]): number[] {
  const ids = orderIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = kitchenTicketRepository.raw(
    `SELECT DISTINCT source_id FROM kitchen_tickets
      WHERE source_type = 'delivery' AND deleted_at IS NULL
        AND status IN ('pendente','preparo','pronto')
        AND source_id IN (${placeholders})`,
    ...ids,
  ) as { source_id: number }[];
  return rows.map((r) => Number(r.source_id));
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
  const ticket = kitchenTicketRepository.findById(ticketId) as
    { status: string; source_type?: string; source_id?: number } | undefined;
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
  // Marketplace na fila: a etapa que subiu aqui muda a situação do pedido lá fora
  // (ex.: "pronto" do KDS vira "saída pra entrega" no Mais Delivery).
  if (ticket.status !== newStatus && !goingBack && ticket.source_type && ticket.source_id != null) {
    syncDeliveryStatus(req, { source_type: ticket.source_type, source_id: ticket.source_id }, newStatus);
  }
  return { ok: true };
}

/**
 * Cancela todos os tickets ainda em aberto de uma venda/comanda cancelada.
 * Best-effort pelos chamadores (PDV/mesas não podem falhar porque a cozinha falhou),
 * mas cada mudança é auditada. Tickets já 'entregue' ficam como estão — o que foi
 * servido foi servido; 'cancelado' idem (idempotente).
 */
export function cancelTicketsForSource(req: Request, sourceType: 'sale' | 'comanda' | 'delivery', sourceId: number): void {
  const tickets = kitchenTicketRepository.raw(
    `SELECT id, status FROM kitchen_tickets
     WHERE source_type = ? AND source_id = ? AND deleted_at IS NULL AND status IN ('pendente','preparo','pronto')`,
    sourceType, sourceId,
  ) as { id: number; status: string }[];
  for (const t of tickets) {
    kitchenTicketRepository.updateStatus(t.id, 'cancelado');
    const motivo = sourceType === 'sale' ? `venda #${sourceId} cancelada`
      : sourceType === 'delivery' ? `pedido #${sourceId} cancelado no marketplace`
      : `comanda #${sourceId} cancelada`;
    audit(req, 'cancelar_ticket_cozinha', 'kitchen_ticket', t.id, { status: t.status }, { motivo });
  }
}

/**
 * Cozinha cancelando um pedido que já recebeu (item em falta, pedido errado, cliente
 * desistiu). O ticket sai do KDS e, quando veio de uma comanda, os itens também são
 * anulados para o caixa não cobrar o que não vai ser produzido.
 *
 * Pedido já entregue (ou parcialmente entregue) não é cancelado por aqui: o que saiu
 * para a mesa não pode sumir da conta silenciosamente. O garçom resolve item a item.
 */
export function cancelTicket(
  req: Request,
  ticketId: number,
  reason?: string | null,
): { ok: true; voidedComandaItems: number } | { ok: false; error: string } {
  const ticket = kitchenTicketRepository.findById(ticketId) as
    { id: number; status: string; source_type: string } | undefined;
  if (!ticket) return { ok: false, error: 'Ticket nao encontrado.' };
  if (ticket.status === 'cancelado') return { ok: false, error: 'Pedido ja foi cancelado.' };
  if (ticket.status === 'entregue') return { ok: false, error: 'Pedido ja foi entregue.' };

  const delivered = kitchenTicketItemRepository.rawOne(
    "SELECT id FROM kitchen_ticket_items WHERE ticket_id = ? AND deleted_at IS NULL AND status = 'entregue' LIMIT 1",
    ticketId,
  ) as { id: number } | undefined;
  if (delivered) {
    return { ok: false, error: 'Parte do pedido ja foi entregue. Cancele apenas os itens pendentes.' };
  }

  const links = kitchenTicketItemRepository.raw(
    `SELECT DISTINCT comanda_item_id FROM kitchen_ticket_items
      WHERE ticket_id = ? AND deleted_at IS NULL AND comanda_item_id IS NOT NULL`,
    ticketId,
  ) as { comanda_item_id: number }[];
  const comandaItemIds = links.map((l) => Number(l.comanda_item_id));

  let voided = 0;
  try {
    // Mesmo banco: a transação cobre o ticket e os itens da comanda. Se a anulação
    // falhar, o pedido continua na cozinha em vez de sumir pela metade.
    kitchenTicketRepository.transaction(() => {
      kitchenTicketRepository.updateStatus(ticketId, 'cancelado');
      kitchenTicketRepository.acknowledge(ticketId);
      if (ticket.source_type === 'comanda' && comandaItemIds.length && hasService('comandas.items')) {
        const comandas = getService<ComandasItemsService>('comandas.items');
        voided = comandas.voidItemsForKitchen(req, comandaItemIds).voided;
      }
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Nao foi possivel cancelar o pedido.' };
  }

  const cleanReason = reason && String(reason).trim()
    ? String(reason).trim().slice(0, 200)
    : 'Cancelado pela cozinha';
  audit(req, 'cancelar_ticket_cozinha', 'kitchen_ticket', ticketId, { status: ticket.status }, {
    motivo: cleanReason, itensComandaAnulados: voided,
  });
  return { ok: true, voidedComandaItems: voided };
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
          service_type: ticket.service_type === 'entrega'
            ? 'entrega'
            : ticket.service_type === 'viagem' ? 'viagem' : 'local',
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
  const ticket = kitchenTicketRepository.rawOne('SELECT status, source_type, source_id FROM kitchen_tickets WHERE id = ?', ticketId) as
    { status: string; source_type?: string; source_id?: number } | undefined;
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
    // Recalc por item também eleva a etapa real do pedido (ex.: último item ficou
    // pronto) — a sincronia com o marketplace segue a mesma regra do avanço manual.
    if (
      rank(ticketStatus) > rank(ticket.status as KitchenActionableStatus) &&
      ticket.source_type && ticket.source_id != null
    ) {
      syncDeliveryStatus(req, { source_type: ticket.source_type, source_id: ticket.source_id }, ticketStatus as KitchenActionableStatus);
    }
  }
}
