import { Router, type Request, type Response } from 'express';
import { getService } from '../../core/services/registry';
import { assertAuth } from '../../shared/auth';
import { getRegisterById } from './cash';
import type { StoreReportsService } from '../store/setup';
import { settingsRepository } from '../../core/repositories/SettingsRepository';

const router = Router();

interface CompanyInfo { name: string; document: string | null; address: string | null }

function companyInfo(): CompanyInfo {
  const name = settingsRepository.get('empresa.nome') || 'Kivo';
  const document = settingsRepository.get('empresa.documento');
  const address = settingsRepository.get('empresa.endereco');
  return { name, document, address };
}

function page(view: string, permission: string, extra: Record<string, unknown> = {}) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user, ...extra });
  };
}

router.get('/caixa', page('finance-cash', 'finance.cash.view'));

router.get('/caixa/:id/relatorio', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('finance.cash.view')) return res.redirect('/');
  const register = getRegisterById(Number(req.params.id));
  if (!register) return res.status(404).send('Caixa não encontrado.');
  const report = getService<StoreReportsService>('store.reports').cashRegisterReport(Number(req.params.id));
  res.render('finance-cash-report', { register, report, company: companyInfo() });
});
router.get('/pagar', page('finance-bills', 'finance.payables.view', {
  bills: { title: 'Contas a pagar', api: '/api/finance/payables', settleLabel: 'Pagar',
    createPerm: 'finance.payables.create', settlePerm: 'finance.payables.pay', editPerm: 'finance.payables.edit',
    partyLabel: 'Fornecedor', settledStatus: 'paga', categoryField: true },
}));
router.get('/receber', page('finance-bills', 'finance.receivables.view', {
  bills: { title: 'Contas a receber', api: '/api/finance/receivables', settleLabel: 'Receber',
    createPerm: 'finance.receivables.create', settlePerm: 'finance.receivables.receive', editPerm: 'finance.receivables.edit',
    partyLabel: 'Cliente', settledStatus: 'recebida' },
}));
router.get('/fluxo', page('finance-cashflow', 'finance.reports.view'));
router.get('/formas-pagamento', page('finance-paymethods', 'finance.paymethods.view'));
router.get('/convenios', page('finance-agreements', 'finance.agreements.view'));
router.get('/reconciliacao', page('finance-reconciliation', 'finance.reconciliation.view'));

export default router;
