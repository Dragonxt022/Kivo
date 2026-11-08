import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import { audit } from '../../core/audit/service';
import { hasCapability } from '../../core/capabilities/service';
import { canUseQrOrder } from '../../core/license/plans';
import { validateLicense } from '../../core/license/service';
import { cloudAuthHeaders, cloudBaseUrl } from '../../core/catalog/submissionQueue';
import { openComanda, addItem, sendToKitchen, voidItem } from './comandas';
import { comandaRepository, comandaItemRepository } from './repositories/ComandaRepository';
import { storeTableRepository } from './repositories/StoreTableRepository';
import { notifyTableEvents } from './tableEvents';

/**
 * Pedido feito pelo cliente no QR da mesa.
 *
 * O comando chega do Cloud com uuids (produto/mesa/opções) porque id local não vale
 * entre máquinas. Os itens são validados AQUI de novo (produto ativo/publicado,
 * complemento realmente ligado ao principal, mínimo/máximo do grupo) e entram na
 * comanda como PENDENTES: nada vai para a cozinha antes do garçom confirmar.
 */

export interface QrOrderItemPayload {
  productUuid?: unknown;
  qty?: unknown;
  notes?: unknown;
  takeaway?: unknown;
  unitPriceCents?: unknown;
  complements?: { productUuid?: unknown; qty?: unknown; unitPriceCents?: unknown }[] | unknown;
}

export interface QrOrderPayload {
  orderUuid?: unknown;
  tableUuid?: unknown;
  tableLabel?: unknown;
  note?: unknown;
  items?: QrOrderItemPayload[] | unknown;
}

export interface QrOrderResult {
  comandaId: number;
  comandaUuid: string | null;
  orderUuid: string;
  items: number;
  alreadyApplied: boolean;
}

type ReceiveResult = { ok: true; result: QrOrderResult } | { ok: false; error: string };

interface ResolvedLine {
  productId: number;
  qty: number;
  notes: string | null;
  takeaway: boolean;
  lineGroupUuid: string;
  unitPriceCents: number | null;
  complements: { productId: number; qty: number; unitPriceCents: number | null }[];
}

interface ProductRow {
  id: number;
  name: string;
  active: number;
  visivel_cardapio: number;
  deleted_at: string | null;
}

interface GroupRow {
  group_uuid: string;
  group_name: string;
  min_select: number;
  max_select: number | null;
  option_product_id: number | null;
}

function db() {
  return getSqlite();
}

function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function productByUuid(uuid: string): ProductRow | undefined {
  return db()
    .prepare('SELECT id, name, active, visivel_cardapio, deleted_at FROM products WHERE uuid = ?')
    .get(uuid) as ProductRow | undefined;
}

function complementGroupsFor(productId: number): GroupRow[] {
  return db()
    .prepare(
      `SELECT cg.uuid AS group_uuid, cg.name AS group_name, cg.min_select, cg.max_select,
              i.product_id AS option_product_id
         FROM product_complement_groups pcg
         JOIN complement_groups cg ON cg.id = pcg.group_id AND cg.deleted_at IS NULL
         LEFT JOIN complement_group_items i ON i.group_id = cg.id AND i.deleted_at IS NULL
        WHERE pcg.product_id = ? AND pcg.deleted_at IS NULL
        ORDER BY pcg.sort_order, cg.name, i.sort_order, i.id`,
    )
    .all(productId) as GroupRow[];
}

