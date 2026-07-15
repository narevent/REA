/**
 * API fetch wrappers for the REA intonation endpoints.
 * Relative endpoints live under /api/intonation/relative/,
 * absolute endpoints under /api/intonation/absolute/.
 */

const BASE = "/api/intonation/relative";
const ABS_BASE = "/api/intonation/absolute";

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} - ${url}`);
  return res.json();
}

/** Follow DRF pagination until exhausted; returns the concatenated results. */
async function fetchAllPages(url) {
  let out = [];
  let next = url;
  while (next) {
    const data = await fetchJSON(next);
    if (Array.isArray(data)) return data;
    out = out.concat(data.results || []);
    next = data.next;
  }
  return out;
}

export const API = {
  /** List key models (optionally filtered by mode). */
  async listKeys(mode = null) {
    const q = mode ? `?mode=${mode}` : "";
    return fetchJSON(`${BASE}/key-models/${q}`);
  },

  /** Get a single key model with its bars/events. */
  async getKey(id) {
    return fetchJSON(`${BASE}/key-models/${id}/`);
  },

  /** List relative lessons, optionally filtered. */
  async listLessons({ keyModel = null, formula = null, texture = null } = {}) {
    const p = new URLSearchParams();
    if (keyModel) p.set("key_model", keyModel);
    if (formula) p.set("formula_name__icontains", formula);
    if (texture) p.set("texture", texture);
    const q = p.toString() ? `?${p.toString()}` : "";
    return fetchJSON(`${BASE}/lessons/${q}`);
  },

  /**
   * List relative *poly* lessons.  Poly context = key + category + subgroup
   * (interval_name / inversion) + part.  Returns all pages so the chapter
   * map can offer a complete subgroup/part list even when a category holds
   * more than one page of lessons (Intervals = 75, Sevenths = 60 per key).
   */
  async listPolyLessons({ keyModel = null, category = null, intervalName = null, inversion = null } = {}) {
    const p = new URLSearchParams();
    p.set("texture", "poly");
    if (keyModel) p.set("key_model", keyModel);
    if (category) p.set("category", category);
    if (intervalName) p.set("interval_name", intervalName);
    if (inversion) p.set("inversion", inversion);
    return fetchAllPages(`${BASE}/lessons/?${p.toString()}`);
  },

  /** Get a single relative lesson with its bars/events. */
  async getLesson(id) {
    return fetchJSON(`${BASE}/lessons/${id}/`);
  },

  /** List scale models. */
  async listScaleModels() {
    return fetchJSON(`${BASE}/scale-models/`);
  },

  /** List absolute lessons for a category/span family (all pages). */
  async listAbsoluteLessons({ category = null, span = null, texture = null } = {}) {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (span) p.set("span", span);
    if (texture) p.set("texture", texture);
    const q = p.toString() ? `?${p.toString()}` : "";
    return fetchAllPages(`${ABS_BASE}/lessons/${q}`);
  },

  /**
   * List *poly* absolute lessons.  Poly context = category + subgroup
   * (quality / interval_size / inversion) + phase + part.  Returns all
   * pages so the chapter picker can match by exercise_number / exercise_type.
   * Any falsy parameter is omitted so the call can be scoped at any level
   * (full category for subgroup options, or a fully specific single lesson).
   */
  async listAbsolutePolyLessons({
    category = null, quality = null, intervalSize = null, inversion = null,
    phase = null, part = null, exerciseNumber = null, exerciseType = null,
  } = {}) {
    const p = new URLSearchParams();
    p.set("texture", "poly");
    if (category) p.set("category", category);
    if (quality) p.set("quality", quality);
    if (intervalSize) p.set("interval_size", intervalSize);
    if (inversion) p.set("inversion", inversion);
    if (phase !== null && phase !== "") p.set("phase", phase);
    if (part) p.set("part", part);
    if (exerciseNumber !== null && exerciseNumber !== "") p.set("exercise_number", exerciseNumber);
    if (exerciseType) p.set("exercise_type", exerciseType);
    return fetchAllPages(`${ABS_BASE}/lessons/?${p.toString()}`);
  },

  /** Get a single absolute lesson with its bars/events. */
  async getAbsoluteLesson(id) {
    return fetchJSON(`${ABS_BASE}/lessons/${id}/`);
  },

  /** Combined exercise list across both systems (relative | absolute | both). */
  async listExercises(system = null) {
    const q = system ? `?system=${system}` : "";
    return fetchJSON(`/api/intonation/exercises/${q}`);
  },
};
