import fs from 'node:fs';
import { Router } from 'express';
import { requireAdminAuth } from '../adminAuth';
import { parseAmountCents } from '../format';
import {
  getPlanDefinitions,
  getPlanPricing,
  loadPlanPricing,
  savePlanPricing,
  savePlanSeal,
  type PlanPricingConfig,
} from '../plans';
import { deletePlanSealFile, planSealPath, savePlanSealFile } from '../planSeals';

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
      // Preservado por `savePlanPricing`; o formulário de preços não mexe no selo.
      sealFile: null,
    };
  }
  try {
    await savePlanPricing(next);
    res.redirect('/admin/plans?ok=' + encodeURIComponent('Preços e promoções atualizados.'));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

/**
 * Selo do plano: imagem enviada como data URL. O arquivo vai para `storage/plan-seals/`
 * e o nome fica no JSON de preços; a troca apaga o arquivo anterior.
 */
router.post('/plans/:key/seal', requireAdminAuth, async (req, res) => {
  const key = String(req.params.key);
  await loadPlanPricing();
  const atual = getPlanPricing()[key as keyof PlanPricingConfig]?.sealFile ?? null;
  try {
    const file = savePlanSealFile(key, String((req.body ?? {}).image ?? ''));
    await savePlanSeal(key, file);
    deletePlanSealFile(atual);
    res.redirect('/admin/plans?ok=' + encodeURIComponent('Selo do plano atualizado.'));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

router.post('/plans/:key/seal/remove', requireAdminAuth, async (req, res) => {
  const key = String(req.params.key);
  await loadPlanPricing();
  const atual = getPlanPricing()[key as keyof PlanPricingConfig]?.sealFile ?? null;
  try {
    await savePlanSeal(key, null);
    deletePlanSealFile(atual);
    res.redirect('/admin/plans?ok=' + encodeURIComponent('Selo padrão restaurado.'));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

/**
 * Imagem do selo personalizado. Fica fora de `/admin` porque é exibida no app do
 * cliente (e na página de assinatura) sem sessão de administrador.
 */
export const publicPlanSealsRouter = Router();

publicPlanSealsRouter.get('/planos/selos/:file', (req, res) => {
  const file = String(req.params.file);
  const target = planSealPath(file);
  if (!target || !fs.existsSync(target)) {
    res.status(404).end();
    return;
  }
  // O nome tem sufixo aleatório: quando o selo é trocado, a URL muda.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.sendFile(target);
});

export default router;
