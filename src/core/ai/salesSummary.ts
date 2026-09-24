import { getSqlite } from '../database/connection';
import type { SalesInsightsInput } from './service';

/**
 * Monta o resumo de vendas do período a partir do banco local (offline-first): totais, ticket
 * médio, produtos mais vendidos, formas de pagamento, faturamento por dia e o período anterior
 * (mesmo tamanho) para a IA comparar. O que sai daqui é o que vai no prompt — nada de PII.
 *
 * As datas seguem a convenção dos relatórios: `date(created_at, 'localtime')`, só vendas
 * `concluida` e não deletadas. Dinheiro em centavos.
 */

const PAYMENT_LABELS: Record<string, string> = {
  dinheiro: 'Dinheiro',
  cartao_debito: 'Cartão de débito',
  cartao_credito: 'Cartão de crédito',
  pix: 'Pix',
  prazo: 'A prazo',
};

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function normDay(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

/** Totais de um intervalo (vendas concluídas). */
function totalsFor(db: ReturnType<typeof getSqlite>, from: string, to: string): { count: number; totalCents: number } {
  const row = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents
       FROM sales
      WHERE status = 'concluida' AND deleted_at IS NULL
        AND date(created_at, 'localtime') BETWEEN ? AND ?`,
  ).get(from, to) as { count: number; total_cents: number } | undefined;
  return { count: Number(row?.count) || 0, totalCents: Number(row?.total_cents) || 0 };
}

export function buildSalesInsightsInput(fromRaw: unknown, toRaw: unknown): SalesInsightsInput {
  const db = getSqlite();
  const now = new Date();
  const from = normDay(fromRaw, ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  const to = normDay(toRaw, ymd(now));

  const totals = totalsFor(db, from, to);

  const topProducts = db.prepare(
    `SELECT i.product_name AS name, SUM(i.qty) AS qty, COALESCE(SUM(i.total_cents), 0) AS total_cents
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'concluida' AND s.deleted_at IS NULL
        AND date(s.created_at, 'localtime') BETWEEN ? AND ?
      GROUP BY i.product_name ORDER BY total_cents DESC LIMIT 15`,
  ).all(from, to) as { name: string; qty: number; total_cents: number }[];

  const byPayment = db.prepare(
    `SELECT payment_method AS method, COALESCE(SUM(total_cents), 0) AS total_cents
       FROM sales
      WHERE status = 'concluida' AND deleted_at IS NULL
        AND date(created_at, 'localtime') BETWEEN ? AND ?
      GROUP BY payment_method ORDER BY total_cents DESC`,
  ).all(from, to) as { method: string; total_cents: number }[];

  const daily = db.prepare(
    `SELECT date(created_at, 'localtime') AS day, COALESCE(SUM(total_cents), 0) AS total_cents
       FROM sales
      WHERE status = 'concluida' AND deleted_at IS NULL
        AND date(created_at, 'localtime') BETWEEN ? AND ?
      GROUP BY day ORDER BY day`,
  ).all(from, to) as { day: string; total_cents: number }[];

  // Período anterior de mesmo tamanho, para a IA comparar a tendência.
  const dayMs = 86_400_000;
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  const span = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs) + 1);
  const prev = totalsFor(db, ymd(new Date(start.getTime() - span * dayMs)), ymd(new Date(start.getTime() - dayMs)));

  return {
    from,
    to,
    salesCount: totals.count,
    totalCents: totals.totalCents,
    ticketCents: totals.count > 0 ? Math.round(totals.totalCents / totals.count) : 0,
    topProducts: topProducts.map((p) => ({ name: p.name, qty: Number(p.qty), totalCents: Number(p.total_cents) })),
    byPayment: byPayment.map((p) => ({ method: PAYMENT_LABELS[p.method] ?? p.method, totalCents: Number(p.total_cents) })),
    daily: daily.map((d) => ({ day: String(d.day), totalCents: Number(d.total_cents) })),
    previous: { totalCents: prev.totalCents, salesCount: prev.count },
  };
}
