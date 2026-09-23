import { settingsRepository } from '../repositories/SettingsRepository';
import { cloudBaseUrl, cloudAuthHeaders } from '../catalog/submissionQueue';

/**
 * KIVO IA — configuração e ponte com o Kivo Web.
 *
 * O app é offline-first e a CSP do navegador é `connect-src 'self'`: o navegador NUNCA fala
 * com a nuvem. Então quem chama o Kivo Web é ESTE servidor local, com as credenciais de
 * licença; o Kivo Web encaminha para o Ollama que roda na VPS. O lojista só configura o que
 * quer (modelo, prompt, temperatura) — a rede fica com a gente.
 */
export interface AiConfig {
  ativo: boolean;
  /** Modelo do Ollama; vazio = usa o padrão do servidor. */
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

export interface AiCredits {
  /** 0 = ilimitado. */
  limit: number;
  used: number;
  period: string | null;
}

export interface AiStatus {
  online: boolean;
  model?: string;
  models?: AiModelInfo[];
  credits?: AiCredits | null;
  error?: string;
  /** Motivo local (antes mesmo de falar com a nuvem): IA desligada, Kivo Web sem config. */
  localError?: string;
}

/** Consulta o Kivo Web (que consulta o Ollama) para a tela mostrar se a IA está no ar. */
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

export type AiChatResult = { ok: true; content: string; model: string } | { ok: false; error: string };

/**
 * Envia um chat para o Kivo Web, que roteia para o Ollama da VPS. `messages` pode vir só com
 * a mensagem do usuário; o prompt de sistema configurado é injetado automaticamente.
 */
export async function aiChat(
  messages: AiChatMessage[],
  opts: { model?: string | null; temperature?: number | null } = {},
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
      body: JSON.stringify({ messages, system: cfg.prompt ?? undefined, model, temperature }),
      signal: AbortSignal.timeout(150000),
    });
    const body = (await r.json().catch(() => ({}))) as { content?: string; model?: string; error?: string };
    if (!r.ok) return { ok: false, error: body.error ?? `Kivo Web respondeu ${r.status}.` };
    return { ok: true, content: body.content ?? '', model: body.model ?? (model ?? '') };
  } catch (e) {
    return { ok: false, error: `Falha ao falar com o Kivo Web: ${e instanceof Error ? e.message : String(e)}` };
  }
}
