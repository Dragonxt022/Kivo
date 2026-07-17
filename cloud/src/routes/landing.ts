import { Router } from 'express';

/**
 * Landing page pública de venda do Katsu (rota "/").
 * O link de download aponta para o instalador publicado no GitHub Releases;
 * atualizar aqui a cada release (ou definir KATSU_DOWNLOAD_URL no ambiente).
 */
const DOWNLOAD_URL =
  process.env.KATSU_DOWNLOAD_URL ??
  'https://github.com/Dragonxt022/katsu/releases/download/v0.2.5/Katsu-Setup-0.2.5.exe';

const APP_VERSION = process.env.KATSU_APP_VERSION ?? '0.2.5';

const router = Router();

router.get('/', (_req, res) => {
  res.render('landing', { downloadUrl: DOWNLOAD_URL, appVersion: APP_VERSION });
});

export default router;
