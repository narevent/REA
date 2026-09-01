/**
 * midiImport.js
 *
 * Read a Standard MIDI File and turn it into bars of this editor's score.
 *
 * Why this exists: entering a melody note by note is the slowest thing in the
 * editor, and every teacher who writes exercises already has them somewhere —
 * in a notation program, in a DAW, in a folder of MIDI files.  Importing one
 * is not a different way to write an exercise, it is the same exercise
 * arriving already written.
 *
 * What it deliberately does *not* try to be is a general MIDI importer.  A REA
 * exercise is a single melodic line with plain durations; a MIDI file can hold
 * sixteen channels of overlapping polyphony with tuplets and tempo curves.
 * The conversion therefore reduces rather than refuses, and says in its report
 * exactly what it reduced, so a teacher can see what they are getting before
 * it replaces the score they have open:
 *
 *   - every track is merged into one timeline (a melody exported from a
 *     notation program is often alone on track 2, with track 1 holding only
 *     the tempo map)
 *   - notes sounding together become their top note, which is the melody in
 *     all but pathological cases
 *   - durations snap to the editor's own list, longest-first, so a lightly
 *     humanised performance still lands on written note values
 *   - bars are cut at the file's time signature
 *
 * There is no dependency here, and there is deliberately not going to be one:
 * a MIDI file is a length-prefixed byte format, the whole reader is under a
 * hundred lines, and it runs on a file the user chose from their own disk.
 */

// `midiToToken` is the inverse of notation.js's own `noteTokenToMidi`, and
// lives beside it: the editor needs it too, to respell a note it has moved
// by a semitone.
import { midiToToken } from "../notation.js?v=164";
import { DURATIONS, LETTERS, blankBar, blankEvent } from "./scoreDoc.js?v=164";

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

