/**
 * layout.js — a dictation score, engraved.
 *
 * Draws the document `score.js` describes as a real score: systems of
 * staves, one line per part (two braced staves for a piano), clefs and key
 * signatures at the start of every system, measures stretched to fill the
 * line, voices sharing a staff with their stems apart, chords, ties across
 * barlines and across systems, slurs, hairpins, dynamics, articulations,
 * tuplets, repeat barlines, first and second endings, D.C./D.S. marks, tempo
 * marks — and, for the editor, the phrases a teacher has cut, as brackets
 * over the music.
 *
 * The drawing is VexFlow's.  What is decided here is the layout — where the
 * measures go and how wide they are — and the map back from the drawing to
 * the document, so a click on a notehead can be answered with the event it
 * belongs to.
 */

import { resolveVexFlow } from "../components/staveLayout.js?v=184";
import * as S from "./score.js?v=184";

export const METRICS = {
  margin: 14,          // left and right
  nameWidth: 76,       // room for part names on the first system
  top: 96,             // above the first system: phrases, then tempo and endings
  staffGap: 78,        // top line to top line within a part
  laneOffset: 17,      // under a staff, the centre of its dynamics lane
  partGap: 84,         // between parts
  systemGap: 96,       // between systems
  minMeasure: 70,
  clefWidth: 34,
  keyAccWidth: 10,
  timeWidth: 28,
};

/** SMuFL dynamics glyphs, by letter. */
const DYNAMIC_GLYPHS = { p: "", m: "", f: "", r: "", s: "", z: "" };
const ARTICULATION_CODES = {
  staccato: "a.", accent: "a>", tenuto: "a-", marcato: "a^", fermata: "a@a",
};
/** The line a rest sits on in each clef, as a VexFlow key. */
const REST_KEYS = {
  treble: ["b/4", "e/5", "f/4"], bass: ["d/3", "g/3", "a/2"],
  alto: ["c/4", "f/4", "g/3"], tenor: ["a/3", "d/4", "e/3"],
};
/** The diatonic step of each clef's top line (see `score.pitchStep`). */
const TOP_LINE = {
  treble: 5 * 7 + 3,      // F5
  bass: 3 * 7 + 5,        // A3
  alto: 4 * 7 + 4,        // G4
  tenor: 4 * 7 + 2,       // E4
  treble8vb: 4 * 7 + 3,   // F4: the treble clef an octave down
};

function vexClefOf(clef) {
  return clef === "treble8vb" ? "treble" : clef;
}

/** How a clef displaces what it shows, in octaves (treble 8vb shows up one). */
function displayShift(clef) {
  return clef === "treble8vb" ? 1 : 0;
}

export function dynamicText(dyn) {
  return (dyn || "").split("").map((c) => DYNAMIC_GLYPHS[c] || "").join("");
}

/**
 * Build the VexFlow notes for one measure of one staff.
 *
 * Returned fresh every time, because VexFlow attaches a note to the formatter
 * that lays it out: the layout measures a measure once to learn how wide it
 * wants to be and builds it again to draw it.
 */
