import type { PosterType } from './posters/common';

/** Posters pre-rendered from the demo data (`npm run examples`) and shown on the import page. Small SVGs only. */
export const EXAMPLE_POSTERS: { type: PosterType; caption: string }[] = [
  { type: 'climb', caption: 'Every metre climbed, year against year' },
  { type: 'circles', caption: 'Each activity a bubble' },
  { type: 'world', caption: 'How many times around the world' },
];
