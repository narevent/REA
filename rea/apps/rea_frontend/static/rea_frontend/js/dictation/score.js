/**
 * score.js — the dictation score: its shape, and every edit made to it.
 *
 * A dictation is a piece of music, written in the dictation editor and stored
 * whole as one JSON document (see `dictation.models` on the server).  This
 * module is that document's only reader and writer: the editor and the
 * practice view call it, and nothing else knows the shape.  Everything here
 * is plain data in and plain data out — no DOM, no VexFlow — so it is tested
 * in node (`tests/dictation/score.mjs`).
 *
 * The document
 * ------------
 *
 *   {
 *     version: 1,
 *     tempo: 80,                       quarter notes per minute
 *     parts: [{ id, name, instrument, staves: [{ clef }] }],
 *     measures: [{
 *       time: [3, 4] | absent,         a change of time signature
 *       key: -2..7 | absent,           a change of key, in fifths (-2 = B♭ major)
 *       tempo: 96 | absent,            a tempo mark
 *       repeatStart: bool,             ‖: at the start
 *       repeatEnd: bool,               :‖ at the end
 *       repeatTimes: 2,                how many times the repeat is played
 *       barline: "single" | "double" | "final",
 *       volta: [1] | [2] | [1, 2] | absent,   the ending(s) this measure belongs to
 *       nav: "segno" | "coda" | "fine" | "dc" | "dcalfine" | "dcalcoda"
 *            | "ds" | "dsalfine" | "dsalcoda" | "tocoda" | absent,
 *       staves: { "<partId>:<staffIndex>": { clef?: "bass", voices: [[ev…], [ev…], [], []] } },
 *     }],
 *   }
 *
 * An event is a note, a chord or a rest:
 *
 *   {
 *     id: "e12",
 *     rest: false,
 *     dur: "q",                        w h q 8 16 32 64
 *     dots: 0,                         0-2
 *     pitches: [{ step: "C", alter: 0, octave: 4, tie: false }],   lowest first
 *     tuplet: { id, num: 3, den: 2 } | null,
 *     dyn: "mf" | null,                a dynamic written under the note
 *     hairpin: "<" | ">" | null,       a hairpin starting at this note…
 *     hairpinEnd: bool,                …and the note it ends on
 *     slur: bool, slurEnd: bool,       a slur starting / ending here
 *     art: ["staccato", "accent", "tenuto", "marcato", "fermata"],
 *   }
 *
 * `tie` on a pitch ties it to the same pitch in the next event of its voice,
 * across a barline if need be.  Pitches are what *sounds*; how a pitch is
 * drawn (which accidental, if any) is worked out from the key and the bar,
 * the way an engraver works it out.
 *
 * Time is counted in ticks, 480 to the quarter note.  A voice's events, in
 * order, fill its measure exactly — the first voice of every staff always,
 * the others once something has been written in them.  Every edit keeps that
 * true, which is what lets a measure be drawn, played and edited without ever
 * asking what happens in the part of it nobody wrote.
 */

export const PPQ = 480;
export const DURATIONS = [
  { dur: "w", ticks: 1920, label: "Whole" },
  { dur: "h", ticks: 960, label: "Half" },
  { dur: "q", ticks: 480, label: "Quarter" },
  { dur: "8", ticks: 240, label: "Eighth" },
  { dur: "16", ticks: 120, label: "Sixteenth" },
  { dur: "32", ticks: 60, label: "Thirty-second" },
  { dur: "64", ticks: 30, label: "Sixty-fourth" },
];
const BASE_TICKS = Object.fromEntries(DURATIONS.map((d) => [d.dur, d.ticks]));

export const STEPS = ["C", "D", "E", "F", "G", "A", "B"];
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ["F", "C", "G", "D", "A", "E", "B"];

export const DYNAMICS = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sfz", "fp"];
export const ARTICULATIONS = ["staccato", "accent", "tenuto", "marcato", "fermata"];
export const NAVIGATIONS = {
  segno: "Segno", coda: "Coda", fine: "Fine", tocoda: "To Coda",
  dc: "D.C.", dcalfine: "D.C. al Fine", dcalcoda: "D.C. al Coda",
  ds: "D.S.", dsalfine: "D.S. al Fine", dsalcoda: "D.S. al Coda",
};
export const CLEFS = [
  { clef: "treble", label: "Treble" },
  { clef: "bass", label: "Bass" },
  { clef: "alto", label: "Alto" },
  { clef: "tenor", label: "Tenor" },
  { clef: "treble8vb", label: "Treble 8vb" },
];

