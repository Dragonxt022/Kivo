import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { fetchCloudCharges, fetchUrgentCharges } from './service';

const router = Router();

router.get('/charges', requirePermission('billing.view'), async (_req, res) => {
  res.json(await fetchCloudCharges());
});

router.get('/alert', requirePermission('billing.view'), async (_req, res) => {
  const urgent = await fetchUrgentCharges();
  res.json({ count: urgent.length, charges: urgent });
});

export default router;
