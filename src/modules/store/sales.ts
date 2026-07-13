import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { getService, hasService } from '../../core/services/registry';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { addDays } from '../../shared/date';
import { assertAuth } from '../../shared/auth';
import type { CommercialStockService, CommercialPricingService, CommercialStoreCreditService, CommercialLoyaltyService } from '../commercial/setup';
import type { FinanceCashService, FinanceReceivablesService, FinancePayMethodsService, FinanceAgreementsService, PaymentMethod } from '../finance/setup';
import type { FoodserviceKitchenService } from '../foodservice/setup';

/**
 * Venda do PDV — transacional de ponta a ponta, com PAGAMENTO MÚLTIPLO:
 * a soma dos pagamentos deve fechar o total (subtotal - desconto + acréscimo).
 * Nome/tipo/taxa da forma de pagamento são congelados por parcela.
 * dinheiro → gaveta (exige caixa aberto) com troco; prazo → conta(s) a receber
 * (parcelada ou não); credito_loja/fidelidade → descontam do saldo do cliente;
 * convenio → cobrança pendente da empresa conveniada, faturada mensalmente.
 * Comunicação entre Apps SEMPRE via serviços do Core (KATSU_PLANO.md §2).
 */

export interface SaleItemInput {
  productId: number;
  qty: number;
  /** Usado apenas internamente (conversão de orçamento honra o preço cotado). */
  unitPriceCents?: number;
  /** Observação por linha (ex.: "sem cebola"). */
  notes?: string;
  /** UUID que agrupa item principal + complementos escolhidos juntos. */
  lineGroupUuid?: string;
}

export interface SalePaymentInput {
  methodId: number;
  amountCents: number;
  /** Para dinheiro: valor entregue pelo cliente (>= amountCents); troco = diferença. */
  receivedCents?: number;
  /** Só relevante quando o método resolvido é 'prazo': sobrepõe input.customerId/dueDate para esta parcela. */
  customerId?: number;
  dueDate?: string;
  /** Só relevante quando o método é 'prazo': parcelamento (2-12x, a cada 30 dias a partir de firstDueDate). */
  installments?: { count: number; firstDueDate: string };
  /** Só relevante quando o método é 'fidelidade': quantos pontos o cliente está gastando. */
  pointsUsed?: number;
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
  /** Gerado uma vez pelo PDV por tentativa de checkout — evita duplicar a venda em duplo-clique/retry. */
  clientRequestId?: string;
}

type SaleResult =
  | { ok: true; id: number; totalCents: number; changeCents: number; feeCents: number; receivableId?: number }
  | { ok: false; error: string };

const LEGACY_TYPE: Record<string, string> = {
  dinheiro: 'dinheiro', cartao_debito: 'debito', cartao_credito: 'credito', pix: 'pix', prazo: 'prazo',
};

function existingSaleByRequestId(clientRequestId: string): SaleResult | undefined {
  const db = getSqlite();
  const sale = db.prepare('SELECT id, total_cents, change_cents, receivable_id FROM sales WHERE client_request_id = ?').get(clientRequestId) as
    { id: number; total_cents: number; change_cents: number; receivable_id: number | null } | undefined;
  if (!sale) return undefined;
  const feeRow = db.prepare('SELECT COALESCE(SUM(fee_cents), 0) AS fee FROM sale_payments WHERE sale_id = ?').get(sale.id) as { fee: number };
  return { ok: true, id: sale.id, totalCents: sale.total_cents, changeCents: sale.change_cents, feeCents: feeRow.fee, receivableId: sale.receivable_id ?? undefined };
}

interface ResolvedItem {
  productId: number; name: string; qty: number; unitCents: number;
  costCents: number; totalCents: number; notes: string | null;
  lineGroupUuid: string | null;
  recipeConsumption?: { productId: number; qty: number }[];
}

interface ResolvedPayment {
  method: PaymentMethod;
  amountCents: number;
  receivedCents: number | null;
  changeCents: number;
  feeCents: number;
  customerId?: number;
  dueDate?: string;
  installments?: { count: number; firstDueDate: string };
  pointsUsed?: number;
}

