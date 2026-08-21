import { Router } from 'express';
import { validateBody } from '../../shared/validateBody';
import { activateLicenseSchema } from '../../shared/schemas';
import { activateLicense, requestTrial, isActivated } from './service';

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

router.post('/api/activation/activate', validateBody(activateLicenseSchema), async (req, res) => {
  const { companyUuid, licenseKey } = req.body;
  // UUID opcional: sem ele, `activateLicense` pergunta à nuvem a qual empresa a chave
  // pertence. O campo continua existindo na tela (recolhido) para licença antiga e para
  // quando a nuvem não conseguir resolver.
  const uuid = companyUuid ? String(companyUuid).trim() : '';
  const result = await activateLicense(uuid || null, String(licenseKey).trim());
  if (!result.ok) {
    const statusCode = result.reason === 'offline' ? 503 : result.reason === 'invalid_credentials' ? 401 : 403;
    res.status(statusCode).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({ ok: true });
});

router.post('/api/activation/request-trial', async (_req, res) => {
  const result = await requestTrial();
  if (!result.ok) {
    const statusCode = result.reason === 'offline' ? 503 : 409;
    res.status(statusCode).json({ error: result.error, reason: result.reason });
    return;
  }
  res.json({ ok: true });
});

export default router;
