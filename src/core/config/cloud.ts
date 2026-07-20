import { getSqlite } from '../database/connection';

/**
 * URL de fábrica do cloud/, embutida no instalador. Só serve de último fallback —
 * ver `getCloudServerUrl()` para a resolução real usada em runtime.
 */
export const PRODUCTION_CLOUD_URL = 'https://kivo.buscamais.org';

const SETTING_KEY = 'sync.server_url';

/**
 * Resolve a URL do cloud/ nesta ordem: (1) setting `sync.server_url`, editável na tela
 * de Configurações sem precisar gerar/reinstalar um novo `.exe`; (2)
 * `KIVO_SYNC_SERVER_URL` (env, usado por testes/dev para apontar a um cloud/ local);
 * (3) `PRODUCTION_CLOUD_URL` (valor de fábrica do instalador). Retorna `null` só se
 * nenhuma das três estiver definida (app roda 100% offline).
 *
 * Normaliza o valor (tira espaço/barra sobrando, completa `https://` quando o admin
 * digita só o domínio) — sem isso um valor colado errado na tela de Configurações
 * quebra o `fetch()` com um erro genérico de "sem conexão", escondendo a causa real.
 */
export function getCloudServerUrl(): string | null {
  const row = getSqlite()
    .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
    .get(SETTING_KEY) as { value: string | null } | undefined;
  const raw = (row?.value || process.env.KIVO_SYNC_SERVER_URL || PRODUCTION_CLOUD_URL || '').trim();
  if (!raw) return null;
  const noTrailingSlash = raw.replace(/\/+$/, '');
  return /^https?:\/\//i.test(noTrailingSlash) ? noTrailingSlash : `https://${noTrailingSlash}`;
}
