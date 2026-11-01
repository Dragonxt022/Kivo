const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let subResponse = null;
  page.on('response', async (r) => {
    if (r.url().includes('/api/billing/subscription') && r.request().method() === 'GET') {
      const body = await r.text().catch(() => '(sem corpo)');
      subResponse = { status: r.status(), url: r.url(), body: body.slice(0, 1200) };
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto('http://localhost:3123/?login=1', { waitUntil: 'load' });
  await page.evaluate(async () => {
    await fetch('/api/auth/quick-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 1 }) });
  });
  await page.goto('http://localhost:3123/admin/cobrancas', { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  const state = await page.evaluate(() => {
    const el = document.querySelector('main');
    const d = el && el._x_dataStack ? el._x_dataStack[0] : null;
    if (!d) return { error: 'sem dados Alpine' };
    return {
      subReady: d.subReady,
      subError: d.subError,
      plans: Array.isArray(d.plans) ? d.plans.length : String(d.plans),
      subscription: d.subscription ? { status: d.subscription.status, payerEmail: d.subscription.payerEmail } : null,
      subGateway: d.subGateway,
    };
  });
  console.log('API subscription:', JSON.stringify(subResponse, null, 2));
  console.log('estado Alpine:', JSON.stringify(state, null, 2));
  await browser.close();
})();
