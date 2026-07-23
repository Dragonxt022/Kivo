import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getService, hasService } from '../../core/services/registry';
import { audit } from '../../core/audit/service';
import { sumCents } from '../../shared/money';
import { addDays } from '../../shared/date';
import { assertAuth } from '../../shared/auth';
import type { CommercialStockService, CommercialPricingService, CommercialStoreCreditService, CommercialLoyaltyService } from '../commercial/setup';
import type { FinanceCashService, FinanceReceivablesService, FinancePayMethodsService, FinanceAgreementsService, PaymentMethod } from '../finance/setup';
import type { FoodserviceKitchenService } from '../foodservice/setup';
import { productRepository } from '../commercial/repositories/ProductRepository';
import { kitItemRepository } from '../commercial/repositories/KitRepository';
import { recipeItemRepository } from '../commercial/repositories/RecipeRepository';
import { customerRepository } from '../commercial/repositories/CustomerRepository';
import { saleRepository, salePaymentRepository } from './repositories/SaleRepository';
import { receivableRepository } from '../finance/repositories/BillRepository';
import { agreementChargeRepository } from '../finance/repositories/AgreementRepository';
import { stockMovementRepository } from '../commercial/repositories/StockMovementRepository';
import { loyaltyPointMovementRepository } from '../commercial/repositories/StockMovementRepository';

export interface SaleItemInput {
  productId: number;
  qty: number;
  unitPriceCents?: number;
  notes?: string;
  lineGroupUuid?: string;
}

export interface SalePaymentInput {
  methodId: number;
  amountCents: number;
  receivedCents?: number;
  customerId?: number;
  dueDate?: string;
  installments?: { count: number; firstDueDate: string };
  pointsUsed?: number;
}

export interface SaleInput {
  items: SaleItemInput[];
  payments?: SalePaymentInput[];
  paymentMethod?: 'dinheiro' | 'cartao_debito' | 'cartao_credito' | 'pix' | 'prazo';
  paidCents?: number;
  discountCents?: number;
  surchargeCents?: number;
  customerId?: number;
  dueDate?: string;
  clientRequestId?: string;
}

type SaleResult =
  | { ok: true; id: number; totalCents: number; changeCents: number; feeCents: number; receivableId?: number }
  | { ok: false; error: string };

const LEGACY_TYPE: Record<string, string> = {
  dinheiro: 'dinheiro', cartao_debito: 'debito', cartao_credito: 'credito', pix: 'pix', prazo: 'prazo',
};

