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

export interface OverviewKpis {
  cash: { open: boolean; registerId: number | null; openedAt: string | null; expectedCents: number };
  salesToday: { count: number; totalCents: number };
  stock: { lowCount: number; zeroCount: number };
  receivables: DueInfo;
  payables: DueInfo;
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

  const sales = getSqlite()
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents
       FROM sales WHERE status = 'concluida' AND deleted_at IS NULL
         AND date(created_at, 'localtime') = date('now', 'localtime')`,
    )
    .get() as { count: number; total_cents: number };

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
    salesToday: { count: sales.count, totalCents: sales.total_cents },
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
