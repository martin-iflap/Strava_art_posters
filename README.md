# Ride Atlas

**Turn your Strava export into detailed stats and printable posters, privately, in your browser.**

Drop in the ZIP that Strava gives you. Ride Atlas shows your totals by year, month, week, weekday and sport, training load (fitness, fatigue and form) worked out the way TrainingPeaks does it, a training calendar, power, heart-rate and pace curves, best efforts, records and streaks, time in heart-rate, power and pace zones, your most-ridden routes, and a page for every activity. It also makes eighteen posters you can download as PNG, JPEG or SVG. Nothing is uploaded: there is no server, no account and no tracking.

## Privacy and safety

Everything happens inside your browser tab. Your files never leave your device.

- **Only what it needs is read.** Ride Atlas uses `activities.csv` and the GPX, TCX and FIT activity files, and nothing else. Photos, videos, messages, your profile and contacts are skipped by name and never opened. From a ZIP it reads the archive's table of contents and then only the activity entries, so the photos in a large export are not even loaded.
- **Nothing is kept.** Your activities live in the tab's memory and are gone when you close or reload it. Two settings are remembered in the browser: light/dark theme and map background.
- **The only network traffic is map pictures.** Activity maps show an OpenStreetMap background by default (OpenTopoMap is the other choice). Like any web map, the tile server sees your IP address and which map squares you look at, so roughly where the activity you opened was. Set **Filters → Map background → Off** and the app makes no requests at all.
- **Enforced by the browser, not just promised.** A strict Content-Security-Policy allows scripts only from the app itself, images only from the app and the two tile servers, and no connections at all (`connect-src 'none'`). Even buggy or tampered code has no way to send your data anywhere.
- **Posters protect your home.** Route posters leave out the first and last 200 m of every route by default (**Hide route ends**: off, 200 m, 500 m or 1 km), so the place you usually start is not on them. A poster of many routes can still hint at your part of town, so look before you post. The other posters show no places, and CSV/JSON exports contain no GPS tracks.
- **Hostile files are handled safely.** File contents are only ever treated as data: text is shown as plain text, never as HTML, and spreadsheet formulas in exports are neutralised. A file that would unpack to more than 256 MB is refused, so a malicious ZIP cannot exhaust memory.

[SECURITY.md](SECURITY.md) has the full threat model, the hosting headers and how to report a problem.

## Get your Strava export

1. On strava.com open **Settings → My Account → Download or Delete Your Account → Get Started**.
2. Choose **Request Your Archive**. Strava emails you a download link; this can take a few hours.
3. Download the ZIP and drop it onto Ride Atlas as it is. An extracted folder works too.

No export yet? Click **Try with demo data**. The demo rider and their activities are entirely made up.

## What you get

- **Training load.** Training stress for every activity as TrainingPeaks scores it: TSS from power and FTP, rTSS from normalized graded pace and threshold pace for runs, otherwise hrTSS from heart rate. Dated thresholds, so older activities use the FTP of their day. The fitness / fatigue / form chart (CTL, ATL, TSB) with a plain-language reading, daily TSS dots, drag-to-zoom and a summary of the period in view; weekly stress stacked by sport, chosen by half-year; fitness per sport; an aerobic-efficiency trend; a training calendar; and estimates of FTP and threshold pace.
- **Curves and best efforts.** Best power, heart rate and pace for every duration (about 120 points from 1 s to 10 h), all time against the last 12 months, with a critical-power model (CP and W′), W/kg, a peak-power-by-year table, and the activity behind any point you select. Your fastest 400 m to marathon for runs and 5 km to 100 miles for rides.
- **Stats.** An overview with a goal for the week, month or year, year-to-date and weekly progress charts (any half-year), the Eddington number, records and streaks, tables by sport, year, month, weekday and week, time in zones for any year or the last 12 months, with the low / moderate / high intensity mix (set your max or threshold heart rate, FTP and threshold pace), most-ridden routes, a sortable activity list and an import report listing any skipped files and why. Click a row (a year, a sport, a record, a route) to list its activities.
- **Activity pages.** A route map you can drag and zoom, full-width elevation, speed, heart-rate and power charts with a shared hover readout that zoom together when you drag across one, effort numbers (TSS or rTSS or hrTSS, intensity factor, normalized power, normalized graded pace, variability index, work, efficiency factor, aerobic decoupling), power and pace curves against your best, heart-rate, power and pace zones, best efforts with PR badges, zones, per-km or per-mile splits, and how the activity ranks against your others and against repeats of the same route.
- **Posters.** Route facets, all routes, calendar heatmap, elevation ridgelines, season overview, activity bubbles, time-of-day ridges, weekly rhythm, year rings, year over year, mountains climbed, around the world, time of day by weekday, landscape, to space, and three abstract ones: route bloom (every route from one centre, like petals, optionally kaleidoscopic), stream of seasons (weekly volume per sport as flowing ribbons) and year spiral (one turn per year, a stroke per day). Choose a theme (light, dark, ember, aurora) and a size (A3 portrait, square, phone wallpaper), add an optional stats strip, tune each poster, and download one as PNG, JPEG or SVG or all of them as a ZIP.
- **Exports.** Activities, monthly, yearly, sport and zone tables as CSV, or everything as JSON.
- Filters for sport, km/mi and local/UTC time apply everywhere. The sidebar folds away for more room. Light and dark mode follow your system, with a manual switch. Browser Back and Forward work throughout.

Ride Atlas is an independent project and is not affiliated with Strava.

## Development

Requires Node.js 22.

```bash
npm install
```

```bash
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with live reload |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run screenshots` | Browser checks on the built site with Playwright: every screen and poster in light/dark and desktop/phone, accessibility, no console errors, and no network requests besides map tiles. Images go to `screenshots/` (not committed) |
| `npm run check` | All of the above; run it before merging |
| `npm run examples` | Re-render the example posters shown on the import page (`public/examples/`) |

The code is TypeScript with no UI framework. `src/parse` reads the export inside a Web Worker, `src/stats` computes the numbers, `src/posters` draws every poster as SVG, and `src/main.ts` builds the interface. Tests and screenshots only use the generated demo data in `src/demo`, never a real export.

## Deploying

`npm run build` produces a static site in `dist/` with relative paths, so it works on any static host and under any sub-path. The build also writes `dist/_headers` with the security headers, which Cloudflare Pages and Netlify apply automatically.

**Cloudflare Pages:** in the dashboard choose **Workers & Pages → Create → Pages → Connect to Git**, pick this repository and set:

- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variable: `NODE_VERSION` = `22`

Every push to `main` is then published, and other branches get preview URLs. Leave Cloudflare Web Analytics off: the security policy would block its script anyway.

On another host, set the headers listed in [SECURITY.md](SECURITY.md) yourself and serve the site over HTTPS.

## License

[MIT](LICENSE)
