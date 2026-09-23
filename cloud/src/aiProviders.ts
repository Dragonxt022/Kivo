/**
 * Provedores de IA da KIVO IA.
 *
 * Quem configura os provedores e as chaves é o time do Kivo, no painel do Kivo Cloud
 * (Configurações › KIVO IA) — o cliente NÃO vê chave nenhuma. Este módulo é puro: recebe a
 * configuração já carregada (`AiConfig`, ver `aiConfig.ts`) e sabe conversar com cada API.
 *
 * Ollama é o padrão (roda na VPS, não exige chave). OpenAI/DeepSeek/Anthropic só entram na
 * lista quando têm chave configurada. Nada de SDK: são endpoints HTTP.
 */

export type ProviderId = 'ollama' | 'openai' | 'deepseek' | 'anthropic';

export const PROVIDER_IDS: readonly ProviderId[] = ['ollama', 'openai', 'deepseek', 'anthropic'];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

export interface AiModelInfo {
  name: string;
  size?: number | null;
  parameterSize?: string | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Configuração resolvida (banco + variáveis de ambiente). Ver aiConfig.ts. */
export interface AiConfig {
  /** Liga/desliga a KIVO IA no servidor. */
  enabled: boolean;
  defaultProvider: ProviderId;
  keys: Record<ProviderId, string | null>;
  ollamaUrl: string;
  ollamaModel: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Exige chave para funcionar (Ollama não). */
  keyRequired: boolean;
  /** Tem chave configurada (no painel ou por variável de ambiente). */
  configured: boolean;
  models: AiModelInfo[];
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

const OPENAI_BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/$/, '');
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');

/** Modelos sugeridos quando o provedor não expõe uma listagem (a tela também aceita texto livre). */
export const STATIC_MODELS: Record<Exclude<ProviderId, 'ollama'>, AiModelInfo[]> = {
  openai: [
    { name: 'gpt-4o-mini', parameterSize: null },
    { name: 'gpt-4o', parameterSize: null },
    { name: 'gpt-4.1-mini', parameterSize: null },
    { name: 'gpt-4.1', parameterSize: null },
  ],
  deepseek: [
    { name: 'deepseek-chat', parameterSize: null },
    { name: 'deepseek-reasoner', parameterSize: null },
  ],
  anthropic: [
    { name: 'claude-3-5-haiku-latest', parameterSize: null },
    { name: 'claude-3-5-sonnet-latest', parameterSize: null },
    { name: 'claude-sonnet-4-5', parameterSize: null },
  ],
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama (servidor Kivo)',
  openai: 'OpenAI (ChatGPT)',
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic (Claude)',
};

/** Modelo usado quando a tela não escolhe um. */
export function defaultModelFor(cfg: AiConfig, provider: ProviderId): string {
  if (provider === 'ollama') return cfg.ollamaModel;
  return STATIC_MODELS[provider][0].name;
}

/** Chave do provedor (só faz sentido para os que exigem). */
export function keyFor(cfg: AiConfig, provider: ProviderId): string | null {
  if (provider === 'ollama') return null;
  return cfg.keys[provider]?.trim() || null;
}

async function ollamaModels(url: string): Promise<AiModelInfo[]> {
  const r = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Ollama respondeu ${r.status}.`);
  const data = (await r.json()) as { models?: { name: string; size?: number; details?: { parameter_size?: string } }[] };
  return (data.models ?? []).map((m) => ({ name: m.name, size: m.size ?? null, parameterSize: m.details?.parameter_size ?? null }));
}

/** Lista os modelos instalados em um Ollama. Usado pelo seletor do painel. Lança se offline. */
export async function listOllamaModels(url: string): Promise<AiModelInfo[]> {
  return ollamaModels(url);
}

/** Metadados dos provedores para o seletor de agente. Só lista os que têm chave (ou o Ollama). */
export async function listProviders(cfg: AiConfig): Promise<ProviderInfo[]> {
  const out: ProviderInfo[] = [];
  for (const id of PROVIDER_IDS) {
    const configured = id === 'ollama' || !!keyFor(cfg, id);
    let models: AiModelInfo[] = [];
    if (id === 'ollama') {
      try { models = await ollamaModels(cfg.ollamaUrl); } catch { models = []; }
    } else if (configured) {
      models = STATIC_MODELS[id];
    }
    out.push({ id, label: PROVIDER_LABELS[id], keyRequired: id !== 'ollama', configured, models });
  }
  return out;
}

function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n').trim();
  const rest = messages.filter((m) => m.role !== 'system');
  return { system, rest };
}

async function chatOllama(cfg: AiConfig, req: ChatRequest): Promise<ChatResponse> {
  const r = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: false,
      options: req.temperature != null ? { temperature: req.temperature } : undefined,
    }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000)),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Ollama respondeu ${r.status}. ${detail.slice(0, 200)}`);
  }
  const data = (await r.json()) as { message?: { content?: string }; model?: string; prompt_eval_count?: number; eval_count?: number };
  return {
    content: data.message?.content ?? '',
    model: data.model ?? req.model,
    promptTokens: Number(data.prompt_eval_count ?? 0),
    completionTokens: Number(data.eval_count ?? 0),
  };
}

/** OpenAI e DeepSeek compartilham o formato `/chat/completions`. */
async function chatOpenAiCompatible(base: string, req: ChatRequest, apiKey: string): Promise<ChatResponse> {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: req.model, messages: req.messages, temperature: req.temperature }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Provedor respondeu ${r.status}. ${detail.slice(0, 300)}`);
  }
  const data = (await r.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model ?? req.model,
    promptTokens: Number(data.usage?.prompt_tokens ?? 0),
    completionTokens: Number(data.usage?.completion_tokens ?? 0),
  };
}

async function chatAnthropic(req: ChatRequest, apiKey: string): Promise<ChatResponse> {
  const { system, rest } = splitSystem(req.messages);
  const r = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 2048,
      system: system || undefined,
      messages: rest.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      temperature: req.temperature,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Anthropic respondeu ${r.status}. ${detail.slice(0, 300)}`);
  }
  const data = (await r.json()) as {
    model?: string;
    content?: { type?: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = (data.content ?? []).filter((c) => c.type === 'text' || c.text).map((c) => c.text ?? '').join('');
  return {
    content,
    model: data.model ?? req.model,
    promptTokens: Number(data.usage?.input_tokens ?? 0),
    completionTokens: Number(data.usage?.output_tokens ?? 0),
  };
}

/** Envia o chat para o provedor escolhido. Lança em erro de rede/HTTP ou falta de chave. */
export async function chat(cfg: AiConfig, req: ChatRequest): Promise<ChatResponse> {
  if (req.provider === 'ollama') return chatOllama(cfg, req);
  const apiKey = keyFor(cfg, req.provider);
  if (!apiKey) throw new Error(`Nenhuma chave configurada para ${PROVIDER_LABELS[req.provider]}.`);
  if (req.provider === 'openai') return chatOpenAiCompatible(OPENAI_BASE, req, apiKey);
  if (req.provider === 'deepseek') return chatOpenAiCompatible(DEEPSEEK_BASE, req, apiKey);
  return chatAnthropic(req, apiKey);
}
