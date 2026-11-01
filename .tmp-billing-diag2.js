const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('response', async (r) => {
    if (r.status() >= 400) console.log('HTTP', r.status(), r.url(), (await r.text().catch(() => '')).slice(0, 300));
  });
  await page.goto('http://localhost:3123/?login=1', { waitUntil: 'load' });
  const profiles = await page.evaluate(async () => {
    const r = await fetch('/api/auth/quick-profiles');
    return { status: r.status, body: await r.text() };
  });
  console.log('profiles:', profiles);
  const login = await page.evaluate(async () => {
    const r = await fetch('/api/auth/quick-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 1 }) });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  });
  console.log('login:', login);
  await page.goto('http://localhost:3123/admin/cobrancas', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  console.log('url:', page.url());
  console.log('body:', (await page.locator('body').innerText()).slice(0, 500));
  await browser.close();
})();
