import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { openRegister, closeRegister, currentRegister, expectedCents, addMovement, editClosedRegister } from './cash';
import { makeBillsRouter } from './bills';
import { pendingTotal, generateInvoice } from './agreements';
import { validateBody } from '../../shared/validateBody';
import { openRegisterSchema, closeRegisterSchema } from '../../shared/schemas';
import { paymentMethodRepository } from './repositories/PaymentMethodRepository';
import { cashMovementRepository, cashRegisterRepository } from './repositories/CashRegisterRepository';
import { payableRepository, receivableRepository } from './repositories/BillRepository';
import { customerRepository } from '../commercial/repositories/CustomerRepository';
import { settingsRepository } from '../../core/repositories/SettingsRepository';

const router = Router();

router.get('/payment-methods', requirePermission('finance.paymethods.view'), (req, res) => {
  const all = req.query.all === '1';
  if (all) {
    res.json(paymentMethodRepository.listAll());
  } else {
    res.json(paymentMethodRepository.listActive());
  }
});

router.get('/payment-methods/active', (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Não autenticado.' });
    return;
  }
  res.json(paymentMethodRepository.listActiveLite());
});

router.post('/payment-methods', requirePermission('finance.paymethods.edit'), (req, res) => {
  const { name, type, feeBps } = req.body ?? {};
  const types = ['dinheiro', 'debito', 'credito', 'pix', 'prazo', 'outro'];
  if (!name || !types.includes(type)) {
    res.status(400).json({ error: `Campos: name, type (${types.join('|')}), feeBps opcional.` });
    return;
  }
  const fee = Math.round(feeBps ?? 0);
  if (fee < 0 || fee > 10000) {
    res.status(400).json({ error: 'Taxa deve estar entre 0 e 10000 bps (0% a 100%).' });
    return;
  }
  try {
    const id = paymentMethodRepository.create({ name, type, fee_bps: fee, sort: 99, uuid: randomUUID() });
    audit(req, 'criar', 'payment_method', id, null, { name, type, feeBps: fee });
    res.status(201).json({ id, name, type, fee_bps: fee });
  } catch {
    res.status(409).json({ error: 'Já existe uma forma de pagamento com esse nome.' });
  }
});

router.put('/payment-methods/:id', requirePermission('finance.paymethods.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = paymentMethodRepository.rawOne('SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id);
  if (!before) {
    res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    return;
  }
  const { name, feeBps, active, sort } = req.body ?? {};
  if (feeBps != null && (Math.round(feeBps) < 0 || Math.round(feeBps) > 10000)) {
    res.status(400).json({ error: 'Taxa deve estar entre 0 e 10000 bps.' });
    return;
  }
  paymentMethodRepository.update(id, {
    name: name ?? null,
    fee_bps: feeBps != null ? Math.round(feeBps) : null,
    active: active != null ? (active ? 1 : 0) : null,
    sort: sort ?? null,
  });
  const after = paymentMethodRepository.rawOne('SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id);
  audit(req, 'editar', 'payment_method', id, before, after);
  res.json(after);
});

router.delete('/payment-methods/:id', requirePermission('finance.paymethods.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = paymentMethodRepository.rawOne('SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id);
  if (!before) {
    res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    return;
  }
  paymentMethodRepository.softDelete(id);
  audit(req, 'excluir', 'payment_method', id, before, null);
  res.json({ ok: true });
});

router.get('/cash/current', requirePermission('finance.cash.view'), (_req, res) => {
  const reg = currentRegister();
  if (!reg) {
    res.json({ open: false });
    return;
  }
  const reminderEnabled = settingsRepository.getBool('caixa.lembrete_24h', true);
  const openedMs = new Date(reg.opened_at.replace(' ', 'T') + 'Z').getTime();
  const openTooLong = reminderEnabled && Date.now() - openedMs > 24 * 3600e3;
  res.json({ open: true, register: reg, expectedCents: expectedCents(reg.id), openTooLong });
});

router.get('/cash/movements', requirePermission('finance.cash.view'), (req, res) => {
  const registerId = req.query.registerId ? Number(req.query.registerId) : currentRegister()?.id;
  if (!registerId) {
    res.json([]);
    return;
  }
  res.json(cashMovementRepository.listByRegister(registerId));
});

router.get('/cash/history', requirePermission('finance.cash.view'), (_req, res) => {
  res.json(cashRegisterRepository.listHistory());
});

