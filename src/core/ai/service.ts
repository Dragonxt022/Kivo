import { settingsRepository } from '../repositories/SettingsRepository';
import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';

/**
 * KIVO IA — configuração e ponte com o Kivo Web.
 *
 * O app é offline-first e a CSP do navegador é `connect-src 'self'`: o navegador NUNCA fala
 * com a nuvem. Então quem chama o Kivo Web é ESTE servidor local, com as credenciais de
 * licença; o Kivo Web escolhe o provedor de IA e chama a API correspondente.
 *
 * Provedores e chaves são configurados pelo time do Kivo no painel do Cloud — o cliente não
 * guarda chave nenhuma. Aqui só ficam as preferências do lojista (ligar/desligar, prompt,
 * temperatura) e o modelo escolhido, quando a tela deixa em branco o padrão do servidor.
 */

export interface AiConfig {
  ativo: boolean;
  /** Modelo; vazio = usa o padrão do servidor. */
  modelo: string | null;
  /** Prompt de sistema (personalidade/instruções). */
  prompt: string | null;
  /** 0 a 1; null = padrão do modelo. */
  temperatura: number | null;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function aiConfig(): AiConfig {
  const tempRaw = settingsRepository.get('ia.temperatura');
  const temp = tempRaw != null && tempRaw !== '' ? Number(tempRaw) : NaN;
  return {
    ativo: settingsRepository.getBool('ia.ativo', false),
    modelo: settingsRepository.get('ia.modelo')?.trim() || null,
    prompt: settingsRepository.get('ia.prompt')?.trim() || null,
    temperatura: Number.isFinite(temp) ? temp : null,
  };
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

/**
 * Envia um chat para o Kivo Web, que injeta a documentação do Kivo e chama o provedor. A tela
 * do chat pode escolher o provedor/modelo (seletor de agente); sem escolha, usa o padrão do
 * servidor. O prompt de sistema configurado é injetado automaticamente. `userName` entra no
 * contexto para a IA tratar a pessoa pelo nome.
 */
export async function aiChat(
  messages: AiChatMessage[],
  opts: { provider?: string | null; model?: string | null; temperature?: number | null; userName?: string | null } = {},
): Promise<AiChatResult> {
  const cfg = aiConfig();
  if (!cfg.ativo) return { ok: false, error: 'A KIVO IA está desligada. Ligue em Configurações › KIVO IA.' };
  if (!Array.isArray(messages) || !messages.some((m) => m.role === 'user' && m.content.trim())) {
    return { ok: false, error: 'Envie uma pergunta para a IA.' };
  }
  const base = cloudBaseUrl();
  const headers = cloudAuthHeaders();
  if (!base || !headers) {
    return { ok: false, error: 'Kivo Web não configurado (licença ou servidor ausente).' };
  }

  const model = opts.model?.trim() || cfg.modelo || undefined;
  const temperature = opts.temperature ?? cfg.temperatura ?? undefined;

  try {
    const r = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        messages,
        system: cfg.prompt ?? undefined,
        model,
        temperature,
        provider: opts.provider || undefined,
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
      model: body.model ?? (model ?? ''),
      provider: body.provider ?? (opts.provider ?? 'ollama'),
      sources: Array.isArray(body.sources) ? body.sources : [],
      links: Array.isArray(body.links) ? body.links : [],
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const friendly = friendlyAiError(raw);
    return { ok: false, error: friendly.error, detail: friendly.detail };
  }
}
