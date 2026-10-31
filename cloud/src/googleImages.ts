import { getPool } from './db';
import type { ExternalImage } from './imageApi';

/**
 * Busca de imagens no Google (Custom Search JSON API / Programmable Search).
 *
 * É o caminho OFICIAL para usar o filtro "Licenças Creative Commons" do Google Imagens.
 * Não faz scraping da página do Google: além de instável, raspar viola os termos de uso e
 * quebra a cada mudança de layout. A API devolve as mesmas imagens do índice do Google,
 * com o parâmetro `rights=cc_use_commercially` (Creative Commons com uso comercial).
 *
 * A chave e o `cx` (ID do mecanismo de busca) ficam no Kivo Cloud, em Configurações.
 * O mecanismo precisa estar configurado para buscar a web inteira e permitir imagens.
 * Também aceita `KIVO_GOOGLE_CSE_KEY` / `KIVO_GOOGLE_CSE_CX` por ambiente.
 */

export interface GoogleImagesConfig {
  apiKey: string;
  cx: string;
}

const PROVIDER = 'google';
const DAILY_CAP = 90; // o tier gratuito do CSE é 100 consultas/dia
const CACHE_TTL_MS = 7 * 24 * 3600e3;
const REQUEST_TIMEOUT_MS = 8000;

function apiBase(): string {
  return (process.env.KIVO_GOOGLE_IMAGES_BASE || 'https://www.googleapis.com/customsearch/v1').replace(/\/$/, '');
}

export async function loadGoogleImagesConfig(): Promise<GoogleImagesConfig | null> {
  const [rows] = await getPool().query(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('image_google_api_key','image_google_cx')",
  );
  const map = Object.fromEntries(
    (rows as { setting_key: string; setting_value: string | null }[]).map((r) => [r.setting_key, r.setting_value]),
  );
  const apiKey = String(map.image_google_api_key ?? '').trim() || String(process.env.KIVO_GOOGLE_CSE_KEY ?? '').trim();
  const cx = String(map.image_google_cx ?? '').trim() || String(process.env.KIVO_GOOGLE_CSE_CX ?? '').trim();
  if (!apiKey || !cx) return null;
  return { apiKey, cx };
}

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

interface GoogleImageItem {
  title?: string | null;
  link?: string | null;
  image?: { thumbnailLink?: string | null; contextLink?: string | null } | null;
}

/** Consulta o CSE. Lança em erro de chave/cota/rede. */
export async function searchGoogleImages(
  q: string,
  limit: number,
  cfg: GoogleImagesConfig,
): Promise<ExternalImage[]> {
  const url = new URL(apiBase());
  url.searchParams.set('key', cfg.apiKey);
  url.searchParams.set('cx', cfg.cx);
  url.searchParams.set('q', q);
  url.searchParams.set('searchType', 'image');
  url.searchParams.set('num', String(Math.max(1, Math.min(limit, 10))));
  url.searchParams.set('rights', 'cc_use_commercially');
  url.searchParams.set('safe', 'active');
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('gl', 'br');

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    items?: GoogleImageItem[];
    error?: { message?: string };
  };
  if (!res.ok) {
    const detail = body.error?.message;
    if (res.status === 401 || res.status === 403) {
      throw new Error(detail ?? 'Google recusou a busca (chave/CSE sem acesso ou cota).');
    }
    if (res.status === 429) throw new Error('Limite de consultas do Google atingido.');
    throw new Error(detail ?? `Google respondeu ${res.status}.`);
  }

  const out: ExternalImage[] = [];
  for (const item of Array.isArray(body.items) ? body.items : []) {
    const full = String(item.link ?? '').trim();
    if (!/^https?:\/\//i.test(full)) continue;
    const thumb = String(item.image?.thumbnailLink ?? '').trim() || full;
    out.push({
      url: full,
      thumb,
      title: String(item.title ?? '').trim(),
      contextUrl: item.image?.contextLink ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

interface CachedRow {
  results: string | ExternalImage[];
  expires_at: string;
}

/**
 * Busca no Google com cache e teto diário. `cached: true` não consome cota.
 * Devolve lista vazia quando não configurado.
 */
export async function searchGoogleImagesCached(
  q: string,
  limit = 10,
): Promise<{ results: ExternalImage[]; cached: boolean; configured: boolean }> {
  const pool = getPool();
  const term = q.trim().slice(0, 191);
  const cfg = await loadGoogleImagesConfig();
  const [cacheRows] = await pool.query(
    'SELECT results, expires_at FROM catalog_search_cache WHERE term = ? AND provider = ? AND expires_at > NOW()',
    [term, PROVIDER],
  );
  const cached = (cacheRows as CachedRow[])[0];
  if (cached) {
    const parsed = typeof cached.results === 'string' ? (JSON.parse(cached.results) as ExternalImage[]) : cached.results;
    return { results: parsed.slice(0, limit), cached: true, configured: !!cfg };
  }
  if (!cfg) return { results: [], cached: false, configured: false };

  const allowed = await registerUsageAndCheckCap();
  if (!allowed) throw new Error('Limite diário de buscas no Google atingido. Tente novamente amanhã.');

  const results = await searchGoogleImages(term, limit, cfg);
  await pool.query(
    `INSERT INTO catalog_search_cache (term, provider, results, expires_at)
     VALUES (?, ?, CAST(? AS JSON), DATE_ADD(NOW(3), INTERVAL ? SECOND))
     ON DUPLICATE KEY UPDATE results = VALUES(results), expires_at = VALUES(expires_at), created_at = NOW(3)`,
    [term, PROVIDER, JSON.stringify(results), Math.round(CACHE_TTL_MS / 1000)],
  );
  return { results, cached: false, configured: true };
}
