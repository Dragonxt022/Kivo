import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getSqlite } from '../../core/database/connection';
import { requirePermission } from '../../core/permissions/middleware';
import { audit } from '../../core/audit/service';
import { openRegister, closeRegister, currentRegister, expectedCents, addMovement, editClosedRegister } from './cash';
import { makeBillsRouter } from './bills';
import { pendingTotal, generateInvoice } from './agreements';

const router = Router();
const db = () => getSqlite();

// ---------- Formas de pagamento (taxa em basis points: 160 = 1,6%) ----------
router.get('/payment-methods', requirePermission('finance.paymethods.view'), (req, res) => {
  const all = req.query.all === '1';
  const where = all ? '' : 'AND active = 1';
  res.json(db().prepare(
    `SELECT id, name, type, fee_bps, active, sort FROM payment_methods
     WHERE deleted_at IS NULL ${where} ORDER BY sort, name`,
  ).all());
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
    const info = db().prepare(
      'INSERT INTO payment_methods (name, type, fee_bps, sort, uuid) VALUES (?, ?, ?, 99, ?)',
    ).run(name, type, fee, randomUUID());
    audit(req, 'criar', 'payment_method', Number(info.lastInsertRowid), null, { name, type, feeBps: fee });
    res.status(201).json({ id: Number(info.lastInsertRowid), name, type, fee_bps: fee });
  } catch {
    res.status(409).json({ error: 'Já existe uma forma de pagamento com esse nome.' });
  }
});

router.put('/payment-methods/:id', requirePermission('finance.paymethods.edit'), (req, res) => {
  const id = String(req.params.id);
  const before = db().prepare('SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    return;
  }
  const { name, feeBps, active, sort } = req.body ?? {};
  if (feeBps != null && (Math.round(feeBps) < 0 || Math.round(feeBps) > 10000)) {
    res.status(400).json({ error: 'Taxa deve estar entre 0 e 10000 bps.' });
    return;
  }
  db().prepare(
    `UPDATE payment_methods SET name = COALESCE(?, name), fee_bps = COALESCE(?, fee_bps),
       active = COALESCE(?, active), sort = COALESCE(?, sort), updated_at = datetime('now') WHERE id = ?`,
  ).run(name ?? null, feeBps != null ? Math.round(feeBps) : null,
    active != null ? (active ? 1 : 0) : null, sort ?? null, id);
  const after = db().prepare('SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ?').get(id);
  audit(req, 'editar', 'payment_method', id, before, after);
  res.json(after);
});

router.delete('/payment-methods/:id', requirePermission('finance.paymethods.delete'), (req, res) => {
  const id = String(req.params.id);
  const before = db().prepare('SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!before) {
    res.status(404).json({ error: 'Forma de pagamento não encontrada.' });
    return;
  }
  db().prepare(`UPDATE payment_methods SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  audit(req, 'excluir', 'payment_method', id, before, null);
  res.json({ ok: true });
});

// ---------- Caixa ----------
router.get('/cash/current', requirePermission('finance.cash.view'), (_req, res) => {
  const reg = currentRegister();
  if (!reg) {
    res.json({ open: false });
    return;
  }
  const reminderSetting = db().prepare("SELECT value FROM settings WHERE key = 'caixa.lembrete_24h' AND deleted_at IS NULL").get() as
    { value: string | null } | undefined;
  const reminderEnabled = reminderSetting?.value !== '0';
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
  res.json(db().prepare(
    `SELECT m.id, m.direction, m.type, m.amount_cents, m.description, m.ref_entity, m.ref_id,
            u.username, m.created_at
     FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.register_id = ? ORDER BY m.id DESC`,
  ).all(registerId));
});

router.get('/cash/history', requirePermission('finance.cash.view'), (_req, res) => {
  res.json(db().prepare(
    `SELECT r.id, r.status, r.opened_at, r.opening_cents, r.closed_at, r.expected_cents,
            r.counted_cents, r.difference_cents, r.edited_at, r.notes,
            uo.username AS opened_by, uc.username AS closed_by, ue.username AS edited_by_name
     FROM cash_registers r
     LEFT JOIN users uo ON uo.id = r.opened_by
     LEFT JOIN users uc ON uc.id = r.closed_by
     LEFT JOIN users ue ON ue.id = r.edited_by
     WHERE r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 500`,
  ).all());
});

router.post('/cash/open', requirePermission('finance.cash.open'), (req, res) => {
  const result = openRegister(req, Math.round(req.body?.openingCents ?? 0));
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

router.post('/cash/close', requirePermission('finance.cash.close'), (req, res) => {
  if (req.body?.countedCents == null) {
    res.status(400).json({ error: 'Informe countedCents (valor contado na gaveta).' });
    return;
  }
  // Contagem por denominação é opcional (só quando o operador escolhe contar notas/moedas no fechamento).
  const countBreakdown =
    req.body?.countBreakdown && typeof req.body.countBreakdown === 'object' ? req.body.countBreakdown : undefined;
  const result = closeRegister(req, Math.round(req.body.countedCents), req.body?.notes, countBreakdown);
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

// ---------- Contas a pagar / a receber ----------
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

// ---------- Convênio ----------
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

// ---------- Reconciliação (saldos negativos após merge de sync) ----------
router.get('/reconciliation/negative-balances', requirePermission('finance.reconciliation.view'), (_req, res) => {
  const rows = db().prepare(
    `SELECT id, name, store_credit_cents, loyalty_points FROM customers
     WHERE deleted_at IS NULL AND (store_credit_cents < 0 OR loyalty_points < 0)
     ORDER BY name`,
  ).all();
  res.json(rows);
});

// ---------- Fluxo de caixa (DoD: bate com lançamentos) ----------
router.get('/reports/cashflow', requirePermission('finance.reports.view'), (req, res) => {
  const from = String(req.query.from ?? '0000-01-01');
  const to = String(req.query.to ?? '9999-12-31');
  const days = db().prepare(
    `SELECT date(created_at) AS day,
            COALESCE(SUM(CASE WHEN direction = 'entrada' THEN amount_cents END), 0) AS entradas,
            COALESCE(SUM(CASE WHEN direction = 'saida' THEN amount_cents END), 0) AS saidas
     FROM cash_movements
     WHERE date(created_at) BETWEEN ? AND ?
     GROUP BY date(created_at) ORDER BY day`,
  ).all(from, to) as { day: string; entradas: number; saidas: number }[];
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

// ---------- Contas a vencer (ícone de notificação do nav) ----------
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

  const payables = canPayables ? db().prepare(
    `SELECT id, description, amount_cents, due_date FROM payables
     WHERE status = 'aberta' AND deleted_at IS NULL AND due_date <= ? ORDER BY due_date LIMIT 20`,
  ).all(limitStr) : [];
  const receivables = canReceivables ? db().prepare(
    `SELECT id, description, amount_cents, due_date FROM receivables
     WHERE status = 'aberta' AND deleted_at IS NULL AND due_date <= ? ORDER BY due_date LIMIT 20`,
  ).all(limitStr) : [];
  res.json({ payables, receivables, count: payables.length + receivables.length });
});

export default router;
