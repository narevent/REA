/**
 * playback.js — a dictation score, as the steps the AudioPlayer plays.
 *
 * The whole score is played in performance order (repeats, endings, D.C. and
 * D.S. worked out by `score.playOrder`); a phrase is played as written, just
 * the music between its two notes, in every part.  Tied notes sound as one;
 * dynamics and hairpins set how loud; staccato, tenuto, accent, marcato and
 * fermata change length and weight the way a player would.
 */

import * as S from "./score.js?v=177";

const LEVELS = { ppp: 28, pp: 40, p: 54, mp: 66, mf: 78, f: 92, ff: 106, fff: 118 };
const START_LEVEL = 74;

/** Milliseconds kept to a hundredth: tick arithmetic leaves float dust. */
const ms = (value) => Math.round(value * 100) / 100;

/**
 * How loud every note is, by event id: the dynamics in force, hairpins
 * ramped across the notes they span, accents on top.  Worked out in written
 * order, staff by staff, once — a repeat is played at the dynamics written.
 */
export function eventLevels(score) {
  const levels = new Map();
  const byStaff = new Map();
  S.allEvents(score).forEach((item) => {
    if (!byStaff.has(item.staffKey)) byStaff.set(item.staffKey, []);
    byStaff.get(item.staffKey).push(item);
  });
  byStaff.forEach((items) => {
    items.sort((a, b) => a.abs - b.abs || a.voice - b.voice);
    let level = START_LEVEL;
    let ramp = null;
    items.forEach((item, i) => {
      const e = item.event;
      let own = null;
      if (e.dyn === "sfz") own = 112;
      else if (e.dyn === "fp") { own = LEVELS.f; level = LEVELS.p; }
      else if (e.dyn && LEVELS[e.dyn]) level = LEVELS[e.dyn];
      if (e.hairpin) ramp = { from: i, dir: e.hairpin === ">" ? -1 : 1, start: level };
      levels.set(e.id, own != null ? own : level);
      if (e.hairpinEnd && ramp) {
        // To the next dynamic written after the hairpin, or a step louder or
        // softer when none is.
        const next = items.slice(i + 1).find((x) => x.event.dyn && LEVELS[x.event.dyn]);
        const target = next ? LEVELS[next.event.dyn] : Math.max(24, Math.min(120, ramp.start + ramp.dir * 18));
        const span = i - ramp.from;
        for (let k = ramp.from; k <= i; k += 1) {
          const t = span ? (k - ramp.from) / span : 1;
          levels.set(items[k].event.id, Math.round(ramp.start + (target - ramp.start) * t));
        }
        level = target;
        ramp = null;
      }
    });
  });
  return levels;
}

/**
 * The steps to play.
 *
 * @param {object} score
 * @param {object} opts
 *   span        {from, to, fromMeasure, toMeasure} — play only this, as written
 *   tempoScale  1 = as marked
 *   fromMeasure start the full performance at this measure (the editor's
 *               "play from here")
 * @returns {{steps: Array, durationMs: number}}
 */
export function schedule(score, { span = null, tempoScale = 1, fromMeasure = 0 } = {}) {
  const levels = eventLevels(score);
  const starts = S.measureStarts(score);
  let order;
  if (span) {
    order = [];
    for (let mi = span.fromMeasure; mi <= span.toMeasure; mi += 1) order.push(mi);
  } else {
    order = S.playOrder(score);
    const at = order.indexOf(fromMeasure);
    if (at > 0) order = order.slice(at);
  }
  const staffKeys = S.staves(score).map((s) => s.key);
  const steps = [];
  const openTies = new Map();
  let clock = 0;
  order.forEach((mi) => {
    const msPerTick = 60000 / (S.tempoAt(score, mi) * tempoScale) / S.PPQ;
    const measure = score.measures[mi];
    const capacity = S.measureTicks(score, mi);
    // Within a phrase, only the part of the first and last measures it
    // covers; the clock starts at the phrase's first note.
    let lo = 0;
    let hi = capacity;
    if (span) {
      lo = Math.max(0, span.from - starts[mi]);
      hi = Math.min(capacity, span.to - starts[mi]);
    }
    const continued = new Set();
    staffKeys.forEach((staffKey) => {
      const staff = measure.staves[staffKey];
      if (!staff) return;
      staff.voices.forEach((events, voice) => {
        S.timed(events).forEach(({ event, start, end }) => {
          if (start < lo || start >= hi || event.rest) return;
          const startMs = ms(clock + (start - lo) * msPerTick);
          const durationMs = ms((Math.min(end, hi) - start) * msPerTick);
          const art = event.art || [];
          let volume = levels.get(event.id) || START_LEVEL;
          if (art.includes("accent")) volume += 14;
          if (art.includes("marcato")) volume += 20;
          event.pitches.forEach((p) => {
            const midi = S.pitchMidi(p);
            const key = `${staffKey}:${voice}:${midi}`;
            const open = openTies.get(key);
            if (open) {
              // Tied into: the note already sounding simply lasts longer.
              open.durationMs = ms(startMs + durationMs - open.startMs);
              continued.add(key);
              if (!p.tie) openTies.delete(key);
              return;
            }
            let length = durationMs;
            if (art.includes("staccato")) length *= 0.45;
            else if (art.includes("marcato")) length *= 0.7;
            else if (!art.includes("tenuto") && !p.tie) length *= 0.95;
            if (art.includes("fermata")) length *= 1.6;
            const step = {
              midi, isRest: false, startMs, durationMs: ms(Math.max(30, length)),
              volume: Math.max(10, Math.min(127, volume)), eventId: event.id,
              barIndex: -1, scoreGlobalIndex: -1,
            };
            steps.push(step);
            if (p.tie) { openTies.set(key, step); continued.add(key); }
          });
        });
      });
    });
    // A tie whose far end never came (it was rubbed out) just ends.
    Array.from(openTies.keys()).forEach((key) => { if (!continued.has(key)) openTies.delete(key); });
    clock = ms(clock + (hi - lo) * msPerTick);
  });
  steps.sort((a, b) => a.startMs - b.startMs);
  return { steps, durationMs: clock };
}
