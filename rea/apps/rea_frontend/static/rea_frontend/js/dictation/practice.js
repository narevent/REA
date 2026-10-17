/**
 * practice.js — a dictation, given to a student.
 *
 * How a classical dictation goes: the teacher gives the key, plays the piece
 * through once, then plays it phrase by phrase, each a few times, while the
 * students write; at the end the score is shown and they check their work.
 * This view is that, with the student at the controls: the key chord and the
 * opening notes, the whole piece, each phrase as often as they like (the
 * count is kept, because how many hearings it took is part of the
 * exercise), a speed control, and the score — hidden until they ask for it.
 */

import * as S from "./score.js?v=181";
import { renderScore } from "./layout.js?v=181";
import { schedule } from "./playback.js?v=181";

const API = "/api/dictation-scores/";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class DictationPractice {
  /**
   * @param {HTMLElement} host
   * @param {object} opts  { player: AudioPlayer, setStatus(msg) }
   */
  constructor(host, { player, setStatus = () => {} }) {
    this.host = host;
    this.player = player;
    this.setStatus = setStatus;
    this.data = null;
    this.score = null;
    this.plays = new Map();
    this.revealed = false;
    this.tempoScale = 1;
    this.current = null;
    this.playingPhrase = null;
  }

  async open(id) {
    this.stop();
    this.host.innerHTML = '<div class="dzp"><p class="dzp-loading">Loading the dictation…</p></div>';
    const res = await fetch(`${API}${id}/`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(res.status === 404 ? "This dictation is not available." : `The server said ${res.status}.`);
    this.data = await res.json();
    this.score = S.normalise(this.data.score && this.data.score.measures ? this.data.score : S.newScore());
    this.plays = new Map();
    this.revealed = false;
    this.current = null;
    this.render();
    this.setStatus(this.data.title);
  }

  phrases() {
    return (this.data.phrases || []).filter((p) => S.phraseSpan(this.score, p));
  }

  render() {
    const d = this.data;
    const root = el("div", "dzp");
    const head = el("div", "dzp-head");
    const titles = el("div", "dzp-titles");
    titles.appendChild(el("h2", "dzp-title", d.title));
    const by = [d.composer, d.owner_name ? `set by ${d.owner_name}` : ""].filter(Boolean).join(" · ");
    if (by) titles.appendChild(el("p", "dzp-by", by));
    head.appendChild(titles);
    const [num, den] = S.timeAt(this.score, 0);
    head.appendChild(el("div", "dzp-meta", `${S.keyName(S.keyAt(this.score, 0))} · ${num}/${den} · ${this.score.parts.map((p) => p.name).join(", ")}`));
    root.appendChild(head);
    if (d.description) root.appendChild(el("p", "dzp-desc", d.description));

    // The orientation a teacher gives before a dictation.
    const before = el("div", "dzp-bar");
    before.appendChild(this.btn("Key chord", "The tonic chord of the key, to set the ear", () => this.playKeyChord()));
    before.appendChild(this.btn("First notes", "The opening notes of every part, together", () => this.playOpening()));
    before.appendChild(this.btn("Whole piece", "Play it all through, with its repeats", () => this.playAll(), "dzp-primary"));
    const speed = el("label", "dzp-speed");
    speed.appendChild(el("span", null, "Speed"));
    const slider = el("input");
    slider.type = "range";
    slider.min = 40;
    slider.max = 120;
    slider.step = 5;
    slider.value = String(Math.round(this.tempoScale * 100));
    const readout = el("span", "dzp-speed-val", `${slider.value}%`);
    slider.addEventListener("input", () => { this.tempoScale = Number(slider.value) / 100; readout.textContent = `${slider.value}%`; });
    speed.appendChild(slider);
    speed.appendChild(readout);
    before.appendChild(speed);
    before.appendChild(this.btn("Stop", "Stop playing", () => this.stop(), "dzp-quiet"));
    root.appendChild(before);

    const phrases = this.phrases();
    const list = el("ol", "dzp-phrases");
    if (!phrases.length) {
      root.appendChild(el("p", "dzp-hint", "This dictation has not been cut into phrases yet — play the whole piece."));
    }
    phrases.forEach((phrase, i) => {
      const span = S.phraseSpan(this.score, phrase);
      const item = el("li", `dzp-phrase${this.current === phrase.id ? " is-current" : ""}${this.playingPhrase === phrase.id ? " is-playing" : ""}`);
      const label = el("div", "dzp-phrase-label");
      label.appendChild(el("span", "dzp-phrase-num", String(i + 1)));
      label.appendChild(el("span", "dzp-phrase-name", phrase.name || `Phrase ${i + 1}`));
      if (this.revealed) label.appendChild(el("span", "dzp-phrase-where", `measures ${span.fromMeasure + 1}–${span.toMeasure + 1}`));
      item.appendChild(label);
      const count = this.plays.get(phrase.id) || 0;
      item.appendChild(el("span", "dzp-count", count ? `heard ${count}×` : "not heard yet"));
      item.appendChild(this.btn("Play", `Play phrase ${i + 1}`, () => this.playPhrase(phrase.id)));
      list.appendChild(item);
    });
    root.appendChild(list);
    if (phrases.length) {
      const next = el("div", "dzp-bar");
      next.appendChild(this.btn(this.current ? "Next phrase" : "First phrase", "Move on to the next phrase and play it", () => this.playNext(), "dzp-primary"));
      if (this.current) next.appendChild(this.btn("Again", "Play the current phrase again", () => this.playPhrase(this.current)));
      root.appendChild(next);
    }

    const reveal = el("div", "dzp-reveal");
    reveal.appendChild(this.btn(this.revealed ? "Hide the score" : "Show the score", this.revealed
      ? "Hide the score and keep listening" : "Check what you wrote against the score",
    () => { this.revealed = !this.revealed; this.render(); }, this.revealed ? "" : "dzp-reveal-btn"));
    root.appendChild(reveal);
    const scoreHost = el("div", "dzp-score");
    scoreHost.hidden = !this.revealed;
    root.appendChild(scoreHost);

    this.host.innerHTML = "";
    this.host.appendChild(root);
    if (this.revealed) {
      // The box's inner width: clientWidth counts its padding.
      const width = Math.max(480, (scoreHost.clientWidth || this.host.clientWidth - 40) - 16);
      renderScore(scoreHost, this.score, {
        width,
        phrases: phrases.map((p, i) => Object.assign({ number: i + 1, selected: p.id === this.current }, p)),
      });
    }
  }

  btn(label, title, action, className = "") {
    const b = el("button", `btn dzp-btn ${className}`.trim(), label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", action);
    return b;
  }

  play(steps, onDone) {
    if (!steps.length) { this.setStatus("Nothing to play."); return; }
    this.player.play(steps, { onStep: (i) => { if (i < 0 && onDone) onDone(); } });
  }

  stop() {
    if (this.player) this.player.stop();
    this.playingPhrase = null;
  }

  playAll() {
    this.playingPhrase = null;
    this.play(schedule(this.score, { tempoScale: this.tempoScale }).steps);
    this.setStatus("The whole piece.");
  }

  playPhrase(id) {
    const phrase = this.phrases().find((p) => p.id === id);
    if (!phrase) return;
    const span = S.phraseSpan(this.score, phrase);
    this.current = id;
    this.playingPhrase = id;
    this.plays.set(id, (this.plays.get(id) || 0) + 1);
    this.render();
    this.play(schedule(this.score, { span, tempoScale: this.tempoScale }).steps, () => {
      this.playingPhrase = null;
      this.render();
    });
    const index = this.phrases().indexOf(phrase) + 1;
    this.setStatus(`Phrase ${index} of ${this.phrases().length}${this.plays.get(id) > 1 ? ` — ${this.plays.get(id)} times` : ""}.`);
  }

  playNext() {
    const phrases = this.phrases();
    if (!phrases.length) return;
    const at = phrases.findIndex((p) => p.id === this.current);
    const next = phrases[Math.min(phrases.length - 1, at + 1)];
    this.playPhrase(next.id);
  }

  /** The tonic triad of the opening key, in a middle register. */
  playKeyChord() {
    const fifths = S.keyAt(this.score, 0);
    const tonicPc = ((fifths * 7) % 12 + 12) % 12;
    const root = 60 + (tonicPc > 6 ? tonicPc - 12 : tonicPc);
    const steps = [0, 4, 7, 12].map((iv) => ({ midi: root + iv, startMs: 0, durationMs: 1400, volume: 70, isRest: false }));
    this.play(steps);
    this.setStatus(`${S.keyName(fifths)}.`);
  }

  /** The first sounding notes of every part, held together. */
  playOpening() {
    const first = new Map();
    S.allEvents(this.score).forEach((item) => {
      if (item.event.rest) return;
      const known = first.get(item.staffKey);
      if (!known || item.abs < known.abs) first.set(item.staffKey, item);
    });
    const steps = [];
    first.forEach((item) => item.event.pitches.forEach((p) => {
      steps.push({ midi: S.pitchMidi(p), startMs: 0, durationMs: 1400, volume: 74, isRest: false });
    }));
    this.play(steps);
    this.setStatus("The opening notes.");
  }
}