function buildStaffMeasure(VF, score, mi, staffKey, accidentals) {
  const measure = score.measures[mi];
  const staff = measure.staves[staffKey];
  const clef = S.clefAt(score, staffKey, mi);
  const vfClef = vexClefOf(clef);
  const shift = displayShift(clef);
  const [num, den] = S.timeAt(score, mi);
  const used = staff.voices.map((events, voice) => ({ events, voice })).filter((v) => v.events.length);
  const poly = used.length > 1;
  const voices = [];
  const beams = [];
  const tuplets = [];
  const entries = [];

  used.forEach(({ events, voice }) => {
    const notes = events.map((event, index) => {
      const duration = event.dur + "d".repeat(event.dots || 0);
      let note;
      // A rest that fills the whole measure is a whole rest, centred, in
      // any meter — that is how an empty measure is engraved.
      const wholeMeasure = event.rest && events.length === 1;
      if (event.rest) {
        const keys = REST_KEYS[vfClef] || REST_KEYS.treble;
        note = new VF.StaveNote({
          keys: [poly ? keys[voice % 2 === 0 ? 1 : 2] : keys[0]],
          duration: (wholeMeasure ? "w" : duration) + "r", clef: vfClef,
          alignCenter: wholeMeasure, align_center: wholeMeasure,
        });
      } else {
        note = new VF.StaveNote({
          keys: event.pitches.map((p) => `${p.step.toLowerCase()}/${p.octave + shift}`),
          duration, clef: vfClef, autoStem: !poly,
        });
        if (poly) note.setStemDirection(voice % 2 === 0 ? 1 : -1);
        (accidentals.get(event.id) || []).forEach((acc, keyIndex) => {
          if (acc) note.addModifier(new VF.Accidental(acc), keyIndex);
        });
        const up = (note.getStemDirection ? note.getStemDirection() : 1) === 1;
        (event.art || []).forEach((name) => {
          const code = ARTICULATION_CODES[name];
          if (!code) return;
          try {
            const art = new VF.Articulation(code);
            const position = name === "fermata" || !up ? VF.Modifier.Position.ABOVE : VF.Modifier.Position.BELOW;
            art.setPosition(position);
            note.addModifier(art, 0);
          } catch (e) { /* an articulation is decoration */ }
        });
      }
      if (event.dots && !wholeMeasure) {
        try { VF.Dot.buildAndAttach([note], { all: true }); } catch (e) { /* dots are decoration */ }
      }
      // Dynamics and hairpins are drawn by `drawDynamics`, under the note's
      // own staff: VexFlow's own placement measures from the bottom of the
      // page's text area and put a treble staff's forte in the bass staff.
      entries.push({ event, note, voice, index });
      return note;
    });

    // Tuplets: runs of notes carrying the same tuplet id.
    const groups = [];
    let run = [];
    const close = () => { if (run.length) groups.push(run); run = []; };
    events.forEach((event, i) => {
      if (!event.tuplet) { close(); return; }
      if (run.length && events[i - 1].tuplet && events[i - 1].tuplet.id !== event.tuplet.id) close();
      run.push(i);
    });
    close();
    const inTuplet = new Set();
    groups.forEach((indexes) => {
      const t = events[indexes[0]].tuplet;
      const group = indexes.map((i) => notes[i]);
      indexes.forEach((i) => inTuplet.add(i));
      try {
        const beamable = group.length > 1 && indexes.every((i) => !events[i].rest && ["8", "16", "32", "64"].includes(events[i].dur));
        tuplets.push(new VF.Tuplet(group, { numNotes: t.num, notesOccupied: t.den, bracketed: !beamable }));
        if (beamable) beams.push(new VF.Beam(group));
      } catch (e) { /* a malformed tuplet costs its bracket only */ }
    });
    // Beams for everything outside a tuplet, grouped by the beat.
    const plain = notes.filter((_, i) => !inTuplet.has(i));
    try {
      VF.Beam.generateBeams(plain, {
        groups: VF.Beam.getDefaultBeamGroups(`${num}/${den}`),
        maintainStemDirections: poly,
      }).forEach((b) => beams.push(b));
    } catch (e) { /* beaming is decoration */ }

    const vfVoice = new VF.Voice({ numBeats: num, beatValue: den }).setStrict(false);
    vfVoice.addTickables(notes);
    voices.push(vfVoice);
  });
  return { voices, beams, tuplets, entries, clef, poly };
}

/** The width a measure's head needs: clef, key, time, as drawn at `mi`. */
function headWidth(score, mi, first) {
  const measure = score.measures[mi];
  const previousKey = mi > 0 ? S.keyAt(score, mi - 1) : 0;
  let width = 0;
  if (first) width += METRICS.clefWidth + Math.abs(S.keyAt(score, mi)) * METRICS.keyAccWidth;
  else if (measure.key != null && measure.key !== previousKey) {
    width += (Math.abs(measure.key) + (measure.key === 0 ? Math.abs(previousKey) : 0)) * METRICS.keyAccWidth + 6;
  }
  if (measure.time && (mi === 0 || timeChanged(score, mi))) width += METRICS.timeWidth;
  if (first && mi > 0) width += 4;
  return width;
}

function timeChanged(score, mi) {
  const time = score.measures[mi].time;
  if (!time) return false;
  if (mi === 0) return true;
  const before = S.timeAt(score, mi - 1);
  return before[0] !== time[0] || before[1] !== time[1];
}

/**
 * How tall one system has to be, and where each staff goes in it.
 *
 * Measured from the music on the line, the way an engraver spaces staves:
 * notes far above or below a staff, the stems that reach further still, the
 * articulations over them and a lane for dynamics under them.  Two staves are
 * kept at least the usual distance apart, and moved further apart when the
 * notes between them need the room — rather than drawn into each other.
 */
