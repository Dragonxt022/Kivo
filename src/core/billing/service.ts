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
  /** Página pública de pagamento (/pagar/<token>) — presente quando o gateway já gerou algo. */
  public_url?: string | null;
  /** Forma escolhida no gateway: pix | boleto | card. */
  mp_method?: string | null;
  mp_status?: string | null;
  mp_status_detail?: string | null;
  /** Pix copia e cola e imagem do QR (base64) devolvidos pelo Mercado Pago. */
  mp_qr_code?: string | null;
  mp_qr_code_base64?: string | null;
  mp_ticket_url?: string | null;
  mp_init_point?: string | null;
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

// ─────────────────────────── Pagamento pelo gateway ───────────────────────────

export type ChargeMethod = 'pix' | 'boleto' | 'card';

/**
 * O que o cloud devolve ao gerar o pagamento: QR do Pix (código e imagem), link do boleto
 * e link do Checkout Pro (cartão). O app NUNCA fala com o Mercado Pago — só com o cloud,
 * autenticado pela licença da empresa.
 */
export interface ChargePayment {
  /** true quando já existia pagamento gerado para esta cobrança (o QR do Pix não muda). */
  jaGerado?: boolean;
  /** Página pública (/pagar/<token>) — link para mandar ao cliente por WhatsApp. */
  public_url: string | null;
  mp_method: string | null;
  mp_qr_code: string | null;
  mp_qr_code_base64: string | null;
  mp_ticket_url: string | null;
  mp_init_point: string | null;
  mp_status?: string | null;
}

export interface ChargeStatus {
  status: CloudCharge['status'];
  mp_status?: string | null;
  mp_status_detail?: string | null;
  paid_at?: string | null;
  /** true quando ESTA consulta baixou a cobrança (o pagamento foi aprovado agora). */
  settled_now?: boolean;
  extended_days?: number;
  valid_until?: string | null;
  error?: string;
}

export type BillingResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Credenciais da licença + URL do cloud, como em /api/sync e /api/backup. */
function cloudBase(): { url: string; headers: Record<string, string> } | null {
  const { companyUuid, licenseKey } = getLicenseCredentials();
  const url = getCloudServerUrl();
  if (!companyUuid || !licenseKey || !url) return null;
  return {
    url: url.replace(/\/$/, ''),
    headers: { 'X-Kivo-Company': companyUuid, 'X-Kivo-License-Key': licenseKey },
  };
}

/**
 * Chamada autenticada às rotas de cobrança do cloud. Timeout generoso de propósito: gerar
 * Pix/boleto envolve o Mercado Pago responder, e o botão da tela fica esperando.
 */
async function cloudFetch<T>(path: string, init: RequestInit = {}): Promise<BillingResult<T>> {
  const cred = cloudBase();
  if (!cred) {
    return { ok: false, error: 'Esta instalação não está ligada a uma licença da nuvem.' };
  }
  try {
    const res = await fetch(`${cred.url}${path}`, {
      ...init,
      headers: { ...cred.headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(body.error ?? `A nuvem respondeu ${res.status}.`) };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError'
      ? 'A nuvem demorou para responder ao gerar o pagamento.'
      : `Sem resposta da nuvem: ${(e as Error).message}`;
    return { ok: false, error: msg };
  }
}

/** Gera (ou reaproveita) o pagamento da cobrança: Pix, boleto ou link de cartão. */
export function createChargePayment(chargeId: number, method: ChargeMethod): Promise<BillingResult<ChargePayment>> {
  return cloudFetch<ChargePayment>(`/api/billing/charges/${chargeId}/gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
  });
}

/**
 * "Já pagou?" — reconfere no Mercado Pago e, se aprovado, baixa a cobrança e estende a
 * validade na hora (sem depender do webhook ter chegado).
 */
export function fetchChargeStatus(chargeId: number): Promise<BillingResult<ChargeStatus>> {
  return cloudFetch<ChargeStatus>(`/api/billing/charges/${chargeId}/status`);
}
