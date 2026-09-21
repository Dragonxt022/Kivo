import dns from 'node:dns/promises';
import net from 'node:net';
import { getPool } from './db';
import { sha256, validateCatalogImage, type ImageFormat } from './catalogValidation';

/**
 * Busca de imagens externa CENTRALIZADA (provedor: Pexels).
 *
 * A chave fica no Kivo Cloud (Configurações) — o cliente não configura nada. O endpoint
 * público /api/catalog/external-search usa este módulo.
 *
 * Cuidados com a API gratuita (200 req/h, 20.000/mês):
 *  - cache por termo (`catalog_search_cache`, TTL de vários dias): o mesmo termo não bate
 *    na API de novo;
 *  - teto diário próprio (`image_api_usage`), bem abaixo do limite do provedor;
 *  - o cliente só chama a partir de um mínimo de caracteres (ver MIN_TERM_LEN no catalog).
 */

export interface ImageApiConfig {
  provider: 'pexels';
  apiKey: string;
}

const PROVIDER = 'pexels';
/** Resultados guardados por termo. O cliente mostra até 6; guardamos alguns a mais. */
const EXTERNAL_LIMIT = 12;
/** Cache de busca: 7 dias. Termos de produto mudam pouco; economiza muito a cota. */
const CACHE_TTL_MS = 7 * 24 * 3600e3;
/** Teto diário próprio (auto-imposto). Pexels permite ~200/h; ficamos bem conservadores. */
const DAILY_CAP = 400;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** Base do provedor. Trocável em teste (`KIVO_IMAGE_API_BASE`). */
function apiBase(): string {
  return (process.env.KIVO_IMAGE_API_BASE || 'https://api.pexels.com').replace(/\/$/, '');
}

export interface ExternalImage {
  url: string;
  thumb: string;
  title: string;
  photographer?: string | null;
  photographerUrl?: string | null;
  contextUrl?: string | null;
}

/** Lê a config da API de imagens. `null` quando desabilitada ou sem chave. */
export async function loadImageApiConfig(): Promise<ImageApiConfig | null> {
  const [rows] = await getPool().query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('image_api_enabled','image_api_key')",
  );
  const map = Object.fromEntries(
    (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );
  const apiKey = String(map.image_api_key ?? '').trim();
  // Ausente = habilitado (compatível com quem só salvou a chave). Só '0' desliga.
  const enabled = map.image_api_enabled !== '0';
  if (!enabled || !apiKey) return null;
  return { provider: PROVIDER, apiKey };
}

