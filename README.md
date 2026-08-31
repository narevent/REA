# REA — Intonation

A Django + Django REST Framework web application for **solfege / ear-training**
(intonation) practice. It trains two complementary systems:

- **Relative intonation** — scale-degree relationships within a key (major /
  minor). Scale templates (`key_models`), melodic formula lessons (`mono`),
  and harmonic lessons (`poly`: triads, seventh chords, intervals, tonal
  formula).
- **Absolute intonation** — absolute-pitch recognition against a chromatic
  base. Melodic pitch-formula lessons (`mono`: Formula / Formula-inverse across
  spans Quinta / Octave / Extended) and harmonic lessons (`poly`: intervals,
  triads, seventh chords, each in melodic-then-harmonic pedagogical phases).

A vanilla-JS frontend (ES modules + VexFlow for staff rendering + Web Audio for
playback and microphone pitch detection) is served by the same Django app.

> **The large exercise data (the `relative/` and `absolute/` JSON libraries and
> the SQLite database) is deliberately not in this repository.** It lives on the
> server in a persistent data directory and is symlinked into the checkout at
> deploy time. See [`scripts/README.md`](scripts/README.md) for the full
> deployment story.

---

## Repository layout

```
rea5/
├── rea/                          # the Django project
│   ├── config/                   # settings, urls, wsgi/asgi
│   ├── apps/
│   │   ├── rea_api/              # REST API (DRF)
│   │   │   ├── urls.py           # API root (/api/...)
│   │   │   ├── pagination.py     # LargePageSizePagination (cap 2000)
│   │   │   ├── editor/           # teacher-only WRITE API (/api/editor/...)
│   │   │   │   ├── score.py               # the score document: read/write a whole lesson
│   │   │   │   ├── serializers.py         # note tokens, durations, offsets, lesson meta
│   │   │   │   ├── views.py               # browse / blank / create / save / duplicate / delete
│   │   │   │   └── urls.py
│   │   │   ├── intonation/
│   │   │   │   ├── views.py      # cross-domain endpoints (chapters, facets, exercises)
│   │   │   │   ├── relative/     # the "relative" domain
│   │   │   │   │   ├── models.py          # ScaleModel(+Timing/Pitch), KeyModel, Lesson, Bar, MusicEvent
│   │   │   │   │   ├── serializers.py     # full + summary lesson serializers
│   │   │   │   │   ├── views.py           # ReadOnlyModelViewSets
│   │   │   │   │   ├── urls.py            # router (scale/key-models, lessons, bars, events)
│   │   │   │   │   ├── admin.py
│   │   │   │   │   ├── utils/note_parser.py        # German note-name parsing
│   │   │   │   │   ├── services/
│   │   │   │   │   │   ├── json_import.py         # raw-JSON normaliser
│   │   │   │   │   │   ├── key_generation.py      # key_models -> DB
│   │   │   │   │   │   ├── lesson_generation.py   # mono lessons -> DB + cross-key regen
│   │   │   │   │   │   └── poly_import.py         # poly (chord/interval) lessons -> DB
│   │   │   │   │   └── management/commands/
│   │   │   │   │       ├── import_key_model.py
│   │   │   │   │       └── import_formula.py
│   │   │   │   └── absolute/     # the "absolute" domain
│   │   │   │       ├── models.py          # ChromaticBase, Lesson, Bar, MusicEvent
│   │   │   │       ├── serializers.py
│   │   │   │       ├── views.py           # ReadOnlyModelViewSets
│   │   │   │       ├── urls.py            # router (chromatic-bases, lessons, bars, events)
│   │   │   │       ├── admin.py
│   │   │   │       ├── services/
│   │   │   │       │   ├── json_import.py
│   │   │   │       │   ├── base_generation.py     # Ap_12 chromatic base -> DB
│   │   │   │       │   └── lesson_generation.py   # mono + poly lessons -> DB
│   │   │   │       └── management/commands/
│   │   │   │           ├── import_absolute_base.py
│   │   │   │           └── import_absolute_lessons.py
│   │   └── rea_frontend/        # frontend layer
│   │       ├── views.py         # IndexView (practice app) + EditorView (teachers) + favicon
│   │       ├── urls.py
│   │       ├── templates/rea_frontend/{index,editor}.html
│   │       └── static/rea_frontend/
│   │           ├── css/{main,editor}.css
│   │           ├── js/                       # ES modules: app, api, audioPlayer,
│   │           │   ├── components/notationRenderer.js   #   pitchDetector, practiceController,
│   │           │   ├── views/{lesson,scale,soundcheck}View.js   #   practiceData/Score, soundPresets, ...
│   │           │   ├── editor/               # the score editor: editorApi, scoreDoc,
│   │           │   │                         #   scoreCanvas, inspector, library, editor
│   │           │   └── ...
│   │           └── vendor/vexflow/vexflow.min.js
│   ├── tests/                   # note_parser, services, frontend view tests
│   ├── manage.py
│   └── requirements.txt
├── scripts/                     # deployment & maintenance bash scripts (see scripts/README.md)
└── relative/  absolute/         # exercise data — git-ignored; symlinked in at deploy time
```

