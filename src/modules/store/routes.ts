import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { validateBody } from '../../shared/validateBody';
import { createSaleSchema, createQuoteSchema, updateQuoteSchema } from '../../shared/schemas';
import { storeController } from './controllers/StoreController';

const router = Router();

router.get('/payment-methods', requirePermission('store.sales.create'), storeController.listPaymentMethods);
router.post('/sales', requirePermission('store.sales.create'), validateBody(createSaleSchema), storeController.createSaleAction);
router.get('/sales', requirePermission('store.sales.view'), storeController.listSales);
router.get('/sales/:id', requirePermission('store.sales.view'), storeController.getSale);
router.post('/sales/:id/cancel', requirePermission('store.sales.cancel'), storeController.cancelSaleAction);

router.get('/quotes', requirePermission('store.quotes.view'), storeController.listQuotes);
router.get('/quotes/:id', requirePermission('store.quotes.view'), storeController.getQuote);
router.post('/quotes', requirePermission('store.quotes.create'), validateBody(createQuoteSchema), storeController.createQuoteAction);
router.put('/quotes/:id', requirePermission('store.quotes.edit'), validateBody(updateQuoteSchema), storeController.updateQuoteAction);
router.post('/quotes/:id/convert', requirePermission('store.sales.create'), storeController.convertQuoteAction);
router.post('/quotes/:id/cancel', requirePermission('store.quotes.create'), storeController.cancelQuoteAction);

router.get('/reports/daily', requirePermission('store.reports.view'), storeController.dailyReport);
router.get('/reports/cash-register/:id', requirePermission('store.reports.view'), storeController.cashRegisterReportAction);

export default router;
