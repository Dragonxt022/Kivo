import { Router, type Request, type Response } from 'express';
import { getSqlite } from '../../core/database/connection';
import { getService } from '../../core/services/registry';
import { getRegisterById } from './cash';
import type { StoreReportsService } from '../store/setup';

/** Páginas do módulo finance (montadas em /app/finance, já autenticadas). */
const router = Router();
const db = () => getSqlite();

interface CompanyInfo { name: string; document: string | null; address: string | null }

/** Cópia local do helper de store/pages.ts — mesmo padrão de duplicar helpers pequenos entre páginas de impressão. */
function companyInfo(): CompanyInfo {
  const rows = db()
    .prepare("SELECT key, value FROM settings WHERE key IN ('empresa.nome', 'empresa.documento', 'empresa.endereco') AND deleted_at IS NULL")
    .all() as { key: string; value: string | null }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { name: map['empresa.nome'] || 'Katsu', document: map['empresa.documento'] || null, address: map['empresa.endereco'] || null };
}

function page(view: string, permission: string, extra: Record<string, unknown> = {}) {
  return (req: Request, res: Response) => {
    if (!req.user!.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user, ...extra });
  };
}

router.get('/caixa', page('finance-cash', 'finance.cash.view'));

/** Relatório completo de fechamento de caixa (imprimível). */
router.get('/caixa/:id/relatorio', (req, res) => {
  if (!req.user!.permissions.has('finance.cash.view')) return res.redirect('/');
  const register = getRegisterById(Number(req.params.id));
  if (!register) return res.status(404).send('Caixa não encontrado.');
  const report = getService<StoreReportsService>('store.reports').cashRegisterReport(Number(req.params.id));
  res.render('finance-cash-report', { register, report, company: companyInfo() });
});
router.get('/pagar', page('finance-bills', 'finance.payables.view', {
  bills: { title: 'Contas a pagar', api: '/api/finance/payables', settleLabel: 'Pagar',
    createPerm: 'finance.payables.create', settlePerm: 'finance.payables.pay', editPerm: 'finance.payables.edit',
    partyLabel: 'Fornecedor', settledStatus: 'paga' },
}));
router.get('/receber', page('finance-bills', 'finance.receivables.view', {
  bills: { title: 'Contas a receber', api: '/api/finance/receivables', settleLabel: 'Receber',
    createPerm: 'finance.receivables.create', settlePerm: 'finance.receivables.receive', editPerm: 'finance.receivables.edit',
    partyLabel: 'Cliente', settledStatus: 'recebida' },
}));
router.get('/fluxo', page('finance-cashflow', 'finance.reports.view'));
router.get('/formas-pagamento', page('finance-paymethods', 'finance.paymethods.view'));

export default router;
