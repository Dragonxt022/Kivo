import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { pinConfigured, setPin, verifyPin } from './service';

const router = Router();

/** Qualquer usuário autenticado pode saber SE existe um PIN configurado (não vaza o PIN em si). */
router.get('/pin/status', (_req, res) => {
  res.json({ configured: pinConfigured() });
});

router.put('/pin', requirePermission('security.pin.manage'), (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!/^\d{4,6}$/.test(pin)) {
    res.status(400).json({ error: 'PIN deve ter de 4 a 6 dígitos.' });
    return;
  }
  setPin(req, pin);
  res.json({ configured: true });
});

/**
 * Verifica o PIN para confirmar uma ação crítica. Sem permissão dedicada: qualquer
 * usuário logado pode tentar (é exatamente o operador do caixa quem vai digitar o PIN
 * do administrador para liberar a ação) — a segurança está no PIN em si, não em RBAC.
 */
router.post('/pin/verify', (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!pin) {
    res.status(400).json({ error: 'Informe o PIN.' });
    return;
  }
  res.json({ ok: verifyPin(req, pin) });
});

export default router;
