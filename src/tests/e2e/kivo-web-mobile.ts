/**
 * QA E2E (Playwright) — Kivo Web no celular.
 *
 * Sobe a nuvem (MySQL) + o desktop, concede acesso remoto pelo painel e abre o link no
 * viewport de um celular real. Confere que cada tela do Kivo Web carrega sem erro de JS e
 * que a barra de ação do orçamento é alcançável e tocável — o defeito que já deixou o botão
 * "Enviar" escondido atrás da navegação inferior.
 *
 * Requer o MySQL do docker-compose no ar (mesma dependência de fase6a/kivo-web-e2e):
 *   docker compose -f cloud/docker-compose.yml up -d
 *   npm run kivo cloud:migrate
 *   node scripts/test-isolated.js src/tests/e2e/kivo-web-mobile.ts
 *
 * Sem o MySQL acessível o teste sai como SKIP (código 0), para a suíte não ficar vermelha
 * numa máquina sem Docker.
 */
import { chromium } from 'playwright';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Reporter, snapDir, snap, unwrap } from './harness';

const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const CLOUD_PORT = Number(process.env.KIVO_WEB_CLOUD_PORT ?? 4134);
const DESK_PORT = Number(process.env.KIVO_WEB_DESK_PORT ?? 3134);
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}`;
const DESK = `http://127.0.0.1:${DESK_PORT}`;
const DB = path.resolve('database', 'qa-mobile.db');
const SHOTS = snapDir('e2e-kivo-web-mobile');

const CLOUD_ENV: Record<string, string> = {
  CLOUD_DB_HOST: process.env.CLOUD_DB_HOST ?? '127.0.0.1',
  CLOUD_DB_PORT: process.env.CLOUD_DB_PORT ?? '3307',
  CLOUD_DB_USER: process.env.CLOUD_DB_USER ?? 'root',
  CLOUD_DB_PASSWORD: process.env.CLOUD_DB_PASSWORD ?? 'kivo',
  CLOUD_DB_NAME: process.env.CLOUD_DB_NAME ?? 'kivo_cloud',
  CLOUD_PORT: String(CLOUD_PORT),
};

/** TCP connect curto: só queremos saber se há MySQL escutando. */
function mysqlReachable(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(Number(CLOUD_ENV.CLOUD_DB_PORT), CLOUD_ENV.CLOUD_DB_HOST);
  });
}

function waitForHealth(url: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () =>
      fetch(url)
        .then((r) => (r.ok ? resolve() : retry()))
        .catch(retry);
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error(`timeout aguardando ${url}`));
      else setTimeout(tryOnce, 700);
    };
    tryOnce();
  });
}

