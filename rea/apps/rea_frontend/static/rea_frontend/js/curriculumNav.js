/**
 * curriculumNav.js — the whole navigation surface.
 *
 * There are exactly three things a student can use:
 *
 *   1. the path line   — one row, every level a segment that opens only its
 *                        own siblings.  The single menu in the app.
 *   2. Previous / Next — walks the ten exercises of the current category,
 *                        then hands off to the next part / next category.
 *   3. the curriculum sheet — the whole tree, behind a button (⌘K), for
 *                        jumping rather than working.
 *
 * The module owns no lesson state: it renders whatever `deps` reports and
 * calls back when the student picks something.
 *
 * deps:
 *   exercises()      → [{ id, title }]  the ten exercises of a category
 *   exerciseIndex()  → 0-based index of the current exercise
 *   partOptions()    → [{ value, label }] for a `parts` node ([] otherwise)
 *   partValue()      → the selected part value
 *   keyOptions()     → [{ value, label }] tonalities ([] when not relative)
 *   keyValue()       → the selected key id, as a string
 *   goCategory(node, partValue?, exerciseIdx?)
 *   goPart(value)
 *   goExercise(idx)
 *   goKey(id)
 */

import {
  TREE, CATEGORIES, pathOf, firstCategory, labelFor, kindOf,
} from "./curriculum.js?v=107";

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

const CARET =
  '<svg class="seg-caret" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 5l3 3 3-3"/></svg>';

const TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

