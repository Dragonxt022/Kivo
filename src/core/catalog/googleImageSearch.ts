import dns from 'node:dns/promises';
import net from 'node:net';
import { getSecret } from '../secrets/service';
import { settingsRepository } from '../repositories/SettingsRepository';

/**
 * Busca de imagens na web via Google Programmable Search Engine (CSE), usada para
 * SUGERIR fotos ao cadastrar um produto. É a camada "externa" do sugestor: o app local
 * chama a API JSON do Google direto (a chave fica no cofre local, ver
 * core/secrets/service.ts), e se ela falhar/não estiver configurada o cadastro cai no
 * sugestor local que já existe — o banco de imagens do Kivo Cloud (ver
 * submissionQueue.ts / cloud/src/routes/catalog.ts).
 *
 * Por que não embutir a API Key: a API JSON do Google exige uma chave além do `cx`. Ela
 * é configurada em Configurações → Imagens e guardada no cofre (nunca na tabela
 * `settings`, que sincroniza e é legível por qualquer usuário com `settings.view`).
 */

/** Chave no cofre local. */
export const GOOGLE_CSE_SECRET_KEY = 'google.cse_api_key';
/** `cx` do motor de busca (Configurações → Imagens). */
export const GOOGLE_CSE_CX_SETTING = 'imagens.cse_cx';
/**
 * `cx` do motor criado pelo usuário (https://cse.google.com/cse?cx=a7c7f9a8761d54e79).
 * Fica como padrão para a busca funcionar assim que a chave for colada.
 */
export const DEFAULT_GOOGLE_CSE_CX = 'a7c7f9a8761d54e79';

const API_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface GoogleImageResult {
  title: string;
  /** URL da imagem em tamanho cheio (usada ao escolher). */
  imageUrl: string;
  /** Miniatura (normalmente hospedada pelo Google) usada na grade de sugestões. */
  thumbUrl: string;
  /** Página de contexto, quando houver. */
  contextUrl?: string;
}

export interface GoogleCseConfig {
  apiKey: string;
  cx: string;
}

/** Config pronta para uso, ou `null` se a chave não estiver configurada. */
export function getGoogleCseConfig(): GoogleCseConfig | null {
  const apiKey = getSecret(GOOGLE_CSE_SECRET_KEY)?.trim();
  if (!apiKey) return null;
  const cx = (settingsRepository.get(GOOGLE_CSE_CX_SETTING) || DEFAULT_GOOGLE_CSE_CX).trim();
  if (!cx) return null;
  return { apiKey, cx };
}

interface CseItem {
  title?: string;
  link?: string;
  snippet?: string;
  image?: {
    thumbnailLink?: string;
    contextLink?: string;
  };
}

/**
 * Consulta a API JSON do Google CSE (searchType=image). Lança em erro de rede/quota —
 * quem chama decide cair no sugestor local. `limit` é limitado a 10 (teto da API).
 */
export async function searchGoogleImages(q: string, limit = 6): Promise<GoogleImageResult[]> {
  const cfg = getGoogleCseConfig();
  if (!cfg) throw new Error('Busca no Google não configurada (falta a API Key).');

  const num = Math.max(1, Math.min(limit, 10));
  const url = new URL(API_ENDPOINT);
  url.searchParams.set('key', cfg.apiKey);
  url.searchParams.set('cx', cfg.cx);
  url.searchParams.set('q', q);
  url.searchParams.set('searchType', 'image');
  url.searchParams.set('num', String(num));
  url.searchParams.set('safe', 'active');
  url.searchParams.set('hl', 'pt-BR');

  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Google respondeu ${res.status}.`);
  }
  const body = (await res.json()) as { items?: CseItem[] };
  const items = Array.isArray(body.items) ? body.items : [];

  const out: GoogleImageResult[] = [];
  for (const it of items) {
    const imageUrl = typeof it.link === 'string' ? it.link : '';
    if (!/^https?:\/\//i.test(imageUrl)) continue;
    const thumbUrl = typeof it.image?.thumbnailLink === 'string' && it.image.thumbnailLink
      ? it.image.thumbnailLink
      : imageUrl;
    out.push({
      title: (it.title ?? '').trim(),
      imageUrl,
      thumbUrl,
      contextUrl: it.image?.contextLink,
    });
    if (out.length >= num) break;
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
 * Baixa uma imagem de uma URL externa (sugestão do Google ou escolha em cache no Cloud)
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