## Two intonation domains

### Relative (`rea.apps.rea_api.intonation.relative`)

Models three layers, mirroring the source JSON under `relative/`:

1. **Scale templates** — mode-agnostic recipes: `ScaleModel` +
   `ScaleModelTiming` (per-degree rhythm/quality) + `ScaleModelPitch`
   (per-degree interval from the tonic). Describe *how* a scale is built.
2. **Keys** — concrete instantiations of a template rooted on a pitch:
   `KeyModel` → `Bar` → `MusicEvent`. Populated from `key_models/`
   (Major/Minor, 30 keys).
3. **Lessons** — formula sequences built on a key: `Lesson` → `Bar` →
   `MusicEvent`. Populated from `lessons/`:
   - **mono** (melodic): single-voice formula lessons (Octave / Quinta /
     Extended), identified by `formula_name` + `variant`.
   - **poly** (harmonic): triads (`ChordsThirds`), seventh chords
     (`ChordsSevenths`, with figured-bass inversions), intervals
     (`Intervals`), and the tonal-trichord `Formula`. Identified by
     `category` + `inversion`/`interval_name` + `part` + `variant`.

### Absolute (`rea.apps.rea_api.intonation.absolute`)

Trains absolute pitch, so there are no keys — the hierarchy differs:

1. **Chromatic base** — the single reference model `Ap_12.json` enumerating
   the 12 chromatic pitches: `ChromaticBase` → `Bar` → `MusicEvent`.
2. **Lessons** — exercise files under `absolute/lessons/`:
   - **mono**: pitch-formula exercises (`Formula` / `FormulaInverse`) across
     spans `Quinta` / `Octave` / `Extended` (the latter split into
     `2Grades` / `3Grades`), progressive `part`s (1..4 and cumulative 1-2,
     1-3, 1-4), and an `exercise_number`/`exercise_type` (listening,
     singing, guessing — optionally timed / chromatic / multiple-answer).
   - **poly**: intervals / triads / seventh chords. Each `part` runs in two
     pedagogical `phase`s — phase 1 presents the material melodically,
     phase 2 harmonically (simultaneous sounding).

### Shared model pattern

In both domains a `Bar` is owned by **either** the reference model
(`KeyModel` / `ChromaticBase`) **or** a `Lesson` via two nullable foreign
keys — one `Bar` model serves both. `MusicEvent` stores the resolved
`pitch_class` (0–11, or -1 for rests) at import time for fast querying.

### Note-name conventions

Tokens use German letters (`h` = B-natural, `b` = flat *modifier*):

`<letter><octave?><modifier?>` where modifier ∈ `# b x r`
(`x` = double-sharp, `r` = naturalised/"raised" in flat minor keys). When
`is_enharmonic` is true the note inherits its alteration from the key
signature (`incdec`). See `rea/apps/rea_api/intonation/relative/utils/note_parser.py`.

