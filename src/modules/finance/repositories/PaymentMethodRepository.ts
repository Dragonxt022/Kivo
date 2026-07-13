import { BaseRepository, type Row } from '../../../core/database/repository';

export class PaymentMethodRepository extends BaseRepository {
  constructor() {
    super('payment_methods');
  }

  listActive(): Row[] {
    return this.raw(
      'SELECT id, name, type, fee_bps FROM payment_methods WHERE active = 1 AND deleted_at IS NULL ORDER BY sort, name',
    );
  }

  listActiveLite(): Row[] {
    return this.raw(
      "SELECT id, name, type FROM payment_methods WHERE active = 1 AND deleted_at IS NULL AND type != 'prazo' ORDER BY sort, name",
    );
  }

  listAll(): Row[] {
    return this.raw(
      'SELECT id, name, type, fee_bps, active, sort FROM payment_methods WHERE deleted_at IS NULL ORDER BY sort, name',
    );
  }

  findActive(id: number): Row | undefined {
    return this.rawOne(
      'SELECT id, name, type, fee_bps FROM payment_methods WHERE id = ? AND active = 1 AND deleted_at IS NULL',
      id,
    );
  }

  findByType(type: string): Row | undefined {
    return this.rawOne(
      'SELECT id, name, type, fee_bps FROM payment_methods WHERE type = ? AND active = 1 AND deleted_at IS NULL ORDER BY sort, name LIMIT 1',
      type,
    );
  }
}

export const paymentMethodRepository = new PaymentMethodRepository();
