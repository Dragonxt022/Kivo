import { getLicenseCredentials } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';
import type { OutgoingRecord, IncomingRecord } from './types';

export interface PullPage {
  records: IncomingRecord[];
  nextCursor: string | null;
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
  if (!res.ok) throw new Error(`Push de sync falhou: ${res.status} ${await res.text()}`);
}

/** Busca uma página de registros alterados por outras máquinas desde o cursor informado. */
export async function pullBatch(cursor: string | null): Promise<PullPage> {
  const qs = new URLSearchParams({ limit: '500', ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${baseUrl()}/api/sync/pull?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Pull de sync falhou: ${res.status} ${await res.text()}`);
  return (await res.json()) as PullPage;
}
