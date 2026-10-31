import { download, h } from '../dom';
import type { Activity, Tz, Units } from '../types';
import type { Thresholds } from '../stats/training';
import { svgToImage } from '../posters/raster';
import { buildCard, type Card } from './cards';
import { wrappedStats, wrappedYears, type Wrapped, type WrappedPeriod } from './data';
import { SHARE_H, SHARE_W, shareSvg } from './share';

/*
 * The Wrapped story: a modal <dialog> with a year picker, then the cards one at a time with progress bars
 * like phone stories. Cards advance by themselves (the current progress bar's CSS animation ending is the
 * timer, so pausing is just pausing the animation). Tap the left third / right of the card or use the
 * arrow keys to move, hold the card or press space to pause, Esc or Back to close.
 */

export interface WrappedOpen {
  all: Activity[];
  tz: Tz;
  units: Units;
  thresholds: Thresholds | null;
  hideEnds: number;
  /** a year to start with (skips the picker) */
  period?: WrappedPeriod;
}

/** Seconds each card stays before the next one (set in CSS as the progress bar duration). */
export const CARD_SECONDS = 6;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let autoPref: boolean | null = null; // the viewer's choice for this page visit

export function openWrapped(o: WrappedOpen): void {
  const opener = document.activeElement as HTMLElement | null;
  const dlg = h('dialog', { class: 'wrapped', 'aria-labelledby': 'w-heading' });
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite', id: 'w-live' });
  const urls: string[] = [];
  let teardown: (() => void) | null = null;
  let countJob = 0;

  const close = () => { if ((history.state as { wrapped?: boolean } | null)?.wrapped) history.back(); else teardown?.(); };
  const closeBtn = () => h('button', { class: 'w-close', 'aria-label': 'Close Sport Wrapped', onclick: close }, '✕');

  /** Year (or all time) picker. */
  const picker = () => {
    stopStory();
    dlg.className = 'wrapped w-bg-0';
    const years = wrappedYears(o.all, o.tz);
    // Under reduced motion the progress bars do not animate, and so cannot time the cards: move by hand.
    const auto = h('input', { type: 'checkbox', id: 'w-auto', checked: !reduced() && (autoPref ?? true), disabled: reduced(), onchange: (e) => { autoPref = (e.target as HTMLInputElement).checked; } });
    const btn = (p: WrappedPeriod, label: string) => h('button', { class: 'w-year', 'data-period': String(p), onclick: () => play(p) }, label);
    dlg.replaceChildren(
      h('div', { class: 'w-pick' }, closeBtn(),
        h('p', { class: 'w-kicker' }, 'Sport Wrapped'),
        h('h2', { class: 'w-title', id: 'w-heading' }, 'Your year,', h('br'), h('em', {}, 'wrapped')),
        h('p', { class: 'w-line' }, 'Pick a year for your story. Everything is worked out here in your browser.'),
        h('div', { class: 'w-years' }, ...years.map((y) => btn(y, String(y))), years.length > 1 ? btn('all', 'All time') : null),
        h('label', { class: 'w-check' }, auto, reduced() ? 'Cards move on when you tap (your device asks for reduced motion)' : 'Move on to the next card by itself')),
      live);
    (dlg.querySelector('.w-year') as HTMLElement | null)?.focus();
  };

  // ---------- story ----------
  let story: { w: Wrapped; cards: Card[]; i: number; bars: HTMLElement[]; stage: HTMLElement; pauseBtn: HTMLButtonElement; auto: boolean; paused: boolean } | null = null;

  function stopStory() { story = null; countJob++; }

  const setPaused = (p: boolean) => {
    if (!story) return;
    story.paused = p;
    dlg.classList.toggle('paused', p);
    story.pauseBtn.textContent = p ? '▶' : '❚❚';
    story.pauseBtn.setAttribute('aria-label', p ? 'Play' : 'Pause');
  };

  function play(period: WrappedPeriod) {
    const w = wrappedStats(o.all, period, { tz: o.tz, thresholds: o.thresholds, hideEnds: o.hideEnds });
    const ctx = { units: o.units, tz: o.tz };
    const cards = w.cards.map((id) => (id === 'summary' ? summaryCard(w) : buildCard(id, w, ctx)!));
    const auto = !reduced() && ((document.getElementById('w-auto') as HTMLInputElement | null)?.checked ?? autoPref ?? true);
    const bars = cards.map(() => h('span', { class: 'w-prog' }, h('i')));
    const stage = h('div', { class: 'w-stage', role: 'group', 'aria-roledescription': 'card' });
    const pauseBtn = h('button', { class: 'w-pause', 'aria-label': 'Pause', onclick: () => setPaused(!story?.paused) }, '❚❚');
    story = { w, cards, i: 0, bars, stage, pauseBtn, auto, paused: false };
    dlg.replaceChildren(
      h('div', { class: 'w-top' }, h('div', { class: 'w-progs', 'aria-hidden': 'true' }, ...bars),
        h('div', { class: 'w-tools' }, h('h2', { class: 'w-heading', id: 'w-heading' }, `Sport Wrapped ${w.label}`),
          auto ? pauseBtn : null, closeBtn())),
      stage,
      h('div', { class: 'w-navs' },
        h('button', { class: 'w-prev', 'aria-label': 'Previous card', onclick: () => go(-1) }, '‹'),
        h('button', { class: 'w-next', 'aria-label': 'Next card', onclick: () => go(1) }, '›')),
      live);
    bindStage(stage);
    show(0);
    (dlg.querySelector('.w-next') as HTMLElement | null)?.focus();
  }

  function go(d: number) {
    if (!story) return;
    const j = story.i + d;
    if (j < 0) return show(0);
    if (j >= story.cards.length) return;
    show(j);
  }

  function show(i: number) {
    if (!story) return;
    const s = story;
    s.i = i;
    const card = s.cards[i]!;
    const last = i === s.cards.length - 1;
    dlg.className = `wrapped w-bg-${i % 7}${s.paused ? ' paused' : ''}`;
    s.bars.forEach((b, k) => {
      b.className = `w-prog${k < i ? ' done' : k === i ? (s.auto && !last ? ' run' : ' done') : ''}`;
      // restart the fill animation for the current bar
      const fill = b.firstElementChild as HTMLElement;
      const clone = fill.cloneNode() as HTMLElement;
      fill.replaceWith(clone);
      if (k === i && s.auto && !last) clone.addEventListener('animationend', () => { if (story === s && s.i === i) go(1); }, { once: true });
    });
    card.el.classList.remove('in');
    s.stage.replaceChildren(card.el);
    void card.el.offsetWidth; // restart the card's entrance animations
    card.el.classList.add('in');
    s.stage.setAttribute('aria-label', `Card ${i + 1} of ${s.cards.length}`);
    live.textContent = `Card ${i + 1} of ${s.cards.length}. ${card.say}`;
    countUp(card.el);
    const prev = dlg.querySelector<HTMLButtonElement>('.w-prev'), next = dlg.querySelector<HTMLButtonElement>('.w-next');
    if (prev) prev.disabled = i === 0;
    if (next) next.disabled = last;
    if (last && document.activeElement === next) (card.el.querySelector('button') as HTMLElement | null)?.focus();
  }

  /** Numbers count up from zero (skipped under reduced motion: they already show the final value). */
  function countUp(root: HTMLElement) {
    const job = ++countJob;
    if (reduced()) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-count]'));
    const t0 = performance.now(), dur = 1100;
    const fmt = (el: HTMLElement, v: number) => { const d = Number(el.dataset.dec ?? 0); el.textContent = v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
    const tick = (t: number) => {
      if (job !== countJob) return;
      const f = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - f) ** 3;
      for (const el of els) fmt(el, Number(el.dataset.count) * e);
      if (f < 1) requestAnimationFrame(tick);
    };
    for (const el of els) fmt(el, 0);
    requestAnimationFrame(tick);
  }

  /** Tap left third = back, elsewhere = forward; holding pauses while held. */
  function bindStage(stage: HTMLElement) {
    let down = 0, wasPaused = false;
    stage.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button, a, input')) return;
      down = performance.now(); wasPaused = story?.paused ?? false; setPaused(true);
    });
    const up = (e: PointerEvent, cancel = false) => {
      if (!down || !story) return;
      const held = performance.now() - down;
      down = 0;
      setPaused(wasPaused);
      if (cancel || held > 300) return;
      const r = stage.getBoundingClientRect();
      go(e.clientX - r.left < r.width / 3 ? -1 : 1);
    };
    stage.addEventListener('pointerup', (e) => up(e));
    stage.addEventListener('pointercancel', (e) => up(e, true));
  }

  /** Last card: the shareable picture and what to do next. */
  function summaryCard(w: Wrapped): Card {
    const svgText = shareSvg(w, o.units);
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    urls.push(url);
    const status = h('span', { class: 'w-status', role: 'status' });
    const save = async () => {
      status.textContent = 'Making the picture…';
      try {
        const img = await svgToImage(svgText, SHARE_W, SHARE_H, 'png');
        download(`sport-wrapped-${w.label}.png`, img.blob, 'image/png');
        status.textContent = 'Saved.';
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Could not make the picture.';
      }
    };
    const el = h('div', { class: 'w-card w-summary' },
      h('img', { class: 'w-share', src: url, alt: `Summary of ${w.label}: ${w.archetype.name}`, width: SHARE_W, height: SHARE_H }),
      h('div', { class: 'w-share-side' },
        h('p', { class: 'w-kicker' }, 'That was your'),
        h('h2', { class: 'w-title' }, w.label),
        h('p', { class: 'w-line' }, 'Save the picture to share it. It is made here; nothing is uploaded.'),
        h('div', { class: 'w-actions' },
          h('button', { class: 'primary', id: 'w-save', onclick: save }, 'Save picture (PNG)'),
          h('button', { onclick: () => show(0) }, 'Watch again'),
          h('button', { onclick: picker }, 'Another year'),
          h('button', { onclick: close }, 'Close')),
        status));
    return { el, say: `That was your ${w.label}. The last card has a picture to save and share.` };
  }

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as Element | null;
    const tag = t?.tagName;
    if (!story || tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === ' ' && tag !== 'BUTTON' && story.auto) { e.preventDefault(); setPaused(!story.paused); }
  };
  const onCancel = (e: Event) => { e.preventDefault(); close(); };

  teardown = () => {
    stopStory();
    window.removeEventListener('popstate', onPop);
    dlg.removeEventListener('keydown', onKey);
    dlg.removeEventListener('cancel', onCancel);
    if (dlg.open) dlg.close();
    dlg.remove();
    for (const u of urls) URL.revokeObjectURL(u);
    document.body.classList.remove('lb-open');
    teardown = null;
    if (opener?.isConnected) opener.focus();
    else document.getElementById('open-wrapped')?.focus();
  };
  const onPop = () => teardown?.();

  dlg.addEventListener('keydown', onKey);
  dlg.addEventListener('cancel', onCancel);
  document.body.append(dlg);
  document.body.classList.add('lb-open');
  dlg.showModal();
  history.pushState({ ...(history.state as object | null ?? { view: 'stats' }), wrapped: true }, '');
  window.addEventListener('popstate', onPop);
  if (o.period !== undefined) play(o.period); else picker();
}
