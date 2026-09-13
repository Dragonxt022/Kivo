/**
 * Infraestrutura compartilhada dos testes E2E de frontend (Playwright).
 *
 * Antes disto cada arquivo de `src/tests/e2e/` repetia setup de banco, login, `check()`,
 * screenshot e teardown. Aqui isso mora num lugar só, para um QA novo ser: subir o servidor,
 * abrir o navegador e descrever o fluxo.
 *
 * Continua usando o Playwright como BIBLIOTECA (não `@playwright/test`), na mesma linha do
 * resto do projeto: testes sem framework, saída PASS/FAIL e código de saída 0/1.
 *
 * Uso típico:
 *   const reporter = new Reporter('PDV');
 *   const { server, base } = await setupServer({ port: 3602 });
 *   const admin = await loginApi(base, 'admin', 'admin');
 *   const browser = await openBrowser();
 *   const page = await newPage(browser);
 *   await loginUi(page, base);
 *   reporter.check('...', true);
 *   await teardown(server, browser);
 *   reporter.finish();
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { migrateUp } from '../../core/database/migrator';
import { runSeeds } from '../../core/database/seeds';
import { getSqlite, closeDb } from '../../core/database/connection';
import { createServer } from '../../core/server';
import { settingsRepository } from '../../core/repositories/SettingsRepository';
import { resetTestDb, activateTestLicense, exitFirstRunState } from '../resetTestDb';

export const DEFAULT_USER = 'admin';
export const DEFAULT_PASS = 'admin';

/** Contador de PASS/FAIL compartilhado; cada arquivo cria o seu. */
export class Reporter {
  private failures = 0;
  private checks = 0;

  constructor(private readonly title: string) {}

  check(label: string, ok: boolean, extra = ''): void {
    this.checks++;
    if (!ok) this.failures++;
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  }

  section(name: string): void {
    console.log(`\n── ${name} ──`);
  }

  /** Encerra o processo com código 0 (verde) ou 1 (falhou). */
  finish(): never {
    const resumo =
      this.failures === 0
        ? `✓ ${this.title}: TODOS OS TESTES PASSARAM (${this.checks} checks)`
        : `✗ ${this.title}: ${this.failures} falha(s) em ${this.checks} checks`;
    console.log(`\n${resumo}`);
    process.exit(this.failures === 0 ? 0 : 1);
  }
}

export interface CapabilitySpec {
  key: string;
  module: string;
  description?: string;
}

export interface SetupOptions {
  port: number;
  /** Capabilities ligadas antes do servidor subir (kits, mesas, etc.). */
  capabilities?: CapabilitySpec[];
  /**
   * Quando true, mantém o estado de PRIMEIRO ACESSO (um único usuário admin/admin) para
   * exercitar a tela "Crie seu acesso". O padrão é sair dele, como as demais suítes.
   */
  firstRun?: boolean;
  /** Marca o assistente de boas-vindas como concluído para ele não abrir modal. Padrão true. */
  skipOnboarding?: boolean;
}

export interface E2EServer {
  server: Server;
  base: string;
}

