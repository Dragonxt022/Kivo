import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { getService } from '../../core/services/registry';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import type { CommercialStockService, CommercialPricingService } from '../commercial/setup';
import type { FinanceCashService, FinanceReceivablesService, FinancePayMethodsService, PaymentMethod } from '../finance/setup';

/**
 * Venda do PDV — transacional de ponta a ponta, com PAGAMENTO MÚLTIPLO:
 * a soma dos pagamentos deve fechar o total (subtotal - desconto + acréscimo).
 * Nome/tipo/taxa da forma de pagamento são congelados por parcela.
 * dinheiro → gaveta (exige caixa aberto) com troco; prazo → conta a receber.
 * Comunicação entre Apps SEMPRE via serviços do Core (KATSU_PLANO.md §2).
 */

export interface SaleItemInput {
  productId: number;
  qty: number;
  /** Usado apenas internamente (conversão de orçamento honra o preço cotado). */
  unitPriceCents?: number;
}

export interface SalePaymentInput {
  methodId: number;
  amountCents: number;
  /** Para dinheiro: valor entregue pelo cliente (>= amountCents); troco = diferença. */
  receivedCents?: number;
}

export interface SaleInput {
  items: SaleItemInput[];
  /** Novo formato: uma ou mais formas de pagamento. */
  payments?: SalePaymentInput[];
  /** Formato legado (uma forma, por tipo). Mantido por compatibilidade. */
  paymentMethod?: 'dinheiro' | 'cartao_debito' | 'cartao_credito' | 'pix' | 'prazo';
  paidCents?: number;
  discountCents?: number;
  surchargeCents?: number;
  customerId?: number;
  dueDate?: string;
}

type SaleResult =
  | { ok: true; id: number; totalCents: number; changeCents: number; feeCents: number; receivableId?: number }
  | { ok: false; error: string };

const LEGACY_TYPE: Record<string, string> = {
  dinheiro: 'dinheiro', cartao_debito: 'debito', cartao_credito: 'credito', pix: 'pix', prazo: 'prazo',
};

