import type { Request } from 'express';
import {
  audit,
} from '../../core/audit/service';
import { getService, hasService } from '../../core/services/registry';
import {
  changeOrderStatus,
  fetchOrder,
  fetchStatuses,
  MaisDeliveryError,
  type OrderItemSummary,
  type OrderSummary,
  type StatusOption,
} from './client';
import { getKitchenSituations, getMaisDeliveryConfig, isMaisDeliveryConfigured, saveKitchenSituations } from './settings';

/**
 * Ponte cozinha ⇆ Mais Delivery.
 *
 * O botão "Enviar p/ cozinha" da tela de pedidos cria um ticket real no KDS com os
 * itens TEXTUAIS do pedido do marketplace (sem casar com produtos do Kuruk) e já
 * atualiza a situação lá no Mais Delivery ("em preparo"). Quando a cozinha marca
 * "pronto" no KDS, a situação lá fora volta a acompanhar (`onTicketStatusChange`).
 *
 * Os ids de situação do marketplace são específicos da conta, então a ponte APRENDE
 * (heurística por nome da situação na operação 7) e guarda no `settings` — sem id
 * combinado, a mudança de status é pulada em vez de chutar.
 */

interface KitchenServiceFacade {
  /** Tickets de delivery em aberto (idempotência: pedido já na fila não re-envia). */
  hasOpenDeliveryTickets: (orderIds: number[]) => number[];
  /** Cria ticket source_type='delivery' com itens textuais. */
  notifyDeliveryOrder: (
    req: Request,
    params: {
      sourceId: number;
      tableLabel?: string;
      serviceType?: 'local' | 'viagem' | 'entrega';
      items: { name: string; qty: number; notes?: string; complements?: string[] }[];
    },
  ) => { items: number; maxEstimatedMinutes: number | null };
  /** Pedido cancelado no marketplace: ticket sai da fila da cozinha. */
  cancelTicketsForSource: (
    req: Request,
    sourceType: 'sale' | 'comanda' | 'delivery',
    sourceId: number,
  ) => void;
}

export function isKitchenAvailable(): boolean {
  return hasService('foodservice.kitchen');
}

