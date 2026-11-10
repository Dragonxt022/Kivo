import fs from 'node:fs';
import { Router } from 'express';
import { requireAdminAuth } from '../adminAuth';
import { parseAmountCents } from '../format';
import {
  createPlan,
  getPlanDefinitions,
  getPlanPromos,
  loadPlanCatalog,
  PLAN_FEATURES,
  savePlanPromos,
  savePlanSeal,
  setPlanActive,
  updatePlan,
  type PlanPromoConfig,
} from '../plans';
import { deletePlanSealFile, planSealPath, savePlanSealFile } from '../planSeals';

/**
 * Planos gerenciáveis pelo painel: cadastrar, editar (nome, descrição, preço,
 * dispositivos, dias e funcionalidades), pausar/reativar a venda e configurar
 * promoção e selo. O app e a página pública consomem o mesmo catálogo — o desktop
 * nunca envia preço, então uma alteração aqui vale para as próximas
 * assinaturas/cobranças sem depender de release.
 *
 * "Remover" é pausar (active = 0): a chave é referenciada por cobranças, assinaturas
 * e pelo plano da empresa, então quem já contratou segue válido e cobranças em aberto
 * continuam baixando normalmente.
 */
const router = Router();

router.get('/plans', requireAdminAuth, async (req, res) => {
  await loadPlanCatalog();
  res.render('admin-plans', {
    definitions: getPlanDefinitions(),
    promos: getPlanPromos(),
    featureOptions: PLAN_FEATURES,
    ok: typeof req.query.ok === 'string' ? req.query.ok : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  });
});

/** Cadastra um plano novo (vai para o ar imediatamente). */
router.post('/plans/create', requireAdminAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    await createPlan({
      key: body.key,
      label: body.label,
      description: body.description,
      priceCents: parseAmountCents(body.price),
      extendsDays: Number(body.extendsDays ?? 30),
      maxDevices: Number(body.maxDevices ?? 1),
      features: body.features ?? {},
    });
    res.redirect('/admin/plans?ok=' + encodeURIComponent(`Plano ${String(body.label).trim()} criado e disponível para venda.`));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

/** Edita um plano existente (a chave nunca muda). */
router.post('/plans/:key/update', requireAdminAuth, async (req, res) => {
  const key = String(req.params.key);
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    await updatePlan(key, {
      label: body.label,
      description: body.description,
      priceCents: parseAmountCents(body.price),
      extendsDays: Number(body.extendsDays ?? 30),
      maxDevices: Number(body.maxDevices ?? 1),
      features: body.features ?? {},
    });
    // Promoção viaja no mesmo formulário: valida e grava junto (só p/ planos conhecidos).
    await savePlanPromos({
      [key]: {
        promoPriceCents: body.promo ? parseAmountCents(body.promo) : null,
        promoLabel: String(body.promoLabel ?? '').trim() || null,
        promoUntil: String(body.promoUntil ?? '').trim() || null,
      } as Partial<PlanPromoConfig>,
    });
    res.redirect('/admin/plans?ok=' + encodeURIComponent(`Plano ${key} atualizado.`));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

/** Pausa ou reativa a venda de um plano. */
router.post('/plans/:key/toggle', requireAdminAuth, async (req, res) => {
  const key = String(req.params.key);
  await loadPlanCatalog();
  const def = getPlanDefinitions().find((d) => d.key === key);
  if (!def) {
    res.redirect('/admin/plans?error=' + encodeURIComponent('Plano não encontrado.'));
    return;
  }
  try {
    await setPlanActive(key, !def.active);
    res.redirect('/admin/plans?ok=' + encodeURIComponent(
      def.active
        ? `Venda do plano ${def.label} pausada. Quem já contratou continua válido; cobranças em aberto continuam baixando.`
        : `Plano ${def.label} ativado e de volta ao catálogo de venda.`,
    ));
  } catch (e) {
    res.redirect('/admin/plans?error=' + encodeURIComponent((e as Error).message));
  }
});

/**
 * Selo do plano: imagem enviada como data URL. O arquivo vai para `storage/plan-seals/`
 * e o nome fica no registro de promoções; a troca apaga o arquivo anterior.
 */
router.post('/plans/:key/seal', requireAdminAuth, async (req, res) => {
  const key = String(req.params.key);
  await loadPlanCatalog();
  const atual = getPlanPromos()[key]?.sealFile ?? null;
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
  await loadPlanCatalog();
  const atual = getPlanPromos()[key]?.sealFile ?? null;
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
