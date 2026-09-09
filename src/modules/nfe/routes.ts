import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { requireCapability } from '../../core/capabilities/middleware';
import { nfeController } from './controllers/NfeController';

const router = Router();

// Todo o módulo fica atrás da capability — desligada, nada responde (403 + gate).
router.use(requireCapability('nfe.import'));

router.get('/products', requirePermission('nfe.import.view'), nfeController.searchProducts);
router.get('/invoices', requirePermission('nfe.import.view'), nfeController.listInvoices);
router.post('/preview', requirePermission('nfe.import.view'), nfeController.preview);
router.post('/commit', requirePermission('nfe.import.run'), nfeController.commit);

export default router;
