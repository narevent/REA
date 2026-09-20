/**
 * glyphs.js
 *
 * The little pictures the editor's controls are labelled with.
 *
 * A note value is a shape before it is a number.  The palette used to offer
 * "1/1 1/2 1/4 1/8 1/16 1/32", which is the arithmetic of a note value and not
 * the thing a musician recognises — a teacher scanning that row is reading six
 * fractions and translating each one, every time.  The same row drawn as
 * noteheads is read at a glance, and it matches what the button is about to
 * put on the stave.
 *
 * They are drawn here rather than taken from the music font because these are
 * *control* labels: they have to sit in a small button, line up with their
 * neighbours, and take the button's own colour when it lights up.  A handful
 * of lines and an ellipse does all three, and needs no font to have loaded
 * before the toolbar can be drawn.
 *
 * What the drawing has to get right is *which part carries the meaning*.  For
 * a note value that is the flags: an eighth and a sixteenth have the same head
 * and the same stem and differ only in the number of hooks at the top, so the
 * hooks are what the eye must land on.  The first version of these glyphs had
 * it backwards — a big head with a thin stem and three tiny flags crowded
 * against each other — and the four shortest values were very nearly the same
 * picture.  The head is small here and the flags are large and clearly
 * separated, which is also how they are engraved.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** How many flags a note value carries, and whether its head is filled. */
const NOTE_SHAPE = {
  1: { flags: 0, stem: false, filled: false },
  0.5: { flags: 0, stem: true, filled: false },
  0.25: { flags: 0, stem: true, filled: true },
  0.125: { flags: 1, stem: true, filled: true },
  0.0625: { flags: 2, stem: true, filled: true },
  0.03125: { flags: 3, stem: true, filled: true },
};

/* The note glyph's geometry, in its own 18×30 box.  Named because the stem
   has to start at the head's right edge and the flags at the stem's top, and
   three numbers repeated in five places is how those quietly drift apart. */
const HEAD_X = 5.8;      // centre of the notehead
const HEAD_Y = 24.2;     // its baseline — the same for every value, so a row
                         // of them sits on one line however tall each is
const HEAD_RX = 3.5;
const HEAD_RY = 2.6;
const STEM_X = 9.0;      // the head's right edge
const STEM_TOP = 2.8;
const FLAG_STEP = 5.0;   // one flag below the last

function node(name, attrs) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function svgRoot(className, viewBox, width, height) {
  return node("svg", {
    class: className, viewBox, width, height,
    "aria-hidden": "true", focusable: "false",
  });
}

/**
 * An `<svg>` of the note of this duration, in the current text colour.
 *
 * Falls back to nothing for a duration the editor cannot draw, so a caller
 * can always ask and only has to decide what to do when the answer is null.
 */
export function durationGlyph(duration) {
  const shape = NOTE_SHAPE[duration];
  if (!shape) return null;

  const svg = svgRoot("ed-glyph ed-glyph-note", "0 0 18 30", 18, 30);

  // A whole note is a wider, rounder head — it is the one value with no stem
  // to tell it apart, so the head has to do it on its own.
  const whole = !shape.stem;
  svg.appendChild(node("ellipse", {
    cx: HEAD_X, cy: HEAD_Y,
    rx: whole ? HEAD_RX + 0.7 : HEAD_RX,
    ry: whole ? HEAD_RY + 0.1 : HEAD_RY,
    transform: `rotate(${whole ? -10 : -20} ${HEAD_X} ${HEAD_Y})`,
    fill: shape.filled ? "currentColor" : "none",
    stroke: "currentColor", "stroke-width": 1.5,
  }));

  if (shape.stem) {
    svg.appendChild(node("line", {
      x1: STEM_X, y1: HEAD_Y - 1.0, x2: STEM_X, y2: STEM_TOP,
      stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round",
    }));
    // Flags hang off the top of the stem, one below the next.  Big enough to
    // count at a glance, which is the entire job of this end of the glyph.
    for (let i = 0; i < shape.flags; i += 1) {
      const y = STEM_TOP + i * FLAG_STEP;
      svg.appendChild(node("path", {
        d: `M${STEM_X} ${y} c5.0 1.7 6.7 4.6 5.7 8.5 c-0.5 -3.4 -2.7 -5.4 -5.7 -6.1 z`,
        fill: "currentColor",
      }));
    }
  }
  return svg;
}

/**
 * An `<svg>` of one notehead shape, in the current text colour.
 *
 * The same six the stave can draw (see `NOTEHEAD_CODES` in `staveLayout.js`).
 * They were a dropdown, which is the wrong control for six pictures: a
 * teacher choosing a shape is choosing what the note will *look* like, and
 * reading the word "diamond" to find out is a translation the row of shapes
 * does not ask for.
 */
