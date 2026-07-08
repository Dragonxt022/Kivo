import { Router, type Request, type Response } from 'express';

/** Páginas do módulo commercial (montadas em /app/commercial, já autenticadas). */
const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    if (!req.user!.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

router.get('/clientes', page('commercial-customers', 'commercial.customers.view'));
router.get('/fornecedores', page('commercial-suppliers', 'commercial.suppliers.view'));
router.get('/produtos', page('commercial-products', 'commercial.products.view'));
router.get('/listas-de-preco', page('commercial-price-lists', 'commercial.pricelists.view'));
router.get('/compras', page('commercial-purchases', 'commercial.purchases.view'));

export default router;
