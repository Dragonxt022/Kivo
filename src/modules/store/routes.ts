import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { getService } from '../../core/services/registry';
import type { FinancePayMethodsService } from '../finance/setup';
import { createSale, cancelSale } from './sales';
import { createQuote, convertQuote, cancelQuote, updateQuote } from './quotes';
import { cashRegisterReport } from './reports';
import { validateBody } from '../../shared/validateBody';
import { createSaleSchema, createQuoteSchema, updateQuoteSchema } from '../../shared/schemas';
import { saleRepository, salePaymentRepository } from './repositories/SaleRepository';
import { quoteRepository } from './repositories/QuoteRepository';

const router = Router();

router.get('/payment-methods', requirePermission('store.sales.create'), (_req, res) => {
  res.json(getService<FinancePayMethodsService>('finance.paymethods').listActive());
});

router.post('/sales', requirePermission('store.sales.create'), validateBody(createSaleSchema), (req, res) => {
  const result = createSale(req, req.body);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

router.get('/sales', requirePermission('store.sales.view'), (req, res) => {
  const day = String(req.query.day ?? '');
  const customerId = req.query.customerId ? Number(req.query.customerId) : undefined;
  const conditions = [day ? 'AND date(s.created_at) = ?' : '', customerId ? 'AND s.customer_id = ?' : ''].filter(Boolean).join(' ');
  const params: unknown[] = [];
  if (day) params.push(day);
  if (customerId) params.push(customerId);
  const sql = `SELECT s.id, s.status, s.total_cents, s.discount_cents, s.payment_method, s.change_cents,
                      c.name AS customer, u.username, s.created_at
               FROM sales s
               LEFT JOIN customers c ON c.id = s.customer_id
               LEFT JOIN users u ON u.id = s.user_id
               WHERE s.deleted_at IS NULL ${conditions} ORDER BY s.id DESC LIMIT 200`;
  res.json(saleRepository.raw(sql, ...params));
});

router.get('/sales/:id', requirePermission('store.sales.view'), (req, res) => {
  const id = String(req.params.id);
  const sale = saleRepository.rawOne(
    `SELECT s.*, c.name AS customer, u.username FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.deleted_at IS NULL`,
    id,
  );
  if (!sale) {
    res.status(404).json({ error: 'Venda não encontrada.' });
    return;
  }
  const items = saleRepository.raw('SELECT product_name, qty, unit_price_cents, total_cents FROM sale_items WHERE sale_id = ?', id);
  const payments = salePaymentRepository.raw('SELECT method_name, method_type, amount_cents, fee_cents, received_cents, change_cents FROM sale_payments WHERE sale_id = ?', id);
  res.json({ ...sale, items, payments });
});

router.post('/sales/:id/cancel', requirePermission('store.sales.cancel'), (req, res) => {
  const result = cancelSale(req, Number(req.params.id));
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.get('/quotes', requirePermission('store.quotes.view'), (req, res) => {
  const status = String(req.query.status ?? '');
  const where = status ? 'AND q.status = ?' : '';
  const sql = `SELECT q.id, q.status, q.customer_id, q.customer_name, c.name AS customer, q.total_cents,
                      q.discount_cents, q.notes, q.valid_until, q.sale_id, u.username, q.created_at
               FROM quotes q
               LEFT JOIN customers c ON c.id = q.customer_id
               LEFT JOIN users u ON u.id = q.user_id
               WHERE q.deleted_at IS NULL ${where} ORDER BY q.id DESC LIMIT 200`;
  res.json(status ? quoteRepository.raw(sql, status) : quoteRepository.raw(sql));
});

router.get('/quotes/:id', requirePermission('store.quotes.view'), (req, res) => {
  const id = String(req.params.id);
  const quote = quoteRepository.rawOne(
    `SELECT q.*, c.name AS customer FROM quotes q
     LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.id = ? AND q.deleted_at IS NULL`,
    id,
  );
  if (!quote) {
    res.status(404).json({ error: 'Orçamento não encontrado.' });
    return;
  }
  const items = quoteRepository.raw('SELECT product_name, qty, unit_price_cents, total_cents FROM quote_items WHERE quote_id = ?', id);
  res.json({ ...quote, items });
});

router.post('/quotes', requirePermission('store.quotes.create'), validateBody(createQuoteSchema), (req, res) => {
  const result = createQuote(req, req.body);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

router.put('/quotes/:id', requirePermission('store.quotes.edit'), validateBody(updateQuoteSchema), (req, res) => {
  const result = updateQuote(req, Number(req.params.id), req.body);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.post('/quotes/:id/convert', requirePermission('store.sales.create'), (req, res) => {
  const result = convertQuote(req, Number(req.params.id), req.body ?? {});
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

router.post('/quotes/:id/cancel', requirePermission('store.quotes.create'), (req, res) => {
  const result = cancelQuote(req, Number(req.params.id));
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.get('/reports/daily', requirePermission('store.reports.view'), (req, res) => {
  const day = String(req.query.day ?? new Date().toISOString().slice(0, 10));
  const byPayment = salePaymentRepository.raw(
    `SELECT p.method_name AS payment_method, COUNT(*) AS vendas,
            SUM(p.amount_cents) AS total_cents, SUM(p.fee_cents) AS fee_cents
     FROM sale_payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.status = 'concluida' AND s.deleted_at IS NULL AND date(s.created_at) = ?
     GROUP BY p.method_name ORDER BY total_cents DESC`,
    day,
  ) as { payment_method: string; vendas: number; total_cents: number; fee_cents: number }[];
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
});

router.get('/reports/cash-register/:id', requirePermission('store.reports.view'), (req, res) => {
  res.json(cashRegisterReport(Number(req.params.id)));
});

export default router;
