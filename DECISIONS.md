# Decisions (append-only)

## M1
- Tooling: Vite + TypeScript + vanilla DOM, vitest, playwright, fflate, fit-file-parser (its bundled encoder is used to build FIT fixtures).
- GPX/TCX are parsed with regex scanning, not DOMParser (unavailable in Web Workers and in plain Node tests).
- File formats are detected by content (FIT magic, gzip magic, ZIP magic, XML root), never by extension.
- CSV: duplicate headers handled (Strava has two "Distance": rounded km, then metres; the last one wins). English plus a few translated header aliases; if headers are unrecognised, stock column positions are used. Dates parsed as UTC.
- A row with a corrupt/missing track file is KEPT using CSV numbers and listed as a warning ("loaded without track data"). Only unusable rows (bad date, no type, duplicate id) count as skipped. Orphan track files are ignored with a note; with no activities.csv, activities are built from track files alone.
- Activities store compact derived data instead of raw streams: HR and power histograms (seconds per bpm/watt), a 256-point route, and a 100-point elevation profile. Zones are recomputed from histograms, so changing max HR/FTP is instant and memory stays small.
- Time per sample = gap to next sample; gaps > 30 s are pauses (0 s). Moving time = samples with speed ≥ 0.5 m/s. CSV values win over file-derived ones.
- Elevation gain from streams uses a 2 m hysteresis.
- Averages: avg speed = total distance / total moving time; avg HR/power weighted by moving time.
- Default max HR = highest recorded plausible HR (≤ 230). HR zones: % of max (60/70/80/90) or Friel LTHR (85/90/95/100). Power: Coggan 7 zones from FTP, shown only if FTP is entered.
- Day/week/month bucketing uses the browser's local time zone by default (toggle: UTC). Weeks are ISO weeks (Mon start). Streaks are consecutive calendar days; "current" streak is relative to the last activity in the data.
- Route clustering: greedy, symmetric Chamfer distance (point-to-segment) ≤ 80 m, length within 15 %, direction-agnostic; documented in src/stats/routes.ts. Runs on the main thread for now (performance pass is M3).
- CSV export: text fields beginning with = + - @ get a leading apostrophe (formula-injection guard). Headers carry units; units follow the UI toggle.
- The fixture generator lives in src/demo/generate.ts (pure TS, also powers the in-app demo button); scripts/generate-fixtures.ts writes it to gitignored fixtures/. Tests generate data in memory, so no fixtures are committed.
- CSP is injected only in production builds (dev server needs inline HMR); the screenshot check serves the production build so CSP violations surface as console errors.
- ZIPs are read fully into memory (fflate); entries are inflated lazily one at a time.

## M2
- Posters are pure functions (activities + options → SVG string) in src/posters/; the SVG viewBox is always 1000 units wide, and width/height attributes carry the output pixel size (A3 3508×4961, square 3000², phone 1290×2796). PNG = SVG drawn to a canvas via a blob: URL (CSP-safe); SVG is downloaded as is.
- Themes: light, dark, plus two accents (ember, aurora). Poster text uses the system font stack, so PNG typography depends on the viewer's installed fonts.
- Route overlay fits to the 2nd–98th percentile of all points and clips the rest, so one far-away trip does not shrink everything else. Glow = blurred wide stroke + thin crisp strokes via `<use>` (no blend modes, for portability).
- Calendar shows up to the 8 most recent years, colour levels by quartiles of non-zero days. Ridgelines use equal-width profiles (not distance-proportional) scaled by the 90th-percentile elevation range; selection = most recent / longest / biggest climbs, N of 15–60.
- Season overview covers one calendar year (picker); it already shows totals, so the optional stats strip is not drawn on it.
- Sport filter, unit toggle and loop-detection UI already shipped in M1; they now also drive the posters.
- Screenshot check also downloads each poster as PNG and SVG and verifies pixel dimensions.

## M3
- Layout: sidebar (views, section links, filters, theme toggle) + content on desktop; on ≤820 px the sidebar collapses to a top bar, with a bottom tab bar (Stats / Posters / Filters / New) and filters in a bottom sheet. Translucent blurred surfaces, 20 px radii, 150–220 ms transitions, all disabled under prefers-reduced-motion.
- Theme: Auto (system) / Light / Dark, remembered in localStorage (wrapped in try/catch; the app works without it).
- Accessibility: skip link, landmarks, aria-current/pressed/expanded, keyboard-focusable named scroll regions, visible focus rings. `axe-core` added as a devDependency (justification: automated WCAG A/AA check of the home, stats and posters screens inside `npm run check`; serious/critical violations fail the check).
- Performance (npm run perf, ~2,660 activities / 92 MB): import ≈ 5.6 s in the worker, stats ≈ 10 ms, route clustering ≈ 0.4 s (main thread, cached per sport), heaviest poster (facets/overlay) ≈ 0.15–0.3 s. In the browser the worst main-thread stall during a big import was < 1 s, so clustering stays on the main thread.
- GitHub Pages: `base: './'` (relative URLs) works under any sub-path; `npm run check` serves dist/ under `/ride-atlas/` and loads the demo to prove it. A Pages deploy workflow is included (runs on `main`).
- README: user-facing section on top, the original spec kept below. Screenshots are NOT committed (git rules); the README explains how to generate them.

