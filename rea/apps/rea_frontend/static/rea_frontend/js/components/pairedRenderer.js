/**
 * pairedRenderer.js
 *
 * The score, with an instrument drawn under it.
 *
 * The keyboard and the guitar neck used to *replace* the stave, which made a
 * student choose between the picture they are learning to read and the one
 * they already think in.  Now the stave stays, and the instrument is drawn
 * below it showing the same bars.  The practice controller drives one
 * renderer, so this answers as the stave does and passes everything that
 * marks the music — the bar being played, the note sounding, a result, a
 * focus — on to the instrument as well, so the two pictures always agree.
 *
 * Questions about the score (how many bars, which notes are in one) are
 * answered by the stave alone: it is the score, the instrument is a view of
 * it.
 */

/** The calls that mark the music, and so are made on both pictures. */
const SHARED = new Set([
  "highlightBar", "highlightBarBox", "markBarResult", "clearBarResults",
  "markFocus", "clearBarHighlight", "clearBarBox", "highlightNote",
  "clearHighlight", "setNoteAccuracy", "clearNoteAccuracy", "showSungNote",
  "clearSungNote",
]);

/** Handlers the instrument needs too, so a click on it answers the same. */
const SHARED_HANDLERS = new Set(["onBarContext", "onBarClick"]);

/**
 * `primary` with `secondary` drawn alongside, or `primary` itself when there
 * is no second picture.
 */
export function pairRenderers(primary, secondary) {
  if (!primary || !secondary) return primary;
  return new Proxy(primary, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      if (SHARED.has(prop) && typeof secondary[prop] === "function") {
        return (...args) => {
          const result = value.apply(target, args);
          // The instrument is a second view; it never gets to break the first.
          try { secondary[prop](...args); } catch (e) { /* the stave stands */ }
          return result;
        };
      }
      return value.bind(target);
    },
    set(target, prop, value) {
      target[prop] = value;
      if (SHARED_HANDLERS.has(prop)) secondary[prop] = value;
      return true;
    },
  });
}
