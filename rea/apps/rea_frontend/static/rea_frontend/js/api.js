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
  async listLessons({ keyModel = null, formula = null } = {}) {
    const p = new URLSearchParams();
    if (keyModel) p.set("key_model", keyModel);
    if (formula) p.set("formula_name__icontains", formula);
    const q = p.toString() ? `?${p.toString()}` : "";
    return fetchJSON(`${BASE}/lessons/${q}`);
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
  async listAbsoluteLessons({ category = null, span = null } = {}) {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (span) p.set("span", span);
    const q = p.toString() ? `?${p.toString()}` : "";
    return fetchAllPages(`${ABS_BASE}/lessons/${q}`);
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
