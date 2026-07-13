import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { productRepository } from './repositories/ProductRepository';
import { stockMovementRepository } from './repositories/StockMovementRepository';

export type MovementType = 'entrada' | 'saida' | 'ajuste';

export function moveStockRaw(
  req: Request,
  productId: number,
  type: MovementType,
  qty: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
  allowNegative = false,
): { ok: true; balance: number } | { ok: false; error: string } {
  if (!Number.isFinite(qty) || (type !== 'ajuste' && qty <= 0)) {
    return { ok: false, error: 'Quantidade inválida.' };
  }

  const product = productRepository.findByIdWithColumns(productId, 'id, name, track_stock, stock_qty') as
    | { id: number; name: string; track_stock: number; stock_qty: number } | undefined;
  if (!product) return { ok: false, error: 'Produto não encontrado.' };
  if (!product.track_stock) return { ok: false, error: 'Produto não controla estoque.' };

  const balance =
    type === 'entrada' ? product.stock_qty + qty
    : type === 'saida' ? product.stock_qty - qty
    : qty;

  if (balance < 0 && !allowNegative) {
    return { ok: false, error: `Estoque insuficiente: saldo ${product.stock_qty}, saída ${qty}.` };
  }

  productRepository.updateStock(productId, balance);
  productRepository.rawRun(
    `INSERT INTO stock_movements (product_id, type, qty, balance_after, reason, ref_entity, ref_id, user_id, uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, type, qty, balance, reason ?? null, refEntity ?? null,
    refId != null ? String(refId) : null, req.user?.id ?? null, randomUUID(),
  );
  audit(req, `estoque_${type}`, 'product', productId, { saldo: product.stock_qty }, { saldo: balance, qty, reason });
  return { ok: true, balance };
}

export function moveStock(
  req: Request,
  productId: number,
  type: MovementType,
  qty: number,
  reason?: string,
  refEntity?: string,
  refId?: string | number,
): { ok: true; balance: number } | { ok: false; error: string } {
  let result: { ok: true; balance: number } | { ok: false; error: string } = { ok: false, error: 'Falha desconhecida.' };
  productRepository.transaction(() => {
    result = moveStockRaw(req, productId, type, qty, reason, refEntity, refId);
  });
  return result;
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function recomputeStockForProducts(productIds: number[]): Promise<void> {
  for (const productId of new Set(productIds)) {
    await yieldTick();
    const movements = stockMovementRepository.listAllByProduct(productId) as { id: number; type: MovementType; qty: number }[];
    let balance = 0;
    for (const m of movements) {
      balance = m.type === 'entrada' ? balance + m.qty : m.type === 'saida' ? balance - m.qty : m.qty;
      stockMovementRepository.updateBalance(m.id, balance);
    }
    productRepository.updateStock(productId, balance);
  }
}

export function listMovements(productId?: number, limit = 100) {
  return stockMovementRepository.list(productId, limit);
}
