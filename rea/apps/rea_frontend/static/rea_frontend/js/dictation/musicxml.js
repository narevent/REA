/**
 * musicxml.js — scores in and out of MusicXML.
 *
 * MusicXML is how notation programs exchange scores: a teacher with a piece
 * already written in MuseScore, Sibelius or Finale exports it and imports it
 * here, and a dictation written here can be taken back the other way.  Both
 * the plain format (.musicxml, .xml) and the compressed one (.mxl, a zip) are
 * read; the plain one is written.
 *
 * What travels: parts and their staves, clefs, keys, time signatures and
 * tempo; notes, chords, rests, dots and tuplets in up to four voices per
 * staff; ties, slurs, articulations, fermatas, dynamics and hairpins; repeat
 * barlines, endings, final and double barlines, segno, coda, Fine and the
 * D.C./D.S. jumps.  What does not (lyrics, grace notes, ornaments, layout) is
 * left out rather than guessed at.
 *
 * The XML is read by a small parser of its own rather than the browser's, so
 * the same code runs in node and is tested there (`tests/dictation/musicxml.mjs`).
 */

import * as S from "./score.js?v=180";

// ---------------------------------------------------------------------------
// A small XML reader — enough for MusicXML, no more.
// ---------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] != null ? ENTITIES[e] : m;
  });
}