router.post('/cash/open', requirePermission('finance.cash.open'), validateBody(openRegisterSchema), (req, res) => {
  const result = openRegister(req, req.body.openingCents);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

router.post('/cash/close', requirePermission('finance.cash.close'), validateBody(closeRegisterSchema), (req, res) => {
  const { countedCents, notes, countBreakdown } = req.body;
  const result = closeRegister(req, countedCents, notes, countBreakdown);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.put('/cash/:id', requirePermission('finance.cash.edit'), (req, res) => {
  const result = editClosedRegister(req, Number(req.params.id), {
    countedCents: req.body?.countedCents != null ? Math.round(req.body.countedCents) : undefined,
    notes: req.body?.notes,
  });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

router.post('/cash/movement', requirePermission('finance.cash.move'), (req, res) => {
  const { type, amountCents, description } = req.body ?? {};
  if (!['suprimento', 'sangria'].includes(type) || !amountCents || amountCents <= 0) {
    res.status(400).json({ error: 'Campos: type (suprimento|sangria), amountCents > 0.' });
    return;
  }
  const reg = currentRegister();
  if (!reg) {
    res.status(400).json({ error: 'Nenhum caixa aberto.' });
    return;
  }
  if (type === 'sangria' && Math.round(amountCents) > expectedCents(reg.id)) {
    res.status(400).json({ error: 'Sangria maior que o valor em caixa.' });
    return;
  }
  addMovement(req, reg.id, type === 'suprimento' ? 'entrada' : 'saida', type, Math.round(amountCents), description);
  res.status(201).json({ ok: true, expectedCents: expectedCents(reg.id) });
});

router.use('/payables', makeBillsRouter({
  table: 'payables', entity: 'payable', permPrefix: 'finance.payables',
  partyColumn: 'supplier_id', partyTable: 'suppliers',
  settleStatus: 'paga', settleAction: 'pagar', settleDateCol: 'paid_at', settleCentsCol: 'paid_cents',
  movementType: 'pagamento', movementDirection: 'saida', settlePermission: 'finance.payables.pay',
  categoryField: true,
}));
router.use('/receivables', makeBillsRouter({
  table: 'receivables', entity: 'receivable', permPrefix: 'finance.receivables',
  partyColumn: 'customer_id', partyTable: 'customers',
  settleStatus: 'recebida', settleAction: 'receber', settleDateCol: 'received_at', settleCentsCol: 'received_cents',
  movementType: 'recebimento', movementDirection: 'entrada', settlePermission: 'finance.receivables.receive',
}));

router.get('/agreements/:companyId/pending', requirePermission('finance.agreements.view'), (req, res) => {
  res.json({ pendingCents: pendingTotal(Number(req.params.companyId)) });
});

router.post('/agreements/:companyId/invoice', requirePermission('finance.agreements.invoice'), (req, res) => {
  const result = generateInvoice(req, Number(req.params.companyId), req.body?.periodKey);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

router.get('/reconciliation/negative-balances', requirePermission('finance.reconciliation.view'), (_req, res) => {
  res.json(customerRepository.getNegativeBalances());
});

router.get('/reports/cashflow', requirePermission('finance.reports.view'), (req, res) => {
  const from = String(req.query.from ?? '0000-01-01');
  const to = String(req.query.to ?? '9999-12-31');
  const days = cashMovementRepository.cashflow(from, to) as { day: string; entradas: number; saidas: number }[];
  const totals = days.reduce(
    (acc, d) => ({ entradas: acc.entradas + d.entradas, saidas: acc.saidas + d.saidas }),
    { entradas: 0, saidas: 0 },
  );
  res.json({
    from, to,
    days: days.map((d) => ({ ...d, saldo: d.entradas - d.saidas })),
    totals: { ...totals, saldo: totals.entradas - totals.saidas },
  });
});

router.get('/reports/upcoming-bills', (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Não autenticado.' });
    return;
  }
  const canPayables = req.user.permissions.has('finance.payables.view');
  const canReceivables = req.user.permissions.has('finance.receivables.view');
  if (!canPayables && !canReceivables) {
    res.status(403).json({ error: 'Permissão negada.' });
    return;
  }
  const WINDOW_DAYS = 3;
  const limit = new Date();
  limit.setDate(limit.getDate() + WINDOW_DAYS);
  const limitStr = limit.toISOString().slice(0, 10);

  const payables = canPayables ? payableRepository.raw(
    `SELECT id, description, amount_cents, due_date FROM payables
     WHERE status = 'aberta' AND deleted_at IS NULL AND due_date <= ? ORDER BY due_date LIMIT 20`,
    limitStr,
  ) : [];
  const receivables = canReceivables ? receivableRepository.findOpenByDueDate(limitStr) : [];
  res.json({ payables, receivables, count: payables.length + receivables.length });
});

export default router;