export function createNav(deps) {
  let category = null;
  let sheetOpen = false;

  // -------------------------------------------------------------------------
  // Path line
  // -------------------------------------------------------------------------

  /**
   * One path segment.  `options` are {label, current, pick} descriptors; a
   * segment with a single option renders as plain text, with no menu.
   */
  function segment(bar, label, options) {
    // No separator in the collapsed form: there is no path to separate from,
    // only the location button and the exercise.
    if (bar.children.length && !NARROW.matches) bar.appendChild(el("span", "seg-sep", "›"));

    const seg = el("span", "seg");
    const btn = el("button", "seg-btn");
    btn.type = "button";
    btn.innerHTML = escapeHTML(label) + (options.length > 1 ? CARET : "");
    seg.appendChild(btn);

    if (options.length > 1) {
      const pop = el("div", "seg-pop");
      options.forEach((o) => {
        const b = el("button", "seg-opt");
        b.type = "button";
        b.setAttribute("aria-current", o.current ? "true" : "false");
        b.innerHTML = '<span class="seg-tick">' + TICK + "</span>" + escapeHTML(o.label);
        b.addEventListener("click", (e) => { e.stopPropagation(); closeAllPops(); o.pick(); });
        pop.appendChild(b);
      });
      seg.appendChild(pop);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const was = seg.classList.contains("open");
        closeAllPops();
        if (!was) {
          seg.classList.add("open");
          // Keep a long menu (30 tonalities, 7 qualities) inside the viewport.
          const r = pop.getBoundingClientRect();
          if (r.right > window.innerWidth - 8) pop.classList.add("align-right");
        }
      });
    } else {
      btn.classList.add("static");
    }
    bar.appendChild(seg);
  }

  function closeAllPops() {
    document.querySelectorAll(".seg.open").forEach((s) => {
      s.classList.remove("open");
      const p = s.querySelector(".seg-pop");
      if (p) p.classList.remove("align-right");
    });
  }

  /** Below this width the full path can run to three wrapped rows and eat the
   *  screen the staff needs, so it collapses to where-you-are plus a way in. */
  const NARROW = window.matchMedia("(max-width: 720px)");

  function renderPath(bar) {
    bar.innerHTML = "";

    if (NARROW.matches) {
      // One button naming the branch, opening the sheet — the levels above it
      // are still reachable, just not spelled out across the top of a phone.
      const path = pathOf(category);
      const here = path.slice(-2).map((n) => n.name).join(" · ");
      const b = el("button", "path-here");
      b.type = "button";
      b.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M4 6h16M4 12h16M4 18h16"/></svg><span>' + escapeHTML(here) + "</span>";
      b.addEventListener("click", (e) => { e.stopPropagation(); openSheet(); });
      bar.appendChild(b);
    } else {
      // One segment per level of the tree.
      pathOf(category).forEach((node) => {
        segment(bar, node.name, node.siblings.map((sib) => ({
          label: sib.name,
          current: sib === node,
          pick: () => deps.goCategory(firstCategory(sib)),
        })));
      });
    }

    // The progressive part, when this category has one.
    const parts = deps.partOptions();
    if (parts.length > 1) {
      const cur = deps.partValue();
      const now = parts.find((p) => p.value === cur) || parts[0];
      segment(bar, now.label, parts.map((p) => ({
        label: p.label,
        current: p.value === cur,
        pick: () => deps.goPart(p.value),
      })));
    }

    // The exercise itself — the last segment, so switching Listening for
    // Guessing is the same gesture as switching Octave for Quinta.
    const exercises = deps.exercises();
    if (exercises.length > 1) {
      const idx = deps.exerciseIndex();
      const now = exercises[idx];
      segment(bar, NARROW.matches && now.short ? now.short : now.title, exercises.map((x, i) => ({
        label: x.title,
        current: i === idx,
        pick: () => deps.goExercise(i),
      })));
    }
  }

  /** The tonality chip — one control, sitting apart from the path because a
   *  key applies across the whole relative system rather than to one node. */
  function renderKey(host) {
    const keys = deps.keyOptions();
    host.innerHTML = "";
    if (!keys.length) { host.hidden = true; return; }
    host.hidden = false;
    const cur = deps.keyValue();
    const now = keys.find((k) => k.value === cur) || keys[0];
    segment(host, now ? now.label : "—", keys.map((k) => ({
      label: k.label,
      current: k.value === cur,
      pick: () => deps.goKey(k.value),
    })));
  }

  // -------------------------------------------------------------------------
  // Previous / Next
  // -------------------------------------------------------------------------

  /**
   * Where Previous and Next lead.  Within the category first — the ten
   * exercises — then the neighbouring part, then the neighbouring category.
   * Each step reports the boundary it crosses so the button can say so.
   */
  function step(dir) {
    const exercises = deps.exercises();
    const idx = deps.exerciseIndex();
    const nextIdx = idx + dir;
    if (nextIdx >= 0 && nextIdx < exercises.length) {
      return { label: exercises[nextIdx].title, cross: null, go: () => deps.goExercise(nextIdx) };
    }

    // Off the end of the exercises: try the neighbouring part of this category.
    const parts = deps.partOptions();
    if (parts.length > 1) {
      const pi = parts.findIndex((p) => p.value === deps.partValue());
      const pj = pi + dir;
      if (pj >= 0 && pj < parts.length) {
        return {
          label: parts[pj].label,
          cross: dir > 0 ? "next part" : "previous part",
          go: () => deps.goPart(parts[pj].value, dir > 0 ? 0 : -1),
        };
      }
    }

    // Off the end of the parts too: the neighbouring category.
    const cat = CATEGORIES[category.pos + dir];
    if (!cat) return null;
    return {
      label: labelFor(cat),
      cross: dir > 0 ? "next category" : "previous category",
      go: () => deps.goCategory(cat, null, dir > 0 ? 0 : -1),
    };
  }

  let prevStep = null;
  let nextStep = null;

  function renderFooter(footer) {
    prevStep = step(-1);
    nextStep = step(1);

    const paint = (btn, lbl, spec) => {
      btn.disabled = !spec;
      lbl.innerHTML = spec
        ? (spec.cross ? '<span class="nav-cross">' + spec.cross + "</span>" : "") +
          '<span class="nav-name">' + escapeHTML(spec.label) + "</span>"
        : "";
      btn.onclick = spec ? spec.go : null;
    };
    paint(footer.querySelector("#nav-prev"), footer.querySelector("#nav-prev-label"), prevStep);
    paint(footer.querySelector("#nav-next"), footer.querySelector("#nav-next-label"), nextStep);
  }

  // -------------------------------------------------------------------------
  // Curriculum sheet
  // -------------------------------------------------------------------------

  function renderSheet(host) {
    host.innerHTML = "";
    const onPath = new Set(pathOf(category).map((n) => n.uid));

    (function build(nodes, into) {
      nodes.forEach((node) => {
        const branch = !!(node.children && node.children.length);
        const open = node._open || onPath.has(node.uid);
        const b = el("button", "tree-node" + (branch ? " branch" : ""));
        b.type = "button";
        b.innerHTML = '<span class="tree-twist">' + (branch ? (open ? "▾" : "▸") : "") +
          "</span>" + escapeHTML(node.name);
        if (node === category) b.setAttribute("aria-current", "true");
        into.appendChild(b);

        if (branch) {
          const kids = el("div", "tree-kids");
          kids.hidden = !open;
          into.appendChild(kids);
          build(node.children, kids);
          b.addEventListener("click", () => {
            node._open = kids.hidden;
            kids.hidden = !kids.hidden;
            b.querySelector(".tree-twist").textContent = kids.hidden ? "▸" : "▾";
          });
        } else {
          b.addEventListener("click", () => { closeSheet(); deps.goCategory(node); });
        }
      });
    })(TREE, host);
  }

  function openSheet() {
    sheetOpen = true;
    const scrim = document.getElementById("curriculum-scrim");
    renderSheet(document.getElementById("curriculum-tree"));
    scrim.hidden = false;
    const cur = scrim.querySelector('[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: "center" });
  }

  function closeSheet() {
    sheetOpen = false;
    document.getElementById("curriculum-scrim").hidden = true;
  }

  // -------------------------------------------------------------------------

  function render(cat) {
    category = cat;
    renderPath(document.getElementById("path-bar"));
    renderKey(document.getElementById("path-key"));
    renderFooter(document.getElementById("session-nav"));
    if (sheetOpen) renderSheet(document.getElementById("curriculum-tree"));
  }

  // Global wiring, once.
  NARROW.addEventListener("change", () => { if (category) render(category); });

  const openBtn = document.getElementById("curriculum-open");
  if (openBtn) openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sheetOpen ? closeSheet() : openSheet();
  });
  const closeBtn = document.getElementById("curriculum-close");
  if (closeBtn) closeBtn.addEventListener("click", closeSheet);
  const scrim = document.getElementById("curriculum-scrim");
  if (scrim) scrim.addEventListener("click", (e) => { if (e.target === scrim) closeSheet(); });

  document.addEventListener("click", closeAllPops);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      sheetOpen ? closeSheet() : openSheet();
      return;
    }
    if (e.key === "Escape") { closeAllPops(); if (sheetOpen) closeSheet(); return; }
    // Arrow keys move through exercises, but never while typing or while the
    // practice deck wants them.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "ArrowRight" && nextStep) { e.preventDefault(); nextStep.go(); }
    if (e.key === "ArrowLeft" && prevStep) { e.preventDefault(); prevStep.go(); }
  });

  return { render, openSheet, closeSheet, kindOf };
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
