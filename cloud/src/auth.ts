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
 * localmente em `license` no Kivo). Sessão/JWT de verdade fica para a 6b.
 */
export async function requireCompanyAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const companyUuid = req.header('X-Kivo-Company');
  const licenseKey = req.header('X-Kivo-License-Key');
  if (!companyUuid || !licenseKey) {
    res.status(401).json({
      error: 'Credenciais ausentes (X-Kivo-Company / X-Kivo-License-Key).',
      code: 'credentials_missing',
    });
    return;
  }
  const [rows] = await getPool().query('SELECT license_key_hash, plan FROM companies WHERE company_uuid = ?', [
    companyUuid,
  ]);
  const company = (rows as { license_key_hash: string; plan: string | null }[])[0];
  // Empresa inexistente = foi excluída (ou nunca existiu) no painel cloud. É diferente de
  // chave errada: o `code` deixa o desktop explicar ao lojista em vez de só "credenciais
  // inválidas". Aqui, empresa some → 404; chave não confere → 401.
  if (!company) {
    res.status(404).json({
      error: 'Empresa não encontrada no servidor (foi excluída ou desativada).',
      code: 'company_not_found',
    });
    return;
  }
  if (company.license_key_hash !== hashLicenseKey(licenseKey)) {
    res.status(401).json({ error: 'Credenciais inválidas.', code: 'invalid_credentials' });
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
