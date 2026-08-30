"""
The editing endpoints behind the score editor.

Everything here is teacher-only (:class:`IsTeacher`), and everything here
writes — the practice app keeps reading through the existing read-only
viewsets, so a bug in the editor can never slow down or reshape what students
see.  The unit of work is the whole score (see :mod:`.score`): fetch a
document, send it back, and the server rewrites that lesson's bars and events
inside one transaction.

Two things are deliberately *not* left to the client:

* **pitch classes** are recomputed from the note tokens and the lesson's key
  on every save, so an F in G major sounds F♯ whether or not the editor
  remembered to say so;
* **indices** are assigned from list order, so reordering notes or bars in the
  editor needs no index bookkeeping in the browser.

Validation is the serializer's alone.  ``Model.full_clean`` would also refuse
every blank identity field — a melodic lesson with no inversion, a harmonic one
with no span — which is how most of the imported library is actually shaped,
so the models' own ``default=""`` is taken at its word.
"""

from __future__ import annotations

from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from ...accounts.permissions import IsTeacher
from ..intonation.absolute.models import (
    Bar as AbsoluteBar,
    ChromaticBase,
    Lesson as AbsoluteLesson,
)
from ..intonation.relative.models import (
    Bar as RelativeBar,
    KeyModel,
    Lesson as RelativeLesson,
    ScaleModel,
)
from . import score
from .serializers import NOTE_TOKEN_HELP, ScoreDocumentSerializer

LESSON_MODELS = {"relative": RelativeLesson, "absolute": AbsoluteLesson}

# How many exercises the browser list returns.  The library holds ~12 000
# lessons across both systems; a teacher finds one by narrowing, not by
# scrolling, so a generous cap keeps the response small without ever being
# the reason a lesson cannot be found.
BROWSE_LIMIT = 300


def lesson_model(system):
    return LESSON_MODELS[system]


def _narrow(qs, search, fields):
    """Filter *qs* by a free-text search across *fields*.

    Each word narrows further, and may match any of the fields.  A teacher
    hunting for "G-dur octave ABC" is naming three different columns in one
    breath; matching the whole phrase against each column on its own would
    find nothing, which reads as "that exercise does not exist".
    """
    for term in (search or "").split():
        clause = Q()
        for field in fields:
            clause |= Q(**{f"{field}__icontains": term})
        qs = qs.filter(clause)
    return qs


class EditorView(APIView):
    """Shared teacher gate + system validation."""

    permission_classes = [IsTeacher]

    def resolve_system(self, system):
        if system not in score.SYSTEMS:
            return None
        return system


