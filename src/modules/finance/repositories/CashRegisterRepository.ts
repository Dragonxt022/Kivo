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

  /**
   * Histórico de turnos. O período (from/to) casa por sobreposição: um caixa aberto
   * ontem e fechado hoje aparece tanto no filtro de ontem quanto no de hoje. Filtrar
   * só pela data de abertura esconderia o turno que mais importa — o que virou a noite.
   */
  listHistory(from?: string, to?: string): Row[] {
    const conditions = ['r.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (from) {
      conditions.push("date(COALESCE(r.closed_at, datetime('now')), 'localtime') >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("date(r.opened_at, 'localtime') <= ?");
      params.push(to);
    }
    return this.raw(
      `SELECT r.id, r.status, r.opened_at, r.opening_cents, r.closed_at,
              -- Turno aberto ainda não tem expected_cents gravado: calcula do livro-razão
              -- para o histórico não mostrar R$ 0,00 enquanto a gaveta tem dinheiro.
              CASE WHEN r.status = 'aberto' THEN (
                SELECT COALESCE(SUM(CASE WHEN m.direction = 'entrada' THEN m.amount_cents ELSE -m.amount_cents END), 0)
                  FROM cash_movements m WHERE m.register_id = r.id
              ) ELSE r.expected_cents END AS expected_cents,
              r.counted_cents, r.difference_cents, r.edited_at, r.notes,
              uo.username AS opened_by, uc.username AS closed_by, ue.username AS edited_by_name
       FROM cash_registers r
       LEFT JOIN users uo ON uo.id = r.opened_by
       LEFT JOIN users uc ON uc.id = r.closed_by
       LEFT JOIN users ue ON ue.id = r.edited_by
       WHERE ${conditions.join(' AND ')} ORDER BY r.id DESC LIMIT 500`,
      ...params,
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

  listByRegister(registerId: number, from?: string, to?: string): Row[] {
    const conditions = ['m.register_id = ?'];
    const params: unknown[] = [registerId];
    if (from) { conditions.push("date(m.created_at, 'localtime') >= ?"); params.push(from); }
    if (to) { conditions.push("date(m.created_at, 'localtime') <= ?"); params.push(to); }
    return this.raw(
      `SELECT m.id, m.direction, m.type, m.amount_cents, m.description, m.ref_entity, m.ref_id,
              u.username, m.created_at
       FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id
       WHERE ${conditions.join(' AND ')} ORDER BY m.id DESC`,
      ...params,
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

  /** Livro caixa (movimentos) por período e, opcionalmente, por caixa. Para exportação. */
  listLedger(from: string, to: string, registerId?: number): Row[] {
    const conditions = ["date(m.created_at, 'localtime') BETWEEN ? AND ?"];
    const params: unknown[] = [from, to];
    if (registerId) { conditions.push('m.register_id = ?'); params.push(registerId); }
    return this.raw(
      `SELECT m.id, m.register_id, m.created_at, m.direction, m.type, m.amount_cents, m.description,
              m.ref_entity, m.ref_id, u.username
         FROM cash_movements m LEFT JOIN users u ON u.id = m.user_id
        WHERE ${conditions.join(' AND ')} ORDER BY m.id`,
      ...params,
    );
  }

  cashflow(from: string, to: string): Row[] {
    return this.raw(
      `SELECT date(created_at, 'localtime') AS day,
              COALESCE(SUM(CASE WHEN direction = 'entrada' THEN amount_cents END), 0) AS entradas,
              COALESCE(SUM(CASE WHEN direction = 'saida' THEN amount_cents END), 0) AS saidas
       FROM cash_movements
       WHERE date(created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY date(created_at, 'localtime') ORDER BY day`,
      from, to,
    );
  }
}

export const cashMovementRepository = new CashMovementRepository();
