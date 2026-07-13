import { BaseRepository, type Row } from '../../../core/database/repository';

export class StockMovementRepository extends BaseRepository {
  constructor() {
    super('stock_movements');
  }

  list(productId?: number, limit = 100): Row[] {
    const base = `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.qty, m.balance_after,
                         m.reason, m.ref_entity, m.ref_id, u.username, m.created_at
                  FROM stock_movements m
                  JOIN products p ON p.id = m.product_id
                  LEFT JOIN users u ON u.id = m.user_id`;
    if (productId) {
      return this.raw(`${base} WHERE m.product_id = ? ORDER BY m.id DESC LIMIT ?`, productId, limit);
    }
    return this.raw(`${base} ORDER BY m.id DESC LIMIT ?`, limit);
  }

  findByRef(refEntity: string, refId: string | number): Row[] {
    return this.raw(
      `SELECT product_id, qty, type FROM stock_movements WHERE ref_entity = ? AND ref_id = ?`,
      refEntity, String(refId),
    );
  }

  findMovementQtysByRef(refEntity: string, refId: string | number): { product_id: number; qty: number }[] {
    return this.raw(
      `SELECT product_id, qty FROM stock_movements WHERE ref_entity = ? AND ref_id = ? AND type = 'saida'`,
      refEntity, String(refId),
    ) as { product_id: number; qty: number }[];
  }

  listAllByProduct(productId: number): Row[] {
    return this.raw(
      'SELECT id, type, qty FROM stock_movements WHERE product_id = ? ORDER BY created_at, uuid',
      productId,
    );
  }

  updateBalance(id: number, balance: number): void {
    this.rawRun('UPDATE stock_movements SET balance_after = ? WHERE id = ?', balance, id);
  }
}

export const stockMovementRepository = new StockMovementRepository();

export class CustomerCreditMovementRepository extends BaseRepository {
  constructor() {
    super('customer_credit_movements');
  }

  listByCustomer(customerId: number, limit = 100): Row[] {
    return this.raw(
      `SELECT id, type, amount_cents AS amount, balance_after, reason, ref_entity, ref_id, created_at
       FROM customer_credit_movements WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
      customerId, limit,
    );
  }

  listAllByCustomer(customerId: number): { id: number; type: string; amount: number }[] {
    return this.raw(
      `SELECT id, type, amount_cents AS amount FROM customer_credit_movements WHERE customer_id = ? ORDER BY created_at, uuid`,
      customerId,
    ) as { id: number; type: string; amount: number }[];
  }
}

export const customerCreditMovementRepository = new CustomerCreditMovementRepository();

export class LoyaltyPointMovementRepository extends BaseRepository {
  constructor() {
    super('loyalty_point_movements');
  }

  listByCustomer(customerId: number, limit = 100): Row[] {
    return this.raw(
      `SELECT id, type, points AS amount, balance_after, reason, ref_entity, ref_id, created_at
       FROM loyalty_point_movements WHERE customer_id = ? ORDER BY id DESC LIMIT ?`,
      customerId, limit,
    );
  }

  listAllByCustomer(customerId: number): { id: number; type: string; amount: number }[] {
    return this.raw(
      `SELECT id, type, points AS amount FROM loyalty_point_movements WHERE customer_id = ? ORDER BY created_at, uuid`,
      customerId,
    ) as { id: number; type: string; amount: number }[];
  }

  findEarnedByRef(refEntity: string, refId: string | number): number {
    const row = this.rawOne(
      `SELECT COALESCE(SUM(points), 0) AS pts FROM loyalty_point_movements WHERE ref_entity = ? AND ref_id = ? AND type = 'ganho'`,
      refEntity, String(refId),
    ) as { pts: number } | undefined;
    return row?.pts ?? 0;
  }
}

export const loyaltyPointMovementRepository = new LoyaltyPointMovementRepository();
