import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { validateLicense } from '../license/service';
import { canSaveToCloud } from '../license/plans';
import { runSync } from './engine';

const router = Router();

/** Dispara push+pull manual com o cloud/ (Fase 6a). Automatização/agendamento fica para depois. */
router.post('/run', requirePermission('sync.run'), async (req, res) => {
  if (!canSaveToCloud(validateLicense().plan)) {
    res.status(403).json({ error: 'Sincronização em nuvem não incluída no plano atual.' });
    return;
  }
  try {
    const result = await runSync(req);
    audit(req, 'sync.run', 'sync', undefined, null, result);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