/** Valida tudo antes de escrever: um item inválido rejeita o pedido inteiro. */
function resolveLines(rawItems: unknown): { ok: true; lines: ResolvedLine[] } | { ok: false; error: string } {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 40) {
    return { ok: false, error: 'Pedido sem itens válidos.' };
  }
  const lines: ResolvedLine[] = [];
  for (const raw of rawItems as QrOrderItemPayload[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Item de pedido inválido.' };
    const productUuid = str(raw.productUuid, 36);
    const product = productByUuid(productUuid);
    if (!product || product.deleted_at || product.active !== 1 || product.visivel_cardapio !== 1) {
      return { ok: false, error: `O item "${productUuid}" não está mais disponível no cardápio.` };
    }
    const qty = Math.min(20, Math.max(1, Math.round(Number(raw.qty) || 1)));
    const notes = raw.notes != null ? str(raw.notes, 200) || null : null;
    const takeaway = raw.takeaway === true || raw.takeaway === 1;
    const unitPriceCents = Number.isFinite(Number(raw.unitPriceCents))
      ? Math.max(0, Math.round(Number(raw.unitPriceCents)))
      : null;

    const groups = complementGroupsFor(product.id);
    const optionsByGroup = new Map<string, Set<number>>();
    for (const g of groups) {
      if (!optionsByGroup.has(g.group_uuid)) optionsByGroup.set(g.group_uuid, new Set());
      if (g.option_product_id != null) optionsByGroup.get(g.group_uuid)!.add(Number(g.option_product_id));
    }

    const selectedByGroup = new Map<string, Set<number>>();
    const complements: { productId: number; qty: number; unitPriceCents: number | null }[] = [];
    const compInputs = Array.isArray(raw.complements) ? raw.complements : [];
    if (compInputs.length > 20) return { ok: false, error: 'Complementos demais em um item.' };
    for (const c of compInputs as { productUuid?: unknown; qty?: unknown; unitPriceCents?: unknown }[]) {
      const compUuid = str(c?.productUuid, 36);
      const comp = productByUuid(compUuid);
      if (!comp || comp.deleted_at || comp.active !== 1) {
        return { ok: false, error: `Um adicional de "${product.name}" não está mais disponível.` };
      }
      const group = groups.find((g) => optionsByGroup.get(g.group_uuid)?.has(comp.id));
      if (!group) {
        return { ok: false, error: `O adicional "${comp.name}" não pertence mais a "${product.name}".` };
      }
      if (!selectedByGroup.has(group.group_uuid)) selectedByGroup.set(group.group_uuid, new Set());
      selectedByGroup.get(group.group_uuid)!.add(comp.id);
      complements.push({
        productId: comp.id,
        qty: Math.min(10, Math.max(1, Math.round(Number(c?.qty) || 1))),
        unitPriceCents: Number.isFinite(Number(c?.unitPriceCents))
          ? Math.max(0, Math.round(Number(c?.unitPriceCents)))
          : null,
      });
    }
    for (const group of groups) {
      const count = selectedByGroup.get(group.group_uuid)?.size ?? 0;
      if (group.min_select > 0 && count < group.min_select) {
        return { ok: false, error: `Escolha ao menos ${group.min_select} opção(ões) em "${group.group_name}" (${product.name}).` };
      }
      if (group.max_select != null && count > group.max_select) {
        return { ok: false, error: `Escolha no máximo ${group.max_select} opção(ões) em "${group.group_name}" (${product.name}).` };
      }
    }

    lines.push({
      productId: product.id,
      qty,
      notes,
      takeaway,
      lineGroupUuid: randomUUID(),
      unitPriceCents,
      complements,
    });
  }
  return { ok: true, lines };
}

/**
 * Aplica o pedido vindo do Cloud. Idempotente por `order_uuid`: reaplicar devolve o
 * mesmo resultado sem duplicar itens (o ack da fila pode ser reenviado).
 */
