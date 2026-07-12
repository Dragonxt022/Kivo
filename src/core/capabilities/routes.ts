import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { listCapabilities, setCapabilityEnabled } from './service';

const router = Router();

router.get('/', requirePermission('settings.capabilities.edit'), (_req, res) => {
  res.json(listCapabilities());
});

router.put('/:key', requirePermission('settings.capabilities.edit'), (req, res) => {
  const key = String(req.params.key);
  const { enabled } = req.body ?? {};
  try {
    setCapabilityEnabled(req, key, !!enabled);
    res.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Erro ao alterar capability.';
    res.status(400).json({ error: message });
  }
});

export default router;
