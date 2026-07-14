/**
 * API fetch wrappers for the REA relative-intonation endpoints.
 * All endpoints are rooted at /api/intonation/relative/.
 */

const BASE = "/api/intonation/relative";

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} - ${url}`);
  return res.json();
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

  /** List lessons, optionally filtered. */
  async listLessons({ keyModel = null, formula = null } = {}) {
    const p = new URLSearchParams();
    if (keyModel) p.set("key_model", keyModel);
    if (formula) p.set("formula_name__icontains", formula);
    const q = p.toString() ? `?${p.toString()}` : "";
    return fetchJSON(`${BASE}/lessons/${q}`);
  },

  /** Get a single lesson with its bars/events. */
  async getLesson(id) {
    return fetchJSON(`${BASE}/lessons/${id}/`);
  },

  /** List scale models. */
  async listScaleModels() {
    return fetchJSON(`${BASE}/scale-models/`);
  },
};