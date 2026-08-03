import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { hasCapability } from '../../core/capabilities/service';

/**
 * Páginas do módulo fiscal (montadas em /app/fiscal, já autenticadas).
 *
 * Com o beta desligado a página redireciona para a home em vez de renderizar: o item nem
 * aparece no menu (`capability` no manifesto), então chegar aqui significa URL digitada
 * à mão ou um link antigo.
 */
const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!hasCapability('fiscal.nfce')) return res.redirect('/');
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

router.get('/notas', page('fiscal-documents', 'fiscal.documents.view'));
router.get('/configuracao', page('fiscal-config', 'fiscal.config.view'));
router.get('/produtos', page('fiscal-products', 'fiscal.config.edit'));

export default router;
