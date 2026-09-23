import { randomUUID } from 'node:crypto';
import { BaseRepository, type Row } from '../../../core/database/repository';

export interface ProductLotRow extends Row {
  id: number;
  product_id: number;
  code: string | null;
  expires_at: string | null;
  qty: number;
  cost_cents: number;
  supplier_id: number | null;
  ref_entity: string | null;
  ref_id: string | null;
  received_at: string;
}

/** Um pedaço consumido de um lote por uma saída/ajuste. */
export interface LotConsumption {
  lotId: number;
  qty: number;
  costCents: number;
}

export interface ReceiveLotInput {
  productId: number;
  code: string | null;
  expiresAt: string | null;
  qty: number;
  costCents: number;
  supplierId?: number | null;
  refEntity?: string | null;
  refId?: string | number | null;
}

/**
 * Lotes de estoque (produtos com `controla_lote`). A ENTRADA reabastece o lote de mesmo
 * produto+código+validade (custo vira média ponderada); a SAÍDA consome em FIFO/FEFO
 * (validade mais próxima primeiro, depois o lote mais antigo) e registra o que saiu.
 *
 * Nenhuma função aqui abre transação própria: rodam dentro da transação de `moveStockRaw`.
 */
export class LotRepository extends BaseRepository<ProductLotRow> {
  constructor() {
    super('product_lots');
  }

  /** Lotes com saldo, na ordem de consumo (validade mais próxima; sem validade por último). */
  listByProduct(productId: number): ProductLotRow[] {
    return this.raw(
      `SELECT id, product_id, code, expires_at, qty, cost_cents, supplier_id, ref_entity, ref_id, received_at
         FROM product_lots
        WHERE product_id = ? AND deleted_at IS NULL AND qty > 0
        ORDER BY (expires_at IS NULL), expires_at, received_at, id`,
      productId,
    ) as unknown as ProductLotRow[];
  }

  /** Lotes com validade dentro de `days` (ou já vencidos) — base do alerta de validade. */
  listExpiring(days: number): (ProductLotRow & { product_name: string })[] {
    return this.raw(
      `SELECT l.id, l.product_id, l.code, l.expires_at, l.qty, l.cost_cents, l.received_at,
              p.name AS product_name
         FROM product_lots l JOIN products p ON p.id = l.product_id
        WHERE l.deleted_at IS NULL AND l.qty > 0 AND l.expires_at IS NOT NULL
          AND date(l.expires_at) <= date('now', '+' || ? || ' days')
        ORDER BY l.expires_at`,
      days,
    ) as unknown as (ProductLotRow & { product_name: string })[];
  }

  /** Cria o lote ou reabastece o de mesmo produto+código+validade (custo = média ponderada). */
  receive(input: ReceiveLotInput): number {
    const code = input.code?.trim() || null;
    const expiresAt = input.expiresAt?.trim() || null;
    const existing = this.rawOne(
      `SELECT id, qty, cost_cents FROM product_lots
        WHERE product_id = ? AND deleted_at IS NULL
          AND COALESCE(code, '') = COALESCE(?, '')
          AND COALESCE(expires_at, '') = COALESCE(?, '')
        LIMIT 1`,
      input.productId, code, expiresAt,
    ) as { id: number; qty: number; cost_cents: number } | undefined;

    if (existing) {
      const beforeQty = Number(existing.qty);
      const newQty = beforeQty + input.qty;
      const weighted = newQty > 0
        ? Math.round((beforeQty * Number(existing.cost_cents) + input.qty * input.costCents) / newQty)
        : input.costCents;
      this.rawRun(
        `UPDATE product_lots SET qty = ?, cost_cents = ?, updated_at = datetime('now') WHERE id = ?`,
        newQty, weighted, existing.id,
      );
      return existing.id;
    }

    const info = this.rawRun(
      `INSERT INTO product_lots (product_id, code, expires_at, qty, cost_cents, supplier_id, ref_entity, ref_id, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.productId, code, expiresAt, input.qty, input.costCents,
      input.supplierId ?? null, input.refEntity ?? null,
      input.refId != null ? String(input.refId) : null, randomUUID(),
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * Consome em FIFO/FEFO. Pode consumir MENOS que o pedido quando não há lote suficiente
   * (o chamador decide se aceita saldo negativo). Não registra o consumo — quem registra é
   * `recordConsumption`, depois de existir o id do movimento.
   */
  consumeFifo(productId: number, qty: number): LotConsumption[] {
    const out: LotConsumption[] = [];
    let remaining = qty;
    for (const lot of this.listByProduct(productId)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(lot.qty));
      if (!(take > 0)) continue;
      this.rawRun(`UPDATE product_lots SET qty = qty - ?, updated_at = datetime('now') WHERE id = ?`, take, lot.id);
      out.push({ lotId: lot.id, qty: take, costCents: Number(lot.cost_cents) });
      remaining -= take;
    }
    return out;
  }

  recordConsumption(movementId: number, productId: number, c: LotConsumption): void {
    this.rawRun(
      `INSERT INTO lot_consumptions (product_id, lot_id, movement_id, qty, unit_cost_cents, uuid)
       VALUES (?, ?, ?, ?, ?, ?)`,
      productId, c.lotId, movementId, c.qty, c.costCents, randomUUID(),
    );
  }

  /** Devolve quantidade a um lote (estorno de saída). */
  restore(lotId: number, qty: number): void {
    this.rawRun(`UPDATE product_lots SET qty = qty + ?, updated_at = datetime('now') WHERE id = ?`, qty, lotId);
  }
}

export const lotRepository = new LotRepository();