class OptionsView(EditorView):
    """Every choice the editor's inspector offers, straight from the data.

    The editor could hard-code these lists, and they would drift the first
    time a lesson is imported with a new exercise type.  Sending the real
    distinct values (plus the model's own choice lists) means a teacher's
    dropdowns always describe the library as it actually is.
    """

    def get(self, request):
        keys = [
            {
                "id": k.pk, "name": k.name, "mode": k.mode,
                "key_signature": k.key_signature,
                "mode_chord": score.mode_chord_for_key(k),
                "tempo": k.tempo,
            }
            for k in KeyModel.objects.order_by("name")
        ]
        bases = [
            {"id": b.pk, "name": b.name, "tempo": b.tempo}
            for b in ChromaticBase.objects.order_by("name")
        ]

        def distinct(model, field):
            return [
                v for v in model.objects.values_list(field, flat=True).distinct().order_by(field)
                if v not in ("", None)
            ]

        return Response({
            "systems": list(score.SYSTEMS),
            "durations": [
                {"value": 1.0, "label": "Whole"},
                {"value": 0.5, "label": "Half"},
                {"value": 0.25, "label": "Quarter"},
                {"value": 0.125, "label": "Eighth"},
                {"value": 0.0625, "label": "Sixteenth"},
                {"value": 0.03125, "label": "Thirty-second"},
            ],
            "note_token_help": NOTE_TOKEN_HELP,
            "keys": keys,
            "bases": bases,
            "modes": [{"value": v, "label": l} for v, l in ScaleModel.Mode.choices],
            "relative": {
                "textures": [{"value": v, "label": l} for v, l in RelativeLesson.Texture.choices],
                "categories": [{"value": v, "label": l} for v, l in RelativeLesson.PolyCategory.choices],
                "formula_names": distinct(RelativeLesson, "formula_name"),
                "interval_names": distinct(RelativeLesson, "interval_name"),
                "inversions": distinct(RelativeLesson, "inversion"),
                "parts": distinct(RelativeLesson, "part"),
                "variants": distinct(RelativeLesson, "variant"),
            },
            "absolute": {
                "textures": [{"value": v, "label": l} for v, l in AbsoluteLesson.Texture.choices],
                "categories": [{"value": v, "label": l} for v, l in AbsoluteLesson.Category.choices],
                "spans": [{"value": v, "label": l} for v, l in AbsoluteLesson.Span.choices],
                "grades": distinct(AbsoluteLesson, "grades"),
                "qualities": distinct(AbsoluteLesson, "quality"),
                "interval_sizes": distinct(AbsoluteLesson, "interval_size"),
                "inversions": distinct(AbsoluteLesson, "inversion"),
                "parts": distinct(AbsoluteLesson, "part"),
                "exercise_types": distinct(AbsoluteLesson, "exercise_type"),
            },
            "clefs": sorted(set(
                distinct(RelativeBar, "music_clef") + distinct(AbsoluteBar, "music_clef")
            )),
            "rhythms": sorted(set(
                distinct(RelativeBar, "music_rhythm") + distinct(AbsoluteBar, "music_rhythm")
            )),
            "mode_chords": distinct(RelativeBar, "music_mode_chord"),
        })


class BrowseView(EditorView):
    """The exercise picker: which lessons exist, narrowed by the usual facets.

    Deliberately thin — it returns ids and names, never bars.  A teacher opens
    one exercise at a time, and loading the notes of three hundred lessons to
    show a list of their titles is the mistake the practice API already learnt
    from (see ``LessonSummarySerializer``).
    """

    def get(self, request):
        system = self.resolve_system(request.query_params.get("system", "relative"))
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        p = request.query_params
        qs = lesson_model(system).objects.all()

        if system == "relative":
            qs = qs.select_related("key_model")
            for param, field in (
                ("texture", "texture"), ("key_model", "key_model"),
                ("category", "category"), ("formula_name", "formula_name"),
                ("part", "part"), ("variant", "variant"),
                ("interval_name", "interval_name"), ("inversion", "inversion"),
            ):
                if p.get(param):
                    qs = qs.filter(**{field: p[param]})
            qs = _narrow(qs, p.get("search", ""), (
                "formula_name", "variant", "category", "key_model__name",
            ))
            qs = qs.order_by("key_model__name", "texture", "formula_name", "category", "part", "variant")
        else:
            for param, field in (
                ("texture", "texture"), ("category", "category"), ("span", "span"),
                ("grades", "grades"), ("quality", "quality"),
                ("interval_size", "interval_size"), ("inversion", "inversion"),
                ("part", "part"), ("phase", "phase"),
                ("exercise_type", "exercise_type"),
            ):
                if p.get(param):
                    qs = qs.filter(**{field: p[param]})
            qs = _narrow(qs, p.get("search", ""), (
                "category", "exercise_type", "span", "quality", "interval_size",
            ))
            qs = qs.order_by(
                "texture", "category", "span", "grades", "quality",
                "interval_size", "inversion", "part", "phase", "exercise_number",
            )

        total = qs.count()
        rows = [
            {
                "id": lesson.pk,
                "system": system,
                "name": lesson.display_name,
                "texture": lesson.texture,
                "bars": lesson.bar_count,
            }
            for lesson in qs.annotate(bar_count=Count("bars"))[:BROWSE_LIMIT]
        ]
        return Response({"count": total, "shown": len(rows), "results": rows})


