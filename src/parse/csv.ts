import { parseCsvDate } from '../util/time';
import { normalizeSport } from './sport';

/** RFC-4180 CSV parser (quotes, escaped quotes, embedded newlines, CRLF, BOM). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.search(/\r|\n/) >>> 0 || 2000);
  const count = (ch: string) => head.split(ch).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

export interface CsvActivity {
  id: string;
  startMs: number;
  name: string;
  sport: string;
  filename: string;
  elapsedS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevGainM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  maxSpeedMps: number | null;
  avgCadence: number | null;
}

export interface CsvResult {
  rows: CsvActivity[];
  skipped: { subject: string; reason: string }[];
}

type Field =
  | 'id' | 'date' | 'name' | 'type' | 'filename' | 'elapsed' | 'moving' | 'distance' | 'elevGain'
  | 'avgHr' | 'maxHr' | 'avgPower' | 'maxPower' | 'maxSpeed' | 'avgCadence';

/** Lower-case header names (English first, then a few translations). */
const ALIASES: Record<Field, string[]> = {
  id: ['activity id', 'aktivitäts-id', 'id de l\'activité', 'id de actividad', 'id aktivity'],
  date: ['activity date', 'aktivitätsdatum', 'date de l\'activité', 'fecha de la actividad', 'datum aktivity'],
  name: ['activity name', 'aktivitätsname', 'nom de l\'activité', 'nombre de la actividad', 'název aktivity'],
  type: ['activity type', 'aktivitätsart', 'type d\'activité', 'tipo de actividad', 'typ aktivity'],
  filename: ['filename', 'dateiname', 'nom du fichier', 'nombre del archivo', 'název souboru'],
  elapsed: ['elapsed time', 'verstrichene zeit', 'temps écoulé', 'tiempo transcurrido', 'uplynulý čas'],
  moving: ['moving time', 'bewegungszeit', 'temps en mouvement', 'tiempo en movimiento', 'čas v pohybu'],
  distance: ['distance', 'distanz', 'distancia', 'vzdálenost'],
  elevGain: ['elevation gain', 'höhenmeter', 'dénivelé positif', 'desnivel positivo', 'převýšení'],
  avgHr: ['average heart rate', 'durchschnittliche herzfrequenz', 'fréquence cardiaque moyenne', 'frecuencia cardíaca media', 'průměrná tepová frekvence'],
  maxHr: ['max heart rate', 'maximale herzfrequenz', 'fréquence cardiaque max.', 'frecuencia cardíaca máxima', 'maximální tepová frekvence'],
  avgPower: ['average watts', 'durchschnittliche wattleistung', 'puissance moyenne', 'vatios promedio', 'průměrné watty'],
  maxPower: ['max watts', 'maximale wattleistung', 'puissance max.', 'vatios máximos', 'maximální watty'],
  maxSpeed: ['max speed', 'höchstgeschwindigkeit', 'vitesse max.', 'velocidad máxima', 'maximální rychlost'],
  avgCadence: ['average cadence', 'durchschnittliche trittfrequenz', 'cadence moyenne', 'cadencia media', 'průměrná kadence'],
};

/** Column positions in the stock Strava export; used when headers are unrecognised (other language). */
const POSITIONAL: Partial<Record<Field, number>> = {
  id: 0, date: 1, name: 2, type: 3, filename: 12, elapsed: 15, moving: 16, distance: 17, elevGain: 20,
  maxHr: 30, avgHr: 31, maxPower: 32, avgPower: 33, maxSpeed: 18, avgCadence: 29,
};

export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseActivitiesCsv(text: string): CsvResult {
  const table = parseCsv(text);
  const skipped: CsvResult['skipped'] = [];
  if (table.length < 2) return { rows: [], skipped: [{ subject: 'activities.csv', reason: 'file has no data rows' }] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());

  const idx = (f: Field): number[] => {
    const out: number[] = [];
    header.forEach((h, i) => { if (ALIASES[f].includes(h)) out.push(i); });
    return out;
  };
  const cols = {} as Record<Field, number[]>;
  for (const f of Object.keys(ALIASES) as Field[]) cols[f] = idx(f);
  const recognised = cols.date.length > 0 && cols.type.length > 0;
  if (!recognised && header.length >= 18) {
    for (const [f, i] of Object.entries(POSITIONAL) as [Field, number][]) cols[f] = [i];
  }
  if (!cols.date.length || !cols.type.length) {
    return { rows: [], skipped: [{ subject: 'activities.csv', reason: 'could not find date and type columns' }] };
  }

  const body = table.slice(1);
  // Strava exports "Distance" twice: rounded km/mi first, metres second. With a single column, guess the unit.
  const distIdx = cols.distance;
  let distScale = 1;
  if (distIdx.length === 1) {
    const vals = body.map((r) => parseNumber(r[distIdx[0]!])).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
    if (vals.length && vals[Math.floor(vals.length / 2)]! < 500) distScale = 1000;
  }

  const num = (row: string[], f: Field): number | null => {
    for (const i of cols[f]) {
      const v = parseNumber(row[i]);
      if (v !== null) return v;
    }
    return null;
  };
  const last = (row: string[], f: Field): number | null => {
    const c = cols[f];
    for (let k = c.length - 1; k >= 0; k--) {
      const v = parseNumber(row[c[k]!]);
      if (v !== null) return v;
    }
    return null;
  };
  // Two columns: the first is rounded km/mi, the last is metres. If the metres cell is empty, fall back to the first (km).
  const distanceOf = (row: string[]): number | null => {
    if (distIdx.length >= 2) {
      const m = parseNumber(row[distIdx[distIdx.length - 1]!]);
      if (m !== null) return m;
      const km = parseNumber(row[distIdx[0]!]);
      return km === null ? null : km * 1000;
    }
    return parseNumber(row[distIdx[0]!]);
  };
  const str = (row: string[], f: Field) => (cols[f].length ? (row[cols[f][0]!] ?? '').trim() : '');

  const rows: CsvActivity[] = [];
  body.forEach((row, n) => {
    const where = `activities.csv row ${n + 2}`;
    const startMs = parseCsvDate(str(row, 'date'));
    if (startMs === null) { skipped.push({ subject: where, reason: `unrecognised date "${str(row, 'date')}"` }); return; }
    const type = str(row, 'type');
    if (!type) { skipped.push({ subject: where, reason: 'missing activity type' }); return; }
    const dist = distIdx.length ? distanceOf(row) : null;
    const clampHr = (v: number | null) => (v !== null && v >= 30 && v <= 250 ? v : null);
    rows.push({
      id: str(row, 'id') || `row-${n + 2}`,
      startMs,
      name: str(row, 'name') || type,
      sport: normalizeSport(type),
      filename: str(row, 'filename'),
      elapsedS: last(row, 'elapsed'),
      movingS: num(row, 'moving'),
      distanceM: dist === null ? null : dist * distScale,
      elevGainM: num(row, 'elevGain'),
      avgHr: clampHr(num(row, 'avgHr')),
      maxHr: clampHr(num(row, 'maxHr')),
      avgPower: positive(num(row, 'avgPower')),
      maxPower: positive(num(row, 'maxPower')),
      maxSpeedMps: positive(num(row, 'maxSpeed')),
      avgCadence: positive(num(row, 'avgCadence')),
    });
  });
  return { rows, skipped };
}

const positive = (v: number | null) => (v !== null && v > 0 ? v : null);
