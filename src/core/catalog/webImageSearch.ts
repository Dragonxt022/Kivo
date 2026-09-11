import dns from 'node:dns/promises';
import net from 'node:net';
import { getSecret } from '../secrets/service';

/**
 * Busca de imagens na web para SUGERIR fotos ao cadastrar um produto.
 *
 * Provedor: Brave Search API (endpoint de imagens). É a camada "externa" do sugestor — o
 * app local chama a API direto (a chave fica no cofre local, ver core/secrets/service.ts)
 * e, se ela falhar/não estiver configurada, o cadastro cai no sugestor local que já existe:
 * o banco de imagens do Kivo Cloud (ver submissionQueue.ts / cloud/src/routes/catalog.ts).
 *
 * Por que Brave e não Google CSE: o Google encerrou a Custom Search JSON API para NOVOS
 * clientes (fórum oficial, 2026; clientes antigos têm até 01/01/2027). Como a chave/cx deste
 * projeto foram criados depois do corte, o Google responde 403 "This project does not have
 * the access to Custom Search JSON API". A Brave tem busca de imagens, tier gratuito
 * recorrente e uma API JSON simples — daí a troca.
 *
 * A chave também pode vir de `KIVO_BRAVE_SEARCH_API_KEY` (padrão de fábrica/instalador);
 * a UI (cofre) tem prioridade.
 */

/** Chave no cofre local. */
export const BRAVE_API_KEY_SECRET = 'brave.search_api_key';
/** Variável de ambiente aceita como padrão de fábrica (mesmo padrão de KIVO_SYNC_SERVER_URL). */
export const BRAVE_API_KEY_ENV = 'KIVO_BRAVE_SEARCH_API_KEY';

const API_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** A API aceita até 200 por requisição; a tela usa 6. */
const MAX_RESULTS = 200;

export interface WebImageResult {
  title: string;
  /** URL da imagem em tamanho cheio (usada ao escolher). */
  imageUrl: string;
  /** Miniatura usada na grade de sugestões. */
  thumbUrl: string;
  /** Página de contexto, quando houver. */
  contextUrl?: string;
}

export type WebImageSource = 'vault' | 'env';

export interface WebImageConfig {
  apiKey: string;
  source: WebImageSource;
}

/** Config pronta para uso, ou `null` se a chave não estiver configurada (cofre ou ambiente). */
export function getWebImageConfig(): WebImageConfig | null {
  const vaultKey = getSecret(BRAVE_API_KEY_SECRET)?.trim();
  const envKey = (process.env[BRAVE_API_KEY_ENV] ?? '').trim();
  const apiKey = vaultKey || envKey;
  if (!apiKey) return null;
  return { apiKey, source: vaultKey ? 'vault' : 'env' };
}

interface BraveImageItem {
  title?: string | null;
  url?: string | null;
  thumbnail?: { src?: string | null } | null;
  properties?: { url?: string | null; placeholder?: string | null } | null;
}

/**
 * Consulta a Brave Search API (endpoint de imagens). Lança em erro de rede/quota/chave —
 * quem chama decide cair no sugestor local.
 */
export async function searchWebImages(q: string, limit = 6): Promise<WebImageResult[]> {
  const cfg = getWebImageConfig();
  if (!cfg) throw new Error('Busca de imagens não configurada (falta a API Key).');

  const count = Math.max(1, Math.min(limit, MAX_RESULTS));
  const url = new URL(API_ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(count));
  url.searchParams.set('safesearch', 'strict');
  url.searchParams.set('country', 'BR');
  url.searchParams.set('search_lang', 'pt');

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.apiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A Brave devolve erros em JSON; se não der para ler, usa o status mesmo.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { detail?: string; message?: string } | string;
    };
    const detail = typeof body.error === 'string'
      ? body.error
      : (body.error?.detail ?? body.error?.message);
    if (res.status === 401 || res.status === 403) {
      throw new Error(detail ?? 'API Key da Brave recusada.');
    }
    if (res.status === 429) {
      throw new Error(detail ?? 'Limite de consultas da Brave atingido.');
    }
    throw new Error(detail ?? `Brave respondeu ${res.status}.`);
  }
  const body = (await res.json()) as { results?: BraveImageItem[] };
  const items = Array.isArray(body.results) ? body.results : [];

  const out: WebImageResult[] = [];
  for (const it of items) {
    const imageUrl = (it.properties?.url ?? it.thumbnail?.src ?? '').trim();
    if (!/^https?:\/\//i.test(imageUrl)) continue;
    const thumbUrl = (it.thumbnail?.src ?? it.properties?.placeholder ?? imageUrl).trim();
    out.push({
      title: (it.title ?? '').trim(),
      imageUrl,
      thumbUrl,
      contextUrl: it.url ?? undefined,
    });
    if (out.length >= count) break;
  }
  return out;
}

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

/**
 * Barra SSRF: só http/https e só host público. Sem isso, `/products/web-image?u=...`
 * viraria um proxy para `http://169.254.169.254/...` (metadados de nuvem) ou para
 * qualquer serviço na rede local da loja. O host é resolvido por DNS para o caso de um
 * domínio apontar para IP privado.
 */
async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL de imagem inválida.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Protocolo não permitido.');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('Host não permitido.');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Endereço não permitido.');
    return u;
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => [] as { address: string }[]);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Host não permitido.');
  }
  return u;
}

/**
 * Baixa uma imagem de uma URL externa (sugestão da Brave ou escolha em cache no Cloud)
 * para o servidor local — o navegador nunca busca a imagem direto, o que mantém a CSP
 * (`img-src 'self'`) fechada e evita mixed-content/CORS. Segue redirects manualmente
 * validando cada salto (um redirect poderia levar a um IP privado). Devolve o buffer ou
 * `null` quando a URL não passa na validação / o conteúdo não é uma imagem dentro do teto.
 */
export async function fetchExternalImage(raw: string): Promise<{ buf: Buffer; contentType: string } | null> {
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
    return { buf, contentType };
  }
  return null;
}
