import type { Request } from 'express';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
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

export function loyaltyEnabled(): boolean {
  return settingsRepository.getBool('fidelidade.ativo', false);
}

export function pointsPerReal(): number {
  const v = settingsRepository.get('fidelidade.pontos_por_real');
  return v ? Number(v) : 1;
}

export function centsPerPoint(): number {
  const pontos = Number(settingsRepository.get('fidelidade.pontos_resgate') ?? '100');
  const valorCents = Number(settingsRepository.get('fidelidade.valor_resgate_cents') ?? '500');
  return pontos > 0 ? valorCents / pontos : 0;
}

export function pointsForSaleCents(amountCents: number): number {
  return Math.floor((amountCents * pointsPerReal()) / 100);
}

export const accrue = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  grantRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

export const redeem = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  redeemRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

export const reverse = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  reverseRedeemRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

export const reverseGrant = (req: Request, customerId: number, points: number, reason?: string, refEntity?: string, refId?: string | number) =>
  reverseGrantRaw(LOYALTY_CFG, req, customerId, points, reason, refEntity, refId);

export const getBalance = (customerId: number) => balance(LOYALTY_CFG, customerId);

export const listLoyaltyMovements = (customerId: number, limit?: number) => listMovements(LOYALTY_CFG, customerId, limit);

export const recomputeLoyaltyForCustomers = (customerIds: number[]) => recomputeForCustomers(LOYALTY_CFG, customerIds);
