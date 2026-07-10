import { randomUUID } from 'node:crypto';
import { registerService } from '../../core/services/registry';
import { getSqlite } from '../../core/database/connection';
import { currentRegister, addMovement, expectedCents, getRegisterById } from './cash';
import { chargeAgreementRaw, pendingTotal, generateInvoice, companiesDueForInvoice } from './agreements';
import { startAgreementScheduler } from './agreementScheduler';

/** Serviços que o módulo finance oferece aos outros Apps (via Core). */
export interface FinanceCashService {
  currentRegister: typeof currentRegister;
  addMovement: typeof addMovement;
  expectedCents: typeof expectedCents;
  getRegisterById: typeof getRegisterById;
}

export interface ReceivableRow {
  id: number;
  description: string;
  amount_cents: number;
  due_date: string;
  status: string;
  installment_no: number | null;
  installment_count: number | null;
}

export interface FinanceReceivablesService {
  create(input: {
    description: string;
    amountCents: number;
    dueDate: string;
    customerId?: number;
    notes?: string;
    saleId?: number;
    installmentNo?: number;
    installmentCount?: number;
  }): number;
  /** Parcelas de uma venda a prazo, em ordem — usado pelo carnê e pelo cancelamento. */
  listBySale(saleId: number): ReceivableRow[];
}

function createReceivable(input: {
  description: string;
  amountCents: number;
  dueDate: string;
  customerId?: number;
  notes?: string;
  saleId?: number;
  installmentNo?: number;
  installmentCount?: number;
}): number {
  const info = getSqlite()
    .prepare(
      `INSERT INTO receivables (description, customer_id, amount_cents, due_date, notes, sale_id, installment_no, installment_count, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.description, input.customerId ?? null, Math.round(input.amountCents), input.dueDate,
      input.notes ?? null, input.saleId ?? null, input.installmentNo ?? null, input.installmentCount ?? null, randomUUID());
  return Number(info.lastInsertRowid);
}

function listReceivablesBySale(saleId: number): ReceivableRow[] {
  return getSqlite().prepare(
    `SELECT id, description, amount_cents, due_date, status, installment_no, installment_count
     FROM receivables WHERE sale_id = ? AND deleted_at IS NULL ORDER BY installment_no, id`,
  ).all(saleId) as ReceivableRow[];
}

export interface PaymentMethod {
  id: number;
  name: string;
  type: 'dinheiro' | 'debito' | 'credito' | 'pix' | 'prazo' | 'outro' | 'credito_loja' | 'fidelidade' | 'convenio';
  fee_bps: number;
}

export interface FinanceAgreementsService {
  chargeAgreementRaw: typeof chargeAgreementRaw;
  pendingTotal: typeof pendingTotal;
  generateInvoice: typeof generateInvoice;
  companiesDueForInvoice: typeof companiesDueForInvoice;
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
  registerService('finance.receivables', { create: createReceivable, listBySale: listReceivablesBySale } satisfies FinanceReceivablesService);
  registerService('finance.paymethods', payMethods);
  registerService('finance.agreements', { chargeAgreementRaw, pendingTotal, generateInvoice, companiesDueForInvoice } satisfies FinanceAgreementsService);
  startAgreementScheduler();
}