export function receiveQrOrder(req: Request, payload: QrOrderPayload): ReceiveResult {
  if (!hasCapability('comandas.pedido_qr') || !canUseQrOrder(validateLicense().plan)) {
    return { ok: false, error: 'O pedido pela mesa via QR está desligado nesta instalação.' };
  }
  const orderUuid = str(payload.orderUuid, 36);
  const tableUuid = str(payload.tableUuid, 36);
  if (!orderUuid || !tableUuid) return { ok: false, error: 'Pedido sem orderUuid/tableUuid.' };

  const existing = db()
    .prepare('SELECT id, comanda_id FROM qr_orders WHERE order_uuid = ? AND deleted_at IS NULL')
    .get(orderUuid) as { id: number; comanda_id: number } | undefined;
  if (existing) {
    const comanda = comandaRepository.rawOne('SELECT uuid FROM comandas WHERE id = ?', existing.comanda_id) as
      { uuid: string } | undefined;
    return {
      ok: true,
      result: {
        comandaId: existing.comanda_id,
        comandaUuid: comanda?.uuid ?? null,
        orderUuid,
        items: 0,
        alreadyApplied: true,
      },
    };
  }

  const table = storeTableRepository.rawOne(
    'SELECT id, label FROM store_tables WHERE uuid = ? AND deleted_at IS NULL',
    tableUuid,
  ) as { id: number; label: string } | undefined;
  if (!table) return { ok: false, error: 'A mesa deste QR não existe mais neste computador.' };

  const resolved = resolveLines(payload.items);
  if (!resolved.ok) return resolved;

  const autoOpen = settingsRepository.getBool('pedido_qr.abrir_mesa_auto', true);
  let comandaId: number;
  let createdComanda = false;
  const open = comandaRepository.findOpenByTable(table.id) as { id: number } | undefined;
  if (open) {
    comandaId = Number(open.id);
  } else {
    if (!autoOpen) {
      return { ok: false, error: 'A mesa não está aberta. Peça ao atendente para liberar a mesa.' };
    }
    const opened = openComanda(req, { tableId: table.id });
    if (!opened.ok) return { ok: false, error: opened.error };
    comandaId = opened.id;
    createdComanda = true;
  }

  let orderId = 0;
  let added = 0;
  const orderNote = payload.note != null ? str(payload.note, 500) || null : null;
  if (orderNote) {
    // Observação geral do pedido: a comanda tem um campo próprio (o cabeçalho da tela
    // e o cupom mostram). Várias rodadas no mesmo QR são concatenadas.
    const current = comandaRepository.rawOne('SELECT notes FROM comandas WHERE id = ?', comandaId) as
      { notes: string | null } | undefined;
    const merged = [current?.notes, orderNote].filter(Boolean).join(' | ').slice(0, 1000) || null;
    comandaRepository.rawRun(
      "UPDATE comandas SET notes = ?, updated_at = datetime('now') WHERE id = ?",
      merged, comandaId,
    );
  }
  try {
    comandaRepository.transaction(() => {
      const info = db()
        .prepare(
          `INSERT INTO qr_orders (order_uuid, comanda_id, status, uuid, origin_machine)
           VALUES (?, ?, 'pendente', ?, ?)`,
        )
        .run(orderUuid, comandaId, randomUUID(), req.headers['x-machine'] ?? null);
      orderId = Number(info.lastInsertRowid);

      for (const line of resolved.lines) {
        const main = addItem(req, comandaId, {
          productId: line.productId,
          qty: line.qty,
          notes: line.notes ?? undefined,
          lineGroupUuid: line.lineGroupUuid,
          paraViagem: line.takeaway,
          origem: 'cliente_qr',
          qrOrderId: orderId,
          unitPriceCents: line.unitPriceCents,
        });
        if (!main.ok) throw new Error(main.error);
        added++;
        for (const comp of line.complements) {
          const extra = addItem(req, comandaId, {
            productId: comp.productId,
            qty: comp.qty,
            lineGroupUuid: line.lineGroupUuid,
            paraViagem: line.takeaway,
            origem: 'cliente_qr',
            qrOrderId: orderId,
            unitPriceCents: comp.unitPriceCents,
          });
          if (!extra.ok) throw new Error(extra.error);
          added++;
        }
      }
    });
  } catch (e) {
    // Comanda recém-aberta por este pedido não pode ficar ocupando a mesa à toa.
    if (createdComanda) {
      try {
        comandaRepository.cancel(comandaId);
        storeTableRepository.free(table.id);
      } catch { /* melhor esforço */ }
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Falha ao aplicar o pedido.' };
  }

  const comanda = comandaRepository.rawOne('SELECT uuid FROM comandas WHERE id = ?', comandaId) as
    { uuid: string } | undefined;
  audit(req, 'receber_pedido_qr', 'comanda', comandaId, null, {
    orderUuid, table: table.label, itens: added,
  });
  notifyTableEvents();
  return {
    ok: true,
    result: { comandaId, comandaUuid: comanda?.uuid ?? null, orderUuid, items: added, alreadyApplied: false },
  };
}

async function notifyCloudStatus(req: Request, orderUuid: string, status: 'confirmado' | 'recusado', reason?: string | null): Promise<void> {
  const base = cloudBaseUrl();
  const auth = cloudAuthHeaders();
  if (!base || !auth) return;
  try {
    await fetch(`${base}/api/menu/orders/${encodeURIComponent(orderUuid)}/status`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason: reason ?? null }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // O status do celular fica em "aguardando"; a operação local já valeu.
  }
}

interface QrOrderRow { id: number; order_uuid: string }

function pendingOrders(comandaId: number, orderUuid?: string): QrOrderRow[] {
  const params: unknown[] = [comandaId];
  let where = "comanda_id = ? AND status = 'pendente' AND deleted_at IS NULL";
  if (orderUuid) { where += ' AND order_uuid = ?'; params.push(orderUuid); }
  return comandaRepository.raw(
    `SELECT id, order_uuid FROM qr_orders WHERE ${where} ORDER BY id`,
    ...params,
  ) as unknown as QrOrderRow[];
}

/**
 * Garçom confirmou: marca a rodada e envia SÓ os itens dela para a cozinha.
 * Se o envio falhar, volta a rodada para pendente (o garçom tenta de novo).
 */
export function confirmQrOrders(
  req: Request,
  comandaId: number,
  orderUuid?: string,
): { ok: true; sent: number; orders: number } | { ok: false; error: string } {
  const comanda = comandaRepository.findOpen(comandaId);
  if (!comanda) return { ok: false, error: 'Comanda não encontrada.' };
  const orders = pendingOrders(comandaId, orderUuid);
  if (!orders.length) return { ok: false, error: 'Nenhum pedido do cliente aguardando confirmação.' };

  let sent = 0;
  let confirmed = 0;
  for (const order of orders) {
    const items = comandaItemRepository.raw(
      `SELECT id, para_viagem AS paraViagem FROM comanda_items
        WHERE comanda_id = ? AND qr_order_id = ? AND deleted_at IS NULL AND voided_at IS NULL
        ORDER BY id`,
      comandaId, order.id,
    ) as { id: number; paraViagem: number }[];
    if (!items.length) {
      // O garçom anulou tudo antes de confirmar: fecha a rodada sem mandar nada.
      comandaRepository.rawRun(
        "UPDATE qr_orders SET status = 'confirmado', confirmed_at = datetime('now'), confirmed_by = ?, updated_at = datetime('now') WHERE id = ?",
        req.user?.id ?? null, order.id,
      );
      confirmed++;
      continue;
    }
    const allTakeaway = items.every((i) => Number(i.paraViagem) === 1);
    comandaRepository.rawRun(
      "UPDATE qr_orders SET status = 'confirmado', confirmed_at = datetime('now'), confirmed_by = ?, updated_at = datetime('now') WHERE id = ?",
      req.user?.id ?? null, order.id,
    );
    const result = sendToKitchen(req, comandaId, allTakeaway ? 'viagem' : 'local', items.map((i) => i.id));
    if (!result.ok) {
      comandaRepository.rawRun(
        "UPDATE qr_orders SET status = 'pendente', confirmed_at = NULL, confirmed_by = NULL, updated_at = datetime('now') WHERE id = ?",
        order.id,
      );
      return { ok: false, error: result.error };
    }
    sent += result.sent;
    confirmed++;
    void notifyCloudStatus(req, order.order_uuid, 'confirmado');
  }

  audit(req, 'confirmar_pedido_qr', 'comanda', comandaId, null, { orders: confirmed, itensEnviados: sent });
  notifyTableEvents();
  return { ok: true, sent, orders: confirmed };
}

/** Garçom recusou (criança/brincadeira, item em falta): anula a rodada e avisa o celular. */
export function rejectQrOrders(
  req: Request,
  comandaId: number,
  orderUuid: string | undefined,
  reason?: string | null,
): { ok: true; orders: number } | { ok: false; error: string } {
  const comanda = comandaRepository.findOpen(comandaId);
  if (!comanda) return { ok: false, error: 'Comanda não encontrada.' };
  const orders = pendingOrders(comandaId, orderUuid);
  if (!orders.length) return { ok: false, error: 'Nenhum pedido do cliente aguardando confirmação.' };
  const cleanReason = reason ? str(reason, 255) : 'Pedido não confirmado pelo atendente.';

  for (const order of orders) {
    const items = comandaItemRepository.raw(
      'SELECT id FROM comanda_items WHERE comanda_id = ? AND qr_order_id = ? AND deleted_at IS NULL AND voided_at IS NULL',
      comandaId, order.id,
    ) as { id: number }[];
    for (const item of items) voidItem(req, comandaId, item.id);
    comandaRepository.rawRun(
      `UPDATE qr_orders SET status = 'recusado', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      cleanReason, order.id,
    );
    void notifyCloudStatus(req, order.order_uuid, 'recusado', cleanReason);
  }

  // Sem nenhum item ativo, a comanda (possivelmente aberta pelo próprio QR) não pode
  // continuar segurando a mesa.
  if (!comandaItemRepository.listActiveByComanda(comandaId).length) {
    comandaRepository.cancel(comandaId);
    const row = comandaRepository.rawOne('SELECT table_id FROM comandas WHERE id = ?', comandaId) as
      { table_id: number | null } | undefined;
    if (row?.table_id) storeTableRepository.free(row.table_id);
  }

  audit(req, 'recusar_pedido_qr', 'comanda', comandaId, null, { orders: orders.length, motivo: cleanReason });
  notifyTableEvents();
  return { ok: true, orders: orders.length };
}

/** Marca/desmarca "viagem" no item e em todo o grupo (principal + adicionais). */
export function setItemTakeaway(
  req: Request,
  comandaId: number,
  itemId: number,
  paraViagem: boolean,
): { ok: true } | { ok: false; error: string } {
  const comanda = comandaRepository.findOpen(comandaId);
  if (!comanda) return { ok: false, error: 'Comanda não encontrada.' };
  const item = comandaItemRepository.findInComanda(itemId, comandaId) as
    { id: number; voided_at: string | null; line_group_uuid: string | null } | undefined;
  if (!item) return { ok: false, error: 'Item não encontrado.' };
  if (item.voided_at) return { ok: false, error: 'Item já foi anulado.' };
  if (item.line_group_uuid) {
    comandaItemRepository.rawRun(
      "UPDATE comanda_items SET para_viagem = ?, updated_at = datetime('now') WHERE comanda_id = ? AND line_group_uuid = ? AND deleted_at IS NULL",
      paraViagem ? 1 : 0, comandaId, item.line_group_uuid,
    );
  } else {
    comandaItemRepository.rawRun(
      "UPDATE comanda_items SET para_viagem = ?, updated_at = datetime('now') WHERE id = ?",
      paraViagem ? 1 : 0, itemId,
    );
  }
  audit(req, 'editar_viagem_item_comanda', 'comanda_item', itemId, null, { paraViagem });
  notifyTableEvents();
  return { ok: true };
}