## REST API

Base URL: `/api/`. Everything the practice app reads is read-only; the only
writers are the teacher-only editor endpoints under `/api/editor/`.

**Relative** (`/api/intonation/relative/`):
`scale-models`, `key-models`, `lessons`, `bars`, `events` — DRF
`ReadOnlyModelViewSet`s with `django-filter` backends (filter on `key_model`,
`texture`, `formula_name`, `category`, `inversion`, `interval_name`, `part`,
`variant`, …).

**Absolute** (`/api/intonation/absolute/`):
`chromatic-bases`, `lessons`, `bars`, `events` — same pattern (filter on
`texture`, `category`, `span`, `grades`, `quality`, `interval_size`,
`inversion`, `part`, `phase`, `exercise_number`, `exercise_type`, `timed`,
`chromatic`).

**Cross-domain** (`/api/intonation/`):
- `chapters/` — top-level grouped counts (`system` × `texture` × `category`)
  for the frontend landing grid.
- `facets/` — distinct facet values (+ counts) within a chosen
  `system`/`texture`/`category`, so the client builds the drill-down tree
  (inversions, interval names, qualities, parts, phases, keys, variants, …)
  dynamically. Accepts `results=0` for a cheap facets-only call.
- `exercises/` — flat uniform list across one or both systems.

**Editor** (`/api/editor/`, teachers only — `IsTeacher`):
- `options/` — every dropdown's contents, read from the library itself (keys,
  categories, spans, exercise types, clefs, rhythms, …).
- `browse/` — id + name + bar count for exercises matching the picker's
  facets and a free-text search (each word narrows, any field may match).
- `<system>/blank/` — a starting document with the importers' defaults.
- `<system>/scores/` — `POST` creates; `<system>/scores/<id>/` `GET`s,
  `PUT`s (replaces the whole score) and `DELETE`s;
  `<system>/scores/<id>/duplicate/` copies one under a free variant /
  exercise number.

The editor's unit of work is the **whole score** — lesson meta plus every bar
and event — rewritten in one transaction. Bar and event indices come from
document order, and `pitch_class` is recomputed server-side from the note
tokens and the lesson's key, so an unaltered `f` in G major is stored as F♯
whatever the browser believed.

List endpoints use a **summary serializer** (scalar fields only — no nested
bars/events, no `raw` blob) so category fetches stay small; the **detail**
(retrieve) endpoint returns the full lesson with nested bars/events. List
responses use `LargePageSizePagination` (client `page_size`, capped at 2000)
so the frontend's combination-category fetch needs few round-trips.

## Getting started (local dev)

You need the exercise data present on disk. For local development, keep
`relative/` and `absolute/` as siblings of the `rea/` project (matching the
project layout) — they are git-ignored and not shipped with the repo.

```bash
cd rea
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python manage.py migrate
python manage.py import_key_model          # relative/key_models   (30 keys)
python manage.py import_formula            # relative/lessons      (mono + poly)
python manage.py import_absolute_base      # absolute/key_models/Base/Ap_12.json
python manage.py import_absolute_lessons   # absolute/lessons      (mono + poly)

python manage.py runserver
```

Open http://127.0.0.1:8000/ for the frontend, http://127.0.0.1:8000/api/
for the browsable API.

### Cross-key regeneration (relative mono)

A formula is stored as a key-independent **degree recipe** (the
`alias`/`alias_degree` labels). Regenerate a lesson in every other key of the
same mode:

```bash
python manage.py import_formula --generate-all-keys
```

or programmatically:

```python
from rea.apps.rea_api.intonation.relative.services.lesson_generation import (
    generate_lesson_for_key,
)
generate_lesson_for_key(source_lesson, target_key_model)
```

## Tests

```bash
python manage.py test rea.tests
```

Covers the German note parser, the relative import services, the frontend
index view, accounts (roles, auth pages, progress) and the editor API — who
may write, what a saved score keeps, and what an invalid one is refused for.

