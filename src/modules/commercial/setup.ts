import { registerService } from '../../core/services/registry';
import { registerRecomputeHook } from '../../core/sync/registry';
import { moveStock, moveStockRaw, listMovements, recomputeStockForProducts } from './stock';
import { resolvePrice, resolveMany } from './pricing';
import * as storeCredit from './storeCredit';
import * as loyalty from './loyalty';

/** Serviços que o módulo commercial oferece aos outros Apps (via Core). */
export interface CommercialStockService {
  move: typeof moveStock;
  /** Sem transação própria — use quando já estiver dentro de uma transação. */
  moveRaw: typeof moveStockRaw;
  listMovements: typeof listMovements;
}

export interface CommercialPricingService {
  resolvePrice: typeof resolvePrice;
  resolveMany: typeof resolveMany;
}

/** Crédito de troca (vale por devolução) — funções "Raw" não abrem transação própria. */
export interface CommercialStoreCreditService {
  grantRaw: typeof storeCredit.grant;
  redeemRaw: typeof storeCredit.redeem;
  reverseRaw: typeof storeCredit.reverse;
  balance: typeof storeCredit.getBalance;
  listMovements: typeof storeCredit.listCreditMovements;
}

/** Clube de fidelidade (pontos por real gasto) — funções "Raw" não abrem transação própria. */
export interface CommercialLoyaltyService {
  enabled: typeof loyalty.loyaltyEnabled;
  pointsForSaleCents: typeof loyalty.pointsForSaleCents;
  centsPerPoint: typeof loyalty.centsPerPoint;
  accrueRaw: typeof loyalty.accrue;
  redeemRaw: typeof loyalty.redeem;
  /** Estorna um RESGATE (devolve pontos gastos numa venda cancelada). */
  reverseRaw: typeof loyalty.reverse;
  /** Estorna um GANHO (remove pontos concedidos automaticamente por uma venda cancelada — pode ficar negativo). */
  reverseGrantRaw: typeof loyalty.reverseGrant;
  balance: typeof loyalty.getBalance;
  listMovements: typeof loyalty.listLoyaltyMovements;
}

export default function setup(): void {
  registerService('commercial.stock', { move: moveStock, moveRaw: moveStockRaw, listMovements } satisfies CommercialStockService);
  registerService('commercial.pricing', { resolvePrice, resolveMany } satisfies CommercialPricingService);
  registerService('commercial.storeCredit', {
    grantRaw: storeCredit.grant, redeemRaw: storeCredit.redeem, reverseRaw: storeCredit.reverse,
    balance: storeCredit.getBalance, listMovements: storeCredit.listCreditMovements,
  } satisfies CommercialStoreCreditService);
  registerService('commercial.loyalty', {
    enabled: loyalty.loyaltyEnabled, pointsForSaleCents: loyalty.pointsForSaleCents, centsPerPoint: loyalty.centsPerPoint,
    accrueRaw: loyalty.accrue, redeemRaw: loyalty.redeem, reverseRaw: loyalty.reverse, reverseGrantRaw: loyalty.reverseGrant,
    balance: loyalty.getBalance, listMovements: loyalty.listLoyaltyMovements,
  } satisfies CommercialLoyaltyService);
  registerRecomputeHook('stock_movements', recomputeStockForProducts);
  registerRecomputeHook('customer_credit_movements', storeCredit.recomputeStoreCreditForCustomers);
  registerRecomputeHook('loyalty_point_movements', loyalty.recomputeLoyaltyForCustomers);
}
