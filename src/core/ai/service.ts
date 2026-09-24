import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';

/**
 * KIVO IA — ponte com o Kivo Web.
 *
 * O app é offline-first e a CSP do navegador é `connect-src 'self'`: o navegador NUNCA fala
 * com a nuvem. Então quem chama o Kivo Web é ESTE servidor local, com as credenciais de
 * licença; o Kivo Web escolhe o provedor de IA e chama a API correspondente.
 *
 * O assistente de SUPORTE está sempre disponível: não há ativação nem configuração no app.
 * Provedores, chaves, instruções e limites são definidos pelo time do Kivo no painel do Cloud.
 */

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiModelInfo {
  name: string;
  size?: number | null;
  parameterSize?: string | null;
}

/** Provedor disponível no servidor (o cliente só escolhe entre os que já vêm configurados). */
export interface AiProviderInfo {
  id: string;
  label: string;
  keyRequired?: boolean;
  configured?: boolean;
  models: AiModelInfo[];
}

export interface AiCredits {
  /** 0 = ilimitado. */
  limit: number;
  used: number;
  period: string | null;
}

export interface AiStatus {
  enabled?: boolean;
  defaultProvider?: string;
  online: boolean;
  model?: string;
  models?: AiModelInfo[];
  providers?: AiProviderInfo[];
  credits?: AiCredits | null;
  error?: string;
  /** Motivo local (antes mesmo de falar com a nuvem): IA desligada, Kivo Web sem config. */
  localError?: string;
}

/** Consulta o Kivo Web para a tela montar o seletor de agente e mostrar o status. */
export async function aiStatus(): Promise<AiStatus> {
  const base = cloudBaseUrl();
  const headers = cloudAuthHeaders();
  if (!base || !headers) {
    return { online: false, localError: 'Kivo Web não configurado (licença ou servidor ausente).' };
  }
  try {
    const r = await fetch(`${base}/api/ai/status`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { online: false, localError: `Kivo Web respondeu ${r.status}.` };
    return (await r.json()) as AiStatus;
  } catch (e) {
    return { online: false, localError: `Não foi possível falar com o Kivo Web: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface AiLink {
  label: string;
  route: string;
  /** Recurso (capability) exigido pela tela; se desligado, o chat oferece ativar. */
  capability?: string;
}

/**
 * Traduz erro técnico do provedor/cloud para algo amigável ao lojista, guardando o texto
 * original em `detail` (a tela mostra o amigável e um "exibir erro" discreto). Aplicado aqui
 * também para funcionar mesmo com um Kivo Web mais antigo que ainda devolva o erro cru.
 */
function friendlyAiError(raw: string): { error: string; detail?: string } {
  const r = raw || '';
  const technical = /model .*not found|not found|respondeu \d{3}|ECONNREFUSED|fetch failed|Failed to fetch|ETIMEDOUT|timeout|\{\s*"error"/i.test(r);
  if (!technical) return { error: r || 'Não foi possível consultar a IA agora. Tente novamente em instantes.' };
  if (/model .*not found|not found|no such model/i.test(r)) {
    return { error: 'A IA ainda não está configurada. Avise o suporte para liberar o assistente.', detail: r };
  }
  if (/Nenhuma chave configurada|n[ãa]o est[áa] configurado/i.test(r)) {
    return { error: 'Este assistente de IA ainda não está liberado. Fale com o suporte.', detail: r };
  }
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ETIMEDOUT|timeout|indispon[íi]/i.test(r)) {
    return { error: 'Não foi possível falar com a IA agora. Tente novamente em instantes.', detail: r };
  }
  return { error: 'Não foi possível consultar a IA agora. Tente novamente em instantes.', detail: r };
}

export type AiChatResult =
  | { ok: true; content: string; model: string; provider: string; sources: string[]; links: AiLink[] }
  | { ok: false; error: string; detail?: string };

export interface AiToolStatus {
  feature: string;
  limit: number;
  used: number;
  remaining: number;
  periodDay: string;
  cost: number;
  resetAt: string;
}

export type AiToolResult =
  | { ok: true; description: string; status?: AiToolStatus }
  | { ok: false; error: string; detail?: string; code?: string };

/** Fuso da máquina (para o cloud saber quando é meia-noite aqui). */
function localTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Porto_Velho'; }
  catch { return 'America/Porto_Velho'; }
}

/**
 * Ferramenta paga "gerar descrição de produto". Cobra 1 uso da cota diária no Kivo Web; se a
 * cota acabou, o cloud devolve 402 com a mensagem amigável (a tela mostra e sugere esperar a
 * renovação à meia-noite).
 */
export async function aiProductDescription(input: { name: string; category?: string; keywords?: string }): Promise<AiToolResult> {
  const base = cloudBaseUrl();
  const headers = cloudAuthHeaders();
  if (!base || !headers) return { ok: false, error: 'Kivo Web não configurado (licença ou servidor ausente).' };
  try {
    const r = await fetch(`${base}/api/ai/tools/product-description`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, 'X-Kivo-Tz': localTimezone() },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(150000),
    });
    const body = (await r.json().catch(() => ({}))) as {
      description?: string; status?: AiToolStatus; error?: string; detail?: string; code?: string;
    };
    if (!r.ok) {
      const friendly = friendlyAiError(body.error ?? `Kivo Web respondeu ${r.status}.`);
      return { ok: false, error: friendly.error, detail: body.detail || friendly.detail, code: body.code };
    }
    return { ok: true, description: body.description ?? '', status: body.status };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const friendly = friendlyAiError(raw);
    return { ok: false, error: friendly.error, detail: friendly.detail };
  }
}

/**
 * Envia um chat para o Kivo Web, que injeta a documentação do Kivo e chama o provedor. O
 * assistente de suporte está sempre disponível: provedor, instruções e limites são definidos
 * pela Kivo no painel — o app não ativa nem configura nada. `userName` entra no contexto para
 * a IA tratar a pessoa pelo nome.
 */
export async function aiChat(
  messages: AiChatMessage[],
  opts: { userName?: string | null } = {},
): Promise<AiChatResult> {
  if (!Array.isArray(messages) || !messages.some((m) => m.role === 'user' && m.content.trim())) {
    return { ok: false, error: 'Envie uma pergunta para a IA.' };
  }
  const base = cloudBaseUrl();
  const headers = cloudAuthHeaders();
  if (!base || !headers) {
    return { ok: false, error: 'Kivo Web não configurado (licença ou servidor ausente).' };
  }

  try {
    const r = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        messages,
        userName: opts.userName || undefined,
      }),
      signal: AbortSignal.timeout(150000),
    });
    const body = (await r.json().catch(() => ({}))) as {
      content?: string;
      model?: string;
      provider?: string;
      sources?: string[];
      links?: AiLink[];
      error?: string;
      detail?: string;
    };
    if (!r.ok) {
      const friendly = friendlyAiError(body.error ?? `Kivo Web respondeu ${r.status}.`);
      return { ok: false, error: friendly.error, detail: body.detail || friendly.detail };
    }
    return {
      ok: true,
      content: body.content ?? '',
      model: body.model ?? '',
      provider: body.provider ?? 'ollama',
      sources: Array.isArray(body.sources) ? body.sources : [],
      links: Array.isArray(body.links) ? body.links : [],
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const friendly = friendlyAiError(raw);
    return { ok: false, error: friendly.error, detail: friendly.detail };
  }
}
