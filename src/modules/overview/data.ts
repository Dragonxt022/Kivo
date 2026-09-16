import { getSqlite } from '../../core/database/connection';
import { getService } from '../../core/services/registry';
import type { FinanceCashService } from '../finance/setup';

/**
 * Consultas do Painel. Tudo leitura: agrega produtos/estoque, caixas e contas que os
 * outros módulos gravaram. O caixa atual vem pelo serviço do Core (`finance.cash`), para
 * não reimplementar a regra de "caixa aberto/valor esperado" que vive no módulo finance.
 */

export interface DueInfo {
  openCount: number;
  openCents: number;
  overdueCount: number;
  overdueCents: number;
  dueSoonCount: number;
  dueSoonCents: number;
}

export interface SalesTotals {
  count: number;
  totalCents: number;
}

export interface OverviewKpis {
  cash: { open: boolean; registerId: number | null; openedAt: string | null; expectedCents: number };
  salesToday: SalesTotals;
  salesYesterday: SalesTotals;
  salesMonth: SalesTotals;
  salesPrevMonth: SalesTotals;
  stock: { lowCount: number; zeroCount: number };
  receivables: DueInfo;
  payables: DueInfo;
}

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Vendas concluídas no intervalo [from, to] (datas locais YYYY-MM-DD). */
function salesRange(from: string, to: string): SalesTotals {
  const row = getSqlite()
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents
       FROM sales WHERE status = 'concluida' AND deleted_at IS NULL
         AND date(created_at, 'localtime') BETWEEN ? AND ?`,
    )
    .get(from, to) as { count: number; total_cents: number };
  return { count: row.count, totalCents: row.total_cents };
}

/** Contas em aberto (status 'aberta') de payables/receivables, com vencidas e a vencer em 7 dias. */
function dueInfo(table: 'payables' | 'receivables'): DueInfo {
  const row = getSqlite()
    .prepare(
      `SELECT
         COUNT(*) AS open_count,
         COALESCE(SUM(amount_cents), 0) AS open_cents,
         SUM(CASE WHEN due_date < date('now', 'localtime') THEN 1 ELSE 0 END) AS overdue_count,
         COALESCE(SUM(CASE WHEN due_date < date('now', 'localtime') THEN amount_cents END), 0) AS overdue_cents,
         SUM(CASE WHEN due_date >= date('now', 'localtime') AND due_date <= date('now', 'localtime', '+7 day') THEN 1 ELSE 0 END) AS soon_count,
         COALESCE(SUM(CASE WHEN due_date >= date('now', 'localtime') AND due_date <= date('now', 'localtime', '+7 day') THEN amount_cents END), 0) AS soon_cents
       FROM ${table} WHERE status = 'aberta' AND deleted_at IS NULL`,
    )
    .get() as {
    open_count: number;
    open_cents: number;
    overdue_count: number;
    overdue_cents: number;
    soon_count: number;
    soon_cents: number;
  };
  return {
    openCount: row.open_count,
    openCents: row.open_cents,
    overdueCount: row.overdue_count,
    overdueCents: row.overdue_cents,
    dueSoonCount: row.soon_count,
    dueSoonCents: row.soon_cents,
  };
}

export function overviewKpis(): OverviewKpis {
  // Caixa atual via serviço do Core. Se o módulo finance não estiver disponível por algum
  // motivo, o painel não pode quebrar — devolve "sem caixa aberto".
  let cash: OverviewKpis['cash'] = { open: false, registerId: null, openedAt: null, expectedCents: 0 };
  try {
    const svc = getService<FinanceCashService>('finance.cash');
    const reg = svc.currentRegister();
    if (reg) {
      cash = { open: true, registerId: reg.id, openedAt: reg.opened_at, expectedCents: svc.expectedCents(reg.id) };
    }
  } catch {
    // sem serviço de caixa: mantém o padrão
  }

  // Vendas: hoje x ontem (para a tendência) e mês corrente x mês anterior.
  const now = new Date();
  const today = localYmd(now);
  const yesterday = localYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const monthStart = localYmd(new Date(now.getFullYear(), now.getMonth(), 1));
  const prevMonthStart = localYmd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const prevMonthEnd = localYmd(new Date(now.getFullYear(), now.getMonth(), 0));

  const stock = getSqlite()
    .prepare(
      `SELECT
         SUM(CASE WHEN stock_qty <= min_stock THEN 1 ELSE 0 END) AS low_count,
         SUM(CASE WHEN stock_qty <= 0 THEN 1 ELSE 0 END) AS zero_count
       FROM products WHERE deleted_at IS NULL AND track_stock = 1 AND active = 1`,
    )
    .get() as { low_count: number | null; zero_count: number | null };

  return {
    cash,
    salesToday: salesRange(today, today),
    salesYesterday: salesRange(yesterday, yesterday),
    salesMonth: salesRange(monthStart, today),
    salesPrevMonth: salesRange(prevMonthStart, prevMonthEnd),
    stock: { lowCount: stock.low_count ?? 0, zeroCount: stock.zero_count ?? 0 },
    receivables: dueInfo('receivables'),
    payables: dueInfo('payables'),
  };
}

export type StockFilter = 'all' | 'low' | 'zero';

export function isStockFilter(v: unknown): v is StockFilter {
  return v === 'all' || v === 'low' || v === 'zero';
}

export interface StockRow {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  stock_qty: number;
  min_stock: number;
  cost_cents: number;
  price_cents: number;
}

/** `low` = no mínimo ou abaixo (precisa repor, inclui zerados); `zero` = sem saldo. */
export function stockReport(filter: StockFilter): StockRow[] {
  const where =
    filter === 'zero' ? 'AND stock_qty <= 0' : filter === 'low' ? 'AND stock_qty <= min_stock' : '';
  return getSqlite()
    .prepare(
      `SELECT id, name, sku, barcode, unit, stock_qty, min_stock, cost_cents, price_cents
       FROM products WHERE deleted_at IS NULL AND track_stock = 1 AND active = 1 ${where}
       ORDER BY (stock_qty <= 0) DESC, stock_qty ASC, name`,
    )
    .all() as StockRow[];
}

export interface CashReportRow {
  id: number;
  status: string;
  opened_at: string;
  closed_at: string | null;
  opening_cents: number;
  expected_cents: number | null;
  counted_cents: number | null;
  difference_cents: number | null;
  entradas: number;
  saidas: number;
  vendas: number;
  vendas_cents: number;
}

export function cashReport(from: string, to: string): CashReportRow[] {
  return getSqlite()
    .prepare(
      `SELECT r.id, r.status, r.opened_at, r.closed_at, r.opening_cents, r.expected_cents,
              r.counted_cents, r.difference_cents,
              (SELECT COALESCE(SUM(CASE WHEN m.direction = 'entrada' THEN m.amount_cents END), 0)
                 FROM cash_movements m WHERE m.register_id = r.id) AS entradas,
              (SELECT COALESCE(SUM(CASE WHEN m.direction = 'saida' THEN m.amount_cents END), 0)
                 FROM cash_movements m WHERE m.register_id = r.id) AS saidas,
              (SELECT COUNT(*) FROM sales s
                WHERE s.cash_register_id = r.id AND s.status = 'concluida' AND s.deleted_at IS NULL) AS vendas,
              (SELECT COALESCE(SUM(s.total_cents), 0) FROM sales s
                WHERE s.cash_register_id = r.id AND s.status = 'concluida' AND s.deleted_at IS NULL) AS vendas_cents
       FROM cash_registers r
       WHERE r.deleted_at IS NULL AND date(r.opened_at, 'localtime') BETWEEN ? AND ?
       ORDER BY r.opened_at DESC`,
    )
    .all(from, to) as CashReportRow[];
}

export interface PaymentRow {
  method: string;
  count: number;
  totalCents: number;
  feeCents: number;
}

export interface TopProductRow {
  name: string;
  qty: number;
  totalCents: number;
}

export interface SalesBreakdown {
  from: string;
  to: string;
  totals: {
    count: number;
    totalCents: number;
    discountCents: number;
    surchargeCents: number;
    feeCents: number;
    ticketCents: number;
  };
  byPayment: PaymentRow[];
  topProducts: TopProductRow[];
}

/** Vendas concluídas do período, com quebra por forma de pagamento e produtos mais vendidos. */
export function salesBreakdown(from: string, to: string): SalesBreakdown {
  const db = getSqlite();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents,
              COALESCE(SUM(discount_cents), 0) AS discount_cents,
              COALESCE(SUM(surcharge_cents), 0) AS surcharge_cents
       FROM sales WHERE status = 'concluida' AND deleted_at IS NULL
         AND date(created_at, 'localtime') BETWEEN ? AND ?`,
    )
    .get(from, to) as { count: number; total_cents: number; discount_cents: number; surcharge_cents: number };

  const fee = db
    .prepare(
      `SELECT COALESCE(SUM(p.fee_cents), 0) AS fee_cents
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'concluida' AND s.deleted_at IS NULL
         AND date(s.created_at, 'localtime') BETWEEN ? AND ?`,
    )
    .get(from, to) as { fee_cents: number };

  const byPayment = db
    .prepare(
      `SELECT p.method_name AS method, COUNT(*) AS count,
              COALESCE(SUM(p.amount_cents), 0) AS total_cents,
              COALESCE(SUM(p.fee_cents), 0) AS fee_cents
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'concluida' AND s.deleted_at IS NULL
         AND date(s.created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY p.method_name ORDER BY total_cents DESC`,
    )
    .all(from, to) as { method: string; count: number; total_cents: number; fee_cents: number }[];

  const topProducts = db
    .prepare(
      `SELECT i.product_name AS name, SUM(i.qty) AS qty, COALESCE(SUM(i.total_cents), 0) AS total_cents
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.status = 'concluida' AND s.deleted_at IS NULL
         AND date(s.created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY i.product_name ORDER BY total_cents DESC LIMIT 10`,
    )
    .all(from, to) as { name: string; qty: number; total_cents: number }[];

  return {
    from,
    to,
    totals: {
      count: totals.count,
      totalCents: totals.total_cents,
      discountCents: totals.discount_cents,
      surchargeCents: totals.surcharge_cents,
      feeCents: fee.fee_cents,
      ticketCents: totals.count > 0 ? Math.round(totals.total_cents / totals.count) : 0,
    },
    byPayment: byPayment.map((p) => ({ method: p.method, count: p.count, totalCents: p.total_cents, feeCents: p.fee_cents })),
    topProducts: topProducts.map((p) => ({ name: p.name, qty: p.qty, totalCents: p.total_cents })),
  };
}

