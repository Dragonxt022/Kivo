import { BaseRepository, type Row } from '../../../core/database/repository';

export class ComandaRepository extends BaseRepository {
  constructor() {
    super('comandas');
  }

  findOpen(id: number): Row | undefined {
    return this.rawOne(
      "SELECT id, table_id, customer_id, status, notes FROM comandas WHERE id = ? AND status = 'aberta' AND deleted_at IS NULL",
      id,
    );
  }

  close(id: number, saleId: number): void {
    this.rawRun(
      "UPDATE comandas SET status = 'fechada', sale_id = ?, closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      saleId, id,
    );
  }

  cancel(id: number): void {
    this.rawRun(
      "UPDATE comandas SET status = 'cancelada', updated_at = datetime('now') WHERE id = ?",
      id,
    );
  }

  transferTable(id: number, targetTableId: number): void {
    this.rawRun(
      "UPDATE comandas SET table_id = ?, updated_at = datetime('now') WHERE id = ?",
      targetTableId, id,
    );
  }
}

export const comandaRepository = new ComandaRepository();

export class ComandaItemRepository extends BaseRepository {
  constructor() {
    super('comanda_items');
  }

  listActiveByComanda(comandaId: number): Row[] {
    return this.raw(
      `SELECT product_id AS productId, qty, notes, line_group_uuid AS lineGroupUuid, unit_price_cents
       FROM comanda_items WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL ORDER BY id`,
      comandaId,
    );
  }

  moveToComanda(ids: number[], targetComandaId: number): void {
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    this.rawRun(
      `UPDATE comanda_items SET comanda_id = ?, updated_at = datetime('now') WHERE id IN (${ph})`,
      targetComandaId, ...ids,
    );
  }

  mergeIntoComanda(sourceComandaId: number, targetComandaId: number): void {
    this.rawRun(
      `UPDATE comanda_items SET comanda_id = ?, updated_at = datetime('now')
       WHERE comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL`,
      targetComandaId, sourceComandaId,
    );
  }

  findInComanda(itemId: number, comandaId: number): Row | undefined {
    return this.rawOne(
      "SELECT id, voided_at FROM comanda_items WHERE id = ? AND comanda_id = ? AND deleted_at IS NULL",
      itemId, comandaId,
    );
  }

  void(id: number): void {
    this.rawRun("UPDATE comanda_items SET voided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", id);
  }

  validateBelongToComanda(itemIds: number[], comandaId: number): number {
    if (!itemIds.length) return 0;
    const ph = itemIds.map(() => '?').join(',');
    const rows = this.raw(
      `SELECT id FROM comanda_items WHERE id IN (${ph}) AND comanda_id = ? AND deleted_at IS NULL AND voided_at IS NULL`,
      ...itemIds, comandaId,
    ) as { id: number }[];
    return rows.length;
  }
}

export const comandaItemRepository = new ComandaItemRepository();