function verticalFor(score, mis, list) {
  const ext = list.map(() => ({ top: 0, bottom: 40, lane: false }));
  list.forEach((s, i) => {
    mis.forEach((mi) => {
      const staff = score.measures[mi].staves[s.key];
      if (!staff) return;
      const top = TOP_LINE[S.clefAt(score, s.key, mi)] ?? TOP_LINE.treble;
      const poly = staff.voices.filter((v) => v.length).length > 1;
      staff.voices.forEach((events, voice) => events.forEach((e) => {
        if (e.dyn || e.hairpin || e.hairpinEnd) ext[i].lane = true;
        if (e.rest) return;
        const ys = e.pitches.map((p) => (top - S.pitchStep(p)) * 5);
        const hi = Math.min(...ys);
        const lo = Math.max(...ys);
        const stem = e.dur !== "w";
        const up = poly ? voice % 2 === 0 : (hi + lo) / 2 > 20;
        ext[i].top = Math.min(ext[i].top, hi - 7, stem && up ? lo - 36 : 0);
        ext[i].bottom = Math.max(ext[i].bottom, lo + 7, stem && !up ? hi + 36 : 40);
        if ((e.art || []).length) {
          ext[i].top = Math.min(ext[i].top, hi - 20);
          ext[i].bottom = Math.max(ext[i].bottom, lo + 16);
        }
      }));
    });
  });
  const offsets = [];
  let y = 0;
  list.forEach((s, i) => {
    if (i > 0) {
      const prev = ext[i - 1];
      const below = prev.bottom - 40 + (prev.lane ? 28 : 0);
      const above = -ext[i].top;
      const minGap = (list[i - 1].part.id === s.part.id ? METRICS.staffGap : METRICS.partGap) - 40;
      y += 40 + Math.max(minGap, below + above + 8);
    }
    offsets.push(y);
  });
  const last = ext[ext.length - 1];
  return {
    offsets,
    above: Math.max(0, -ext[0].top),
    height: y + Math.max(40, last.bottom + (last.lane ? 28 : 0)),
  };
}

/** Every staff's vertical place within a system, from the system's top. */
function staffOffsets(score) {
  const list = S.staves(score);
  let y = 0;
  return list.map((s, i) => {
    if (i > 0) y += list[i - 1].part.id === s.part.id ? METRICS.staffGap : METRICS.partGap;
    return Object.assign({ offset: y }, s);
  });
}

/**
 * Draw `score` into `container`.  Returns the layout — the drawn SVG and the
 * map from the drawing back to the document — for the editor to hit-test
 * against and paint over.
 *
 * opts: { width, selected: Set<eventId>, playing: eventId, phrases: [...],
 *         showNames: true, measureNumbers: true }
 */