/** The instruments a part can be, with the staves each is written on. */
export const INSTRUMENTS = {
  piano: { name: "Piano", staves: ["treble", "bass"] },
  soprano: { name: "Soprano", staves: ["treble"] },
  alto: { name: "Alto", staves: ["treble"] },
  tenor: { name: "Tenor", staves: ["treble8vb"] },
  bass: { name: "Bass", staves: ["bass"] },
  violin: { name: "Violin", staves: ["treble"] },
  viola: { name: "Viola", staves: ["alto"] },
  cello: { name: "Cello", staves: ["bass"] },
  flute: { name: "Flute", staves: ["treble"] },
  guitar: { name: "Guitar", staves: ["treble8vb"] },
  treble: { name: "Treble staff", staves: ["treble"] },
  bassStaff: { name: "Bass staff", staves: ["bass"] },
};

export const MAX_VOICES = 4;

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

let idCounter = 0;
/** A fresh event or part id, unique within any score this page loads. */
export function newId(prefix = "e") {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** How long an event lasts, in ticks: its value, its dots, its tuplet. */
export function eventTicks(event) {
  const base = BASE_TICKS[event.dur] || PPQ;
  let ticks = base;
  let add = base;
  for (let i = 0; i < (event.dots || 0); i += 1) { add /= 2; ticks += add; }
  if (event.tuplet && event.tuplet.num && event.tuplet.den) ticks = (ticks * event.tuplet.den) / event.tuplet.num;
  return Math.round(ticks);
}

/** The written value of a length in ticks, if one exists: `{dur, dots}`. */
export function durationFor(ticks) {
  for (const d of DURATIONS) {
    for (let dots = 0; dots <= 2; dots += 1) {
      if (eventTicks({ dur: d.dur, dots }) === ticks) return { dur: d.dur, dots };
    }
  }
  return null;
}

/**
 * A length in ticks as written values, longest first: 1440 is a dotted half,
 * 1680 a dotted half tied to an eighth.  How a rest fills a gap, and how a
 * note that will not fit in one value is split into tied ones.
 */
export function splitTicks(ticks) {
  const out = [];
  let left = ticks;
  while (left >= 30) {
    let best = null;
    for (const d of DURATIONS) {
      for (let dots = 2; dots >= 0; dots -= 1) {
        const t = eventTicks({ dur: d.dur, dots });
        if (t <= left && (!best || t > best.ticks)) best = { dur: d.dur, dots, ticks: t };
      }
    }
    if (!best) break;
    out.push({ dur: best.dur, dots: best.dots });
    left -= best.ticks;
  }
  return out;
}

export function pitchMidi(p) {
  return (p.octave + 1) * 12 + STEP_PC[p.step] + (p.alter || 0);
}

/** A pitch's diatonic index — its line or space, counted from C-1. */
export function pitchStep(p) {
  return p.octave * 7 + STEPS.indexOf(p.step);
}

export function pitchFromStep(index, alter = 0) {
  return { step: STEPS[((index % 7) + 7) % 7], octave: Math.floor(index / 7), alter };
}

/** The letters a key signature alters, and by how much: `{F: 1, C: 1}`. */
export function keyAlterations(fifths) {
  const out = {};
  if (fifths > 0) SHARP_ORDER.slice(0, fifths).forEach((s) => { out[s] = 1; });
  if (fifths < 0) SHARP_ORDER.slice().reverse().slice(0, -fifths).forEach((s) => { out[s] = -1; });
  return out;
}

const MAJOR_KEYS = ["C♭", "G♭", "D♭", "A♭", "E♭", "B♭", "F", "C", "G", "D", "A", "E", "B", "F♯", "C♯"];
/** "B♭ major" for -2. */
export function keyName(fifths) {
  return `${MAJOR_KEYS[fifths + 7]} major`;
}
/** VexFlow's spelling of a key signature: "Bb" for -2. */
export function vexKey(fifths) {
  return MAJOR_KEYS[fifths + 7].replace("♭", "b").replace("♯", "#");
}

/**
 * A pitch spelled the way the key spells it: `pitchForLetter("F", 4, 2)` is
 * F♯4 in D major.  What a letter key writes.
 */
export function pitchForLetter(step, octave, fifths) {
  return { step, octave, alter: keyAlterations(fifths)[step] || 0, tie: false };
}

/** Move a pitch by semitones, respelled sensibly for the key. */
export function transposePitch(p, semitones, fifths) {
  const midi = pitchMidi(p) + semitones;
  const prefersFlats = fifths < 0;
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const key = keyAlterations(fifths);
  // In the key first: a note the key already spells is spelled that way.
  for (const step of STEPS) {
    if ((STEP_PC[step] + (key[step] || 0) + 12) % 12 === pc) {
      const base = STEP_PC[step] + (key[step] || 0);
      return { step, alter: key[step] || 0, octave: octave + (base < 0 ? 1 : base > 11 ? -1 : 0), tie: false };
    }
  }
  const sharps = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const flats = ["C", "D", "D", "E", "E", "F", "G", "G", "A", "A", "B", "B"];
  const step = (prefersFlats ? flats : sharps)[pc];
  return { step, alter: pc - STEP_PC[step], octave, tie: false };
}

// ---------------------------------------------------------------------------
// A new score
// ---------------------------------------------------------------------------

export function newPart(instrument = "piano") {
  const preset = INSTRUMENTS[instrument] || INSTRUMENTS.treble;
  return {
    id: newId("p"),
    name: preset.name,
    instrument,
    staves: preset.staves.map((clef) => ({ clef })),
  };
}

export function restEvent(dur = "w", dots = 0) {
  return {
    id: newId(), rest: true, dur, dots, pitches: [], tuplet: null,
    dyn: null, hairpin: null, hairpinEnd: false, slur: false, slurEnd: false, art: [],
  };
}

export function noteEvent(pitches, dur = "q", dots = 0) {
  return Object.assign(restEvent(dur, dots), { rest: false, pitches: sortPitches(pitches) });
}

export function sortPitches(pitches) {
  return pitches.slice().sort((a, b) => pitchMidi(a) - pitchMidi(b));
}

/**
 * Rests that fill `ticks` starting at `start` in a measure of `capacity`.
 *
 * A whole empty measure is one rest.  Anything else is filled the way an
 * engraver fills it — each rest as long as it can be while starting on a
 * multiple of its own length — so the beats stay visible: after an eighth on
 * beat two comes an eighth rest and then a half, never the other way round.
 */
export function restsFor(ticks, start = 0, capacity = null) {
  if (start === 0 && capacity != null && ticks === capacity) {
    const whole = durationFor(ticks);
    if (whole) return [restEvent(whole.dur, whole.dots)];
  }
  const out = [];
  let at = start;
  const end = start + ticks;
  while (at < end) {
    let best = null;
    for (const d of DURATIONS) {
      if (d.ticks <= end - at && at % d.ticks === 0) { best = d; break; }
    }
    if (!best) {
      // Off the grid (after a tuplet, say): fall back to plain splitting.
      splitTicks(end - at).forEach(({ dur, dots }) => out.push(restEvent(dur, dots)));
      break;
    }
    out.push(restEvent(best.dur, 0));
    at += best.ticks;
  }
  return out;
}

export function newScore({ instruments = ["piano"], time = [4, 4], key = 0, measures = 8, tempo = 80 } = {}) {
  const score = {
    version: 1,
    tempo,
    parts: instruments.map((name) => newPart(name)),
    measures: [],
  };
  for (let i = 0; i < measures; i += 1) {
    score.measures.push(i === 0 ? { time, key, staves: {} } : { staves: {} });
  }
  normalise(score);
  return score;
}

// ---------------------------------------------------------------------------
// Reading the score
// ---------------------------------------------------------------------------

/** Every staff, in score order, as `{key, part, partIndex, staffIndex}`. */
export function staves(score) {
  const out = [];
  score.parts.forEach((part, partIndex) => {
    part.staves.forEach((_, staffIndex) => {
      out.push({ key: `${part.id}:${staffIndex}`, part, partIndex, staffIndex });
    });
  });
  return out;
}

/** The time signature in force at measure `mi`. */
export function timeAt(score, mi) {
  for (let i = mi; i >= 0; i -= 1) if (score.measures[i] && score.measures[i].time) return score.measures[i].time;
  return [4, 4];
}

export function keyAt(score, mi) {
  for (let i = mi; i >= 0; i -= 1) {
    const m = score.measures[i];
    if (m && m.key != null) return m.key;
  }
  return 0;
}

export function tempoAt(score, mi) {
  for (let i = mi; i >= 0; i -= 1) {
    const m = score.measures[i];
    if (m && m.tempo) return m.tempo;
  }
  return score.tempo || 80;
}

/** The clef a staff is in at measure `mi`: the latest change, or the part's. */
export function clefAt(score, staffKey, mi) {
  for (let i = mi; i >= 0; i -= 1) {
    const s = score.measures[i] && score.measures[i].staves[staffKey];
    if (s && s.clef) return s.clef;
  }
  const [partId, staffIndex] = staffKey.split(":");
  const part = score.parts.find((p) => p.id === partId);
  return (part && part.staves[Number(staffIndex)] && part.staves[Number(staffIndex)].clef) || "treble";
}

export function measureTicks(score, mi) {
  const [num, den] = timeAt(score, mi);
  return Math.round((num * 4 * PPQ) / den);
}

/** A measure's voices on one staff, created empty if the staff has none yet. */
export function voicesOf(score, mi, staffKey) {
  const measure = score.measures[mi];
  if (!measure.staves[staffKey]) measure.staves[staffKey] = { voices: [[], [], [], []] };
  const staff = measure.staves[staffKey];
  while (staff.voices.length < MAX_VOICES) staff.voices.push([]);
  return staff.voices;
}

/** The events of a voice with the tick each starts at. */
export function timed(events) {
  let tick = 0;
  return events.map((event) => {
    const start = tick;
    tick += eventTicks(event);
    return { event, start, end: tick };
  });
}

/** Where an event is: `{mi, staffKey, voice, index, start}`, or null. */
export function locate(score, id) {
  for (let mi = 0; mi < score.measures.length; mi += 1) {
    const measure = score.measures[mi];
    for (const staffKey of Object.keys(measure.staves)) {
      const voices = measure.staves[staffKey].voices || [];
      for (let voice = 0; voice < voices.length; voice += 1) {
        let tick = 0;
        for (let index = 0; index < voices[voice].length; index += 1) {
          const event = voices[voice][index];
          if (event.id === id) return { mi, staffKey, voice, index, start: tick, event };
          tick += eventTicks(event);
        }
      }
    }
  }
  return null;
}

/** Where every measure starts, in ticks from the beginning of the score. */
export function measureStarts(score) {
  const out = [];
  let tick = 0;
  score.measures.forEach((_, mi) => { out.push(tick); tick += measureTicks(score, mi); });
  out.push(tick);
  return out;
}

/**
 * Every event, with where it is and when — in score time, measure by
 * measure, as written (repeats not unrolled).
 */
export function allEvents(score) {
  const starts = measureStarts(score);
  const out = [];
  const keys = staves(score).map((s) => s.key);
  score.measures.forEach((measure, mi) => {
    keys.forEach((staffKey) => {
      const staff = measure.staves[staffKey];
      if (!staff) return;
      staff.voices.forEach((events, voice) => {
        timed(events).forEach(({ event, start, end }) => {
          out.push({ event, mi, staffKey, voice, start, end, abs: starts[mi] + start, absEnd: starts[mi] + end });
        });
      });
    });
  });
  return out;
}

/** The next event in the same voice — the one a tie or a slur continues into. */
export function nextInVoice(score, where) {
  const voices = score.measures[where.mi].staves[where.staffKey].voices;
  if (where.index + 1 < voices[where.voice].length) {
    return { mi: where.mi, index: where.index + 1, event: voices[where.voice][where.index + 1] };
  }
  for (let mi = where.mi + 1; mi < score.measures.length; mi += 1) {
    const staff = score.measures[mi].staves[where.staffKey];
    const events = staff && staff.voices[where.voice];
    if (events && events.length) return { mi, index: 0, event: events[0] };
    if (where.voice === 0) return null;
  }
  return null;
}

/**
 * The accidental to draw for each pitch of each event, in one measure of one
 * staff: "#", "b", "n", "##", "bb" or null.  Read the way an engraver reads it
 * — against the key, and against whatever an earlier note in the same
 * measure on the same line has already said.  A tied-over note repeats
 * nothing.  All voices share one memory, because on paper they share the
 * staff.
 */
export function accidentalsFor(score, mi, staffKey) {
  const key = keyAlterations(keyAt(score, mi));
  const staff = score.measures[mi].staves[staffKey];
  const out = new Map();
  if (!staff) return out;
  const said = new Map();
  const tiedInto = tiedTargets(score, mi, staffKey);
  const items = [];
  staff.voices.forEach((events, voice) => timed(events).forEach((t) => items.push(Object.assign({ voice }, t))));
  items.sort((a, b) => a.start - b.start || a.voice - b.voice);
  items.forEach(({ event }) => {
    if (event.rest) return;
    out.set(event.id, event.pitches.map((p) => {
      const line = `${p.step}${p.octave}`;
      const expected = said.has(line) ? said.get(line) : (key[p.step] || 0);
      said.set(line, p.alter || 0);
      if (tiedInto.has(`${event.id}:${pitchMidi(p)}`)) return null;
      if ((p.alter || 0) === expected) return null;
      return { 0: "n", 1: "#", 2: "##", "-1": "b", "-2": "bb" }[String(p.alter || 0)] || null;
    }));
  });
  return out;
}

/** The pitches in a measure that are the far end of a tie: `"<id>:<midi>"`. */
function tiedTargets(score, mi, staffKey) {
  const out = new Set();
  const visit = (m) => {
    const staff = score.measures[m] && score.measures[m].staves[staffKey];
    if (!staff) return;
    staff.voices.forEach((events, voice) => events.forEach((event, index) => {
      event.pitches.forEach((p) => {
        if (!p.tie) return;
        const next = nextInVoice(score, { mi: m, staffKey, voice, index });
        if (next && next.mi === mi) out.add(`${next.event.id}:${pitchMidi(p)}`);
      });
    }));
  };
  visit(mi);
  visit(mi - 1);
  return out;
}

// ---------------------------------------------------------------------------
// Keeping it whole
// ---------------------------------------------------------------------------

/**
 * Make a score obey its own rules: every staff has a voice 1 that fills each
 * measure exactly, the other voices are empty or fill it too, every event has
 * an id, every chord is lowest-first.  Run after every edit and on load, so
 * no other code has to defend against a half-written measure.
 */
export function normalise(score) {
  if (!score.parts || !score.parts.length) score.parts = [newPart("treble")];
  if (!score.measures || !score.measures.length) score.measures = [{ time: [4, 4], key: 0, staves: {} }];
  if (!score.measures[0].time) score.measures[0].time = [4, 4];
  if (score.measures[0].key == null) score.measures[0].key = 0;
  const keys = staves(score).map((s) => s.key);
  score.measures.forEach((measure, mi) => {
    measure.staves = measure.staves || {};
    // A staff that belongs to no part any more goes with it.
    Object.keys(measure.staves).forEach((k) => { if (!keys.includes(k)) delete measure.staves[k]; });
    const capacity = measureTicks(score, mi);
    keys.forEach((staffKey) => {
      const voices = voicesOf(score, mi, staffKey);
      voices.forEach((events, voice) => {
        events.forEach((e) => {
          if (!e.id) e.id = newId();
          if (!Array.isArray(e.pitches)) e.pitches = [];
          if (!Array.isArray(e.art)) e.art = [];
          if (!e.rest && !e.pitches.length) e.rest = true;
          if (e.rest) e.pitches = [];
          else e.pitches = sortPitches(e.pitches);
        });
        if (voice > 0 && events.every((e) => e.rest)) { voices[voice] = []; return; }
        voices[voice] = fit(events, capacity);
      });
    });
  });
  return score;
}

/** Events cut or padded to fill exactly `capacity` ticks. */
function fit(events, capacity) {
  const out = [];
  let tick = 0;
  for (const event of events) {
    const length = eventTicks(event);
    if (tick + length <= capacity) {
      out.push(event);
      tick += length;
      continue;
    }
    // The last event runs past the barline (a time signature got shorter):
    // it keeps what fits.
    const room = capacity - tick;
    if (room > 0) splitTicks(room).forEach((d, i) => out.push(Object.assign(clone(event), d, { id: i ? newId() : event.id, tuplet: null })));
    tick = capacity;
    break;
  }
  if (tick < capacity) out.push(...restsFor(capacity - tick, tick, capacity));
  return out;
}

// ---------------------------------------------------------------------------
// Writing — MuseScore's way
// ---------------------------------------------------------------------------

/**
 * Write `event` into a voice at `tick`, over whatever was there.
 *
 * What a notation program does when you type a note: the new note takes its
 * time from the notes it lands on.  A note it covers completely is gone; one
 * it cuts into keeps the part before it; whatever is left of the last one it
 * reaches becomes rest.  A note too long for what is left of the measure is
 * written as far as the barline and tied into the next measure — made if
 * there is none — so the music carries on exactly as long as it was asked to.
 *
 * Mutates `score`; returns the id of the (first) event written.
 */
export function writeEvent(score, { mi, staffKey, voice, tick }, event) {
  let remaining = eventTicks(event);
  let firstId = null;
  let previousPiece = null;
  let m = mi;
  let at = tick;
  while (remaining > 0) {
    if (m >= score.measures.length) score.measures.push({ staves: {} });
    const capacity = measureTicks(score, m);
    const voices = voicesOf(score, m, staffKey);
    if (!voices[voice].length) voices[voice] = restsFor(capacity, 0, capacity);
    const room = capacity - at;
    const length = Math.min(remaining, room);
    // Written as asked when it fits; otherwise as the written values that
    // make up the part that fits, tied — a tuplet that has to be split is no
    // longer one.
    const whole = length === eventTicks(event);
    const pieces = whole ? [{ dur: event.dur, dots: event.dots || 0 }] : splitTicks(length);
    const written = pieces.map((d, i) => {
      const piece = Object.assign(clone(event), d);
      const first = !firstId && i === 0;
      piece.id = first ? (event.id || newId()) : newId();
      if (!whole) piece.tuplet = null;
      // The marks written on a note belong to where it starts.
      if (!first) Object.assign(piece, { dyn: null, hairpin: null, art: [], slur: false });
      return piece;
    });
    // Pieces of one note are tied together, and to whatever came before.
    if (!event.rest) {
      const chain = previousPiece ? [previousPiece, ...written] : written;
      chain.forEach((piece, i) => {
        if (i < chain.length - 1) piece.pitches.forEach((p) => { p.tie = true; });
      });
    }
    voices[voice] = overwrite(voices[voice], at, written, capacity);
    if (!firstId) firstId = written[0].id;
    previousPiece = written[written.length - 1];
    remaining -= length;
    m += 1;
    at = 0;
  }
  // The last piece keeps the tie the note itself was written with.
  if (previousPiece && !event.rest) {
    previousPiece.pitches.forEach((p, i) => { p.tie = !!(event.pitches[i] && event.pitches[i].tie); });
  }
  return firstId;
}

/** `events` with `written` laid over them from `at`, padded with rests. */
function overwrite(events, at, written, capacity) {
  const length = written.reduce((sum, e) => sum + eventTicks(e), 0);
  const end = at + length;
  const out = [];
  timed(events).forEach(({ event, start, end: stop }) => {
    if (stop <= at) { out.push(event); return; }
    if (start >= end) return;
    // Cut into from the right: keep the part before the new note.
    if (start < at) {
      splitTicks(at - start).forEach((d, i) => {
        const piece = Object.assign(clone(event), d, { id: i ? newId() : event.id, tuplet: null });
        out.push(piece);
      });
    }
  });
  out.push(...written);
  // What the new note left of the event it ended in becomes rest.
  const after = timed(events).filter(({ start, end: stop }) => stop > end || start >= end);
  let tick = end;
  after.forEach(({ event, start, end: stop }) => {
    if (start >= end) {
      if (start > tick) out.push(...restsFor(start - tick, tick, capacity));
      out.push(event);
      tick = stop;
      return;
    }
    out.push(...restsFor(stop - end, end, capacity));
    tick = stop;
  });
  return fit(out, capacity);
}

/** Write a note (or rest) at a cursor; returns its id. */
export function writeNote(score, cursor, { pitches = null, dur = "q", dots = 0, tuplet = null } = {}) {
  const event = pitches ? noteEvent(pitches, dur, dots) : restEvent(dur, dots);
  if (tuplet) event.tuplet = tuplet;
  const id = writeEvent(score, cursor, event);
  normalise(score);
  return id;
}

/** Turn an event into a rest of the same length (MuseScore's Delete). */
export function eraseEvent(score, id) {
  const where = locate(score, id);
  if (!where) return false;
  const voices = score.measures[where.mi].staves[where.staffKey].voices;
  const event = voices[where.voice][where.index];
  voices[where.voice][where.index] = Object.assign(restEvent(event.dur, event.dots), { id: event.id, tuplet: event.tuplet });
  normalise(score);
  return true;
}

/** Give an event a new length, keeping where it starts. */
export function setDuration(score, id, dur, dots = 0) {
  const where = locate(score, id);
  if (!where) return null;
  const event = clone(where.event);
  Object.assign(event, { dur, dots, tuplet: null });
  const newId_ = writeEvent(score, { mi: where.mi, staffKey: where.staffKey, voice: where.voice, tick: where.start }, event);
  normalise(score);
  return newId_;
}

/** Add a pitch to a note, making a chord; a rest becomes the note. */
export function addPitch(score, id, pitch) {
  const where = locate(score, id);
  if (!where) return false;
  const event = where.event;
  if (event.pitches.some((p) => pitchMidi(p) === pitchMidi(pitch))) return false;
  event.rest = false;
  event.pitches = sortPitches(event.pitches.concat([Object.assign({ tie: false }, pitch)]));
  normalise(score);
  return true;
}

export function removePitch(score, id, pitchIndex) {
  const where = locate(score, id);
  if (!where) return false;
  const event = where.event;
  if (event.pitches.length <= 1) return eraseEvent(score, id);
  event.pitches.splice(pitchIndex, 1);
  normalise(score);
  return true;
}

/** Change pitches in place: `fn(pitch) -> pitch`. */
export function mapPitches(score, ids, fn) {
  ids.forEach((id) => {
    const where = locate(score, id);
    if (!where || where.event.rest) return;
    where.event.pitches = sortPitches(where.event.pitches.map((p) => Object.assign({}, fn(p), { tie: p.tie })));
  });
  normalise(score);
}

/**
 * Tie the selected notes to the next note in their voice — or untie them.
 * A tie joins the same pitch, so a pitch the next note does not have is
 * given to it: tying a C to a rest writes the C over the rest.
 */
export function toggleTie(score, ids) {
  const located = ids.map((id) => locate(score, id)).filter((w) => w && !w.event.rest);
  if (!located.length) return false;
  const on = !located.every((w) => w.event.pitches.every((p) => p.tie));
  located.forEach((where) => {
    where.event.pitches.forEach((p) => { p.tie = on; });
    if (!on) return;
    const next = nextInVoice(score, where);
    if (!next) return;
    if (next.event.rest) {
      next.event.rest = false;
      next.event.pitches = where.event.pitches.map((p) => Object.assign({}, p, { tie: false }));
    } else {
      where.event.pitches.forEach((p) => {
        if (!next.event.pitches.some((q) => pitchMidi(q) === pitchMidi(p))) {
          next.event.pitches.push(Object.assign({}, p, { tie: false }));
        }
      });
    }
  });
  normalise(score);
  return true;
}

/** Set (or with `value` null, clear) a property on events. */
export function setEventProps(score, ids, props) {
  ids.forEach((id) => {
    const where = locate(score, id);
    if (where) Object.assign(where.event, props);
  });
  normalise(score);
}

export function toggleArticulation(score, ids, name) {
  const events = ids.map((id) => locate(score, id)).filter((w) => w && !w.event.rest).map((w) => w.event);
  if (!events.length) return;
  const on = !events.every((e) => e.art.includes(name));
  events.forEach((e) => {
    e.art = e.art.filter((a) => a !== name);
    if (on) e.art.push(name);
  });
}

/**
 * Make a run of notes a tuplet: the first selected note's value, `num` of
 * them in the time of `den`.  The selected note is divided into the tuplet,
 * the way the exercise editor divides one.
 */
export function makeTuplet(score, id, num, den) {
  const where = locate(score, id);
  if (!where) return false;
  const event = where.event;
  const total = eventTicks(Object.assign({}, event, { tuplet: null }));
  // The notes of the tuplet are each the value that, `den` of them, makes
  // the original: a quarter into a triplet is three triplet eighths.
  const unit = durationFor(total / den);
  if (!unit) return false;
  const tuplet = { id: newId("t"), num, den };
  const pieces = [];
  for (let i = 0; i < num; i += 1) {
    const piece = i === 0 && !event.rest
      ? Object.assign(clone(event), unit, { id: event.id, tuplet })
      : Object.assign(restEvent(unit.dur, unit.dots), { tuplet });
    pieces.push(piece);
  }
  const voices = score.measures[where.mi].staves[where.staffKey].voices;
  voices[where.voice].splice(where.index, 1, ...pieces);
  normalise(score);
  return true;
}

// ---------------------------------------------------------------------------
// Measures and parts
// ---------------------------------------------------------------------------

export function insertMeasures(score, at, count = 1) {
  for (let i = 0; i < count; i += 1) score.measures.splice(at, 0, { staves: {} });
  normalise(score);
}

export function deleteMeasures(score, from, to) {
  if (score.measures.length - (to - from + 1) < 1) return false;
  const first = score.measures[from];
  const removed = score.measures.splice(from, to - from + 1);
  // What the first deleted measure said about time and key still holds for
  // the music after it.
  const next = score.measures[from];
  if (next) {
    const time = removed.slice().reverse().find((m) => m.time);
    const key = removed.slice().reverse().find((m) => m.key != null);
    if (time && !next.time) next.time = time.time;
    if (key && next.key == null) next.key = key.key;
  }
  if (from === 0 && first) {
    if (!score.measures[0].time) score.measures[0].time = first.time || [4, 4];
    if (score.measures[0].key == null) score.measures[0].key = first.key || 0;
  }
  normalise(score);
  return true;
}

export function setMeasureProps(score, from, to, props) {
  for (let mi = from; mi <= to; mi += 1) {
    const measure = score.measures[mi];
    if (!measure) continue;
    Object.entries(props).forEach(([k, v]) => {
      if (v == null || v === false) delete measure[k];
      else measure[k] = v;
    });
  }
  normalise(score);
}

export function addPart(score, instrument) {
  score.parts.push(newPart(instrument));
  normalise(score);
}

export function removePart(score, partId) {
  if (score.parts.length <= 1) return false;
  score.parts = score.parts.filter((p) => p.id !== partId);
  normalise(score);
  return true;
}

export function movePart(score, partId, delta) {
  const i = score.parts.findIndex((p) => p.id === partId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= score.parts.length) return false;
  const [part] = score.parts.splice(i, 1);
  score.parts.splice(j, 0, part);
  return true;
}

// ---------------------------------------------------------------------------
// Copy and paste
// ---------------------------------------------------------------------------

/** The events of one voice between two of its events, inclusive, as a clip. */
export function copyRange(score, fromId, toId) {
  const a = locate(score, fromId);
  const b = locate(score, toId);
  if (!a || !b || a.staffKey !== b.staffKey || a.voice !== b.voice) return null;
  const [first, last] = (a.mi < b.mi || (a.mi === b.mi && a.index <= b.index)) ? [a, b] : [b, a];
  const clip = [];
  for (let mi = first.mi; mi <= last.mi; mi += 1) {
    const events = score.measures[mi].staves[first.staffKey].voices[first.voice];
    const from = mi === first.mi ? first.index : 0;
    const to = mi === last.mi ? last.index : events.length - 1;
    for (let i = from; i <= to; i += 1) clip.push(clone(events[i]));
  }
  return clip;
}

/** Paste a clip at a cursor, writing over what is there. */
export function pasteClip(score, cursor, clip) {
  let { mi, tick } = cursor;
  let firstId = null;
  clip.forEach((event) => {
    const copy = Object.assign(clone(event), { id: newId() });
    const id = writeEvent(score, Object.assign({}, cursor, { mi, tick }), copy);
    if (!firstId) firstId = id;
    tick += eventTicks(copy);
    while (tick >= measureTicks(score, mi)) { tick -= measureTicks(score, mi); mi += 1; }
  });
  normalise(score);
  return firstId;
}

// ---------------------------------------------------------------------------
// Playing order
// ---------------------------------------------------------------------------

/**
 * The order the measures are played in, with repeats, endings and the
 * D.C./D.S. jumps worked out: a list of measure indices.
 *
 * The rules are the ordinary ones.  A repeat goes back to the last ‖: (or the
 * beginning) and is played `repeatTimes` times; an ending marked 1 is played
 * on the first time through and skipped after, one marked 2 on the second.
 * D.C. goes back to the beginning and D.S. to the segno, taking no repeats
 * the second time, and stops at Fine — or, "al Coda", jumps from To Coda to
 * the coda.
 */
export function playOrder(score) {
  const measures = score.measures;
  const order = [];
  const passes = new Map();      // repeat end -> times played
  let i = 0;
  let repeatStart = 0;
  let jumped = null;             // "fine" | "coda" once a D.C./D.S. has been taken
  let guard = 0;
  const segno = measures.findIndex((m) => m.nav === "segno");
  const coda = measures.findIndex((m) => m.nav === "coda");
  while (i < measures.length && guard < 10000) {
    guard += 1;
    const m = measures[i];
    if (m.repeatStart && !jumped) repeatStart = i;
    // An ending that does not belong to this pass is skipped.
    const pass = (passes.get(repeatFor(measures, i)) || 0) + 1;
    if (m.volta && !jumped && !m.volta.includes(pass)) { i += 1; continue; }
    order.push(i);
    if (jumped === "fine" && m.nav === "fine") break;
    if (jumped === "coda" && m.nav === "tocoda" && coda >= 0) { i = coda; jumped = "done"; continue; }
    if (m.repeatEnd && !jumped) {
      const times = m.repeatTimes || 2;
      const done = (passes.get(i) || 0) + 1;
      passes.set(i, done);
      if (done < times) { i = repeatStart; continue; }
    }
    if (!jumped && m.nav && /^(dc|ds)/.test(m.nav)) {
      jumped = /alfine$/.test(m.nav) ? "fine" : /alcoda$/.test(m.nav) ? "coda" : "end";
      i = m.nav.startsWith("ds") && segno >= 0 ? segno : 0;
      continue;
    }
    i += 1;
  }
  return order;
}

/**
 * The repeat sign that decides which time through an ending is on.  A first
 * ending holds its repeat sign; a second ending comes after it.  So: forward
 * through the run of endings, and failing that, back to the last repeat sign.
 */
function repeatFor(measures, i) {
  for (let j = i; j < measures.length && measures[j].volta; j += 1) if (measures[j].repeatEnd) return j;
  for (let j = i - 1; j >= 0; j -= 1) if (measures[j].repeatEnd) return j;
  return -1;
}

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

/**
 * What a phrase covers, in score time: from where its start note begins to
 * where its end note ends.  `null` when either note has gone (deleted since
 * the phrase was marked).
 */
export function phraseSpan(score, phrase) {
  const events = allEvents(score);
  const a = events.find((e) => e.event.id === phrase.start);
  const b = events.find((e) => e.event.id === phrase.end);
  if (!a || !b) return null;
  const from = Math.min(a.abs, b.abs);
  const to = Math.max(a.absEnd, b.absEnd);
  return { from, to, fromMeasure: Math.min(a.mi, b.mi), toMeasure: Math.max(a.mi, b.mi) };
}