async function main(): Promise<void> {
  const reporter = new Reporter('Kivo Web (mobile)');

  if (!(await mysqlReachable())) {
    console.log(
      `\nSKIP  Kivo Web (mobile) — MySQL não acessível em ${CLOUD_ENV.CLOUD_DB_HOST}:${CLOUD_ENV.CLOUD_DB_PORT}.`,
    );
    console.log('      docker compose -f cloud/docker-compose.yml up -d && npm run kivo cloud:migrate');
    process.exit(0);
  }

  let cloudProc: ChildProcess | undefined;
  let deskProc: ChildProcess | undefined;
  const browser = await chromium.launch({ headless: true });

  try {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(DB + ext);
      } catch {
        // arquivo ainda não existe: ok
      }
    }

    const companyUuid = randomUUID();
    const licenseKey = randomBytes(16).toString('hex');
    execFileSync(
      process.execPath,
      [
        TSX,
        'cloud/src/provision-company.ts',
        companyUuid,
        licenseKey,
        'Loja QA Mobile',
        '--plan',
        'diamante',
        '--valid-until',
        '2099-12-31',
      ],
      { env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit' },
    );

    cloudProc = spawn(process.execPath, [TSX, 'cloud/src/server.ts'], {
      env: { ...process.env, ...CLOUD_ENV },
      stdio: 'ignore',
    });
    deskProc = spawn(process.execPath, [TSX, 'src/dev.ts'], {
      env: {
        ...process.env,
        KIVO_DB_PATH: DB,
        KIVO_PORT: String(DESK_PORT),
        KIVO_SYNC_SERVER_URL: CLOUD,
        KIVO_MACHINE_ID: 'qa-mobile-e2e',
      },
      stdio: 'ignore',
    });

    await waitForHealth(`${CLOUD}/api/health`);
    await waitForHealth(`${DESK}/api/health`);
    reporter.check('nuvem e desktop no ar', true);

    const ativa = await fetch(`${DESK}/api/activation/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey }),
    });
    reporter.check('desktop ativado pela licença da nuvem', ativa.ok, String(ativa.status));

    const login = await fetch(`${DESK}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').match(/kivo_session=[^;]+/)?.[0] ?? '';
    reporter.check('login admin no desktop', login.ok && cookie.length > 0);

    const dk = (route: string, opts: RequestInit = {}) =>
      fetch(DESK + route, {
        ...opts,
        headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers ?? {}) },
      });

    // Catálogo + clientes + um sync, para as telas do celular não ficarem vazias.
    const produtos: [string, string, number][] = [
      ['Porta de madeira maciça', 'PRT-210', 120000],
      ['Fechadura tetra reforçada', 'FCH-01', 18000],
      ['Dobradiça inox 3.5', 'DOB-35', 2500],
    ];
    for (const [name, sku, priceCents] of produtos) {
      await dk('/api/commercial/products', {
        method: 'POST',
        body: JSON.stringify({ name, sku, productType: 'fisico', priceCents, trackStock: true, minStock: 5 }),
      });
    }
    for (const nome of ['João da Silva Pereira', 'Construtora Horizonte']) {
      await dk('/api/commercial/customers', {
        method: 'POST',
        body: JSON.stringify({ name: nome, phone: '(69) 99999-0000' }),
      });
    }
    const sync = await dk('/api/sync/run', { method: 'POST' });
    reporter.check('sync enviou o catálogo para a nuvem', sync.ok, String(sync.status));

    const users = await unwrap<{ id: number }[]>(await dk('/api/users'));
    const adminId = users[0].id;
    const respGrant = await dk(`/api/remote/users/${adminId}/grant`, { method: 'POST' });
    const grantBody = (await respGrant.json()) as { url?: string; data?: { url?: string } };
    const url = grantBody.data?.url ?? grantBody.url;
    reporter.check('acesso remoto concedido (link do QR)', !!url);
    if (!url) throw new Error('sem link de acesso remoto');

    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // O link do QR autentica e some da URL.
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    reporter.check('link do QR autentica o celular', page.url().startsWith(CLOUD), page.url());
    reporter.check('token do QR não fica na URL', !page.url().includes('token'), page.url());
    await snap(page, SHOTS, 'entrada-mobile');

    reporter.section('Telas do Kivo Web');
    const telas: [string, string][] = [
      ['inicio', '/m'],
      ['analiticos', '/m/analiticos'],
      ['orcamentos', '/m/orcamentos'],
      ['orcamento-novo', '/m/orcamentos/novo'],
      ['estoque', '/m/estoque'],
    ];
    for (const [nome, rota] of telas) {
      const resposta = await page.goto(CLOUD + rota, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(300);
      const corpo = (await page.locator('body').innerText()).trim();
      reporter.check(
        `tela "${nome}" carrega com conteúdo`,
        (resposta?.status() ?? 0) < 400 && corpo.length > 20,
        `status=${resposta?.status()} len=${corpo.length}`,
      );
      await snap(page, SHOTS, `tela-${nome}`);
    }

    reporter.section('Orçamento no celular');
    await page.goto(`${CLOUD}/m/orcamentos/novo`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.click('#btn-add');
    await page.waitForTimeout(400);
    reporter.check('folha de produto abre', await page.locator('#lista-produto').isVisible());
    await snap(page, SHOTS, 'folha-produto');

    const picks = await page.locator('#lista-produto .m-pick').all();
    reporter.check('lista tem produtos para escolher', picks.length > 0, `${picks.length}`);
    for (const b of picks.slice(0, 3)) {
      await b.click();
      await page.waitForTimeout(120);
    }
    await page.locator('[data-fechar="sheet-produto"]').click();
    await page.waitForTimeout(400);
    reporter.check('carrinho mostra os itens escolhidos', (await page.locator('#barra-total').innerText()).trim().length > 0);
    await snap(page, SHOTS, 'carrinho');

    const barra = await page.evaluate(() => {
      // `globalThis` em vez de `document`/`window` diretos: o tsconfig do projeto não traz
      // a lib DOM (o código de produção roda no Node), e este callback roda no navegador.
      const g = globalThis as unknown as {
        document: {
          querySelector(sel: string): { getBoundingClientRect(): { bottom: number; top: number } } | null;
          getElementById(id: string): { textContent: string | null; disabled?: boolean } | null;
          elementFromPoint(x: number, y: number): { id: string; closest(sel: string): unknown } | null;
        };
        innerHeight: number;
      };
      const b = g.document.querySelector('.m-actionbar');
      if (!b) return { existe: false } as const;
      const r = b.getBoundingClientRect();
      const btnEl = g.document.querySelector('.m-actionbar #enviar') as unknown as {
        getBoundingClientRect(): { left: number; top: number; width: number; height: number };
        disabled: boolean;
      };
      const box = btnEl.getBoundingClientRect();
      const alvo = g.document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        existe: true,
        dentroDaTela: r.bottom <= g.innerHeight + 1 && r.top >= 0,
        alturaBotao: Math.round(box.height),
        recebeToque: !!alvo && (alvo.id === 'enviar' || alvo.closest('#enviar') !== null),
        totalNaBarra: g.document.getElementById('barra-total')?.textContent ?? '',
        botaoAtivo: !btnEl.disabled,
      };
    });
    reporter.check('barra de ação existe', barra.existe);
    reporter.check('barra de ação dentro da tela', 'dentroDaTela' in barra && barra.dentroDaTela === true);
    reporter.check('botão Enviar recebe o toque (não está atrás da navegação)', 'recebeToque' in barra && barra.recebeToque === true);
    reporter.check('botão Enviar habilitado com o carrinho', 'botaoAtivo' in barra && barra.botaoAtivo === true);
    reporter.check('alvo de toque com pelo menos 44px', 'alturaBotao' in barra && (barra.alturaBotao ?? 0) >= 44, `${'alturaBotao' in barra ? barra.alturaBotao : '?'}px`);

    reporter.check('nenhum erro de JS nas telas do celular', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } catch (e) {
    console.error('[e2e-kivo-web-mobile] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  } finally {
    await browser.close().catch(() => {});
    cloudProc?.kill();
    deskProc?.kill();
  }

  reporter.finish();
}

void main();
