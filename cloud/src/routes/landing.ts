import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { getPool } from '../db';
import { getCommercialPlans } from '../plans';
import { createRateLimiter } from '../rateLimit';

/**
 * Landing page pública de venda do Kuruk (rota "/").
 *
 * O link de download e a versão exibida vêm da release mais recente do GitHub
 * (releases/latest), consultada com cache em memória — publicar uma nova release
 * atualiza o site sozinho, sem redeploy. Se a API falhar (offline, rate limit),
 * cai no último valor conhecido ou no fallback fixo abaixo.
 *
 * KURUK_DOWNLOAD_URL / KURUK_APP_VERSION no ambiente têm precedência sobre tudo
 * (útil para apontar para um mirror ou congelar uma versão).
 */
const GITHUB_LATEST_API = 'https://api.github.com/repos/Dragonxt022/kuruk/releases/latest';
// Última release publicada ainda usa o nome antigo do instalador. O fallback
// aponta para ela até existir uma release `Kuruk-Setup-*`; a consulta à API já
// aceita os dois nomes e passa a preferir a release nova sozinha.
const FALLBACK_VERSION = '2.1.16';
const FALLBACK_URL = `https://github.com/Dragonxt022/kuruk/releases/download/v${FALLBACK_VERSION}/Kivo-Setup-${FALLBACK_VERSION}.exe`;
const CACHE_TTL_MS = 30 * 60 * 1000;

type ReleaseInfo = { downloadUrl: string; version: string };

let cached: ReleaseInfo | null = null;
let cachedAt = 0;

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const res = await fetch(GITHUB_LATEST_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kuruk-cloud' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const rel = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  // Kivo = releases anteriores ao rebrand; Kuruk = releases novas.
  const asset = (rel.assets ?? []).find((a) => /^(Kuruk|Kivo|Katsu)-Setup-.*\.exe$/i.test(a.name));
  if (!asset) return null;
  const version = String(rel.tag_name ?? '').replace(/^v/, '') || FALLBACK_VERSION;
  return { downloadUrl: asset.browser_download_url, version };
}

async function getReleaseInfo(): Promise<ReleaseInfo> {
  if (process.env.KURUK_DOWNLOAD_URL) {
    return {
      downloadUrl: process.env.KURUK_DOWNLOAD_URL,
      version: process.env.KURUK_APP_VERSION ?? FALLBACK_VERSION,
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

/**
 * Cadastro obrigatório antes do download. Em vez de contar cliques anônimos, o site pede
 * nome, celular e e-mail e guarda em installer_leads. O link do instalador carrega um token
 * aleatório com validade curta, então o painel consegue ver quem se cadastrou e quem baixou.
 *
 * Best-effort, como antes: se o banco estiver fora, o download continua (o cadastro é
 * perdido, mas o cliente não fica bloqueado). O freio por IP evita enxurrada de robôs.
 */
const DOWNLOAD_TOKEN_TTL_DAYS = 7;
const downloadRateLimited = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 8,
  keyPrefix: 'download-lead:',
});

function clip(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** Origem amigável para o painel: o caminho da página que levou ao formulário. */
function origemFromReferer(req: Request): string | null {
  const raw = req.get('referer');
  if (!raw) return null;
  try {
    return clip(new URL(raw).pathname, 80);
  } catch {
    return clip(raw, 80);
  }
}

function downloadFormParams(
  version: string,
  extra: {
    origem?: string;
    error?: string | null;
    expirado?: boolean;
    values?: { name?: string; whatsapp?: string; email?: string };
  } = {},
) {
  return {
    downloadUrl: '/baixar',
    appVersion: version,
    plans: getCommercialPlans(),
    origem: extra.origem ?? '',
    error: extra.error ?? null,
    expirado: extra.expirado ?? false,
    values: {
      name: extra.values?.name ?? '',
      whatsapp: extra.values?.whatsapp ?? '',
      email: extra.values?.email ?? '',
    },
  };
}

/**
 * Formulário público de download. O link exibido em todas as páginas do site é `/baixar`,
 * nunca a URL direta do GitHub, senão o cadastro é ignorado.
 */
router.get('/baixar', async (req, res) => {
  const { version } = await getReleaseInfo();
  res.render(
    'baixar',
    downloadFormParams(version, {
      origem: clip(req.query.origem, 80) ?? '',
      expirado: req.query.expirado === '1',
    }),
  );
});

router.post('/baixar', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const { downloadUrl, version } = await getReleaseInfo();

  const renderError = (error: string, status = 400) =>
    res.status(status).render(
      'baixar',
      downloadFormParams(version, {
        origem: clip(b.origem, 80) ?? clip(req.query.origem, 80) ?? '',
        error,
        values: {
          name: String(b.name ?? '').trim(),
          whatsapp: String(b.whatsapp ?? '').trim(),
          email: String(b.email ?? '').trim(),
        },
      }),
    );

  // Honeypot: campo invisível para humanos; bot que preencher não recebe token.
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    return res.redirect(303, '/baixar');
  }

  const name = String(b.name ?? '').trim();
  const whatsapp = String(b.whatsapp ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  const phoneDigits = digitsOnly(whatsapp);

  if (name.length < 2 || name.length > 120) {
    return renderError('Informe seu nome completo.');
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 13) {
    return renderError('Informe um celular válido, com DDD.');
  }
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderError('Informe um e-mail válido.');
  }
  if (downloadRateLimited(req.ip ?? 'desconhecido')) {
    return renderError('Muitos cadastros seguidos — tente novamente mais tarde.', 429);
  }

  const origem = clip(b.origem, 80) ?? clip(req.query.origem, 80) ?? origemFromReferer(req);
  const token = randomBytes(24).toString('hex');

  try {
    await getPool().query(
      `INSERT INTO installer_leads
         (name, whatsapp, email, ip, user_agent, referer, origem, version, download_token, token_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ${DOWNLOAD_TOKEN_TTL_DAYS} DAY))`,
      [
        name,
        whatsapp,
        email,
        clip(req.ip, 64),
        clip(req.get('user-agent'), 400),
        clip(req.get('referer'), 500),
        origem,
        clip(version, 24),
        token,
      ],
    );
  } catch (e) {
    console.error('[downloads] falha ao registrar cadastro (libera o download mesmo assim):', e);
    return res.redirect(303, downloadUrl);
  }

  res.redirect(303, `/baixar/obrigado?t=${encodeURIComponent(token)}`);
});