## M4 (audit, more posters, single-activity view)
- Audit fixes: CSV distance no longer falls back to the rounded km column silently mis-scaled (metres column wins; km×1000 only if empty); lone renamed CSV accepted; narrow no-break space in AM/PM dates; FIT running cadence doubled to steps/min; focus is restored after every re-render (keyboard users keep their place); files dropped outside the drop zone no longer navigate the tab away; import can be cancelled; search/zone forms submit with Enter; PNG export retries at 75 %/50 % size when a browser (Safari) refuses a 17 MP canvas; sticky sidebar blur disabled on mobile (it re-anchored the filters sheet in Safari); calendar/rings/cumulative subtitles and totals only count the years actually drawn; plural forms ("1 day"); records table alignment; very large ZIPs give an actionable message.
- New posters (inspired by marcusvolz/strava: facets, map, elevations, calendar, ridges, packed circles): activity bubbles (packed circles, area = distance, ≤ 1,000 largest), time-of-day ridges (KDE of start times by year/month/weekday, circular so 23:30 is near 00:30), weekly rhythm (weekday × hour punch card), year rings (polar calendar), year over year (cumulative lines). I could not browse the repos from this environment, so the list follows my knowledge of them.
- Activities now also store speed/HR/power series (100 bins along distance) and km-split times; mile splits are interpolated from the km table.
- Single-activity page: state-based view with history entries (Back works, "Back to stats" skips stacked entries and restores scroll). Route-repeat info reuses the cached clustering; its time ranking is among members of the cluster.

## M5 (polish: gallery, month tables, mountains poster)
- Month tables (stats and zones) showed every month in a 440 px scroll box, so only the latest year was visible without scrolling inside it. They now have a year picker (latest year by default, or "All"), shared by all month tables.
- Posters page is a gallery: all posters in a 2-column grid (1 on phones), global theme/size/strip on top, per-poster settings and PNG/SVG on each card, "Download all" as a ZIP (PNG or SVG, built with fflate, stored uncompressed). Posters render one per task and are cached per settings, so a big export does not freeze the page and changing one setting redraws only that poster.
- Full-screen viewer: dialog with prev/next buttons, ←/→ keys (wraps around), swipe, Escape, focus trapped inside and returned to the thumbnail.
- New "Mountains climbed" poster: activities in date order, each starting at the distance and elevation where the previous ended (so the line ends at total distance, total gain). Within an activity the gain follows its elevation profile's uphill parts; without a profile it rises linearly. Next to it, towers of Everest (8,849 m), Mont Blanc (4,806 m) and Olympus (2,918 m) on the same vertical scale, cut off at the total, and the fractional count of each. When one mountain would be drawn under 30 units tall, one drawn mountain stands for 2/5/10/… (labelled "each = N"). Scope: one year (latest by default) or all time. Mountain sketches are hand-drawn polygons, no imagery.
- Git: the spec caps the project at 6 commits and that was already reached; this follow-up work is one extra commit rather than rewriting the earlier milestones.

## M5 follow-up
- Mountains climbed: the stacked mountain drawings are gone (with a few years of data they became stripes), and so is the area fill; the line stays. The headline keeps the Everest / Mont Blanc / Olympus counts and adds the next "straight up" milestone: share of the way to space (Kármán line, 100 km), then to the ISS orbit (~408 km), then multiples of it. New period option "All years overlaid": one line per year (most recent 8), each from zero, labelled with its total; the headline then counts all of those years.
- Around the world (new): total distance wound clockwise around a line-art globe (no tilt, equator in the accent colour), one ring per 40,075 km lap (equator), segments coloured by year, quarter-lap marks. Headline: laps, share of the 384,400 km to the Moon, total. Default period all time, or a single year.
- Time of day by weekday (new): the time-of-day ridges for one year (latest by default) with a row per weekday. Weekday rows no longer highlight the last row in the accent colour (that only means something for years).
- Posters are easier to find: a banner at the top of the stats page with three live thumbnails and an "Open the poster gallery" button, a poster count badge in the sidebar, and the home screen tagline mentions posters.
- The full-screen viewer is a history entry: browser Back / the phone back gesture closes it instead of leaving the page.
- Fix: section headings inside wrapper divs (Records, Time in zones, Routes, Activities, Export, Import report) had lost their top margin because of a blanket `h2:first-child` rule.
