import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getPool } from './db';

/**
 * Gateway de pagamento do Kivo Cloud — Mercado Pago.
 *
 * O Kivo cobra a assinatura do lojista (tabela `charges`) e o lojista paga por Pix, boleto
 * ou cartão. Toda a conversa com o Mercado Pago passa por aqui: credenciais guardadas em
 * `app_settings` (nunca vão para o app do cliente), criação do pagamento, leitura do status
 * e validação da assinatura do webhook.
 *
 * Duas decisões que valem explicação:
 *  1. **O webhook nunca é fonte da verdade.** Ele só diz "olhe o pagamento X"; o status é
 *     sempre reconferido em `GET /v1/payments/{id}` com o nosso Access Token. Assim, uma
 *     notificação forjada não marca cobrança como paga.
 *  2. **`MP_API_BASE` é configurável por ambiente**, para a suíte de testes apontar para um
 *     servidor de mentira e exercitar o fluxo inteiro sem internet e sem dinheiro real.
 */

export const MP_API_BASE = (process.env.MP_API_BASE ?? 'https://api.mercadopago.com').replace(/\/+$/, '');

/** Chaves em `app_settings`. O prefixo `mp_` mantém tudo do gateway num lugar só. */
const KEY_TOKEN = 'mp_access_token';
const KEY_SECRET = 'mp_webhook_secret';
const KEY_EMAIL = 'mp_payer_email';
const KEY_ENABLED = 'mp_enabled';

export interface GatewaySettings {
  enabled: boolean;
  accessToken: string;
  webhookSecret: string;
  /** E-mail do pagador usado quando a cobrança não tem um (o Pix exige e-mail). */
  payerEmail: string;
}

/** O que a tela pode saber: segredo nunca volta, só o sinal de que existe. */
export interface GatewaySettingsView {
  enabled: boolean;
  accessTokenSet: boolean;
  accessTokenPreview: string;
  webhookSecretSet: boolean;
  payerEmail: string;
  environment: 'teste' | 'producao' | 'desconhecido';
  apiBase: string;
  notificationUrl: string;
}

export class GatewayError extends Error {
  /** Status HTTP devolvido pelo Mercado Pago (0 = falha de rede). */
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status = 0, detail = '') {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.detail = detail;
  }
}

async function readSettings(): Promise<Record<string, string>> {
  const [rows] = await getPool().query(
    `SELECT setting_key, setting_value FROM app_settings
      WHERE setting_key IN (?, ?, ?, ?)`,
    [KEY_TOKEN, KEY_SECRET, KEY_EMAIL, KEY_ENABLED],
  );
  const out: Record<string, string> = {};
  for (const r of rows as { setting_key: string; setting_value: string | null }[]) {
    out[r.setting_key] = r.setting_value ?? '';
  }
  return out;
}

export async function loadSettings(): Promise<GatewaySettings> {
  const s = await readSettings();
  return {
    enabled: s[KEY_ENABLED] === '1',
    accessToken: s[KEY_TOKEN] ?? '',
    webhookSecret: s[KEY_SECRET] ?? '',
    payerEmail: s[KEY_EMAIL] ?? '',
  };
}

/** Ambiente derivado do prefixo do token — é o que o próprio Mercado Pago usa. */
export function tokenEnvironment(token: string): 'teste' | 'producao' | 'desconhecido' {
  if (token.startsWith('APP_USR-')) return 'producao';
  if (token.startsWith('TEST-')) return 'teste';
  return 'desconhecido';
}

export async function loadSettingsForView(): Promise<GatewaySettingsView> {
  const s = await loadSettings();
  return {
    enabled: s.enabled,
    accessTokenSet: Boolean(s.accessToken),
    accessTokenPreview: s.accessToken ? `${s.accessToken.slice(0, 8)}…${s.accessToken.slice(-4)}` : '',
    webhookSecretSet: Boolean(s.webhookSecret),
    payerEmail: s.payerEmail,
    environment: tokenEnvironment(s.accessToken),
    apiBase: MP_API_BASE,
    notificationUrl: notificationUrl(),
  };
}

/**
 * Salva o que veio da tela. Campo de segredo em branco MANTÉM o que já estava salvo — é o
 * mesmo contrato da senha de SMTP (`admin.ts`), para o admin não apagar a chave sem querer.
 */
export async function saveSettings(body: Record<string, unknown>): Promise<void> {
  const upsert = (key: string, value: string | null) =>
    getPool().query(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value],
    );
  await upsert(KEY_ENABLED, body.enabled ? '1' : '0');
  await upsert(KEY_EMAIL, String(body.payerEmail ?? '').trim() || null);
  const token = String(body.accessToken ?? '').trim();
  if (token) await upsert(KEY_TOKEN, token);
  const secret = String(body.webhookSecret ?? '').trim();
  if (secret) await upsert(KEY_SECRET, secret);
}

