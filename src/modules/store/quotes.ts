/**
 * Orçamentos.
 *
 * O orçamento é montado no PDV (`/app/store/pdv`), não em tela própria: é lá que existem
 * busca que devolve variantes, diálogo de complementos, tabelas de preço e observação por
 * item. Este módulo só persiste o carrinho e o converte em venda.
 *
 * Duas regras estruturam o resto:
 *  1. O preço cotado é congelado em quote_items e honrado na conversão
 *     (createSale com allowPriceOverride) — o cliente recebeu um papel com um valor.
 *  2. Complemento não é uma estrutura aninhada: principal e adicionais são linhas irmãs
 *     amarradas pelo mesmo line_group_uuid, igual a sale_items. Quem perder esse campo no
 *     caminho quebra o vínculo.
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getService } from '../../core/services/registry';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { assertAuth } from '../../shared/auth';
import { createSale, type SaleInput, type SaleItemInput } from './sales';
import type { CommercialPricingService } from '../commercial/setup';
import { productRepository } from '../commercial/repositories/ProductRepository';
import { quoteRepository } from './repositories/QuoteRepository';

export interface QuoteItemInput {
  productId: number;
  qty: number;
  unitPriceCents?: number;
  notes?: string;
  lineGroupUuid?: string;
}

export interface QuoteInput {
  items: QuoteItemInput[];
  customerId?: number;
  customerName?: string;
  discountCents?: number;
  surchargeCents?: number;
  validUntil?: string;
  notes?: string;
}

interface ResolvedQuoteItem {
  productId: number;
  name: string;
  qty: number;
  unitCents: number;
  totalCents: number;
  notes: string | null;
  lineGroupUuid: string | null;
}

/**
 * Valida os produtos e resolve o preço pelo mesmo caminho da venda
 * (pricing.resolvePrice — tabela de preço, preço por cliente, faixa de quantidade).
 *
 * Kit/combo e ficha técnica NÃO são explodidos aqui: o orçamento guarda a linha-pai e a
 * explosão acontece no createSale, na conversão. Explodir nos dois lugares duplicaria os
 * componentes na venda.
 */
function resolveQuoteItems(
  items: QuoteItemInput[],
  pricing: CommercialPricingService,
  customerId: number | null,
  allowPriceOverride: boolean,
): ResolvedQuoteItem[] | { error: string } {
  const out: ResolvedQuoteItem[] = [];
  for (const item of items) {
    const p = productRepository.rawOne(
      'SELECT id, name, price_cents, active FROM products WHERE id = ? AND deleted_at IS NULL',
      item.productId,
    ) as { id: number; name: string; price_cents: number; active: number } | undefined;
    if (!p || !p.active) return { error: `Produto ${item.productId} não encontrado ou inativo.` };
    if (!(item.qty > 0)) return { error: `Quantidade inválida para "${p.name}".` };
    const unitCents =
      allowPriceOverride && item.unitPriceCents != null
        ? Math.round(item.unitPriceCents)
        : pricing.resolvePrice(p.id, item.qty, customerId).unitCents;
    out.push({
      productId: p.id,
      name: p.name,
      qty: item.qty,
      unitCents,
      totalCents: Math.round(unitCents * item.qty),
      notes: item.notes ?? null,
      lineGroupUuid: item.lineGroupUuid ?? null,
    });
  }
  return out;
}

