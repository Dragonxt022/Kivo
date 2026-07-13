import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { audit } from '../../core/audit/service';

export type MovementType = 'entrada' | 'saida' | 'ajuste';

/**
 * Lógica bruta de movimentação de estoque — SEM transação própria.
 * Usada internamente por callers que já estão dentro de uma transação
 * (ex.: createSale, cancelSale, purchases).
 */
export function moveStockRaw(
  req: Request,
  productId: number,
  type: MovementType,
  qty: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
  /** Permite saldo negativo (ex.: venda no PDV não pode travar por falta de estoque). */
  allowNegative = false,
): { ok: true; balance: number } | { ok: false; error: string } {
  if (!Number.isFinite(qty) || (type !== 'ajuste' && qty <= 0)) {
    return { ok: false, error: 'Quantidade inválida.' };
  }
  const db = getSqlite();

  const product = db
    .prepare('SELECT id, name, track_stock, stock_qty FROM products WHERE id = ? AND deleted_at IS NULL')
    .get(productId) as { id: number; name: string; track_stock: number; stock_qty: number } | undefined;
  if (!product) return { ok: false, error: 'Produto não encontrado.' };
  if (!product.track_stock) return { ok: false, error: 'Produto não controla estoque.' };

  const balance =
    type === 'entrada' ? product.stock_qty + qty
    : type === 'saida' ? product.stock_qty - qty
    : qty;

  if (balance < 0 && !allowNegative) {
    return { ok: false, error: `Estoque insuficiente: saldo ${product.stock_qty}, saída ${qty}.` };
  }

  db.prepare(`UPDATE products SET stock_qty = ?, updated_at = datetime('now') WHERE id = ?`).run(balance, productId);
  db.prepare(
    `INSERT INTO stock_movements (product_id, type, qty, balance_after, reason, ref_entity, ref_id, user_id, uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    productId,
    type,
    qty,
    balance,
    reason ?? null,
    refEntity ?? null,
    refId != null ? String(refId) : null,
    req.user?.id ?? null,
    randomUUID(),
  );
  audit(req, `estoque_${type}`, 'product', productId, { saldo: product.stock_qty }, { saldo: balance, qty, reason });
  return { ok: true, balance };
}

/**
 * Movimentação de estoque consistente com transação própria (DoD Fase 3).
 * Para chamadas diretas da API (POST /stock/move).
 * Se você já está dentro de uma transação, use `moveStockRaw` em vez desta.
 */
export function moveStock(
  req: Request,
  productId: number,
  type: MovementType,
  qty: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): { ok: true; balance: number } | { ok: false; error: string } {
  const db = getSqlite();
  let result: { ok: true; balance: number } | { ok: false; error: string } = { ok: false, error: 'Falha desconhecida.' };

  db.transaction(() => {
    result = moveStockRaw(req, productId, type, qty, reason, refEntity, refId);
  })();

  return result;
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Recomputa stock_qty de um produto a partir do replay cronológico do ledger
 * (stock_movements). Usado pelo motor de sync (Fase 6a): stock_qty nunca viaja na
 * rede — cada máquina reconstrói o mesmo saldo a partir do conjunto de movimentos
 * mesclado, independente de quem sincronizou primeiro (evita perda de baixas
 * concorrentes por sobrescrita de linha inteira).
 */
export async function recomputeStockForProducts(productIds: number[]): Promise<void> {
  const db = getSqlite();
  const updateBalance = db.prepare('UPDATE stock_movements SET balance_after = ? WHERE id = ?');
  const updateProduct = db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?');
  for (const productId of new Set(productIds)) {
    await yieldTick();
    const movements = db
      .prepare('SELECT id, type, qty FROM stock_movements WHERE product_id = ? ORDER BY created_at, uuid')
      .all(productId) as { id: number; type: MovementType; qty: number }[];
    let balance = 0;
    for (const m of movements) {
      balance = m.type === 'entrada' ? balance + m.qty : m.type === 'saida' ? balance - m.qty : m.qty;
      updateBalance.run(balance, m.id);
    }
    updateProduct.run(balance, productId);
  }
}

export function listMovements(productId?: number, limit = 100) {
  const db = getSqlite();
  const base = `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.qty, m.balance_after,
                       m.reason, m.ref_entity, m.ref_id, u.username, m.created_at
                FROM stock_movements m
                JOIN products p ON p.id = m.product_id
                LEFT JOIN users u ON u.id = m.user_id`;
  return productId
    ? db.prepare(`${base} WHERE m.product_id = ? ORDER BY m.id DESC LIMIT ?`).all(productId, limit)
    : db.prepare(`${base} ORDER BY m.id DESC LIMIT ?`).all(limit);
}
