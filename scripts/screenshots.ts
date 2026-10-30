/**
 * Visual + sanity check. Serves the production build (so the CSP is active), drives it with headless
 * Chromium, saves screenshots to screenshots/ and FAILS on any console error, page error or non-local network request.
 * Usage: npm run build && npm run screenshots
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { zipSync } from 'fflate';
import { chromium, type Browser, type Page } from 'playwright';
import { generate } from '../src/demo/generate';

const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;
const problems: string[] = [];
mkdirSync('screenshots', { recursive: true });

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    const exe = '/opt/pw-browsers/chromium';
    if (!existsSync(exe)) throw new Error('No Chromium available for Playwright');
    return chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  }
}

function watch(page: Page, label: string): void {
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${label}] console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:')) problems.push(`[${label}] network request: ${u}`);
  });
  page.on('requestfailed', (r) => problems.push(`[${label}] request failed: ${r.url()} ${r.failure()?.errorText}`));
}

async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.waitForTimeout(350); // let the 220 ms enter animation finish
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage });
  console.log('saved', name);
}


const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** Run axe-core (injected via evaluate, so the page CSP is not involved) and record serious/critical violations. */
async function a11y(page: Page, label: string): Promise<void> {
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (window as any).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return r.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => `${v.id}: ${v.help} (${v.nodes.length} nodes, e.g. ${v.nodes[0].target})`);
  });
  for (const v of violations) problems.push(`[a11y ${label}] ${v}`);
}

/** Serve dist/ under a sub-path, like GitHub Pages project sites (https://user.github.io/repo/). */
function servePages(prefix: string, port: number) {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  return createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (!url.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const rel = url.slice(prefix.length);
    const file = join('dist', rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel);
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  }).listen(port);
}

