# Round 4 plan

Sixteen requests from the owner, grouped into seven steps. Each step is one commit that leaves the app working
(`npm run check` green), so work can stop after any step. Numbers in brackets refer to the owner's list.

Guiding rules for every step:
- Keep modules small and single-purpose; new logic that can be pure (clustering, poster maths) goes in its own
  file with unit tests, the DOM code in `main.ts` / `detail.ts` only wires it up.
- No new dependencies unless they remove more code than they add.
- Every new interactive element is a real `<button>`/`<select>` with a label (keyboard and screen readers),
  and the screenshot check gets an assertion for it.
- Note decisions in `DECISIONS.md` (append-only) and keep the README feature list current.

## Step 1 – Navigation and first impressions  [1, 2, 3, 7, 8]

1. **Theme selector centred** in the sidebar footer (desktop); unchanged in the mobile header.
2. **Poster options inside the full-screen viewer.** `posterSettings()` takes an `onChange` callback, so the same
   controls are used on the gallery card and in the viewer bar; changing one re-renders the poster on screen
   (the gallery behind it updates too). The viewer's focus trap includes the selects.
3. **Leaving the viewer returns to the gallery.** Root cause: switching Stats ⇄ Posters did not touch the
   browser history, so after visiting an activity the entry under the viewer still said "activity" and Back
   reopened it. Fix: one small history model. Every entry carries `{ view, activity?, depth?, lightbox? }`;
   the nav pushes `#posters` / `#stats`, the activity view pushes on top, the viewer pushes on top of the
   gallery. A single `popstate` handler restores the view from the entry and does nothing when the view is
   unchanged (which is the case when only the viewer closes). Browser Back now also moves between Stats and
   Posters, as users expect.
4. **Import page explains the app** [7]: what you get (stats, 13 posters, activity detail), a strip of three
   example posters rendered from the demo data, how it works (files are read in the browser, a worker parses
   them, nothing is uploaded), what files are supported, and a short FAQ (privacy, Strava archive wait,
   which data is used).
5. **Link to gpx-to-fit.pages.dev** [8]: on the import page ("Forgot to record a ride? …") and in the sidebar
   footer, opened in a new tab with `rel="noopener noreferrer"`.

## Step 2 – Maps  [6, 13, 14]

1. **Why OpenStreetMap tiles fail** [14]: tile.openstreetmap.org requires an accurate `Referer` and blocks
   requests without one; a page opened from `file://` (the build uses relative paths, so that works for the
   rest of the app) or served with `Referrer-Policy: no-referrer` sends none, and OSM answers with a
   "Referer is required" picture. Fixes: tiles become HTML `<img referrerpolicy="strict-origin-when-cross-origin">`
   in a layer under the SVG route (explicit policy, browser lazy-loading/decoding, cheaper to move while
   panning), `<meta name="referrer" content="strict-origin-when-cross-origin">` in `index.html`, and on
   `file://` the app explains that map backgrounds need the app served over http(s) and falls back to
   OpenTopoMap, which does not require a referrer.
2. **OpenStreetMap is the default background** [6], listed first. Off is still one click away (Filters → Map
   background, remembered). Privacy text in the UI and README is updated to say maps are on by default.
3. **Pan and zoom on the activity map** [13]: a `MapView` (centre + fractional zoom) in `src/map.ts`; drag to pan,
   wheel / pinch / double-click / +− buttons to zoom, a "fit route" button, keyboard arrows and +/−.
   Tiles are fetched at the integer zoom nearest the view and scaled in between, so the route fills the map
   exactly (also fixes "route only fills half the box"). Hover sync with the charts keeps working.
   Small previews (loops) stay static.

## Step 3 – Clickable stats  [15, 16]

1. **Shared "activity list" panel**: a compact card grid (mini map + date, name, distance, time) in the same
   layout as the repeated-routes cards, reused everywhere a set of activities is shown. Clicking a card opens
   the activity; the panel is closable and announced to screen readers.
2. **Drill-downs** [15]: a repeated route → all its activities; Records → most active day / month / longest
   streak → those activities; By year / month / weekday / sport rows → that period's activities; calendar
   style cells in zone tables → that period. Other records already link to their activity.
3. **Selectable table rows** [16]: `table()` gets an optional `onRowClick`; rows become focusable (Enter/Space),
   the selected row is shaded grey (`aria-selected`), selection survives re-renders via state keyed by table id.

## Step 4 – Regions and periods for route posters  [4, 5]

1. **Region clustering** (pure, tested, `src/stats/regions.ts`): group activities by start point with
   single-linkage on a ~150 km threshold (grid-bucketed, so linear time). Each region is named by its
   position relative to the largest one plus activity count (e.g. "Main area · 812", "Australia-side · 34";
   no reverse geocoding — offline). Virtual rides (Zwift etc., detected by sport or by "Watopia"-style
   coordinates) naturally form their own region.
2. **Poster option "Regions"**: checklist with "Everywhere" (default = the largest region only when the others
   would shrink it to a dot; otherwise everything), used by Route facets and All routes.
3. **Time period** select for Route facets and All routes (year or all time), same control as other posters.

## Step 5 – Poster additions and compaction  [9, 10, 12]

1. **Activity bubbles** [9]: options "per year", "per sport", "all years, one cluster per year" (packed clusters
   laid out in a grid with year labels, shared scale so sizes compare across clusters).
2. **Landscape** [10]: elevation profiles of the last N activities, each scaled to the same width, filled with
   low opacity and drawn back to front, so dense overlaps go dark (as in the owner's picture). Options: count,
   selection (recent / longest / climbiest), absolute vs. relative height.
3. **Around the world, more compact** [12]: smaller headline, globe and rings use the freed space, legend
   moved beside the globe on square sizes, lap labels thinned.

## Step 6 – "To space" climbing poster  [11]

A curved ascent from the Earth's surface: the Earth as an arc at the bottom, the climb drawn as a gently
spiralling path (one turn per activity block, not a straight line) up through labelled altitude marks
(Everest, Kármán line, ISS, … and the Moon when the total reaches it, with a scale break so the Moon fits).
Two variants as an option: elevation gain (climbed) and total distance (if every km went straight up).

## Step 7 – Clean-up and verification

Review pass over the round's diff (dead code, duplicated helpers, CSS for new parts in dark/light/mobile),
README + DECISIONS update, performance check with the big fixture (`npm run perf`), full `npm run check`.
