import type { Request, Response } from 'express';
import { getService } from '../../../core/services/registry';
import { audit } from '../../../core/audit/service';
import type { FinancePayMethodsService } from '../../finance/setup';
import { createSale, cancelSale, returnSale, soldLines, returnedQtyByProduct } from '../sales';
import { createQuote, convertQuote, cancelQuote, updateQuote } from '../quotes';
import { cashRegisterReport, revenueTrend, type RevenueTrendPeriod } from '../reports';
import { toCsv } from '../../commercial/productsImport';
import { saleRepository, salePaymentRepository } from '../repositories/SaleRepository';
import { quoteRepository } from '../repositories/QuoteRepository';

/**
 * Preço cotado só vale como override para quem já pode dar desconto. Sem essa trava,
 * cotar um produto por R$ 0,01 e converter o orçamento seria um jeito de contornar
 * store.sales.discount — a conversão honra o preço do orçamento por desenho.
 * Para o operador comum o unitPriceCents enviado pelo PDV é ignorado e o preço é
 * re-resolvido pelo pricing service, que é de onde ele veio.
 */
function canOverridePrice(req: Request): boolean {
  return req.user?.permissions.has('store.sales.discount') ?? false;
}

/** Filtros da listagem/exportação de vendas, montados a partir da query string. */
function buildSalesWhere(req: Request): { whereSql: string; params: unknown[] } {
  const where: string[] = ['s.deleted_at IS NULL'];
  const params: unknown[] = [];
  const day = String(req.query.day ?? '').trim();
  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();
  const status = String(req.query.status ?? '').trim();
  const paymentMethod = String(req.query.paymentMethod ?? '').trim();
  const customerId = Number(req.query.customerId);
  const userId = Number(req.query.userId);
  const q = String(req.query.q ?? '').trim();

  if (day) { where.push('date(s.created_at) = ?'); params.push(day); }
  if (from) { where.push('date(s.created_at) >= ?'); params.push(from); }
  if (to) { where.push('date(s.created_at) <= ?'); params.push(to); }
  if (status) { where.push('s.status = ?'); params.push(status); }
  if (paymentMethod) { where.push('s.payment_method = ?'); params.push(paymentMethod); }
  if (Number.isInteger(customerId) && customerId > 0) { where.push('s.customer_id = ?'); params.push(customerId); }
  if (Number.isInteger(userId) && userId > 0) { where.push('s.user_id = ?'); params.push(userId); }
  if (q) {
    where.push('(CAST(s.id AS TEXT) = ? OR COALESCE(s.customer_name, c.name) LIKE ?)');
    params.push(q, `%${q}%`);
  }
  return { whereSql: where.join(' AND '), params };
}

// COALESCE: o nome congelado na venda manda; o JOIN só cobre vendas anteriores à migration
// 0058, que não têm snapshot. `returned_cents` alimenta a coluna de devoluções.
const SALE_LIST_SELECT = `SELECT s.id, s.status, s.total_cents, s.discount_cents, s.payment_method, s.change_cents,
       COALESCE(s.customer_name, c.name) AS customer, u.username, s.created_at,
       (SELECT COUNT(*) FROM sale_payments sp WHERE sp.sale_id = s.id) AS payment_count,
       (SELECT COALESCE(SUM(sr.total_cents), 0) FROM sale_returns sr WHERE sr.sale_id = s.id AND sr.deleted_at IS NULL) AS returned_cents
  FROM sales s
  LEFT JOIN customers c ON c.id = s.customer_id
  LEFT JOIN users u ON u.id = s.user_id`;

