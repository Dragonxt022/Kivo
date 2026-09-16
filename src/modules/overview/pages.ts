import { Router } from 'express';
import { assertAuth } from '../../shared/auth';

/** Página do Painel (montada em /app/overview, já autenticada). */
const router = Router();

router.get('/', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('overview.view')) return res.redirect('/');
  res.render('overview-panel', { user: req.user });
});

export default router;
