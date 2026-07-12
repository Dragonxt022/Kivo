import { Router } from 'express';
import { activateLicense, isActivated } from './service';

/**
 * Rotas PÚBLICAS (sem `requireAuth`) — a tela de ativação precisa ser alcançável antes
 * de existir qualquer sessão. Montadas em server.ts antes do gate `requireActivation`.
 */
const router = Router();

router.get('/ativacao', (_req, res) => {
  if (isActivated()) {
    res.redirect('/');
    return;
  }
  res.render('activation', { error: null });
});

router.post('/api/activation/activate', async (req, res) => {
  const { companyUuid, licenseKey } = req.body ?? {};
  if (!companyUuid || !licenseKey) {
    res.status(400).json({ error: 'Informe empresa e chave de licença.' });
    return;
  }
  const result = await activateLicense(String(companyUuid).trim(), String(licenseKey).trim());
  if (!result.ok) {
    const statusCode = result.reason === 'offline' ? 503 : result.reason === 'invalid_credentials' ? 401 : 403;
    res.status(statusCode).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({ ok: true });
});

export default router;
