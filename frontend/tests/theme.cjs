// Run after building frontend; PLAYWRIGHT_MODULE may point to a local installation.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = process.env.RENDER_FIXTURE_PATH ? fs.readFileSync(process.env.RENDER_FIXTURE_PATH, 'utf8') : execFileSync('uv', [
  'run', '--project', 'backend', 'python', '-c',
  'import sys; sys.path.insert(0, "backend"); from render import isolated_html, render, new_notebook; print(isolated_html(render(new_notebook("Theme preview"))))',
], { encoding: 'utf8' });
let fallbackReads = 0;
const artifactCookies = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/api/workspace') return res.end(JSON.stringify({
    users: [{ id: 1, login: 'notebook-author' }],
    notebooks: ['blob', 'fallback', 'local'].map(id => ({ id, owner_id: 1, title: 'Theme notebook ' + id, revision: 1, updated_at: 1, render_url: id === 'local' ? null : '/artifact/' + id })),
  }));
  if (url.pathname === '/api/auth/me') return res.end(JSON.stringify({ user: null, can_edit: false, configured: true }));
  if (url.pathname.endsWith('/chat-history')) return res.end('{"messages":[],"revision":0}');
  if (url.pathname.endsWith('/chat/state')) return res.end('{"active":false}');
  if (url.pathname.startsWith('/artifact/')) artifactCookies.push(req.headers.cookie);
  if (url.pathname === '/artifact/fallback') { res.statusCode = 503; return res.end(); }
  if (url.pathname === '/artifact/blob' || url.pathname.endsWith('/render')) {
    if (url.pathname.endsWith('/render')) {
      fallbackReads++;
      if (!req.headers.cookie?.includes('preview_auth=allowed')) { res.statusCode = 401; return res.end('Deployment authentication required'); }
    }
    res.setHeader('Content-Type', 'text/html'); return res.end(fixture);
  }
  if (url.pathname.startsWith('/api/')) { res.statusCode = 404; return res.end('{}'); }
  const file = path.join(process.cwd(), 'frontend/dist', ['/', '/about'].includes(url.pathname) ? 'index.html' : url.pathname);
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  try { res.end(fs.readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});

// @lat: [[architecture#Notebook Factory#Appearance tests]]
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 850 } });
    context.setDefaultTimeout(10000);
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await context.addCookies([{ name: 'preview_auth', value: 'allowed', url: origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/?notebook=blob');
    await page.getByRole('combobox', { name: 'Theme' }).waitFor();
    const expectTheme = async (target, value) => {
      await target.waitForFunction(value => document.documentElement.dataset.theme === value, value);
      assert.equal(await target.evaluate(() => getComputedStyle(document.documentElement).colorScheme), value);
    };
    await expectTheme(page, 'light');
    const frame = await (await page.waitForSelector('iframe[title="Rendered notebook"]')).contentFrame();
    await expectTheme(frame, 'light');
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 250, 250)');
    await frame.evaluate(() => { window.themeTestMarker = 42; window.scrollTo(0, 100); });
    await page.screenshot({ path: '/tmp/notebook-theme-light.png' });
    await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
    await expectTheme(page, 'dark'); await expectTheme(frame, 'dark');
    assert.equal(await frame.evaluate(() => window.themeTestMarker), 42, 'theme changes preserve the iframe');
    assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 10, 10)');
    await page.screenshot({ path: '/tmp/notebook-theme-dark.png' });
    await page.reload(); await expectTheme(page, 'dark');
    assert.equal(await page.getByRole('combobox', { name: 'Theme' }).inputValue(), 'dark');
    const other = await context.newPage(); await other.goto(origin);
    await other.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    await expectTheme(page, 'light');
    await page.getByRole('combobox', { name: 'Theme' }).selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' }); await expectTheme(page, 'dark');
    await page.emulateMedia({ colorScheme: 'light' }); await expectTheme(page, 'light');
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Choose a notebook' }).waitFor();
    assert.equal(await page.locator('.welcome').evaluate(node => getComputedStyle(node).backgroundImage), 'none');
    await page.getByRole('combobox', { name: 'Theme' }).focus();
    assert.equal(await page.locator('.theme-switcher').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.screenshot({ path: '/tmp/notebook-theme-welcome.png' });
    await page.goto(origin + '/?notebook=local');
    const local = await (await page.waitForSelector('iframe[title="Rendered notebook"]')).contentFrame();
    await expectTheme(local, 'light');
    await page.goto(origin + '/?notebook=fallback');
    const fallback = await (await page.waitForSelector('iframe[title="Rendered notebook"]')).contentFrame();
    await expectTheme(fallback, 'light');
    assert.ok(fallbackReads > 0);
    assert.ok(artifactCookies.length > 0 && artifactCookies.every(cookie => cookie === undefined), 'Blob fetches omit credentials');
    assert.ok(await fallback.locator('meta[http-equiv="Content-Security-Policy"]').count());
    // Published content still cannot open network connections when fetched into srcdoc.
    assert.equal(await fallback.evaluate(async origin => {
      try { await fetch(origin + '/api/workspace'); return false; } catch { return true; }
    }, origin), true);
    await page.getByRole('button', { name: 'Close chat' }).click();
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (width < 650) {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await page.waitForFunction(() => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().x) < 0.5);
      }
      const brand = await page.locator('.brand').boundingBox();
      const switcher = await page.locator('.theme-switcher').boundingBox();
      const sidebar = await page.locator('.sidebar').boundingBox();
      assert.ok(brand.x + brand.width <= switcher.x, 'brand and switcher do not overlap');
      assert.ok(switcher.x + switcher.width <= sidebar.x + sidebar.width, 'switcher fits sidebar');
      await page.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
      await expectTheme(fallback, 'dark');
      await page.getByRole('combobox', { name: 'Theme' }).selectOption('light');
    }
    await page.screenshot({ path: '/tmp/notebook-theme-mobile.png' });
    const blocked = await browser.newContext({ colorScheme: 'light' });
    blocked.setDefaultTimeout(10000);
    await blocked.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await blocked.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
      Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
    });
    const privatePage = await blocked.newPage(); await privatePage.goto(origin);
    await privatePage.getByRole('combobox', { name: 'Theme' }).selectOption('dark');
    await expectTheme(privatePage, 'dark');
    assert.deepEqual(errors, []);
    console.log('Theme checks passed: palettes, persistence, tabs, system preference, storage failure, iframe retention, authenticated fallback, credential-free Blob fetches, CSP, responsive layout, welcome background, switcher focus.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
