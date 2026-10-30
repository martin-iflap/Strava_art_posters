# Ride Atlas

**Turn your Strava data export into detailed stats and poster-quality art, privately, in your browser.**

Drop in the ZIP that Strava gives you and get totals by year/month/week/weekday and sport, records and streaks, time in heart-rate and power zones, your most-ridden routes, and five downloadable posters (route facets, all-routes glow overlay, calendar heatmap, elevation ridgelines, season overview) as PNG or SVG, plus CSV/JSON exports.

## Privacy

Everything happens inside your browser tab. There is no server, no account, no analytics, no fonts or map tiles from the internet. The page ships with a strict Content-Security-Policy (`connect-src 'none'`), and an automated check fails the build if the app makes any network request. Your files are never uploaded. Ride Atlas is an independent project and is not affiliated with Strava.

## How to get your Strava export

1. On strava.com open **Settings → My Account → Download or Delete Your Account → Get Started**.
2. Choose **Request Your Archive**. Strava emails you a link (it can take a while).
3. Download the ZIP. You do not need to unpack it; drop the ZIP (or the extracted folder) onto Ride Atlas.

Don't have an export handy? Click **Try with demo data**. It is entirely made up.

## Using it

- **Stats**: overview, records, by sport/year/month/weekday/week, time in zones (set max or threshold heart rate and FTP), most-ridden routes (a heuristic, labelled as such), a sortable activity list and the import report (skipped/unreadable files with reasons).
- **Posters**: pick a poster, theme (light, dark, ember, aurora) and size (A3 portrait, square, phone wallpaper), optionally add a stats strip, then download PNG or SVG.
- Filters (sport, km/mi, local/UTC time zone) apply everywhere. Light/dark follows your system, with a manual toggle.
- **Export**: activities, monthly, yearly, sports and zones as CSV, or everything as JSON.

## Run it yourself

```bash
npm install
npm run dev        # development server
npm run build      # static site in dist/ (relative paths: works under any sub-path)
npm test           # unit tests
npm run check      # tests + build + browser checks (needs Chromium for Playwright)
npm run perf       # timings on a ~2,700 activity synthetic export
npm run fixtures   # write a fake export to fixtures/ (folder + ZIP)
```

### Publishing on GitHub Pages

The build uses relative URLs, so it works from `https://<user>.github.io/<repo>/` with no configuration. `.github/workflows/pages.yml` builds and deploys `dist/` on every push to `main`; enable **Settings → Pages → Source: GitHub Actions**.

### Screenshots

Screenshots are not committed. `npm run check` (or `npm run screenshots` after `npm run build`) renders every screen and poster from demo data into `screenshots/`, in light and dark and at desktop and phone widths.

---

# Project spec (source of truth for development)

A static, client-only web app. The user drops in their Strava data export and gets (1) detailed stats and (2) shareable, poster-quality visualizations, all downloadable. Nothing ever leaves the browser.

This file is the source of truth. Read it fully before doing anything. If something here conflicts with your instinct, follow this file.

---

## 1. Hard constraints

- **Static site only.** No backend, no accounts, no database, no API keys, no Strava login/API.
- **Zero network requests at runtime.** No analytics, no CDN scripts/fonts, no map tiles, no telemetry. Everything is bundled. Add a strict Content-Security-Policy meta tag (`default-src 'self'`; allow `blob:`/`data:` for images only).
- **All parsing happens in the browser.** Files are never uploaded anywhere.
- **Minimal dependencies.** Vite + TypeScript + vanilla DOM (no UI framework). Allowed extras: a small FIT parser (e.g. `fit-file-parser`), `fflate` (gzip), `vitest`, `playwright`. Anything else needs a one-line justification in the commit message. Draw all charts and posters yourself with SVG/canvas, no chart libraries.
- **Never use real personal data.** Tests and screenshots use only generated fake data.

## 2. Input: the Strava export

Strava's "Download your data" export contains `activities.csv` plus an `activities/` folder of per-activity files (`.gpx`, `.tcx`, `.fit`, and `.fit.gz` / `.gpx.gz` variants). The user may drop the whole ZIP, or the extracted folder.

- Accept: the ZIP, a folder, or multiple files via drag-and-drop and a file picker.
- `activities.csv` is the index (date, type, name, distance, moving time, elevation, etc.). Per-activity files add GPS tracks, heart rate, power, cadence and elevation streams.
- Be defensive: columns differ by language/account, files can be missing or corrupt. Skip bad activities, count them, and show "N activities skipped" with a reason list. Never crash on bad input.
- Handle large exports (thousands of activities) without freezing the UI: parse in a Web Worker, show progress.

## 3. Stats (must be correct and tested)

- Activities, distance, moving time, elevation: per **month, year, week, weekday**, and all-time.
- Averages and bests: avg/median distance, speed, HR, power, longest ride, biggest climb, streaks, most active day/month.
- **By sport** (Ride, Run, Walk, Swim, etc.): all of the above, split per sport, with a sport filter across the whole app.
- **Time in zones:** heart-rate zones (default 5-zone, user-configurable via max HR or threshold HR) and power zones (from FTP, if power data exists). Show per activity, per month, per year, all-time. If a stream is missing, say so instead of showing zeros.
- **Most ridden loops/routes:** resample each GPS track to a fixed number of points, cluster similar routes (document the similarity method and threshold in code comments), and list the top routes with count, avg time, best time and a small route preview. It is a heuristic, so label it honestly.
- Handle units (km/mi toggle), time zones, and activities with missing fields.