/** Prepara banco descartável, seeds, licença e sobe o Express — sem Electron. */
export async function setupServer(opts: SetupOptions): Promise<E2EServer> {
  resetTestDb();
  migrateUp();
  runSeeds();
  activateTestLicense();
  if (!opts.firstRun) exitFirstRunState();

  const db = getSqlite();
  for (const cap of opts.capabilities ?? []) {
    const existing = db.prepare('SELECT id FROM capabilities WHERE key = ?').get(cap.key) as
      | { id: number }
      | undefined;
    if (existing) {
      db.prepare('UPDATE capabilities SET enabled = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare(
        'INSERT INTO capabilities (key, description, module, enabled, uuid) VALUES (?, ?, ?, 1, ?)',
      ).run(cap.key, cap.description ?? cap.key, cap.module, randomUUID());
    }
  }

  if (opts.skipOnboarding !== false) settingsRepository.set('onboarding.completed', '1');

  const { app } = await createServer();
  const base = `http://127.0.0.1:${opts.port}`;
  const server = app.listen(opts.port);
  console.log(`[e2e] Servidor em ${base}`);
  return { server, base };
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers (para preparar dados e conferir o resultado depois da UI)
// ─────────────────────────────────────────────────────────────────────────────

export function api(base: string, route: string, opts: RequestInit = {}, cookie?: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

/** Login via API; devolve o cookie de sessão ou null se as credenciais falharem. */
export async function loginApi(
  base: string,
  user = DEFAULT_USER,
  pass = DEFAULT_PASS,
): Promise<string | null> {
  const r = await api(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!r.ok) return null;
  const m = (r.headers.get('set-cookie') ?? '').match(/kivo_session=([^;]+)/);
  return m ? `kivo_session=${m[1]}` : null;
}

/** Desembrulha o envelope { success, data } — mesma ideia do testUtils dos testes de API. */
export async function unwrap<T>(r: Response): Promise<T> {
  const body: unknown = await r.json();
  if (body && typeof body === 'object' && 'success' in body) {
    const env = body as { success: boolean; data?: T; error?: string };
    if (env.success) return env.data as T;
    throw new Error(env.error ?? 'API error');
  }
  return body as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navegador
// ─────────────────────────────────────────────────────────────────────────────

export async function openBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/**
 * Cria um contexto já com os avisos de primeira visita desligados.
 *
 * Sem isto, três overlays atrapalham os testes: o tour guiado do PDV (`kivo-tour-pdv-v1`),
 * o aviso de novidade (`kivo-novidade-seen`) e a preferência de interface. O tour em
 * especial cobre a tela inteira com `kivo-tour-capture` e intercepta TODO clique — foi
 * exatamente o que quebrou o E2E de comandas quando o tour entrou em produção.
 */
export async function newContext(
  browser: Browser,
  opts: { mobile?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext(
    opts.mobile
      ? {
          viewport: opts.viewport ?? { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
        }
      : { viewport: opts.viewport ?? { width: 1400, height: 900 } },
  );
  await context.addInitScript(() => {
    try {
      localStorage.setItem('kivo-tour-pdv-v1', '1');
      localStorage.setItem('kivo-novidade-seen', 'web-v1');
      localStorage.setItem('kivo-interface', 'cards');
    } catch {
      // localStorage indisponível (about:blank): sem consequência.
    }
  });
  return context;
}

export async function newPage(
  browser: Browser,
  opts: { mobile?: boolean; viewport?: { width: number; height: number } } = {},
): Promise<Page> {
  const context = await newContext(browser, opts);
  return context.newPage();
}

/** Login pela UI real (exercita o formulário, não só a API). */
export async function loginUi(
  page: Page,
  base: string,
  user = DEFAULT_USER,
  pass = DEFAULT_PASS,
): Promise<void> {
  await page.goto(`${base}/?login=1`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForSelector('#login-user', { state: 'visible', timeout: 8000 });
  await page.fill('#login-user', user);
  await page.fill('#login-pass', pass);
  await Promise.all([
    page.waitForURL(`${base}/`, { waitUntil: 'load', timeout: 20000 }),
    page.click('.login-card button[type="submit"]'),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshots
// ─────────────────────────────────────────────────────────────────────────────

let snapCounter = 0;

export function snapDir(name: string): string {
  const dir = path.resolve(process.cwd(), '.qa-screenshots', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function snap(page: Page, dir: string, label: string): Promise<void> {
  snapCounter++;
  const name = `${String(snapCounter).padStart(3, '0')}_${label
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60)}.png`;
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

/** Fecha navegador + servidor e solta o SQLite. Nunca lança. */
export async function teardown(server: Server, browser?: Browser): Promise<void> {
  if (browser) await browser.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
}
