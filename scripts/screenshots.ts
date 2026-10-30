/**
 * Visual + sanity check. Serves the production build (so the CSP is active), drives it with headless
 * Chromium, saves screenshots to screenshots/ and FAILS on any console error, page error or non-local network request.
 * Usage: npm run build && npm run screenshots
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
  console.log('saved', name);
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
        await page.click('#demo');
        await page.waitForSelector('#export', { timeout: 60_000 });
        await shoot(page, `stats-${label}`);
        if (label === 'desktop-light') {
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
