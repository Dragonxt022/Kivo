import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { comandaRepository } from './repositories/ComandaRepository';
import { storeTableRepository } from './repositories/StoreTableRepository';

/**
 * Geração de mesas em lote e histórico de ocupação.
 *
 * A tela de Mesas precisa das duas coisas sem espalhar SQL de auditoria pelo
 * controller: a geração segue a numeração já usada nos nomes (Mesa 01 → próximas
 * 2, 3, 4...) e o histórico junta as sessões de comanda com os eventos de
 * `audit_logs`, que é a única fonte de autoria/horário de abertura e fechamento
 * (a tabela `comandas` guarda só `opened_by` e o `closed_at` do fechamento).
 */

export interface GenerateTablesInput {
  base?: string;
  start?: number;
  count: number;
  pad?: number;
}

export interface GeneratedTable {
  id: number;
  label: string;
  number: number;
}

interface TableRow {
  id: number;
  label: string;
  sort_order: number | null;
}

function normalizeLabel(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Número final de um nome como "Mesa 01" para a base "Mesa" — `null` se não casar. */
function labelNumber(label: unknown, base: string): number | null {
  if (!base) return null;
  const re = new RegExp(`^\\s*${escapeRegExp(base)}\\s*0*(\\d+)\\s*$`, 'i');
  const match = re.exec(String(label ?? ''));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function generateTables(req: Request, input: GenerateTablesInput): { created: GeneratedTable[] } {
  const base = String(input.base ?? '').trim() || 'Mesa';
  const pad = Math.max(0, Math.min(6, Math.floor(Number(input.pad) || 0)));
  const count = Math.max(1, Math.min(200, Math.floor(Number(input.count) || 1)));

  const rows = storeTableRepository.raw(
    'SELECT id, label, sort_order FROM store_tables WHERE deleted_at IS NULL',
  ) as unknown as TableRow[];

  const existingNumbers = new Set<number>();
  const existingLabels = new Set<string>();
  let lastSort = -1;
  for (const row of rows) {
    existingLabels.add(normalizeLabel(row.label));
    lastSort = Math.max(lastSort, Number(row.sort_order) || 0);
    const number = labelNumber(row.label, base);
    if (number != null) existingNumbers.add(number);
  }

  const maxNumber = existingNumbers.size ? Math.max(...existingNumbers) : 0;
  let current = input.start != null ? Math.max(1, Math.floor(input.start)) : maxNumber + 1;
  let nextSort = lastSort + 1;

  const created: GeneratedTable[] = [];
  // Se o usuário mandar começar num número já usado, o laço pula os existentes e
  // continua avançando até criar a quantidade pedida. A folga cobre justamente
  // esse caso (começar em 1 com 1..100 já cadastrados, por exemplo).
  const maxAttempts = count + existingNumbers.size + 1000;
  let attempts = 0;

  storeTableRepository.transaction(() => {
    while (created.length < count && attempts < maxAttempts) {
      attempts++;
      const number = current;
      current++;
      const label = `${base} ${String(number).padStart(pad, '0')}`;
      if (existingNumbers.has(number) || existingLabels.has(normalizeLabel(label))) continue;
      const id = storeTableRepository.create({
        label,
        sort_order: nextSort++,
        uuid: randomUUID(),
        origin_machine: req.headers['x-machine'] ?? null,
      });
      created.push({ id, label, number });
      existingNumbers.add(number);
      existingLabels.add(normalizeLabel(label));
    }
  });

  audit(req, 'gerar_mesas', 'table', undefined, null, {
    base,
    pad,
    requested: count,
    created: created.map((item) => item.label),
  });

  return { created };
}

// ─────────────────────────────────────────────────────────────────────────────
// Histórico
// ─────────────────────────────────────────────────────────────────────────────

export interface TableHistoryOptions {
  tableId?: number;
  limit?: number;
}

interface SessionRow {
  comanda_id: number;
  table_id: number | null;
  table_label: string | null;
  status: string;
  opened_by: number | null;
  opened_by_name: string | null;
  sale_id: number | null;
  sale_total_cents: number | null;
  sale_user_name: string | null;
  closed_at: string | null;
  updated_at: string | null;
}

interface ItemRow {
  id: number;
  comanda_id: number;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  voided_at: string | null;
  added_by_name: string | null;
}

interface AuditRow {
  id: number;
  username: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export interface HistoryItem {
  id: number;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  total_cents: number;
  voided: boolean;
  voided_at: string | null;
  added_at: string | null;
  added_by: string | null;
  canceled_by: string | null;
}

export interface HistoryEvent {
  id: number;
  at: string;
  username: string | null;
  action: string;
  label: string;
  detail: string;
}

export interface HistorySession {
  comanda_id: number;
  table_id: number | null;
  table_label: string | null;
  status: string;
  sale_id: number | null;
  opened_at: string | null;
  opened_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  items_total_cents: number;
  voided_total_cents: number;
  total_cents: number;
  items: HistoryItem[];
  events: HistoryEvent[];
}

const ACTION_LABELS: Record<string, string> = {
  abrir_comanda: 'Abriu a comanda',
  fechar_comanda: 'Fechou a comanda',
  cancelar_comanda: 'Cancelou a comanda',
  transferir_comanda: 'Transferiu de mesa',
  enviar_cozinha: 'Enviou para a cozinha',
  comanda_pronta_pagamento: 'Pediu a conta',
  comanda_reaberta_pagamento: 'Reabriu a conta',
  dividir_comanda: 'Dividiu a comanda',
  unir_comandas: 'Uniu comandas',
  adicionar_item_comanda: 'Lançou item',
  anular_item_comanda: 'Cancelou item',
  editar_qtd_item_comanda: 'Alterou a quantidade',
  editar_obs_item_comanda: 'Alterou a observação',
};

function parseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function formatQty(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Number.isInteger(number)
    ? String(number)
    : number.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function eventDetail(
  action: string,
  item: ItemRow | undefined,
  after: Record<string, unknown>,
  before: Record<string, unknown>,
  tableLabels: Map<number, string>,
): string {
  const tableLabel = (value: unknown): string | null => {
    const id = Number(value);
    return Number.isFinite(id) && tableLabels.has(id) ? tableLabels.get(id)! : null;
  };

  switch (action) {
    case 'adicionar_item_comanda': {
      const qty = after.qty ?? item?.qty;
      const name = item?.product_name;
      return [qty != null ? `${formatQty(qty)}×` : '', name].filter(Boolean).join(' ');
    }
    case 'anular_item_comanda':
      return item ? `${formatQty(item.qty)}× ${item.product_name}` : '';
    case 'editar_qtd_item_comanda':
      return item ? `${item.product_name} → ${formatQty(after.qty ?? item.qty)}` : '';
    case 'editar_obs_item_comanda':
      return item?.product_name ?? '';
    case 'transferir_comanda': {
      const from = tableLabel(before.tableIdAntes);
      const to = tableLabel(after.tableIdDepois);
      return from || to ? `${from ?? 'Sem mesa'} → ${to ?? 'Sem mesa'}` : '';
    }
    case 'fechar_comanda':
      return after.saleId != null ? `Venda #${after.saleId}` : '';
    case 'enviar_cozinha': {
      const sent = Number(after.itensEnviados);
      if (!Number.isFinite(sent)) return '';
      return `${sent} ${sent === 1 ? 'item enviado' : 'itens enviados'}`;
    }
    case 'dividir_comanda':
      return after.destino != null ? `Nova comanda #${after.destino}` : '';
    case 'unir_comandas':
      return after.origem != null ? `Comanda #${after.origem} unida` : '';
    default:
      return '';
  }
}

export function listTableHistory(options: TableHistoryOptions = {}): { sessions: HistorySession[] } {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 50)));
  const tableId = options.tableId != null && Number.isFinite(Number(options.tableId))
    ? Math.floor(Number(options.tableId))
    : null;

  const where = ['c.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (tableId != null) {
    where.push('c.table_id = ?');
    params.push(tableId);
  }
  params.push(limit);

  // `comandas` não tem created_at: o horário de abertura vem do audit_logs. O
  // fechamento tem `closed_at`, mas a comanda cancelada só atualiza `updated_at`,
  // então o evento de cancelamento (ou o updated_at, como reserva) completa a data.
  const rows = comandaRepository.raw(
    `SELECT c.id AS comanda_id, c.table_id, c.status, c.opened_by, c.sale_id,
            c.closed_at, c.updated_at,
            t.label AS table_label,
            s.total_cents AS sale_total_cents,
            su.name AS sale_user_name,
            u.name AS opened_by_name
       FROM comandas c
       LEFT JOIN store_tables t ON t.id = c.table_id
       LEFT JOIN sales s ON s.id = c.sale_id
       LEFT JOIN users su ON su.id = s.user_id
       LEFT JOIN users u ON u.id = c.opened_by
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(c.closed_at, c.updated_at) DESC, c.id DESC
      LIMIT ?`,
    ...params,
  ) as unknown as SessionRow[];

  if (!rows.length) return { sessions: [] };

  const sessions = new Map<number, HistorySession>();
  const saleUserBySession = new Map<number, string | null>();
  const saleTotalBySession = new Map<number, number | null>();
  for (const row of rows) {
    const id = Number(row.comanda_id);
    sessions.set(id, {
      comanda_id: id,
      table_id: row.table_id != null ? Number(row.table_id) : null,
      table_label: row.table_label ?? null,
      status: String(row.status),
      sale_id: row.sale_id != null ? Number(row.sale_id) : null,
      opened_at: null,
      opened_by: row.opened_by_name ?? null,
      closed_at: row.closed_at ?? null,
      closed_by: null,
      items_total_cents: 0,
      voided_total_cents: 0,
      total_cents: 0,
      items: [],
      events: [],
    });
    saleUserBySession.set(id, row.sale_user_name ?? null);
    saleTotalBySession.set(id, row.sale_total_cents != null ? Number(row.sale_total_cents) : null);
    // Cancelada não preenche closed_at; updated_at é a última alteração e serve
    // apenas como reserva quando a auditoria daquele período já foi expurgada.
    if (row.status !== 'aberta' && !row.closed_at && row.updated_at) {
      sessions.get(id)!.closed_at = row.updated_at;
    }
  }

  const comandaIds = [...sessions.keys()];
  const itemPlaceholders = comandaIds.map(() => '?').join(',');
  const itemRows = comandaRepository.raw(
    `SELECT ci.id, ci.comanda_id, ci.product_name, ci.qty, ci.unit_price_cents,
            ci.voided_at, u.name AS added_by_name
       FROM comanda_items ci
       LEFT JOIN users u ON u.id = ci.added_by
      WHERE ci.comanda_id IN (${itemPlaceholders}) AND ci.deleted_at IS NULL
      ORDER BY ci.id`,
    ...comandaIds,
  ) as unknown as ItemRow[];

  const itemsByComanda = new Map<number, ItemRow[]>();
  const itemById = new Map<number, ItemRow>();
  for (const item of itemRows) {
    const comandaId = Number(item.comanda_id);
    if (!itemsByComanda.has(comandaId)) itemsByComanda.set(comandaId, []);
    itemsByComanda.get(comandaId)!.push(item);
    itemById.set(Number(item.id), item);
  }

  const itemIds = itemRows.map((item) => Number(item.id));
  const auditWhere: string[] = [];
  const auditParams: unknown[] = [];
  if (comandaIds.length) {
    auditWhere.push(`(entity = 'comanda' AND entity_id IN (${comandaIds.map(() => '?').join(',')}))`);
    auditParams.push(...comandaIds.map((id) => String(id)));
  }
  if (itemIds.length) {
    auditWhere.push(`(entity = 'comanda_item' AND entity_id IN (${itemIds.map(() => '?').join(',')}))`);
    auditParams.push(...itemIds.map((id) => String(id)));
  }

  const auditRows = auditWhere.length
    ? comandaRepository.raw(
      `SELECT id, username, action, entity, entity_id, before_json, after_json, created_at
         FROM audit_logs
        WHERE ${auditWhere.join(' OR ')}
        ORDER BY created_at, id`,
      ...auditParams,
    ) as unknown as AuditRow[]
    : [];

  const tableRows = storeTableRepository.raw('SELECT id, label FROM store_tables') as unknown as { id: number; label: string }[];
  const tableLabels = new Map<number, string>();
  for (const table of tableRows) tableLabels.set(Number(table.id), String(table.label));

  const addedEvents = new Map<number, AuditRow>();
  const voidedEvents = new Map<number, AuditRow>();

  for (const event of auditRows) {
    const action = String(event.action);
    let session: HistorySession | undefined;
    let item: ItemRow | undefined;

    if (event.entity === 'comanda') {
      session = sessions.get(Number(event.entity_id));
    } else if (event.entity === 'comanda_item') {
      item = itemById.get(Number(event.entity_id));
      if (item) session = sessions.get(Number(item.comanda_id));
    }
    if (!session) continue;

    const after = parseJson(event.after_json);
    const before = parseJson(event.before_json);
    const username = event.username ?? null;
    const at = String(event.created_at);

    session.events.push({
      id: Number(event.id),
      at,
      username,
      action,
      label: ACTION_LABELS[action] ?? action,
      detail: eventDetail(action, item, after, before, tableLabels),
    });

    if (action === 'abrir_comanda' && !session.opened_at) {
      session.opened_at = at;
      if (username) session.opened_by = username;
    }
    if ((action === 'fechar_comanda' || action === 'cancelar_comanda') && !session.closed_by) {
      session.closed_at = at;
      session.closed_by = username;
    }
    if (item) {
      const itemId = Number(item.id);
      if (action === 'adicionar_item_comanda' && !addedEvents.has(itemId)) addedEvents.set(itemId, event);
      if (action === 'anular_item_comanda' && !voidedEvents.has(itemId)) voidedEvents.set(itemId, event);
    }
  }

  for (const session of sessions.values()) {
    // Auditoria expurgada: o primeiro evento que sobrou ainda dá uma noção do
    // período; sem nenhum, a tela mostra "—" em vez de inventar um horário.
    if (!session.opened_at && session.events.length) session.opened_at = session.events[0].at;
    if (!session.closed_by && session.status === 'fechada') {
      session.closed_by = saleUserBySession.get(session.comanda_id) ?? null;
    }

    for (const item of itemsByComanda.get(session.comanda_id) ?? []) {
      const id = Number(item.id);
      const added = addedEvents.get(id);
      const voided = voidedEvents.get(id);
      const qty = Number(item.qty);
      const unitPrice = Number(item.unit_price_cents);
      const total = Math.round(qty * unitPrice);
      const historyItem: HistoryItem = {
        id,
        product_name: String(item.product_name),
        qty,
        unit_price_cents: unitPrice,
        total_cents: total,
        voided: !!item.voided_at,
        voided_at: item.voided_at ? String(item.voided_at) : null,
        added_at: added ? String(added.created_at) : null,
        added_by: added?.username ?? item.added_by_name ?? null,
        canceled_by: voided?.username ?? null,
      };
      session.items.push(historyItem);
      if (historyItem.voided) session.voided_total_cents += total;
      else session.items_total_cents += total;
    }
    session.total_cents = session.items_total_cents;
    // Venda fechada é a fonte do valor final (desconto/acréscimo): a soma dos itens
    // continua em `items_total_cents` para a conferência linha a linha.
    if (session.sale_id != null && session.status === 'fechada') {
      const saleTotal = saleTotalBySession.get(session.comanda_id);
      if (saleTotal != null) session.total_cents = saleTotal;
    }
  }

  return { sessions: [...sessions.values()] };
}