export function renderScore(container, score, opts = {}) {
  const VF = resolveVexFlow();
  container.innerHTML = "";
  if (!VF) {
    container.textContent = "VexFlow did not load — the score cannot be drawn.";
    return null;
  }
  const width = Math.max(360, opts.width || container.clientWidth || 900);
  const list = staffOffsets(score);
  const nameWidth = opts.showNames === false ? 0 : (list.some((s) => s.part.name) ? METRICS.nameWidth : 0);

  // --- How wide each measure wants to be --------------------------------
  const widths = score.measures.map((_, mi) => {
    const formatter = new VF.Formatter();
    const all = [];
    list.forEach(({ key }) => {
      const built = buildStaffMeasure(VF, score, mi, key, S.accidentalsFor(score, mi, key));
      if (built.voices.length) { formatter.joinVoices(built.voices); all.push(...built.voices); }
    });
    let min = 0;
    try { min = all.length ? formatter.preCalculateMinTotalWidth(all) : 0; } catch (e) { min = 120; }
    // Room to breathe: a minimum-width measure reads as a cramped one.
    return Math.max(METRICS.minMeasure, Math.round(min * 1.35 + 34));
  });

  // --- Into systems --------------------------------------------------------
  // Measures fill a line until the next would not fit; the first system
  // leaves room on the left for the part names.
  const systems = [];
  let current = null;
  const startSystem = () => {
    const left = METRICS.margin + (systems.length === 0 ? nameWidth : 0);
    current = { measures: [], used: 0, left, lineWidth: width - left - METRICS.margin };
  };
  score.measures.forEach((_, mi) => {
    if (!current) startSystem();
    const appended = headWidth(score, mi, current.measures.length === 0);
    if (current.measures.length && current.used + widths[mi] + appended > current.lineWidth) {
      systems.push(current);
      startSystem();
    }
    const head = headWidth(score, mi, current.measures.length === 0);
    current.measures.push({ mi, natural: widths[mi], head });
    current.used += widths[mi] + head;
  });
  if (current) systems.push(current);

  // Each system as tall as its own music needs, one under the other.
  let cursorY = METRICS.top;
  systems.forEach((system, si) => {
    system.vertical = verticalFor(score, system.measures.map((m) => m.mi), list);
    // Notes high over the top staff push the system down, so the tempo
    // mark, the endings and the phrase brackets stay clear of them.
    cursorY += Math.max(0, system.vertical.above - 20);
    system.top = cursorY;
    cursorY += system.vertical.height + METRICS.systemGap;
  });
  const height = cursorY + 20;
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const context = renderer.getContext();
  context.setFillStyle("#16171a");
  context.setStrokeStyle("#16171a");
  const svg = container.querySelector("svg");

  const layout = {
    svg, width, height, systems: [], measures: [], events: new Map(),
    score,
  };
  const ties = [];

  systems.forEach((system, si) => {
    const top = system.top;
    const last = si === systems.length - 1;
    // Stretched to the line, except a short last system, which is left at
    // its natural width rather than pulled thin across the page.
    const natural = system.measures.reduce((sum, m) => sum + m.natural + m.head, 0);
    const stretch = (last && natural < system.lineWidth * 0.66) ? 1 : (system.lineWidth / natural);
    let x = system.left;
    const systemInfo = { index: si, top, bottom: top + system.vertical.height, measures: [], staves: {} };
    layout.systems.push(systemInfo);

    system.measures.forEach((m, k) => {
      const { mi } = m;
      const measure = score.measures[mi];
      const measureWidth = Math.round((m.natural + m.head) * stretch);
      const firstInSystem = k === 0;
      const staveObjs = [];
      list.forEach((s) => {
        const y = top + system.vertical.offsets[list.indexOf(s)];
        const stave = new VF.Stave(x, y - 40, measureWidth);
        const clef = S.clefAt(score, s.key, mi);
        const clefChanged = !firstInSystem && measure.staves[s.key] && measure.staves[s.key].clef
          && S.clefAt(score, s.key, mi - 1) !== clef;
        try {
          if (firstInSystem || clefChanged) {
            stave.addClef(vexClefOf(clef), clefChanged ? "small" : "default", clef === "treble8vb" ? "8vb" : undefined);
          }
          const key = S.keyAt(score, mi);
          const previousKey = mi > 0 ? S.keyAt(score, mi - 1) : 0;
          if (firstInSystem && key !== 0) stave.addKeySignature(S.vexKey(key));
          else if (!firstInSystem && measure.key != null && measure.key !== previousKey) {
            stave.addKeySignature(S.vexKey(measure.key), S.vexKey(previousKey));
          }
          if (measure.time && (mi === 0 || timeChanged(score, mi))) {
            stave.addTimeSignature(`${measure.time[0]}/${measure.time[1]}`);
          }
          if (measure.repeatStart) stave.setBegBarType(VF.Barline.type.REPEAT_BEGIN);
          if (measure.repeatEnd) stave.setEndBarType(VF.Barline.type.REPEAT_END);
          else if (measure.barline === "double") stave.setEndBarType(VF.Barline.type.DOUBLE);
          else if (measure.barline === "final" || mi === score.measures.length - 1) stave.setEndBarType(VF.Barline.type.END);
        } catch (e) { /* a head VexFlow will not draw is not worth the measure */ }
        // The marks that belong to the system rather than to one staff go
        // on its top staff: tempo, endings, jumps.
        if (s === list[0]) decorateTop(VF, score, mi, stave, firstInSystem);
        stave.setContext(context);
        staveObjs.push({ s, stave, clef });
      });

      // Notes start at the same x on every staff, or the parts do not line up.
      const start = Math.max(...staveObjs.map((o) => o.stave.getNoteStartX()));
      staveObjs.forEach((o) => o.stave.setNoteStartX(start));
      staveObjs.forEach((o) => o.stave.draw());

      // Barline connectors through each multi-staff part.
      drawPartConnectors(VF, context, score, staveObjs, firstInSystem);

      const formatter = new VF.Formatter();
      const built = staveObjs.map((o) => {
        const b = buildStaffMeasure(VF, score, mi, o.s.key, S.accidentalsFor(score, mi, o.s.key));
        if (b.voices.length) formatter.joinVoices(b.voices);
        return Object.assign(b, o);
      });
      const allVoices = built.flatMap((b) => b.voices);
      const formatWidth = Math.max(20, x + measureWidth - start - 14);
      try { if (allVoices.length) formatter.format(allVoices, formatWidth); } catch (e) { /* drawn unformatted */ }
      built.forEach((b) => {
        b.voices.forEach((voice) => { try { voice.draw(context, b.stave); } catch (e) { /* skip */ } });
        b.beams.forEach((beam) => { try { beam.setContext(context).draw(); } catch (e) { /* skip */ } });
        b.tuplets.forEach((t) => { try { t.setContext(context).draw(); } catch (e) { /* skip */ } });
        b.entries.forEach(({ event, note, voice, index }) => {
          let el = null;
          try { el = note.getSVGElement ? note.getSVGElement() : null; } catch (e) { el = null; }
          const entry = {
            id: event.id, event, note, el, mi, staffKey: b.s.key, voice, index, system: si,
            x: note.getAbsoluteX(), ys: safeYs(note),
          };
          if (el) {
            el.classList.add("dz-event");
            el.dataset.id = event.id;
            if (event.rest) el.classList.add("dz-rest");
            el.dataset.voice = String(voice + 1);
          }
          layout.events.set(event.id, entry);
          if (!event.rest && event.pitches.some((p) => p.tie)) ties.push(entry);
        });
        const lineTop = b.stave.getYForLine(0);
        const lineBottom = b.stave.getYForLine(4);
        const info = {
          mi, staffKey: b.s.key, system: si, stave: b.stave, clef: b.clef,
          x, width: measureWidth, top: lineTop, bottom: lineBottom,
          noteStart: start, noteEnd: x + measureWidth - 10,
        };
        layout.measures.push(info);
      });

      // The system's opening: a line through every staff, a brace for each
      // piano, the part names on the first system and a measure number on
      // the others.
      if (firstInSystem) {
        drawSystemStart(VF, context, score, staveObjs, si === 0 && nameWidth > 0, opts);
        if (si > 0 && opts.measureNumbers !== false) {
          context.save();
          context.setFont("Arial", 10, "", "italic");
          context.fillText(String(mi + 1), x, top - 18);
          context.restore();
        }
      }
      systemInfo.measures.push(mi);
      x += measureWidth;
    });
  });

  drawTies(VF, context, score, layout, ties);
  drawSlursAndHairpins(VF, context, score, layout);
  drawDynamics(context, layout);
  if (opts.phrases && opts.phrases.length) drawPhrases(context, score, layout, opts.phrases);
  paintState(layout, opts);
  return layout;
}

