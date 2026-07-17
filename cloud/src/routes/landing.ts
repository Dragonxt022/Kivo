import { Router } from 'express';

/**
 * Landing page pública de venda do Katsu (rota "/").
 *
 * O link de download e a versão exibida vêm da release mais recente do GitHub
 * (releases/latest), consultada com cache em memória — publicar uma nova release
 * atualiza o site sozinho, sem redeploy. Se a API falhar (offline, rate limit),
 * cai no último valor conhecido ou no fallback fixo abaixo.
 *
 * KATSU_DOWNLOAD_URL / KATSU_APP_VERSION no ambiente têm precedência sobre tudo
 * (útil para apontar para um mirror ou congelar uma versão).
 */
const GITHUB_LATEST_API = 'https://api.github.com/repos/Dragonxt022/katsu/releases/latest';
const FALLBACK_VERSION = '0.2.5';
const FALLBACK_URL = `https://github.com/Dragonxt022/katsu/releases/download/v${FALLBACK_VERSION}/Katsu-Setup-${FALLBACK_VERSION}.exe`;
const CACHE_TTL_MS = 30 * 60 * 1000;

type ReleaseInfo = { downloadUrl: string; version: string };

let cached: ReleaseInfo | null = null;
let cachedAt = 0;

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const res = await fetch(GITHUB_LATEST_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'katsu-cloud' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const rel = (await res.json()) as {
    tag_name?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  const asset = (rel.assets ?? []).find((a) => /^Katsu-Setup-.*\.exe$/i.test(a.name));
  if (!asset) return null;
  const version = String(rel.tag_name ?? '').replace(/^v/, '') || FALLBACK_VERSION;
  return { downloadUrl: asset.browser_download_url, version };
}

async function getReleaseInfo(): Promise<ReleaseInfo> {
  if (process.env.KATSU_DOWNLOAD_URL) {
    return {
      downloadUrl: process.env.KATSU_DOWNLOAD_URL,
      version: process.env.KATSU_APP_VERSION ?? FALLBACK_VERSION,
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

export default router;
