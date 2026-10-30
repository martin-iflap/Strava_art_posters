/** Map Strava activity types (English plus common translations and GPX/TCX names) to a canonical sport. */
const ALIASES: Record<string, string> = {
  ride: 'Ride', cycling: 'Ride', biking: 'Ride', bike: 'Ride', 'virtual ride': 'Virtual Ride', 'e-bike ride': 'Ride',
  'mountain bike ride': 'Ride', 'gravel ride': 'Ride', ebikeride: 'Ride', virtualride: 'Virtual Ride',
  run: 'Run', running: 'Run', 'trail run': 'Run', 'virtual run': 'Run', trailrun: 'Run',
  walk: 'Walk', walking: 'Walk', hike: 'Hike', hiking: 'Hike',
  swim: 'Swim', swimming: 'Swim',
  // de
  fahrt: 'Ride', radfahrt: 'Ride', lauf: 'Run', laufen: 'Run', spaziergang: 'Walk', wanderung: 'Hike', schwimmen: 'Swim',
  // fr
  'sortie à vélo': 'Ride', 'course à pied': 'Run', marche: 'Walk', randonnée: 'Hike', natation: 'Swim',
  // es
  'paseo en bicicleta': 'Ride', carrera: 'Run', caminata: 'Walk', senderismo: 'Hike', natación: 'Swim',
  // cs
  'jízda na kole': 'Ride', běh: 'Run', chůze: 'Walk', turistika: 'Hike', plavání: 'Swim',
  // it / nl / pt
  'giro in bici': 'Ride', corsa: 'Run', camminata: 'Walk', nuoto: 'Swim', fietsrit: 'Ride', hardlopen: 'Run',
  pedalada: 'Ride', corrida: 'Run', caminhada: 'Walk', natação: 'Swim',
};

export function normalizeSport(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s) return 'Other';
  return ALIASES[s.toLowerCase()] ?? s;
}