function kitchen(): KitchenServiceFacade | null {
  return isKitchenAvailable()
    ? (getService<KitchenServiceFacade>('foodservice.kitchen'))
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heurísticas (puras, para facilitar teste)
// ─────────────────────────────────────────────────────────────────────────────

const PREPARO_PATTERN = /prepar|andament|produ|iniciad|cozinh/i;
const PRONTO_PATTERN = /pronto|finaliz|conclu/i;
const CANCELADO_PATTERN = /cancel|recus|negad/i;

/**
 * Escolhe a situação de destino entre as opções do marketplace (operação 7).
 * Exclui a situação atual do pedido (a API recusa trocar por ela mesma) e situações
 * de cancelamento. Devolve `null` quando nada casa — nesse caso NADA é enviado e
 * o usuário pode escolher manualmente no modal de detalhes.
 */
export function chooseSituation(
  statuses: StatusOption[],
  slot: 'preparo' | 'pronto',
  excludeIds: (string | number)[] = [],
): StatusOption | null {
  const pattern = slot === 'pronto' ? PRONTO_PATTERN : PREPARO_PATTERN;
  const blocked = new Set(excludeIds.map(String));
  const candidates = statuses.filter(
    (status) => status.id && !CANCELADO_PATTERN.test(status.name || ''),
  );
  const match = candidates.find((status) => pattern.test(status.name || '') && !blocked.has(String(status.id)));
  return match ?? null;
}

/**
 * A situação é "parecida com cancelar"? Usado para cancelar o ticket da cozinha
 * quando a lojista recusa/cancela o pedido direto no modal de detalhes.
 */
export function isCancelSituation(name: string): boolean {
  return CANCELADO_PATTERN.test(name || '');
}

/**
 * Quantidade do item vira número: a API do marketplace entrega `qtde` como texto.
 * Nem sempre dá para distinguir milhar de decimal fixo com 3 casas ("2.000" = dois
 * com 3 decimais; "1.234.567" = milhar). Regra determinística do repositório:
 * - comma decimal: "2,5" → 2.5; "2.000,5" → 2000.5
 * - único ponto + 3 casas: decimal fixo ("2.000" → 2; "0,500"→ via vírgula)
 * - múltiplos pontos: milhar ("1.234.567" → 1234567)
 */
function parseQty(qty: string | number | undefined | null): number {
  let raw = String(qty ?? '').trim();
  if (!raw) return 1;
  if (/,\d{1,3}$/.test(raw)) raw = raw.replace(/\./g, '').replace(',', '.');
  const dots = (raw.match(/\./g) ?? []).length;
  if (dots > 1) raw = raw.replace(/\./g, '');
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1; // lixo ou negativo: assume 1, não perde item
  if (parsed === 0) return 0; // zero explícito: sem esse item (o chamador descarta)
  return Math.min(Math.round(parsed * 1000) / 1000, 999);
}

/**
 * Itens do pedido do marketplace no formato do KDS. Sem produto do catálogo:
 * `product_id` fica NULL e a fila mostra o cardápio como o cliente pediu.
 */
export function buildKitchenItems(items: OrderItemSummary[]): { name: string; qty: number; notes?: string }[] {
  const grouped = new Map<string, { name: string; qty: number; notes?: string }>();
  for (const item of items) {
    const name = (item.name || '').trim();
    if (!name) continue;
    const qty = parseQty(item.qty);
    if (qty <= 0) continue;
    // Mesmo produto (mesmo nome e observação) somando quantidade: a cozinha vê
    // "2x X-Burguer" em vez de duas linhas iguais.
    const key = `${name}||${(item.notes || '').trim()}`;
    const existing = grouped.get(key);
    if (existing) existing.qty += qty;
    else grouped.set(key, { name, qty, notes: item.notes?.trim() || undefined });
  }
  return [...grouped.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Enviar p/ cozinha
// ─────────────────────────────────────────────────────────────────────────────

export interface SendToKitchenResult {
  sent: boolean;
  /** true quando o pedido JÁ estava na fila da cozinha (clique repetido). */
  alreadyInKitchen: boolean;
  ticketItems: number;
  ticketId: number | null;
  statusChanged: boolean;
  statusName: string | null;
  /** Obrigatório para a tela atualizar o badge do card sem recarregar a listagem. */
  statusId: number | null;
  /** Avisa (sem bloquear) quando não deu para combinar a situação do marketplace. */
  warning: string | null;
}

async function resolveSituation(
  slot: 'preparo' | 'pronto',
  excludeIds: (string | number)[] = [],
): Promise<StatusOption | null> {
  // O id guardado no `settings` é o preferido (aprendido no primeiro uso). Se ele
  // sumir da lista ou virar algo cancelável, redescobre pela heurística.
  const stored = getKitchenSituations();
  const storedId = slot === 'pronto' ? stored.pronto : stored.preparo;
  const { statuses } = await fetchStatuses();
  const byStored = storedId ? statuses.find((s) => String(s.id) === String(storedId)) ?? null : null;
  if (byStored && !CANCELADO_PATTERN.test(byStored.name || '') && !excludeIds.map(String).includes(String(byStored.id))) {
    return byStored;
  }
  const chosen = chooseSituation(statuses, slot, excludeIds);
  if (chosen) saveKitchenSituations({ [slot]: Number(chosen.id) });
  return chosen;
}

function tableLabelFor(order: OrderSummary): string {
  const customer = (order.customer || '').trim();
  return customer ? `Mais Delivery · ${customer}` : 'Mais Delivery';
}

function serviceTypeFor(order: OrderSummary): 'local' | 'viagem' | 'entrega' {
  const text = `${order.deliveryType} ${order.origin}`.toLowerCase();
  if (/retir|retire|balc|pickup|search: ?retir/.test(text)) return 'viagem';
  return 'entrega';
}

export async function sendOrderToKitchen(req: Request, orderId: number): Promise<SendToKitchenResult> {
  const kitchenService = kitchen();
  if (!kitchenService) {
    throw new MaisDeliveryError('O painel de cozinha não está disponível nesta instalação.', 400);
  }

  const already = kitchenService.hasOpenDeliveryTickets([orderId]);
  if (already.includes(orderId)) {
    return { sent: false, alreadyInKitchen: true, ticketItems: 0, ticketId: null, statusChanged: false, statusName: null, statusId: null, warning: null };
  }

  const { order } = await fetchOrder(orderId, { fresh: true });
  const items = buildKitchenItems(order.items);
  if (!items.length) {
    throw new MaisDeliveryError('Este pedido não tem itens que possam ir para a cozinha.', 400);
  }

  const created = kitchenService.notifyDeliveryOrder(req, {
    sourceId: orderId,
    tableLabel: tableLabelFor(order),
    serviceType: serviceTypeFor(order),
    items,
  });

  // Situação no marketplace: "em preparo"/grid. Se nada casar, o ticket continua
  // válido na cozinha e a lojista escolhe a situação manualmente no modal.
  audit(req, 'enviar_cozinha_maisdelivery', 'maisdelivery_order', orderId, null, {
    ticketItems: created.items,
    items: items.map((i) => ({ name: i.name, qty: i.qty })),
  });

  const result: SendToKitchenResult = {
    sent: true,
    alreadyInKitchen: false,
    ticketItems: created.items,
    ticketId: null,
    statusChanged: false,
    statusName: null,
    statusId: null,
    warning: null,
  };

  try {
    const situacao = await resolveSituation('preparo', [orderId, order.statusId]);
    if (!situacao) {
      result.warning = 'Pedido na cozinha, mas não achei a situação "em preparo" no Mais Delivery — escolha manualmente no modal de detalhes.';
      return result;
    }
    await changeOrderStatus(orderId, Number(situacao.id), 'Pedido enviado para a cozinha do Kuruk');
    result.statusChanged = true;
    result.statusName = situacao.name;
    result.statusId = Number(situacao.id);
  } catch (error) {
    result.warning = `Pedido na cozinha, mas a situação no Mais Delivery não mudou: ${error instanceof MaisDeliveryError ? error.message : 'falha de conexão'}.`;
    audit(req, 'sincronizar_status_delivery', 'maisdelivery_order', orderId, null, {
      ticketStatus: 'preparo',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pedido de teste (sandbox)
// ─────────────────────────────────────────────────────────────────────────────

/** Itens fictícios com preço — a API do marketplace não cria pedidos, o teste é local. */
const TEST_ORDER_ITEMS = [
  { name: 'X-Burger (TESTE)', qty: 1, unit: 2990 },
  { name: 'Batata frita (TESTE)', qty: 2, unit: 1290, notes: 'bem feita, sem sal na batata' },
  { name: 'Refrigerante lata (TESTE)', qty: 2, unit: 690 },
];

/**
 * Cria um pedido de teste no modo sandbox: ticket REAL de cozinha (mesma fila dos
 * pedidos de marketplace, com rótulo "TESTE") que a cozinha pode avançar de etapa
 * normalmente. Nada é enviado ao Mais Delivery — source_id negativo marca que este
 * ticket não é um pedido real do marketplace (a sincronia com lá fora o ignora).
 */
export async function createTestOrder(req: Request): Promise<{
  orderId: string;
  customer: string;
  deliveryType: string;
  origin: string;
  items: { name: string; qty: string }[];
  itemCount: number;
  totalCents: number;
  totalRaw: string;
}> {
  const kitchenService = kitchen();
  if (!kitchenService) {
    throw new MaisDeliveryError('O painel de cozinha não está disponível nesta instalação.', 400);
  }
  if (!isMaisDeliveryConfigured() || !getMaisDeliveryConfig().sandbox) {
    throw new MaisDeliveryError('Ligue o modo sandbox para criar pedidos de teste.', 400);
  }

  const sourceId = -Date.now(); // negativo = pedido de teste, nunca vai para o marketplace
  const created = kitchenService.notifyDeliveryOrder(req, {
    sourceId,
    tableLabel: 'TESTE · Sandbox',
    serviceType: 'entrega',
    items: TEST_ORDER_ITEMS.map((item) => ({ name: item.name, qty: item.qty, notes: item.notes })),
  });
  if (created.items === 0) {
    throw new MaisDeliveryError('Não foi possível gerar os itens do pedido de teste.', 400);
  }
  audit(req, 'criar_pedido_teste', 'maisdelivery_order', sourceId, null, {
    items: TEST_ORDER_ITEMS.map((i) => ({ name: i.name, qty: i.qty })),
  });

  const totalCents = TEST_ORDER_ITEMS.reduce((sum, item) => sum + item.qty * item.unit, 0);
  return {
    orderId: String(sourceId),
    customer: 'PEDIDO TESTE',
    deliveryType: 'Sandbox',
    origin: 'Kuruk (teste)',
    items: TEST_ORDER_ITEMS.map((item) => ({ name: item.name, qty: String(item.qty) })),
    itemCount: TEST_ORDER_ITEMS.length,
    totalCents,
    totalRaw: (totalCents / 100).toFixed(2).replace('.', ','),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cozinha → marketplace (gancho chamado pelo foodservice via service registry)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ticket de delivery mudou de etapa no KDS. Só reage a "pronto" (o "em preparo"
 * já foi setado no envio; "entregue" é rotina do entregador, não da cozinha).
 * Falha aqui fica na auditoria — nunca interrompe a cozinha.
 */
export async function onTicketStatusChange(req: Request, orderId: number, ticketStatus: string): Promise<void> {
  if (ticketStatus !== 'pronto' || !isMaisDeliveryConfigured()) return;
  try {
    const situacao = await resolveSituation('pronto', [orderId]);
    if (!situacao) {
      audit(req, 'sincronizar_status_delivery', 'maisdelivery_order', orderId, null, {
        ticketStatus, warning: 'Nenhuma situação "pronto" combina no marketplace.',
      });
      return;
    }
    await changeOrderStatus(orderId, Number(situacao.id), 'Pedido pronto na cozinha do Kuruk');
  } catch (error) {
    audit(req, 'sincronizar_status_delivery', 'maisdelivery_order', orderId, null, {
      ticketStatus,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