export function createSale(
  req: Request,
  input: SaleInput,
  opts: { allowPriceOverride?: boolean } = {},
): SaleResult {
  const db = getSqlite();
  const stock = getService<CommercialStockService>('commercial.stock');
  const pricing = getService<CommercialPricingService>('commercial.pricing');
  const cash = getService<FinanceCashService>('finance.cash');
  const methods = getService<FinancePayMethodsService>('finance.paymethods');

  if (!input.items?.length) return { ok: false, error: 'Venda sem itens.' };
  const discount = Math.round(input.discountCents ?? 0);
  const surcharge = Math.round(input.surchargeCents ?? 0);
  if (discount < 0 || surcharge < 0) return { ok: false, error: 'Desconto/acréscimo inválido.' };
  if ((discount > 0 || surcharge > 0) && !req.user!.permissions.has('store.sales.discount')) {
    return { ok: false, error: 'Permissão negada: store.sales.discount (desconto/acréscimo).' };
  }

  // Congela produtos e preços do catálogo atual
  const items: { productId: number; name: string; qty: number; unitCents: number; totalCents: number }[] = [];
  for (const item of input.items) {
    const p = db
      .prepare('SELECT id, name, price_cents, active FROM products WHERE id = ? AND deleted_at IS NULL')
      .get(item.productId) as { id: number; name: string; price_cents: number; active: number } | undefined;
    if (!p || !p.active) return { ok: false, error: `Produto ${item.productId} não encontrado ou inativo.` };
    if (!(item.qty > 0)) return { ok: false, error: `Quantidade inválida para "${p.name}".` };
    const unitCents =
      opts.allowPriceOverride && item.unitPriceCents != null
        ? Math.round(item.unitPriceCents)
        : pricing.resolvePrice(p.id, item.qty, input.customerId ?? null).unitCents;
    items.push({
      productId: p.id, name: p.name, qty: item.qty, unitCents,
      totalCents: Math.round(unitCents * item.qty),
    });
  }

  const subtotal = sumCents(...items.map((i) => i.totalCents));
  const total = subtotal - discount + surcharge;
  if (total < 0) return { ok: false, error: 'Desconto maior que o subtotal.' };

  // ----- Resolve pagamentos (novo formato ou legado) -----
  interface ResolvedPayment {
    method: PaymentMethod;
    amountCents: number;
    receivedCents: number | null;
    changeCents: number;
    feeCents: number;
  }
  const resolved: ResolvedPayment[] = [];

  if (input.payments?.length) {
    for (const pay of input.payments) {
      const method = methods.get(Number(pay.methodId));
      if (!method) return { ok: false, error: `Forma de pagamento ${pay.methodId} inexistente ou inativa.` };
      const amount = Math.round(pay.amountCents);
      if (!(amount > 0)) return { ok: false, error: `Valor inválido para "${method.name}".` };
      let received: number | null = null;
      let change = 0;
      if (method.type === 'dinheiro') {
        received = Math.round(pay.receivedCents ?? amount);
        if (received < amount) return { ok: false, error: `Recebido em "${method.name}" menor que a parcela.` };
        change = received - amount;
      }
      resolved.push({ method, amountCents: amount, receivedCents: received, changeCents: change,
        feeCents: Math.round((amount * method.fee_bps) / 10000) });
    }
  } else if (input.paymentMethod) {
    // Legado: uma forma, resolvida pelo tipo
    const type = LEGACY_TYPE[input.paymentMethod];
    const method = methods.getByType(type);
    if (!method) return { ok: false, error: `Nenhuma forma de pagamento ativa do tipo "${type}".` };
    let received: number | null = null;
    let change = 0;
    if (method.type === 'dinheiro') {
      received = Math.round(input.paidCents ?? total);
      if (received < total) return { ok: false, error: 'Valor recebido menor que o total.' };
      change = received - total;
    }
    resolved.push({ method, amountCents: total, receivedCents: received, changeCents: change,
      feeCents: Math.round((total * method.fee_bps) / 10000) });
  } else {
    return { ok: false, error: 'Informe payments[] ou paymentMethod.' };
  }

  const paymentsSum = sumCents(...resolved.map((p) => p.amountCents));
  if (paymentsSum !== total) {
    return { ok: false, error: `Pagamentos (${paymentsSum}) não fecham o total (${total}).` };
  }

  const hasCash = resolved.some((p) => p.method.type === 'dinheiro');
  const reg = cash.currentRegister();
  if (hasCash && !reg) return { ok: false, error: 'Abra o caixa antes de vender em dinheiro.' };
  const hasPrazo = resolved.some((p) => p.method.type === 'prazo');
  if (hasPrazo && !input.customerId) return { ok: false, error: 'Venda a prazo exige cliente.' };

  const totalChange = sumCents(...resolved.map((p) => p.changeCents));
  const totalFee = sumCents(...resolved.map((p) => p.feeCents));
  const primaryMethod = resolved.length === 1 ? resolved[0].method.type : 'multiplo';
  const legacyLabel: Record<string, string> = {
    dinheiro: 'dinheiro', debito: 'cartao_debito', credito: 'cartao_credito', pix: 'pix', prazo: 'prazo',
    outro: 'pix', multiplo: 'pix',
  };

  let saleId = 0;
  let receivableId: number | undefined;
  let error: string | null = null;

  try {
    db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO sales (customer_id, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method,
           paid_cents, change_cents, cash_register_id, user_id, uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.customerId ?? null, subtotal, discount, surcharge, total,
        legacyLabel[primaryMethod] ?? 'pix',
        resolved[0].receivedCents, totalChange, reg?.id ?? null, req.user!.id, randomUUID());
      saleId = Number(info.lastInsertRowid);

      const insertItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, total_cents)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const i of items) {
        insertItem.run(saleId, i.productId, i.name, i.qty, i.unitCents, i.totalCents);
        // allowNegative: a venda não pode travar por falta de estoque (reposição pode atrasar).
        const move = stock.moveRaw(req, i.productId, 'saida', i.qty, 'venda', 'sale', saleId, true);
        if (!move.ok) throw new Error(move.error);
      }

      const insertPay = db.prepare(
        `INSERT INTO sale_payments (sale_id, payment_method_id, method_name, method_type, amount_cents,
           fee_bps, fee_cents, received_cents, change_cents, receivable_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const pay of resolved) {
        let payReceivableId: number | null = null;
        if (pay.method.type === 'dinheiro' && reg) {
          cash.addMovement(req, reg.id, 'entrada', 'venda', pay.amountCents,
            `Venda #${saleId} (${pay.method.name})`, 'sale', saleId);
        }
        if (pay.method.type === 'prazo') {
          const receivables = getService<FinanceReceivablesService>('finance.receivables');
          payReceivableId = receivables.create({
            description: `Venda a prazo #${saleId}`,
            amountCents: pay.amountCents,
            dueDate: input.dueDate ?? new Date(Date.now() + 30 * 24 * 3600e3).toISOString().slice(0, 10),
            customerId: input.customerId,
          });
          receivableId = payReceivableId;
        }
        insertPay.run(saleId, pay.method.id, pay.method.name, pay.method.type, pay.amountCents,
          pay.method.fee_bps, pay.feeCents, pay.receivedCents, pay.changeCents, payReceivableId);
      }
      if (receivableId) db.prepare('UPDATE sales SET receivable_id = ? WHERE id = ?').run(receivableId, saleId);
    })();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) return { ok: false, error };
  audit(req, 'venda', 'sale', saleId, null, {
    total, feeCents: totalFee, payments: resolved.map((p) => ({ method: p.method.name, amount: p.amountCents })),
  });
  return { ok: true, id: saleId, totalCents: total, changeCents: totalChange, feeCents: totalFee, receivableId };
}