function resolveSaleItems(
  input: SaleInput,
  pricing: CommercialPricingService,
  opts: { allowPriceOverride?: boolean },
): ResolvedItem[] | { error: string } {
  const db = getSqlite();
  const items: ResolvedItem[] = [];
  for (const item of input.items) {
    const p = db
      .prepare('SELECT id, name, price_cents, cost_cents, product_type, active FROM products WHERE id = ? AND deleted_at IS NULL')
      .get(item.productId) as { id: number; name: string; price_cents: number; cost_cents: number; product_type: string; active: number } | undefined;
    if (!p || !p.active) return { error: `Produto ${item.productId} não encontrado ou inativo.` };
    if (!(item.qty > 0)) return { error: `Quantidade inválida para "${p.name}".` };
    const unitCents =
      opts.allowPriceOverride && item.unitPriceCents != null
        ? Math.round(item.unitPriceCents)
        : pricing.resolvePrice(p.id, item.qty, input.customerId ?? null).unitCents;
    const notes = item.notes ?? null;
    const lineGroupUuid = item.lineGroupUuid ?? null;
    items.push({
      productId: p.id, name: p.name, qty: item.qty, unitCents,
      costCents: p.cost_cents,
      totalCents: Math.round(unitCents * item.qty),
      notes, lineGroupUuid,
    });

    if (p.product_type === 'kit' || p.product_type === 'combo') {
      const kitComponents = db.prepare(
        `SELECT ki.qty AS compQty, comp.id, comp.name, comp.cost_cents, comp.active
         FROM kit_items ki
         JOIN products comp ON comp.id = ki.component_product_id AND comp.deleted_at IS NULL
         WHERE ki.kit_product_id = ? AND ki.deleted_at IS NULL
         ORDER BY ki.sort_order`,
      ).all(p.id) as { compQty: number; id: number; name: string; cost_cents: number; active: number }[];
      for (const comp of kitComponents) {
        if (!comp.active) {
          return { error: `Componente "${comp.name}" do kit "${p.name}" está inativo.` };
        }
        const compQty = comp.compQty * item.qty;
        items.push({
          productId: comp.id, name: comp.name, qty: compQty,
          unitCents: 0, costCents: comp.cost_cents, totalCents: 0,
          notes, lineGroupUuid,
        });
      }
    }

    if (p.product_type === 'produzido') {
      const recipeItems = db.prepare(
        `SELECT ri.qty AS recipeQty, input.id, input.name, input.cost_cents, input.active, input.track_stock
         FROM product_recipe_items ri
         JOIN products input ON input.id = ri.input_product_id AND input.deleted_at IS NULL
         WHERE ri.produced_product_id = ? AND ri.deleted_at IS NULL
         ORDER BY ri.sort_order`,
      ).all(p.id) as { recipeQty: number; id: number; name: string; cost_cents: number; active: number; track_stock: number }[];
      if (recipeItems.length > 0) {
        for (const ri of recipeItems) {
          if (!ri.active) {
            return { error: `Insumo "${ri.name}" da ficha técnica de "${p.name}" está inativo.` };
          }
          if (!ri.track_stock) {
            return { error: `Insumo "${ri.name}" não controla estoque — obrigatório para produtos com ficha técnica.` };
          }
        }
        let recipeCostCents = 0;
        const consumption: { productId: number; qty: number }[] = [];
        for (const ri of recipeItems) {
          const consumedQty = Math.round(ri.recipeQty * item.qty * 1000000) / 1000000;
          recipeCostCents += Math.round(ri.recipeQty * ri.cost_cents);
          consumption.push({ productId: ri.id, qty: consumedQty });
        }
        items[items.length - 1].costCents = Math.round(recipeCostCents);
        items[items.length - 1].recipeConsumption = consumption;
      }
    }
  }
  return items;
}

