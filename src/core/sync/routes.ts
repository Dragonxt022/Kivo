import { Router } from 'express';
import { requirePermission } from '../permissions/middleware';
import { audit } from '../audit/service';
import { runSync } from './engine';
import { CloudAuthError } from './client';
import { getSyncTables } from './registry';
import { getSqlite } from '../database/connection';
import { getCloudServerUrl } from '../config/cloud';
import { getLicenseCredentials } from '../license/service';
import { trySubmitPending } from '../catalog/submissionQueue';
import { createLogger } from '../logger';

const log = createLogger('submit');

const router = Router();

/**
 * Quantas linhas ainda não subiram para a nuvem, somando todas as tabelas sincronizáveis.
 * Alimenta o aviso de "vendas pendentes" no rodapé do PDV. Best-effort: uma tabela ausente
 * (módulo não instalado) não pode derrubar o indicador de conectividade.
 */
function pendingSyncCount(): number {
  let total = 0;
  for (const spec of getSyncTables()) {
    const condition = spec.ledgerFor ? 'synced_at IS NULL' : 'synced_at IS NULL OR synced_at < updated_at';
    try {
      const row = getSqlite().prepare(`SELECT COUNT(*) AS cnt FROM ${spec.table} WHERE ${condition}`).get() as { cnt: number };
      total += row.cnt;
    } catch {
      // tabela ainda não migrada / módulo fora do plano — ignora
    }
  }
  return total;
}

/**
 * Conectividade com a nuvem para o ícone da navbar (polling leve, não é SSE ainda).
 * Sem permissão dedicada: qualquer usuário logado pode ver se está online, mesmo sem
 * `license.view` — é só um indicador, não expõe nada sensível.
 */
router.get('/status', async (_req, res) => {
  const url = getCloudServerUrl();
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const pending = pendingSyncCount();
  if (!url || !companyUuid || !licenseKey) {
    res.json({ configured: false, online: false, url: null, pending });
    return;
  }
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(4000) });
    res.json({ configured: true, online: r.ok, url, pending });
  } catch {
    res.json({ configured: true, online: false, url, pending });
  }
});

/** Dispara push+pull manual com o cloud/ (Fase 6a). Automatização/agendamento fica para depois. */
router.post('/run', requirePermission('sync.run'), async (req, res) => {
  try {
    const result = await runSync(req);
    // Independe do gate de plano do sync de tabelas: imagens de produto podem ser
    // contribuídas ao banco do Cloud por qualquer plano (ver cloud/src/routes/catalog.ts).
    trySubmitPending().catch((e) => log.error('erro no sync manual', e));
    if (result.skipped) {
      res.status(403).json({ error: 'Sincronização em nuvem não incluída no plano atual.' });
      return;
    }
    audit(req, 'sync.run', 'sync', undefined, null, result);
    res.json(result);
  } catch (e) {
    // Empresa ausente/chave trocada na nuvem: mensagem explicativa, não um 502 genérico.
    if (e instanceof CloudAuthError) {
      res.status(409).json({ error: e.message, code: e.code });
      return;
    }
    res.status(502).json({ error: (e as Error).message });
  }
});

export default router;