/** Consulta o Pexels. Lança em erro de rede/quota/chave. */
export async function searchPexels(q: string, limit: number, cfg: ImageApiConfig): Promise<ExternalImage[]> {
  const url = new URL(`${apiBase()}/v1/search`);
  url.searchParams.set('query', q);
  url.searchParams.set('per_page', String(Math.max(1, Math.min(limit, 80))));
  url.searchParams.set('locale', 'pt-BR');

  const res = await fetch(url, {
    headers: { Authorization: cfg.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Estatísticas de cota (só vêm em respostas 2xx) — guardamos para exibir no painel.
  const remaining = res.headers.get('x-ratelimit-remaining');
  const limitHeader = res.headers.get('x-ratelimit-limit');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining || limitHeader || reset) {
    await saveUsageHeaders({ remaining, limit: limitHeader, reset }).catch(() => {});
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Chave da API de imagens recusada.');
    if (res.status === 429) throw new Error('Limite de consultas da API de imagens atingido.');
    throw new Error(`API de imagens respondeu ${res.status}.`);
  }

  const body = (await res.json()) as {
    photos?: {
      url?: string | null;
      alt?: string | null;
      photographer?: string | null;
      photographer_url?: string | null;
      src?: Record<string, string | undefined> | null;
    }[];
  };
  const photos = Array.isArray(body.photos) ? body.photos : [];
  const out: ExternalImage[] = [];
  for (const p of photos) {
    const src = p.src ?? {};
    const full = (src.large || src.original || src.large2x || '').trim();
    if (!/^https?:\/\//i.test(full)) continue;
    const thumb = (src.medium || src.small || full).trim();
    out.push({
      url: full,
      thumb,
      title: (p.alt ?? '').trim(),
      photographer: p.photographer ?? null,
      photographerUrl: p.photographer_url ?? null,
      contextUrl: p.url ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

interface UsageHeaders {
  remaining: string | null;
  limit: string | null;
  reset: string | null;
}

async function saveUsageHeaders(h: UsageHeaders): Promise<void> {
  const entries: [string, string][] = [];
  if (h.remaining) entries.push(['image_api_remaining', h.remaining]);
  if (h.limit) entries.push(['image_api_limit', h.limit]);
  if (h.reset) entries.push(['image_api_reset', h.reset]);
  if (!entries.length) return;
  await Promise.all(
    entries.map(([k, v]) =>
      getPool().query(
        'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [k, v],
      ),
    ),
  );
}

/** Conta mais uma requisição no dia e diz se o teto diário próprio já foi atingido. */
async function registerUsageAndCheckCap(): Promise<boolean> {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT requests FROM image_api_usage WHERE day = CURDATE() AND provider = ?',
    [PROVIDER],
  );
  const used = Number((rows as { requests: number }[])[0]?.requests ?? 0);
  if (used >= DAILY_CAP) return false;
  await pool.query(
    `INSERT INTO image_api_usage (day, provider, requests) VALUES (CURDATE(), ?, 1)
     ON DUPLICATE KEY UPDATE requests = requests + 1`,
    [PROVIDER],
  );
  return true;
}

interface CachedRow {
  results: string | ExternalImage[];
  expires_at: string;
}

/**
 * Busca externa com cache. Devolve `cached: true` quando veio do cache (sem gastar cota).
 * Lança quando a API falha de verdade; devolve lista vazia quando não configurada.
 */
export async function searchExternalCached(q: string, limit = EXTERNAL_LIMIT): Promise<{ results: ExternalImage[]; cached: boolean }> {
  const pool = getPool();
  const term = q.trim().slice(0, 191);

  const [cacheRows] = await pool.query(
    'SELECT results, expires_at FROM catalog_search_cache WHERE term = ? AND provider = ? AND expires_at > NOW()',
    [term, PROVIDER],
  );
  const cached = (cacheRows as CachedRow[])[0];
  if (cached) {
    const parsed = typeof cached.results === 'string' ? (JSON.parse(cached.results) as ExternalImage[]) : cached.results;
    return { results: parsed.slice(0, limit), cached: true };
  }

  const cfg = await loadImageApiConfig();
  if (!cfg) return { results: [], cached: false };

  const allowed = await registerUsageAndCheckCap();
  if (!allowed) throw new Error('Limite diário de buscas externas atingido. Tente novamente amanhã.');

  const results = await searchPexels(term, EXTERNAL_LIMIT, cfg);
  // Cache mesmo resultado vazio: evita repetir o gasto para um termo que não acha nada.
  await pool.query(
    `INSERT INTO catalog_search_cache (term, provider, results, expires_at)
     VALUES (?, ?, CAST(? AS JSON), DATE_ADD(NOW(3), INTERVAL ? SECOND))
     ON DUPLICATE KEY UPDATE results = VALUES(results), expires_at = VALUES(expires_at), created_at = NOW(3)`,
    [term, PROVIDER, JSON.stringify(results), Math.round(CACHE_TTL_MS / 1000)],
  );
  return { results, cached: false };
}

// ── Download de imagem externa (com guarda SSRF) ─────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return false;
}

/** Só http/https e host público — evita que a rota vire proxy para a rede interna. */
async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL inválida.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Protocolo não permitido.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('Host não permitido.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Endereço não permitido.');
    return u;
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => [] as { address: string }[]);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Host não permitido.');
  return u;
}

export interface DownloadedImage {
  buf: Buffer;
  format: ImageFormat;
  width: number;
  height: number;
}

/**
 * Baixa uma imagem de URL externa validando cada salto (SSRF) e o conteúdo (formato/tamanho).
 * Devolve `null` quando a URL não passa na validação ou o conteúdo não é uma imagem aceita.
 */
export async function downloadExternalImage(raw: string): Promise<DownloadedImage | null> {
  let target: URL;
  try {
    target = await assertPublicHttpUrl(raw);
  } catch {
    return null;
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'image/*' },
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      try {
        target = await assertPublicHttpUrl(new URL(loc, target).toString());
      } catch {
        return null;
      }
      continue;
    }
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared && declared > MAX_IMAGE_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    const check = validateCatalogImage(buf);
    if (!check.ok) return null;
    return { buf, format: check.format, width: check.width, height: check.height };
  }
  return null;
}

/** Hash do conteúdo — usado para deduplicar a imagem que entra na curadoria. */
export function contentHash(buf: Buffer): string {
  return sha256(buf);
}