function insertQuoteItems(quoteId: number, items: ResolvedQuoteItem[]): void {
  for (const i of items) {
    quoteRepository.rawRun(
      `INSERT INTO quote_items (quote_id, product_id, product_name, qty, unit_price_cents, total_cents, notes, line_group_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      quoteId, i.productId, i.name, i.qty, i.unitCents, i.totalCents, i.notes, i.lineGroupUuid,
    );
  }
}

export function createQuote(
  req: Request,
  input: QuoteInput,
  opts: { allowPriceOverride?: boolean } = {},
):
  | { ok: true; id: number; totalCents: number }
  | { ok: false; error: string } {
  assertAuth(req);
  if (!input.items?.length) return { ok: false, error: 'Orçamento sem itens.' };
  const discount = Math.round(input.discountCents ?? 0);
  const surcharge = Math.round(input.surchargeCents ?? 0);
  if (discount < 0 || surcharge < 0) return { ok: false, error: 'Desconto/acréscimo inválido.' };
  if ((discount > 0 || surcharge > 0) && !req.user.permissions.has('store.sales.discount')) {
    return { ok: false, error: 'Permissão negada: store.sales.discount (desconto/acréscimo).' };
  }

  const pricing = getService<CommercialPricingService>('commercial.pricing');
  const resolved = resolveQuoteItems(
    input.items, pricing, input.customerId ?? null, opts.allowPriceOverride ?? false,
  );
  if ('error' in resolved) return { ok: false, error: resolved.error };

  const subtotal = sumCents(...resolved.map((i) => i.totalCents));
  const total = subtotal - discount + surcharge;
  if (total < 0) return { ok: false, error: 'Desconto maior que o subtotal.' };

  let id = 0;
  quoteRepository.transaction(() => {
    id = quoteRepository.create({
      customer_id: input.customerId ?? null,
      customer_name: input.customerName ?? null,
      subtotal_cents: subtotal,
      discount_cents: discount,
      surcharge_cents: surcharge,
      total_cents: total,
      valid_until: input.validUntil ?? null,
      notes: input.notes ?? null,
      user_id: req.user.id,
      uuid: randomUUID(),
    });
    insertQuoteItems(id, resolved);
  });
  audit(req, 'criar', 'quote', id, null, { total, items: resolved.length });
  return { ok: true, id, totalCents: total };
}

export function convertQuote(
  req: Request,
  quoteId: number,
  payment: Pick<SaleInput, 'paymentMethod' | 'paidCents' | 'payments' | 'customerId' | 'dueDate' | 'clientRequestId'>,
  items?: QuoteItemInput[],
): ReturnType<typeof createSale> {
  // Garante atomicidade: a leitura do orçamento, a venda e a marcação como convertido
  // acontecem na mesma transação. Ler o status fora dela abriria janela para dupla conversão.
  let result: ReturnType<typeof createSale> = { ok: false, error: 'Falha desconhecida ao converter orçamento.' };
  try {
    quoteRepository.transaction(() => {
      const quote = quoteRepository.rawOne(
        'SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL',
        quoteId,
      ) as
        | { id: number; status: string; customer_id: number | null; discount_cents: number; surcharge_cents: number; valid_until: string | null }
        | undefined;
      if (!quote) throw new Error('Orçamento não encontrado.');
      if (quote.status !== 'aberto') throw new Error(`Orçamento já está "${quote.status}".`);
      if (quote.valid_until && quote.valid_until < new Date().toISOString().slice(0, 10)) {
        throw new Error('Orçamento vencido — gere um novo com os preços atuais.');
      }

      // O PDV manda o carrinho atual (o operador pode ter ajustado ao reabrir); sem isso,
      // valem os itens gravados. Nos dois casos unitPriceCents vai preenchido — é o que
      // faz o preço cotado prevalecer sobre o preço de catálogo de hoje.
      const saleItems: SaleItemInput[] = items?.length
        ? items.map((i) => ({
            productId: i.productId, qty: i.qty,
            unitPriceCents: i.unitPriceCents,
            notes: i.notes, lineGroupUuid: i.lineGroupUuid,
          }))
        : (quoteRepository.raw(
            'SELECT product_id, qty, unit_price_cents, notes, line_group_uuid FROM quote_items WHERE quote_id = ?',
            quoteId,
          ) as { product_id: number; qty: number; unit_price_cents: number; notes: string | null; line_group_uuid: string | null }[])
            .map((i) => ({
              productId: i.product_id, qty: i.qty,
              unitPriceCents: i.unit_price_cents,
              notes: i.notes ?? undefined, lineGroupUuid: i.line_group_uuid ?? undefined,
            }));
      if (!saleItems.length) throw new Error('Orçamento sem itens.');

      const saleResult = createSale(req, {
        items: saleItems,
        paymentMethod: payment.paymentMethod,
        payments: payment.payments,
        paidCents: payment.paidCents,
        discountCents: quote.discount_cents,
        surchargeCents: quote.surcharge_cents,
        customerId: payment.customerId ?? quote.customer_id ?? undefined,
        dueDate: payment.dueDate,
        clientRequestId: payment.clientRequestId,
      }, { allowPriceOverride: true, allowDiscount: true });

      if (!saleResult.ok) throw new Error(saleResult.error);

      quoteRepository.rawRun(
        `UPDATE quotes SET status = 'convertido', sale_id = ?, converted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        saleResult.id, quoteId,
      );
      result = saleResult;
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (result.ok) {
    audit(req, 'converter', 'quote', quoteId, { status: 'aberto' }, { status: 'convertido', saleId: (result as { ok: true; id: number }).id });
  }
  return result;
}

export function updateQuote(req: Request, quoteId: number, updates: {
  items?: QuoteItemInput[];
  customerId?: number | null;
  customerName?: string | null;
  validUntil?: string | null;
  notes?: string | null;
  discountCents?: number;
  surchargeCents?: number;
}, opts: { allowPriceOverride?: boolean } = {}): { ok: true; totalCents: number } | { ok: false; error: string } {
  assertAuth(req);
  const before = quoteRepository.rawOne(
    'SELECT id, status, customer_id, subtotal_cents, discount_cents, surcharge_cents, total_cents FROM quotes WHERE id = ? AND deleted_at IS NULL',
    quoteId,
  ) as { id: number; status: string; customer_id: number | null; subtotal_cents: number; discount_cents: number; surcharge_cents: number; total_cents: number } | undefined;
  if (!before) return { ok: false, error: 'Orçamento não encontrado.' };
  if (before.status !== 'aberto') return { ok: false, error: `Orçamento já está "${before.status}".` };

  const discount = updates.discountCents != null ? Math.round(updates.discountCents) : before.discount_cents;
  const surcharge = updates.surchargeCents != null ? Math.round(updates.surchargeCents) : before.surcharge_cents;
  if (discount < 0 || surcharge < 0) return { ok: false, error: 'Desconto/acréscimo inválido.' };
  if ((discount !== before.discount_cents || surcharge !== before.surcharge_cents)
      && !req.user.permissions.has('store.sales.discount')) {
    return { ok: false, error: 'Permissão negada: store.sales.discount (alterar desconto/acréscimo).' };
  }

  // Itens são opcionais: editar só a validade não deve mexer no carrinho cotado.
  let resolved: ResolvedQuoteItem[] | null = null;
  if (updates.items) {
    if (!updates.items.length) return { ok: false, error: 'Orçamento sem itens.' };
    const customerId = updates.customerId !== undefined ? updates.customerId : before.customer_id;
    const pricing = getService<CommercialPricingService>('commercial.pricing');
    const r = resolveQuoteItems(updates.items, pricing, customerId, opts.allowPriceOverride ?? false);
    if ('error' in r) return { ok: false, error: r.error };
    resolved = r;
  }

  const subtotal = resolved ? sumCents(...resolved.map((i) => i.totalCents)) : before.subtotal_cents;
  const total = subtotal - discount + surcharge;
  if (total < 0) return { ok: false, error: 'Desconto maior que o subtotal.' };

  quoteRepository.transaction(() => {
    if (resolved) {
      quoteRepository.rawRun('DELETE FROM quote_items WHERE quote_id = ?', quoteId);
      insertQuoteItems(quoteId, resolved);
    }
    // `undefined` preserva, `null` limpa — por isso cada campo tem seu próprio fragmento
    // em vez de um COALESCE, que tornava impossível desvincular cliente ou apagar a validade.
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (updates.customerId !== undefined) { sets.push('customer_id = ?'); args.push(updates.customerId); }
    if (updates.customerName !== undefined) { sets.push('customer_name = ?'); args.push(updates.customerName); }
    if (updates.validUntil !== undefined) { sets.push('valid_until = ?'); args.push(updates.validUntil); }
    if (updates.notes !== undefined) { sets.push('notes = ?'); args.push(updates.notes); }
    sets.push('subtotal_cents = ?', 'discount_cents = ?', 'surcharge_cents = ?', 'total_cents = ?', "updated_at = datetime('now')");
    args.push(subtotal, discount, surcharge, total, quoteId);
    quoteRepository.rawRun(`UPDATE quotes SET ${sets.join(', ')} WHERE id = ?`, ...args);
  });

  audit(req, 'editar', 'quote', quoteId,
    { discount_cents: before.discount_cents, surcharge_cents: before.surcharge_cents, total_cents: before.total_cents },
    { discount_cents: discount, surcharge_cents: surcharge, total_cents: total, items: resolved?.length });
  return { ok: true, totalCents: total };
}

export function cancelQuote(req: Request, quoteId: number): { ok: boolean; error?: string } {
  assertAuth(req);
  const quote = quoteRepository.rawOne(
    'SELECT id, status FROM quotes WHERE id = ? AND deleted_at IS NULL',
    quoteId,
  ) as { id: number; status: string } | undefined;
  if (!quote) return { ok: false, error: 'Orçamento não encontrado.' };
  if (quote.status !== 'aberto') return { ok: false, error: `Orçamento já está "${quote.status}".` };
  quoteRepository.rawRun("UPDATE quotes SET status = 'cancelado', updated_at = datetime('now') WHERE id = ?", quoteId);
  audit(req, 'cancelar', 'quote', quoteId, quote, { status: 'cancelado' });
  return { ok: true };
}