function safeYs(note) {
  try { return note.getYs(); } catch (e) { return []; }
}

/** Tempo, endings and jumps, on the top staff of a measure. */
function decorateTop(VF, score, mi, stave, firstInSystem) {
  const measure = score.measures[mi];
  try {
    if (mi === 0 || measure.tempo) {
      stave.setTempo({ duration: "q", bpm: measure.tempo || score.tempo || 80 }, -14);
    }
  } catch (e) { /* skip */ }
  if (measure.volta && measure.volta.length) {
    try {
      const same = (other) => other && other.volta && other.volta.join() === measure.volta.join();
      const begins = !same(score.measures[mi - 1]) || firstInSystem;
      const ends = !same(score.measures[mi + 1]);
      const T = VF.Volta.type;
      const type = begins && ends ? T.BEGIN_END : begins ? T.BEGIN : ends ? T.END : T.MID;
      stave.setVoltaType(type, begins ? measure.volta.map((n) => `${n}.`).join(" ") : "", -6);
    } catch (e) { /* skip */ }
  }
  if (measure.nav) {
    try {
      const R = VF.Repetition.type;
      const map = {
        segno: R.SEGNO_LEFT, coda: R.CODA_LEFT, fine: R.FINE, tocoda: R.TO_CODA,
        dc: R.DC, dcalfine: R.DC_AL_FINE, dcalcoda: R.DC_AL_CODA,
        ds: R.DS, dsalfine: R.DS_AL_FINE, dsalcoda: R.DS_AL_CODA,
      };
      if (map[measure.nav] != null) stave.setRepetitionType(map[measure.nav], 4);
    } catch (e) { /* skip */ }
  }
}

function drawPartConnectors(VF, context, score, staveObjs, firstInSystem) {
  score.parts.forEach((part) => {
    const own = staveObjs.filter((o) => o.s.part.id === part.id);
    if (own.length < 2) return;
    try {
      const line = new VF.StaveConnector(own[0].stave, own[own.length - 1].stave);
      line.setType(VF.StaveConnector.type.SINGLE_RIGHT);
      line.setContext(context).draw();
      if (firstInSystem) {
        const left = new VF.StaveConnector(own[0].stave, own[own.length - 1].stave);
        left.setType(VF.StaveConnector.type.SINGLE_LEFT);
        left.setContext(context).draw();
      }
    } catch (e) { /* chrome */ }
  });
}

