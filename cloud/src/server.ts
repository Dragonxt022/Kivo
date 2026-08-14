import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import syncRoutes from './routes/sync';
import licenseRoutes from './routes/license';
import backupRoutes from './routes/backup';
import billingRoutes from './routes/billing';
import catalogRoutes from './routes/catalog';
import adminRoutes from './routes/admin';
import wikiRoutes from './routes/wiki';
import landingRoutes from './routes/landing';
import supportRoutes from './routes/support';
import menuRoutes from './routes/menu';
import mobileGrantsRoutes from './routes/mobileGrants';
import { mobileSide as mobileCommandsRoutes, desktopSide as desktopCommandsRoutes } from './routes/mobileCommands';
import mobileAppRoutes from './routes/mobileApp';
import quotePublicRoutes from './routes/quotePublic';

const PORT = Number(process.env.CLOUD_PORT ?? 4000);

export function createCloudServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, 'views'));
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'kivo-cloud' }));
  app.use('/', landingRoutes);
  app.use('/wiki', wikiRoutes);
  app.use('/cardapio', menuRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/license', licenseRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/catalog', catalogRoutes);
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
  app.listen(PORT, () => console.log(`[kivo-cloud] ouvindo em http://localhost:${PORT}`));
}
