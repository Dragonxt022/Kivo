import { Router, type Request, type Response } from 'express';
import { getSqlite } from '../../core/database/connection';
import { getService } from '../../core/services/registry';
import type { FinanceReceivablesService } from '../finance/setup';

/** Páginas do módulo store (montadas em /app/store, já autenticadas). */
const router = Router();
const db = () => getSqlite();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    if (!req.user!.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

interface CompanyInfo {
  name: string;
  document: string | null;
  address: string | null;
}

function companyInfo(): CompanyInfo {
  const rows = db()
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('empresa.nome', 'empresa.documento', 'empresa.endereco') AND deleted_at IS NULL",
    )
    .all() as { key: string; value: string | null }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    name: map['empresa.nome'] || 'Katsu',
    document: map['empresa.documento'] || null,
    address: map['empresa.endereco'] || null,
  };
}

router.get('/pdv', page('store-pdv', 'store.sales.create'));
router.get('/vendas', page('store-sales', 'store.sales.view'));
router.get('/orcamentos', page('store-quotes', 'store.quotes.view'));

/** Cupom de venda imprimível (layout 80mm). */
router.get('/vendas/:id/cupom', (req, res) => {
  if (!req.user!.permissions.has('store.sales.view')) return res.redirect('/');
  const sale = db().prepare(
    `SELECT s.*, c.name AS customer, u.username FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.deleted_at IS NULL`,
  ).get(req.params.id);
  if (!sale) return res.status(404).send('Venda não encontrada.');
  const items = db().prepare('SELECT product_name, qty, unit_price_cents, total_cents FROM sale_items WHERE sale_id = ?').all(req.params.id);
  const payments = db().prepare('SELECT method_name, amount_cents, received_cents, change_cents FROM sale_payments WHERE sale_id = ?').all(req.params.id);
  res.render('store-receipt', { sale, items, payments, company: companyInfo() });
});

/** Orçamento imprimível. */
router.get('/orcamentos/:id/imprimir', (req, res) => {
  if (!req.user!.permissions.has('store.quotes.view')) return res.redirect('/');
  const quote = db().prepare(
    `SELECT q.*, c.name AS customer FROM quotes q
     LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.id = ? AND q.deleted_at IS NULL`,
  ).get(req.params.id);
  if (!quote) return res.status(404).send('Orçamento não encontrado.');
  const items = db().prepare('SELECT product_name, qty, unit_price_cents, total_cents FROM quote_items WHERE quote_id = ?').all(req.params.id);
  res.render('store-quote-print', { quote, items, company: companyInfo() });
});

/** Carnê de venda a prazo parcelada — uma via impressa por parcela. */
router.get('/vendas/:id/carne', (req, res) => {
  if (!req.user!.permissions.has('store.sales.view')) return res.redirect('/');
  const sale = db().prepare(
    `SELECT s.*, c.name AS customer FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = ? AND s.deleted_at IS NULL`,
  ).get(req.params.id) as { id: number; customer: string | null } | undefined;
  if (!sale) return res.status(404).send('Venda não encontrada.');
  const installments = getService<FinanceReceivablesService>('finance.receivables').listBySale(Number(req.params.id));
  if (!installments.length) return res.status(404).send('Esta venda não tem parcelas a prazo.');
  res.render('store-carne-print', { sale, installments, company: companyInfo() });
});

export default router;