function resolveSalePayments(
  input: SaleInput,
  methods: FinancePayMethodsService,
  total: number,
  loyalty: CommercialLoyaltyService,
): ResolvedPayment[] | { error: string } {
  const db = getSqlite();
  const resolved: ResolvedPayment[] = [];

  if (input.payments?.length) {
    for (const pay of input.payments) {
      const method = methods.get(Number(pay.methodId));
      if (!method) return { error: `Forma de pagamento ${pay.methodId} inexistente ou inativa.` };
      const amount = Math.round(pay.amountCents);
      if (!(amount > 0)) return { error: `Valor inválido para "${method.name}".` };
      let received: number | null = null;
      let change = 0;
      if (method.type === 'dinheiro') {
        received = Math.round(pay.receivedCents ?? amount);
        if (received < amount) return { error: `Recebido em "${method.name}" menor que a parcela.` };
        change = received - amount;
      }
      resolved.push({
        method, amountCents: amount, receivedCents: received, changeCents: change,
        feeCents: Math.round((amount * method.fee_bps) / 10000),
        customerId: pay.customerId, dueDate: pay.dueDate, installments: pay.installments, pointsUsed: pay.pointsUsed,
      });
    }
  } else if (input.paymentMethod) {
    const type = LEGACY_TYPE[input.paymentMethod];
    const method = methods.getByType(type);
    if (!method) return { error: `Nenhuma forma de pagamento ativa do tipo "${type}".` };
    let received: number | null = null;
    let change = 0;
    if (method.type === 'dinheiro') {
      received = Math.round(input.paidCents ?? total);
      if (received < total) return { error: 'Valor recebido menor que o total.' };
      change = received - total;
    }
    resolved.push({ method, amountCents: total, receivedCents: received, changeCents: change,
      feeCents: Math.round((total * method.fee_bps) / 10000) });
  } else {
    return { error: 'Informe payments[] ou paymentMethod.' };
  }

  const paymentsSum = sumCents(...resolved.map((p) => p.amountCents));
  if (paymentsSum !== total) {
    return { error: `Pagamentos (${paymentsSum}) não fecham o total (${total}).` };
  }

  for (const pay of resolved) {
    const custId = pay.customerId ?? input.customerId;
    if (pay.method.type === 'prazo') {
      if (!custId) return { error: 'Venda a prazo exige cliente.' };
      const count = pay.installments?.count ?? 1;
      if (count < 1 || count > 12) return { error: 'Parcelamento deve ser entre 1 e 12 vezes.' };
    }
    if (pay.method.type === 'credito_loja' && !custId) {
      return { error: 'Pagamento com crédito de loja exige cliente.' };
    }
    if (pay.method.type === 'fidelidade') {
      if (!custId) return { error: 'Pagamento com pontos de fidelidade exige cliente.' };
      if (!loyalty.enabled()) return { error: 'Clube de fidelidade não está ativo.' };
      const expected = Math.round((pay.pointsUsed ?? 0) * loyalty.centsPerPoint());
      if (!pay.pointsUsed || expected !== pay.amountCents) {
        return { error: 'Quantidade de pontos não corresponde ao valor do pagamento.' };
      }
    }
    if (pay.method.type === 'convenio') {
      if (!custId) return { error: 'Pagamento por convênio exige cliente.' };
      const customer = db.prepare('SELECT agreement_company_id FROM customers WHERE id = ? AND deleted_at IS NULL').get(custId) as
        { agreement_company_id: number | null } | undefined;
      if (!customer?.agreement_company_id) return { error: 'Cliente não possui convênio vinculado.' };
    }
  }

  return resolved;
}

