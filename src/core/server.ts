import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertAuth } from '../shared/auth';
import { responseEnvelope } from '../shared/responseEnvelope';
import { formatBRL } from '../shared/money';
import { loadModules, collectMenu, filterModuleMenu } from './modules/loader';
import type { LoadedModule } from './modules/types';
import { attachUser, requireAuth } from './auth/middleware';
import authRoutes from './auth/routes';
import usersRoutes from './users/routes';
import remoteRoutes from './remote/routes';
import rolesRoutes from './roles/routes';
import auditRoutes from './audit/routes';
import settingsRoutes from './config/routes';
import { getMachinePrefs } from './config/machinePrefs';
import backupRoutes from './backup/routes';
import licenseRoutes from './license/routes';
import syncRoutes from './sync/routes';
import billingRoutes from './billing/routes';
import securityRoutes from './security/routes';
import { startBackupScheduler } from './backup/service';
import { validateLicense, isActivated, refreshLicenseFromCloud } from './license/service';
import activationRoutes from './license/activationRoutes';
import { productImagesDir, categoryImagesDir, trySubmitPending } from './catalog/submissionQueue';
import { companyLogoDir, LOGO_SETTING_KEY } from './config/companyLogo';
import { getSqlite } from './database/connection';
import { registerSyncTables } from './sync/registry';
import { startSyncScheduler } from './sync/scheduler';
import { startEventChannel } from './sync/events';
import capabilitiesRoutes from './capabilities/routes';
import onboardingRoutes from './onboarding/routes';
import supportRoutes from './support/routes';
import updaterRoutes from './updater/routes';
import recoveryRoutes from './recovery/routes';
import { purgeOldChallenges } from './recovery/service';
import { purgeExpiredSessions } from './auth/service';
import { createLogger } from './logger';

// Um logger por assunto, e não um genérico "server": é o que faz `[backup]`, `[license]`
// e `[http]` continuarem separáveis no arquivo de log quando o suporte for procurar.
const logLicenca = createLogger('license');
const logCatalogo = createLogger('submit');
const logRecuperacao = createLogger('recovery');
const logSessoes = createLogger('sessions');
const logHttp = createLogger('http');

/** Revalidação periódica (fora do boot/sync manual): sem isso, a trava de máquina/relógio
 * só se autocura se o usuário reiniciar o app ou clicar em "Sincronizar agora". */
function startLicenseRevalidationScheduler(): NodeJS.Timeout {
  const check = () => {
    refreshLicenseFromCloud().catch((e) => logLicenca.error('falha na revalidação', e));
  };
  // Uma passada logo depois do boot, além do ciclo de 4h. É por ela que o segredo do
  // resgate de senha chega em instalação já existente (e em plano que não sincroniza, como
  // o prata) — esperar as 4h significaria uma janela em que "esqueci minha senha" não
  // funciona. 20s para não disputar rede com o boot; `unref` para não segurar o processo.
  setTimeout(check, 20_000).unref?.();
  const timer = setInterval(check, 4 * 3600e3); // a cada 4h
  timer.unref();
  return timer;
}

/**
 * Sessões vencidas: limpa no boot e a cada 12h.
 *
 * Nada de sessão expirada tinha prazo de validade em DISCO — `userFromToken` já recusava
 * o token, mas a linha ficava lá para sempre, porque só `logout` apagava e ninguém sai do
 * PDV pelo botão "sair". Em uma instalação de um ano isso é uma tabela com dezenas de
 * milhares de tokens inúteis, todos legíveis por quem alcançar o arquivo do banco.
 *
 * `unref` para o timer não segurar o processo no encerramento — mesma escolha do
 * revalidador de licença acima.
 */
function startSessionPurgeScheduler(): NodeJS.Timeout {
  const limpar = () => {
    try {
      const removidas = purgeExpiredSessions();
      if (removidas > 0) logSessoes.info(`${removidas} sessão(ões) vencida(s) removida(s).`);
    } catch (e) {
      logSessoes.error('falha ao limpar sessões vencidas', e);
    }
  };
  limpar();
  const timer = setInterval(limpar, 12 * 3600e3);
  timer.unref();
  return timer;
}

