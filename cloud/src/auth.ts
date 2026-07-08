import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from './db';
import { canSaveToCloud } from './plans';

export function hashLicenseKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface AuthedRequest extends Request {
  companyUuid?: string;
  companyPlan?: string | null;
}

/**
 * Autenticação mínima da 6a: par company_uuid + license_key (o mesmo já guardado
 * localmente em `license` no Katsu). Sessão/JWT de verdade fica para a 6b.
 */
export async function requireCompanyAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const companyUuid = req.header('X-Katsu-Company');
  const licenseKey = req.header('X-Katsu-License-Key');
  if (!companyUuid || !licenseKey) {
    res.status(401).json({ error: 'Credenciais ausentes (X-Katsu-Company / X-Katsu-License-Key).' });
    return;
  }
  const [rows] = await getPool().query('SELECT license_key_hash, plan FROM companies WHERE company_uuid = ?', [
    companyUuid,
  ]);
  const company = (rows as { license_key_hash: string; plan: string | null }[])[0];
  if (!company || company.license_key_hash !== hashLicenseKey(licenseKey)) {
    res.status(401).json({ error: 'Credenciais inválidas.' });
    return;
  }
  req.companyUuid = companyUuid;
  req.companyPlan = company.plan;
  next();
}

/**
 * Gate por plano comercial (Fase 6e): Trial/Prata não podem salvar dados na nuvem
 * (sync push/pull, upload de backup). Roda depois de `requireCompanyAuth`, que
 * preenche `req.companyPlan`.
 */
export function requireCloudSavePlan(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!canSaveToCloud(req.companyPlan)) {
    res.status(403).json({ error: 'Sincronização/backup em nuvem não incluído neste plano.' });
    return;
  }
  next();
}
