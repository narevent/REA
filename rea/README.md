# REA — Relative Intonation (Django app)

A Django + Django REST Framework application that models **relative intonation**
exercises: scale templates (`key_models`) and formula exercises (`exercises`)
imported from the JSON files in `../relative/`.

## Layout

```
rea/
├── config/                         # Django project settings
├── apps/
│   ├── rea_api/                    # API layer (DRF)
│   │   ├── urls.py                 # API root router (/api/...)
│   │   └── intonation/relative/    # the "relative" domain
│   │       ├── models.py           # ScaleModel, KeyModel, Bar, MusicEvent, Exercise
│   │       ├── serializers.py
│   │       ├── views.py            # ReadOnlyModelViewSets
│   │       ├── urls.py
│   │       ├── admin.py
│   │       ├── utils/note_parser.py        # German note-name parsing
│   │       ├── services/
│   │       │   ├── json_import.py         # raw-JSON normaliser
│   │       │   ├── key_generation.py      # key_models -> DB
│   │       │   └── exercise_generation.py # exercises -> DB + cross-key regen
│   │       └── management/commands/
│   │           ├── import_key_model.py
│   │           └── import_formula.py
│   └── rea_frontend/              # frontend layer
│       ├── views.py               # serves index.html
│       ├── templates/rea_frontend/index.html
│       └── static/rea_frontend/{css,js,vendor}
├── tests/
└── manage.py
```

## Data model

See `apps/rea_api/intonation/relative/models.py`. The schema follows the brief
(`scale_model`, `scale_model_timing`, `scale_model_pitch`, `key_model`,
`bar`, `music_event`, `exercise`) with these refinements:

- `Bar` is owned by **either** a `KeyModel` (scale template) **or** an
  `Exercise` (formula), via two nullable FKs — one model serves both.
- `MusicEvent` stores the resolved `pitch_class` (0–11) at import time for
  fast querying.
- `KeyModel.key_signature` is a normalised JSON list
  (`[{"name": "f2#", "letter": "f", "offset": 1}, ...]`).

### Note-name conventions

Tokens use German letters (`h` = B-natural, `b` = flat *modifier*):

`<letter><octave?><modifier?>` where modifier ∈ `# b x r`
(`x` = double-sharp, `r` = naturalised/"raised" in flat minor keys). When
`is_enharmonic` is true the note inherits its alteration from the key
signature (`incdec`). See `utils/note_parser.py`.

## Getting started

```bash
cd rea
python manage.py migrate
python manage.py import_key_model      # imports ../relative/key_models  (30 keys)
python manage.py import_formula        # imports ../relative/exercises   (720 exercises)
python manage.py runserver
```

Open http://127.0.0.1:8000/ for the frontend, http://127.0.0.1:8000/api/ for
the browsable API.

### Cross-key regeneration

A formula is stored as a key-independent **degree recipe** (the `alias` /
`alias_degree` labels). Regenerate an exercise in every other key of the same
mode:

```bash
python manage.py import_formula --generate-all-keys
```

or programmatically:

```python
from rea.apps.rea_api.intonation.relative.services.exercise_generation import (
    generate_exercise_for_key,
)
generate_exercise_for_key(source_exercise, target_key_model)
```

## Tests

```bash
python manage.py test rea.tests
```

## Frontend

Vanilla JS (ES modules) + VexFlow for staff rendering. Drop the real VexFlow
build into `apps/rea_frontend/static/rea_frontend/vendor/vexflow/vexflow.min.js`
to enable notation; without it the panel shows an informative placeholder.