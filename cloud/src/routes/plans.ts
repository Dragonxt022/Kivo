import { Router } from 'express';
import { requireAdminAuth } from '../adminAuth';
import { parseAmountCents } from '../format';
import {
  getPlanDefinitions,
  getPlanPricing,
  loadPlanPricing,
  savePlanPricing,
  type PlanPricingConfig,
} from '../plans';

/**
 * Preços comerciais configuráveis pelo painel. O app e a página pública consomem o
 * mesmo catálogo — o desktop nunca envia preço, então uma alteração aqui vale para as
 * próximas assinaturas/cobranças sem depender de release.
 */
const router = Router();

router.get('/plans', requireAdminAuth, async (req, res) => {
  await loadPlanPricing();
  res.render('admin-plans', {
    definitions: getPlanDefinitions(),
    pricing: getPlanPricing(),
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

router.post('/plans', requireAdminAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const next = {} as PlanPricingConfig;
  for (const def of getPlanDefinitions()) {
    const promoRaw = String(body[`promo_${def.key}`] ?? '').trim();
    next[def.key] = {
      priceCents: parseAmountCents(body[`price_${def.key}`]),
      promoPriceCents: promoRaw ? parseAmountCents(promoRaw) : null,
      promoLabel: String(body[`promo_label_${def.key}`] ?? '').trim() || null,
      promoUntil: String(body[`promo_until_${def.key}`] ?? '').trim() || null,
    };
  }
  try {
    await savePlanPricing(next);
    res.redirect('/admin/plans?ok=' + encodeURIComponent('Preços e promoções atualizados.'));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

export default router;
