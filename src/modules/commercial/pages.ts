import { Router, type Request, type Response } from 'express';
import { assertAuth } from '../../shared/auth';
import { hasCapability } from '../../core/capabilities/service';

/** Páginas do módulo commercial (montadas em /app/commercial, já autenticadas). */
const router = Router();

function page(view: string, permission: string) {
  return (req: Request, res: Response) => {
    assertAuth(req);
    if (!req.user.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user, caps: capabilitiesForView() });
  };
}

/** Flags de recursos opcionais para a UI esconder/desabilitar elementos. */
export function capabilitiesForView() {
  return {
    variantes: hasCapability('commercial.variantes'),
    complementos: hasCapability('commercial.complementos'),
    kits: hasCapability('commercial.kits'),
    producao: hasCapability('commercial.producao'),
    cardapioOnline: hasCapability('commercial.cardapio_online'),
    // Módulo nfe (importação de XML): o card no modal de importar/exportar só aparece com
    // o recurso ligado E o módulo no plano — mesma régua do menu.
    nfe: hasCapability('nfe.import'),
  };
}

router.get('/clientes', page('commercial-customers', 'commercial.customers.view'));
router.get('/clientes/:id', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('commercial.customers.view')) return res.redirect('/');
  res.render('commercial-customer-ficha', { user: req.user, customerId: Number(req.params.id) });
});
router.get('/clientes/:id/compras', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('commercial.customers.view')) return res.redirect('/');
  res.render('commercial-customer-purchases', { user: req.user, customerId: Number(req.params.id) });
});
router.get('/clientes/:id/financeiro', (req, res) => {
  assertAuth(req);
  if (!req.user.permissions.has('commercial.customers.view')) return res.redirect('/');
  res.render('commercial-customer-receivables', { user: req.user, customerId: Number(req.params.id) });
});
router.get('/fornecedores', page('commercial-suppliers', 'commercial.suppliers.view'));
router.get('/produtos', page('commercial-products', 'commercial.products.view'));
router.get('/lotes', page('commercial-lots', 'commercial.stock.view'));
router.get('/categorias', page('commercial-categories', 'commercial.products.view'));
router.get('/listas-de-preco', page('commercial-price-lists', 'commercial.pricelists.view'));
router.get('/compras', page('commercial-purchases', 'commercial.purchases.view'));

export default router;
