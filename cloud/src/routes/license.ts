import { Router } from 'express';
import { getPool } from '../db';
import { requireCompanyAuth, type AuthedRequest } from '../auth';

const router = Router();

interface CompanyLicenseRow {
  plan: string | null;
  modules: string[] | string | null;
  valid_until: string | null;
}

router.get('/validate', requireCompanyAuth, async (req: AuthedRequest, res) => {
  const [rows] = await getPool().query('SELECT plan, modules, valid_until FROM companies WHERE company_uuid = ?', [
    req.companyUuid,
  ]);
  const company = (rows as CompanyLicenseRow[])[0];
  // `modules` NULL = nunca configurado no cloud/ (sem restrição ainda, fail-open) —
  // diferente de `[]` (configurado explicitamente como "nenhum módulo"), que bloqueia tudo.
  const modules = company?.modules == null ? null : typeof company.modules === 'string' ? JSON.parse(company.modules) : company.modules;

  // Contato de suporte é global (do fornecedor Katsu), não por empresa — mesmo valor para todas.
  const [settingsRows] = await getPool().query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('support_phone','support_email')",
  );
  const settingsMap = Object.fromEntries(
    (settingsRows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );

  res.json({
    plan: company?.plan ?? null,
    modules,
    validUntil: company?.valid_until ?? null,
    supportPhone: settingsMap.support_phone ?? null,
    supportEmail: settingsMap.support_email ?? null,
  });
});

export default router;
