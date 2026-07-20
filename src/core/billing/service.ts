import { getLicenseCredentials } from '../license/service';
import { getCloudServerUrl } from '../config/cloud';

export interface CloudCharge {
  id: number;
  description: string;
  instructions: string | null;
  amount_cents: number;
  due_date: string;
  status: 'pendente' | 'paga' | 'cancelada';
  paid_at: string | null;
  created_at: string;
}

const ALERT_WINDOW_MS = 3 * 24 * 3600e3;

/**
 * Histórico de cobranças manuais (KIVO_PLANO.md §9) lido direto do cloud/ — nunca
 * espelhado localmente (sem risco de ficar desatualizado quanto a status de
 * pagamento). Offline ou sem licença configurada: lista vazia, nunca lança.
 */
export async function fetchCloudCharges(): Promise<CloudCharge[]> {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const url = getCloudServerUrl();
  if (!companyUuid || !licenseKey || !url) return [];
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/billing/charges`, {
      headers: { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return (await res.json()) as CloudCharge[];
  } catch {
    return [];
  }
}

/** Cobranças pendentes vencendo em até 3 dias (ou já vencidas) — alerta global do nav. */
export async function fetchUrgentCharges(): Promise<CloudCharge[]> {
  const charges = await fetchCloudCharges();
  const now = Date.now();
  return charges.filter((c) => c.status === 'pendente' && new Date(c.due_date).getTime() - now <= ALERT_WINDOW_MS);
}
