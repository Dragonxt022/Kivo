import { getPool } from './db';
import { isProviderId, type AiConfig, type ProviderId } from './aiProviders';

/**
 * Configuração da KIVO IA no Kivo Cloud (painel › Configurações › KIVO IA).
 *
 * Quem configura provedor e chaves é o time do Kivo — o cliente só usa. Por isso tudo vive em
 * `app_settings` (mesma tabela da busca de imagens), editável no painel admin. As chaves são
 * segredos de servidor: nunca voltam para a tela, só um sinalizador de "já configurada".
 *
 * Variáveis de ambiente continuam valendo como reserva (deploy sem tocar no painel).
 */

const KEYS = {
  enabled: 'ai_enabled',
  defaultProvider: 'ai_default_provider',
  ollamaUrl: 'ai_ollama_url',
  ollamaModel: 'ai_ollama_model',
  openai: 'ai_openai_key',
  deepseek: 'ai_deepseek_key',
  anthropic: 'ai_anthropic_key',
} as const;

/** Chaves de segredo — a tela nunca devolve o valor, só se existe. */
export const AI_SECRET_KEYS = [KEYS.openai, KEYS.deepseek, KEYS.anthropic] as const;

export interface AiSettingsMap {
  enabled: boolean;
  defaultProvider: ProviderId;
  ollamaUrl: string;
  ollamaModel: string;
  /** `true` quando há chave salva no painel (não revela o valor). */
  hasKey: Record<ProviderId, boolean>;
  /** Valores crus das chaves (só uso interno / carregamento). */
  keys: Record<ProviderId, string | null>;
}

async function readSettings(): Promise<Record<string, string>> {
  const [rows] = await getPool().query(
    `SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (${Object.values(KEYS).map(() => '?').join(',')})`,
    Object.values(KEYS),
  );
  return Object.fromEntries(
    (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, String(r.setting_value ?? '')]),
  );
}

function envKey(provider: Exclude<ProviderId, 'ollama'>): string {
  const env: Record<Exclude<ProviderId, 'ollama'>, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  return (env[provider] ?? '').trim();
}

/** Configuração pronta para uso (painel + variáveis de ambiente). */
export async function loadAiConfig(): Promise<AiConfig> {
  const s = await readSettings();
  const keys: Record<ProviderId, string | null> = {
    ollama: null,
    openai: (s[KEYS.openai] || '').trim() || envKey('openai') || null,
    deepseek: (s[KEYS.deepseek] || '').trim() || envKey('deepseek') || null,
    anthropic: (s[KEYS.anthropic] || '').trim() || envKey('anthropic') || null,
  };
  const defaultRaw = s[KEYS.defaultProvider];
  return {
    enabled: s[KEYS.enabled] !== '0',
    defaultProvider: isProviderId(defaultRaw) ? defaultRaw : 'ollama',
    keys,
    ollamaUrl: (s[KEYS.ollamaUrl] || '').trim() || process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    ollamaModel: (s[KEYS.ollamaModel] || '').trim() || process.env.OLLAMA_MODEL || 'llama3.2',
  };
}

/** Versão para a tela do painel: sem os valores das chaves. */
export async function loadAiSettingsForView(): Promise<AiSettingsMap> {
  const s = await readSettings();
  const keys: Record<ProviderId, string | null> = {
    ollama: null,
    openai: (s[KEYS.openai] || '').trim() || envKey('openai') || null,
    deepseek: (s[KEYS.deepseek] || '').trim() || envKey('deepseek') || null,
    anthropic: (s[KEYS.anthropic] || '').trim() || envKey('anthropic') || null,
  };
  const defaultRaw = s[KEYS.defaultProvider];
  return {
    enabled: s[KEYS.enabled] !== '0',
    defaultProvider: isProviderId(defaultRaw) ? defaultRaw : 'ollama',
    ollamaUrl: (s[KEYS.ollamaUrl] || '').trim() || process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    ollamaModel: (s[KEYS.ollamaModel] || '').trim() || process.env.OLLAMA_MODEL || 'llama3.2',
    hasKey: {
      ollama: true,
      openai: !!keys.openai,
      deepseek: !!keys.deepseek,
      anthropic: !!keys.anthropic,
    },
    keys,
  };
}

export const AI_CONFIG_KEY_NAMES = KEYS;
