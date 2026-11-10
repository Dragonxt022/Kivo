// Sanity check: renderiza maisdelivery-orders.ejs nas variantes (sandbox on/off, com/sem gestão).
import ejs from 'ejs';
import path from 'node:path';

const moduleViews = path.resolve('src/modules/maisdelivery/views');
const globalViews = path.resolve('src/views');

const draft = {
  user: { name: 'Teste', username: 'teste', roleSlug: 'admin', permissions: new Set() },
  cspNonce: 'test-nonce',
  // Helpers do app disponíveis como locals em produção; mocks mínimos para o render direto.
  svgIcon: (name: string) => `<svg data-icon="${name}"></svg>`,
  _navPdv: false,
  empresaLogoUrl: null,
};

async function render(label: string, variants: Record<string, unknown>, checks: Record<string, (html: string) => boolean>): Promise<void> {
  const html: string = await ejs.renderFile(
    path.join(moduleViews, 'maisdelivery-orders.ejs'),
    { ...draft, ...variants },
    { views: [moduleViews, globalViews], root: moduleViews, async: false, cache: false },
  );
  const failed = Object.entries(checks).filter(([, check]) => !check(html));
  if (failed.length) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('C:/Users/Administrador/AppData/Local/Temp/opencode/render-md-orders-fail.html', html);
    throw new Error(`${label}: faltou ${failed.map(([k]) => k).join(', ')}`);
  }
  console.log(`✓ ${label} (${(html.length / 1024).toFixed(1)} KB)`);
}

async function main(): Promise<void> {
  const base = {
    configured: true,
    canManage: true,
    canSettings: true,
  };
  await render('sandbox ligado', { ...base, sandbox: true }, {
    botaoTeste: (html) => html.includes('Criar pedido de teste'),
    bannerSandbox: (html) => html.includes('Modo sandbox ligado.'),
    quatroArgs: (html) => /maisdeliveryOrdersPage\(true, true, true, true\)/.test(html),
    tagWarn: (html) => html.includes('md-tag warn'),
  });
  await render('sandbox desligado', { ...base, sandbox: false }, {
    gateBanner: (html) => html.includes('x-show="configured && sandbox"'),
    quatroArgsFalse: (html) => /maisdeliveryOrdersPage\(true, true, true, false\)/.test(html),
  });
  console.log('Template de pedidos compila e renderiza OK.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