export interface CashflowDay {
  day: string;
  entradas: number;
  saidas: number;
  saldo: number;
}

export interface CashflowReport {
  from: string;
  to: string;
  days: CashflowDay[];
  totals: { entradas: number; saidas: number; saldo: number };
}

/** Movimentações de caixa (entradas/saídas) por dia, no intervalo informado. */
export function cashflowReport(from: string, to: string): CashflowReport {
  const days = getSqlite()
    .prepare(
      `SELECT date(created_at, 'localtime') AS day,
              COALESCE(SUM(CASE WHEN direction = 'entrada' THEN amount_cents END), 0) AS entradas,
              COALESCE(SUM(CASE WHEN direction = 'saida' THEN amount_cents END), 0) AS saidas
       FROM cash_movements WHERE date(created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY date(created_at, 'localtime') ORDER BY day`,
    )
    .all(from, to) as { day: string; entradas: number; saidas: number }[];

  const totals = days.reduce(
    (acc, d) => ({ entradas: acc.entradas + d.entradas, saidas: acc.saidas + d.saidas }),
    { entradas: 0, saidas: 0 },
  );
  return {
    from,
    to,
    days: days.map((d) => ({ ...d, saldo: d.entradas - d.saidas })),
    totals: { ...totals, saldo: totals.entradas - totals.saidas },
  };
}

export interface BillRow {
  id: number;
  description: string;
  amount_cents: number;
  due_date: string;
}

export interface UpcomingBills {
  payables: BillRow[];
  receivables: BillRow[];
}

/** Contas em aberto com vencimento até `windowDays` dias (inclui as já vencidas). */
export function upcomingBills(windowDays = 7): UpcomingBills {
  const limit = new Date();
  limit.setDate(limit.getDate() + windowDays);
  const limitStr = localYmd(limit);
  const db = getSqlite();
  const query = (table: 'payables' | 'receivables'): BillRow[] =>
    db
      .prepare(
        `SELECT id, description, amount_cents, due_date FROM ${table}
         WHERE status = 'aberta' AND deleted_at IS NULL AND due_date <= ?
         ORDER BY due_date LIMIT 20`,
      )
      .all(limitStr) as BillRow[];
  return { payables: query('payables'), receivables: query('receivables') };
}
