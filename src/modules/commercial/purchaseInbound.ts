import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { sumCents } from '../../shared/money';
import { moveStockRaw } from './stock';
import { purchaseRepository, purchaseItemRepository } from './repositories/PurchaseRepository';
import { productRepository } from './repositories/ProductRepository';

/**
 * Entrada de compra (recebida) — domínio compartilhado entre as rotas de compra e a
 * importação de NF-e. Como a regra de custo médio é delicada (alimenta o CMV do DRE),
 * ela vive num único lugar: quem precisa "comprar" (rota /api/commercial/purchases ou
 * o módulo nfe) usa estas funções. Nenhuma delas abre transação quando não for a dona
 * do COMMIT — a função com transação própria é `createPurchaseInbound`; as demais são
 * pensadas para rodar DENTRO da transação de quem chamou.
 */

/**
 * Custo médio ponderado móvel: novo custo = (saldo × custo atual + entrada × custo da
 * compra) / (saldo + entrada). Média não faz sentido (volta ao custo da compra) quando
 * o saldo é <= 0, o custo atual é 0 (1ª compra) ou o produto não controla estoque.
 */
export function weightedAverageCostCents(
  saldoAtual: number,
  custoAtualCents: number,
  qtdEntrada: number,
  custoEntradaCents: number,
): number {
  if (!(qtdEntrada > 0)) return custoAtualCents;
  if (!(saldoAtual > 0) || !(custoAtualCents > 0)) return Math.round(custoEntradaCents);
  const valorTotal = saldoAtual * custoAtualCents + qtdEntrada * custoEntradaCents;
  return Math.round(valorTotal / (saldoAtual + qtdEntrada));
}

export interface PurchaseInboundItem {
  productId: number;
  qty: number;
  unitCostCents: number;
}

export function purchaseItemTotal(item: PurchaseInboundItem): number {
  return Math.round(item.qty * item.unitCostCents);
}

/**
 * Grava custo + movimentação de entrada de cada item de uma compra recebida.
 * Não abre transação: roda dentro da transação de quem recebeu a compra.
 */
export function postPurchaseItems(req: Request, purchaseId: number, items: PurchaseInboundItem[]): void {
  for (const item of items) {
    // Lê o saldo ANTES da entrada: é ele que pondera contra a quantidade que chega.
    const before = productRepository.findByIdWithColumns(Number(item.productId), 'id, stock_qty, cost_cents, track_stock') as
      | { id: number; stock_qty: number; cost_cents: number; track_stock: number } | undefined;
    if (!before) throw new Error(`Produto ${item.productId} não encontrado.`);

    const novoCusto = before.track_stock
      ? weightedAverageCostCents(before.stock_qty, before.cost_cents, Number(item.qty), Math.round(item.unitCostCents))
      : Math.round(item.unitCostCents);
    productRepository.updateCost(item.productId, novoCusto);

    const move = moveStockRaw(req, Number(item.productId), 'entrada', Number(item.qty), 'compra', 'purchase', purchaseId);
    if (!move.ok) throw new Error(move.error);
  }
}

export interface CreatePurchaseInboundInput {
  supplierId: number;
  items: PurchaseInboundItem[];
  notes?: string | null;
  status?: 'recebida' | 'rascunho';
  receivedAt?: string;
  paymentMethodId?: number | null;
  installmentCount?: number;
  firstDueDate?: string | null;
  lateFeeCents?: number;
  dailyInterestBps?: number;
}

/**
 * Cria a compra (e itens) e, se recebida, posta estoque/custo. Abre a própria
 * transação; quem chama de dentro de outra transação (ex.: módulo nfe) ganha um
 * savepoint — tudo continua atômico junto com o COMMIT externo.
 */
export function createPurchaseInbound(req: Request, input: CreatePurchaseInboundInput): number {
  const asDraft = input.status === 'rascunho';
  const items = input.items.map((i) => ({ ...i, qty: Number(i.qty), unitCostCents: Math.round(Number(i.unitCostCents)) }));
  let purchaseId = 0;
  purchaseRepository.transaction(() => {
    const total = sumCents(...items.map(purchaseItemTotal));
    purchaseId = purchaseRepository.create({
      supplier_id: input.supplierId,
      status: asDraft ? 'rascunho' : 'recebida',
      total_cents: total,
      notes: input.notes ?? null,
      received_at: asDraft ? null : (input.receivedAt ?? new Date().toISOString()),
      uuid: randomUUID(),
      payment_method_id: input.paymentMethodId ?? null,
      installment_count: input.installmentCount ?? 1,
      first_due_date: input.firstDueDate ?? null,
      late_fee_cents: input.lateFeeCents ?? 0,
      daily_interest_bps: input.dailyInterestBps ?? 0,
    });
    for (const item of items) {
      purchaseItemRepository.create({
        purchase_id: purchaseId,
        product_id: item.productId,
        qty: item.qty,
        unit_cost_cents: item.unitCostCents,
      });
    }
    if (!asDraft) postPurchaseItems(req, purchaseId, items);
  });
  return purchaseId;
}
