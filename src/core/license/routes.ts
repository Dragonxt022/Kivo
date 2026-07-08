import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { validateLicense, setLicense, getEntitledModules } from './service';
import { canAutoUpdate, canSaveToCloud } from './plans';

const router = Router();

router.get('/', requirePermission('license.view'), (_req, res) => {
  const info = validateLicense();
  res.json({
    ...info,
    modules: getEntitledModules(),
    canAutoUpdate: canAutoUpdate(info.plan),
    canSaveToCloud: canSaveToCloud(info.plan),
  });
});

/**
 * Versão enxuta, sem `license.view`: qualquer usuário logado precisa disso para a
 * faixa de trial / modal de bloqueio por vencimento (nav.ejs), não só quem administra
 * a licença. Protegida apenas pelo `requireAuth` já aplicado ao router em server.ts.
 */
router.get('/status', (_req, res) => {
  const info = validateLicense();
  res.json({
    status: info.status,
    plan: info.plan,
    daysRemaining: info.daysRemaining,
    message: info.message,
    supportPhone: info.supportPhone,
    supportEmail: info.supportEmail,
  });
});

router.put('/', requirePermission('license.edit'), (req, res) => {
  const { companyUuid, licenseKey, plan, validUntil } = req.body ?? {};
  if (!companyUuid || !licenseKey) {
    res.status(400).json({ error: 'Campos obrigatórios: companyUuid, licenseKey.' });
    return;
  }
  const before = validateLicense();
  setLicense(String(companyUuid), String(licenseKey), plan, validUntil);
  const after = validateLicense();
  audit(req, 'editar', 'license', 1, before, after);
  res.json(after);
});

export default router;