/**
 * Deixa a logo do lojista disponível para o `nav` em toda página renderizada.
 *
 * Lido a cada requisição de página, e não cacheado em `app.locals` no boot: `settings`
 * SINCRONIZA entre as máquinas da loja, então a logo pode mudar sem que este processo
 * tenha feito nada — com cache de boot, o segundo computador só descobriria a troca no
 * próximo reinício. É um SELECT por chave única, e só em requisição que vira HTML (o
 * filtro abaixo tira /api e /uploads, que são a maioria do volume).
 */
function logoDaEmpresa(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    next();
    return;
  }
  try {
    const linha = getSqlite()
      .prepare('SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL')
      .get(LOGO_SETTING_KEY) as { value: string | null } | undefined;
    res.locals.empresaLogoUrl = linha?.value || null;
  } catch {
    // Banco ainda sem a tabela (instalação nova, antes das migrations): sem logo, e a
    // página renderiza com a marca do Kivo em vez de estourar.
    res.locals.empresaLogoUrl = null;
  }
  next();
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

export interface KivoServer {
  app: Express;
  modules: LoadedModule[];
}

/** Página protegida por permissão: sem permissão → volta para a home. */
function page(view: string, permission?: string) {
  return (req: Request, res: Response, _next: NextFunction) => {
    if (permission) {
      assertAuth(req);
      if (!req.user.permissions.has(permission)) return res.redirect('/');
    }
    res.render(view, { user: req.user });
  };
}

