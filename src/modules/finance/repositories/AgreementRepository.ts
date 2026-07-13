import { BaseRepository, type Row } from '../../../core/database/repository';

export class AgreementCompanyRepository extends BaseRepository {
  constructor() {
    super('agreement_companies');
  }
}

export const agreementCompanyRepository = new AgreementCompanyRepository();

export class AgreementChargeRepository extends BaseRepository {
  constructor() {
    super('agreement_charges');
  }

  findBySale(saleId: number): Row | undefined {
    return this.rawOne(
      'SELECT id, invoiced_at FROM agreement_charges WHERE sale_id = ? AND deleted_at IS NULL',
      saleId,
    );
  }

  pendingTotal(companyId: number): number {
    const row = this.rawOne(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM agreement_charges
       WHERE agreement_company_id = ? AND invoiced_at IS NULL AND deleted_at IS NULL`,
      companyId,
    ) as { total: number };
    return row.total;
  }

  invoiceAll(companyId: number, receivableId: number): void {
    this.rawRun(
      `UPDATE agreement_charges SET invoiced_at = datetime('now'), receivable_id = ?, updated_at = datetime('now')
       WHERE agreement_company_id = ? AND invoiced_at IS NULL AND deleted_at IS NULL`,
      receivableId, companyId,
    );
  }
}

export const agreementChargeRepository = new AgreementChargeRepository();
