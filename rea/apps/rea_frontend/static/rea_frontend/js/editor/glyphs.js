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
 * *control* labels: they have to sit in a button at 18 pixels, line up with
 * their neighbours, and take the button's own colour when it lights up.  A
 * handful of lines and an ellipse does all three, and needs no font to have
 * loaded before the toolbar can be drawn.
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

function node(name, attrs) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
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

  const svg = node("svg", {
    class: "ed-glyph", viewBox: "0 0 16 22", width: 16, height: 22,
    "aria-hidden": "true", focusable: "false",
  });

  // The head sits low in the box and the stem rises from its right side, the
  // way a note below the middle line is written.
  svg.appendChild(node("ellipse", {
    cx: 6, cy: 16.5, rx: 4.6, ry: 3.4, transform: "rotate(-20 6 16.5)",
    fill: shape.filled ? "currentColor" : "none",
    stroke: "currentColor", "stroke-width": 1.6,
  }));
  if (shape.stem) {
    svg.appendChild(node("line", {
      x1: 10.4, y1: 15.4, x2: 10.4, y2: 2.5,
      stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round",
    }));
    // Flags hang off the top of the stem, one below the other — three of them
    // still fit above the head at this size, which is the whole reason the
    // box is 22 units tall.
    for (let i = 0; i < shape.flags; i += 1) {
      const y = 3 + i * 4;
      svg.appendChild(node("path", {
        d: `M10.4 ${y} q4.4 2.2 3.4 6.2 q-0.6 -3 -3.4 -3.6 z`,
        fill: "currentColor",
      }));
    }
  }
  return svg;
}

/**
 * Put the glyph for *duration* into *button*, keeping the fraction as the
 * accessible name.
 *
 * The fraction is not thrown away: it stays as the button's text for a screen
 * reader and as part of its tooltip, because "1/8" is still the exact answer
 * to "which one is this" and the picture is only the faster one.
 */
export function labelWithDuration(button, duration, text) {
  const glyph = durationGlyph(duration);
  if (!glyph) return button;
  button.textContent = "";
  button.appendChild(glyph);
  const label = document.createElement("span");
  label.className = "ed-glyph-text";
  label.textContent = text;
  button.appendChild(label);
  return button;
}
