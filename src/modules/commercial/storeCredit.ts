import type { Request } from 'express';
import { grantRaw, redeemRaw, reverseRedeemRaw, reverseGrantRaw, balance, recomputeForCustomers, listMovements, type LedgerCfg } from './customerLedger';

export const STORE_CREDIT_CFG: LedgerCfg = {
  table: 'customer_credit_movements',
  amountColumn: 'amount_cents',
  balanceColumn: 'store_credit_cents',
  grantType: 'concessao',
  redeemType: 'resgate',
  reverseRedeemType: 'estorno_resgate',
  reverseGrantType: 'estorno_ganho',
  label: 'crédito de troca',
};

export const grant = (req: Request, customerId: number, amountCents: number, reason?: string, refEntity?: string, refId?: string | number) =>
  grantRaw(STORE_CREDIT_CFG, req, customerId, amountCents, reason, refEntity, refId);

export const redeem = (req: Request, customerId: number, amountCents: number, reason?: string, refEntity?: string, refId?: string | number) =>
  redeemRaw(STORE_CREDIT_CFG, req, customerId, amountCents, reason, refEntity, refId);

/** Estorna crédito de loja gasto numa venda cancelada (devolve o saldo). */
export const reverse = (req: Request, customerId: number, amountCents: number, reason?: string, refEntity?: string, refId?: string | number) =>
  reverseRedeemRaw(STORE_CREDIT_CFG, req, customerId, amountCents, reason, refEntity, refId);

/** Estorna crédito de loja concedido (ex.: concessão feita por engano) — não usado hoje pelo cancelamento de venda, disponível para uso futuro. */
export const reverseGrant = (req: Request, customerId: number, amountCents: number, reason?: string, refEntity?: string, refId?: string | number) =>
  reverseGrantRaw(STORE_CREDIT_CFG, req, customerId, amountCents, reason, refEntity, refId);

export const getBalance = (customerId: number) => balance(STORE_CREDIT_CFG, customerId);

export const listCreditMovements = (customerId: number, limit?: number) => listMovements(STORE_CREDIT_CFG, customerId, limit);

export const recomputeStoreCreditForCustomers = (customerIds: number[]) => recomputeForCustomers(STORE_CREDIT_CFG, customerIds);