/** Parse XML into `{name, attrs, children, text}` nodes; returns the root. */
export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) {
      const text = xml.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].text += decode(text);
    }
    if (xml.startsWith("<!--", lt)) { i = xml.indexOf("-->", lt) + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) { i = xml.indexOf("?>", lt) + 2; continue; }
    if (xml.startsWith("<!", lt)) {
      // A DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let j = lt;
      for (; j < len; j += 1) {
        if (xml[j] === "[") depth += 1;
        else if (xml[j] === "]") depth -= 1;
        else if (xml[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    const tag = xml.slice(lt + 1, gt);
    if (tag[0] === "/") {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameEnd = body.search(/\s|$/);
    const node = { name: body.slice(0, nameEnd), attrs: {}, children: [], text: "" };
    body.slice(nameEnd).replace(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (m, k, v, a, b) => {
      node.attrs[k] = decode(a != null ? a : b);
      return m;
    });
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root.children[0] || root;
}

const child = (node, name) => (node && node.children.find((c) => c.name === name)) || null;
const children = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const text = (node, name, fallback = "") => {
  const c = child(node, name);
  return c ? c.text.trim() : fallback;
};
const num = (node, name, fallback = 0) => {
  const t = text(node, name, "");
  return t === "" ? fallback : Number(t);
};

// ---------------------------------------------------------------------------
// .mxl — a zip with the score inside
// ---------------------------------------------------------------------------

/**
 * The MusicXML text inside an .mxl file.  The container names its root file
 * in META-INF/container.xml; failing that, the first .xml/.musicxml outside
 * META-INF is the score.  Deflate is undone with the browser's own
 * DecompressionStream.
 */
export async function unzipMxl(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This is not a compressed MusicXML (.mxl) file.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressed, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const read = async (entry) => {
    const nameLength = view.getUint16(entry.local + 26, true);
    const extraLength = view.getUint16(entry.local + 28, true);
    const start = entry.local + 30 + nameLength + extraLength;
    const data = bytes.slice(start, start + entry.compressed);
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8 || typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot open compressed MusicXML; export it uncompressed (.musicxml) instead.");
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  };
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  let target = null;
  if (container) {
    const root = parseXml(await read(container));
    const rootfile = findDeep(root, "rootfile");
    if (rootfile && rootfile.attrs["full-path"]) target = entries.find((e) => e.name === rootfile.attrs["full-path"]);
  }
  if (!target) target = entries.find((e) => !e.name.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(e.name));
  if (!target) throw new Error("No score was found inside this .mxl file.");
  return read(target);
}

function findDeep(node, name) {
  if (!node) return null;
  if (node.name === name) return node;
  for (const c of node.children) {
    const found = findDeep(c, name);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const TYPE_TO_DUR = {
  whole: "w", half: "h", quarter: "q", eighth: "8", "16th": "16", "32nd": "32", "64th": "64",
  breve: "w", "128th": "64",
};
const DYNAMIC_NAMES = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "sfz", "fp"]);

function clefFrom(clef) {
  const sign = text(clef, "sign", "G");
  const octave = num(clef, "clef-octave-change", 0);
  const line = num(clef, "line", sign === "G" ? 2 : sign === "F" ? 4 : 3);
  if (sign === "F") return "bass";
  if (sign === "C") return line === 4 ? "tenor" : "alto";
  return octave === -1 ? "treble8vb" : "treble";
}

const NAV_WORDS = [
  [/d\.?\s*s\.?\s*al\s*fine/i, "dsalfine"], [/d\.?\s*s\.?\s*al\s*coda/i, "dsalcoda"],
  [/d\.?\s*c\.?\s*al\s*fine/i, "dcalfine"], [/d\.?\s*c\.?\s*al\s*coda/i, "dcalcoda"],
  [/^\s*d\.?\s*s\.?\s*$/i, "ds"], [/^\s*d\.?\s*c\.?\s*$/i, "dc"], [/da\s*capo/i, "dc"],
  [/^\s*fine\s*$/i, "fine"], [/to\s*coda/i, "tocoda"],
];

/**
 * A MusicXML document as a dictation: `{title, composer, score}`.
 * Throws with a reason a teacher can act on when the file is not a score.
 */
export function readMusicXml(xml) {
  const root = parseXml(xml);
  if (root.name === "score-timewise") throw new Error("This is a timewise MusicXML file; export it partwise (the usual kind) instead.");
  if (root.name !== "score-partwise") throw new Error("This file is not a MusicXML score.");
  const title = text(child(root, "work"), "work-title") || text(root, "movement-title") || "";
  const creators = children(child(root, "identification"), "creator");
  const composerNode = creators.find((c) => c.attrs.type === "composer") || creators[0];
  const composer = composerNode ? composerNode.text.trim() : "";

  const partList = child(root, "part-list");
  const names = new Map(children(partList, "score-part").map((sp) => [sp.attrs.id, text(sp, "part-name") || "Part"]));
  const xmlParts = children(root, "part");
  const measureCount = Math.max(1, ...xmlParts.map((p) => children(p, "measure").length));

  const score = { version: 1, tempo: 80, parts: [], measures: [] };
  for (let mi = 0; mi < measureCount; mi += 1) score.measures.push({ staves: {} });

  xmlParts.forEach((xp, partIndex) => {
    const measures = children(xp, "measure");
    let divisions = 1;
    let staffCount = 1;
    const clefs = ["treble"];
    // Staves are known once the first <attributes> is read; the part is made then.
    let part = null;
    const voiceMaps = new Map();   // staff -> Map(xmlVoice -> index 0-3)
    let pendingDyn = new Map();    // staff -> dynamic waiting for its next note
    let pendingWedge = new Map();  // staff -> "<" | ">" waiting for its next note
    let wedgeStopping = new Map(); // staff -> true: the next note ends a hairpin
    const openTuplets = new Map(); // "staff:voice" -> current tuplet group
    const lastNoteOf = new Map();  // "staff:voice" -> last event (for chords)

    measures.forEach((xm, mi) => {
      const measure = score.measures[mi];
      const perVoice = new Map();  // "staff:voice" -> [{start, event}]
      let time = 0;
      let lastStart = 0;
      const ticks = (d) => Math.round((d * S.PPQ) / divisions);

      xm.children.forEach((node) => {
        if (node.name === "attributes") {
          if (child(node, "divisions")) divisions = num(node, "divisions", 1) || 1;
          if (child(node, "staves")) staffCount = Math.max(1, Math.min(2, num(node, "staves", 1)));
          const key = child(node, "key");
          if (key && child(key, "fifths") && partIndex === 0) measure.key = num(key, "fifths", 0);
          const t = child(node, "time");
          if (t && child(t, "beats") && partIndex === 0) {
            measure.time = [parseInt(text(t, "beats"), 10) || 4, num(t, "beat-type", 4)];
          }
          children(node, "clef").forEach((c) => {
            const index = Math.max(0, Number(c.attrs.number || 1) - 1);
            const clef = clefFrom(c);
            if (!part || mi === 0) clefs[index] = clef;
            else {
              const staffKey = `${part.id}:${index}`;
              measure.staves[staffKey] = measure.staves[staffKey] || { voices: [[], [], [], []] };
              measure.staves[staffKey].clef = clef;
            }
          });
          if (!part) {
            part = {
              id: S.newId("p"), name: names.get(xp.attrs.id) || `Part ${partIndex + 1}`,
              instrument: "imported",
              staves: Array.from({ length: staffCount }, (_, i) => ({ clef: clefs[i] || (i === 1 ? "bass" : "treble") })),
            };
            score.parts.push(part);
          }
          return;
        }
        if (node.name === "backup") { time -= num(node, "duration", 0); return; }
        if (node.name === "forward") { time += num(node, "duration", 0); return; }
        if (node.name === "direction") {
          const staff = Math.max(0, Number(text(node, "staff", "1")) - 1);
          children(node, "direction-type").forEach((dt) => {
            const dyn = child(dt, "dynamics");
            if (dyn && dyn.children[0] && DYNAMIC_NAMES.has(dyn.children[0].name)) pendingDyn.set(staff, dyn.children[0].name);
            const wedge = child(dt, "wedge");
            if (wedge) {
              if (wedge.attrs.type === "crescendo") pendingWedge.set(staff, "<");
              else if (wedge.attrs.type === "diminuendo") pendingWedge.set(staff, ">");
              else if (wedge.attrs.type === "stop") wedgeStopping.set(staff, true);
            }
            const metronome = child(dt, "metronome");
            if (metronome && child(metronome, "per-minute") && partIndex === 0) {
              const bpm = Math.round(num(metronome, "per-minute", 80));
              if (mi === 0) score.tempo = bpm; else measure.tempo = bpm;
            }
            if (child(dt, "segno") && partIndex === 0) measure.nav = "segno";
            if (child(dt, "coda") && partIndex === 0) measure.nav = measure.nav || "coda";
            const words = child(dt, "words");
            if (words && partIndex === 0) {
              const hit = NAV_WORDS.find(([re]) => re.test(words.text));
              if (hit) measure.nav = hit[1];
            }
          });
          const sound = child(node, "sound");
          if (sound && sound.attrs.tempo && partIndex === 0 && !child(node, "direction-type")) {
            const bpm = Math.round(Number(sound.attrs.tempo));
            if (mi === 0) score.tempo = bpm; else measure.tempo = bpm;
          }
          return;
        }
        if (node.name === "barline" && partIndex === 0) {
          const repeat = child(node, "repeat");
          if (repeat && repeat.attrs.direction === "forward") measure.repeatStart = true;
          if (repeat && repeat.attrs.direction === "backward") {
            measure.repeatEnd = true;
            if (repeat.attrs.times) measure.repeatTimes = Number(repeat.attrs.times);
          }
          const style = text(node, "bar-style");
          if (style === "light-heavy" && !repeat) measure.barline = "final";
          if (style === "light-light") measure.barline = "double";
          const ending = child(node, "ending");
          if (ending && ending.attrs.number && (ending.attrs.type === "start" || node.attrs.location !== "right")) {
            measure.volta = ending.attrs.number.split(/[,\s]+/).map(Number).filter(Boolean);
          }
          return;
        }
        if (node.name !== "note") return;
        if (child(node, "grace") || child(node, "cue")) return;
        // A part that never said how many staves it has is one staff.
        if (!part) {
          part = { id: S.newId("p"), name: names.get(xp.attrs.id) || `Part ${partIndex + 1}`, instrument: "imported", staves: [{ clef: "treble" }] };
          score.parts.push(part);
        }
        const staff = Math.max(0, Math.min(part.staves.length - 1, Number(text(node, "staff", "1")) - 1));
        if (!voiceMaps.has(staff)) voiceMaps.set(staff, new Map());
        const vmap = voiceMaps.get(staff);
        const xmlVoice = text(node, "voice", "1");
        if (!vmap.has(xmlVoice)) vmap.set(xmlVoice, Math.min(3, vmap.size));
        const voice = vmap.get(xmlVoice);
        const voiceKey = `${staff}:${voice}`;
        const isChord = !!child(node, "chord");
        const duration = num(node, "duration", 0);
        const pitchNode = child(node, "pitch");
        const pitch = pitchNode ? {
          step: text(pitchNode, "step", "C").toUpperCase(),
          alter: Math.round(num(pitchNode, "alter", 0)),
          octave: num(pitchNode, "octave", 4),
          tie: children(node, "tie").some((t) => t.attrs.type === "start"),
        } : null;

        if (isChord && lastNoteOf.has(voiceKey) && pitch) {
          const previous = lastNoteOf.get(voiceKey);
          if (!previous.rest) previous.pitches.push(pitch);
          return;
        }
        const start = isChord ? lastStart : time;
        lastStart = start;
        const dur = TYPE_TO_DUR[text(node, "type", "")] || (S.durationFor(ticks(duration)) || { dur: "q" }).dur;
        const event = pitch ? S.noteEvent([pitch], dur, children(node, "dot").length) : S.restEvent(dur, children(node, "dot").length);
        if (!pitch && child(node, "rest") && child(child(node, "rest"), "display-step") === null && child(node, "rest").attrs.measure === "yes") {
          // A whole-measure rest is written as long as the measure.
          const capacity = S.measureTicks(score, mi);
          const whole = S.durationFor(capacity);
          if (whole) Object.assign(event, whole);
        }
        const modification = child(node, "time-modification");
        const notations = child(node, "notations");
        if (modification) {
          const actual = num(modification, "actual-notes", 3);
          const normal = num(modification, "normal-notes", 2);
          let group = openTuplets.get(voiceKey);
          const startsGroup = notations && children(notations, "tuplet").some((t) => t.attrs.type === "start");
          if (!group || startsGroup || group.num !== actual || group.den !== normal || group.count >= actual) {
            group = { id: S.newId("t"), num: actual, den: normal, count: 0 };
            openTuplets.set(voiceKey, group);
          }
          group.count += 1;
          event.tuplet = { id: group.id, num: actual, den: normal };
          if (notations && children(notations, "tuplet").some((t) => t.attrs.type === "stop")) openTuplets.delete(voiceKey);
        } else {
          openTuplets.delete(voiceKey);
        }
        if (notations) {
          children(notations, "tied").forEach((t) => { if (t.attrs.type === "start" && event.pitches[0]) event.pitches[0].tie = true; });
          children(notations, "slur").forEach((s) => {
            if (s.attrs.type === "start") event.slur = true;
            if (s.attrs.type === "stop") event.slurEnd = true;
          });
          const arts = child(notations, "articulations");
          if (arts) {
            if (child(arts, "staccato") || child(arts, "staccatissimo")) event.art.push("staccato");
            if (child(arts, "accent")) event.art.push("accent");
            if (child(arts, "tenuto")) event.art.push("tenuto");
            if (child(arts, "strong-accent")) event.art.push("marcato");
          }
          if (child(notations, "fermata")) event.art.push("fermata");
          const dyn = child(notations, "dynamics");
          if (dyn && dyn.children[0] && DYNAMIC_NAMES.has(dyn.children[0].name)) event.dyn = dyn.children[0].name;
        }
        if (pitch) {
          if (pendingDyn.has(staff)) { event.dyn = event.dyn || pendingDyn.get(staff); pendingDyn.delete(staff); }
          if (pendingWedge.has(staff)) { event.hairpin = pendingWedge.get(staff); pendingWedge.delete(staff); }
          else if (wedgeStopping.get(staff)) { event.hairpinEnd = true; wedgeStopping.delete(staff); }
        }
        if (!perVoice.has(voiceKey)) perVoice.set(voiceKey, []);
        perVoice.get(voiceKey).push({ start: ticks(start), event });
        lastNoteOf.set(voiceKey, event);
        time = start + duration;
      });

      // Lay each voice out in time, with rests in whatever gaps it leaves.
      perVoice.forEach((items, voiceKey) => {
        const [staff, voice] = voiceKey.split(":").map(Number);
        const staffKey = `${part.id}:${staff}`;
        measure.staves[staffKey] = measure.staves[staffKey] || { voices: [[], [], [], []] };
        const events = [];
        let tick = 0;
        items.sort((a, b) => a.start - b.start).forEach(({ start, event }) => {
          if (start > tick) events.push(...S.restsFor(start - tick, tick));
          if (start < tick) return;   // overlapping: a voice cannot hold two things at once
          events.push(event);
          tick = start + S.eventTicks(event);
        });
        measure.staves[staffKey].voices[voice] = events;
      });
      void pendingDyn;
    });
    pendingDyn = new Map();
    pendingWedge = new Map();
    wedgeStopping = new Map();
  });
  if (!score.parts.length) throw new Error("This score has no parts.");
  S.normalise(score);
  return { title, composer, score };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const DUR_TO_TYPE = { w: "whole", h: "half", q: "quarter", 8: "eighth", 16: "16th", 32: "32nd", 64: "64th" };
const CLEF_XML = {
  treble: ["G", 2, 0], bass: ["F", 4, 0], alto: ["C", 3, 0], tenor: ["C", 4, 0], treble8vb: ["G", 2, -1],
};
const NAV_XML = {
  dc: ["D.C.", 'dacapo="yes"'], dcalfine: ["D.C. al Fine", 'dacapo="yes"'], dcalcoda: ["D.C. al Coda", 'dacapo="yes"'],
  ds: ["D.S.", 'dalsegno="segno"'], dsalfine: ["D.S. al Fine", 'dalsegno="segno"'], dsalcoda: ["D.S. al Coda", 'dalsegno="segno"'],
  fine: ["Fine", 'fine="yes"'], tocoda: ["To Coda", 'tocoda="coda"'],
};

function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A dictation as MusicXML 3.1 (partwise), for MuseScore and friends. */
export function writeMusicXml({ title = "", composer = "", score }) {
  const out = [];
  const w = (line) => out.push(line);
  w('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  w('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  w('<score-partwise version="3.1">');
  if (title) w(`  <work><work-title>${esc(title)}</work-title></work>`);
  w("  <identification>");
  if (composer) w(`    <creator type="composer">${esc(composer)}</creator>`);
  w("    <encoding><software>REA dictation editor</software></encoding>");
  w("  </identification>");
  w("  <part-list>");
  score.parts.forEach((part, i) => {
    w(`    <score-part id="P${i + 1}"><part-name>${esc(part.name)}</part-name></score-part>`);
  });
  w("  </part-list>");
  const accidentalSign = { "-2": "flat-flat", "-1": "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };

  score.parts.forEach((part, pi) => {
    w(`  <part id="P${pi + 1}">`);
    score.measures.forEach((measure, mi) => {
      w(`    <measure number="${mi + 1}">`);
      const capacity = S.measureTicks(score, mi);
      if (measure.repeatStart || (measure.volta && !(score.measures[mi - 1] && score.measures[mi - 1].volta && score.measures[mi - 1].volta.join() === measure.volta.join()))) {
        w('      <barline location="left">');
        if (measure.repeatStart) w('        <bar-style>heavy-light</bar-style><repeat direction="forward"/>');
        if (measure.volta) w(`        <ending number="${measure.volta.join(", ")}" type="start">${measure.volta.join(", ")}.</ending>`);
        w("      </barline>");
      }
      // Attributes: the first measure says everything, later ones what changed.
      const attrs = [];
      if (mi === 0) attrs.push(`<divisions>${S.PPQ}</divisions>`);
      if (mi === 0 || measure.key != null) attrs.push(`<key><fifths>${S.keyAt(score, mi)}</fifths></key>`);
      if (mi === 0 || measure.time) {
        const [n, d] = S.timeAt(score, mi);
        attrs.push(`<time><beats>${n}</beats><beat-type>${d}</beat-type></time>`);
      }
      if (mi === 0 && part.staves.length > 1) attrs.push(`<staves>${part.staves.length}</staves>`);
      part.staves.forEach((st, si) => {
        const staffKey = `${part.id}:${si}`;
        const changed = mi > 0 && measure.staves[staffKey] && measure.staves[staffKey].clef;
        if (mi === 0 || changed) {
          const [sign, line, octave] = CLEF_XML[S.clefAt(score, staffKey, mi)] || CLEF_XML.treble;
          attrs.push(`<clef${part.staves.length > 1 ? ` number="${si + 1}"` : ""}><sign>${sign}</sign><line>${line}</line>${octave ? `<clef-octave-change>${octave}</clef-octave-change>` : ""}</clef>`);
        }
      });
      if (attrs.length) w(`      <attributes>${attrs.join("")}</attributes>`);
      if (pi === 0 && (mi === 0 || measure.tempo)) {
        const bpm = mi === 0 ? (measure.tempo || score.tempo || 80) : measure.tempo;
        w(`      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`);
      }
      if (pi === 0 && measure.nav === "segno") w('      <direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>');
      if (pi === 0 && measure.nav === "coda") w('      <direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>');

      let first = true;
      part.staves.forEach((st, si) => {
        const staffKey = `${part.id}:${si}`;
        const staff = measure.staves[staffKey];
        if (!staff) return;
        staff.voices.forEach((events, vi) => {
          if (!events.length) return;
          if (!first) w(`      <backup><duration>${capacity}</duration></backup>`);
          first = false;
          const voiceNumber = si * 4 + vi + 1;
          events.forEach((event) => {
            const ticks = S.eventTicks(event);
            if (event.dyn) {
              w(`      <direction placement="below"><direction-type><dynamics><${event.dyn}/></dynamics></direction-type><voice>${voiceNumber}</voice>${part.staves.length > 1 ? `<staff>${si + 1}</staff>` : ""}</direction>`);
            }
            if (event.hairpin) {
              w(`      <direction placement="below"><direction-type><wedge type="${event.hairpin === ">" ? "diminuendo" : "crescendo"}"/></direction-type>${part.staves.length > 1 ? `<staff>${si + 1}</staff>` : ""}</direction>`);
            }
            const pitches = event.rest ? [null] : event.pitches;
            pitches.forEach((p, k) => {
              const parts = ["<note>"];
              if (k > 0) parts.push("<chord/>");
              if (!p) parts.push(event.dur === "w" && ticks === capacity ? '<rest measure="yes"/>' : "<rest/>");
              else parts.push(`<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>`);
              parts.push(`<duration>${ticks}</duration>`);
              if (p && p.tie) parts.push('<tie type="start"/>');
              parts.push(`<voice>${voiceNumber}</voice>`);
              parts.push(`<type>${DUR_TO_TYPE[event.dur] || "quarter"}</type>`);
              for (let d = 0; d < (event.dots || 0); d += 1) parts.push("<dot/>");
              if (p && p.alter) parts.push(`<accidental>${accidentalSign[String(p.alter)] || "natural"}</accidental>`);
              if (event.tuplet) parts.push(`<time-modification><actual-notes>${event.tuplet.num}</actual-notes><normal-notes>${event.tuplet.den}</normal-notes></time-modification>`);
              if (part.staves.length > 1) parts.push(`<staff>${si + 1}</staff>`);
              const notations = [];
              if (p && p.tie) notations.push('<tied type="start"/>');
              if (k === 0) {
                if (event.slur) notations.push('<slur type="start" number="1"/>');
                if (event.slurEnd) notations.push('<slur type="stop" number="1"/>');
                const arts = (event.art || []).filter((a) => a !== "fermata").map((a) => ({
                  staccato: "<staccato/>", accent: "<accent/>", tenuto: "<tenuto/>", marcato: "<strong-accent/>",
                }[a])).filter(Boolean);
                if (arts.length) notations.push(`<articulations>${arts.join("")}</articulations>`);
                if ((event.art || []).includes("fermata")) notations.push("<fermata/>");
              }
              if (notations.length) parts.push(`<notations>${notations.join("")}</notations>`);
              parts.push("</note>");
              w(`      ${parts.join("")}`);
            });
            if (event.hairpinEnd) w(`      <direction><direction-type><wedge type="stop"/></direction-type>${part.staves.length > 1 ? `<staff>${si + 1}</staff>` : ""}</direction>`);
          });
        });
      });
      if (pi === 0 && measure.nav && NAV_XML[measure.nav]) {
        const [words, sound] = NAV_XML[measure.nav];
        w(`      <direction placement="above"><direction-type><words>${words}</words></direction-type><sound ${sound}/></direction>`);
      }
      const endsVolta = measure.volta && !(score.measures[mi + 1] && score.measures[mi + 1].volta && score.measures[mi + 1].volta.join() === measure.volta.join());
      if (measure.repeatEnd || measure.barline || endsVolta || mi === score.measures.length - 1) {
        w('      <barline location="right">');
        const style = measure.repeatEnd || measure.barline === "final" || mi === score.measures.length - 1 ? "light-heavy" : measure.barline === "double" ? "light-light" : "regular";
        w(`        <bar-style>${style}</bar-style>`);
        if (endsVolta) w(`        <ending number="${measure.volta.join(", ")}" type="${measure.repeatEnd ? "stop" : "discontinue"}"/>`);
        if (measure.repeatEnd) w(`        <repeat direction="backward"${measure.repeatTimes && measure.repeatTimes !== 2 ? ` times="${measure.repeatTimes}"` : ""}/>`);
        w("      </barline>");
      }
      w("    </measure>");
    });
    w("  </part>");
  });
  w("</score-partwise>");
  return out.join("\n") + "\n";
}