export function createSale(
  req: Request,
  input: SaleInput,
  opts: { allowPriceOverride?: boolean } = {},
): SaleResult {
  assertAuth(req);
  const db = getSqlite();

  if (input.clientRequestId) {
    const existing = existingSaleByRequestId(input.clientRequestId);
    if (existing) return existing;
  }

  const stock = getService<CommercialStockService>('commercial.stock');
  const pricing = getService<CommercialPricingService>('commercial.pricing');
  const storeCredit = getService<CommercialStoreCreditService>('commercial.storeCredit');
  const loyalty = getService<CommercialLoyaltyService>('commercial.loyalty');
  const cash = getService<FinanceCashService>('finance.cash');
  const methods = getService<FinancePayMethodsService>('finance.paymethods');
  const agreements = getService<FinanceAgreementsService>('finance.agreements');

  if (!input.items?.length) return { ok: false, error: 'Venda sem itens.' };
  const discount = Math.round(input.discountCents ?? 0);
  const surcharge = Math.round(input.surchargeCents ?? 0);
  if (discount < 0 || surcharge < 0) return { ok: false, error: 'Desconto/acréscimo inválido.' };
  if ((discount > 0 || surcharge > 0) && !req.user.permissions.has('store.sales.discount')) {
    return { ok: false, error: 'Permissão negada: store.sales.discount (desconto/acréscimo).' };
  }

  const itemsResult = resolveSaleItems(input, pricing, opts);
  if ('error' in itemsResult) return { ok: false, error: itemsResult.error };
  const items = itemsResult;

  const subtotal = sumCents(...items.map((i) => i.totalCents));
  const total = subtotal - discount + surcharge;
  if (total < 0) return { ok: false, error: 'Desconto maior que o subtotal.' };

  const paymentsResult = resolveSalePayments(input, methods, total, loyalty);
  if ('error' in paymentsResult) return { ok: false, error: paymentsResult.error };
  const resolved = paymentsResult;

  const hasCash = resolved.some((p) => p.method.type === 'dinheiro');
  const reg = cash.currentRegister();
  if (hasCash && !reg) return { ok: false, error: 'Abra o caixa antes de vender em dinheiro.' };

  const totalChange = sumCents(...resolved.map((p) => p.changeCents));
  const totalFee = sumCents(...resolved.map((p) => p.feeCents));
  const primaryMethod = resolved.length === 1 ? resolved[0].method.type : 'multiplo';
  const legacyLabel: Record<string, string> = {
    dinheiro: 'dinheiro', debito: 'cartao_debito', credito: 'cartao_credito', pix: 'pix', prazo: 'prazo',
    outro: 'pix', multiplo: 'pix', credito_loja: 'pix', fidelidade: 'pix', convenio: 'pix',
  };

  let saleId = 0;
  let receivableId: number | undefined;
  let error: string | null = null;

  try {
    db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO sales (customer_id, subtotal_cents, discount_cents, surcharge_cents, total_cents, payment_method,
           paid_cents, change_cents, cash_register_id, user_id, client_request_id, uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.customerId ?? null, subtotal, discount, surcharge, total,
        legacyLabel[primaryMethod] ?? 'pix',
        resolved[0].receivedCents, totalChange, reg?.id ?? null, req.user.id, input.clientRequestId ?? null, randomUUID());
      saleId = Number(info.lastInsertRowid);

      const insertItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const i of items) {
        insertItem.run(saleId, i.productId, i.name, i.qty, i.unitCents, i.costCents, i.totalCents, i.notes, i.lineGroupUuid);
        const move = stock.moveRaw(req, i.productId, 'saida', i.qty, 'venda', 'sale', saleId, true);
        if (!move.ok) throw new Error(move.error);
        if (i.recipeConsumption?.length) {
          for (const c of i.recipeConsumption) {
            const rmove = stock.moveRaw(req, c.productId, 'saida', c.qty, 'producao', 'sale', saleId, true);
            if (!rmove.ok) throw new Error(rmove.error);
          }
        }
      }

      const insertPay = db.prepare(
        `INSERT INTO sale_payments (sale_id, payment_method_id, method_name, method_type, amount_cents,
           fee_bps, fee_cents, received_cents, change_cents, receivable_id, points_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let loyaltyEarnBaseCents = 0;
      for (const pay of resolved) {
        const custId = pay.customerId ?? input.customerId;
        let payReceivableId: number | null = null;
        let pointsUsed: number | null = null;

        if (pay.method.type === 'dinheiro' && reg) {
          cash.addMovement(req, reg.id, 'entrada', 'venda', pay.amountCents,
            `Venda #${saleId} (${pay.method.name})`, 'sale', saleId);
        }

        if (pay.method.type === 'prazo') {
          const receivables = getService<FinanceReceivablesService>('finance.receivables');
          const count = pay.installments?.count ?? 1;
          const firstDue = pay.installments?.firstDueDate ?? pay.dueDate ?? input.dueDate
            ?? new Date(Date.now() + 30 * 24 * 3600e3).toISOString().slice(0, 10);
          const base = Math.floor(pay.amountCents / count);
          const remainder = pay.amountCents - base * count;
          for (let n = 0; n < count; n++) {
            const amt = n === 0 ? base + remainder : base;
            const due = addDays(firstDue, 30 * n);
            const id = receivables.create({
              description: count > 1 ? `Venda a prazo #${saleId} — parcela ${n + 1}/${count}` : `Venda a prazo #${saleId}`,
              amountCents: amt, dueDate: due, customerId: custId,
              saleId, installmentNo: n + 1, installmentCount: count,
            });
            if (n === 0) payReceivableId = id;
          }
          receivableId = payReceivableId ?? receivableId;
        }

        if (pay.method.type === 'credito_loja') {
          const result = storeCredit.redeemRaw(req, custId!, pay.amountCents, `Venda #${saleId}`, 'sale', saleId);
          if (!result.ok) throw new Error(result.error);
        }

        if (pay.method.type === 'fidelidade') {
          pointsUsed = pay.pointsUsed ?? 0;
          const result = loyalty.redeemRaw(req, custId!, pointsUsed, `Venda #${saleId}`, 'sale', saleId);
          if (!result.ok) throw new Error(result.error);
        }

        if (pay.method.type === 'convenio') {
          const customer = db.prepare('SELECT agreement_company_id FROM customers WHERE id = ?').get(custId) as { agreement_company_id: number };
          agreements.chargeAgreementRaw(saleId, customer.agreement_company_id, pay.amountCents);
        }

        if (pay.method.type !== 'credito_loja' && pay.method.type !== 'fidelidade') {
          loyaltyEarnBaseCents += pay.amountCents;
        }

        insertPay.run(saleId, pay.method.id, pay.method.name, pay.method.type, pay.amountCents,
          pay.method.fee_bps, pay.feeCents, pay.receivedCents, pay.changeCents, payReceivableId, pointsUsed);
      }
      if (receivableId) db.prepare('UPDATE sales SET receivable_id = ? WHERE id = ?').run(receivableId, saleId);

      if (input.customerId && loyalty.enabled() && loyaltyEarnBaseCents > 0) {
        const points = loyalty.pointsForSaleCents(loyaltyEarnBaseCents);
        if (points > 0) loyalty.accrueRaw(req, input.customerId, points, `Venda #${saleId}`, 'sale', saleId);
      }
    })();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) return { ok: false, error };
  audit(req, 'venda', 'sale', saleId, null, {
    total, feeCents: totalFee, payments: resolved.map((p) => ({ method: p.method.name, amount: p.amountCents })),
  });
  try {
    if (hasService('foodservice.kitchen')) {
      getService<FoodserviceKitchenService>('foodservice.kitchen').notifyOrder(req, {
        sourceType: 'sale', sourceId: saleId,
        items: items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, notes: i.notes ?? undefined })),
      });
    }
  } catch (e) { console.error('[kitchen] falha ao notificar:', e); }
  return { ok: true, id: saleId, totalCents: total, changeCents: totalChange, feeCents: totalFee, receivableId };
}

