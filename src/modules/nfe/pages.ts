import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { hasCapability } from '../../core/capabilities/service';

/** Páginas do módulo nfe (montadas em /app/nfe, já autenticadas). */
const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!hasCapability('nfe.import')) return res.redirect('/');
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

router.get('/importar', page('nfe-import', 'nfe.import.view'));

export default router;
