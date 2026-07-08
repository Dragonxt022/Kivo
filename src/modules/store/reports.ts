import { getSqlite } from '../../core/database/connection';

export interface CashRegisterReport {
  totals: { vendas: number; total_cents: number; discount_cents: number; surcharge_cents: number; fee_cents: number };
  byPayment: { payment_method: string; vendas: number; total_cents: number; fee_cents: number }[];
  topProducts: { product_name: string; qty: number; total_cents: number }[];
  sales: { id: number; customer: string | null; total_cents: number; payment_method: string; created_at: string }[];
}

/** Relatório completo de vendas de um caixa (usado pelo fechamento de caixa do finance). */
export function cashRegisterReport(registerId: number): CashRegisterReport {
  const db = getSqlite();

  const byPayment = db.prepare(
    `SELECT p.method_name AS payment_method, COUNT(*) AS vendas,
            SUM(p.amount_cents) AS total_cents, SUM(p.fee_cents) AS fee_cents
     FROM sale_payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND s.cash_register_id = ?
     GROUP BY p.method_name ORDER BY total_cents DESC`,
  ).all(registerId) as CashRegisterReport['byPayment'];

  const totals = db.prepare(
    `SELECT COUNT(*) AS vendas, COALESCE(SUM(total_cents), 0) AS total_cents,
            COALESCE(SUM(discount_cents), 0) AS discount_cents,
            COALESCE(SUM(surcharge_cents), 0) AS surcharge_cents,
            COALESCE((SELECT SUM(p.fee_cents) FROM sale_payments p JOIN sales s2 ON s2.id = p.sale_id
                      WHERE s2.status = 'concluida' AND s2.deleted_at IS NULL AND s2.cash_register_id = ?), 0) AS fee_cents
     FROM sales WHERE status = 'concluida' AND deleted_at IS NULL AND cash_register_id = ?`,
  ).get(registerId, registerId) as CashRegisterReport['totals'];

  const topProducts = db.prepare(
    `SELECT i.product_name, SUM(i.qty) AS qty, SUM(i.total_cents) AS total_cents
     FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND s.cash_register_id = ?
     GROUP BY i.product_name ORDER BY total_cents DESC`,
  ).all(registerId) as CashRegisterReport['topProducts'];

  const sales = db.prepare(
    `SELECT s.id, c.name AS customer, s.total_cents, s.payment_method, s.created_at
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND s.cash_register_id = ?
     ORDER BY s.id`,
  ).all(registerId) as CashRegisterReport['sales'];

  return { totals, byPayment, topProducts, sales };
}
