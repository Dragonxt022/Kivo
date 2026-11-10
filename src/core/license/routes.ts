import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { validateLicense, setLicense, getEntitledModules, type LicenseInfo } from './service';
import { canAutoUpdate, canSaveToCloud, planLabel } from './plans';
import { runSync } from '../sync/engine';
import { getCloudServerUrl } from '../config/cloud';

const router = Router();

function licensePayload(info: LicenseInfo) {
  return {
    ...info,
    planLabel: planLabel(info.plan),
    modules: getEntitledModules(),
    canAutoUpdate: canAutoUpdate(info.plan),
    canSaveToCloud: canSaveToCloud(info.plan),
  };
}

router.get('/', requirePermission('license.view'), (_req, res) => {
  res.json(licensePayload(validateLicense()));
});

/**
 * Versão enxuta, sem `license.view`: qualquer usuário logado precisa disso para a
 * faixa de trial / modal de bloqueio por vencimento (nav.ejs), não só quem administra
 * a licença. Protegida apenas pelo `requireAuth` já aplicado ao router em server.ts.
 */
router.get('/status', (_req, res) => {
  const info = validateLicense();
  res.json({
    status: info.status,
    plan: info.plan,
    planLabel: planLabel(info.plan),
    daysRemaining: info.daysRemaining,
    daysUntilBlock: info.daysUntilBlock,
    blockAt: info.blockAt,
    validUntil: info.validUntil,
    message: info.message,
    cloudIssue: info.cloudIssue,
    cloudIssueSince: info.cloudIssueSince,
    supportPhone: info.supportPhone,
    supportEmail: info.supportEmail,
    canSaveToCloud: canSaveToCloud(info.plan),
    sealPath: info.sealPath,
  });
});

/**
 * Proxy do selo do plano: a CSP do app só permite imagens da própria origem, então o
 * navegador não pode buscar direto no cloud. O servidor local busca o caminho salvo na
 * validação e devolve a imagem; se o cloud estiver fora do ar, a view cai na imagem
 * padrão local (`/img/plano_<plano>.jpg`).
 */
router.get('/seal', async (req, res) => {
  // Sem `p`, serve o selo do plano atual (tela de licença). Com `p`, serve o selo de
  // qualquer plano do catálogo (modal de renovação / tela de planos). O caminho é sempre
  // validado abaixo, então isso não vira um proxy arbitrário.
  const path = typeof req.query.p === 'string' ? req.query.p : validateLicense().sealPath;
  const base = getCloudServerUrl();
  // Só aceita os caminhos que o próprio cloud publica — evita virar proxy arbitrário.
  if (!path || !base || !/^\/(planos\/selos|img\/planos)\//.test(path)) {
    res.status(404).end();
    return;
  }
  try {
    const target = new URL(path, base.endsWith('/') ? base : `${base}/`);
    const r = await fetch(target, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      res.status(404).end();
      return;
    }
    const type = r.headers.get('content-type') ?? 'image/jpeg';
    if (!/^image\//i.test(type)) {
      res.status(404).end();
      return;
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(bytes);
  } catch {
    res.status(404).end();
  }
});

/**
 * Salvar já sincroniza na hora (Fase 6f): sem isso, os efeitos (plano/módulos
 * corretos, backups da nuvem disponíveis) só apareciam depois de um "Sincronizar
 * agora" manual — que ficava escondido até a página recarregar. `sync` no retorno
 * é best-effort: se a nuvem estiver fora do ar, a licença é salva do mesmo jeito.
 */
router.put('/', requirePermission('license.edit'), async (req, res) => {
  const { companyUuid, licenseKey, plan, validUntil } = req.body ?? {};
  if (!companyUuid || !licenseKey) {
    res.status(400).json({ error: 'Campos obrigatórios: companyUuid, licenseKey.' });
    return;
  }
  const before = validateLicense();
  setLicense(String(companyUuid), String(licenseKey), plan, validUntil);

  let sync: { pushed: number; pulled: number; skipped?: boolean } | null = null;
  let syncError: string | null = null;
  try {
    sync = await runSync(req);
  } catch (e) {
    syncError = (e as Error).message;
  }

  const after = validateLicense();
  audit(req, 'editar', 'license', 1, before, after);
  res.json({ ...licensePayload(after), sync, syncError });
});

export default router;
