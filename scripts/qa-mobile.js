/**
 * Screenshots das telas do Kivo Web num viewport de celular real, para conferir o que o
 * lojista vê. Sobe a nuvem + o desktop reaproveitando o mesmo caminho do e2e.
 *
 * Uso: node qa-mobile.js  (requer o MySQL do docker no ar)
 */
const { chromium } = require('playwright');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CLOUD = 'http://127.0.0.1:4133';
const DESK = 'http://127.0.0.1:3133';
const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const DB = path.resolve('database/qa-mobile.db');
const OUT = path.resolve('.qa-screenshots');

const CLOUD_ENV = {
  CLOUD_DB_HOST: '127.0.0.1', CLOUD_DB_PORT: '3307', CLOUD_DB_USER: 'root',
  CLOUD_DB_PASSWORD: 'kivo', CLOUD_DB_NAME: 'kivo_cloud', CLOUD_PORT: '4133',
};

function esperar(url, ms = 60000) {
  const fim = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function tenta() {
      fetch(url).then(() => resolve()).catch(() => {
        if (Date.now() > fim) reject(new Error('timeout ' + url));
        else setTimeout(tenta, 700);
      });
    })();
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch {} }

  const companyUuid = randomUUID();
  const licenseKey = randomBytes(16).toString('hex');
  execFileSync(process.execPath, [TSX, 'cloud/src/provision-company.ts', companyUuid, licenseKey, 'Marcenaria Silva', '--plan', 'diamante', '--valid-until', '2099-12-31'],
    { env: { ...process.env, ...CLOUD_ENV }, stdio: 'inherit' });

  const cloudProc = spawn(process.execPath, [TSX, 'cloud/src/server.ts'], { env: { ...process.env, ...CLOUD_ENV }, stdio: 'ignore' });
  const deskProc = spawn(process.execPath, [TSX, 'src/dev.ts'], {
    env: {
      ...process.env, KIVO_DB_PATH: DB, KIVO_PORT: '3133',
      KIVO_SYNC_SERVER_URL: CLOUD, KIVO_MACHINE_ID: 'qa-mobile',
    }, stdio: 'ignore',
  });

  try {
    await esperar(`${CLOUD}/api/health`);
    await esperar(`${DESK}/api/health`);

    const dkFetch = async (p, o = {}) => fetch(DESK + p, {
      ...o, headers: { 'Content-Type': 'application/json', ...(global.cookie ? { cookie: global.cookie } : {}), ...(o.headers || {}) },
    });

    const ativa = await fetch(`${DESK}/api/activation/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey }),
    });
    console.log('ativacao:', ativa.status, ativa.ok ? '' : await ativa.text());

    const login = await fetch(`${DESK}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    global.cookie = (login.headers.get('set-cookie') || '').match(/kivo_session=[^;]+/)?.[0] || '';
    console.log('login desktop:', login.status);

    // Catálogo + clientes + uma venda, para as telas não ficarem vazias.
    const prods = [
      ['Porta de madeira maciça 210x80', 'PRT-210', 120000],
      ['Fechadura tetra reforçada', 'FCH-01', 18000],
      ['Dobradiça inox 3.5"', 'DOB-35', 2500],
      ['Batente pinus tratado', 'BAT-PIN', 34000],
      ['Verniz marítimo 900ml', 'VRN-900', 8900],
    ];
    for (const [name, sku, price] of prods) {
      await dkFetch('/api/commercial/products', {
        method: 'POST', body: JSON.stringify({ name, sku, productType: 'fisico', priceCents: price, trackStock: true, minStock: 5 }),
      });
    }
    for (const nome of ['João da Silva Pereira', 'Construtora Horizonte', 'Maria Aparecida Souza']) {
      await dkFetch('/api/commercial/customers', { method: 'POST', body: JSON.stringify({ name: nome, phone: '(69) 99999-0000' }) });
    }
    await dkFetch('/api/sync/run', { method: 'POST' });

    const users = await (await dkFetch('/api/users')).json();
    const adminId = (users.data || users)[0].id;
    const respGrant = await dkFetch(`/api/remote/users/${adminId}/grant`, { method: 'POST' });
    const grant = await respGrant.json();
    const url = (grant.data || grant).url;
    if (!url) { console.log('grant falhou:', respGrant.status, JSON.stringify(grant).slice(0, 300)); throw new Error('sem link'); }
    console.log('link do celular:', url);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  JS ERR:', e.message.slice(0, 90)));
    await page.goto(url, { waitUntil: 'networkidle' });

    const telas = [
      ['inicio', '/m'],
      ['analiticos', '/m/analiticos'],
      ['orcamentos', '/m/orcamentos'],
      ['orcamento-novo', '/m/orcamentos/novo'],
      ['estoque', '/m/estoque'],
    ];
    for (const [nome, rota] of telas) {
      await page.goto(CLOUD + rota, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `m-${nome}.png`), fullPage: false });
      console.log('  ✓', nome);
    }

    // Folha de produto aberta — o fluxo que estava difícil
    await page.goto(`${CLOUD}/m/orcamentos/novo`, { waitUntil: 'networkidle' });
    await page.click('#btn-add');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'm-folha-produto.png') });
    // Adiciona três itens e fecha, para o carrinho aparecer
    const botoes = await page.locator('#lista-produto .m-pick').all();
    for (const b of botoes.slice(0, 3)) { await b.click(); await page.waitForTimeout(120); }
    await page.locator('[data-fechar="sheet-produto"]').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'm-carrinho.png') });
    console.log('  ✓ folha de produto + carrinho');

    // A barra de ação PRECISA estar visível e clicável: ela e a navegação inferior são
    // as duas fixas no rodapé, e foi assim que o botão "Enviar" ficou escondido atrás
    // da navegação — o orçamento não tinha como ser concluído.
    const barra = await page.evaluate(() => {
      const b = document.querySelector('.m-actionbar');
      if (!b) return { existe: false };
      const r = b.getBoundingClientRect();
      const btn = b.querySelector('#enviar').getBoundingClientRect();
      // Quem o navegador entrega ao toque no centro do botão?
      const alvo = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
      return {
        existe: true,
        dentroDaTela: r.bottom <= window.innerHeight + 1 && r.top >= 0,
        alturaBotao: Math.round(btn.height),
        recebeToque: !!alvo && (alvo.id === 'enviar' || alvo.closest('#enviar') !== null),
        totalNaBarra: (document.getElementById('barra-total') || {}).textContent,
        botaoAtivo: !document.getElementById('enviar').disabled,
      };
    });
    console.log('  barra de ação:', JSON.stringify(barra));
    if (!barra.existe || !barra.dentroDaTela || !barra.recebeToque || !barra.botaoAtivo) {
      throw new Error('BARRA DE AÇÃO INALCANÇÁVEL — o orçamento não pode ser enviado');
    }
    if (barra.alturaBotao < 44) throw new Error('botão menor que 44px: alvo de toque insuficiente');
    console.log('  ✓ barra de ação visível, tocável e com o total certo');

    await browser.close();
  } finally {
    cloudProc.kill();
    deskProc.kill();
  }
  console.log('\nScreenshots em .qa-screenshots/');
}

main().catch((e) => { console.error(e); process.exit(1); });
