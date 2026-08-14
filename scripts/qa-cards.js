/**
 * QA de layout — detecta texto CORTADO nos cards da home, em várias resoluções.
 *
 * Uso:  node scripts/qa-cards.js        (requer `npm run dev` rodando)
 * Sai com código 1 se algum card cortar texto.
 *
 * Por que existe: nenhum teste da suíte pega isso. A resposta HTTP é 200, o HTML está
 * correto e o servidor não reclama — o defeito só acontece na hora que o navegador
 * calcula o layout. Foi assim que a compactação para telas baixas passou a fatiar a
 * descrição dos cards no meio da palavra sem nada acusar.
 *
 * A checagem distingue dois casos que parecem iguais e não são:
 *   - `-webkit-line-clamp` truncando texto longo: INTENCIONAL, corta na linha com
 *     reticências;
 *   - caixa de texto encolhida pelo flex abaixo das linhas que ela reservou: DEFEITO,
 *     corta na horizontal no meio das letras e sem reticências.
 * Comparar `scrollHeight` com `clientHeight` confunde os dois — ver o comentário na
 * checagem (b) mais abaixo.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3123';
const CASOS = [
  { nome: '1920x1080          ', width: 1920, height: 1080, zoom: 1 },
  { nome: '1600x900           ', width: 1600, height: 900, zoom: 1 },
  { nome: '1366x768           ', width: 1366, height: 768, zoom: 1 },
  { nome: '1280x720           ', width: 1280, height: 720, zoom: 1 },
  { nome: '1024x768           ', width: 1024, height: 768, zoom: 1 },
  // Windows a 125%/150% encolhe o viewport CSS na mesma proporção — é o cenário mais
  // comum em notebook de loja, e o que mais aperta o card.
  { nome: '1366x768 @125% Win ', width: 1093, height: 614, zoom: 1 },
  { nome: '1920x1080 @150% Win', width: 1280, height: 720, zoom: 1 },
];

async function autenticar(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?login=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (await page.locator('#setup-user').count()) {
    await page.fill('#setup-name', 'QA');
    await page.fill('#setup-user', 'qaadmin');
    await page.fill('#setup-pass', 'Kivo@2026');
    await page.fill('#setup-pass2', 'Kivo@2026');
    await page.click('.login-card button[type="submit"]');
  } else {
    await page.fill('#login-user', 'qaadmin');
    await page.fill('#login-pass', 'Kivo@2026');
    await page.click('.login-card button[type="submit"]');
  }
  await page.waitForTimeout(2200);
  const estado = await ctx.storageState();
  await ctx.close();
  if (!estado.cookies.some((c) => c.name === 'kivo_session')) throw new Error('login não completou');
  return estado;
}

async function main() {
  const browser = await chromium.launch();
  const estado = await autenticar(browser);
  let problemas = 0;

  for (const c of CASOS) {
    const ctx = await browser.newContext({
      viewport: { width: c.width, height: c.height },
      storageState: estado,
    });
    await ctx.addInitScript(() => localStorage.setItem('kivo-interface', 'cards'));
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const r = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.app-grid .app-card')]
        .filter((el) => el.getBoundingClientRect().width > 0 && el.querySelector('.card-title'));
      const cortados = [];
      for (const card of cards) {
        const cs = getComputedStyle(card);
        const box = card.getBoundingClientRect();
        const topo = box.top + parseFloat(cs.paddingTop);
        const base = box.bottom - parseFloat(cs.paddingBottom);
        for (const filho of card.children) {
          const f = filho.getBoundingClientRect();
          // (a) o elemento estourou a caixa de conteúdo do card…
          const estourou = f.height > 0 && (f.bottom > base + 1 || f.top < topo - 1);
          // (b) …ou o TEXTO foi FATIADO. Aqui está a distinção que importa:
          //
          //     `-webkit-line-clamp: 2` truncar um texto longo é INTENCIONAL — corta na
          //     linha certa e põe reticências. Nesse caso `scrollHeight` continua
          //     reportando o texto inteiro, então comparar scrollHeight com clientHeight
          //     acusaria todo card com descrição longa (falso positivo).
          //
          //     O defeito de verdade é a caixa ficar MENOR que as linhas que ela mesma
          //     reservou — aí a última linha é cortada na horizontal, no meio das letras,
          //     e sem reticências. Logo: comparo a altura real com a altura ESPERADA
          //     (nº de linhas permitidas × line-height), não com o conteúdo todo.
          const est = getComputedStyle(filho);
          const lh = parseFloat(est.lineHeight) || parseFloat(est.fontSize) * 1.2;
          const clamp = parseInt(est.webkitLineClamp, 10);
          const linhasPermitidas = Number.isFinite(clamp) && clamp > 0
            ? clamp
            : est.whiteSpace === 'nowrap' ? 1 : Math.round(filho.scrollHeight / lh);
          const esperado = Math.min(filho.scrollHeight, linhasPermitidas * lh);
          const textoCortado = filho.clientHeight + 1 < esperado;
          if (estourou || textoCortado) {
            cortados.push({
              card: (card.querySelector('.card-title') || {}).textContent?.trim() ?? '?',
              elemento: filho.className || filho.tagName,
              motivo: textoCortado ? 'texto fatiado' : 'estourou o card',
              sobra: textoCortado
                ? Math.round(esperado - filho.clientHeight)
                : Math.round(Math.max(f.bottom - base, topo - f.top)),
            });
            break;
          }
        }
      }
      const primeiro = cards[0]?.getBoundingClientRect();
      return {
        total: cards.length,
        cortados,
        cardW: primeiro ? Math.round(primeiro.width) : 0,
        cardH: primeiro ? Math.round(primeiro.height) : 0,
        colunas: getComputedStyle(document.querySelector('.app-grid')).gridTemplateColumns.split(' ').length,
        visiveis: cards.filter((el) => {
          const b = el.getBoundingClientRect();
          return b.top >= 0 && b.bottom <= window.innerHeight;
        }).length,
      };
    });

    const status = r.cortados.length
      ? `✗ ${r.cortados.length} card(s) com texto cortado — ex.: "${r.cortados[0].card}" (${r.cortados[0].motivo}, ${r.cortados[0].sobra}px)`
      : '✓ nenhum texto cortado';
    console.log(
      `${c.nome} card ${String(r.cardW).padStart(3)}x${String(r.cardH).padStart(3)} | ${r.colunas} col | ` +
      `${String(r.visiveis).padStart(2)} visíveis | ${status}`,
    );
    problemas += r.cortados.length;
    await ctx.close();
  }

  await browser.close();
  console.log(problemas === 0 ? '\nOK — nenhum card corta texto em nenhuma resolução testada.' : `\n${problemas} ocorrência(s).`);
  process.exit(problemas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