/** Cria a API local (Express 5) + views EJS e carrega os módulos via manifesto. */
export async function createServer(): Promise<KivoServer> {
  const app = express();
  // Relativo a __dirname (não process.cwd()): dev resolve para src/views|public; app
  // empacotado resolve para dist/views|public (ver scripts/copy-build-assets.js).
  const coreViews = path.resolve(__dirname, '..', 'views');

  app.set('view engine', 'ejs');
  app.set('views', coreViews);

  // Disponível em toda view (app.locals é mesclado automaticamente pelo EJS) — evita
  // número de versão hardcoded e divergente em cada tela que precisa exibi-lo.
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { version: string };
  app.locals.appVersion = pkg.version;

  // Modo leve é por máquina (machinePrefs), não por empresa. Entra em app.locals para o
  // partial `theme-init` estampar `data-lite` no <html> junto com tema e layout — antes de
  // qualquer CSS pintar, sem piscar a interface pesada primeiro.
  app.locals.modoLeve = getMachinePrefs().modoLeve;

  // Logo do lojista no cabeçalho — ver o middleware `logoDaEmpresa` mais abaixo.
  app.locals.empresaLogoUrl = null;

  // Valor de reserva do nonce da CSP. Toda requisição HTTP recebe o seu em `res.locals`
  // (que tem precedência sobre `app.locals`) — este aqui só existe para `app.render()`
  // fora de uma requisição, onde não há resposta, nem CSP, nem `res.locals`: sem ele a
  // view estoura em "cspNonce is not defined" em vez de renderizar.
  app.locals.cspNonce = '';

  // Helper EJS: retorna o SVG inline para icones — as views usam currentColor
  const iconsDir = path.resolve(__dirname, '..', 'public', 'icons');
  function svgIcon(name: string, width = 24, height = 24): string {
    try {
      const file = path.join(iconsDir, name + '.svg');
      return fs
        .readFileSync(file, 'utf8')
        .replace(/<svg\b/, `<svg width="${width}" height="${height}"`);
    } catch {
      return '';
    }
  }
  app.locals.svgIcon = svgIcon;

  // Dinheiro nas views renderizadas no servidor (cupom, orçamento, carnê, relatório de
  // caixa, DRE impresso). Cada uma dessas telas trazia a própria cópia de `brl()` — e
  // duas delas tinham divergido, imprimindo "R$ 1234,56" sem o separador de milhar
  // enquanto o resto do sistema imprimia "R$ 1.234,56". Passa a existir uma implementação
  // só, a `formatBRL` de shared/money, que já é coberta por testes.
  app.locals.brl = (cents: number | null | undefined) => formatBRL(cents ?? 0);

  // Mapa nome→SVG para renderização inline no Alpine.js
  const svgMap = (() => {
    const map: Record<string, string> = {};
    try {
      const files = fs.readdirSync(iconsDir);
      for (const f of files) {
        if (!f.endsWith('.svg')) continue;
        const name = f.slice(0, -4);
        const svg = fs.readFileSync(path.join(iconsDir, f), 'utf8');
        map[name] = svg;
      }
    } catch {
      /* sem icones */
    }
    return map;
  })();
  app.locals.svgIconMapJson = JSON.stringify(svgMap);

  // Logging de requisições HTTP
  app.use(morgan('dev'));

  // Security headers (Helmet) — CSP desligado para compatibilidade com Alpine.js CDN
  // Nonce por requisição: é o que permite ligar a CSP sem reescrever os ~53 blocos de
  // <script> inline das telas. Cada resposta ganha um valor novo, e só as tags que o
  // carimbam executam — um <script> que entre pelo nome de um produto (XSS armazenado)
  // não tem como adivinhá-lo.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });

  app.use(
    helmet({
      /**
       * CSP estava DESLIGADA com o comentário "compatibilidade com Alpine.js CDN" — só que
       * o Alpine é servido local (`src/public/vendor/alpine.min.js`) desde que o projeto
       * deixou de usar CDN. O motivo tinha deixado de existir; a porta continuou aberta.
       *
       * `'unsafe-eval'` fica: o Alpine avalia `x-data`/`x-text` com `new Function`, e a
       * alternativa (build CSP-friendly) obrigaria a reescrever toda expressão de toda
       * tela. Mesmo assim a política vale muito: `script-src` com nonce recusa script
       * INJETADO, `connect-src 'self'` corta o caminho de exfiltrar dados da loja para
       * outro servidor, e `object-src 'none'`/`frame-ancestors 'none'` fecham plugin e
       * clickjacking.
       */
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`,
            "'unsafe-eval'", // exigido pelo avaliador de expressões do Alpine
          ],
          // Estilo inline é usado à vontade nas telas (atributos `style=` e blocos
          // <style> por página). Não é vetor de execução de código, e o ganho de fechar
          // aqui não paga o risco de quebrar layout em telas que ninguém revisaria.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'], // fotos em base64 e QR gerados como data:
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Limite maior que o padrão (100kb): fotos de produto viajam como base64 no corpo JSON
  // (ver modules/commercial/routes.ts) — servidor local/Electron, não exposto à internet.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.resolve(__dirname, '..', 'public')));
  app.use('/uploads/products', express.static(productImagesDir()));
  app.use('/uploads/categories', express.static(categoryImagesDir()));
  app.use('/uploads/company', express.static(companyLogoDir()));

  // Envelope de resposta padronizado: { success, data/error } em todas as rotas JSON
  app.use(responseEnvelope);

  // Health check e tela de ativação: alcançáveis mesmo numa instalação ainda não
  // ativada (é o próprio propósito da tela). O gate abaixo bloqueia todo o resto.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'kivo', ts: new Date().toISOString() });
  });
  app.use(activationRoutes);
  app.use(requireActivation);

  app.use(attachUser);
  app.use(filterModuleMenu);
  app.use(logoDaEmpresa);

  // Rotas públicas
  app.use('/api/auth', authRoutes);
  // Resgate de senha: pública pelo mesmo motivo do primeiro acesso — quem esqueceu a senha
  // não tem sessão para autenticar. A guarda é o código que só o suporte gera.
  app.use('/api/recovery', recoveryRoutes);
  app.get('/login', (_req, res) => {
    res.redirect('/?login=1');
  });

  // API do Core (auth + RBAC por rota)
  app.use('/api/users', requireAuth, usersRoutes);
  // Acesso pelo celular (Kivo Web): concessão/revogação por usuário. Fora de `usersRoutes`
  // porque conversa com a nuvem e tem permissão própria (`users.remote.manage`).
  app.use('/api/remote', requireAuth, remoteRoutes);
  app.use('/api/roles', requireAuth, rolesRoutes);
  app.use('/api/audit', requireAuth, auditRoutes);
  app.use('/api/settings', requireAuth, settingsRoutes);
  app.use('/api/backup', requireAuth, backupRoutes);
  app.use('/api/license', requireAuth, licenseRoutes);
  app.use('/api/sync', requireAuth, syncRoutes);
  app.use('/api/billing', requireAuth, billingRoutes);
  app.use('/api/security', requireAuth, securityRoutes);
  app.use('/api/core/capabilities', requireAuth, capabilitiesRoutes);
  app.use('/api/onboarding', requireAuth, onboardingRoutes);
  app.use('/api/support', requireAuth, supportRoutes);
  app.use('/api/updates', requireAuth, updaterRoutes);

  // Páginas do Core
  app.get('/', page('home'));
  app.get('/notificacoes', requireAuth, page('notifications'));
  app.get('/admin/usuarios', requireAuth, page('users', 'users.view'));
  app.get('/admin/cargos', requireAuth, page('roles', 'roles.view'));
  app.get('/admin/auditoria', requireAuth, page('audit', 'audit.view'));
  app.get('/admin/backup', requireAuth, page('backup', 'backup.view'));
  app.get('/admin/configuracoes', requireAuth, page('settings', 'settings.view'));
  app.get('/admin/cobrancas', requireAuth, page('billing', 'billing.view'));
  app.get('/admin/recursos', requireAuth, page('recursos', 'settings.capabilities.edit'));

  // Módulos: API (/api/<id>) e páginas (/app/<id>) exigem autenticação por padrão
  app.use('/api', requireAuth);
  app.use('/app', requireAuth);
  const modules = await loadModules(app);

  // Views dos módulos entram no lookup do EJS; menu dos manifestos vai para as views
  const moduleViews = modules.map((m) => m.viewsDir).filter((v): v is string => !!v);
  app.set('views', [coreViews, ...moduleViews]);
  app.locals.moduleMenu = collectMenu(modules);
  // id → nome legível do módulo, para telas que agrupam por módulo (ex.: Recursos)
  // não precisarem exibir o id cru ('commercial') para o lojista.
  app.locals.moduleNamesJson = JSON.stringify(
    Object.fromEntries(modules.map((m) => [m.manifest.id, m.manifest.name])),
  );

  // Tabelas sincronizáveis do Core
  registerSyncTables('core', [{ table: 'capabilities' }]);


  // Licença (não trava o boot) e backup diário às 23:00
  const lic = validateLicense();
  logLicenca.info(`${lic.status}: ${lic.message}`);
  startBackupScheduler();
  startLicenseRevalidationScheduler();
  // Sync periódico: o painel do Kivo Web lê o que a nuvem tem, então parar de depender do
  // clique manual em "Sincronizar agora" é pré-requisito para o dado no celular ser atual.
  startSyncScheduler();
  // Canal de eventos: encurta de minutos para segundos a confirmação de um orçamento feito
  // no celular. O ciclo acima continua sendo a rede de segurança se o canal cair.
  startEventChannel();
  // Fotos de produto pendentes de envio ao banco de imagens do Cloud (best-effort, não trava o boot).
  trySubmitPending().catch((e) => logCatalogo.error('erro ao enviar fotos pendentes', e));
  // Desafios de resgate vencidos não servem para nada depois; limpa no boot.
  try {
    purgeOldChallenges();
  } catch (e) {
    logRecuperacao.error('falha ao limpar desafios antigos', e);
  }
  startSessionPurgeScheduler();

  // Error handler global (deve ser o ÚLTIMO middleware)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logHttp.error('erro não tratado numa rota', err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  return { app, modules };
}
