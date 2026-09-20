/**
 * Stop means stop.
 *
 * A piece is scheduled in one go: pressing Play hands WebAudio every note of
 * the exercise at once, each with its own absolute start time, and then the
 * browser plays them without being asked again.  Stopping is therefore not a
 * matter of cutting the note that is sounding — it is unscheduling the forty
 * that are not.
 *
 * That is the bug this file exists for, and it has been reported twice.  The
 * voice's `stop` clamped itself to `t + 0.005`, five milliseconds after *the
 * note's own start*, which for a note due in eight seconds scheduled the stop
 * eight seconds out: the note began on time, jumped to full gain and rang for
 * the thirty milliseconds of the release ramp.  Multiply by every remaining
 * note and what a user hears after pressing Stop is the rest of the exercise,
 * played as a row of clicks.  "The playback continues with very short decay
 * of notes after hitting stop" is exactly that, and it sounds like a note
 * failing to stop rather than like every note stopping at the wrong time,
 * which is why it survived one fix already.
 *
 * So the test is about *time*, not about sound: a fake AudioContext records
 * what was scheduled, the player is stopped mid-piece, and nothing may be
 * left that can make a sound afterwards.
 */

import "./env.mjs";
import { AudioPlayer } from "../../apps/rea_frontend/static/rea_frontend/js/audioPlayer.js";
import { setSoundPresetById, SOUND_PRESETS } from "../../apps/rea_frontend/static/rea_frontend/js/soundPresets.js";

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok   " + name); }
  else { failed += 1; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// ---------------------------------------------------------------------------
// A WebAudio context that plays nothing and remembers everything.
// ---------------------------------------------------------------------------

function fakeParam() {
  return {
    value: 1,
    events: [],
    setValueAtTime(v, t) { this.events.push({ kind: "set", v, t }); return this; },
    linearRampToValueAtTime(v, t) { this.events.push({ kind: "linear", v, t }); return this; },
    exponentialRampToValueAtTime(v, t) { this.events.push({ kind: "exp", v, t }); return this; },
    cancelScheduledValues(t) { this.events.push({ kind: "cancel", t }); return this; },
  };
}

function fakeContext() {
  const ctx = {
    currentTime: 0,
    state: "running",
    destination: { id: "destination" },
    oscillators: [],
    gains: [],
    resume() { return Promise.resolve(); },
    createOscillator() {
      const osc = {
        type: "sine", frequency: fakeParam(), detune: fakeParam(),
        startedAt: null, stoppedAt: null,
        start(t) { this.startedAt = t; },
        // The real node refuses a second stop; the app relies on that being
        // harmless, so the fake refuses too.
        stop(t) {
          if (this.stoppedAt != null) throw new Error("already stopped");
          this.stoppedAt = t;
        },
        connect(next) { return next; },
        disconnect() { this.disconnected = true; },
      };
      ctx.oscillators.push(osc);
      return osc;
    },
    createGain() {
      const gain = {
        gain: fakeParam(), connections: [],
        connect(next) { this.connections.push(next); return next; },
        disconnect() { this.disconnected = true; this.connections = []; },
      };
      ctx.gains.push(gain);
      return gain;
    },
    createBiquadFilter() {
      return {
        type: "lowpass", frequency: fakeParam(), Q: fakeParam(),
        connect(next) { return next; }, disconnect() {},
      };
    },
  };
  return ctx;
}

/** A plain scale, scheduled across four seconds. */
function phrase() {
  return [60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => ({
    midi, isRest: false, startMs: i * 500, durationMs: 480, volume: 80,
  }));
}

function playWith(preset) {
  setSoundPresetById(preset.id);
  const ctx = fakeContext();
  globalThis.window.__reaAudioCtx = ctx;
  const player = new AudioPlayer();
  player.play(phrase());
  return { ctx, player };
}

// ---------------------------------------------------------------------------

console.log("Transport");

globalThis.window = globalThis.window || {};
globalThis.window.AudioContext = function () { return fakeContext(); };
globalThis.setTimeout = globalThis.setTimeout;

// The preset with the most going on: partials with their own decay, a filter,
// and a tremolo LFO — the last being a source that is not a partial and was
// left running by every earlier version of `stop`.
const rich = SOUND_PRESETS.find((p) => p.tremolo && p.tremolo.depth > 0) || SOUND_PRESETS[0];

for (const preset of [SOUND_PRESETS[0], rich]) {
  console.log("  · " + preset.id);
  const { ctx, player } = playWith(preset);
  ok("the whole phrase is scheduled up front",
    ctx.oscillators.length > 0 && ctx.oscillators.some((o) => o.startedAt > 2),
    `${ctx.oscillators.length} sources, latest start ${Math.max(...ctx.oscillators.map((o) => o.startedAt))}`);

  // Two seconds in: four notes have sounded, four have not.
  ctx.currentTime = 2;
  player.stop();

  const stillToSound = ctx.oscillators.filter(
    (o) => o.stoppedAt == null || o.stoppedAt > Math.max(o.startedAt, 2 + 0.1),
  );
  ok("nothing is left that can sound after the stop",
    stillToSound.length === 0,
    stillToSound.length
      ? `${stillToSound.length} of ${ctx.oscillators.length}: ` + stillToSound
        .slice(0, 3)
        .map((o) => `start ${o.startedAt.toFixed(2)} stop ${o.stoppedAt}`)
        .join(", ")
      : "");

  const future = ctx.oscillators.filter((o) => o.startedAt > 2);
  ok("a note that had not begun is stopped before it would have",
    future.length > 0 && future.every((o) => o.stoppedAt < o.startedAt),
    future.map((o) => `${o.startedAt.toFixed(2)}→${o.stoppedAt}`).slice(0, 3).join(", "));

  ok("the note that was sounding is faded rather than cut",
    ctx.oscillators.some((o) => o.startedAt <= 2 && o.stoppedAt > 2),
    "");
}

// The one that was actually reported: stop, then let the clock run past every
// note's start, and check nothing was scheduled to make a sound there.
{
  console.log("  · after the stop, as the clock runs on");
  const { ctx, player } = playWith(SOUND_PRESETS[0]);
  ctx.currentTime = 1;
  player.stop();
  const blips = ctx.oscillators.filter((o) => o.stoppedAt > o.startedAt && o.startedAt > 1);
  ok("no later note is left with a window to sound in",
    blips.length === 0,
    blips.map((o) => `${o.startedAt.toFixed(2)}→${o.stoppedAt.toFixed(2)}`).slice(0, 4).join(", "));

  // The disconnect is on a timer, so the graph is checked once it has run.
  await new Promise((resolve) => setTimeout(resolve, 90));
  const connected = ctx.gains.filter((g) => !g.disconnected && g.connections.includes(ctx.destination));
  ok("…and the graph is empty once the fade is over",
    connected.length === 0,
    `${connected.length} still connected`);
}

console.log(failed ? `\n${failed} FAIL, ${passed} ok` : `\nall ${passed} transport tests pass`);