function drawSystemStart(VF, context, score, staveObjs, names) {
  try {
    if (staveObjs.length > 1) {
      const line = new VF.StaveConnector(staveObjs[0].stave, staveObjs[staveObjs.length - 1].stave);
      line.setType(VF.StaveConnector.type.SINGLE_LEFT);
      line.setContext(context).draw();
    }
    score.parts.forEach((part) => {
      const own = staveObjs.filter((o) => o.s.part.id === part.id);
      if (own.length > 1) {
        const brace = new VF.StaveConnector(own[0].stave, own[own.length - 1].stave);
        brace.setType(VF.StaveConnector.type.BRACE);
        brace.setContext(context).draw();
      }
      if (names && part.name && own.length) {
        const first = own[0].stave;
        const lastStave = own[own.length - 1].stave;
        const y = (first.getYForLine(0) + lastStave.getYForLine(4)) / 2 + 4;
        context.save();
        context.setFont("Arial", 12);
        context.fillText(part.name, METRICS.margin, y);
        context.restore();
      }
    });
    // Single-staff parts side by side are bracketed together, as a choir is.
    const singles = staveObjs.filter((o) => o.s.part.staves.length === 1);
    if (singles.length > 1 && singles.length === staveObjs.length) {
      const bracket = new VF.StaveConnector(singles[0].stave, singles[singles.length - 1].stave);
      bracket.setType(VF.StaveConnector.type.BRACKET);
      bracket.setContext(context).draw();
    }
  } catch (e) { /* chrome */ }
}

function drawTies(VF, context, score, layout, ties) {
  ties.forEach((entry) => {
    const next = S.nextInVoice(score, { mi: entry.mi, staffKey: entry.staffKey, voice: entry.voice, index: entry.index });
    const target = next && layout.events.get(next.event.id);
    const firstIndexes = [];
    const lastIndexes = [];
    entry.event.pitches.forEach((p, i) => {
      if (!p.tie) return;
      const j = target ? target.event.pitches.findIndex((q) => S.pitchMidi(q) === S.pitchMidi(p)) : -1;
      firstIndexes.push(i);
      lastIndexes.push(j >= 0 ? j : i);
    });
    if (!firstIndexes.length) return;
    try {
      if (target && target.system === entry.system && !target.event.rest) {
        new VF.StaveTie({ firstNote: entry.note, lastNote: target.note, firstIndexes, lastIndexes }).setContext(context).draw();
      } else {
        // Across a system break: half a tie out of the old line and half
        // into the new, as a score prints it.
        new VF.StaveTie({ firstNote: entry.note, firstIndexes, lastIndexes: firstIndexes }).setContext(context).draw();
        if (target && !target.event.rest) {
          new VF.StaveTie({ lastNote: target.note, firstIndexes: lastIndexes, lastIndexes }).setContext(context).draw();
        }
      }
    } catch (e) { /* a tie VexFlow will not draw is decoration */ }
  });
}

/** Slurs (per voice) and hairpins (per staff), split at system breaks. */
function drawSlursAndHairpins(VF, context, score, layout) {
  const ordered = Array.from(layout.events.values()).sort((a, b) => (
    a.mi - b.mi || a.index - b.index
  ));
  const slurs = new Map();
  const hairpins = new Map();
  const drawSpan = (from, to, draw) => {
    if (from.system === to.system) { draw(from.note, to.note); return; }
    // The first system's part runs to its last note on that staff; the rest
    // starts from the first note of the system the span ends on.
    const lastOfFirst = ordered.filter((e) => e.system === from.system && e.staffKey === from.staffKey && e.voice === from.voice).pop();
    const firstOfLast = ordered.find((e) => e.system === to.system && e.staffKey === to.staffKey && e.voice === to.voice);
    if (lastOfFirst) draw(from.note, lastOfFirst.note);
    if (firstOfLast) draw(firstOfLast.note, to.note);
  };
  ordered.forEach((entry) => {
    const e = entry.event;
    const voiceKey = `${entry.staffKey}:${entry.voice}`;
    if (e.slur) slurs.set(voiceKey, entry);
    if (e.slurEnd && slurs.has(voiceKey)) {
      const from = slurs.get(voiceKey);
      slurs.delete(voiceKey);
      if (from !== entry) {
        drawSpan(from, entry, (a, b) => {
          try { new VF.Curve(a, b, {}).setContext(context).draw(); } catch (err) { /* skip */ }
        });
      }
    }
  });
  void hairpins;
}

/**
 * Dynamics and hairpins, in the lane just under each staff — where a player
 * reads them, and the one place they cannot be mistaken for the staff below.
 */
