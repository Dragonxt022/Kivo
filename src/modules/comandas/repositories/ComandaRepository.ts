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

  /** Comanda aberta da mesa (o pedido por QR reusa a mesma conta). */
  findOpenByTable(tableId: number): Row | undefined {
    return this.rawOne(
      `SELECT id, table_id, customer_id, status, notes FROM comandas
        WHERE table_id = ? AND status = 'aberta' AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      tableId,
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

  /** Garçom avisando o caixa. `NULL` desmarca — a mesa pediu mais uma coisa. */
  setReadyForPayment(id: number, pronta: boolean): void {
    this.rawRun(
      `UPDATE comandas SET ready_for_payment_at = ${pronta ? "datetime('now')" : 'NULL'},
              updated_at = datetime('now')
        WHERE id = ?`,
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
    // `id` e `productName`: "Enviar p/ cozinha" precisa do vínculo item↔cozinha e do
    // nome para o ticket (snapshot — o produto pode mudar de nome depois).
    return this.raw(
      `SELECT id, product_id AS productId, product_name AS productName, qty, notes,
              line_group_uuid AS lineGroupUuid, unit_price_cents,
              para_viagem AS paraViagem, origem, qr_order_id AS qrOrderId
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
      "SELECT id, voided_at, product_id, line_group_uuid FROM comanda_items WHERE id = ? AND comanda_id = ? AND deleted_at IS NULL",
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

  /**
   * A divisão é por item, mas complemento e principal compartilham o `line_group_uuid`.
   * Se a seleção levar só parte do grupo, o complemento vira "principal" na comanda
   * nova (o fechamento assume o primeiro item do grupo) e o pedido sai errado.
   * Retorna true quando algum grupo tocado pela seleção ficou incompleto.
   */
  hasIncompleteLineGroup(itemIds: number[], comandaId: number): boolean {
    if (!itemIds.length) return false;
    const ph = itemIds.map(() => '?').join(',');
    const row = this.rawOne(
      `SELECT COUNT(*) AS faltando
         FROM comanda_items ci
         JOIN (
           SELECT DISTINCT line_group_uuid
             FROM comanda_items
            WHERE id IN (${ph}) AND comanda_id = ?
              AND deleted_at IS NULL AND voided_at IS NULL
              AND line_group_uuid IS NOT NULL
         ) g ON g.line_group_uuid = ci.line_group_uuid
        WHERE ci.comanda_id = ? AND ci.deleted_at IS NULL AND ci.voided_at IS NULL
          AND ci.id NOT IN (${ph})`,
      ...itemIds, comandaId, comandaId, ...itemIds,
    ) as { faltando: number } | undefined;
    return Number(row?.faltando ?? 0) > 0;
  }
}

export const comandaItemRepository = new ComandaItemRepository();
