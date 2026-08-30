/**
 * editorApi.js
 *
 * The editor's half of the teacher API (`/api/editor/...`).
 *
 * Unlike `api.js`, every call here can write, so each one carries Django's
 * CSRF token and each one surfaces its errors: a save that fails must say so
 * in the teacher's own words ("another exercise already uses this variant"),
 * never be swallowed the way a missed progress sync is.
 */

const BASE = "/api/editor";

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** An API error carrying the server's field errors, ready for the UI. */
export class ApiError extends Error {
  constructor(message, { status = 0, fields = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
  }
}

/**
 * Turn a DRF error body into one readable sentence.
 *
 * DRF answers with `{detail: "..."}` for view-level refusals and with
 * `{field: ["..."], meta: {field: ["..."]}}` for validation, and a teacher
 * needs to read both without opening the network tab.
 */
function describe(body, status) {
  if (!body) return `Request failed (${status}).`;
  if (typeof body === "string") return body;
  if (body.detail) return body.detail;
  const parts = [];
  const walk = (obj, prefix) => {
    Object.entries(obj || {}).forEach(([key, value]) => {
      const label = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((v) => {
          if (v && typeof v === "object") walk(v, label);
          else parts.push(`${label}: ${v}`);
        });
      } else if (value && typeof value === "object") {
        walk(value, label);
      } else {
        parts.push(`${label}: ${value}`);
      }
    });
  };
  walk(body, "");
  return parts.length ? parts.join(" · ") : `Request failed (${status}).`;
}

async function request(url, { method = "GET", body = null } = {}) {
  const options = {
    method,
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  };
  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.headers["X-CSRFToken"] = csrfToken();
    options.body = JSON.stringify(body);
  } else if (method !== "GET") {
    options.headers["X-CSRFToken"] = csrfToken();
  }

  const res = await fetch(url, options);
  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (e) { payload = text; }
  }
  if (!res.ok) {
    throw new ApiError(describe(payload, res.status), {
      status: res.status,
      fields: payload && typeof payload === "object" ? payload : null,
    });
  }
  return payload;
}

export const EditorAPI = {
  /** Every dropdown's contents, read from the library itself. */
  options() {
    return request(`${BASE}/options/`);
  },

  /** Exercises matching the picker's filters (ids and names only). */
  browse(params = {}) {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== "") q.set(k, v);
    });
    return request(`${BASE}/browse/?${q.toString()}`);
  },

  /** A starting document for a new exercise, with the importers' defaults. */
  blank(system, { keyModel = null } = {}) {
    const q = keyModel ? `?key_model=${encodeURIComponent(keyModel)}` : "";
    return request(`${BASE}/${system}/blank/${q}`);
  },

  /** One exercise, whole. */
  load(system, id) {
    return request(`${BASE}/${system}/scores/${id}/`);
  },

  /** Create a new exercise from a document. */
  create(system, document) {
    return request(`${BASE}/${system}/scores/`, { method: "POST", body: document });
  },

  /** Replace an existing exercise with a document. */
  save(system, id, document) {
    return request(`${BASE}/${system}/scores/${id}/`, { method: "PUT", body: document });
  },

  /** Copy an exercise, uniqueness resolved server-side. */
  duplicate(system, id) {
    return request(`${BASE}/${system}/scores/${id}/duplicate/`, { method: "POST", body: {} });
  },

  /** Delete an exercise. */
  remove(system, id) {
    return request(`${BASE}/${system}/scores/${id}/`, { method: "DELETE" });
  },
};