function drawDynamics(context, layout) {
  // One lane per staff per system: under the staff, or under the lowest
  // note hanging below it on that line, whichever is lower — a dynamic
  // written over a notehead cannot be read.
  const lanes = new Map();
  layout.events.forEach((entry) => {
    const m = layout.measures.find((x) => x.mi === entry.mi && x.staffKey === entry.staffKey);
    if (!m) return;
    const key = `${entry.system}:${entry.staffKey}`;
    let lowest = Math.max(m.bottom, ...(entry.event.rest ? [] : entry.ys));
    // A stem pointing down reaches further than its head.
    try {
      if (!entry.event.rest && entry.note.hasStem && entry.note.hasStem() && entry.note.getStemDirection() === -1) {
        const ext = entry.note.getStemExtents();
        lowest = Math.max(lowest, ext.topY, ext.baseY);
      }
    } catch (e) { /* the heads will do */ }
    lanes.set(key, Math.max(lanes.get(key) || 0, m.bottom + METRICS.laneOffset, lowest + 13));
  });
  const lane = (entry) => lanes.get(`${entry.system}:${entry.staffKey}`) ?? null;
  const ordered = Array.from(layout.events.values()).sort((a, b) => a.mi - b.mi || a.x - b.x);
  ordered.forEach((entry) => {
    if (!entry.event.dyn) return;
    const y = lane(entry);
    if (y == null) return;
    context.save();
    context.setFont("Bravura", 24);
    context.fillText(dynamicText(entry.event.dyn), entry.x - 4, y + 5);
    context.restore();
  });
  const open = new Map();
  ordered.forEach((entry) => {
    const e = entry.event;
    if (e.hairpin) open.set(entry.staffKey, entry);
    if (!e.hairpinEnd || !open.has(entry.staffKey)) return;
    const from = open.get(entry.staffKey);
    open.delete(entry.staffKey);
    const y = lane(from);
    if (y == null) return;
    const segments = [];
    if (from.system === entry.system) segments.push([from.x + (from.event.dyn ? 22 : 0), entry.x + 14, true, true]);
    else {
      const endOfLine = layout.measures.filter((m) => m.system === from.system && m.staffKey === from.staffKey).pop();
      const startOfLine = layout.measures.find((m) => m.system === entry.system && m.staffKey === entry.staffKey);
      if (endOfLine) segments.push([from.x, endOfLine.x + endOfLine.width - 6, true, false]);
      if (startOfLine) segments.push([startOfLine.noteStart, entry.x + 14, false, true]);
    }
    const cresc = from.event.hairpin !== ">";
    segments.forEach(([x1, x2, opens, closes]) => {
      if (x2 - x1 < 8) return;
      const yLane = from.system === entry.system ? y
        : (lanes.get(`${opens ? from.system : entry.system}:${from.staffKey}`) ?? y);
      // A crescendo opens to the right, a diminuendo to the left; a hairpin
      // carried over a line break is drawn part-open where it is cut.
      const closed = 0;
      const half = 2.5;
      const full = 5;
      const left = cresc ? (opens ? closed : half) : (opens ? full : half);
      const right = cresc ? (closes ? full : half) : (closes ? closed : half);
      context.beginPath();
      context.moveTo(x1, yLane - left);
      context.lineTo(x2, yLane - right);
      context.moveTo(x1, yLane + left);
      context.lineTo(x2, yLane + right);
      context.stroke();
    });
  });
}

/**
 * Phrases, as numbered brackets over the music.  `phrases` are
 * `{id, name, start, end, number, selected}`.
 */
function drawPhrases(context, score, layout, phrases) {
  const svgNS = "http://www.w3.org/2000/svg";
  const group = document.createElementNS(svgNS, "g");
  group.setAttribute("class", "dz-phrases");
  phrases.forEach((phrase, i) => {
    const a = layout.events.get(phrase.start);
    const b = layout.events.get(phrase.end);
    if (!a || !b) return;
    const [from, to] = (a.mi < b.mi || (a.mi === b.mi && a.x <= b.x)) ? [a, b] : [b, a];
    for (let si = from.system; si <= to.system; si += 1) {
      const sys = layout.systems[si];
      if (!sys) continue;
      const measures = layout.measures.filter((m) => m.system === si && m.staffKey === layout.measures[0].staffKey);
      if (!measures.length) continue;
      const x1 = si === from.system ? from.x - 4 : measures[0].noteStart - 6;
      const lastNote = to.note;
      const x2 = si === to.system
        ? (lastNote ? lastNote.getAbsoluteX() + 16 : to.x + 16)
        : measures[measures.length - 1].x + measures[measures.length - 1].width;
      // Above the tempo mark and the endings, which sit just over the staff;
      // neighbouring phrases alternate height so where one ends and the next
      // begins is never in doubt.
      const y = sys.top - 54 - (i % 2) * 12;
      const path = document.createElementNS(svgNS, "path");
      const openLeft = si !== from.system;
      const openRight = si !== to.system;
      path.setAttribute("d", `M${x1} ${y + (openLeft ? 0 : 7)} L${x1} ${y} L${x2} ${y} L${x2} ${y + (openRight ? 0 : 7)}`);
      path.setAttribute("class", `dz-phrase${phrase.selected ? " is-selected" : ""}`);
      path.dataset.phrase = phrase.id;
      group.appendChild(path);
      if (si === from.system) {
        const label = document.createElementNS(svgNS, "text");
        label.setAttribute("x", x1 + 4);
        label.setAttribute("y", y - 4);
        label.setAttribute("class", `dz-phrase-label${phrase.selected ? " is-selected" : ""}`);
        label.dataset.phrase = phrase.id;
        label.textContent = phrase.name || `Phrase ${phrase.number || i + 1}`;
        group.appendChild(label);
      }
    }
  });
  layout.svg.appendChild(group);
}

