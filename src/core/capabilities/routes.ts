import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { listCapabilities, setCapabilityEnabled } from './service';
import { scheduleMenuPublish } from '../menu/publisher';

const router = Router();

router.get('/', requirePermission('settings.capabilities.edit'), (_req, res) => {
  res.json(listCapabilities());
});

router.put('/:key', requirePermission('settings.capabilities.edit'), (req, res) => {
  const key = String(req.params.key);
  const { enabled } = req.body ?? {};
  try {
    setCapabilityEnabled(req, key, !!enabled);
    // Ligar/desligar o pedido por QR precisa refletir na página pública: ligar publica
    // o menu, desligar tira a página do ar (enabled=false no snapshot).
    if (key === 'comandas.pedido_qr') scheduleMenuPublish(600);
    res.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Erro ao alterar capability.';
    res.status(400).json({ error: message });
  }
});

export default router;