/** URL pública que o Mercado Pago chama. Derivada do domínio configurado no cloud. */
export function notificationUrl(): string {
  const base = (process.env.CLOUD_PUBLIC_URL ?? 'https://kivo.buscamais.org').replace(/\/+$/, '');
  return `${base}/api/webhooks/mercadopago`;
}

export function publicPayUrl(token: string): string {
  const base = (process.env.CLOUD_PUBLIC_URL ?? 'https://kivo.buscamais.org').replace(/\/+$/, '');
  return `${base}/pagar/${token}`;
}

export function isConfigured(s: GatewaySettings): boolean {
  return Boolean(s.accessToken);
}

/** Chamada crua à API do Mercado Pago, com o erro traduzido para uma mensagem útil. */
async function mpRequest<T>(path: string, init: { method?: string; body?: unknown; settings: GatewaySettings }): Promise<T> {
  const url = `${MP_API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${init.settings.accessToken}`,
        'Content-Type': 'application/json',
        // O Mercado Pago usa esta chave para não duplicar pagamento em retry de rede.
        'X-Idempotency-Key': randomUUID(),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (e) {
    throw new GatewayError(`Não foi possível falar com o Mercado Pago: ${(e as Error).message}`, 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // resposta não-JSON (proxy, HTML de erro) — fica no detail abaixo
  }
  if (!res.ok) {
    const err = (json ?? {}) as { message?: string; error?: string; cause?: { description?: string }[] };
    const cause = Array.isArray(err.cause) && err.cause.length ? ` (${err.cause.map((c) => c.description).filter(Boolean).join('; ')})` : '';
    throw new GatewayError(
      `Mercado Pago recusou a operação (HTTP ${res.status}): ${err.message ?? err.error ?? 'sem detalhe'}${cause}`,
      res.status,
      text.slice(0, 500),
    );
  }
  return json as T;
}

export interface ChargePaymentInput {
  chargeId: number;
  description: string;
  amountCents: number;
  payerEmail: string;
  /** Nome do pagador: o boleto exige ao menos o primeiro nome. */
  payerName?: string | null;
  /** CPF/CNPJ do pagador (só números) — exigido pelo boleto. */
  payerDocument?: string | null;
}

export interface CreatedPayment {
  method: 'pix' | 'boleto';
  paymentId: string;
  status: string;
  statusDetail: string | null;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
}

interface MpPaymentResponse {
  id?: number | string;
  status?: string;
  status_detail?: string;
  point_of_interaction?: {
    transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string };
  };
  transaction_details?: { external_resource_url?: string };
}

function amountFromCents(cents: number): number {
  return Number((Math.round(cents) / 100).toFixed(2));
}

function paymentBody(input: ChargePaymentInput, method: 'pix' | 'bolbradesco'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    transaction_amount: amountFromCents(input.amountCents),
    description: input.description,
    payment_method_id: method,
    external_reference: `charge:${input.chargeId}`,
    notification_url: notificationUrl(),
    payer: { email: input.payerEmail } as Record<string, unknown>,
  };
  const payer = body.payer as Record<string, unknown>;
  const nome = String(input.payerName ?? '').trim();
  if (nome) {
    const partes = nome.split(/\s+/);
    payer.first_name = partes[0];
    if (partes.length > 1) payer.last_name = partes.slice(1).join(' ');
  }
  const doc = String(input.payerDocument ?? '').replace(/\D/g, '');
  if (doc) payer.identification = { type: doc.length > 11 ? 'CNPJ' : 'CPF', number: doc };
  return body;
}

/** Pix (Checkout Transparente): devolve o copia e cola e a imagem do QR. */
export async function createPixPayment(input: ChargePaymentInput, settings: GatewaySettings): Promise<CreatedPayment> {
  const r = await mpRequest<MpPaymentResponse>('/v1/payments', {
    method: 'POST', body: paymentBody(input, 'pix'), settings,
  });
  const tx = r.point_of_interaction?.transaction_data ?? {};
  return {
    method: 'pix',
    paymentId: String(r.id ?? ''),
    status: String(r.status ?? 'pending'),
    statusDetail: r.status_detail ?? null,
    qrCode: tx.qr_code ?? null,
    qrCodeBase64: tx.qr_code_base64 ?? null,
    ticketUrl: tx.ticket_url ?? null,
  };
}

/** Boleto: devolve a URL do boleto (o Mercado Pago hospeda a página). */
export async function createBoletoPayment(input: ChargePaymentInput, settings: GatewaySettings): Promise<CreatedPayment> {
  const r = await mpRequest<MpPaymentResponse>('/v1/payments', {
    method: 'POST', body: paymentBody(input, 'bolbradesco'), settings,
  });
  return {
    method: 'boleto',
    paymentId: String(r.id ?? ''),
    status: String(r.status ?? 'pending'),
    statusDetail: r.status_detail ?? null,
    qrCode: null,
    qrCodeBase64: null,
    ticketUrl: r.transaction_details?.external_resource_url
      ?? r.point_of_interaction?.transaction_data?.ticket_url ?? null,
  };
}

