import { BaseRepository, type Row } from '../../../core/database/repository';

export class CustomerRepository extends BaseRepository {
  constructor() {
    super('customers');
  }

  updateBalance(id: number | string, column: string, balance: number): void {
    this.rawRun(`UPDATE customers SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`, balance, id);
  }

  getNegativeBalances(): Row[] {
    return this.raw(
      `SELECT id, name, store_credit_cents, loyalty_points FROM customers
       WHERE deleted_at IS NULL AND (store_credit_cents < 0 OR loyalty_points < 0)
       ORDER BY name`,
    );
  }
}

export const customerRepository = new CustomerRepository();
