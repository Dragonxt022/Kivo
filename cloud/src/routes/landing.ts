import { Router } from 'express';
import { getPool } from '../db';

/**
 * Landing page pública de venda do Kivo (rota "/").
 *
 * O link de download e a versão exibida vêm da release mais recente do GitHub
 * (releases/latest), consultada com cache em memória — publicar uma nova release
 * atualiza o site sozinho, sem redeploy. Se a API falhar (offline, rate limit),
 * cai no último valor conhecido ou no fallback fixo abaixo.
 *
 * KIVO_DOWNLOAD_URL / KIVO_APP_VERSION no ambiente têm precedência sobre tudo
 * (útil para apontar para um mirror ou congelar uma versão).
 */
const GITHUB_LATEST_API = 'https://api.github.com/repos/Dragonxt022/kivo/releases/latest';
const FALLBACK_VERSION = '0.2.5';
const FALLBACK_URL = `https://github.com/Dragonxt022/kivo/releases/download/v${FALLBACK_VERSION}/Kivo-Setup-${FALLBACK_VERSION}.exe`;
const CACHE_TTL_MS = 30 * 60 * 1000;

type ReleaseInfo = { downloadUrl: string; version: string };

let cached: ReleaseInfo | null = null;
let cachedAt = 0;

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const res = await fetch(GITHUB_LATEST_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kivo-cloud' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const rel = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  const asset = (rel.assets ?? []).find((a) => /^Kivo-Setup-.*\.exe$/i.test(a.name));
  if (!asset) return null;
  const version = String(rel.tag_name ?? '').replace(/^v/, '') || FALLBACK_VERSION;
  return { downloadUrl: asset.browser_download_url, version };
}

async function getReleaseInfo(): Promise<ReleaseInfo> {
  if (process.env.KIVO_DOWNLOAD_URL) {
    return {
      downloadUrl: process.env.KIVO_DOWNLOAD_URL,
      version: process.env.KIVO_APP_VERSION ?? FALLBACK_VERSION,
    };
  }
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const info = await fetchLatestRelease();
    if (info) {
      cached = info;
      cachedAt = Date.now();
      return info;
    }
  } catch {
    // rede/timeout — usa o que tiver
  }
  // Falhou: mantém o último valor conhecido (e espera o TTL para tentar de novo,
  // senão toda visita pagaria o timeout da API fora do ar) ou usa o fallback fixo.
  cachedAt = Date.now();
  return cached ?? { downloadUrl: FALLBACK_URL, version: FALLBACK_VERSION };
}

const router = Router();

router.get('/', async (_req, res) => {
  const { downloadUrl, version } = await getReleaseInfo();
  res.render('landing', { downloadUrl, appVersion: version });
});

// ─── Formulário de contato (público) ───
// Leads caem em contact_leads e aparecem no painel admin (/admin/leads).

/** Rate limit simples em memória: máx. 5 envios por IP por hora. */
const contactHits = new Map<string, number[]>();
const CONTACT_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_MAX_PER_WINDOW = 5;

function contactRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (contactHits.get(ip) ?? []).filter((t) => now - t < CONTACT_WINDOW_MS);
  if (hits.length >= CONTACT_MAX_PER_WINDOW) return true;
  hits.push(now);
  contactHits.set(ip, hits);
  // Evita a lista crescer para sempre com IPs que nunca voltam.
  if (contactHits.size > 5000) {
    for (const [k, v] of contactHits) {
      if (v.every((t) => now - t >= CONTACT_WINDOW_MS)) contactHits.delete(k);
    }
  }
  return false;
}

router.post('/api/contact', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;

  // Honeypot: campo invisível para humanos; bot que preencher recebe um "ok" falso.
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    return res.json({ ok: true });
  }

  const name = String(b.name ?? '').trim();
  const whatsapp = String(b.whatsapp ?? '').trim();
  const email = String(b.email ?? '').trim();
  const business = String(b.business ?? '').trim();
  const message = String(b.message ?? '').trim();

  if (name.length < 2 || name.length > 120) {
    return res.status(400).json({ ok: false, error: 'Informe seu nome.' });
  }
  const phoneDigits = whatsapp.replace(/\D/g, '');
  if (phoneDigits.length < 8 || whatsapp.length > 40) {
    return res.status(400).json({ ok: false, error: 'Informe um WhatsApp válido, com DDD.' });
  }
  if (email && (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return res.status(400).json({ ok: false, error: 'E-mail inválido.' });
  }
  if (business.length > 160 || message.length > 2000) {
    return res.status(400).json({ ok: false, error: 'Mensagem longa demais.' });
  }

  if (contactRateLimited(req.ip ?? 'desconhecido')) {
    return res.status(429).json({ ok: false, error: 'Muitos envios seguidos — tente novamente mais tarde.' });
  }

  await getPool().query(
    'INSERT INTO contact_leads (name, whatsapp, email, business, message) VALUES (?, ?, ?, ?, ?)',
    [name, whatsapp, email || null, business || null, message || null],
  );
  res.json({ ok: true });
});

export default router;
