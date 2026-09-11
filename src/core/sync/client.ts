import { getLicenseCredentials } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';
import type { OutgoingRecord, IncomingRecord } from './types';

export interface PullPage {
  records: IncomingRecord[];
  nextCursor: string | null;
}

/**
 * Recusa AUTORITATIVA da nuvem sobre esta empresa (não é rede fora do ar):
 *  - `company_not_found`: a empresa foi excluída/desativada no painel cloud (404).
 *  - `invalid_credentials`: a chave de licença mudou/rotacionou (401).
 *
 * Quem captura isto deve tratar como aviso ao lojista — o Kivo segue operando até a
 * validade local vencer — e não como falha genérica de sincronização.
 */
export class CloudAuthError extends Error {
  readonly code: 'company_not_found' | 'invalid_credentials';

  constructor(code: 'company_not_found' | 'invalid_credentials', message: string) {
    super(message);
    this.name = 'CloudAuthError';
    this.code = code;
  }
}

/** Traduz a resposta de erro da nuvem; lança `CloudAuthError` para empresa ausente/chave trocada. */
async function throwFromResponse(prefix: string, res: Response): Promise<never> {
  let body: { error?: string; code?: string } = {};
  try {
    body = (await res.json()) as { error?: string; code?: string };
  } catch {
    // corpo não-JSON (proxy, HTML de erro): segue com a mensagem pelo status
  }
  if (res.status === 404 || body.code === 'company_not_found') {
    throw new CloudAuthError(
      'company_not_found',
      'A empresa desta licença não existe mais no servidor (foi excluída ou desativada). O Kivo continua funcionando até a licença vencer. Contate o suporte para reativar.',
    );
  }
  if (res.status === 401 || body.code === 'invalid_credentials') {
    throw new CloudAuthError(
      'invalid_credentials',
      'A chave de licença não é mais aceita pelo servidor (pode ter sido alterada). O Kivo continua funcionando até a licença vencer. Contate o suporte.',
    );
  }
  throw new Error(`${prefix}: ${res.status}${body.error ? ` ${body.error}` : ''}`);
}

function baseUrl(): string {
  const url = getCloudServerUrl();
  if (!url) throw new Error('Servidor de sincronização não configurado (veja Configurações → Licença).');
  return url.replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  if (!companyUuid || !licenseKey) {
    throw new Error('Licença não configurada (company_uuid/license_key ausentes) — configure em /api/license.');
  }
  return {
    'Content-Type': 'application/json',
    'X-Kivo-Company': companyUuid,
    'X-Kivo-License-Key': licenseKey,
  };
}

/** Envia um lote de registros alterados localmente para o cloud/ (idempotente). */
export async function pushBatch(machineId: string, batch: OutgoingRecord[]): Promise<void> {
  if (!batch.length) return;
  const res = await fetch(`${baseUrl()}/api/sync/push`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ machineId, batch }),
  });
  if (!res.ok) await throwFromResponse('Push de sync falhou', res);
}

/** Busca uma página de registros alterados por outras máquinas desde o cursor informado. */
export async function pullBatch(cursor: string | null): Promise<PullPage> {
  const qs = new URLSearchParams({ limit: '500', ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${baseUrl()}/api/sync/pull?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) await throwFromResponse('Pull de sync falhou', res);
  return (await res.json()) as PullPage;
}

export interface CompanyResetResult {
  syncRecordsRemoved: number;
  menuItemsRemoved: number;
  backupsRemoved: number;
}

/**
 * Apaga na nuvem o histórico sincronizado da empresa (reset de fábrica).
 *
 * Chamado ANTES de zerar o banco local, e é obrigatório que dê certo: como o `pullAll()`
 * reconstrói tudo a partir de `sync_records` a cada rodada, zerar só o local devolveria
 * os dados de teste no ciclo seguinte.
 */
export async function resetCompanyData(includeBackups: boolean): Promise<CompanyResetResult> {
  const res = await fetch(`${baseUrl()}/api/sync/company-reset`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ includeBackups }),
  });
  if (!res.ok) await throwFromResponse('Reset na nuvem falhou', res);
  return (await res.json()) as CompanyResetResult;
}
