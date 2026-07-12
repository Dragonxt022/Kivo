import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { loadModules, collectMenu, filterModuleMenu } from './modules/loader';
import type { LoadedModule } from './modules/types';
import { attachUser, requireAuth } from './auth/middleware';
import authRoutes from './auth/routes';
import usersRoutes from './users/routes';
import rolesRoutes from './roles/routes';
import auditRoutes from './audit/routes';
import settingsRoutes from './config/routes';
import backupRoutes from './backup/routes';
import licenseRoutes from './license/routes';
import syncRoutes from './sync/routes';
import billingRoutes from './billing/routes';
import securityRoutes from './security/routes';
import { startBackupScheduler } from './backup/service';
import { validateLicense, isActivated, refreshLicenseFromCloud } from './license/service';
import activationRoutes from './license/activationRoutes';
import { productImagesDir, trySubmitPending } from './catalog/submissionQueue';

/** Revalidação periódica (fora do boot/sync manual): sem isso, a trava de máquina/relógio
 * só se autocura se o usuário reiniciar o app ou clicar em "Sincronizar agora". */
function startLicenseRevalidationScheduler(): NodeJS.Timeout {
  const check = () => {
    refreshLicenseFromCloud().catch(() => {});
  };
  const timer = setInterval(check, 4 * 3600e3); // a cada 4h
  timer.unref();
  return timer;
}

/** Ativação obrigatória: sem isso, nenhuma rota (exceto a própria tela de ativação) responde. */
function requireActivation(req: Request, res: Response, next: NextFunction): void {
  if (isActivated()) {
    next();
    return;
  }
  if (req.path.startsWith('/api/')) {
    res.status(403).json({ error: 'not_activated' });
    return;
  }
  res.redirect('/ativacao');
}

export interface KatsuServer {
  app: Express;
  modules: LoadedModule[];
}

/** Página protegida por permissão: sem permissão → volta para a home. */
function page(view: string, permission?: string) {
  return (req: Request, res: Response, _next: NextFunction) => {
    if (permission && !req.user!.permissions.has(permission)) return res.redirect('/');
    res.render(view, { user: req.user });
  };
}

/** Cria a API local (Express 5) + views EJS e carrega os módulos via manifesto. */
export async function createServer(): Promise<KatsuServer> {
  const app = express();
  // Relativo a __dirname (não process.cwd()): dev resolve para src/views|public; app
  // empacotado resolve para dist/views|public (ver scripts/copy-build-assets.js).
  const coreViews = path.resolve(__dirname, '..', 'views');

  app.set('view engine', 'ejs');
  app.set('views', coreViews);

  // Disponível em toda view (app.locals é mesclado automaticamente pelo EJS) — evita
  // número de versão hardcoded e divergente em cada tela que precisa exibi-lo.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  app.locals.appVersion = pkg.version;

  // Limite maior que o padrão (100kb): fotos de produto viajam como base64 no corpo JSON
  // (ver modules/commercial/routes.ts) — servidor local/Electron, não exposto à internet.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.resolve(__dirname, '..', 'public')));
  app.use('/uploads/products', express.static(productImagesDir()));

  // Health check e tela de ativação: alcançáveis mesmo numa instalação ainda não
  // ativada (é o próprio propósito da tela). O gate abaixo bloqueia todo o resto.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'katsu', ts: new Date().toISOString() });
  });
  app.use(activationRoutes);
  app.use(requireActivation);

  app.use(attachUser);
  app.use(filterModuleMenu);

  // Rotas públicas
  app.use('/api/auth', authRoutes);
  app.get('/login', (_req, res) => {
    res.redirect('/?login=1');
  });

  // API do Core (auth + RBAC por rota)
  app.use('/api/users', requireAuth, usersRoutes);
  app.use('/api/roles', requireAuth, rolesRoutes);
  app.use('/api/audit', requireAuth, auditRoutes);
  app.use('/api/settings', requireAuth, settingsRoutes);
  app.use('/api/backup', requireAuth, backupRoutes);
  app.use('/api/license', requireAuth, licenseRoutes);
  app.use('/api/sync', requireAuth, syncRoutes);
  app.use('/api/billing', requireAuth, billingRoutes);
  app.use('/api/security', requireAuth, securityRoutes);

  // Páginas do Core
  app.get('/', page('home'));
  app.get('/admin/usuarios', requireAuth, page('users', 'users.view'));
  app.get('/admin/cargos', requireAuth, page('roles', 'roles.view'));
  app.get('/admin/auditoria', requireAuth, page('audit', 'audit.view'));
  app.get('/admin/backup', requireAuth, page('backup', 'backup.view'));
  app.get('/admin/configuracoes', requireAuth, page('settings', 'settings.view'));
  app.get('/admin/cobrancas', requireAuth, page('billing', 'billing.view'));

  // Módulos: API (/api/<id>) e páginas (/app/<id>) exigem autenticação por padrão
  app.use('/api', requireAuth);
  app.use('/app', requireAuth);
  const modules = await loadModules(app);

  // Views dos módulos entram no lookup do EJS; menu dos manifestos vai para as views
  const moduleViews = modules.map((m) => m.viewsDir).filter((v): v is string => !!v);
  app.set('views', [coreViews, ...moduleViews]);
  app.locals.moduleMenu = collectMenu(modules);

  // Licença (não trava o boot) e backup diário às 23:00
  const lic = validateLicense();
  console.log(`[license] ${lic.status}: ${lic.message}`);
  startBackupScheduler();
  startLicenseRevalidationScheduler();
  // Fotos de produto pendentes de envio ao banco de imagens do Cloud (best-effort, não trava o boot).
  trySubmitPending().catch(() => {});

  return { app, modules };
}
