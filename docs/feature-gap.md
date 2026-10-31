# Feature gap: Ride Atlas vs TrainingPeaks, Strava subscription, intervals.icu, Garmin Connect

Written October 2026, from these products' current public feature sets. The question was what they offer
that we can also offer, given our constraints: everything runs in the browser, and the only input is a
Strava export (activities.csv plus GPX, TCX and FIT files).

## What we had before this round

Totals by sport, year, month, weekday and ISO week (count, distance, moving time, elevation, average and
median distance, average speed, HR and power). Records and streaks. Time in HR zones (max HR or LTHR) and
Coggan power zones (FTP). Repeated routes. Per-activity map, elevation, speed, HR and power charts, splits
and rankings. Fifteen posters.

## Added in the first round

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

## Added in the second round

| Feature | Where others have it | Ours |
| --- | --- | --- |
| **rTSS and normalized graded pace** | TrainingPeaks | Runs without power: every second's speed adjusted for gradient (Minetti's cost of running), then the 30 s 4th-power average; IF = NGP ÷ threshold pace |
| **hrTSS as a TRIMP score** | TrainingPeaks (hrTSS), intervals.icu (HRSS), Golden Cheetah | Banister-weighted heart-rate reserve, 100 = one hour at threshold HR; uses resting and max HR and the male/female weighting |
| **Dated thresholds** | TrainingPeaks | "Before this date, FTP / threshold HR / pace was …"; each activity is scored with the values of its day |
| **Friel heart-rate and pace zones** | TrainingPeaks defaults | Seven LTHR zones (Z1–Z5c), the cycling or running table by sport; seven pace zones from threshold pace |
| **Heart-rate and pace curves** | intervals.icu, TrainingPeaks | Next to the power curve; about 120 durations from 1 s to 10 h, so the curves are continuous |
| **Critical power and W′** | WKO, intervals.icu | Two-parameter model fitted to the 3–20 min bests, drawn over the power curve |
| **Peak power by year** | TrainingPeaks peak-power chart | 5 s, 1 min, 5 min, 20 min, 1 h per year, best year bold |
| **W/kg** | All of them | From a weight field; on the power table and FTP |
| **Threshold pace estimate** | intervals.icu, Garmin | 98 % of your best 30 minutes running |
| **Training calendar** | TrainingPeaks calendar, Strava training log | Month grid with each activity, its TSS, the day's load as shading and weekly totals |
| **Load by sport** | intervals.icu | Weekly TSS stacked by sport, and fitness per sport |
| **Efficiency-factor trend** | TrainingPeaks | EF of every ride (NP ÷ HR) and run (NGP m/min ÷ HR), with the monthly median |
| **Matched-activity trend** | Strava "Matched runs" | On an activity of a repeated route: moving time of every repeat by date |
| **Intensity mix** | intervals.icu, TrainingPeaks | Low / moderate / high share of time (Seiler's three zones) with a one-line reading |
| **Goals** | Strava goals | Distance, time or climbing for the week, month or year, with "even pace" marker. Kept for the session |
| **Eddington number** | VeloViewer, Strava add-ons | In Records, with the days needed for the next one |
| **Zoomable charts** | All of them | Drag across a chart (or press + / −) to zoom; legend entries show and hide lines; on activity pages all charts zoom together |
| **Week spans, zone periods** | Strava training log | Weekly charts and the week table by half-year (‹ 2026 Jan – Jun ›); zones for all time, last 12 months or any year |
| **Three new posters** | – | Route bloom, stream of seasons, year spiral |

## Added in the third round

| Feature | Where others have it | Here |
| --- | --- | --- |
| **Laps** | TrainingPeaks, Garmin Connect, Strava | Device laps from FIT and TCX files: time, distance, pace or speed, HR, power, NP, IF, climb, cadence; selecting a lap zooms the charts to it |
| **Garmin export** | – | The whole Garmin data export can be dropped as it is: the nested `UploadedFiles_*.zip` archives are opened, everything else skipped |
| **Remember on this device** | All (accounts) | Optional: thresholds, earlier thresholds and goal saved in this browser only; unticking deletes them |
| **Heart-rate strata poster** | – | Every activity a layer, as wide as it was long, coloured by heart rate |

## Added in the fourth round

| Feature | Where others have it | Here |
| --- | --- | --- |
| **Power numbers under fitness** | intervals.icu | Estimated FTP, CP, W′ and W/kg sit right under fitness, fatigue and form |
| **Work done poster** | – | Total kilojoules as squares by year, with equivalents (pizza, litres boiled, a car lifted, an LED bulb) |
| **Power fingerprint poster** | – | Each year's best power curve wound around a centre on a log time scale, every ride faint behind |
| **Sunrise clock poster** | – | Each activity an arc on a 24-hour dial, one ring per day, over sunrise-to-sunset at your usual start |

## Added in the fifth round

| Feature | Where others have it | Here |
| --- | --- | --- |
| **Sport Wrapped** | Strava's Year in Sport (paid, once a year) | Any year or all time, any time: up to 17 cards, each a chart of your data (three of them funny), and a shareable 1080 × 1920 picture, all made in the browser |

## Still missing: possible next steps

✅ = possible with export data, ⚠️ = needs input from the user, ❌ = not in the export.

1. ✅ **Swim TSS (sTSS)** from threshold swim pace (TrainingPeaks: IF³ × hours × 100). Strava's pool swims rarely carry streams, so it would mostly use the CSV averages.
2. ✅ **Per-activity HR zones by sport in the totals**: the "all sports" zone totals use one zone table (cycling or running); TrainingPeaks keeps one set per sport.
3. ✅ **Interval detection** (work/rest blocks from the power or pace stream, for files without laps; device laps are read already).
4. ✅ **Segment-like climbs**: detect named-less climbs (length, gradient, VAM) and rank repeats of them.
5. ✅ **Garmin activity names**: the Garmin export's `summarizedActivities` JSON has names and could be matched to the FIT files by start time.
6. ❌ Segments and leaderboards, planned workouts and compliance, HRV, sleep and wellness, VO2max and training-effect estimates from the device: none of this is in the export, or it needs Strava's servers.

## How the numbers are worked out (and how close they are to TrainingPeaks)

TrainingPeaks' help pages could not be opened from the build environment, so this follows their published
definitions and the open re-implementations (Golden Cheetah, intervals.icu) that match them.

| Number | Formula | Same as TrainingPeaks? |
| --- | --- | --- |
| Normalized power | 30 s rolling mean of the 1 s power stream, 4th power, mean, 4th root. Zeros (coasting) count | Yes |
| IF, TSS | IF = NP ÷ FTP; TSS = seconds × IF² × 100 ÷ 3600 (seconds of the power stream) | Yes |
| rTSS | IF = NGP ÷ threshold pace; same TSS formula over moving time | Same definition; NGP's exact grade model is TrainingPeaks' own, ours is Minetti's cost curve over ±5 s |
| hrTSS | Σ seconds × HRr·e^(k·HRr), ÷ the same for one hour at LTHR, × 100; HRr = (HR − rest) ÷ (max − rest), k = 1.92 men / 1.67 women | Close, not identical: TrainingPeaks uses an unpublished zone table. This is the TRIMP method intervals.icu and Golden Cheetah use for the same purpose |
| Priority | Power, then pace (runs), then heart rate | Yes |
| CTL / ATL | CTL += (TSS − CTL) ÷ 42 each day, ATL with 7; rest days count as 0; starts at 0 on the first day | Yes (TrainingPeaks lets you set a starting value) |
| TSB | Yesterday's CTL − yesterday's ATL | Yes |
| Ramp rate | CTL change over 7 days | Yes |
| EF | NP ÷ avg HR (rides); NGP in m/min ÷ avg HR (runs) | Yes for rides; TrainingPeaks shows run EF in yards per minute |
| Decoupling | Output per beat in the first half of the moving samples vs the second (Pw:HR, or Pa:HR from speed) | Yes |
| HR zones (threshold) | Friel: cycling 81 / 90 / 94 / 100 / 103 / 106 % of LTHR, running 85 / 90 / 95 / 100 / 103 / 106 % | Yes |
| HR zones (max HR) | 60 / 70 / 80 / 90 % of max | Strava / Garmin style |
| Power zones | Coggan 55 / 75 / 90 / 105 / 120 / 150 % of FTP | Yes |
| Pace zones | Friel, as % of threshold pace: 129 / 114 / 106 / 101 / 97 / 90 % | Yes |
| eFTP | 95 % of the best 20 min of the last 12 months | The classic 20-minute test; intervals.icu derives its eFTP from a model instead (shown here as CP) |

Other notes:

- The export holds the original activity files, so NP, the curves and best efforts come from the 1 s
  stream (smart-recording gaps are filled with the last value; pauses longer than 30 s are left out, like
  auto-pause).
- With max HR set instead of threshold HR, threshold HR is estimated as 90 % of max, and the page says so.
  Resting HR defaults to 60 bpm until you set it.
- Form is shown as of the last day in the export, not today.