/** Selection and playback marks, repainted without a relayout. */
export function paintState(layout, { selected = null, playing = null, selectedPitch = null } = {}) {
  if (!layout) return;
  layout.svg.querySelectorAll(".dz-pitch-mark").forEach((n) => n.remove());
  layout.events.forEach((entry, id) => {
    if (!entry.el) return;
    entry.el.classList.toggle("is-selected", !!(selected && selected.has(id)));
    entry.el.classList.toggle("is-playing", playing === id);
  });
  // One pitch of a chord picked out: a ring round its head.
  if (selectedPitch && layout.events.has(selectedPitch.id)) {
    const entry = layout.events.get(selectedPitch.id);
    const y = entry.ys[selectedPitch.index];
    if (y != null) {
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      ring.setAttribute("cx", entry.x + 6);
      ring.setAttribute("cy", y);
      ring.setAttribute("rx", 10);
      ring.setAttribute("ry", 7.5);
      ring.setAttribute("class", "dz-pitch-mark");
      layout.svg.appendChild(ring);
    }
  }
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** The event (and pitch) under an SVG point, if any. */
export function eventAt(layout, x, y) {
  let best = null;
  let bestDistance = Infinity;
  layout.events.forEach((entry) => {
    if (Math.abs(x - (entry.x + 6)) > 12) return;
    const ys = entry.ys.length ? entry.ys : [];
    ys.forEach((hy, index) => {
      const d = Math.abs(y - hy);
      if (d > 8) return;
      const distance = d + Math.abs(x - (entry.x + 6)) * 0.5;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { id: entry.id, pitchIndex: entry.event.rest ? null : index, entry };
      }
    });
  });
  return best;
}

/** The measure-staff under an SVG point, if any (with a little reach). */
export function measureAt(layout, x, y) {
  return layout.measures.find((m) => (
    x >= m.x && x <= m.x + m.width && y >= m.top - 30 && y <= m.bottom + 30
  )) || null;
}

/** The pitch a height on a staff means (a line or a space), unaltered. */
export function stepAt(measureInfo, y) {
  const spacing = (measureInfo.bottom - measureInfo.top) / 4;
  const halfLines = Math.round((y - measureInfo.top) / (spacing / 2));
  const top = TOP_LINE[measureInfo.clef] ?? TOP_LINE.treble;
  return top - halfLines;
}

/** The height a line or space is drawn at on a staff (the inverse of `stepAt`). */
export function stepY(measureInfo, step) {
  const spacing = (measureInfo.bottom - measureInfo.top) / 4;
  const top = TOP_LINE[measureInfo.clef] ?? TOP_LINE.treble;
  return measureInfo.top + (top - step) * (spacing / 2);
}

/**
 * The x a tick in a voice is drawn at: the event that starts there, or a
 * point between its neighbours.  Where the note-input cursor is drawn.
 */
export function tickX(layout, score, { mi, staffKey, voice, tick }) {
  const info = layout.measures.find((m) => m.mi === mi && m.staffKey === staffKey);
  if (!info) return null;
  const events = (score.measures[mi].staves[staffKey] || { voices: [] }).voices[voice] || [];
  const timed = S.timed(events);
  const exact = timed.find((t) => t.start === tick);
  if (exact && layout.events.get(exact.event.id)) return layout.events.get(exact.event.id).x;
  const capacity = S.measureTicks(score, mi);
  return info.noteStart + (info.noteEnd - info.noteStart) * (tick / capacity);
}
