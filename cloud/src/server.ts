import path from 'node:path';
import express from 'express';
import syncRoutes from './routes/sync';
import licenseRoutes from './routes/license';
import backupRoutes from './routes/backup';
import billingRoutes from './routes/billing';
import catalogRoutes from './routes/catalog';
import adminRoutes from './routes/admin';
import wikiRoutes from './routes/wiki';

const PORT = Number(process.env.CLOUD_PORT ?? 4000);

export function createCloudServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, 'views'));
  app.use(express.static(path.resolve(__dirname, 'public')));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'katsu-cloud' }));
  app.use('/wiki', wikiRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/license', licenseRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/catalog', catalogRoutes);
  app.use('/admin', adminRoutes);
  return app;
}

if (require.main === module) {
  const app = createCloudServer();
  app.listen(PORT, () => console.log(`[katsu-cloud] ouvindo em http://localhost:${PORT}`));
}