Two suites are browser JavaScript and run under Node instead:

```bash
node rea/tests/audio/run.mjs
node rea/tests/editor/midi.mjs
```

The first covers the singing exercises' audio path (pitch tracking and note
segmentation, sung by a synthesiser); the second covers the score editor's
MIDI import — the pitch spellings it chooses, and what it does with chords,
gaps, performed note lengths and barlines.

## Frontend

Vanilla JS (ES modules) + [VexFlow](https://github.com/0xfe/vexflow) for staff
rendering, Web Audio for playback, and microphone-based pitch detection. The
real VexFlow build lives at
`rea/apps/rea_frontend/static/rea_frontend/vendor/vexflow/vexflow.min.js`.

**One score is drawn one way.** `js/components/staveLayout.js` owns the
measuring, the row wrapping, the accidental carry rules and the drawing;
`notationRenderer` (practice) and `editor/scoreCanvas` (editor) each add only
their own interaction layer on top, so the two views are pixel-identical.

What is drawn is deliberately spare: five lines, barlines and noteheads. No
clef, no time signature, no key signature, and no stems, flags or beams — the
last three hidden by one rule on the `svg.rea-score` class every score
carries. These are intonation exercises, so the eye belongs on where the note
sits. Rhythm is still real in playback and editable in the editor's
inspector; it is simply not notated. With no key signature drawn, a notehead
carries only the accidental in its own token — a written `f` in G major shows
plain but still *sounds* F♯ (the pitch is resolved from the key server-side,
and the editor's inspector names the sounding pitch).

Two pages share that stack:

- **`/`** — the practice app (chapter map, lessons, singing).
- **`/editor/`** — the **score editor**, for teachers only. Library on the
  left, an editable stave in the middle, property panels on the right. Notes
  are written by clicking empty staff at the pitch you want, dragged
  vertically to re-pitch, `Alt`-dragged sideways to change **when they sound**
  and `Alt`+`Shift`-dragged sideways to change **where they are drawn**; the
  keyboard can do all of it (press `?` or *Shortcuts* for the sheet). Notes can
  also arrive wholesale from a MIDI file (*Import MIDI…*), which replaces the
  bars and leaves the exercise's identity alone. Every property the data model
  carries is editable — degree alias, both offsets, attack/decay, volume,
  rests, key-signature notes, pickup bars, bar labels and the exercise's own
  identity — and the transport previews the result with the same synth and
  timing rules the students hear.

  The two offsets are separate fields and answer separate questions.
  `horizontal_offset_ms` moves the moment a note *sounds* and changes nothing
  on the page — it is how an anticipated or delayed note is written. Stored in
  the source library's own units, one of which is 12 ms of playback; the editor
  shows and edits it in milliseconds. `visual_offset_px` moves where the
  notehead is *drawn* and changes nothing about the sound — it is for spacing
  that reads badly. It is capped at just under one notehead's width, applies in
  the practice view as well as the editor (so a student sees the picture the
  teacher approved), and the editor marks a nudged note with a tick at the
  position it would otherwise have had.

## Deployment

Deployment, updates, backups and restore are handled by the bash scripts in
[`scripts/`](scripts/) — see [`scripts/README.md`](scripts/README.md) for the
full guide. In short, from your local machine:

```bash
bash scripts/bootstrap_local.sh \
    --host root@your-vps-ip \
    --domain rea.example.com \
    --repo https://github.com/narevent/REA.git
```

The app runs under Gunicorn behind Nginx as a systemd service on Debian 13.
The exercise data and database are kept in a persistent on-server directory
(`/opt/rea-data`) and symlinked into the checkout, so `git pull` / updates
never touch them.

## Tech stack

- Django 5.1, Django REST Framework, django-filter, django-cors-headers
- SQLite (single-file DB; suitable for this read-heavy app)
- Vanilla JS ES modules + VexFlow + Web Audio API
- Gunicorn + Nginx + systemd on Debian 13