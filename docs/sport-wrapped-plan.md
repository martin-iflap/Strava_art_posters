# Sport Wrapped: plan

A year-in-review story in the style of Spotify Wrapped. You pick a year, or all time, and get a full-screen
sequence of animated cards, one number per card, ending in a summary card you can download and share.
**Built** (in `src/wrapped/`); this was the plan, kept for the reasoning. Differences from it: the banner on the stats page shows only from
15 December to 15 January (otherwise Wrapped is under Records and in the sidebar); every card carries a chart and
the look follows the app's dark theme with one accent colour; three light-hearted cards were added (earliest and
latest start, longest break, activity names); the summary picture is PNG only.

## Is it too complicated?

No. It is about the size of one earlier round of work: roughly 900 to 1,200 lines, most of it slide layouts.

- **The numbers are already there.** Totals, records, best efforts, the power curve, training load, regions,
  time of day and streaks are all worked out for the stats pages.
- **The animation is plain CSS.** Keyframes, transforms and opacity, with numbers counting up through
  `requestAnimationFrame`. The strict content-security policy is not a problem: animations live in
  `style.css` and positions are set with `style.setProperty`, as everywhere else.
- **The share image reuses the poster renderer.** The last card is an SVG turned into a PNG by the same
  code as the posters (`posters/raster.ts`), at 1080 × 1920 for phone stories.

The work is in the polish: timing, mobile layout, and making it accessible. That is design time, not technical risk.

## How it would work

1. A "Your year, wrapped" button on the stats page and in the sidebar opens a picker: each year with data, or all time.
2. The story opens as a full-screen `<dialog>`:
   - Progress bars at the top, like Instagram stories.
   - Each card advances by itself after about 6 seconds.
   - Tap the right or left half, or press the arrow keys, to move. Hold the screen or press space to pause, and Esc to close.
3. Each card animates its own way: numbers count up, bars grow, the longest route draws itself, and backgrounds shift colour from card to card.

## Cards (each shown only when the data supports it)

| # | Card | Data (already computed) |
| --- | --- | --- |
| 1 | "Your 2025, wrapped": the year and the sport mix, as coloured stripes | summary, sports |
| 2 | Distance, counting up, with an equivalent such as "a third of the way around the world" or "Lisbon to Moscow" | summary, world poster |
| 3 | Time moving in days and hours, with a bar for each sport | summary by sport |
| 4 | Climbing, in Everests, with a mountain silhouette that fills | elevation, To space poster |
| 5 | Your rhythm: favourite weekday, favourite hour, busiest month | weekday, time of day, months |
| 6 | Longest activity, with its route drawn line by line; the ends are trimmed for privacy, as on the posters | records, route |
| 7 | Biggest week and longest streak | weeks, streaks |
| 8 | Personal records set this year: best efforts and power-curve bests that beat earlier years | best efforts, peaks by year |
| 9 | Peak fitness: highest CTL, and when it was (only with thresholds set) | training load |
| 10 | Work done, in kilojoules and slices of pizza | work-done poster |
| 11 | Where you went: top regions and number of countries | regions |
| 12 | Your type, chosen by simple rules: early bird, night owl, weekend warrior, climber, metronome (steady weekly volume), explorer (many new routes) | weekday, hour, climbing, routes |
| 13 | Compared with last year: distance, time and climbing, with the change in % (not shown for all time) | summary per year |
| 14 | Summary card to download as PNG or JPEG | everything above |

**All time:** the same cards cover the whole history. "This year" becomes "since 2016", the PR card shows
all-time bests, and the comparison card becomes "your biggest year".

## Code layout

- `src/wrapped/data.ts`: a pure function `wrappedStats(activities, year | 'all', settings)` that returns the
  numbers and decides which cards exist. Unit-tested on the demo data like the other stats.
- `src/wrapped/cards.ts`: one function per card, returning an element (text plus a small inline SVG).
- `src/wrapped/player.ts`: the dialog, timers, progress bars, keyboard and touch handling, pausing, and
  focus trapping. Closing returns focus to the button that opened it.
- `src/wrapped/share.ts`: builds the summary SVG and turns it into a PNG with the poster raster code.
- CSS: one `.wrapped` block with the keyframes. Under `prefers-reduced-motion` cards cross-fade, numbers
  show at once and nothing advances by itself.

## Accessibility and privacy

- Every card's text is real text, announced through an `aria-live` region, and the whole story can be read
  with a keyboard.
- Auto-advance can be switched off with a button on the first card (browsers cannot tell when a screen reader is running), and is off under reduced motion.
- Nothing leaves the browser. Shared images keep route ends trimmed, and the regions card names only countries or regions, never start points.
- No music: the app makes no network requests, and generated sound would be a gimmick.

## Testing

- **Unit tests for `wrappedStats`:**
  - Totals match the stats page.
  - The PR card lists only records set in the chosen year.
  - The type rules give the expected result on handmade activities.
  - Cards without data are left out.
- **Screenshot check:** open the story on the demo data, step through every card with the keyboard, and look for console errors and network requests.
- **Share image:** download it and check its size.
