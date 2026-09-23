import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { audit } from '../../core/audit/service';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import { productRepository } from './repositories/ProductRepository';
import { stockMovementRepository } from './repositories/StockMovementRepository';
import { lotRepository, type LotConsumption, type ProductLotRow } from './repositories/LotRepository';

export type MovementType = 'entrada' | 'saida' | 'ajuste';

/** Lote informado numa entrada/ajuste de produto que controla lote. */
export interface StockLotInput {
  code?: string | null;
  /** Validade no formato YYYY-MM-DD. */
  expiresAt?: string | null;
  /** Custo unitário do lote em centavos (sem isso, usa o custo atual do produto). */
  costCents?: number | null;
  supplierId?: number | null;
}

/** Arredonda um saldo de estoque para 6 casas decimais, evitando resíduos de ponto flutuante. */
function roundBalance(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

function normalizeLotDate(value: string | null | undefined): string | null {
  const t = (value ?? '').trim();
  if (!t) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/** Validade anterior a hoje (comparação lexicográfica de YYYY-MM-DD é segura). */
function isExpired(expiresAt: string | null | undefined): boolean {
  const d = normalizeLotDate(expiresAt);
  if (!d) return false;
  return d < new Date().toISOString().slice(0, 10);
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
  lot: StockLotInput | null = null,
  opts: { skipLot?: boolean } = {},
): { ok: true; balance: number } | { ok: false; error: string } {
  if (!Number.isFinite(qty) || (type !== 'ajuste' && qty <= 0)) {
    return { ok: false, error: 'Quantidade inválida.' };
  }

  const product = productRepository.findByIdWithColumns(productId, 'id, name, track_stock, stock_qty, cost_cents, controla_lote') as
    | { id: number; name: string; track_stock: number; stock_qty: number; cost_cents: number; controla_lote: number } | undefined;
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

  // ── Lotes (só para produtos com `controla_lote`) ──────────────────────────────
  // Toda a validação acontece ANTES de mexer nos lotes: assim uma saída recusada não
  // consome lote nenhum. As mutações rodam dentro da transação de quem chamou.
  const controlled = Number(product.controla_lote) === 1;
  const lotObrigatorio = controlled && settingsRepository.getBool('estoque.lote_obrigatorio', false);
  // Exige lote nas entradas de origem manual/compra. Estornos (devolução, reversão de
  // NF-e, cancelamento) não têm lote de origem e não podem ser barrados.
  const lotRequiredHere = lotObrigatorio && type === 'entrada' && (refEntity == null || refEntity === 'purchase');
  if (lotRequiredHere && !(lot?.code ?? '').trim()) {
    return { ok: false, error: `Produto "${product.name}" exige lote: informe o código do lote na entrada.` };
  }

  const decreasing = type === 'saida' || (type === 'ajuste' && balance < product.stock_qty);
  if (controlled && decreasing) {
    const blockExpired = (settingsRepository.get('estoque.validade_acao') ?? 'sugerir_baixa') === 'bloquear';
    if (blockExpired) {
      const first = lotRepository.listByProduct(productId)[0];
      if (first && isExpired(first.expires_at)) {
        return {
          ok: false,
          error: `O lote ${first.code ?? first.id} de "${product.name}" está vencido (${first.expires_at}). ` +
            'Dê baixa no lote ou ajuste a política de vencimento em Configurações › Estoque.',
        };
      }
    }
  }

  let entryLotId: number | null = null;
  let consumptions: LotConsumption[] = [];
  if (controlled) {
    if (type === 'entrada' && opts.skipLot) {
      // Estorno (cancelamento/devolução): o lote de origem é devolvido por
      // `restoreLotsForSale`, então aqui NÃO se cria um lote novo.
    } else if (type === 'entrada' || (type === 'ajuste' && balance > product.stock_qty)) {
      const entryQty = type === 'entrada' ? qty : roundBalance(balance - product.stock_qty);
      entryLotId = lotRepository.receive({
        productId,
        code: lot?.code ?? null,
        expiresAt: normalizeLotDate(lot?.expiresAt),
        qty: entryQty,
        costCents: lot?.costCents != null ? Math.round(lot.costCents) : Math.round(product.cost_cents ?? 0),
        supplierId: lot?.supplierId ?? null,
        refEntity: refEntity ?? null,
        refId: refId ?? null,
      });
    } else if (decreasing) {
      const consumeQty = type === 'saida' ? qty : roundBalance(product.stock_qty - balance);
      consumptions = lotRepository.consumeFifo(productId, consumeQty);
    }
  }

  productRepository.updateStock(productId, balance);
  const info = productRepository.rawRun(
    `INSERT INTO stock_movements (product_id, type, qty, balance_after, reason, ref_entity, ref_id, user_id, uuid, lot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, type, qty, balance, reason ?? null, refEntity ?? null,
    refId != null ? String(refId) : null, req.user?.id ?? null, randomUUID(), entryLotId,
  );
  if (consumptions.length) {
    const movementId = Number(info.lastInsertRowid);
    for (const c of consumptions) lotRepository.recordConsumption(movementId, productId, c);
  }
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
  lot: StockLotInput | null = null,
  opts: { skipLot?: boolean } = {},
): { ok: true; balance: number } | { ok: false; error: string } {
  let result: { ok: true; balance: number } | { ok: false; error: string } = { ok: false, error: 'Falha desconhecida.' };
  productRepository.transaction(() => {
    result = moveStockRaw(req, productId, type, qty, reason, refEntity, refId, false, lot, opts);
  });
  return result;
}

/** Lotes ativos de um produto (para a tela e para a conferência de validade). */
export function listLots(productId: number): ProductLotRow[] {
  return lotRepository.listByProduct(productId);
}

/**
 * Devolve aos LOTES DE ORIGEM a quantidade estornada de uma venda, usando os consumos
 * registrados (`lot_consumptions`): recria/reabastece cada lote com o código, a validade e
 * o custo originais, em vez de criar um lote novo. Cada consumo usado é reduzido (e some
 * quando zera), então devoluções parciais repetidas não duplicam a devolução.
 *
 * Devolve quanto foi efetivamente restaurado — pode ser menor que `qty` se não houver
 * consumo registrado (produto sem lote). O saldo do produto NÃO é mexido aqui: quem faz a
 * entrada é o chamador (com `skipLot` para não criar lote novo).
 */
export function restoreLotsForSale(
  productId: number,
  qty: number,
  refEntity: string,
  refId: string | number,
): number {
  if (!(qty > 0)) return 0;
  const consumos = lotRepository.raw(
    `SELECT lc.id, lc.qty, lc.unit_cost_cents, pl.code, pl.expires_at
       FROM lot_consumptions lc
       JOIN stock_movements sm ON sm.id = lc.movement_id
       LEFT JOIN product_lots pl ON pl.id = lc.lot_id
      WHERE sm.ref_entity = ? AND sm.ref_id = ? AND lc.product_id = ? AND lc.deleted_at IS NULL
      ORDER BY lc.id DESC`,
    refEntity, String(refId), productId,
  ) as unknown as { id: number; qty: number; unit_cost_cents: number; code: string | null; expires_at: string | null }[];

  let remaining = qty;
  let restored = 0;
  for (const c of consumos) {
    if (remaining <= 0) break;
    const available = Number(c.qty);
    if (!(available > 0)) continue;
    const take = Math.min(remaining, available);
    lotRepository.receive({
      productId, code: c.code, expiresAt: c.expires_at,
      qty: take, costCents: Number(c.unit_cost_cents),
    });
    if (take >= available - 1e-9) {
      lotRepository.rawRun(
        "UPDATE lot_consumptions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        c.id,
      );
    } else {
      lotRepository.rawRun(
        "UPDATE lot_consumptions SET qty = qty - ?, updated_at = datetime('now') WHERE id = ?",
        take, c.id,
      );
    }
    remaining -= take;
    restored += take;
  }
  return restored;
}

/** O método de custo configurado é FIFO? (Configurações › Estoque). */
export function fifoCostEnabled(): boolean {
  return (settingsRepository.get('estoque.metodo_custo') ?? 'medio') === 'fifo';
}

/**
 * Custo unitário que a próxima saída de `qty` vai consumir, em FIFO/FEFO — SEM consumir.
 * Espelha a ordem de `moveStockRaw` para o custo da venda bater com o lote que sai. O que
 * não houver em lote cai no custo de reposição (`fallbackCents`).
 */
export function fifoUnitCostCents(productId: number, qty: number, fallbackCents: number): number {
  if (!(qty > 0)) return fallbackCents;
  let remaining = qty;
  let total = 0;
  for (const lot of lotRepository.listByProduct(productId)) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(lot.qty));
    if (!(take > 0)) continue;
    total += take * Number(lot.cost_cents);
    remaining -= take;
  }
  if (remaining > 0) total += remaining * fallbackCents;
  return Math.round(total / qty);
}

/** Lotes vencendo dentro do prazo configurado (ou já vencidos). */
export function listExpiringLots(days?: number): (ProductLotRow & { product_name: string })[] {
  const d = days ?? Number(settingsRepository.get('estoque.validade_alerta_dias') ?? 30);
  return lotRepository.listExpiring(Number.isFinite(d) && d >= 0 ? d : 30);
}

/**
 * Dá baixa em um lote inteiro (perda/vencimento): zera o lote, subtrai o saldo do produto e
 * registra a movimentação + o consumo. É explícita — não passa pela checagem de saldo
 * negativo da venda, porque a baixa é justamente para tirar o que não se vende.
 */
export function writeOffLot(
  req: Request,
  lotId: number,
  reason?: string,
): { ok: true; qty: number } | { ok: false; error: string } {
  const lot = lotRepository.findById(lotId) as ProductLotRow | undefined;
  if (!lot) return { ok: false, error: 'Lote não encontrado.' };
  const qty = Number(lot.qty);
  if (!(qty > 0)) return { ok: false, error: 'Lote já está zerado.' };
  const product = productRepository.findByIdWithColumns(lot.product_id, 'id, name, track_stock, stock_qty') as
    | { id: number; name: string; track_stock: number; stock_qty: number } | undefined;
  if (!product) return { ok: false, error: 'Produto do lote não encontrado.' };

  productRepository.transaction(() => {
    const balance = roundBalance(Number(product.stock_qty) - qty);
    productRepository.updateStock(product.id, balance);
    const info = productRepository.rawRun(
      `INSERT INTO stock_movements (product_id, type, qty, balance_after, reason, ref_entity, ref_id, user_id, uuid)
       VALUES (?, 'saida', ?, ?, ?, 'lot_writeoff', ?, ?, ?)`,
      product.id, qty, balance, reason?.trim() || 'baixa de lote', String(lotId),
      req.user?.id ?? null, randomUUID(),
    );
    lotRepository.rawRun("UPDATE product_lots SET qty = 0, updated_at = datetime('now') WHERE id = ?", lotId);
    lotRepository.recordConsumption(Number(info.lastInsertRowid), product.id, {
      lotId, qty, costCents: Number(lot.cost_cents),
    });
    audit(req, 'estoque_baixa_lote', 'product', product.id, { lote: lot.code, qty }, { saldo: balance });
  });
  return { ok: true, qty };
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
