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
import { deflateSync } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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

/** Map tile hosts: the only outside requests allowed. They are answered locally (see fakeTiles), never fetched. */
const TILE_HOST = /^https:\/\/([abc]\.tile\.opentopomap\.org|tile\.openstreetmap\.org)\//;
let tileRequests = 0;

function watch(page: Page, label: string): void {
  // A refused map tile is logged by the browser; the app handles it (see the refusal check), so it is not a problem here.
  page.on('console', (m) => { if (m.type() === 'error' && !TILE_HOST.test(m.location().url)) problems.push(`[${label}] console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (TILE_HOST.test(u)) { tileRequests++; return; }
    if (!u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:')) problems.push(`[${label}] network request: ${u}`);
  });
  page.on('requestfailed', (r) => problems.push(`[${label}] request failed: ${r.url()} ${r.failure()?.errorText}`));
}

/** A plain 256 × 256 PNG standing in for map tiles, so the check never needs the internet. */
function fakeTile(): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(256 * 3, 0)]);
  for (let i = 0; i < 256; i++) row.set([232, 238, 222], 1 + i * 3);
  const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Answer map tile requests with a plain local picture, so the check never needs the internet. */
async function fakeTiles(ctx: BrowserContext): Promise<BrowserContext> {
  const body = fakeTile();
  await ctx.route(TILE_HOST, (r) => r.fulfill({ status: 200, contentType: 'image/png', body }));
  return ctx;
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
  await page.waitForTimeout(350); // the enter animation fades content in; contrast is measured after it
  await page.evaluate(AXE);
  const violations = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (window as any).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return r.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical').map((v: any) => `${v.id}: ${v.help} (${v.nodes.length} nodes, e.g. ${v.nodes[0].target}: ${v.nodes[0].failureSummary?.split('\n').slice(0, 3).join(' ')})`);
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
        const ctx = await fakeTiles(await browser.newContext({ viewport: { width: s.width, height: s.height }, colorScheme: scheme }));
        const page = await ctx.newPage();
        const label = `${s.n}-${scheme}`;
        watch(page, label);
        await page.goto(ORIGIN);
        await page.waitForSelector('#demo');
        // Example posters on the import page are static files that must load.
        await page.evaluate(() => Promise.all(Array.from(document.querySelectorAll<HTMLImageElement>('.examples img')).map((i) => { i.loading = 'eager'; return i.decode(); })))
          .catch(() => problems.push(`${label}: an example poster on the import page did not load`));
        await shoot(page, `home-${label}`);
        if (!(await page.locator('#privacy + .safety li').count())) problems.push(`${label}: the import page has no privacy and safety section`);
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
          await page.waitForSelector('#poster-climb[src]');
          await shoot(page, `posters-${label}`, false);
          await page.click('.thumb >> nth=0');
          await page.waitForSelector('.lightbox');
          await shoot(page, `lightbox-${label}`, false);
          await page.keyboard.press('Escape');
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
          const charts = await page.locator('.detail .charts .chart').count();
          const svgs = await page.locator('.detail .routesvg').count();
          console.log('activity view:', { tiles, charts, route: svgs, title: await page.textContent('#activity-title') });
          if (tiles < 5 || charts < 2 || svgs !== 1) problems.push('activity detail looks empty');
          // Hover: one chart shows its value, every chart and the map show the same point.
          await page.locator('.detail .charts .chart').first().scrollIntoViewIfNeeded();
          const box = (await page.locator('.detail .charts .chart').first().boundingBox())!;
          await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
          const hover = await page.evaluate(() => ({
            charts: Array.from(document.querySelectorAll('.detail .charts .chart .hover')).filter((g) => g.getAttribute('visibility') === 'visible').length,
            bubble: document.querySelector('.detail .charts .chart .bubble-text')?.textContent ?? '',
            map: document.querySelector('.detail .map-cursor')?.closest('[display="none"]') ? 'hidden' : 'visible',
            mapText: document.querySelector('.detail .map-bubble-text')?.textContent ?? '',
          }));
          console.log('hover:', hover);
          if (hover.charts !== charts || !/km · \d/.test(hover.bubble) || hover.map !== 'visible' || !/km · /.test(hover.mapText)) problems.push(`chart hover not shown everywhere: ${JSON.stringify(hover)}`);
          await shoot(page, 'activity-hover-desktop-light', false);
          await page.mouse.move(5, 5);
          // Regression: leaving the chart hid the map's dot and label but left its bubble box behind.
          // (checkVisibility() is not reliable inside SVG, so look for a hidden ancestor or the element's own visibility)
          const leftOver = await page.evaluate(() => Array.from(document.querySelectorAll('.detail .map-cursor, .detail .map .bubble'))
            .filter((el) => !el.closest('[display="none"]') && getComputedStyle(el).visibility !== 'hidden').length);
          if (leftOver) problems.push(`map hover marker still shown after the pointer left (${leftOver} parts)`);
          // Keyboard: focus a chart and step with the arrow keys.
          await page.locator('.detail .charts .chart').first().focus();
          await page.keyboard.press('End');
          if (!(await page.textContent('.detail .charts .chart .bubble-text'))?.startsWith((await page.locator('.detail .charts .chart .tick').last().textContent())!.split(' ')[0]!)) problems.push('chart End key did not jump to the end');
          // Map background: OpenStreetMap by default (tiles answered locally), movable and zoomable.
          await page.waitForSelector('.detail .map.has-tiles .tiles img');
          await page.waitForTimeout(300);
          await shoot(page, 'activity-map-desktop-light', false);
          if (!(await page.locator('.detail .map-attr').count())) problems.push('map attribution missing');
          if (!(await page.locator('.detail .tiles img').first().getAttribute('src'))?.includes('tile.openstreetmap.org')) problems.push('map background is not OpenStreetMap by default');
          const mapState = () => page.evaluate(() => ({
            route: document.querySelector('.detail .map .route')?.getAttribute('points')?.slice(0, 40),
            tiles: Array.from(document.querySelectorAll('.detail .tiles img')).map((i) => (i as HTMLImageElement).src.split('/').slice(-3).join('/')).sort().join(' '),
          }));
          const m0 = await mapState();
          await page.locator('.detail .map').scrollIntoViewIfNeeded();
          const mb = (await page.locator('.detail .map').boundingBox())!;
          await page.mouse.move(mb.x + mb.width * 0.3, mb.y + mb.height * 0.6);
          await page.mouse.down();
          await page.mouse.move(mb.x + mb.width * 0.6, mb.y + mb.height * 0.4, { steps: 5 });
          await page.mouse.up();
          await page.waitForTimeout(100);
          const m1 = await mapState();
          if (m1.route === m0.route) problems.push('map: dragging did not move the map');
          await page.mouse.move(mb.x + mb.width * 0.5, mb.y + mb.height * 0.5);
          await page.mouse.wheel(0, -400);
          await page.waitForTimeout(100);
          const m2 = await mapState();
          if (m2.route === m1.route) problems.push('map: the wheel did not zoom');
          await page.getByRole('button', { name: 'Fit the route' }).click();
          await page.waitForTimeout(100);
          if ((await mapState()).route !== m0.route) problems.push('map: "Fit the route" did not restore the view');
          await page.locator('.detail .map').focus();
          await page.keyboard.press('+');
          await page.keyboard.press('ArrowLeft');
          await page.waitForTimeout(100);
          if ((await mapState()).route === m0.route) problems.push('map: keyboard did not move or zoom the map');
          await page.keyboard.press('0');
          // Off means off: no tile requests at all.
          await page.getByLabel('Map background').selectOption('off');
          const tilesBefore = tileRequests;
          await page.getByRole('button', { name: /Older activity/ }).click();
          await page.waitForSelector('#activity-title');
          if (await page.locator('.detail .map.has-tiles').count()) problems.push('map background still shown after switching it off');
          if (tileRequests !== tilesBefore) problems.push('map tiles requested while the map background is off');
          await page.goBack();
          await page.waitForSelector('#activity-title');
          await a11y(page, 'activity');
          await page.getByRole('button', { name: /Older activity/ }).click();
          await page.waitForSelector('#activity-title');
          await page.goBack();
          await page.waitForTimeout(100);
          await page.goBack();
          await page.waitForSelector('#overview');
          if (await page.locator('#activity-title').count()) problems.push('browser back did not leave the activity view');
          await page.locator('table .link').first().click();
          await page.waitForSelector('#activity-title');
          await page.getByRole('button', { name: /Older activity/ }).click();
          await page.click('#back'); // must skip over the stacked activity entries
          await page.waitForSelector('#overview');
          // Clickable stats: a row (clicked anywhere) lists its activities below the table, shaded while selected.
          await page.locator('#records ~ .card tr', { hasText: 'Most active day' }).locator('td').nth(1).click();
          await page.waitForSelector('#list-records .act-card').catch(() => problems.push('records: most active day did not list its activities'));
          if (!(await page.locator('#records ~ .card tr.selected').count())) problems.push('records: the clicked row is not shaded');
          if ((await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))) !== 'true') problems.push('records: focus is not on the expanded row');
          await page.locator('.loops:not(.act-list) .loop button.stretch').first().click();
          await page.waitForSelector('#list-loops .act-card').catch(() => problems.push('routes: a repeated route did not list its activities'));
          if (await page.locator('#list-records').count()) problems.push('drill-down: two lists open at once');
          const loopCards = await page.locator('#list-loops .act-card').count();
          if (loopCards !== 12 || !(await page.locator('#list-loops .more').isVisible())) problems.push(`routes: expected 12 cards and a "Show more" button, got ${loopCards}`);
          await page.locator('#list-loops .more').click();
          if ((await page.locator('#list-loops .act-card').count()) <= 12) problems.push('routes: "Show more" added no cards');
          await shoot(page, 'stats-route-list', false);
          await a11y(page, 'stats-with-list');
          // A card opens its activity; Back returns to the open list.
          await page.locator('#list-loops .act-name').first().click();
          await page.waitForSelector('#activity-title');
          await page.goBack();
          await page.waitForSelector('#list-loops').catch(() => problems.push('drill-down: the list was gone after returning from an activity'));
          await page.getByRole('button', { name: /^Close the list/ }).click();
          if (await page.locator('#list-loops').count()) problems.push('drill-down: Close did not close the list');
          if (!(await page.evaluate(() => document.activeElement?.closest('.loop')))) problems.push('drill-down: focus did not return to the route after closing');
          // Period rows, by keyboard: Enter on the year button.
          await page.locator('button.rowbtn', { hasText: /^\d{4}$/ }).first().focus();
          await page.keyboard.press('Enter');
          await page.waitForSelector('#list-year .act-card').catch(() => problems.push('years: Enter on a year row did not list its activities'));
          // The activity opened last stays shaded in the activities table.
          await page.locator('#activities ~ .card tbody tr').nth(2).locator('td').nth(3).click();
          await page.waitForSelector('#activity-title');
          await page.goBack();
          await page.waitForSelector('#activities');
          if ((await page.locator('#activities ~ .card tbody tr').nth(2).getAttribute('class'))?.includes('selected') !== true) problems.push('activities: the row of the activity opened last is not shaded');
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

    // Posters: every type is shown in the gallery; download PNG + SVG from its card and verify dimensions.
    const plan: [string, string, string, string][] = [
      ['facets', 'dark', 'a3', 'facets'], ['overlay', 'ember', 'a3', 'overlay'], ['calendar', 'light', 'a3', 'calendar'],
      ['ridgelines', 'aurora', 'a3', 'ridgelines'], ['season', 'dark', 'a3', 'season'],
      ['facets', 'light', 'phone', 'facets-phone'], ['overlay', 'dark', 'square', 'overlay-square'],
      ['circles', 'dark', 'a3', 'circles'], ['timeofday', 'ember', 'a3', 'timeofday'], ['punchcard', 'light', 'square', 'punchcard'],
      ['rings', 'aurora', 'square', 'rings'], ['cumulative', 'dark', 'a3', 'cumulative'],
      ['climb', 'dark', 'a3', 'climb'], ['climb', 'light', 'square', 'climb-square'],
      ['world', 'dark', 'a3', 'world'], ['world', 'aurora', 'square', 'world-square'], ['todweek', 'ember', 'a3', 'todweek'],
      ['landscape', 'light', 'a3', 'landscape'], ['space', 'dark', 'a3', 'space'], ['space', 'ember', 'square', 'space-square'],
      ['bloom', 'dark', 'a3', 'bloom'], ['stream', 'aurora', 'a3', 'stream'], ['spiral', 'light', 'square', 'spiral'], ['strata', 'ember', 'a3', 'strata'],
      ['work', 'dark', 'a3', 'work'], ['fingerprint', 'ember', 'a3', 'fingerprint'], ['sunrise', 'aurora', 'a3', 'sunrise'], ['sunrise', 'light', 'square', 'sunrise-square'],
    ];
    const pctx = await fakeTiles(await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }));
    const pp = await pctx.newPage();
    watch(pp, 'posters');
    await pp.goto(ORIGIN);
    await pp.click('#demo');
    await pp.waitForSelector('#export', { timeout: 60_000 });
    await pp.waitForFunction(() => Array.from(document.querySelectorAll('.promo img')).every((i) => (i as HTMLImageElement).src && (i as HTMLImageElement).complete));
    await shoot(pp, 'stats-promo', false);
    // Sport Wrapped: pick a year, step through every card with the keyboard, save the picture, close.
    await pp.click('#open-wrapped');
    await pp.waitForSelector('.w-year');
    await a11y(pp, 'wrapped-picker');
    await shoot(pp, 'wrapped-picker', false);
    await pp.click('.w-year');
    const wcards = await pp.locator('.w-prog').count();
    if (wcards < 10) problems.push(`wrapped: only ${wcards} cards on the demo data`);
    for (let i = 0; i < wcards; i++) {
      if (!(await pp.textContent('#w-live'))?.startsWith(`Card ${i + 1} of`)) problems.push(`wrapped: card ${i + 1} not announced`);
      if (i === 2) { await pp.waitForTimeout(1500); await a11y(pp, 'wrapped-card'); } // after the card's fade-in
      if (i === 0 || i === 5 || i === wcards - 1) await shoot(pp, `wrapped-${i + 1}`, false);
      await pp.keyboard.press('ArrowRight');
    }
    const [wdl] = await Promise.all([pp.waitForEvent('download'), pp.click('#w-save')]);
    const wpath = await wdl.path();
    if (!wpath || statSync(wpath).size < 20_000) problems.push('wrapped: saved picture missing or too small');
    await pp.keyboard.press('ArrowLeft');
    if (!(await pp.textContent('#w-live'))?.startsWith(`Card ${wcards - 1} of`)) problems.push('wrapped: ArrowLeft did not go back');
    await pp.keyboard.press('Escape');
    await pp.waitForTimeout(200);
    if (await pp.locator('dialog.wrapped').count()) problems.push('wrapped: Escape did not close');
    if ((await pp.evaluate(() => document.activeElement?.id)) !== 'open-wrapped') problems.push('wrapped: focus not returned');
    // Auto-advance: the first card moves on by itself after its progress bar fills.
    await pp.click('#open-wrapped');
    await pp.click('.w-year');
    await pp.waitForTimeout(6_600);
    if (!(await pp.textContent('#w-live'))?.startsWith('Card 2 of')) problems.push('wrapped: did not advance by itself');
    await pp.goBack(); // Back closes it too
    await pp.waitForTimeout(200);
    if (await pp.locator('dialog.wrapped').count()) problems.push('wrapped: Back did not close');
    if (!(await pp.locator('#export').count())) problems.push('wrapped: Back left the stats page');
    await pp.click('#open-posters'); // the banner on the stats page leads to the gallery
    await pp.waitForSelector('.gallery');
    const cards = await pp.locator('.pcard').count();
    if (cards < 15) problems.push(`gallery shows ${cards} posters, expected all of them`);
    for (const [type, theme, size, name] of plan) {
      await pp.locator('.controls select').nth(0).selectOption(theme);
      await pp.locator('.controls select').nth(1).selectOption(size);
      await pp.waitForFunction((t) => { const i = document.querySelector(`#poster-${t}`) as HTMLImageElement | null; return !!i?.src && i.complete; }, type);
      const [dl] = await Promise.all([pp.waitForEvent('download', { timeout: 60_000 }), pp.click(`#dl-png-${type}`)]);
      const file = `screenshots/poster-${name}.png`;
      await dl.saveAs(file);
      const png = readFileSync(file);
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      const want = size === 'a3' ? [3508, 4961] : size === 'square' ? [3000, 3000] : [1290, 2796];
      if (w !== want[0] || h !== want[1]) problems.push(`poster ${name}: PNG is ${w}x${h}, expected ${want.join('x')}`);
      const [sv] = await Promise.all([pp.waitForEvent('download'), pp.click(`#dl-svg-${type}`)]);
      await sv.saveAs(`screenshots/poster-${name}.svg`);
      const svgText = readFileSync(`screenshots/poster-${name}.svg`, 'utf8');
      if (!svgText.startsWith('<svg') || /NaN|undefined/.test(svgText)) problems.push(`poster ${name}: bad SVG output`);
      console.log('poster', name, `${w}x${h}`, `${Math.round(png.length / 1024)} KB`, `svg ${Math.round(svgText.length / 1024)} KB`);
    }
    // Download all as one ZIP of SVGs.
    const [zdl] = await Promise.all([pp.waitForEvent('download', { timeout: 120_000 }), pp.click('#dl-all-svg')]);
    await zdl.saveAs('screenshots/_all-svg.zip');
    const { unzipSync } = await import('fflate');
    const names = Object.keys(unzipSync(readFileSync('screenshots/_all-svg.zip')));
    if (names.length !== cards) problems.push(`download all: ${names.length} files in ZIP, expected ${cards}`);
    // Full-screen viewer: arrows move between posters, Escape closes and returns focus.
    await pp.locator('.thumb').nth(0).click();
    await pp.waitForSelector('.lightbox');
    await shoot(pp, 'lightbox-desktop', false);
    await a11y(pp, 'lightbox');
    await pp.keyboard.press('ArrowRight');
    if (!(await pp.textContent('.lb-count'))?.startsWith('2 /')) problems.push('lightbox: ArrowRight did not advance');
    await pp.keyboard.press('ArrowLeft');
    await pp.keyboard.press('ArrowLeft');
    if (!(await pp.textContent('.lb-count'))?.startsWith(`${cards} /`)) problems.push('lightbox: ArrowLeft did not wrap around');
    await pp.click('.lb-next');
    if (!(await pp.textContent('.lb-count'))?.startsWith('1 /')) problems.push('lightbox: next button did not advance');
    await pp.keyboard.press('Escape');
    await pp.waitForTimeout(100);
    if (await pp.locator('.lightbox').count()) problems.push('lightbox: Escape did not close');
    // Browser Back closes the viewer and stays on the posters page.
    await pp.locator('.thumb').nth(2).click();
    await pp.waitForSelector('.lightbox');
    await pp.goBack();
    await pp.waitForTimeout(150);
    if (await pp.locator('.lightbox').count()) problems.push('lightbox: Back did not close');
    if (!(await pp.locator('.gallery').count())) problems.push('lightbox: Back left the posters page');
    if (!(await pp.evaluate(() => document.activeElement?.classList.contains('thumb')))) problems.push('lightbox: focus not returned');
    // Poster options can be changed inside the viewer; the poster there and in the gallery follow.
    const climbAt = await pp.locator('.pcard').evaluateAll((els) => els.findIndex((e) => e.querySelector('#poster-climb')));
    await pp.locator('.thumb').nth(climbAt).click();
    await pp.waitForSelector('.lightbox');
    const before = await pp.getAttribute('.lb-img', 'src');
    await pp.locator('.lb-settings').getByLabel('Mountains climbed: Period').selectOption('overlay');
    if ((await pp.getAttribute('.lb-img', 'src')) === before) problems.push('lightbox: changing an option did not redraw the poster');
    if (!(await pp.evaluate(() => document.activeElement?.closest('.lb-settings')))) problems.push('lightbox: focus lost after changing an option');
    await shoot(pp, 'lightbox-options', false);
    await pp.keyboard.press('Escape');
    await pp.waitForTimeout(100);
    if ((await pp.locator('.gallery').getByLabel('Mountains climbed: Period').inputValue()) !== 'overlay') problems.push('lightbox: gallery did not pick up the option changed in the viewer');
    await pp.waitForFunction(() => { const i = document.querySelector('#poster-climb') as HTMLImageElement | null; return !!i?.src && i.complete; });
    // Route posters: a period, and regions (the demo has a holiday and Zwift rides far from home).
    const overlayCard = pp.locator('.pcard', { has: pp.locator('#poster-overlay') });
    const overlaySrc = () => pp.getAttribute('#poster-overlay', 'src');
    const src0 = await overlaySrc();
    await overlayCard.locator('.regions-pick summary').click();
    if ((await overlayCard.locator('.regions-list input').count()) < 3) problems.push('regions: expected Everywhere plus at least two regions');
    await overlayCard.getByLabel('All routes: Everywhere').check();
    await pp.waitForFunction((s) => (document.querySelector('#poster-overlay') as HTMLImageElement).src !== s, src0).catch(() => problems.push('regions: ticking Everywhere did not redraw All routes'));
    if (!(await overlayCard.locator('.regions-pick[open]').count())) problems.push('regions: the menu closed after ticking a box');
    if ((await pp.evaluate(() => document.activeElement?.getAttribute('aria-label'))) !== 'All routes: Everywhere') problems.push('regions: focus lost after ticking a box');
    await shoot(pp, 'posters-regions', false);
    await overlayCard.getByLabel('All routes: Watopia (Zwift)').uncheck();
    if (await overlayCard.getByLabel('All routes: Everywhere').isChecked()) problems.push('regions: Everywhere still ticked after removing a region');
    const src1 = await overlaySrc();
    await overlayCard.getByLabel('All routes: Period').selectOption({ index: 1 });
    await pp.waitForFunction((s) => (document.querySelector('#poster-overlay') as HTMLImageElement).src !== s, src1).catch(() => problems.push('route posters: the period did not redraw All routes'));
    if (!(await pp.locator('.pcard').getByLabel('Route facets: Period').count())) problems.push('route facets: no period choice');
    // Privacy: route ends are hidden by default, and the choice redraws the poster.
    const hide = overlayCard.getByLabel('All routes: Hide route ends');
    if ((await hide.inputValue()) !== '200') problems.push('privacy: route ends are not hidden by default');
    const src2 = await overlaySrc();
    await hide.selectOption('1000');
    await pp.waitForFunction((s) => (document.querySelector('#poster-overlay') as HTMLImageElement).src !== s, src2).catch(() => problems.push('privacy: Hide route ends did not redraw All routes'));
    if ((await pp.locator('.pcard').getByLabel('Route facets: Hide route ends').inputValue()) !== '1000') problems.push('privacy: Hide route ends is not shared by both route posters');
    await overlayCard.locator('.thumb').click();
    await pp.waitForSelector('.lightbox');
    if (!(await pp.locator('.lb-settings .regions-pick').count())) problems.push('regions: no region choice in the viewer');
    await a11y(pp, 'lightbox-regions');
    await pp.keyboard.press('Escape');
    await pp.waitForTimeout(100);
    // Regression: after visiting an activity, closing the viewer must stay on the gallery (it used to reopen the activity).
    await pp.getByRole('button', { name: 'Stats', exact: true }).first().click();
    await pp.locator('.link.name').first().click();
    await pp.waitForSelector('#activity-title');
    await pp.locator('.nav').getByRole('button', { name: /^Posters/ }).click();
    await pp.waitForSelector('.gallery');
    await pp.locator('.thumb').nth(1).click();
    await pp.waitForSelector('.lightbox');
    await pp.keyboard.press('Escape');
    await pp.waitForTimeout(150);
    if (!(await pp.locator('.gallery').count()) || (await pp.locator('#activity-title').count())) problems.push('lightbox: closing it after visiting an activity left the posters page');
    // Back walks the views in order: posters → activity → stats.
    await pp.goBack();
    await pp.waitForSelector('#activity-title').catch(() => problems.push('history: Back from posters did not return to the activity'));
    await pp.goBack();
    await pp.waitForSelector('#records').catch(() => problems.push('history: Back from the activity did not return to stats'));
    await pp.goForward();
    await pp.goForward();
    await pp.waitForSelector('.gallery').catch(() => problems.push('history: Forward did not return to posters'));
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
    await ctx.route(/tile\.opentopomap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: fakeTile() }));
    await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 403, body: 'Referer is required' }));
    const page = await ctx.newPage();
    watch(page, 'upload');
    await page.goto(ORIGIN);
    await page.setInputFiles('input[type=file] >> nth=0', 'screenshots/_upload.zip');
    await page.waitForSelector('#export', { timeout: 60_000 });
    const report = await page.textContent('#issues + p');
    console.log('upload report:', report);
    if (!/3 skipped/.test(report ?? '')) problems.push(`unexpected import report: ${report}`);
    // A tile server that refuses us (OpenStreetMap without a referrer) leads to an explanation and the other background.
    await page.locator('.link.name').first().click();
    await page.waitForSelector('#activity-title');
    await page.getByRole('button', { name: /Use Outdoor/ }).click({ timeout: 10_000 }).catch(() => problems.push('map: refused tiles did not offer the other background'));
    await page.waitForSelector('.detail .tiles img[src*="opentopomap"]', { timeout: 5000 }).catch(() => problems.push('map: switching to OpenTopoMap after a refusal failed'));
    // GitHub Pages style sub-path hosting: relative asset and worker URLs must still resolve.
    const pages = servePages('/ride-atlas/', 4180);
    const gctx = await fakeTiles(await browser.newContext({ viewport: { width: 1100, height: 800 } }));
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
      const bctx = await fakeTiles(await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }));
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
      await bp.waitForFunction(() => Array.from(document.querySelectorAll('.pcard img')).every((i) => (i as HTMLImageElement).src && (i as HTMLImageElement).complete), undefined, { timeout: 60_000 });
      console.log(`big: all posters rendered in ${Date.now() - t1} ms`);
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
