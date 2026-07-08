import { randomUUID } from 'node:crypto';
import { registerService } from '../../core/services/registry';
import { getSqlite } from '../../core/database/connection';
import { currentRegister, addMovement, expectedCents, getRegisterById } from './cash';

/** Serviços que o módulo finance oferece aos outros Apps (via Core). */
export interface FinanceCashService {
  currentRegister: typeof currentRegister;
  addMovement: typeof addMovement;
  expectedCents: typeof expectedCents;
  getRegisterById: typeof getRegisterById;
}

export interface FinanceReceivablesService {
  create(input: {
    description: string;
    amountCents: number;
    dueDate: string;
    customerId?: number;
    notes?: string;
  }): number;
}

function createReceivable(input: {
  description: string;
  amountCents: number;
  dueDate: string;
  customerId?: number;
  notes?: string;
}): number {
  const info = getSqlite()
    .prepare(
      `INSERT INTO receivables (description, customer_id, amount_cents, due_date, notes, uuid)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.description, input.customerId ?? null, Math.round(input.amountCents), input.dueDate,
      input.notes ?? null, randomUUID());
  return Number(info.lastInsertRowid);
}

export interface PaymentMethod {
  id: number;
  name: string;
  type: 'dinheiro' | 'debito' | 'credito' | 'pix' | 'prazo' | 'outro';
  fee_bps: number;
}

export interface FinancePayMethodsService {
  listActive(): PaymentMethod[];
  get(id: number): PaymentMethod | undefined;
  getByType(type: string): PaymentMethod | undefined;
}

const payMethods: FinancePayMethodsService = {
  listActive: () =>
    getSqlite().prepare(
      'SELECT id, name, type, fee_bps FROM payment_methods WHERE active = 1 AND deleted_at IS NULL ORDER BY sort, name',
    ).all() as PaymentMethod[],
  get: (id) =>
    getSqlite().prepare(
      'SELECT id, name, type, fee_bps FROM payment_methods WHERE id = ? AND active = 1 AND deleted_at IS NULL',
    ).get(id) as PaymentMethod | undefined,
  getByType: (type) =>
    getSqlite().prepare(
      'SELECT id, name, type, fee_bps FROM payment_methods WHERE type = ? AND active = 1 AND deleted_at IS NULL ORDER BY sort, name LIMIT 1',
    ).get(type) as PaymentMethod | undefined,
};

export default function setup(): void {
  registerService('finance.cash', { currentRegister, addMovement, expectedCents, getRegisterById } satisfies FinanceCashService);
  registerService('finance.receivables', { create: createReceivable } satisfies FinanceReceivablesService);
  registerService('finance.paymethods', payMethods);
}
