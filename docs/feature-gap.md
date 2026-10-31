# Feature gap: Ride Atlas vs TrainingPeaks, Strava subscription, intervals.icu, Garmin Connect

Written October 2026, from these products' current public feature sets. The question was what they offer
that we can also offer, given our constraints: everything runs in the browser, and the only input is a
Strava export (activities.csv plus GPX, TCX and FIT files).

## What we had before this round

Totals by sport, year, month, weekday and ISO week (count, distance, moving time, elevation, average and
median distance, average speed, HR and power). Records and streaks. Time in HR zones (max HR or LTHR) and
Coggan power zones (FTP). Repeated routes. Per-activity map, elevation, speed, HR and power charts, splits
and rankings. Fifteen posters.

## Added in this round

| Feature | Where others have it | Ours |
| --- | --- | --- |
| **Normalized power (NP)** | TrainingPeaks, intervals.icu, Strava ("Weighted avg power") | Per activity, from the 1 s power stream |
| **Intensity factor (IF)** | TrainingPeaks, intervals.icu | NP / FTP, with a plain-language reading |
| **Training stress score (TSS)** | TrainingPeaks, intervals.icu ("Load"), Strava ("Relative Effort", HR-based) | From power + FTP; otherwise **hrTSS** from HR against threshold HR. Marked when estimated |
| **Fitness / fatigue / form (CTL / ATL / TSB)** | TrainingPeaks PMC, Strava "Fitness & Freshness", intervals.icu "Fitness" | Chart (90 days, 1 year, all) with today's values, a form label ("Fresh", "Productive training" …) and an explanation |
| **Ramp rate** | TrainingPeaks | Change in fitness over the last 7 days |
| **Weekly training stress** | TrainingPeaks weekly summary, Strava training log | Bars for the last 26 weeks; a bar lists its activities |
| **Power curve (mean-maximal power)** | All four | 1 s to 5 h, all time against the last 12 months, per activity against your best; a point opens the activity that set it |
| **FTP estimate** | intervals.icu eFTP, Garmin, Strava | 95 % of best 20 min (last 12 months), applied with one click |
| **Best efforts** | Strava (runs), TrainingPeaks peak pace | Run distances 400 m to marathon, ride distances 5 km to 100 mi; top 3, plus PR / 2nd / 3rd badges and rank on each activity |
| **Variability index, work (kJ), efficiency factor** | TrainingPeaks, intervals.icu | Per activity |
| **Aerobic decoupling (Pw:HR / Pa:HR)** | TrainingPeaks | Per activity (≥ 20 min with HR) |
| **Year-to-date comparison** | Strava "Progress" | Cumulative distance/time/elevation per year; latest highlighted, others grey |
| **Weekly volume** | Strava profile and training log | Last 26 weeks, with the 4-week average |
| **JPEG posters** | – | Per poster, in the viewer, and "All as JPEG" ZIP |

TSS, NP, IF, decoupling and the zones are in the activities CSV export too.

## Display changes (things that were hard to read)

- **Zones.** The all-time summary was a table of seven "minutes" columns, which reached tens of thousands.
  It is now one horizontal bar per zone with range, hours and percent, the way Strava and TrainingPeaks show
  it. The same layout is on the activity pages. Year and month tables show `h:mm`, plus a total column.
- **Monthly totals** have a bar chart above the table, for distance, time or elevation. A bar selects the
  same month as the table row.
- **Summary tables** have a thin bar under the distance figure, so bigger years and months stand out without
  having to read every number.
- **Activity list:** five HR-zone minute columns became one zone bar per row. A TSS column appears once
  thresholds are set.
- **Effort numbers** on activity pages each come with a one-line explanation ("100 = one hour flat out at
  threshold", "Under 5 %: good endurance"), not just the bare acronym.
- **Thresholds** (HR and FTP) are set in one form under Training load and used everywhere.

## Still missing: possible next steps

Ranked by value for effort. ✅ = possible with export data, ⚠️ = needs input from the user, ❌ = not in the
export.

1. ✅ **Pace zones and running TSS (rTSS)** from threshold pace, for runners without HR (TrainingPeaks).
2. ✅ **Heart-rate and pace curves** (best HR and pace for every duration), next to the power curve
   (intervals.icu, TrainingPeaks).
3. ✅ **Training calendar**: month grid with each day's activities and TSS (TrainingPeaks calendar, Strava
   training log). The calendar poster has the data already.
4. ✅ **Power-duration model / critical power and W′** fitted to the power curve (intervals.icu, WKO).
5. ✅ **Efficiency factor trend**: EF over months on similar (endurance) rides, as an aerobic-fitness signal.
6. ✅ **Peak-performance table by period**: best 5 s / 1 min / 5 min / 20 min per year or month
   (TrainingPeaks "Peak Power" chart).
7. ✅ **Load by sport**: CTL split by ride, run and other, and a stacked weekly TSS chart (intervals.icu).
8. ✅ **Matched activities trend**: the existing repeated-route clusters plotted as time against date (Strava
   "Matched runs").
9. ⚠️ **W/kg**: power curve and FTP per kilogram, needs the user's weight. Strava's export has a profile
   CSV with weight, but we deliberately do not open it. A manual field would do.
10. ⚠️ **Goals**: weekly, monthly or yearly distance and time targets with a progress bar (Strava goals).
    Only browser storage is available, which we keep for two settings, so goals would be per session.
11. ⚠️ **Threshold history**: FTP and LTHR that change over time, so old TSS uses the FTP of its day
    (TrainingPeaks). Needs a small table of dated values.
12. ❌ Segments and leaderboards, planned workouts and compliance, HRV, sleep and wellness, VO2max and
    training-effect estimates from the device: none of this is in the export, or it needs Strava's servers.

## Notes on accuracy

- The export holds the original activity files, so NP, the power curve and best efforts come from the 1 s
  stream (smart-recording gaps are filled with the last value; pauses longer than 30 s are left out, like
  auto-pause).
- hrTSS weights every second by (HR / threshold HR)². With max HR set instead of threshold HR, threshold HR
  is estimated as 90 % of max, and the page says so.
- Form is yesterday's fitness minus yesterday's fatigue (the TrainingPeaks convention), and it is shown as
  of the last day in the export, not today.
