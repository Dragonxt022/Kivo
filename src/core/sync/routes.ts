import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { runSync } from './engine';
import { getCloudServerUrl } from '../config/cloud';
import { getLicenseCredentials } from '../license/service';

const router = Router();

/**
 * Conectividade com a nuvem para o ícone da navbar (polling leve, não é SSE ainda).
 * Sem permissão dedicada: qualquer usuário logado pode ver se está online, mesmo sem
 * `license.view` — é só um indicador, não expõe nada sensível.
 */
router.get('/status', async (_req, res) => {
  const url = getCloudServerUrl();
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!url || !companyUuid || !licenseKey) {
    res.json({ configured: false, online: false });
    return;
  }
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(4000) });
    res.json({ configured: true, online: r.ok });
  } catch {
    res.json({ configured: true, online: false });
  }
});

/** Dispara push+pull manual com o cloud/ (Fase 6a). Automatização/agendamento fica para depois. */
router.post('/run', requirePermission('sync.run'), async (req, res) => {
  try {
    const result = await runSync(req);
    if (result.skipped) {
      res.status(403).json({ error: 'Sincronização em nuvem não incluída no plano atual.' });
      return;
    }
    audit(req, 'sync.run', 'sync', undefined, null, result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