class ScoreDetailView(EditorView):
    """Read, replace or delete one exercise."""

    def get_lesson(self, system, pk):
        qs = lesson_model(system).objects.all()
        if system == "relative":
            qs = qs.select_related("key_model")
        return get_object_or_404(qs, pk=pk)

    def get(self, request, system, pk):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        return Response(score.lesson_document(self.get_lesson(system, pk), system))

    def put(self, request, system, pk):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        lesson = self.get_lesson(system, pk)
        serializer = ScoreDocumentSerializer(data=request.data, system=system)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        try:
            with transaction.atomic():
                for field, value in data["meta"].items():
                    setattr(lesson, field, value)
                if system == "relative" and data.get("key_model"):
                    lesson.key_model = data["key_model"]
                lesson.save()
                score.write_bars(lesson, system, data["bars"])
        except IntegrityError:
            return Response(
                {"detail": _duplicate_message(system)},
                status=status.HTTP_409_CONFLICT,
            )
        lesson.refresh_from_db()
        return Response(score.lesson_document(lesson, system))

    def delete(self, request, system, pk):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        lesson = self.get_lesson(system, pk)
        name = lesson.display_name
        lesson.delete()
        return Response({"deleted": True, "name": name})


class ScoreCreateView(EditorView):
    """Create a new exercise from a document."""

    def post(self, request, system):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        serializer = ScoreDocumentSerializer(data=request.data, system=system)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        kwargs = dict(data["meta"])
        if system == "relative":
            key_model = data.get("key_model")
            if not key_model:
                return Response(
                    {"key_model": ["A relative exercise has to be built on a key."]},
                    status=400,
                )
            kwargs["key_model"] = key_model
        else:
            base = ChromaticBase.objects.order_by("pk").first()
            if not base:
                return Response(
                    {"detail": "No chromatic base is imported — absolute exercises need one."},
                    status=400,
                )
            kwargs["base"] = base

        try:
            with transaction.atomic():
                lesson = lesson_model(system)(**kwargs)
                lesson.save()
                score.write_bars(lesson, system, data["bars"])
        except IntegrityError:
            return Response(
                {"detail": _duplicate_message(system)},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            score.lesson_document(lesson, system), status=status.HTTP_201_CREATED
        )


class ScoreDuplicateView(EditorView):
    """Copy an exercise, so a teacher can write a variant of a real lesson
    instead of starting from an empty stave.

    The copy lands with ``variant`` / ``exercise_number`` shifted just enough
    to clear the uniqueness constraint, because the alternative — refusing
    until the teacher renames something they have not seen yet — makes the
    feature useless exactly when it is most wanted.
    """

    def post(self, request, system, pk):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        model = lesson_model(system)
        source = get_object_or_404(model.objects.all(), pk=pk)
        document = score.lesson_document(source, system)

        with transaction.atomic():
            copy = model.objects.get(pk=pk)
            copy.pk = None
            copy._state.adding = True
            if system == "relative":
                copy.variant = _free_variant(model, source)
            else:
                copy.exercise_number = _free_exercise_number(model, source)
            copy.source_file = ""
            copy.save()
            score.write_bars(copy, system, document["bars"])
        return Response(
            score.lesson_document(copy, system), status=status.HTTP_201_CREATED
        )


def _free_variant(model, source):
    """A ``variant`` string not yet used by a sibling of *source*."""
    siblings = model.objects.filter(
        key_model=source.key_model, texture=source.texture,
        formula_name=source.formula_name, category=source.category,
        inversion=source.inversion, interval_name=source.interval_name,
        part=source.part,
    ).values_list("variant", flat=True)
    taken = set(siblings)
    base = source.variant or "copy"
    for n in range(2, 200):
        candidate = f"{base}-{n}"
        if candidate not in taken:
            return candidate
    return f"{base}-{len(taken) + 1}"