export interface CreatedPreference {
  preferenceId: string;
  initPoint: string;
}

/**
 * Cartão pelo Checkout Pro: em vez de tratar cartão dentro do Kivo (o que exigiria PCI e
 * checkout próprio), criamos uma preferência e mandamos o cliente para a página do Mercado
 * Pago. O webhook de `payment` continua sendo o que fecha o ciclo.
 */
export async function createCardPreference(
  input: ChargePaymentInput,
  settings: GatewaySettings,
  backUrls: { success: string; pending: string; failure: string },
): Promise<CreatedPreference> {
  const r = await mpRequest<{ id?: string; init_point?: string; sandbox_init_point?: string }>('/checkout/preferences', {
    method: 'POST',
    settings,
    body: {
      items: [{
        id: String(input.chargeId),
        title: input.description.slice(0, 250),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: amountFromCents(input.amountCents),
      }],
      payer: { email: input.payerEmail },
      external_reference: `charge:${input.chargeId}`,
      notification_url: notificationUrl(),
      back_urls: backUrls,
      auto_return: 'approved',
      statement_descriptor: 'KIVO',
    },
  });
  const initPoint = r.init_point ?? r.sandbox_init_point ?? '';
  if (!r.id || !initPoint) throw new GatewayError('Mercado Pago não devolveu o link do checkout.', 0, JSON.stringify(r).slice(0, 300));
  return { preferenceId: String(r.id), initPoint };
}

export interface PaymentSnapshot {
  paymentId: string;
  status: string;
  statusDetail: string | null;
  externalReference: string | null;
  paidAmountCents: number | null;
}

/** Leitura do pagamento — a fonte da verdade usada pelo webhook e pela reconciliação. */
export async function getPayment(paymentId: string, settings: GatewaySettings): Promise<PaymentSnapshot> {
  const r = await mpRequest<{
    id?: number | string; status?: string; status_detail?: string;
    external_reference?: string; transaction_amount?: number;
  }>(`/v1/payments/${encodeURIComponent(paymentId)}`, { settings });
  return {
    paymentId: String(r.id ?? paymentId),
    status: String(r.status ?? 'unknown'),
    statusDetail: r.status_detail ?? null,
    externalReference: r.external_reference ?? null,
    paidAmountCents: typeof r.transaction_amount === 'number' ? Math.round(r.transaction_amount * 100) : null,
  };
}

/** Status do Mercado Pago → o que o Kivo faz com a cobrança. */
export function mapPaymentStatus(mpStatus: string): 'paga' | 'pendente' | 'nao_mexe' {
  switch (mpStatus) {
    case 'approved':
      return 'paga';
    case 'pending':
    case 'in_process':
    case 'authorized':
    case 'rejected':
    case 'cancelled':
      // Recusado/cancelado volta a ficar pendente: o cliente pode tentar de novo (o
      // motivo fica em mp_status_detail para o admin explicar o que houve).
      return 'pendente';
    default:
      // refunded/charged_back: NÃO desfaz a baixa sozinho — quem estorna é o admin
      // (botão "Estornar pagamento", que também reverte a comissão do afiliado).
      return 'nao_mexe';
  }
}

/**
 * Valida a origem da notificação (HMAC SHA-256 do manifesto, conforme a documentação).
 * Sem segredo configurado devolve `null` ("não deu para validar") — o webhook trata isso
 * como aviso, porque quem decide o pagamento é a releitura na API, não a notificação.
 */
export function verifyWebhookSignature(opts: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  secret: string;
}): boolean | null {
  if (!opts.secret) return null;
  if (!opts.xSignature) return false;

  let ts = '';
  let v1 = '';
  for (const parte of opts.xSignature.split(',')) {
    const [chave, valor] = parte.split('=');
    if (chave?.trim() === 'ts') ts = (valor ?? '').trim();
    if (chave?.trim() === 'v1') v1 = (valor ?? '').trim();
  }
  if (!ts || !v1) return false;

  // Manifesto: só entram as partes presentes (a doc manda remover as ausentes).
  const partes: string[] = [];
  if (opts.dataId) partes.push(`id:${opts.dataId.toLowerCase()}`);
  if (opts.xRequestId) partes.push(`request-id:${opts.xRequestId}`);
  partes.push(`ts:${ts}`);
  const manifest = partes.join(';') + ';';

  const esperado = createHmac('sha256', opts.secret).update(manifest).digest('hex');
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
