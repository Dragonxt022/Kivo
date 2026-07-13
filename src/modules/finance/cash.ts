import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { assertAuth } from '../../shared/auth';
import { cashRegisterRepository, cashMovementRepository } from './repositories/CashRegisterRepository';
import { saleRepository } from '../store/repositories/SaleRepository';

export interface CashRegister {
  id: number;
  status: string;
  opening_cents: number;
  opened_at: string;
  opened_by: number;
}

export function currentRegister(): CashRegister | undefined {
  const row = cashRegisterRepository.findCurrent() as CashRegister | undefined;
  return row;
}

export interface CashRegisterDetail {
  id: number;
  status: string;
  opening_cents: number;
  opened_at: string;
  opened_by_name: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  expected_cents: number | null;
  counted_cents: number | null;
  difference_cents: number | null;
  notes: string | null;
  count_breakdown: Record<string, number> | null;
}

export function getRegisterById(registerId: number): CashRegisterDetail | undefined {
  return cashRegisterRepository.findDetail(registerId) as CashRegisterDetail | undefined;
}

export function registerTotals(registerId: number): { entradas: number; saidas: number } {
  return cashMovementRepository.totals(registerId);
}

export function expectedCents(registerId: number): number {
  const { entradas, saidas } = registerTotals(registerId);
  return entradas - saidas;
}

export function addMovement(
  req: Request,
  registerId: number,
  direction: 'entrada' | 'saida',
  type: 'abertura' | 'suprimento' | 'sangria' | 'venda' | 'recebimento' | 'pagamento',
  amountCents: number,
  description?: string,
  refEntity?: string,
  refId?: string | number,
): void {
  cashMovementRepository.create({
    register_id: registerId,
    direction,
    type,
    amount_cents: Math.round(amountCents),
    description: description ?? null,
    ref_entity: refEntity ?? null,
    ref_id: refId != null ? String(refId) : null,
    user_id: req.user?.id ?? null,
    uuid: randomUUID(),
  });
}

export function openRegister(req: Request, openingCents: number): { ok: true; id: number } | { ok: false; error: string } {
  assertAuth(req);
  if (currentRegister()) return { ok: false, error: 'Já existe um caixa aberto. Feche-o antes de abrir outro.' };
  if (!Number.isInteger(openingCents) || openingCents < 0) return { ok: false, error: 'Valor de abertura inválido.' };
  let id = 0;
  cashRegisterRepository.transaction(() => {
    id = cashRegisterRepository.create({
      opened_by: req.user.id,
      opening_cents: openingCents,
      uuid: randomUUID(),
    });
    if (openingCents > 0) addMovement(req, id, 'entrada', 'abertura', openingCents, 'Fundo de troco');
  });
  audit(req, 'caixa_abrir', 'cash_register', id, null, { openingCents });
  return { ok: true, id };
}

export function closeRegister(
  req: Request,
  countedCents: number,
  notes?: string,
  countBreakdown?: Record<string, number>,
): { ok: true; id: number; expected: number; counted: number; difference: number } | { ok: false; error: string } {
  assertAuth(req);
  const reg = currentRegister();
  if (!reg) return { ok: false, error: 'Nenhum caixa aberto.' };
  if (!Number.isInteger(countedCents) || countedCents < 0) return { ok: false, error: 'Valor contado inválido.' };

  const expected = expectedCents(reg.id);
  const difference = countedCents - expected;
  const breakdownJson = countBreakdown && Object.keys(countBreakdown).length ? JSON.stringify(countBreakdown) : null;
  cashRegisterRepository.close(reg.id, req.user.id, expected, countedCents, difference, notes ?? null, breakdownJson);
  audit(req, 'caixa_fechar', 'cash_register', reg.id, { expected }, { counted: countedCents, difference });
  return { ok: true, id: reg.id, expected, counted: countedCents, difference };
}

export function editClosedRegister(req: Request, registerId: number, updates: { countedCents?: number; notes?: string }):
  { ok: true; id: number; expected: number; counted: number; difference: number } | { ok: false; error: string } {
  assertAuth(req);
  const before = cashRegisterRepository.rawOne(
    'SELECT id, status, expected_cents, counted_cents, difference_cents FROM cash_registers WHERE id = ? AND deleted_at IS NULL',
    registerId,
  ) as { id: number; status: string; expected_cents: number; counted_cents: number; difference_cents: number } | undefined;
  if (!before) return { ok: false, error: 'Registro de caixa não encontrado.' };
  if (before.status !== 'fechado') return { ok: false, error: 'Apenas caixas fechados podem ser editados.' };

  const counted = updates.countedCents != null ? Math.round(updates.countedCents) : before.counted_cents;
  const difference = counted - before.expected_cents;

  cashRegisterRepository.editClosed(registerId, counted, difference, updates.notes ?? null, req.user.id);

  audit(req, 'caixa_editar', 'cash_register', registerId,
    { counted: before.counted_cents, difference: before.difference_cents },
    { counted, difference });
  return { ok: true, id: registerId, expected: before.expected_cents, counted, difference };
}