export function cancelSale(req: Request, saleId: number): { ok: true } | { ok: false; error: string } {
  const db = getSqlite();
  const stock = getService<CommercialStockService>('commercial.stock');
  const cash = getService<FinanceCashService>('finance.cash');

  const sale = db
    .prepare('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL')
    .get(saleId) as { id: number; status: string; payment_method: string; total_cents: number; receivable_id: number | null } | undefined;
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status === 'cancelada') return { ok: false, error: 'Venda já cancelada.' };

  const payments = db
    .prepare('SELECT method_name, method_type, amount_cents, receivable_id FROM sale_payments WHERE sale_id = ?')
    .all(saleId) as { method_name: string; method_type: string; amount_cents: number; receivable_id: number | null }[];

  // Recebíveis já liquidados bloqueiam o cancelamento
  for (const pay of payments) {
    if (pay.receivable_id) {
      const rec = db.prepare('SELECT status FROM receivables WHERE id = ?').get(pay.receivable_id) as { status: string } | undefined;
      if (rec && rec.status === 'recebida') {
        return { ok: false, error: 'Conta a receber desta venda já foi recebida — estorne no financeiro antes de cancelar.' };
      }
    }
  }

  const hasCashPayment = payments.some((p) => p.method_type === 'dinheiro') ||
    (payments.length === 0 && sale.payment_method === 'dinheiro');

  const items = db
    .prepare('SELECT product_id, product_name, qty FROM sale_items WHERE sale_id = ?')
    .all(saleId) as { product_id: number; product_name: string; qty: number }[];

  let error: string | null = null;
  try {
    db.transaction(() => {
      for (const i of items) {
        const move = stock.moveRaw(req, i.product_id, 'entrada', i.qty, 'cancelamento de venda', 'sale', saleId);
        if (!move.ok) throw new Error(move.error);
      }
      if (hasCashPayment) {
        const reg = cash.currentRegister();
        if (!reg) throw new Error('Abra o caixa para devolver o dinheiro do cancelamento.');
        const cashAmount = payments.length
          ? sumCents(...payments.filter((p) => p.method_type === 'dinheiro').map((p) => p.amount_cents))
          : sale.total_cents;
        cash.addMovement(req, reg.id, 'saida', 'pagamento', cashAmount, `Cancelamento venda #${saleId}`, 'sale', saleId);
      }
      for (const pay of payments) {
        if (pay.receivable_id) {
          db.prepare(`UPDATE receivables SET status = 'cancelada', updated_at = datetime('now') WHERE id = ? AND status = 'aberta'`)
            .run(pay.receivable_id);
        }
      }
      if (sale.receivable_id && payments.length === 0) {
        db.prepare(`UPDATE receivables SET status = 'cancelada', updated_at = datetime('now') WHERE id = ? AND status = 'aberta'`)
          .run(sale.receivable_id);
      }
      db.prepare(
        `UPDATE sales SET status = 'cancelada', canceled_at = datetime('now'), canceled_by = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(req.user!.id, saleId);
    })();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) return { ok: false, error };
  audit(req, 'venda_cancelar', 'sale', saleId, sale, { status: 'cancelada' });
  return { ok: true };
}
