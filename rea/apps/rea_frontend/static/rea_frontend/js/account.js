/**
 * account.js
 *
 * The practice app's link to the signed-in user, if there is one.
 *
 * REA works fully signed out — progress then lives in localStorage and never
 * leaves the browser (see chapters.js).  Signing in adds a second, durable
 * record: every completed run is POSTed so the profile dashboard can show
 * progress over time.  Nothing here is on the critical path, so a failed or
 * refused request is swallowed rather than interrupting practice: the local
 * progress store has already been updated by the time we are called.
 */

const ME_URL = "/api/accounts/me/";
const SESSIONS_URL = "/api/accounts/sessions/";

let _me = { authenticated: false };

/** Read Django's CSRF cookie (the page sets it via ensure_csrf_cookie). */
function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** Who is signed in.  Resolves to `{ authenticated: false }` when nobody is. */
export async function loadAccount() {
  try {
    const res = await fetch(ME_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) return _me;
    _me = await res.json();
  } catch (e) {
    // Offline, or the endpoint is unreachable — practising must still work.
  }
  return _me;
}

/** The account as last loaded (synchronous, for render paths). */
export function currentAccount() { return _me; }

export function isSignedIn() { return !!_me.authenticated; }

/**
 * Record a completed run against the signed-in user.
 *
 * @param {object} run
 * @param {number} run.chapterId
 * @param {string} run.chapterKey
 * @param {string} [run.chapterTitle]
 * @param {number} run.score      0-100
 * @param {number} [run.rounds]
 * @param {object} [run.context]  { system, texture, keyName, formula }
 * @returns {Promise<boolean>} whether it was stored server-side
 */
export async function recordServerSession(run) {
  if (!isSignedIn()) return false;
  const ctx = run.context || {};
  const payload = {
    chapter_id: run.chapterId,
    chapter_key: run.chapterKey || "",
    chapter_title: run.chapterTitle || "",
    score: Math.max(0, Math.min(100, Math.round(run.score || 0))),
    rounds: run.rounds || 0,
    system: ctx.system || "",
    texture: ctx.texture || "",
    key_name: ctx.keyName || "",
    formula: ctx.formula || "",
  };
  try {
    const res = await fetch(SESSIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRFToken": csrfToken(),
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

const OCTAVES_URL = "/api/accounts/octaves/";

/**
 * The notes this student sings an octave away from where they are written,
 * as a Map of "system:eventId" -> shift.  Empty when signed out or offline:
 * the exercise is then simply sung as written.
 */
export async function loadNoteOctaves() {
  const map = new Map();
  if (!isSignedIn()) return map;
  try {
    const res = await fetch(OCTAVES_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) return map;
    (await res.json()).forEach((row) => map.set(row.system + ":" + row.event_id, row.shift));
  } catch (e) { /* sung as written */ }
  return map;
}

/** Move one note for this student; a shift of 0 puts it back.  Resolves to
 *  whether the server kept it. */
export async function saveNoteOctave(system, eventId, shift) {
  if (!isSignedIn()) return false;
  try {
    const res = await fetch(OCTAVES_URL, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRFToken": csrfToken(),
      },
      body: JSON.stringify({ system, event_id: eventId, shift }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}
