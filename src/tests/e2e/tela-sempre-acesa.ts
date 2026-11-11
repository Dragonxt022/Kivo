/**
 * QA E2E (Playwright) — Tela sempre acesa nos painéis.
 *
 * O que protege: no tablet/celular ligado pela rede local o Kuruk abre por
 * `http://192.168...` (contexto inseguro), onde a Screen Wake Lock API não existe. Sem o
 * fallback de vídeo mudo em loop, a tela apagava no tempo máximo do Android e o som do
 * pedido novo parava junto.
 *
 * Este teste confere que Cozinha e Mesas:
 *  - carregam o /js/keep-awake.js e ligam a proteção por padrão;
 *  - têm o botão de ligar/desligar refletindo o estado;
 *  - guardam a escolha no aparelho (localStorage) e sobrevivem ao recarregar.
 *
 * Uso:
 *   node scripts/test-isolated.js src/tests/e2e/tela-sempre-acesa.ts
 */
import {
  Reporter,
  setupServer,
  openBrowser,
  newPage,
  loginUi,
  teardown,
  type E2EServer,
} from './harness';

const PORT = Number(process.env.KURUK_PORT ?? 3616);

interface KeepAwakeState {
  hasApi: boolean;
  enabled: boolean;
  active: boolean;
  method: string;
  videos: number;
  button: boolean;
}

async function main(): Promise<void> {
  const reporter = new Reporter('Tela sempre acesa');
  let server: E2EServer | undefined;

  try {
    server = await setupServer({
      port: PORT,
      capabilities: [
        { key: 'comandas.mesas', module: 'comandas' },
        { key: 'foodservice.cozinha', module: 'foodservice' },
      ],
    });
    const browser = await openBrowser();
    const page = await newPage(browser);
    await loginUi(page, server.base);

    const state = (): Promise<KeepAwakeState> => page.evaluate(() => {
      const api = (window as unknown as {
        KurukKeepAwake?: { isEnabled(): boolean; isActive(): boolean; method(): string };
      }).KurukKeepAwake;
      return {
        hasApi: !!api,
        enabled: !!api && api.isEnabled(),
        active: !!api && api.isActive(),
        method: api ? api.method() : 'none',
        videos: document.querySelectorAll('video').length,
        button: !!Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').includes('Tela acesa') || (b.textContent || '').includes('Tela apaga')),
      };
    });

    // ── Cozinha ───────────────────────────────────────────────────────────
    await page.goto(`${server.base}/app/foodservice/cozinha`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const api = (window as unknown as { KurukKeepAwake?: { isActive(): boolean } }).KurukKeepAwake;
      return !!api && api.isActive();
    }, undefined, { timeout: 10000 }).catch(() => {});

    const kds = await state();
    reporter.check('cozinha carrega o keep-awake', kds.hasApi);
    reporter.check('cozinha liga por padrão', kds.enabled);
    reporter.check('cozinha mantém a tela ativa', kds.active, kds.method);
    reporter.check('cozinha usa Wake Lock ou vídeo de fallback', ['wake-lock', 'video'].includes(kds.method), kds.method);
    reporter.check('cozinha tem o botão de tela', kds.button);

    // O navegador pausa o vídeo com a aba em segundo plano. Ao voltar, o Kuruk tem de
    // perceber e pedir de novo — foi o caso que deixava a tela apagar depois de um tempo.
    if (kds.method === 'video') {
      await page.evaluate(() => document.querySelector('video')?.pause());
      await page.waitForTimeout(300);
      reporter.check('pausa do navegador derruba o estado', !(await state()).active);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(700);
      reporter.check('voltar para a tela retoma a proteção', (await state()).active);
    }

    // Desliga: a preferência fica no aparelho e o botão reflete na hora.
    await page.locator('button', { hasText: 'Tela acesa' }).click();
    await page.waitForTimeout(300);
    const off = await state();
    reporter.check('desligar solta a proteção', !off.enabled && !off.active, `${off.enabled}/${off.active}`);
    reporter.check(
      'preferência gravada no aparelho',
      await page.evaluate(() => localStorage.getItem('kuruk:keep-awake')) === '0',
    );
    reporter.check('botão passa a "Tela apaga"', (await page.locator('button', { hasText: 'Tela apaga' }).count()) > 0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    const afterReload = await state();
    reporter.check('preferência sobrevive ao recarregar', !afterReload.enabled && !afterReload.active);

    // Religa para o teste das mesas herdar o padrão.
    await page.locator('button', { hasText: 'Tela apaga' }).click();
    await page.waitForTimeout(500);
    reporter.check('religar volta a proteger a tela', (await state()).active);

    // ── Mesas ─────────────────────────────────────────────────────────────
    await page.goto(`${server.base}/app/comandas/mesas`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const api = (window as unknown as { KurukKeepAwake?: { isActive(): boolean } }).KurukKeepAwake;
      return !!api && api.isActive();
    }, undefined, { timeout: 10000 }).catch(() => {});
    const mesas = await state();
    reporter.check('mesas carrega o keep-awake', mesas.hasApi);
    reporter.check('mesas mantém a tela ativa', mesas.active, mesas.method);
    reporter.check(
      'mesas tem o botão marcado',
      (await page.locator('.mesas-tela-btn[aria-pressed="true"]').count()) > 0,
    );

    // ── Só os painéis recebem o script ────────────────────────────────────
    await page.goto(`${server.base}/app/store/vendas`, { waitUntil: 'domcontentloaded' });
    const other = await page.evaluate(() => 'KurukKeepAwake' in window);
    reporter.check('outras telas não carregam o keep-awake', !other);

    await teardown(server.server, browser);
  } catch (e) {
    console.error('[e2e-tela-sempre-acesa] erro fatal:', e);
    reporter.check('execução sem exceção', false, (e as Error).message);
  }

  reporter.finish();
}

void main();
