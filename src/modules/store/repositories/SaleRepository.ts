import { BaseRepository, type Row } from '../../../core/database/repository';

export class SaleRepository extends BaseRepository {
  constructor() {
    super('sales');
  }

  findByClientRequestId(clientRequestId: string): Row | undefined {
    return this.rawOne(
      'SELECT id, total_cents, change_cents, receivable_id FROM sales WHERE client_request_id = ?',
      clientRequestId,
    );
  }

  findFull(id: number): Row | undefined {
    return this.rawOne('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL', id);
  }

  cancel(id: number, userId: number): void {
    this.rawRun(
      `UPDATE sales SET status = 'cancelada', canceled_at = datetime('now'), canceled_by = ?, updated_at = datetime('now') WHERE id = ?`,
      userId, id,
    );
  }

  updateReceivable(id: number, receivableId: number): void {
    this.rawRun('UPDATE sales SET receivable_id = ? WHERE id = ?', receivableId, id);
  }
}

export const saleRepository = new SaleRepository();

export class SaleItemRepository extends BaseRepository {
  constructor() {
    super('sale_items');
  }
}

export const saleItemRepository = new SaleItemRepository();

export class SalePaymentRepository extends BaseRepository {
  constructor() {
    super('sale_payments');
  }

  listBySale(saleId: number): Row[] {
    return this.findWhere({ sale_id: saleId } as unknown as Record<string, string | number | boolean | null>);
  }

  findFeeTotal(saleId: number): number {
    const row = this.rawOne(
      'SELECT COALESCE(SUM(fee_cents), 0) AS fee FROM sale_payments WHERE sale_id = ?',
      saleId,
    ) as { fee: number };
    return row.fee;
  }

  findBySale(saleId: number): { method_name: string; method_type: string; amount_cents: number; receivable_id: number | null; points_used: number | null }[] {
    return this.raw(
      'SELECT method_name, method_type, amount_cents, receivable_id, points_used FROM sale_payments WHERE sale_id = ?',
      saleId,
    ) as { method_name: string; method_type: string; amount_cents: number; receivable_id: number | null; points_used: number | null }[];
  }
}

export const salePaymentRepository = new SalePaymentRepository();
