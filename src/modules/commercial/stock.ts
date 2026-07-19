import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import { productRepository } from './repositories/ProductRepository';
import { stockMovementRepository } from './repositories/StockMovementRepository';

export type MovementType = 'entrada' | 'saida' | 'ajuste';

/** Arredonda um saldo de estoque para 6 casas decimais, evitando resíduos de ponto flutuante. */
function roundBalance(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

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

  // Produtos sem controle de estoque: ignorar silenciosamente movimentações automáticas
  // (venda, cancelamento, compra — identificadas por refEntity) e rejeitar ajustes manuais.
  if (!product.track_stock) {
    if (refEntity) return { ok: true, balance: product.stock_qty };
    return { ok: false, error: `Produto "${product.name}" não controla estoque. Ative o controle antes de realizar ajustes manuais.` };
  }

  const rawBalance =
    type === 'entrada' ? product.stock_qty + qty
    : type === 'saida' ? product.stock_qty - qty
    : qty;
  const balance = roundBalance(rawBalance);

  if (balance < 0 && !allowNegative) {
    return { ok: false, error: `Estoque insuficiente: saldo ${product.stock_qty}, saída ${qty}.` };
  }

  // Quando allowNegative=true (movimentações automáticas de venda), respeita a configuração
  // "estoque.venda_estoque_zerado": '0' = bloquear; '1' (padrão) = permitir.
  if (balance < 0 && allowNegative) {
    const permitirNegativo = settingsRepository.getBool('estoque.venda_estoque_zerado', true);
    if (!permitirNegativo) {
      return { ok: false, error: `Estoque insuficiente para "${product.name}": saldo ${product.stock_qty}, saída ${qty}. Ajuste o estoque ou habilite venda com estoque zerado nas configurações.` };
    }
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
    // Produtos sem controle de estoque não precisam ter o saldo recalculado.
    const productInfo = productRepository.findByIdWithColumns(productId, 'track_stock') as
      | { track_stock: number } | undefined;
    if (!productInfo?.track_stock) continue;

    const movements = stockMovementRepository.listAllByProduct(productId) as { id: number; type: MovementType; qty: number }[];
    let balance = 0;
    for (const m of movements) {
      const raw = m.type === 'entrada' ? balance + m.qty : m.type === 'saida' ? balance - m.qty : m.qty;
      balance = Math.round(raw * 1_000_000) / 1_000_000;
      stockMovementRepository.updateBalance(m.id, balance);
    }
    productRepository.updateStock(productId, balance);
  }
}

export function listMovements(productId?: number, limit = 100) {
  return stockMovementRepository.list(productId, limit);
}