## 4. Visualizations (the fun part)

All viewable in-app AND downloadable as PNG (high-res, poster-sized) and SVG where practical. Each poster can optionally include a stats strip (totals, year, sport).

1. **Route facets:** a grid of every activity's route as a small thin line on a blank background (the style of github.com/marcusvolz/strava "facets"). Sortable by date/distance.
2. **All routes overlay / heatmap:** every route drawn on one canvas, with glow-style blending, normalized to fit.
3. **Calendar heatmap:** a year of days, GitHub-contribution style, by distance or time.
4. **Elevation ridgelines:** stacked elevation profiles (joyplot style) for a selection of activities.
5. **Season overview poster:** monthly distance/time bars plus key totals.

Posters need a choice of a few themes (light, dark, and one or two accent palettes) and a size picker (e.g. A3 portrait, square, phone wallpaper). No map tiles or external imagery, just clean line art.

## 5. Export

- Posters: PNG + SVG (where the poster is SVG-based).
- Stats: **CSV** (per-activity table, monthly table, yearly table, zones table, sport table) and **JSON**.
- A clearly labelled "Export" area; filenames include the date range and sport.

## 6. Design

Minimal, premium, modern, **Apple-style (macOS/iOS feel)**:
- System font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`). No webfonts downloaded.
- Generous whitespace, large corner radii, soft shadows, subtle translucency/blur on toolbars and sheets, hairline separators.
- iOS-style segmented controls, pill buttons, toggles, and sheets. Sidebar + content layout on desktop, tab-style layout on mobile.
- Light and dark mode following `prefers-color-scheme`, with a manual toggle.
- Smooth, restrained animations (150-250ms). Respect `prefers-reduced-motion`.
- Take the *style* only. Do not use Apple logos, SF font files, or Strava branding or logos anywhere. The app is unaffiliated with Strava.
- Responsive and accessible: keyboard navigation, visible focus states, sufficient contrast, ARIA labels on controls.
- A friendly empty state explaining how to get the Strava export, with a built-in "Try with demo data" button that uses the generated fake dataset.

## 7. Testing and verification (this is how you check your own work)

- **Fixture generator:** write `scripts/generate-fixtures.ts` that produces a realistic fake Strava export (several years, rides/runs/walks, GPX/TCX/FIT-like data, HR/power, a few deliberately corrupt files, a few repeated loops). Output goes to `fixtures/` (commit the generator, not huge outputs; keep committed fixtures small).
- **Unit tests (Vitest)** for: CSV parsing, each stream parser, every stats function (with hand-computed expected values), zone calculation, loop clustering, CSV export format, unit conversion.
- **Visual checks (Playwright, headless):** screenshot the key screens with demo data (home, each poster type, light and dark, desktop and mobile width) into `screenshots/` (gitignored). **Look at the screenshots yourself** and fix layout bugs, clipped text, empty charts and ugly spacing. Also fail the check on any console error or any network request.
- If Playwright browsers cannot be downloaded in your sandbox, say so once and fall back to checking the SVG/DOM output programmatically and rendering SVGs to PNG with another available tool. Do not burn time fighting the environment.
- Provide `npm test`, `npm run build`, and `npm run check` (tests + build + screenshot script). Run `npm run check` before every milestone is declared done.

## 8. Git rules (important)

- **At most 6 commits in the entire project.** One commit per milestone, and a final polish commit if needed.
- Within a milestone, do not create extra commits. Use `git commit --amend --no-edit` to fold work in.
- Do not commit generated build output, `node_modules`, screenshots, or large fixtures.
- Push only at the end of a milestone (use `--force-with-lease` on your own branch if you amended after a push). Never touch the main branch history of anything else.
- Commit messages: short, imperative, one line plus a few bullets at most.

## 9. Budget and working style

- Be economical. Do not re-read large files you already know. Do not rewrite files that work. Do not generate screenshots more often than needed, and cap visual-fix loops at 3 rounds per screen.
- Work in **milestones** and **stop after each one** with a short report (what works, what's rough, what's next). Do not start the next milestone on your own.
- Do not ask questions unless truly blocked. Make reasonable decisions and note them in `DECISIONS.md` (short, append-only).
- No scope creep: do not add features not listed here.

## 10. Milestones

**M1: Foundation.** Project scaffold, fixture generator, parsing pipeline (ZIP/folder, CSV, GPX/TCX/FIT, gzip) in a worker, full stats engine, zones, tests, CSV/JSON export, and a plain functional UI (import screen, stats tables). Tests green.

**M2: Visualizations and exports.** All five poster types, themes and sizes, in-app viewing, PNG/SVG download, loop detection UI, sport filter and unit toggle. Playwright screenshot checks working.

**M3: Design polish and docs.** Full Apple-style design pass (light/dark, mobile layout, animations, empty states, demo data), accessibility pass, performance with a large synthetic export (e.g. 3,000 activities), a user-facing README section ("How to get your Strava export", privacy statement, screenshots section) and a GitHub Pages-compatible build (correct `base` path). Everything passes `npm run check`.

## 11. Definition of done

A user can drop a Strava export, see correct stats and all five visualizations in a polished Apple-style UI, download posters and CSV, and nothing ever leaves their browser. `npm run check` passes. At most 6 commits.
