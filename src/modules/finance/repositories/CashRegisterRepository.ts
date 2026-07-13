import { BaseRepository, type Row } from '../../../core/database/repository';

export class CashRegisterRepository extends BaseRepository {
  constructor() {
    super('cash_registers');
  }

  findCurrent(): Row | undefined {
    return this.rawOne(
      "SELECT * FROM cash_registers WHERE status = 'aberto' AND deleted_at IS NULL LIMIT 1",
    );
  }

  findDetail(id: number): Row | undefined {
    const row = this.rawOne(
      `SELECT r.id, r.status, r.opening_cents, r.opened_at, ou.username AS opened_by_name,
              r.closed_at, cu.username AS closed_by_name, r.expected_cents, r.counted_cents,
              r.difference_cents, r.notes, r.count_breakdown
       FROM cash_registers r
       LEFT JOIN users ou ON ou.id = r.opened_by
       LEFT JOIN users cu ON cu.id = r.closed_by
       WHERE r.id = ? AND r.deleted_at IS NULL`,
      id,
    );
    if (!row) return undefined;
    let countBreakdown: Record<string, number> | null = null;
    if (row.count_breakdown) {
      try { countBreakdown = JSON.parse(row.count_breakdown as string); }
      catch { countBreakdown = null; }
    }
    return { ...row, count_breakdown: countBreakdown };
  }

  listHistory(): Row[] {
    return this.raw(
      `SELECT r.id, r.status, r.opened_at, r.opening_cents, r.closed_at, r.expected_cents,
              r.counted_cents, r.difference_cents, r.edited_at, r.notes,
              uo.username AS opened_by, uc.username AS closed_by, ue.username AS edited_by_name
       FROM cash_registers r
       LEFT JOIN users uo ON uo.id = r.opened_by
       LEFT JOIN users uc ON uc.id = r.closed_by
       LEFT JOIN users ue ON ue.id = r.edited_by
       WHERE r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 500`,
    );
  }

  close(id: number, closedBy: number, expected: number, counted: number, difference: number, notes: string | null, breakdownJson: string | null): void {
    this.rawRun(
      `UPDATE cash_registers SET status = 'fechado', closed_by = ?, closed_at = datetime('now'),
         expected_cents = ?, counted_cents = ?, difference_cents = ?, notes = COALESCE(?, notes),
         count_breakdown = ?, updated_at = datetime('now')
       WHERE id = ?`,
      closedBy, expected, counted, difference, notes, breakdownJson, id,
    );
  }

  editClosed(id: number, counted: number, difference: number, notes: string | null, userId: number): void {
    this.rawRun(
      `UPDATE cash_registers SET counted_cents = ?, difference_cents = ?, notes = COALESCE(?, notes),
         edited_at = datetime('now'), edited_by = ?, updated_at = datetime('now') WHERE id = ?`,
      counted, difference, notes, userId, id,
    );
  }
}

export const cashRegisterRepository = new CashRegisterRepository();

export class CashMovementRepository extends BaseRepository {
  constructor() {
    super('cash_movements');
  }

  listByRegister(registerId: number): Row[] {
    return this.raw(
      `SELECT m.id, m.direction, m.type, m.amount_cents, m.description, m.ref_entity, m.ref_id,
              u.username, m.created_at
       FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.register_id = ? ORDER BY m.id DESC`,
      registerId,
    );
  }

  totals(registerId: number): { entradas: number; saidas: number } {
    return this.rawOne(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'entrada' THEN amount_cents END), 0) AS entradas,
         COALESCE(SUM(CASE WHEN direction = 'saida' THEN amount_cents END), 0) AS saidas
       FROM cash_movements WHERE register_id = ?`,
      registerId,
    ) as { entradas: number; saidas: number };
  }

  cashflow(from: string, to: string): Row[] {
    return this.raw(
      `SELECT date(created_at) AS day,
              COALESCE(SUM(CASE WHEN direction = 'entrada' THEN amount_cents END), 0) AS entradas,
              COALESCE(SUM(CASE WHEN direction = 'saida' THEN amount_cents END), 0) AS saidas
       FROM cash_movements
       WHERE date(created_at) BETWEEN ? AND ?
       GROUP BY date(created_at) ORDER BY day`,
      from, to,
    );
  }
}

export const cashMovementRepository = new CashMovementRepository();
