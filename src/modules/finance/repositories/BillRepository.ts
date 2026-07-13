import { BaseRepository, type Row } from '../../../core/database/repository';

export class PayableRepository extends BaseRepository {
  constructor() {
    super('payables');
  }

  list(status?: string, partyId?: number): Row[] {
    const conditions = ['b.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (status) { conditions.push('b.status = ?'); params.push(status); }
    if (partyId) { conditions.push('b.supplier_id = ?'); params.push(partyId); }
    const where = conditions.join(' AND ');
    return this.raw(
      `SELECT b.id, b.description, s.name AS party, b.amount_cents, b.issue_date, b.due_date, b.status,
              b.notes, b.paid_at AS settled_at, b.paid_cents AS settled_cents,
              spm.name AS settle_method_name,
              b.installment_group_id, b.installment_no, b.installment_count,
              b.dre_category_id, dc.label AS dre_category_label
       FROM payables b LEFT JOIN suppliers s ON s.id = b.supplier_id
            LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id
            LEFT JOIN dre_categories dc ON dc.id = b.dre_category_id
       WHERE ${where} ORDER BY b.due_date, b.id`,
      ...params,
    );
  }

  findDetail(id: number | string): Row | undefined {
    return this.rawOne(
      `SELECT b.id, b.description, b.supplier_id AS party_id, s.name AS party,
              b.amount_cents, b.issue_date, b.due_date, b.status, b.paid_at AS settled_at,
              b.paid_cents AS settled_cents, b.notes, b.updated_at,
              b.settle_payment_method_id, spm.name AS settle_method_name,
              b.installment_group_id, b.installment_no, b.installment_count,
              b.dre_category_id, dc.label AS dre_category_label
       FROM payables b LEFT JOIN suppliers s ON s.id = b.supplier_id
            LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id
            LEFT JOIN dre_categories dc ON dc.id = b.dre_category_id
       WHERE b.id = ? AND b.deleted_at IS NULL`,
      id,
    );
  }

  findNextInstallment(groupId: string, nextNo: number): Row | undefined {
    return this.rawOne(
      `SELECT id FROM payables WHERE installment_group_id = ? AND installment_no = ? AND status = 'aberta'`,
      groupId, nextNo,
    );
  }

  settle(id: number | string, status: string, dateCol: string, centsCol: string, paidCents: number, paymentMethodId: number | null): void {
    this.rawRun(
      `UPDATE payables SET status = ?, ${dateCol} = datetime('now'), ${centsCol} = ?, settle_payment_method_id = ?, updated_at = datetime('now') WHERE id = ?`,
      status, paidCents, paymentMethodId, id,
    );
  }
}

export const payableRepository = new PayableRepository();

export class ReceivableRepository extends BaseRepository {
  constructor() {
    super('receivables');
  }

  list(status?: string, partyId?: number, agreementCompanyId?: number): Row[] {
    const conditions = ['b.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (status) { conditions.push('b.status = ?'); params.push(status); }
    if (partyId) { conditions.push('b.customer_id = ?'); params.push(partyId); }
    if (agreementCompanyId) { conditions.push('b.agreement_company_id = ?'); params.push(agreementCompanyId); }
    const where = conditions.join(' AND ');
    return this.raw(
      `SELECT b.id, b.description, c.name AS party, b.amount_cents, b.issue_date, b.due_date, b.status,
              b.notes, b.received_at AS settled_at, b.received_cents AS settled_cents,
              spm.name AS settle_method_name,
              b.installment_group_id, b.installment_no, b.installment_count,
              b.sale_id
       FROM receivables b LEFT JOIN customers c ON c.id = b.customer_id
            LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id
       WHERE ${where} ORDER BY b.due_date, b.id`,
      ...params,
    );
  }

  findDetail(id: number | string): Row | undefined {
    return this.rawOne(
      `SELECT b.id, b.description, b.customer_id AS party_id, c.name AS party,
              b.amount_cents, b.issue_date, b.due_date, b.status, b.received_at AS settled_at,
              b.received_cents AS settled_cents, b.notes, b.updated_at,
              b.settle_payment_method_id, spm.name AS settle_method_name,
              b.installment_group_id, b.installment_no, b.installment_count,
              b.sale_id
       FROM receivables b LEFT JOIN customers c ON c.id = b.customer_id
            LEFT JOIN payment_methods spm ON spm.id = b.settle_payment_method_id
       WHERE b.id = ? AND b.deleted_at IS NULL`,
      id,
    );
  }

  listBySale(saleId: number): Row[] {
    return this.raw(
      `SELECT id, description, amount_cents, due_date, status, installment_no, installment_count
       FROM receivables WHERE sale_id = ? AND deleted_at IS NULL ORDER BY installment_no, id`,
      saleId,
    );
  }

  findNextInstallment(groupId: string, nextNo: number): Row | undefined {
    return this.rawOne(
      `SELECT id FROM receivables WHERE installment_group_id = ? AND installment_no = ? AND status = 'aberta'`,
      groupId, nextNo,
    );
  }

  findNextBySale(saleId: number, nextNo: number): Row | undefined {
    return this.rawOne(
      `SELECT id FROM receivables WHERE sale_id = ? AND installment_no = ? AND status = 'aberta'`,
      saleId, nextNo,
    );
  }

  settle(id: number | string, status: string, dateCol: string, centsCol: string, paidCents: number, paymentMethodId: number | null): void {
    this.rawRun(
      `UPDATE receivables SET status = ?, ${dateCol} = datetime('now'), ${centsCol} = ?, settle_payment_method_id = ?, updated_at = datetime('now') WHERE id = ?`,
      status, paidCents, paymentMethodId, id,
    );
  }

  cancelBySale(saleId: number): void {
    this.rawRun(
      `UPDATE receivables SET status = 'cancelada', updated_at = datetime('now') WHERE sale_id = ? AND status = 'aberta'`,
      saleId,
    );
  }

  findByAgreementAndPeriod(companyId: number, periodKey: string): Row | undefined {
    return this.rawOne(
      'SELECT id FROM receivables WHERE agreement_company_id = ? AND period_key = ? AND deleted_at IS NULL',
      companyId, periodKey,
    );
  }

  findOpenByDueDate(limitDate: string): Row[] {
    return this.raw(
      `SELECT id, description, amount_cents, due_date FROM receivables
       WHERE status = 'aberta' AND deleted_at IS NULL AND due_date <= ? ORDER BY due_date LIMIT 20`,
      limitDate,
    );
  }

  findSaleReceivables(saleId: number): { id: number; status: string }[] {
    return this.raw(
      'SELECT id, status FROM receivables WHERE sale_id = ? AND deleted_at IS NULL',
      saleId,
    ) as { id: number; status: string }[];
  }
}

export const receivableRepository = new ReceivableRepository();

export class BillSettlementPaymentRepository extends BaseRepository {
  constructor() {
    super('bill_settlement_payments');
  }
}

export const billSettlementPaymentRepository = new BillSettlementPaymentRepository();
