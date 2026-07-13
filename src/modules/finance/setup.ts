import { randomUUID } from 'node:crypto';
import { registerService } from '../../core/services/registry';
import { currentRegister, addMovement, expectedCents, getRegisterById, openRegister, closeRegister } from './cash';
import { chargeAgreementRaw, pendingTotal, generateInvoice, companiesDueForInvoice } from './agreements';
import { startAgreementScheduler } from './agreementScheduler';
import { paymentMethodRepository } from './repositories/PaymentMethodRepository';
import { receivableRepository } from './repositories/BillRepository';

export interface FinanceCashService {
  currentRegister: typeof currentRegister;
  addMovement: typeof addMovement;
  expectedCents: typeof expectedCents;
  getRegisterById: typeof getRegisterById;
  openRegister: typeof openRegister;
  closeRegister: typeof closeRegister;
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
  return receivableRepository.create({
    description: input.description,
    customer_id: input.customerId ?? null,
    amount_cents: Math.round(input.amountCents),
    due_date: input.dueDate,
    notes: input.notes ?? null,
    sale_id: input.saleId ?? null,
    installment_no: input.installmentNo ?? null,
    installment_count: input.installmentCount ?? null,
    uuid: randomUUID(),
  });
}

function listReceivablesBySale(saleId: number): ReceivableRow[] {
  return receivableRepository.listBySale(saleId) as unknown as ReceivableRow[];
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
    paymentMethodRepository.listActive() as unknown as PaymentMethod[],
  get: (id) =>
    paymentMethodRepository.findActive(id) as unknown as PaymentMethod | undefined,
  getByType: (type) =>
    paymentMethodRepository.findByType(type) as unknown as PaymentMethod | undefined,
};

export default function setup(): void {
  registerService('finance.cash', { currentRegister, addMovement, expectedCents, getRegisterById, openRegister, closeRegister } satisfies FinanceCashService);
  registerService('finance.receivables', { create: createReceivable, listBySale: listReceivablesBySale } satisfies FinanceReceivablesService);
  registerService('finance.paymethods', payMethods);
  registerService('finance.agreements', { chargeAgreementRaw, pendingTotal, generateInvoice, companiesDueForInvoice } satisfies FinanceAgreementsService);
  startAgreementScheduler();
}