export const storeController = {
  listPaymentMethods(_req: Request, res: Response) {
    res.json(getService<FinancePayMethodsService>('finance.paymethods').listActive());
  },

  createSaleAction(req: Request, res: Response) {
    // Quem pode dar desconto também pode ajustar o preço de uma linha (desconto por item).
    const result = createSale(req, req.body, { allowPriceOverride: canOverridePrice(req) });
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json(result);
  },

  returnSaleAction(req: Request, res: Response) {
    const result = returnSale(req, Number(req.params.id), req.body ?? {});
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json(result);
  },

  listSales(req: Request, res: Response) {
    const { whereSql, params } = buildSalesWhere(req);
    const countRow = saleRepository.rawOne(
      `SELECT COUNT(*) AS cnt FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE ${whereSql}`,
      ...params,
    ) as { cnt: number };

    let sql = `${SALE_LIST_SELECT} WHERE ${whereSql} ORDER BY s.id DESC`;
    const limit = Number(req.query.limit);
    if (Number.isFinite(limit) && limit > 0) {
      sql += ' LIMIT ?';
      params.push(Math.min(Math.floor(limit), 500));
      const offset = Number(req.query.offset);
      if (Number.isFinite(offset) && offset > 0) { sql += ' OFFSET ?'; params.push(Math.floor(offset)); }
    } else {
      sql += ' LIMIT 200';
    }
    res.setHeader('X-Total-Count', String(countRow.cnt));
    res.json(saleRepository.raw(sql, ...params));
  },

  listSellers(_req: Request, res: Response) {
    res.json(saleRepository.raw(
      `SELECT DISTINCT u.id, u.username FROM sales s JOIN users u ON u.id = s.user_id
        WHERE s.deleted_at IS NULL ORDER BY u.username`,
    ));
  },

  exportSales(req: Request, res: Response) {
    const { whereSql, params } = buildSalesWhere(req);
    const rows = saleRepository.raw(
      `${SALE_LIST_SELECT} WHERE ${whereSql} ORDER BY s.id DESC LIMIT 5000`,
      ...params,
    ) as unknown as Record<string, unknown>[];
    const cents = (c: unknown): string => (Number(c ?? 0) / 100).toFixed(2).replace('.', ',');
    const csv = toCsv([
      ['#', 'Data', 'Cliente', 'Situação', 'Pagamento', 'Vendedor', 'Total (R$)', 'Devolvido (R$)'],
      ...rows.map((r) => [
        r.id as number, String(r.created_at), String(r.customer ?? ''), String(r.status),
        String(r.payment_method), String(r.username ?? ''), cents(r.total_cents), cents(r.returned_cents),
      ]),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vendas-${stamp}.csv"`);
    audit(req, 'exportar', 'sale', 0, null, { total: rows.length });
    res.send(csv);
  },

  getSale(req: Request, res: Response) {
    const id = String(req.params.id);
    const sale = saleRepository.rawOne(
      `SELECT s.*, COALESCE(s.customer_name, c.name) AS customer, u.username FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.deleted_at IS NULL`,
      id,
    );
    if (!sale) { res.status(404).json({ error: 'Venda não encontrada.' }); return; }
    const items = saleRepository.raw(
      'SELECT id, product_name, qty, unit_price_cents, total_cents, notes, line_group_uuid FROM sale_items WHERE sale_id = ?',
      id,
    );
    const payments = salePaymentRepository.raw('SELECT method_name, method_type, amount_cents, fee_cents, received_cents, change_cents FROM sale_payments WHERE sale_id = ?', id);
    const returns = saleRepository.raw(
      'SELECT id, refund_method, total_cents, notes, created_at FROM sale_returns WHERE sale_id = ? AND deleted_at IS NULL ORDER BY id DESC',
      id,
    );
    const returned = returnedQtyByProduct(Number(id));
    const returnable = soldLines(Number(id)).map((l) => ({
      product_id: l.product_id,
      product_name: l.product_name,
      sold_qty: l.qty,
      unit_price_cents: l.unit_price_cents,
      returned_qty: returned.get(l.product_id) ?? 0,
      remaining_qty: l.qty - (returned.get(l.product_id) ?? 0),
    }));
    res.json({ ...sale, items, payments, returns, returnable });
  },

  cancelSaleAction(req: Request, res: Response) {
    const result = cancelSale(req, Number(req.params.id));
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  },

  listQuotes(req: Request, res: Response) {
    const status = String(req.query.status ?? '');
    const where = status ? 'AND q.status = ?' : '';
    const sql = `SELECT q.id, q.status, q.customer_id, q.customer_name, c.name AS customer, q.total_cents,
                        q.discount_cents, q.notes, q.valid_until, q.sale_id, u.username, q.created_at
                 FROM quotes q
                 LEFT JOIN customers c ON c.id = q.customer_id
                 LEFT JOIN users u ON u.id = q.user_id
                 WHERE q.deleted_at IS NULL ${where} ORDER BY q.id DESC LIMIT 200`;
    res.json(status ? quoteRepository.raw(sql, status) : quoteRepository.raw(sql));
  },

  getQuote(req: Request, res: Response) {
    const id = String(req.params.id);
    const quote = quoteRepository.rawOne(
      `SELECT q.*, c.name AS customer FROM quotes q
       LEFT JOIN customers c ON c.id = q.customer_id
       WHERE q.id = ? AND q.deleted_at IS NULL`,
      id,
    );
    if (!quote) { res.status(404).json({ error: 'Orçamento não encontrado.' }); return; }
    // product_id/notes/line_group_uuid vão no retorno porque o PDV remonta o carrinho a
    // partir daqui ao reabrir o orçamento — sem eles o vínculo com os complementos se perde.
    // image_url/sku saem do produto (LEFT JOIN — pode ter sido excluído): o PDV mostra a
    // foto no carrinho ao reabrir o orçamento, igual a quando o item foi lançado à mão.
    const items = quoteRepository.raw(
      `SELECT qi.id, qi.product_id, qi.product_name, qi.qty, qi.unit_price_cents, qi.total_cents,
              qi.notes, qi.line_group_uuid, p.image_url, p.sku
         FROM quote_items qi
         LEFT JOIN products p ON p.id = qi.product_id
        WHERE qi.quote_id = ? ORDER BY qi.id`,
      id,
    );
    res.json({ ...quote, items });
  },

  createQuoteAction(req: Request, res: Response) {
    const result = createQuote(req, req.body, { allowPriceOverride: canOverridePrice(req) });
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json(result);
  },

  updateQuoteAction(req: Request, res: Response) {
    const result = updateQuote(req, Number(req.params.id), req.body, { allowPriceOverride: canOverridePrice(req) });
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  },

  convertQuoteAction(req: Request, res: Response) {
    const { items, ...payment } = req.body ?? {};
    const result = convertQuote(req, Number(req.params.id), payment, items);
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json(result);
  },

  cancelQuoteAction(req: Request, res: Response) {
    const result = cancelQuote(req, Number(req.params.id));
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  },

  dailyReport(req: Request, res: Response) {
    const day = String(req.query.day ?? new Date().toISOString().slice(0, 10));
    const byPayment = salePaymentRepository.raw(
      `SELECT p.method_name AS payment_method, COUNT(*) AS vendas,
              SUM(p.amount_cents) AS total_cents, SUM(p.fee_cents) AS fee_cents
       FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND date(s.created_at) = ?
       GROUP BY p.method_name ORDER BY total_cents DESC`,
      day,
    );
    const totals = saleRepository.rawOne(
      `SELECT COUNT(*) AS vendas, COALESCE(SUM(total_cents), 0) AS total_cents,
              COALESCE(SUM(discount_cents), 0) AS discount_cents,
              COALESCE(SUM(surcharge_cents), 0) AS surcharge_cents,
              COALESCE((SELECT SUM(p.fee_cents) FROM sale_payments p JOIN sales s2 ON s2.id = p.sale_id
                        WHERE s2.status = 'concluida' AND s2.deleted_at IS NULL AND date(s2.created_at) = ?), 0) AS fee_cents
       FROM sales WHERE status = 'concluida' AND deleted_at IS NULL AND date(created_at) = ?`,
      day, day,
    );
    const topProducts = saleRepository.raw(
      `SELECT i.product_name, SUM(i.qty) AS qty, SUM(i.total_cents) AS total_cents
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND date(s.created_at) = ?
       GROUP BY i.product_name ORDER BY total_cents DESC LIMIT 10`,
      day,
    );
    res.json({ day, totals, byPayment, topProducts });
  },

  cashRegisterReportAction(req: Request, res: Response) {
    res.json(cashRegisterReport(Number(req.params.id)));
  },

  revenueTrendAction(req: Request, res: Response) {
    const raw = String(req.query.period ?? 'month');
    const period: RevenueTrendPeriod = raw === 'week' || raw === 'year' ? raw : 'month';
    res.json(revenueTrend(period));
  },
};
