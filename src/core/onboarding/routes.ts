import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { onboardingController } from './controller';

const router = Router();

router.get('/status', onboardingController.status);
router.get('/payment-methods', requirePermission('settings.edit'), onboardingController.paymentMethods);
router.post('/skip', onboardingController.skip);
router.post('/provision', requirePermission('settings.edit'), onboardingController.provisionAction);

export default router;