async function main(): Promise<void> {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(ORIGIN)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const browser = await launch();
    const sizes = [{ n: 'desktop', width: 1280, height: 900 }, { n: 'mobile', width: 390, height: 844 }];
    const schemes = ['light', 'dark'] as const;

    for (const s of sizes) {
      for (const scheme of schemes) {
        const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, colorScheme: scheme });
        const page = await ctx.newPage();
        const label = `${s.n}-${scheme}`;
        watch(page, label);
        await page.goto(ORIGIN);
        await page.waitForSelector('#demo');
        await shoot(page, `home-${label}`);
        if (scheme === 'light') await a11y(page, `home-${s.n}`);
        await page.click('#demo');
        await page.waitForSelector('#export', { timeout: 60_000 });
        await shoot(page, `stats-${label}`);
        if (scheme === 'light') await a11y(page, `stats-${s.n}`);
        if (s.n === 'mobile') {
          await page.getByRole('button', { name: 'Filters' }).click();
          await shoot(page, `filters-sheet-${label}`, false);
          await page.getByRole('button', { name: 'Done' }).click();
          await page.getByRole('button', { name: 'Posters' }).click();
          await page.waitForSelector('#poster-preview');
          await shoot(page, `posters-${label}`, false);
        }
        if (label === 'desktop-light') {
          // single-activity view: open from the table, check content, history back, search keeps focus
          await page.fill('#activity-search', 'Ride');
          if ((await page.evaluate(() => document.activeElement?.id)) !== 'activity-search') problems.push('search box lost focus while typing');
          await page.fill('#activity-search', '');
          await page.locator('.link.name').first().click();
          await page.waitForSelector('#activity-title');
          await shoot(page, 'activity-desktop-light');
          const tiles = await page.locator('.detail .stat').count();
          const charts = await page.locator('.detail .chart').count();
          const svgs = await page.locator('.detail .routesvg').count();
          console.log('activity view:', { tiles, charts, route: svgs, title: await page.textContent('#activity-title') });
          if (tiles < 5 || charts < 2 || svgs !== 1) problems.push('activity detail looks empty');
          await a11y(page, 'activity');
          await page.getByRole('button', { name: /Older activity/ }).click();
          await page.waitForSelector('#activity-title');
          await page.goBack();
          await page.waitForTimeout(100);
          await page.goBack();
          await page.waitForSelector('#overview');
          if (await page.locator('#activity-title').count()) problems.push('browser back did not leave the activity view');
          await page.locator('.link').first().click();
          await page.waitForSelector('#activity-title');
          await page.getByRole('button', { name: /Older activity/ }).click();
          await page.click('#back'); // must skip over the stacked activity entries
          await page.waitForSelector('#overview');
          // keyboard focus survives a re-render
          await page.locator('.filters select').nth(1).focus();
          await page.locator('.filters select').nth(1).selectOption('imperial');
          if ((await page.evaluate(() => document.activeElement?.tagName)) !== 'SELECT') problems.push('focus lost after changing a filter');
          await page.locator('.filters select').nth(1).selectOption('metric');
          const checks = await page.evaluate(() => ({
            h2: Array.from(document.querySelectorAll('h2')).map((e) => e.textContent),
            tables: document.querySelectorAll('table').length,
            loops: document.querySelectorAll('.loop').length,
            stats: document.querySelectorAll('.stat').length,
          }));
          console.log(checks);
          if (checks.loops < 2) problems.push('expected repeated routes in demo data');
          if (checks.stats < 9) problems.push('overview stats missing');
          // sport filter + units toggle do something
          const before = await page.textContent('.stat b');
          await page.selectOption('select >> nth=1', 'imperial');
          const dist = await page.locator('.stat b').nth(1).textContent();
          if (!dist?.includes('mi')) problems.push(`unit toggle failed: ${dist}`);
          await page.selectOption('select >> nth=0', 'Run');
          const after = await page.textContent('.stat b');
          if (before === after) problems.push('sport filter did not change the activity count');
        }
        await ctx.close();
      }
    }

    // Posters: render every type from demo data, download PNG + SVG, verify dimensions.
    const plan: [string, string, string, string][] = [
      ['Route facets', 'dark', 'a3', 'facets'], ['All routes', 'ember', 'a3', 'overlay'], ['Calendar heatmap', 'light', 'a3', 'calendar'],
      ['Elevation ridgelines', 'aurora', 'a3', 'ridgelines'], ['Season overview', 'dark', 'a3', 'season'],
      ['Route facets', 'light', 'phone', 'facets-phone'], ['All routes', 'dark', 'square', 'overlay-square'],
      ['Activity bubbles', 'dark', 'a3', 'circles'], ['Time-of-day ridges', 'ember', 'a3', 'timeofday'], ['Weekly rhythm', 'light', 'square', 'punchcard'],
      ['Year rings', 'aurora', 'square', 'rings'], ['Year over year', 'dark', 'a3', 'cumulative'],
    ];
    const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const pp = await pctx.newPage();
    watch(pp, 'posters');
    await pp.goto(ORIGIN);
    await pp.click('#demo');
    await pp.waitForSelector('#export', { timeout: 60_000 });
    await pp.getByRole('button', { name: 'Posters' }).click();
    for (const [type, theme, size, name] of plan) {
      await pp.locator('.controls select').nth(0).selectOption({ label: type });
      await pp.locator('.controls select').nth(1).selectOption(theme);
      await pp.locator('.controls select').nth(2).selectOption(size);
      await pp.waitForSelector('#poster-preview');
      await pp.waitForFunction(() => (document.querySelector('#poster-preview') as HTMLImageElement).complete);
      const [dl] = await Promise.all([pp.waitForEvent('download', { timeout: 60_000 }), pp.click('#dl-png')]);
      const file = `screenshots/poster-${name}.png`;
      await dl.saveAs(file);
      const png = readFileSync(file);
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      const want = size === 'a3' ? [3508, 4961] : size === 'square' ? [3000, 3000] : [1290, 2796];
      if (w !== want[0] || h !== want[1]) problems.push(`poster ${name}: PNG is ${w}x${h}, expected ${want.join('x')}`);
      const [sv] = await Promise.all([pp.waitForEvent('download'), pp.click('#dl-svg')]);
      await sv.saveAs(`screenshots/poster-${name}.svg`);
      const svgText = readFileSync(`screenshots/poster-${name}.svg`, 'utf8');
      if (!svgText.startsWith('<svg') || /NaN|undefined/.test(svgText)) problems.push(`poster ${name}: bad SVG output`);
      console.log('poster', name, `${w}x${h}`, `${Math.round(png.length / 1024)} KB`, `svg ${Math.round(svgText.length / 1024)} KB`);
    }
    await shoot(pp, 'posters-page');
    await a11y(pp, 'posters');
    await pp.getByRole('button', { name: 'Dark', exact: true }).click();
    if ((await pp.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') problems.push('theme toggle did not set dark');
    await pp.getByRole('button', { name: 'Light', exact: true }).click();
    if ((await pp.evaluate(() => document.documentElement.dataset.theme)) !== 'light') problems.push('theme toggle did not set light');
    await pctx.close();

    // Real upload path: a ZIP chosen through the file picker.
    const { files } = generate({ seed: 3, density: 0.15 });
    const zip: Record<string, Uint8Array> = {};
    for (const f of files) zip[`strava_export/${f.path}`] = f.data;
    writeFileSync('screenshots/_upload.zip', zipSync(zip, { level: 0 }));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    watch(page, 'upload');
    await page.goto(ORIGIN);
    await page.setInputFiles('input[type=file] >> nth=0', 'screenshots/_upload.zip');
    await page.waitForSelector('#export', { timeout: 60_000 });
    const report = await page.textContent('#issues + p');
    console.log('upload report:', report);
    if (!/3 skipped/.test(report ?? '')) problems.push(`unexpected import report: ${report}`);
    // GitHub Pages style sub-path hosting: relative asset and worker URLs must still resolve.
    const pages = servePages('/ride-atlas/', 4180);
    const gctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const gp = await gctx.newPage();
    gp.on('console', (m) => { if (m.type() === 'error') problems.push(`[pages] console error: ${m.text()}`); });
    gp.on('pageerror', (e) => problems.push(`[pages] page error: ${e.message}`));
    await gp.goto('http://localhost:4180/ride-atlas/');
    await gp.click('#demo');
    await gp.waitForSelector('#export', { timeout: 60_000 });
    await gctx.close();
    pages.close();

    // Large export through the real file input: UI must stay responsive and finish in reasonable time.
    if (process.env.BIG !== '0') {
      const big = generate({ seed: 11, density: 6.2, stepS: 20 });
      const bz: Record<string, Uint8Array> = {};
      for (const f of big.files) bz[f.path] = f.data;
      writeFileSync('screenshots/_big.zip', zipSync(bz, { level: 0 }));
      const bctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
      const bp = await bctx.newPage();
      watch(bp, 'big');
      await bp.goto(ORIGIN);
      // Frame-gap monitor (a string, so esbuild helpers are not injected into the page).
      await bp.evaluate(`(() => { window.__maxGap = 0; let last = performance.now(); const tick = () => { const n = performance.now(); window.__maxGap = Math.max(window.__maxGap, n - last); last = n; requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
      const t0 = Date.now();
      await bp.setInputFiles('input[type=file] >> nth=0', 'screenshots/_big.zip');
      await bp.waitForSelector('#export', { timeout: 180_000 });
      const importMs = Date.now() - t0;
      const gap = await bp.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap);
      console.log(`big import: ${importMs} ms, worst main-thread stall ${Math.round(gap)} ms, ${await bp.locator('.stat b').first().textContent()} activities`);
      if (gap > 1500) problems.push(`main thread stalled ${Math.round(gap)} ms during big import`);
      await bp.getByRole('button', { name: 'Posters' }).click();
      const t1 = Date.now();
      await bp.waitForSelector('#poster-preview');
      await bp.waitForFunction(() => (document.querySelector('#poster-preview') as HTMLImageElement).complete);
      console.log(`big facets poster rendered in ${Date.now() - t1} ms`);
      await shoot(bp, 'big-posters');
      await bctx.close();
    }
    await ctx.close();
    await browser.close();
  } finally {
    server.kill();
  }
  if (problems.length) {
    console.error('\nPROBLEMS:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('screenshots ok: no console errors, no network requests');
}

main().catch((e) => { console.error(e); process.exit(1); });