class Reader {
  constructor(view, pos = 0) { this.v = view; this.p = pos; }
  u8() { return this.v.getUint8(this.p++); }
  u16() { const n = this.v.getUint16(this.p); this.p += 2; return n; }
  u32() { const n = this.v.getUint32(this.p); this.p += 4; return n; }
  str(n) {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  /** MIDI's variable-length quantity: seven bits per byte, high bit continues. */
  varint() {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      n = (n << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return n;
  }
}

/**
 * Parse a Standard MIDI File into a flat, absolute-time note list.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ticksPerQuarter, tempoBpm, timeSignature, notes, trackCount}}
 *          notes are `{ start, duration, midi, velocity }` in ticks, sorted.
 * @throws {Error} with a message meant to be shown to the user
 */
export function parseMidi(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 14) throw new Error("That file is too short to be a MIDI file.");
  const r = new Reader(view);
  if (r.str(4) !== "MThd") throw new Error("That doesn't look like a MIDI file (no MThd header).");
  const headerLength = r.u32();
  r.u16();                       // format 0/1/2 — the merge below covers all three
  const trackCount = r.u16();
  const division = r.u16();
  r.p = 8 + headerLength;        // headers may be longer than the 6 bytes we read

  if (division & 0x8000) {
    // SMPTE timecode division: frames per second and ticks per frame, with no
    // musical beat behind it at all.  Nothing in this editor's world (which is
    // written in note values) can be recovered from that honestly.
    throw new Error("This MIDI file is timed in SMPTE frames rather than beats, so it has no note values to import.");
  }
  const ticksPerQuarter = division || 480;

  let tempoBpm = null;
  let timeSignature = { numerator: 4, denominator: 4 };
  const notes = [];

  for (let t = 0; t < trackCount && r.p < view.byteLength; t++) {
    if (r.str(4) !== "MTrk") break;            // a malformed tail is not fatal
    const length = r.u32();
    const end = r.p + length;
    let time = 0;
    let status = 0;
    const sounding = new Map();                // midi -> { start, velocity }

    while (r.p < end) {
      time += r.varint();
      let b = r.u8();
      if (b & 0x80) status = b; else r.p--;    // running status: reuse the last
      const type = status & 0xf0;

      if (status === 0xff) {                   // meta
        const metaType = r.u8();
        const len = r.varint();
        const at = r.p;
        if (metaType === 0x51 && len === 3) {
          const usPerQuarter = (view.getUint8(at) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at + 2);
          // The first tempo in the file wins.  A tempo map is a curve and the
          // exercise has one number; taking the opening tempo is the reading
          // that matches how the piece starts.
          if (tempoBpm == null && usPerQuarter > 0) tempoBpm = Math.round(60000000 / usPerQuarter);
        } else if (metaType === 0x58 && len >= 2) {
          timeSignature = {
            numerator: view.getUint8(at) || 4,
            denominator: Math.pow(2, view.getUint8(at + 1)) || 4,
          };
        }
        r.p = at + len;
      } else if (status === 0xf0 || status === 0xf7) {
        r.p += r.varint();                     // sysex — nothing here for us
      } else if (type === 0x90 || type === 0x80) {
        const midi = r.u8();
        const velocity = r.u8();
        // A note-on at velocity zero is a note-off; every sequencer that uses
        // running status writes them that way.
        if (type === 0x90 && velocity > 0) {
          sounding.set(midi, { start: time, velocity });
        } else {
          const on = sounding.get(midi);
          if (on) {
            sounding.delete(midi);
            if (time > on.start) notes.push({ start: on.start, duration: time - on.start, midi, velocity: on.velocity });
          }
        }
      } else if (type === 0xc0 || type === 0xd0) {
        r.u8();                                // one data byte
      } else if (type >= 0x80 && type <= 0xe0) {
        r.p += 2;                              // two data bytes
      } else {
        r.p = end;                             // lost the thread — abandon this track
      }
    }
    r.p = end;
  }

  if (!notes.length) throw new Error("That MIDI file has no notes in it.");
  notes.sort((a, b) => a.start - b.start || b.midi - a.midi);
  return { ticksPerQuarter, tempoBpm, timeSignature, notes, trackCount };
}

// ---------------------------------------------------------------------------
// Timing -> written note values
// ---------------------------------------------------------------------------

const DURATION_VALUES = DURATIONS.map((d) => d.value).sort((a, b) => b - a);
const SHORTEST = DURATION_VALUES[DURATION_VALUES.length - 1];

/** The written note value nearest to a length in whole-notes.  Nearest in
 *  *ratio*, not in difference: an eighth and a sixteenth are as far apart to
 *  the ear as a whole and a half, and a linear nearest would round almost
 *  everything short of a quarter down to a sixteenth. */
function snapDuration(whole) {
  if (!(whole > 0)) return SHORTEST;
  let best = DURATION_VALUES[0];
  let bestRatio = Infinity;
  for (const v of DURATION_VALUES) {
    const ratio = whole > v ? whole / v : v / whole;
    if (ratio < bestRatio) { bestRatio = ratio; best = v; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------

/**
 * Turn a parsed MIDI file into bars for a score document.
 *
 * @param {object} parsed        from `parseMidi`
 * @param {object} opts
 * @param {string} opts.system   "relative" | "absolute" — what a blank bar needs
 * @param {Array}  opts.keySignature  the score's key signature, for spelling
 * @param {object} [opts.template]    a bar to inherit clef/rhythm/key from
 * @returns {{bars, report}}  `report` is what to tell the teacher
 */
export function midiToBars(parsed, { system, keySignature, template = null }) {
  const { ticksPerQuarter, timeSignature, notes } = parsed;
  const ticksPerWhole = ticksPerQuarter * 4;
  const ticksPerBar = Math.max(1, Math.round(ticksPerWhole * (timeSignature.numerator / timeSignature.denominator)));

  // --- reduce to one line: the top note of anything sounding together ------
  // "Together" has to allow for a little slop, because a chord played on a
  // keyboard is not three notes at the same tick — it is three notes within a
  // few milliseconds of each other.
  const together = Math.max(1, Math.round(ticksPerQuarter / 16));
  const line = [];
  let chords = 0;
  notes.forEach((n) => {
    const last = line[line.length - 1];
    if (last && n.start - last.start <= together) {
      chords += 1;
      if (n.midi > last.midi) { last.midi = n.midi; last.velocity = n.velocity; }
      last.duration = Math.max(last.duration, n.duration);
      return;
    }
    line.push({ start: n.start, duration: n.duration, midi: n.midi, velocity: n.velocity });
  });

  // --- notes and the gaps between them into bars ---------------------------
  const bars = [];
  let previousBar = template;
  const barFor = (index) => {
    while (bars.length <= index) {
      const bar = blankBar(system, previousBar);
      bars.push(bar);
      previousBar = bar;
    }
    return bars[index];
  };

  const firstStart = line.length ? line[0].start : 0;
  // An anacrusis — a melody starting mid-bar — would otherwise push everything
  // into the wrong bar, so the whole line is shifted to start at a barline.
  const origin = Math.floor(firstStart / ticksPerBar) * ticksPerBar;

  let previousEvent = null;
  let cursor = firstStart;
  let rests = 0;
  let skipped = 0;
  let clipped = 0;

  line.forEach((n) => {
    // The gap since the last note ended is a rest, when it is long enough to
    // be worth writing.  Shorter than the shortest note value it is
    // articulation — the space around a detached note — and writing it would
    // turn every staccato phrase into an unreadable rest-note-rest-note.
    const gap = n.start - cursor;
    if (gap > 0 && gap / ticksPerWhole >= SHORTEST) {
      const bar = barFor(Math.floor((cursor - origin) / ticksPerBar));
      const rest = blankEvent(previousEvent, {
        is_rest: true, note_name: "", duration: snapDuration(gap / ticksPerWhole),
      });
      bar.events.push(rest);
      previousEvent = rest;
      rests += 1;
    }

    const token = midiToToken(n.midi, keySignature);
    if (!token) { skipped += 1; cursor = n.start + n.duration; return; }
    // A note may not outlast its own bar: the score has no ties, so a note
    // written across a barline would sound for a length its notation does not
    // show.  Clip it and say how often that happened.
    const room = ticksPerBar - ((n.start - origin) % ticksPerBar);
    const sounding = Math.min(n.duration, room);
    if (sounding < n.duration) clipped += 1;

    const bar = barFor(Math.floor((n.start - origin) / ticksPerBar));
    const event = blankEvent(previousEvent, {
      note_name: token.name,
      is_rest: false,
      duration: snapDuration(sounding / ticksPerWhole),
      // The score's volume is on MIDI's own 0-127 scale, so velocity carries
      // across unchanged — no rescaling, and nothing to round away.
      volume: Math.max(0, Math.min(127, n.velocity)),
    });
    bar.events.push(event);
    previousEvent = event;
    cursor = n.start + n.duration;
  });

  // A trailing empty bar is an artefact of where the last note ended, not a
  // bar of music, and the editor would show it as an empty stave.
  while (bars.length > 1 && !bars[bars.length - 1].events.length) bars.pop();
  if (!bars.length) bars.push(blankBar(system, template));

  const report = {
    bars: bars.length,
    notes: bars.reduce((n, b) => n + b.events.filter((e) => !e.is_rest).length, 0),
    rests,
    chords,
    skipped,
    clipped,
    tempoBpm: parsed.tempoBpm,
    timeSignature,
    tracks: parsed.trackCount,
  };
  return { bars, report };
}

/** The report as one sentence a teacher can act on. */
export function describeImport(report) {
  const bits = [
    `${report.notes} note${report.notes === 1 ? "" : "s"} in ${report.bars} bar${report.bars === 1 ? "" : "s"}`,
    `${report.timeSignature.numerator}/${report.timeSignature.denominator}`,
  ];
  if (report.tempoBpm) bits.push(`${report.tempoBpm} bpm`);
  if (report.rests) bits.push(`${report.rests} rest${report.rests === 1 ? "" : "s"}`);
  if (report.chords) bits.push(`${report.chords} chord note${report.chords === 1 ? "" : "s"} reduced to the top line`);
  if (report.clipped) bits.push(`${report.clipped} note${report.clipped === 1 ? "" : "s"} clipped at a barline`);
  if (report.skipped) bits.push(`${report.skipped} note${report.skipped === 1 ? "" : "s"} out of range and dropped`);
  return bits.join(" · ");
}

export { LETTERS, midiToToken };
