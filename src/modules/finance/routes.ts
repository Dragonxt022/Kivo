import { Router } from 'express';
import { requirePermission } from '../../core/permissions/middleware';
import { makeBillsRouter, PAYABLES_CONFIG, RECEIVABLES_CONFIG } from './bills';
import { validateBody } from '../../shared/validateBody';
import { openRegisterSchema, closeRegisterSchema } from '../../shared/schemas';
import { financeController } from './controllers/FinanceController';

const router = Router();

router.get('/payment-methods', requirePermission('finance.paymethods.view'), financeController.listPaymentMethods);
router.get('/payment-methods/active', financeController.listPaymentMethodsActive);
router.post('/payment-methods', requirePermission('finance.paymethods.edit'), financeController.createPaymentMethod);
router.put('/payment-methods/:id', requirePermission('finance.paymethods.edit'), financeController.updatePaymentMethod);
router.delete('/payment-methods/:id', requirePermission('finance.paymethods.delete'), financeController.deletePaymentMethod);

router.get('/cash/current', requirePermission('finance.cash.view'), financeController.getCurrentCash);
router.get('/cash/movements', requirePermission('finance.cash.view'), financeController.listCashMovements);
router.get('/cash/movements/export.csv', requirePermission('finance.cash.view'), financeController.exportCashLedger);
router.get('/cash/history', requirePermission('finance.cash.view'), financeController.listCashHistory);
router.post('/cash/open', requirePermission('finance.cash.open'), validateBody(openRegisterSchema), financeController.openCashAction);
router.post('/cash/close', requirePermission('finance.cash.close'), validateBody(closeRegisterSchema), financeController.closeCashAction);
router.put('/cash/:id', requirePermission('finance.cash.edit'), financeController.editCashAction);
router.post('/cash/movement', requirePermission('finance.cash.move'), financeController.createCashMovement);

router.use('/payables', makeBillsRouter(PAYABLES_CONFIG));
router.use('/receivables', makeBillsRouter(RECEIVABLES_CONFIG));

router.get('/agreements/:companyId/pending', requirePermission('finance.agreements.view'), financeController.getPendingAgreement);
router.post('/agreements/:companyId/invoice', requirePermission('finance.agreements.invoice'), financeController.generateInvoiceAction);

router.get('/reconciliation/negative-balances', requirePermission('finance.reconciliation.view'), financeController.getNegativeBalances);

router.get('/reports/cashflow', requirePermission('finance.reports.view'), financeController.cashflowReport);
router.get('/reports/upcoming-bills', financeController.upcomingBills);

export default router;
