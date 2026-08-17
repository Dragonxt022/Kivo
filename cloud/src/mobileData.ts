import { getPool } from './db';

/**
 * Leitura do que o desktop já sincronizou. A fonte é `sync_records`: cada entidade chega
 * como JSON no push (routes/sync.ts) e fica guardada por empresa. Não há banco espelho nem
 * projeção — o painel consulta o mesmo registro que o motor de sync usa.
 *
 * Consequência assumida: o painel mostra o estado do ÚLTIMO sync, não o de agora. Por isso
 * `dataFreshness` existe e a tela exibe "atualizado há X" — número velho apresentado como
 * atual seria pior do que número nenhum.
 */

export interface SyncRow<T> {
  uuid: string;
  payload: T;
  updatedAt: string;
  deletedAt: string | null;
}

function parse<T>(raw: string | T): T {
  return typeof raw === 'string' ? (JSON.parse(raw) as T) : raw;
}

/** Registros vivos de um tipo (exclui os apagados no desktop). */
export async function listEntity<T>(
  companyUuid: string,
  entityType: string,
  opts: { limit?: number; since?: string } = {},
): Promise<SyncRow<T>[]> {
  const params: unknown[] = [companyUuid, entityType];
  let where = 'company_uuid = ? AND entity_type = ? AND deleted_at IS NULL';
  if (opts.since) {
    where += ' AND updated_at >= ?';
    params.push(opts.since);
  }
  const [rows] = await getPool().query(
    `SELECT uuid, payload, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
            CASE WHEN deleted_at IS NULL THEN NULL ELSE DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s') END AS deleted_at
       FROM sync_records WHERE ${where}
      ORDER BY updated_at DESC LIMIT ?`,
    [...params, opts.limit ?? 200],
  );
  return (rows as { uuid: string; payload: string; updated_at: string; deleted_at: string | null }[]).map((r) => ({
    uuid: r.uuid,
    payload: parse<T>(r.payload),
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  }));
}

export async function findEntity<T>(companyUuid: string, entityType: string, uuid: string): Promise<SyncRow<T> | null> {
  const [rows] = await getPool().query(
    `SELECT uuid, payload, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at, deleted_at
       FROM sync_records WHERE company_uuid = ? AND entity_type = ? AND uuid = ?`,
    [companyUuid, entityType, uuid],
  );
  const r = (rows as { uuid: string; payload: string; updated_at: string; deleted_at: string | null }[])[0];
  if (!r) return null;
  return { uuid: r.uuid, payload: parse<T>(r.payload), updatedAt: r.updated_at, deletedAt: r.deleted_at };
}

/** Há quanto tempo esta empresa mandou qualquer coisa — o "atualizado há X" da tela. */
export async function dataFreshness(companyUuid: string): Promise<{ lastSyncAt: string | null; minutesAgo: number | null }> {
  const [rows] = await getPool().query(
    'SELECT MAX(server_received_at) AS last FROM sync_records WHERE company_uuid = ?',
    [companyUuid],
  );
  const last = (rows as { last: Date | string | null }[])[0]?.last ?? null;
  if (!last) return { lastSyncAt: null, minutesAgo: null };
  const ts = last instanceof Date ? last.getTime() : new Date(String(last).replace(' ', 'T') + 'Z').getTime();
  return { lastSyncAt: String(last), minutesAgo: Math.max(0, Math.round((Date.now() - ts) / 60000)) };
}

// ---------------------------------------------------------------------------
// Formas de leitura específicas
// ---------------------------------------------------------------------------

export interface SalePayload {
  status: string;
  total_cents: number;
  discount_cents: number;
  surcharge_cents: number;
  customer_name: string | null;
  payment_method: string;
  created_at: string;
  sale_items?: { product_id: string | null; qty: number; unit_price_cents: number; total_cents: number; notes?: string | null }[];
  sale_payments?: { method_name: string; amount_cents: number }[];
}

export interface ProductPayload {
  name: string;
  sku: string | null;
  barcode: string | null;
  price_cents: number;
  min_stock: number;
  track_stock: number;
  active: number;
  product_type: string;
  parent_product_id: string | null;
}

export interface StockMovementPayload {
  product_id: string | null;
  type: 'entrada' | 'saida' | 'ajuste';
  qty: number;
  created_at: string;
}

/**
 * Saldo de estoque refeito a partir do ledger.
 *
 * `products.stock_qty` está em `excludeColumns` do manifesto do commercial — o saldo é
 * derivado e nunca viaja pela rede, então ele simplesmente não existe na nuvem. Aqui é
 * refeito replicando a regra de `commercial/stock.ts`:
 *
 *   entrada → soma | saida → subtrai | **ajuste → DEFINE o saldo** (não soma).
 *
 * Um `SUM(qty)` ingênuo daria número errado em todo produto que já sofreu ajuste de
 * inventário. A ordem importa por causa do `ajuste`, daí ordenar por data de criação.
 */
export async function stockBalances(companyUuid: string): Promise<Map<string, number>> {
  const [rows] = await getPool().query(
    `SELECT payload FROM sync_records
      WHERE company_uuid = ? AND entity_type = 'commercial.stock_movements' AND deleted_at IS NULL
      ORDER BY JSON_UNQUOTE(JSON_EXTRACT(payload, '$.created_at')), id`,
    [companyUuid],
  );
  const balances = new Map<string, number>();
  for (const r of rows as { payload: string | StockMovementPayload }[]) {
    const m = parse<StockMovementPayload>(r.payload);
    if (!m.product_id) continue;
    const current = balances.get(m.product_id) ?? 0;
    const qty = Number(m.qty) || 0;
    const next = m.type === 'entrada' ? current + qty : m.type === 'saida' ? current - qty : qty;
    balances.set(m.product_id, next);
  }
  return balances;
}

export interface BillPayload {
  description: string;
  amount_cents: number;
  due_date: string;
  status: string;
  paid_cents?: number;
  /**
   * UUID do cliente, não o id local: o motor de sync converte toda coluna declarada em
   * `foreignKeys` (ver `receivables` no manifesto do finance) para o uuid do alvo antes de
   * enviar. É o que permite ligar conta a receber e cliente aqui na nuvem.
   *
   * Opcional porque conta avulsa (sem cliente) existe e chega com null.
   */
  customer_id?: string | null;
  notes?: string | null;
  received_cents?: number;
}

export interface CashRegisterPayload {
  status: string;
  opening_cents: number;
  opened_at: string;
  closed_at: string | null;
}

export interface QuotePayload {
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  /** Existe desde a migration 0057 do desktop; instalação antiga pode não ter mandado. */
  surcharge_cents?: number;
  total_cents: number;
  customer_name: string | null;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
  quote_items?: {
    product_id: string | null;
    product_name?: string | null;
    qty: number;
    unit_price_cents: number;
    total_cents?: number;
    notes?: string | null;
  }[];
}

export interface CustomerPayload {
  name: string;
  document: string | null;
  phone: string | null;
  active?: number;
  email?: string | null;
  address?: string | null;
  /** Crédito de troca e pontos — o que o cliente tem A FAVOR, ao lado do que ele deve. */
  store_credit_cents?: number;
  loyalty_points?: number;
}