export function noteheadGlyph(shape) {
  const svg = svgRoot("ed-glyph ed-glyph-head", "0 0 18 18", 18, 18);
  const stroke = { stroke: "currentColor", "stroke-width": 1.6, "stroke-linejoin": "round" };

  if (shape === "cross") {
    svg.appendChild(node("path", {
      d: "M4.4 4.4 L13.6 13.6 M13.6 4.4 L4.4 13.6",
      fill: "none", "stroke-linecap": "round", ...stroke, "stroke-width": 2,
    }));
  } else if (shape === "diamond") {
    svg.appendChild(node("path", {
      d: "M9 3.6 L14.2 9 L9 14.4 L3.8 9 Z", fill: "currentColor", ...stroke,
    }));
  } else if (shape === "triangle") {
    svg.appendChild(node("path", {
      d: "M9 3.8 L14.4 14.2 L3.6 14.2 Z", fill: "currentColor", ...stroke,
    }));
  } else if (shape === "square") {
    svg.appendChild(node("rect", {
      x: 4.2, y: 4.2, width: 9.6, height: 9.6, rx: 0.8,
      fill: "currentColor", ...stroke,
    }));
  } else if (shape === "slash") {
    svg.appendChild(node("path", {
      d: "M4.0 13.4 L11.6 4.6 L14.0 4.6 L6.4 13.4 Z",
      fill: "currentColor", ...stroke,
    }));
  } else {
    // The ordinary oval, and the one the empty value means.
    svg.appendChild(node("ellipse", {
      cx: 9, cy: 9, rx: 5.2, ry: 3.8, transform: "rotate(-20 9 9)",
      fill: "currentColor", ...stroke,
    }));
  }
  return svg;
}

/**
 * An `<svg>` of one accidental, in the current text colour.
 *
 * These were the Unicode characters — ♯ ♭ ♮ and, for the doubles, 𝄪 and 𝄫 —
 * and the two doubles are the problem: no interface font carries them, so
 * they came from whatever fallback the system had, at a size and weight that
 * matched nothing beside them.  Making the row bigger made the three that
 * worked bigger and left the two that mattered most as specks.  Drawn here,
 * all six are one family and take the button's colour like every other glyph.
 */
export function accidentalGlyph(modifier) {
  const svg = svgRoot("ed-glyph ed-glyph-acc", "0 0 16 22", 16, 22);
  const stroke = (attrs) => node("line", Object.assign(
    { stroke: "currentColor", "stroke-linecap": "round" }, attrs,
  ));

  if (modifier === "#" || modifier === "bb" || modifier === "b"
      || modifier === "r" || modifier === "x") {
    if (modifier === "#") {
      // Two uprights, and two bars rising to the right — the bars are the
      // heavy strokes of a sharp and are what tells it from a natural.
      svg.appendChild(stroke({ x1: 6, y1: 4.5, x2: 6, y2: 18.5, "stroke-width": 1.5 }));
      svg.appendChild(stroke({ x1: 10.4, y1: 3.5, x2: 10.4, y2: 17.5, "stroke-width": 1.5 }));
      svg.appendChild(stroke({ x1: 3, y1: 11.6, x2: 13.4, y2: 9.4, "stroke-width": 2.5 }));
      svg.appendChild(stroke({ x1: 3, y1: 16.1, x2: 13.4, y2: 13.9, "stroke-width": 2.5 }));
    } else if (modifier === "r") {
      // A natural: one upright up, one down, joined by two bars.
      svg.appendChild(stroke({ x1: 5.8, y1: 3.5, x2: 5.8, y2: 15.5, "stroke-width": 1.5 }));
      svg.appendChild(stroke({ x1: 10.4, y1: 6.5, x2: 10.4, y2: 18.5, "stroke-width": 1.5 }));
      svg.appendChild(stroke({ x1: 5.4, y1: 10.2, x2: 10.8, y2: 8.4, "stroke-width": 2.4 }));
      svg.appendChild(stroke({ x1: 5.4, y1: 13.6, x2: 10.8, y2: 11.8, "stroke-width": 2.4 }));
    } else if (modifier === "x") {
      // A double sharp is a saltire, so it is drawn as one: a bold X.
      svg.appendChild(node("path", {
        d: "M4.2 6.2 L11.8 15.2 M11.8 6.2 L4.2 15.2",
        fill: "none", stroke: "currentColor", "stroke-width": 3,
        "stroke-linecap": "round",
      }));
    } else {
      // A flat, once or twice.  The bowl is filled, which is what makes it
      // read as a flat rather than as a lower-case b.
      const flat = (x) => {
        const group = node("g", { transform: `translate(${x} 0)` });
        group.appendChild(stroke({ x1: 4.4, y1: 3, x2: 4.4, y2: 18, "stroke-width": 1.5 }));
        group.appendChild(node("path", {
          d: "M4.4 10.8 q4.6 -2.2 4.6 2.2 q0 3.2 -4.6 5.2 z",
          fill: "currentColor",
        }));
        return group;
      };
      if (modifier === "bb") {
        svg.appendChild(flat(-0.6));
        svg.appendChild(flat(4.2));
      } else {
        svg.appendChild(flat(1.8));
      }
    }
  } else {
    // "As the key signature has it": no mark, so a dash rather than a sign.
    svg.appendChild(stroke({ x1: 3.6, y1: 11, x2: 12.4, y2: 11, "stroke-width": 2 }));
  }
  return svg;
}

/** Put *glyph* into *button*, keeping *text* as the accessible name.
 *
 * The word is not thrown away: it stays as the button's text for a screen
 * reader and as part of its tooltip, because "1/8" and "Diamond" are still
 * the exact answer to "which one is this" and the picture is only faster. */
function labelWith(button, glyph, text) {
  if (!glyph) return button;
  button.textContent = "";
  button.appendChild(glyph);
  const label = document.createElement("span");
  label.className = "ed-glyph-text";
  label.textContent = text;
  button.appendChild(label);
  return button;
}

export function labelWithDuration(button, duration, text) {
  return labelWith(button, durationGlyph(duration), text);
}

export function labelWithNotehead(button, shape, text) {
  return labelWith(button, noteheadGlyph(shape), text);
}

export function labelWithAccidental(button, modifier, text) {
  return labelWith(button, accidentalGlyph(modifier), text);
}
