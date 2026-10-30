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
