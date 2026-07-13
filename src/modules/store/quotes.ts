import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { assertAuth } from '../../shared/auth';
import { createSale, type SaleInput } from './sales';

/**
 * Orçamentos: proposta com preços congelados e validade.
 * Não mexem em estoque nem caixa. Converter honra os preços cotados.
 */

export interface QuoteInput {
  items: { productId: number; qty: number }[];
  customerId?: number;
  customerName?: string;
  discountCents?: number;
  validUntil?: string;
  notes?: string;
}

export function createQuote(req: Request, input: QuoteInput):
  | { ok: true; id: number; totalCents: number }
  | { ok: false; error: string } {
  assertAuth(req);
  const db = getSqlite();
  if (!input.items?.length) return { ok: false, error: 'Orçamento sem itens.' };
  const discount = Math.round(input.discountCents ?? 0);
  if (discount > 0 && !req.user.permissions.has('store.sales.discount')) {
    return { ok: false, error: 'Permissão negada: store.sales.discount (aplicar desconto).' };
  }

  const items: { productId: number; name: string; qty: number; unitCents: number; totalCents: number }[] = [];
  for (const item of input.items) {
    const p = db.prepare('SELECT id, name, price_cents, active FROM products WHERE id = ? AND deleted_at IS NULL')
      .get(item.productId) as { id: number; name: string; price_cents: number; active: number } | undefined;
    if (!p || !p.active) return { ok: false, error: `Produto ${item.productId} não encontrado ou inativo.` };
    if (!(item.qty > 0)) return { ok: false, error: `Quantidade inválida para "${p.name}".` };
    items.push({ productId: p.id, name: p.name, qty: item.qty, unitCents: p.price_cents,
      totalCents: Math.round(p.price_cents * item.qty) });
  }
  const subtotal = sumCents(...items.map((i) => i.totalCents));
  const total = subtotal - discount;
  if (total < 0) return { ok: false, error: 'Desconto maior que o subtotal.' };

  let id = 0;
  db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO quotes (customer_id, customer_name, subtotal_cents, discount_cents, total_cents, valid_until, notes, user_id, uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.customerId ?? null, input.customerName ?? null, subtotal, discount, total,
      input.validUntil ?? null, input.notes ?? null, req.user.id, randomUUID());
    id = Number(info.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO quote_items (quote_id, product_id, product_name, qty, unit_price_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const i of items) ins.run(id, i.productId, i.name, i.qty, i.unitCents, i.totalCents);
  })();
  audit(req, 'criar', 'quote', id, null, { total, items: items.length });
  return { ok: true, id, totalCents: total };
}

export function convertQuote(
  req: Request,
  quoteId: number,
  payment: Pick<SaleInput, 'paymentMethod' | 'paidCents' | 'payments' | 'customerId' | 'dueDate'>,
): ReturnType<typeof createSale> {
  const db = getSqlite();
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL').get(quoteId) as
    | { id: number; status: string; customer_id: number | null; discount_cents: number; valid_until: string | null }
    | undefined;
  if (!quote) return { ok: false, error: 'Orçamento não encontrado.' };
  if (quote.status !== 'aberto') return { ok: false, error: `Orçamento já está "${quote.status}".` };
  if (quote.valid_until && quote.valid_until < new Date().toISOString().slice(0, 10)) {
    return { ok: false, error: 'Orçamento vencido — gere um novo com os preços atuais.' };
  }

  const items = db.prepare('SELECT product_id, qty, unit_price_cents FROM quote_items WHERE quote_id = ?')
    .all(quoteId) as { product_id: number; qty: number; unit_price_cents: number }[];

  const result = createSale(req, {
    items: items.map((i) => ({ productId: i.product_id, qty: i.qty, unitPriceCents: i.unit_price_cents })),
    paymentMethod: payment.paymentMethod,
    payments: payment.payments,
    paidCents: payment.paidCents,
    discountCents: quote.discount_cents,
    customerId: payment.customerId ?? quote.customer_id ?? undefined,
    dueDate: payment.dueDate,
  }, { allowPriceOverride: true });

  if (result.ok) {
    db.prepare(
      `UPDATE quotes SET status = 'convertido', sale_id = ?, converted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(result.id, quoteId);
    audit(req, 'converter', 'quote', quoteId, { status: 'aberto' }, { status: 'convertido', saleId: result.id });
  }
  return result;
}

export function updateQuote(req: Request, quoteId: number, updates: {
  customerId?: number; customerName?: string; validUntil?: string; notes?: string; discountCents?: number;
}): { ok: true } | { ok: false; error: string } {
  assertAuth(req);
  const db = getSqlite();
  const before = db.prepare('SELECT id, status, subtotal_cents, discount_cents, total_cents FROM quotes WHERE id = ? AND deleted_at IS NULL')
    .get(quoteId) as { id: number; status: string; subtotal_cents: number; discount_cents: number; total_cents: number } | undefined;
  if (!before) return { ok: false, error: 'Orçamento não encontrado.' };
  if (before.status !== 'aberto') return { ok: false, error: `Orçamento já está "${before.status}".` };

  const discount = updates.discountCents != null ? Math.round(updates.discountCents) : before.discount_cents;
  if (discount !== before.discount_cents) {
    if (!req.user.permissions.has('store.sales.discount')) {
      return { ok: false, error: 'Permissão negada: store.sales.discount (alterar desconto).' };
    }
    if (discount > before.subtotal_cents) return { ok: false, error: 'Desconto maior que o subtotal.' };
  }
  const total = before.subtotal_cents - discount;

  db.prepare(
    `UPDATE quotes SET customer_id = COALESCE(?, customer_id), customer_name = COALESCE(?, customer_name),
       valid_until = COALESCE(?, valid_until), notes = COALESCE(?, notes),
       discount_cents = ?, total_cents = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(updates.customerId ?? null, updates.customerName ?? null, updates.validUntil ?? null, updates.notes ?? null,
    discount, total, quoteId);

  audit(req, 'editar', 'quote', quoteId,
    { discount_cents: before.discount_cents, total_cents: before.total_cents },
    { discount_cents: discount, total_cents: total });
  return { ok: true };
}

export function cancelQuote(req: Request, quoteId: number): { ok: boolean; error?: string } {
  const db = getSqlite();
  const quote = db.prepare('SELECT id, status FROM quotes WHERE id = ? AND deleted_at IS NULL').get(quoteId) as
    { id: number; status: string } | undefined;
  if (!quote) return { ok: false, error: 'Orçamento não encontrado.' };
  if (quote.status !== 'aberto') return { ok: false, error: `Orçamento já está "${quote.status}".` };
  db.prepare(`UPDATE quotes SET status = 'cancelado', updated_at = datetime('now') WHERE id = ?`).run(quoteId);
  audit(req, 'cancelar', 'quote', quoteId, quote, { status: 'cancelado' });
  return { ok: true };
}
