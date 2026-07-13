import { Router, type Request, type Response } from 'express';
import { getService } from '../../core/services/registry';
import { assertAuth } from '../../shared/auth';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import type { FinanceReceivablesService } from '../finance/setup';
import { saleRepository, salePaymentRepository } from './repositories/SaleRepository';
import { quoteRepository } from './repositories/QuoteRepository';

const router = Router();

interface CompanyInfo { name: string; document: string | null; address: string | null }

function companyInfo(): CompanyInfo {
  const name = settingsRepository.get('empresa.nome') || 'Katsu';
  const document = settingsRepository.get('empresa.documento');
  const address = settingsRepository.get('empresa.endereco');
  return { name, document, address };
}

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

router.get('/pdv', page('store-pdv', 'store.sales.create'));
router.get('/vendas', page('store-sales', 'store.sales.view'));
router.get('/orcamentos', page('store-quotes', 'store.quotes.view'));

router.get('/vendas/:id/cupom', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('store.sales.view')) return res.redirect('/');
  const sale = saleRepository.rawOne(
    `SELECT s.*, c.name AS customer, u.username FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.deleted_at IS NULL`,
    req.params.id,
  );
  if (!sale) return res.status(404).send('Venda não encontrada.');
  const items = saleRepository.raw('SELECT product_name, qty, unit_price_cents, total_cents FROM sale_items WHERE sale_id = ?', req.params.id);
  const payments = salePaymentRepository.raw('SELECT method_name, amount_cents, received_cents, change_cents FROM sale_payments WHERE sale_id = ?', req.params.id);
  res.render('store-receipt', { sale, items, payments, company: companyInfo() });
});

router.get('/orcamentos/:id/imprimir', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('store.quotes.view')) return res.redirect('/');
  const quote = quoteRepository.rawOne(
    `SELECT q.*, c.name AS customer FROM quotes q
     LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.id = ? AND q.deleted_at IS NULL`,
    req.params.id,
  );
  if (!quote) return res.status(404).send('Orçamento não encontrado.');
  const items = quoteRepository.raw('SELECT product_name, qty, unit_price_cents, total_cents FROM quote_items WHERE quote_id = ?', req.params.id);
  res.render('store-quote-print', { quote, items, company: companyInfo() });
});

router.get('/vendas/:id/carne', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('store.sales.view')) return res.redirect('/');
  const sale = saleRepository.rawOne(
    `SELECT s.*, c.name AS customer FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = ? AND s.deleted_at IS NULL`,
    req.params.id,
  ) as { id: number; customer: string | null } | undefined;
  if (!sale) return res.status(404).send('Venda não encontrada.');
  const installments = getService<FinanceReceivablesService>('finance.receivables').listBySale(Number(req.params.id));
  if (!installments.length) return res.status(404).send('Esta venda não tem parcelas a prazo.');
  res.render('store-carne-print', { sale, installments, company: companyInfo() });
});

export default router;
