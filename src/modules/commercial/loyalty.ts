import type { Request } from 'express';
import { getSqlite } from '../../core/database/connection';
import { grantRaw, redeemRaw, reverseRedeemRaw, reverseGrantRaw, balance, recomputeForCustomers, listMovements, type LedgerCfg } from './customerLedger';

export const LOYALTY_CFG: LedgerCfg = {
  table: 'loyalty_point_movements',
  amountColumn: 'points',
  balanceColumn: 'loyalty_points',
  grantType: 'ganho',
  redeemType: 'resgate',
  reverseRedeemType: 'estorno_resgate',
  reverseGrantType: 'estorno_ganho',
  label: 'pontos de fidelidade',
};

function settingValue(key: string): string | null {
  const row = getSqlite().prepare('SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL').get(key) as
    { value: string | null } | undefined;
  return row?.value ?? null;
}

/** "fidelidade.ativo": desativado por padrão (ausente = inativo) — feature opt-in. */
export function loyaltyEnabled(): boolean {
  return settingValue('fidelidade.ativo') === '1';
}

/** Pontos concedidos por real gasto (padrão: 1 ponto por R$1). */
export function pointsPerReal(): number {
  const v = settingValue('fidelidade.pontos_por_real');
  return v ? Number(v) : 1;
}

/** Quantos centavos vale 1 ponto no resgate (padrão: 100 pontos = R$5,00 → 5 centavos/ponto). */
export function centsPerPoint(): number {
  const pontos = Number(settingValue('fidelidade.pontos_resgate') ?? '100');
  const valorCents = Number(settingValue('fidelidade.valor_resgate_cents') ?? '500');
  return pontos > 0 ? valorCents / pontos : 0;
}

/** Pontos que uma venda de `amountCents` deveria gerar, arredondado pra baixo. */
export function pointsForSaleCents(amountCents: number): number {
  return Math.floor((amountCents * pointsPerReal()) / 100);
}

export const accrue = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  grantRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

export const redeem = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  redeemRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

/** Estorna pontos resgatados numa venda cancelada (devolve os pontos gastos). */
export const reverse = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  reverseRedeemRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

/** Estorna pontos GANHOS por uma venda cancelada (remove os pontos — pode ficar negativo se já gastos em outra compra). */
export const reverseGrant = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  reverseGrantRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

export const getBalance = (customerId: number) => balance(LOYALTY_CFG, customerId);

export const listLoyaltyMovements = (customerId: number, limit?: number) => listMovements(LOYALTY_CFG, customerId, limit);

export const recomputeLoyaltyForCustomers = (customerIds: number[]) => recomputeForCustomers(LOYALTY_CFG, customerIds);