def _free_exercise_number(model, source):
    """The next free ``exercise_number`` within an absolute lesson's family."""
    used = set(model.objects.filter(
        texture=source.texture, category=source.category, span=source.span,
        grades=source.grades, quality=source.quality,
        interval_size=source.interval_size, inversion=source.inversion,
        part=source.part, phase=source.phase,
    ).values_list("exercise_number", flat=True))
    n = 1
    while n in used:
        n += 1
    return n


def _duplicate_message(system):
    if system == "relative":
        return (
            "Another exercise already uses this key, texture, formula, "
            "category, inversion, interval, part and variant — change one of "
            "them (the variant is usually the one meant to differ)."
        )
    return (
        "Another exercise already uses this category, span, grades, quality, "
        "interval, inversion, part, phase and exercise number — give this one "
        "a different exercise number."
    )


class BlankScoreView(EditorView):
    """The starting document for a new exercise.

    Built server-side so a new score already carries the defaults the
    importers use (clef, rhythm, tempo, and — for a relative exercise — the
    key's own ``music_mode_chord``, without which the stave would draw no key
    signature at all).
    """

    def get(self, request, system):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)

        if system == "relative":
            key_id = request.query_params.get("key_model")
            key = (
                KeyModel.objects.filter(pk=key_id).first() if key_id
                else KeyModel.objects.order_by("name").first()
            )
            if not key:
                return Response({"detail": "No key models are imported."}, status=400)
            mode_chord = score.mode_chord_for_key(key)
            document = {
                "system": system, "id": None, "display_name": "New exercise",
                "key_model": key.pk, "key_model_name": key.name,
                "key_signature": key.key_signature, "mode": key.mode,
                "meta": {
                    "texture": "mono", "formula_name": "", "category": "",
                    "inversion": "", "interval_name": "", "part": "",
                    "variant": "", "source_file": "", "tempo": 86,
                    "draw_only_note_heads": False, "default_rhythm": "FreeStyle",
                    "mid_bar_time": 0.1,
                },
                "bars": [score.blank_bar(system, mode_chord)],
            }
        else:
            base = ChromaticBase.objects.order_by("pk").first()
            if not base:
                return Response({"detail": "No chromatic base is imported."}, status=400)
            document = {
                "system": system, "id": None, "display_name": "New exercise",
                "base": base.pk, "key_signature": [],
                "meta": {
                    "texture": "mono", "category": "Formula", "span": "Quinta",
                    "grades": "", "quality": "", "interval_size": "",
                    "inversion": "", "part": "", "phase": 0,
                    "exercise_number": 1, "exercise_type": "listening_model",
                    "timed": False, "chromatic": False, "source_file": "",
                    "tempo": 86, "draw_only_note_heads": False,
                    "default_rhythm": "FreeStyle", "mid_bar_time": 0.1,
                },
                "bars": [score.blank_bar(system, "C_Major")],
            }
        return Response(document)


class PreviewPitchView(EditorView):
    """Resolve a note token to the pitch it will actually sound.

    The editor needs this the moment a teacher types a bare ``f`` into a sharp
    key: what they hear on preview must be what the lesson will store, and the
    key-signature rule that decides it lives in the Python note parser.
    """

    def get(self, request, system):
        system = self.resolve_system(system)
        if not system:
            return Response({"detail": "Unknown system."}, status=400)
        token = request.query_params.get("note", "")
        key_id = request.query_params.get("key_model")
        key_signature = []
        if system == "relative" and key_id:
            key = KeyModel.objects.filter(pk=key_id).first()
            key_signature = key.key_signature if key else []
        return Response({
            "note": token,
            "pitch_class": score.resolve_event_pitch_class(token, False, key_signature),
        })


# Re-exported so the URLconf reads as a list of endpoints, not of imports.
__all__ = [
    "OptionsView", "BrowseView", "ScoreDetailView", "ScoreCreateView",
    "ScoreDuplicateView", "BlankScoreView", "PreviewPitchView",
]
