import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { validateLicense, setLicense, getEntitledModules, type LicenseInfo } from './service';
import { canAutoUpdate, canSaveToCloud } from './plans';
import { runSync } from '../sync/engine';

const router = Router();

function licensePayload(info: LicenseInfo) {
  return {
    ...info,
    modules: getEntitledModules(),
    canAutoUpdate: canAutoUpdate(info.plan),
    canSaveToCloud: canSaveToCloud(info.plan),
  };
}

router.get('/', requirePermission('license.view'), (_req, res) => {
  res.json(licensePayload(validateLicense()));
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

/**
 * Salvar já sincroniza na hora (Fase 6f): sem isso, os efeitos (plano/módulos
 * corretos, backups da nuvem disponíveis) só apareciam depois de um "Sincronizar
 * agora" manual — que ficava escondido até a página recarregar. `sync` no retorno
 * é best-effort: se a nuvem estiver fora do ar, a licença é salva do mesmo jeito.
 */
router.put('/', requirePermission('license.edit'), async (req, res) => {
  const { companyUuid, licenseKey, plan, validUntil } = req.body ?? {};
  if (!companyUuid || !licenseKey) {
    res.status(400).json({ error: 'Campos obrigatórios: companyUuid, licenseKey.' });
    return;
  }
  const before = validateLicense();
  setLicense(String(companyUuid), String(licenseKey), plan, validUntil);

  let sync: { pushed: number; pulled: number; skipped?: boolean } | null = null;
  let syncError: string | null = null;
  try {
    sync = await runSync(req);
  } catch (e) {
    syncError = (e as Error).message;
  }

  const after = validateLicense();
  audit(req, 'editar', 'license', 1, before, after);
  res.json({ ...licensePayload(after), sync, syncError });
});

export default router;