export function cancelSale(req: Request, saleId: number): { ok: true } | { ok: false; error: string } {
  assertAuth(req);
  const db = getSqlite();
  const stock = getService<CommercialStockService>('commercial.stock');
  const storeCredit = getService<CommercialStoreCreditService>('commercial.storeCredit');
  const loyalty = getService<CommercialLoyaltyService>('commercial.loyalty');
  const cash = getService<FinanceCashService>('finance.cash');

  const sale = db
    .prepare('SELECT * FROM sales WHERE id = ? AND deleted_at IS NULL')
    .get(saleId) as { id: number; customer_id: number | null; status: string; payment_method: string; total_cents: number; receivable_id: number | null } | undefined;
  if (!sale) return { ok: false, error: 'Venda não encontrada.' };
  if (sale.status === 'cancelada') return { ok: false, error: 'Venda já cancelada.' };

  const payments = db
    .prepare('SELECT method_name, method_type, amount_cents, receivable_id, points_used FROM sale_payments WHERE sale_id = ?')
    .all(saleId) as { method_name: string; method_type: string; amount_cents: number; receivable_id: number | null; points_used: number | null }[];

  // Recebíveis já liquidados bloqueiam o cancelamento (busca por sale_id: cobre 1 ou N parcelas)
  const saleReceivables = db.prepare('SELECT id, status FROM receivables WHERE sale_id = ? AND deleted_at IS NULL').all(saleId) as
    { id: number; status: string }[];
  if (saleReceivables.some((r) => r.status === 'recebida')) {
    return { ok: false, error: 'Conta a receber desta venda já foi recebida — estorne no financeiro antes de cancelar.' };
  }

  // Cobrança de convênio já faturada bloqueia o cancelamento
  const agreementCharge = db.prepare('SELECT id, invoiced_at FROM agreement_charges WHERE sale_id = ? AND deleted_at IS NULL').get(saleId) as
    { id: number; invoiced_at: string | null } | undefined;
  if (agreementCharge?.invoiced_at) {
    return { ok: false, error: 'Cobrança de convênio desta venda já foi faturada — ajuste a fatura manualmente antes de cancelar.' };
  }

  const hasCashPayment = payments.some((p) => p.method_type === 'dinheiro') ||
    (payments.length === 0 && sale.payment_method === 'dinheiro');

  const movements = db
    .prepare("SELECT product_id, qty FROM stock_movements WHERE ref_entity = 'sale' AND ref_id = ? AND type = 'saida'")
    .all(String(saleId)) as { product_id: number; qty: number }[];

  let error: string | null = null;
  try {
    db.transaction(() => {
      for (const m of movements) {
        // Permite saldo negativo: o produto pode ter saidas posteriores (reposição pode atrasar).
        const move = stock.moveRaw(req, m.product_id, 'entrada', m.qty, 'cancelamento de venda', 'sale', saleId, true);
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
      if (saleReceivables.length) {
        db.prepare(`UPDATE receivables SET status = 'cancelada', updated_at = datetime('now') WHERE sale_id = ? AND status = 'aberta'`).run(saleId);
      }
      if (agreementCharge) {
        db.prepare(`UPDATE agreement_charges SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(agreementCharge.id);
      }
      for (const pay of payments) {
        if (pay.method_type === 'credito_loja' && sale.customer_id) {
          const r = storeCredit.reverseRaw(req, sale.customer_id, pay.amount_cents, `Estorno cancelamento venda #${saleId}`, 'sale', saleId);
          if (!r.ok) throw new Error(r.error);
        }
        if (pay.method_type === 'fidelidade' && sale.customer_id && pay.points_used) {
          const r = loyalty.reverseRaw(req, sale.customer_id, pay.points_used, `Estorno cancelamento venda #${saleId}`, 'sale', saleId);
          if (!r.ok) throw new Error(r.error);
        }
      }
      // Reverte os pontos GANHOS por esta venda (se algum acúmulo automático ocorreu).
      if (sale.customer_id) {
        const earned = db.prepare(
          `SELECT COALESCE(SUM(points), 0) AS pts FROM loyalty_point_movements WHERE ref_entity = 'sale' AND ref_id = ? AND type = 'ganho'`,
        ).get(String(saleId)) as { pts: number };
        if (earned.pts > 0) {
          const r = loyalty.reverseGrantRaw(req, sale.customer_id, earned.pts, `Estorno de pontos ganhos — venda cancelada #${saleId}`, 'sale', saleId);
          if (!r.ok) throw new Error(r.error);
        }
      }
      db.prepare(
        `UPDATE sales SET status = 'cancelada', canceled_at = datetime('now'), canceled_by = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(req.user.id, saleId);
    })();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) return { ok: false, error };
  audit(req, 'venda_cancelar', 'sale', saleId, sale, { status: 'cancelada' });
  return { ok: true };
}
