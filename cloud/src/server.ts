import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { getPool } from './db';
import syncRoutes from './routes/sync';
import licenseRoutes from './routes/license';
import backupRoutes from './routes/backup';
import billingRoutes from './routes/billing';
import catalogRoutes from './routes/catalog';
import themeRoutes from './routes/themes';
import messageRoutes from './routes/messages';
import adminRoutes from './routes/admin';
import adminMessagesRoutes from './routes/adminMessages';
import wikiRoutes from './routes/wiki';
import landingRoutes from './routes/landing';
import supportRoutes from './routes/support';
import menuRoutes from './routes/menu';
import mobileGrantsRoutes from './routes/mobileGrants';
import { mobileSide as mobileCommandsRoutes, desktopSide as desktopCommandsRoutes } from './routes/mobileCommands';
import mobileAppRoutes from './routes/mobileApp';
import quotePublicRoutes from './routes/quotePublic';
import telemetryRoutes, { startTelemetryRetention } from './routes/telemetry';
import affiliateRoutes from './routes/affiliate';
import { purgeExpiredAdminSessions, purgeExpiredPasswordResets } from './adminAuth';
import { purgeExpiredAffiliateSessions } from './affiliateAuth';
import { fmtDateBr, fmtDateTimeBr } from './format';

const PORT = Number(process.env.CLOUD_PORT ?? 4000);

/**
 * Retenção de dados operacionais que crescem para sempre. Os comandos do Kivo Web ficam só
 * como histórico do que já foi aplicado; sem limpeza a tabela vira lixo de anos. Roda no
 * boot e a cada 24h. (Os relatórios de erro têm retenção própria em routes/telemetry.ts.)
 */
function startDataRetention(): NodeJS.Timeout {
  const run = async () => {
    try {
      const [res] = await getPool().query(
        "DELETE FROM company_commands WHERE status <> 'pendente' AND applied_at < (NOW() - INTERVAL 30 DAY)",
      );
      const removidos = (res as { affectedRows?: number }).affectedRows ?? 0;
      if (removidos > 0) console.log(`[retention] ${removidos} comando(s) antigo(s) removido(s).`);
      // Cache da busca de imagens vencido: não precisa ficar ocupando espaço.
      await getPool().query('DELETE FROM catalog_search_cache WHERE expires_at < NOW()');
    } catch (e) {
      console.error('[retention] falha ao limpar comandos antigos:', e);
    }
  };
  void run();
  const timer = setInterval(run, 24 * 3600e3);
  timer.unref?.();
  return timer;
}

export function createCloudServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, 'views'));
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));
  // Helpers de data/hora disponíveis em toda view renderizada no servidor (formato BR).
  app.use((_req, res, next) => {
    res.locals.fmtDateBr = fmtDateBr;
    res.locals.fmtDateTimeBr = fmtDateTimeBr;
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'kivo-cloud' }));
  app.use('/', landingRoutes);
  app.use('/wiki', wikiRoutes);
  app.use('/cardapio', menuRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/license', licenseRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/catalog', catalogRoutes);
  // Loja de temas (pacotes de ícones): o servidor local do desktop chama com as credenciais
  // de licença da empresa.
  app.use('/api/themes', themeRoutes);
  // Central de mensagens: o servidor local busca a caixa de entrada e a imagem de destaque
  // com as credenciais de licença (o navegador não fala com a nuvem — a CSP do app é 'self').
  app.use('/api/messages', messageRoutes);
  // Kivo Web. As concessões e a fila vista pelo celular vivem em /api/mobile (cookie de
  // acesso); o lado do desktop fica em /api/commands (credenciais de licença).
  app.use('/api/mobile', mobileGrantsRoutes);
  app.use('/api/mobile', mobileCommandsRoutes);
  app.use('/api/commands', desktopCommandsRoutes);
  app.use('/m', mobileAppRoutes);
  // Página do orçamento que o CLIENTE da loja abre pelo link do WhatsApp. Fora de `/m`
  // porque é pública — `/m` inteiro exige o cookie de acesso do lojista.
  app.use('/', quotePublicRoutes);
  app.use('/api/support', supportRoutes);
  app.use('/api/telemetry', telemetryRoutes);
  // Portal do afiliado (representante): login próprio e visão restrita às indicações dele.
  app.use('/afiliado', affiliateRoutes);
  app.use('/admin/messages', adminMessagesRoutes);
  app.use('/admin', adminRoutes);

  // Middleware de erro global: captura falhas de conexão com o banco de dados
  // e exibe uma página amigável com instruções em português.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && 'message' in err && /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/.test(err.message)) {
      console.error('[DB] Erro de conexão:', err.message);
      res.status(503).render('db-error');
      return;
    }
    console.error('[SERVER]', err);
    res.status(500).send('Erro interno do servidor.');
  });

  return app;
}

if (require.main === module) {
  const app = createCloudServer();
  startTelemetryRetention();
  startDataRetention();
  // Sessões do painel e do portal do afiliado vivem no banco — limpa as vencidas no
  // boot e a cada 6h.
  purgeExpiredAdminSessions();
  purgeExpiredPasswordResets();
  purgeExpiredAffiliateSessions();
  setInterval(() => {
    purgeExpiredAdminSessions();
    purgeExpiredPasswordResets();
    purgeExpiredAffiliateSessions();
  }, 6 * 3600e3).unref?.();
  app.listen(PORT, () => console.log(`[kivo-cloud] ouvindo em http://localhost:${PORT}`));
}
