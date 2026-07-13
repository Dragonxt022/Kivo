import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { requirePermission } from '../../../core/permissions/middleware';
import { audit } from '../../../core/audit/service';
import { openRegister, closeRegister, currentRegister, expectedCents, addMovement, editClosedRegister } from '../cash';
import { pendingTotal, generateInvoice } from '../agreements';
import { paymentMethodRepository } from '../repositories/PaymentMethodRepository';
import { cashMovementRepository, cashRegisterRepository } from '../repositories/CashRegisterRepository';
import { payableRepository, receivableRepository } from '../repositories/BillRepository';
import { customerRepository } from '../../commercial/repositories/CustomerRepository';
import { settingsRepository } from '../../../core/repositories/SettingsRepository';

export const financeController = {
  listPaymentMethods(req: Request, res: Response) {
    const all = req.query.all === '1';
    res.json(all ? paymentMethodRepository.listAll() : paymentMethodRepository.listActive());
  },

  listPaymentMethodsActive(req: Request, res: Response) {
    if (!req.user) { res.status(401).json({ error: 'Não autenticado.' }); return; }
    res.json(paymentMethodRepository.listActiveLite());
  },

  createPaymentMethod(req: Request, res: Response) {
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
  },

  updatePaymentMethod(req: Request, res: Response) {
    const id = String(req.params.id);
    const before = paymentMethodRepository.rawOne(
      'SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id,
    );
    if (!before) { res.status(404).json({ error: 'Forma de pagamento não encontrada.' }); return; }
    const { name, feeBps, active, sort } = req.body ?? {};
    if (feeBps != null && (Math.round(feeBps) < 0 || Math.round(feeBps) > 10000)) {
      res.status(400).json({ error: 'Taxa deve estar entre 0 e 10000 bps.' });
      return;
    }
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (feeBps !== undefined) updates.fee_bps = Math.round(feeBps);
    if (active !== undefined) updates.active = active ? 1 : 0;
    if (sort !== undefined) updates.sort = sort;
    if (Object.keys(updates).length === 0) return;
    paymentMethodRepository.update(id, updates);
    const after = paymentMethodRepository.rawOne(
      'SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id,
    );
    audit(req, 'editar', 'payment_method', id, before, after);
    res.json(after);
  },

  deletePaymentMethod(req: Request, res: Response) {
    const id = String(req.params.id);
    const before = paymentMethodRepository.rawOne(
      'SELECT id, name, type, fee_bps, active FROM payment_methods WHERE id = ? AND deleted_at IS NULL', id,
    );
    if (!before) { res.status(404).json({ error: 'Forma de pagamento não encontrada.' }); return; }
    paymentMethodRepository.softDelete(id);
    audit(req, 'excluir', 'payment_method', id, before, null);
    res.json({ ok: true });
  },

  getCurrentCash(_req: Request, res: Response) {
    const reg = currentRegister();
    if (!reg) { res.json({ open: false }); return; }
    const reminderEnabled = settingsRepository.getBool('caixa.lembrete_24h', true);
    const openedMs = new Date(reg.opened_at.replace(' ', 'T') + 'Z').getTime();
    const openTooLong = reminderEnabled && Date.now() - openedMs > 24 * 3600e3;
    res.json({ open: true, register: reg, expectedCents: expectedCents(reg.id), openTooLong });
  },

  listCashMovements(req: Request, res: Response) {
    const registerId = req.query.registerId ? Number(req.query.registerId) : currentRegister()?.id;
    if (!registerId) { res.json([]); return; }
    res.json(cashMovementRepository.listByRegister(registerId));
  },

  listCashHistory(_req: Request, res: Response) {
    res.json(cashRegisterRepository.listHistory());
  },

  openCashAction(req: Request, res: Response) {
    const result = openRegister(req, req.body.openingCents);
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json(result);
  },

  closeCashAction(req: Request, res: Response) {
    const { countedCents, notes, countBreakdown } = req.body;
    const result = closeRegister(req, countedCents, notes, countBreakdown);
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  },

  editCashAction(req: Request, res: Response) {
    const result = editClosedRegister(req, Number(req.params.id), {
      countedCents: req.body?.countedCents != null ? Math.round(req.body.countedCents) : undefined,
      notes: req.body?.notes,
    });
    if (!result.ok) { res.status(400).json(result); return; }
    res.json(result);
  },

  createCashMovement(req: Request, res: Response) {
    const { type, amountCents, description } = req.body ?? {};
    if (!['suprimento', 'sangria'].includes(type) || !amountCents || amountCents <= 0) {
      res.status(400).json({ error: 'Campos: type (suprimento|sangria), amountCents > 0.' });
      return;
    }
    const reg = currentRegister();
    if (!reg) { res.status(400).json({ error: 'Nenhum caixa aberto.' }); return; }
    if (type === 'sangria' && Math.round(amountCents) > expectedCents(reg.id)) {
      res.status(400).json({ error: 'Sangria maior que o valor em caixa.' });
      return;
    }
    addMovement(req, reg.id, type === 'suprimento' ? 'entrada' : 'saida', type, Math.round(amountCents), description);
    res.status(201).json({ ok: true, expectedCents: expectedCents(reg.id) });
  },

  getPendingAgreement(req: Request, res: Response) {
    res.json({ pendingCents: pendingTotal(Number(req.params.companyId)) });
  },

  generateInvoiceAction(req: Request, res: Response) {
    const result = generateInvoice(req, Number(req.params.companyId), req.body?.periodKey);
    if (!result.ok) { res.status(400).json(result); return; }
    res.status(201).json(result);
  },

  getNegativeBalances(_req: Request, res: Response) {
    res.json(customerRepository.getNegativeBalances());
  },

  cashflowReport(req: Request, res: Response) {
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
  },

  upcomingBills(req: Request, res: Response) {
    if (!req.user) { res.status(401).json({ error: 'Não autenticado.' }); return; }
    const canPayables = req.user.permissions.has('finance.payables.view');
    const canReceivables = req.user.permissions.has('finance.receivables.view');
    if (!canPayables && !canReceivables) { res.status(403).json({ error: 'Permissão negada.' }); return; }
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
  },
};