function existingSaleByRequestId(clientRequestId: string): SaleResult | undefined {
  const sale = saleRepository.findByClientRequestId(clientRequestId) as
    | { id: number; total_cents: number; change_cents: number; receivable_id: number | null } | undefined;
  if (!sale) return undefined;
  const feeRow = salePaymentRepository.findFeeTotal(sale.id);
  return { ok: true, id: sale.id, totalCents: sale.total_cents, changeCents: sale.change_cents, feeCents: feeRow, receivableId: sale.receivable_id ?? undefined };
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
  const items: ResolvedItem[] = [];
  for (const item of input.items) {
    const p = productRepository.rawOne(
      'SELECT id, name, price_cents, cost_cents, product_type, active FROM products WHERE id = ? AND deleted_at IS NULL',
      item.productId,
    ) as { id: number; name: string; price_cents: number; cost_cents: number; product_type: string; active: number } | undefined;
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
      const kitComponents = kitItemRepository.findComponentsByProduct(p.id) as
        { compQty: number; id: number; name: string; cost_cents: number; active: number }[];
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
      const recipeItems = recipeItemRepository.findRecipeByProduct(p.id) as
        { recipeQty: number; id: number; name: string; cost_cents: number; active: number; track_stock: number }[];
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
      const customer = customerRepository.rawOne('SELECT agreement_company_id FROM customers WHERE id = ? AND deleted_at IS NULL', custId) as
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

  const reg = cash.currentRegister();
  if (!reg) return { ok: false, error: 'Abra o caixa antes de realizar uma venda.' };

  const totalChange = sumCents(...resolved.map((p) => p.changeCents));
  const totalFee = sumCents(...resolved.map((p) => p.feeCents));
  const primaryMethod = resolved.length === 1 ? resolved[0].method.type : 'multiplo';
  const legacyLabel: Record<string, string> = {
    dinheiro: 'dinheiro', debito: 'cartao_debito', credito: 'cartao_credito', pix: 'pix', prazo: 'prazo',
    outro: 'outro', multiplo: 'multiplo', credito_loja: 'credito_loja', fidelidade: 'fidelidade', convenio: 'convenio',
  };

  let saleId = 0;
  let receivableId: number | undefined;
  let error: string | null = null;

  try {
    saleRepository.transaction(() => {
      saleId = saleRepository.create({
        customer_id: input.customerId ?? null,
        subtotal_cents: subtotal,
        discount_cents: discount,
        surcharge_cents: surcharge,
        total_cents: total,
        payment_method: legacyLabel[primaryMethod] ?? 'pix',
        paid_cents: resolved[0].receivedCents,
        change_cents: totalChange,
        cash_register_id: reg?.id ?? null,
        user_id: req.user.id,
        client_request_id: input.clientRequestId ?? null,
        uuid: randomUUID(),
      });

      for (const i of items) {
        saleRepository.rawRun(
          `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price_cents, cost_cents, total_cents, notes, line_group_uuid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          saleId, i.productId, i.name, i.qty, i.unitCents, i.costCents, i.totalCents, i.notes, i.lineGroupUuid,
        );
        const move = stock.moveRaw(req, i.productId, 'saida', i.qty, 'venda', 'sale', saleId, true);
        if (!move.ok) throw new Error(move.error);
        if (i.recipeConsumption?.length) {
          for (const c of i.recipeConsumption) {
            const rmove = stock.moveRaw(req, c.productId, 'saida', c.qty, 'producao', 'sale', saleId, true);
            if (!rmove.ok) throw new Error(rmove.error);
          }
        }
      }

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
          const customer = customerRepository.rawOne('SELECT agreement_company_id FROM customers WHERE id = ?', custId) as { agreement_company_id: number };
          agreements.chargeAgreementRaw(saleId, customer.agreement_company_id, pay.amountCents);
        }

        if (pay.method.type !== 'credito_loja' && pay.method.type !== 'fidelidade') {
          loyaltyEarnBaseCents += pay.amountCents;
        }

        saleRepository.rawRun(
          `INSERT INTO sale_payments (sale_id, payment_method_id, method_name, method_type, amount_cents,
             fee_bps, fee_cents, received_cents, change_cents, receivable_id, points_used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          saleId, pay.method.id, pay.method.name, pay.method.type, pay.amountCents,
          pay.method.fee_bps, pay.feeCents, pay.receivedCents, pay.changeCents, payReceivableId, pointsUsed,
        );
      }
      if (receivableId) saleRepository.updateReceivable(saleId, receivableId);

      if (input.customerId && loyalty.enabled() && loyaltyEarnBaseCents > 0) {
        const points = loyalty.pointsForSaleCents(loyaltyEarnBaseCents);
        if (points > 0) loyalty.accrueRaw(req, input.customerId, points, `Venda #${saleId}`, 'sale', saleId);
      }
    });
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

/* ---------- cancelSale sub-functions ---------- */

interface CancellationSale {
  id: number; customer_id: number | null; status: string;
  payment_method: string; total_cents: number; receivable_id: number | null;
}

function validateCancellation(
  sale: CancellationSale | undefined,
  saleReceivables: { id: number; status: string }[],
  agreementCharge: { id: number; invoiced_at: string | null } | undefined,
): string | null {
  if (!sale) return 'Venda não encontrada.';
  if (sale.status === 'cancelada') return 'Venda já cancelada.';
  if (saleReceivables.some((r) => r.status === 'recebida')) {
    return 'Conta a receber desta venda já foi recebida — estorne no financeiro antes de cancelar.';
  }
  if (agreementCharge?.invoiced_at) {
    return 'Cobrança de convênio desta venda já foi faturada — ajuste a fatura manualmente antes de cancelar.';
  }
  return null;
}

function reverseStockMovements(
  stock: CommercialStockService, req: Request,
  movements: { product_id: number; qty: number }[], saleId: number,
): string | null {
  for (const m of movements) {
    const move = stock.moveRaw(req, m.product_id, 'entrada', m.qty, 'cancelamento de venda', 'sale', saleId, true);
    if (!move.ok) return move.error;
  }
  return null;
}

function handleCashRefund(
  cash: FinanceCashService, req: Request,
  hasCashPayment: boolean,
  payments: { method_type: string; amount_cents: number }[],
  sale: CancellationSale, saleId: number,
): string | null {
  if (!hasCashPayment) return null;
  const reg = cash.currentRegister();
  if (!reg) return 'Abra o caixa para devolver o dinheiro do cancelamento.';
  const cashAmount = payments.length
    ? sumCents(...payments.filter((p) => p.method_type === 'dinheiro').map((p) => p.amount_cents))
    : sale.total_cents;
  cash.addMovement(req, reg.id, 'saida', 'pagamento', cashAmount, `Cancelamento venda #${saleId}`, 'sale', saleId);
  return null;
}

function cancelReceivablesAndAgreements(
  saleReceivables: { id: number }[],
  agreementCharge: { id: number } | undefined,
  saleId: number,
): void {
  if (saleReceivables.length) receivableRepository.cancelBySale(saleId);
  if (agreementCharge) agreementChargeRepository.softDelete(agreementCharge.id);
}

function reversePaymentsInvolvingCustomer(
  storeCredit: CommercialStoreCreditService, loyalty: CommercialLoyaltyService,
  req: Request, payments: { method_type: string; amount_cents: number; points_used?: number | null }[],
  customerId: number, saleId: number,
): string | null {
  for (const pay of payments) {
    if (pay.method_type === 'credito_loja') {
      const r = storeCredit.reverseRaw(req, customerId, pay.amount_cents, `Estorno cancelamento venda #${saleId}`, 'sale', saleId);
      if (!r.ok) return r.error;
    }
    if (pay.method_type === 'fidelidade' && pay.points_used) {
      const r = loyalty.reverseRaw(req, customerId, pay.points_used, `Estorno cancelamento venda #${saleId}`, 'sale', saleId);
      if (!r.ok) return r.error;
    }
  }
  return null;
}

function reverseEarnedLoyaltyPoints(
  loyalty: CommercialLoyaltyService,
  req: Request, customerId: number, saleId: number,
): string | null {
  const earned = loyaltyPointMovementRepository.findEarnedByRef('sale', saleId);
  if (earned <= 0) return null;
  const r = loyalty.reverseGrantRaw(req, customerId, earned, `Estorno de pontos ganhos — venda cancelada #${saleId}`, 'sale', saleId);
  return r.ok ? null : r.error;
}

export function cancelSale(req: Request, saleId: number): { ok: true } | { ok: false; error: string } {
  assertAuth(req);
  const stock = getService<CommercialStockService>('commercial.stock');
  const storeCredit = getService<CommercialStoreCreditService>('commercial.storeCredit');
  const loyalty = getService<CommercialLoyaltyService>('commercial.loyalty');
  const cash = getService<FinanceCashService>('finance.cash');

  const sale = saleRepository.findFull(saleId) as CancellationSale | undefined;
  const payments = salePaymentRepository.findBySale(saleId);
  const saleReceivables = receivableRepository.findSaleReceivables(saleId) as { id: number; status: string }[];
  const agreementCharge = agreementChargeRepository.findBySale(saleId) as
    | { id: number; invoiced_at: string | null } | undefined;

  const err = validateCancellation(sale, saleReceivables, agreementCharge);
  if (err) return { ok: false, error: err };

  const hasCashPayment = payments.some((p) => p.method_type === 'dinheiro') ||
    (payments.length === 0 && sale!.payment_method === 'dinheiro');
  const movements = stockMovementRepository.findMovementQtysByRef('sale', saleId);

  let error: string | null = null;
  try {
    saleRepository.transaction(() => {
      error = reverseStockMovements(stock, req, movements, saleId);
      if (error) throw new Error(error);

      error = handleCashRefund(cash, req, hasCashPayment, payments, sale!, saleId);
      if (error) throw new Error(error);

      cancelReceivablesAndAgreements(saleReceivables, agreementCharge, saleId);

      if (sale!.customer_id) {
        error = reversePaymentsInvolvingCustomer(storeCredit, loyalty, req, payments, sale!.customer_id, saleId);
        if (error) throw new Error(error);

        error = reverseEarnedLoyaltyPoints(loyalty, req, sale!.customer_id, saleId);
        if (error) throw new Error(error);
      }

      saleRepository.cancel(saleId, req.user.id);
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) return { ok: false, error };
  audit(req, 'venda_cancelar', 'sale', saleId, sale, { status: 'cancelada' });
  return { ok: true };
}
