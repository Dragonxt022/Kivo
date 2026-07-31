import { saleRepository, salePaymentRepository } from './repositories/SaleRepository';

export interface CashRegisterReport {
  totals: { vendas: number; total_cents: number; discount_cents: number; surcharge_cents: number; fee_cents: number };
  byPayment: { payment_method: string; vendas: number; total_cents: number; fee_cents: number }[];
  topProducts: { product_name: string; qty: number; total_cents: number }[];
  sales: { id: number; customer: string | null; total_cents: number; payment_method: string; created_at: string }[];
}

export function cashRegisterReport(registerId: number): CashRegisterReport {
  const byPayment = salePaymentRepository.raw(
    `SELECT p.method_name AS payment_method, COUNT(*) AS vendas,
            SUM(p.amount_cents) AS total_cents, SUM(p.fee_cents) AS fee_cents
     FROM sale_payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND s.cash_register_id = ?
     GROUP BY p.method_name ORDER BY total_cents DESC`,
    registerId,
  ) as CashRegisterReport['byPayment'];

  const totals = saleRepository.rawOne(
    `SELECT COUNT(*) AS vendas, COALESCE(SUM(total_cents), 0) AS total_cents,
            COALESCE(SUM(discount_cents), 0) AS discount_cents,
            COALESCE(SUM(surcharge_cents), 0) AS surcharge_cents,
            COALESCE((SELECT SUM(p.fee_cents) FROM sale_payments p JOIN sales s2 ON s2.id = p.sale_id
                      WHERE s2.status = 'concluida' AND s2.deleted_at IS NULL AND s2.cash_register_id = ?), 0) AS fee_cents
     FROM sales WHERE status = 'concluida' AND deleted_at IS NULL AND cash_register_id = ?`,
    registerId, registerId,
  ) as CashRegisterReport['totals'];

  const topProducts = saleRepository.raw(
    `SELECT i.product_name, SUM(i.qty) AS qty, SUM(i.total_cents) AS total_cents
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND s.cash_register_id = ?
     GROUP BY i.product_name ORDER BY total_cents DESC`,
    registerId,
  ) as CashRegisterReport['topProducts'];

  const sales = saleRepository.raw(
    `SELECT s.id, c.name AS customer, s.total_cents, s.payment_method, s.created_at
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND s.cash_register_id = ?
     ORDER BY s.id`,
    registerId,
  ) as CashRegisterReport['sales'];

  return { totals, byPayment, topProducts, sales };
}

export type RevenueTrendPeriod = 'week' | 'month' | 'year';
export interface RevenueTrendBucket { key: string; label: string; totalCents: number }
export interface RevenueTrendReport { period: RevenueTrendPeriod; buckets: RevenueTrendBucket[] }

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Limites (from/to, formato YYYY-MM-DD) de cada balde do período pedido, do mais
 * antigo pro mais recente — semana alinhada à segunda-feira, mês e ano de calendário. */
function buildBuckets(period: RevenueTrendPeriod): { key: string; label: string; from: string; to: string }[] {
  const now = new Date();
  const buckets: { key: string; label: string; from: string; to: string }[] = [];

  if (period === 'week') {
    const dayOfWeek = now.getDay(); // 0 = domingo
    const diffToMonday = (dayOfWeek + 6) % 7;
    const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
    for (let i = 7; i >= 0; i--) {
      const start = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - i * 7);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      buckets.push({ key: fmtDate(start), label: `${pad2(start.getDate())}/${pad2(start.getMonth() + 1)}`, from: fmtDate(start), to: fmtDate(end) });
    }
  } else if (period === 'year') {
    for (let i = 4; i >= 0; i--) {
      const y = now.getFullYear() - i;
      buckets.push({ key: String(y), label: String(y), from: `${y}-01-01`, to: `${y}-12-31` });
    }
  } else {
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth();
      const lastDay = new Date(y, m + 1, 0).getDate();
      buckets.push({ key: `${y}-${pad2(m + 1)}`, label: MONTH_LABELS[m], from: `${y}-${pad2(m + 1)}-01`, to: `${y}-${pad2(m + 1)}-${pad2(lastDay)}` });
    }
  }
  return buckets;
}

/** Evolução do faturamento por semana/mês/ano — soma vendas concluídas por dia no
 * intervalo total e distribui pros baldes em JS (evita depender do strftime('%W')
 * do SQLite pra numeração de semana, que não bate com semana começando na segunda). */
export function revenueTrend(period: RevenueTrendPeriod): RevenueTrendReport {
  const buckets = buildBuckets(period);
  const from = buckets[0].from;
  const to = buckets[buckets.length - 1].to;
  const rows = saleRepository.raw(
    `SELECT date(created_at) AS day, COALESCE(SUM(total_cents), 0) AS total_cents
     FROM sales WHERE status = 'concluida' AND deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?
     GROUP BY date(created_at)`,
    from, to,
  ) as { day: string; total_cents: number }[];

  return {
    period,
    buckets: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      totalCents: rows.filter((r) => r.day >= b.from && r.day <= b.to).reduce((s, r) => s + r.total_cents, 0),
    })),
  };
}
