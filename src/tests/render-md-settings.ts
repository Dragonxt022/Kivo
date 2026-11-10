// Sanity check: renderiza maisdelivery-settings.ejs nas duas variantes (configured true/false).
import ejs from 'ejs';
import path from 'node:path';

const moduleViews = path.resolve('src/modules/maisdelivery/views');
const globalViews = path.resolve('src/views');

const draft = {
  user: { name: 'Teste', username: 'teste', roleSlug: 'admin', permissions: new Set() },
  cspNonce: 'test-nonce',
  canOrders: true,
  canSettings: true,
  // Helpers do app disponíveis como locals em produção; mocks mínimos para o render direto.
  svgIcon: (name: string) => `<svg data-icon="${name}"></svg>`,
  _navPdv: false,
  empresaLogoUrl: null,
  config: {
    empresaIntegrada: 12,
    restaurante: 50451,
    marketplace: null,
    sandbox: true,
    hasAccessToken: false,
    hasBasicAuth: false,
  },
};

async function render(label: string, configured: boolean): Promise<void> {
  const html: string = await ejs.renderFile(
    path.join(moduleViews, 'maisdelivery-settings.ejs'),
    { ...draft, configured },
    { views: [moduleViews, globalViews], root: moduleViews, async: false, cache: false },
  );
  const checks: Record<string, boolean> = {
    modal: html.includes('md-modal'),
    alpineOk: /const canSettings = true/.test(html) && /const canOrders = true/.test(html),
    fonteEstilo: html.includes('.md-onboard') && html.includes('dialog.md-modal'),
  };
  if (configured) {
    checks.statusList = html.includes('Status da integração');
    checks.statusLabel = html.includes('Access token da sede');
    checks.changeCode = html.includes('Alterar código de integração');
    checks.noOnboardingCta = !html.includes('Integrar agora');
  } else {
    checks.onboardingCta = html.includes('Integrar agora');
    checks.help = html.includes('Como funciona a integração');
  }
  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync('C:/Users/Administrador/AppData/Local/Temp/opencode/render-md-fail.html', html);
    throw new Error(`${label}: faltou ${failed.map(([k]) => k).join(', ')}`);
  }
  console.log(`✓ ${label} (${(html.length / 1024).toFixed(1)} KB)`);
}

async function main(): Promise<void> {
  await render('não-integrada (configured=false)', false);
  await render('integrada (configured=true)', true);
  console.log('Template compila e renderiza OK nas duas variantes.');

  // Dump da variante não-integrada para diagnóstico manual (fora do repositório).
  const { writeFileSync } = await import('node:fs');
  const htmlDump: string = await ejs.renderFile(
    path.join(moduleViews, 'maisdelivery-settings.ejs'),
    { ...draft, configured: false },
    { views: [moduleViews, globalViews], root: moduleViews, async: false, cache: false },
  );
  writeFileSync(
    'C:/Users/Administrador/AppData/Local/Temp/opencode/render-md.html',
    htmlDump,
  );
  console.log('HTML de diagnóstico salvo em C:/Users/Administrador/AppData/Local/Temp/opencode/render-md.html');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