router.get('/baixar/obrigado', async (req, res) => {
  const token = String(req.query.t ?? '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return res.redirect(303, '/baixar');

  // Valida antes de exibir a página: token expirado volta para o formulário.
  try {
    const [rows] = await getPool().query(
      `SELECT id FROM installer_leads
        WHERE download_token = ? AND token_expires_at > NOW(3) LIMIT 1`,
      [token],
    );
    if (!(rows as { id: number }[]).length) return res.redirect(303, '/baixar?expirado=1');
  } catch (e) {
    // Banco fora: não bloqueia a página; o botão de download tenta de novo.
    console.error('[downloads] falha ao validar token (segue para a página):', e);
  }

  const { version } = await getReleaseInfo();
  res.render('baixar-obrigado', {
    downloadUrl: `/baixar/arquivo?t=${encodeURIComponent(token)}`,
    appVersion: version,
    fileUrl: `/baixar/arquivo?t=${encodeURIComponent(token)}`,
  });
});

router.get('/baixar/arquivo', async (req, res) => {
  const token = String(req.query.t ?? '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return res.redirect(303, '/baixar');

  try {
    const [rows] = await getPool().query(
      `SELECT id FROM installer_leads
        WHERE download_token = ? AND token_expires_at > NOW(3) LIMIT 1`,
      [token],
    );
    const lead = (rows as { id: number }[])[0];
    if (!lead) return res.redirect(303, '/baixar?expirado=1');

    await getPool().query(
      `UPDATE installer_leads
          SET downloaded_at = COALESCE(downloaded_at, NOW(3)),
              download_count = download_count + 1
        WHERE id = ?`,
      [lead.id],
    );
  } catch (e) {
    // Igual ao cadastro: a indisponibilidade do banco não pode impedir o download.
    console.error('[downloads] falha ao validar token (libera o download mesmo assim):', e);
  }

  const { downloadUrl } = await getReleaseInfo();
  res.redirect(302, downloadUrl);
});

router.get('/', async (_req, res) => {
  const { version } = await getReleaseInfo();
  res.render('landing', { downloadUrl: '/baixar', appVersion: version, plans: getCommercialPlans() });
});

/**
 * Páginas institucionais do site. Todas recebem os mesmos dados de release
 * (link de download e versão), então ficam registradas por uma tabela simples
 * rota → view em vez de um handler repetido para cada uma.
 */
const SITE_PAGES: Record<string, string> = {
  '/lojas': 'lojas',
  '/farmacias': 'farmacias',
  '/restaurantes': 'restaurantes',
  '/servicos': 'servicos',
  '/odonto': 'odonto',
  '/recursos': 'recursos',
  '/recursos/pdv': 'recursos-pdv',
  '/recursos/estoque': 'recursos-estoque',
  '/recursos/financeiro': 'recursos-financeiro',
  '/recursos/restaurante': 'recursos-restaurante',
  '/recursos/cardapio-online': 'recursos-cardapio',
  '/recursos/importacao-nfe': 'recursos-nfe',
  '/recursos/fiscal': 'recursos-fiscal',
  '/recursos/etiquetas': 'recursos-etiquetas',
  '/planos': 'planos',
  '/contato': 'contato',
};

for (const [path, view] of Object.entries(SITE_PAGES)) {
  router.get(path, async (_req, res) => {
    const { version } = await getReleaseInfo();
    res.render(view, { downloadUrl: '/baixar', appVersion: version, plans: getCommercialPlans() });
  });
}

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
