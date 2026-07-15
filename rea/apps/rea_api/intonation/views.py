"""
Cross-domain intonation views.

Two cross-domain endpoints support the frontend's hierarchical exercise
browser:

* :class:`ChapterListView` — top-level grouped counts (system × texture ×
  category) for the landing grid.
* :class:`FacetsView` — the distinct facet values (and per-value counts)
  available *within* a chosen system/texture/category, so the client can
  build the drill-down tree (inversions, interval names, qualities, parts,
  phases, keys, variants, …) dynamically from the data.

:class:`ExerciseListView` remains as a flat uniform list for ad-hoc use.
"""

from django.db.models import Count, Q
from rest_framework.response import Response
from rest_framework.reverse import reverse
from rest_framework.views import APIView

from .absolute.models import Lesson as AbsoluteLesson
from .relative.models import KeyModel, Lesson as RelativeLesson


def _relative_groups(texture=None):
    qs = RelativeLesson.objects.all()
    if texture:
        qs = qs.filter(texture=texture)
    qs = qs.values("texture", "category").annotate(n=Count("pk")).order_by("texture", "category")
    out = []
    for row in qs:
        out.append({
            "system": "relative",
            "texture": row["texture"],
            "category": row["category"] or "",
            "count": row["n"],
        })
    return out


def _absolute_groups(texture=None):
    qs = AbsoluteLesson.objects.all()
    if texture:
        qs = qs.filter(texture=texture)
    qs = qs.values("texture", "category").annotate(n=Count("pk")).order_by("texture", "category")
    out = []
    for row in qs:
        out.append({
            "system": "absolute",
            "texture": row["texture"],
            "category": row["category"] or "",
            "count": row["n"],
        })
    return out


class ChapterListView(APIView):
    """Top-level grouped summary (system × texture × category) with counts.

    Query params:

    ``system``   ``relative`` | ``absolute`` — omit for both.
    ``texture``  ``mono`` | ``poly`` — omit for both.
    """

    def get(self, request):
        system = request.query_params.get("system", "").lower()
        texture = request.query_params.get("texture", "").lower() or None
        results = []
        if system in ("", "relative"):
            results.extend(_relative_groups(texture))
        if system in ("", "absolute"):
            results.extend(_absolute_groups(texture))
        return Response({"count": len(results), "results": results})


# Pedagogical ordering for the absolute-poly facet values, mirroring the
# exercise outline.  Values not listed keep their natural string order as a
# fallback so nothing is dropped.
_INTERVAL_SIZE_ORDER = [
    "Seconds", "Thirds", "Fourths", "Fifths", "Sixths", "Sevenths", "Eights",
]
_INTERVAL_QUALITY_ORDER = ["Minor", "Major", "Perfect", "Augmented"]
_TRIAD_QUALITY_ORDER = ["Major", "Minor", "Diminished", "Augmented"]
_SEVENTH_QUALITY_ORDER = [
    "DominantSeventh", "MajorSeventh", "MinorSeventh", "MinorMajorSeventh",
    "HalfDiminishedSeventh", "DiminishedSeventh", "AugmentedSeventh",
]
_TRIAD_INVERSION_ORDER = ["53", "63", "64"]
_SEVENTH_INVERSION_ORDER = ["7", "65", "43", "2"]
_PHASE_ORDER = [1, 2]

_FACET_ORDER = {
    "interval_size": _INTERVAL_SIZE_ORDER,
    "quality_intervals": _INTERVAL_QUALITY_ORDER,
    "quality_triads": _TRIAD_QUALITY_ORDER,
    "quality_sevenths": _SEVENTH_QUALITY_ORDER,
    "inversion_triads": _TRIAD_INVERSION_ORDER,
    "inversion_sevenths": _SEVENTH_INVERSION_ORDER,
    "phase": _PHASE_ORDER,
}


def _facet_values(qs, field, order=None):
    """Return [{value, count}] for the distinct values of ``field`` in ``qs``,
    sorted.  When ``order`` is given (a list of preferred values), those come
    first in that order, followed by any remaining values in natural order.
    Empty-string/None values are omitted."""
    rows = qs.values(field).annotate(n=Count("pk"))
    by_val = {r[field]: r["n"] for r in rows}
    out = []
    if order:
        for v in order:
            if v in by_val and v not in ("", None):
                out.append({"value": v, "count": by_val.pop(v)})
    for v in sorted(by_val, key=lambda x: (str(x) == "", str(x))):
        if v in ("", None):
            continue
        out.append({"value": v, "count": by_val[v]})
    return out


class FacetsView(APIView):
    """Distinct facet values (with counts) within a system/texture/category.

    Required params:

    ``system``   ``relative`` | ``absolute``
    ``texture``  ``mono`` | ``poly``

    Optional params (narrow the facet query, and are echoed back):

    ``category``           relative+poly / absolute
    ``inversion``          poly chords
    ``interval_name``      relative poly intervals
    ``interval_size``      absolute poly intervals
    ``quality``            absolute poly chords/intervals
    ``part``               poly
    ``phase``              absolute poly
    ``variant``            relative poly
    ``key_model``          relative (key id)
    ``formula_name``       relative mono
    ``span`` / ``grades``  absolute mono

    ``results``            ``1`` (default) include the matching lesson summary
                           list; ``0`` omit it (only facets + count) for a
                           cheap facets-only call when the caller already has
                           the lesson list from the dedicated list endpoint.

    The response lists every facet that still has >1 distinct value under
    the current selection, so the client can render the next drill-down
    level.  ``results`` is the matching lesson summaries (id + display_name)
    so the client can show an exercise list once a selection is specific
    enough.
    """

    def get(self, request):
        system = request.query_params.get("system", "").lower()
        texture = request.query_params.get("texture", "").lower()
        if system not in ("relative", "absolute") or texture not in ("mono", "poly"):
            return Response({"detail": "system and texture are required"}, status=400)
        include_results = request.query_params.get("results", "1") not in ("0", "false")

        p = request.query_params
        echo = {k: p[k] for k in (
            "category", "inversion", "interval_name", "interval_size",
            "quality", "part", "phase", "variant", "key_model",
            "formula_name", "span", "grades",
        ) if p.get(k) not in (None, "")}

        if system == "relative":
            qs = RelativeLesson.objects.filter(texture=texture)
            if echo.get("category"):
                qs = qs.filter(category=echo["category"])
            if echo.get("inversion"):
                qs = qs.filter(inversion=echo["inversion"])
            if echo.get("interval_name"):
                qs = qs.filter(interval_name=echo["interval_name"])
            if echo.get("part"):
                qs = qs.filter(part=echo["part"])
            if echo.get("variant"):
                qs = qs.filter(variant=echo["variant"])
            if echo.get("key_model"):
                qs = qs.filter(key_model=echo["key_model"])
            if echo.get("formula_name"):
                qs = qs.filter(formula_name=echo["formula_name"])

            facets = {}
            if texture == "mono":
                facets["mode"] = _mode_facet(qs)
                facets["formula_name"] = _facet_values(qs, "formula_name")
                facets["variant"] = _facet_values(qs, "variant")
                facets["key_model"] = _key_facet(qs)
            else:
                # poly: which facets are relevant depends on category
                cat = echo.get("category", "")
                facets["category"] = _facet_values(qs, "category")
                if cat == "ChordsThirds" or cat == "ChordsSevenths":
                    facets["inversion"] = _facet_values(qs, "inversion")
                if cat == "Intervals":
                    facets["interval_name"] = _facet_values(qs, "interval_name")
                facets["part"] = _facet_values(qs, "part")
                facets["variant"] = _facet_values(qs, "variant")
                facets["key_model"] = _key_facet(qs)

            lessons = _relative_facet_results(qs) if include_results else []

        else:
            qs = AbsoluteLesson.objects.filter(texture=texture)
            if echo.get("category"):
                qs = qs.filter(category=echo["category"])
            if echo.get("inversion"):
                qs = qs.filter(inversion=echo["inversion"])
            if echo.get("interval_size"):
                qs = qs.filter(interval_size=echo["interval_size"])
            if echo.get("quality"):
                qs = qs.filter(quality=echo["quality"])
            if echo.get("part"):
                qs = qs.filter(part=echo["part"])
            if echo.get("phase"):
                qs = qs.filter(phase=echo["phase"])
            if echo.get("span"):
                qs = qs.filter(span=echo["span"])
            if echo.get("grades"):
                qs = qs.filter(grades=echo["grades"])

            facets = {}
            if texture == "mono":
                facets["category"] = _facet_values(qs, "category")
                facets["span"] = _facet_values(qs, "span")
                facets["grades"] = _facet_values(qs, "grades")
                facets["part"] = _facet_values(qs, "part")
            else:
                cat = echo.get("category", "")
                facets["category"] = _facet_values(qs, "category")
                if cat == "ChordsThirds":
                    facets["quality"] = _facet_values(qs, "quality", _TRIAD_QUALITY_ORDER)
                    facets["inversion"] = _facet_values(qs, "inversion", _TRIAD_INVERSION_ORDER)
                elif cat == "ChordsSevenths":
                    facets["quality"] = _facet_values(qs, "quality", _SEVENTH_QUALITY_ORDER)
                    facets["inversion"] = _facet_values(qs, "inversion", _SEVENTH_INVERSION_ORDER)
                elif cat == "Intervals":
                    facets["interval_size"] = _facet_values(qs, "interval_size", _INTERVAL_SIZE_ORDER)
                    facets["quality"] = _facet_values(qs, "quality", _INTERVAL_QUALITY_ORDER)
                facets["part"] = _facet_values(qs, "part")
                facets["phase"] = _facet_values(qs, "phase", _PHASE_ORDER)

            lessons = _absolute_facet_results(qs) if include_results else []

        return Response({
            "system": system, "texture": texture, "selection": echo,
            "facets": facets, "count": qs.count(), "results": lessons,
        })


def _key_facet(qs):
    """[{value: keyId, label: keyName, count}] for relative lessons."""
    rows = (
        qs.values("key_model", "key_model__name")
        .annotate(n=Count("pk"))
        .order_by("key_model__name")
    )
    return [
        {"value": r["key_model"], "label": r["key_model__name"], "count": r["n"]}
        for r in rows if r["key_model"]
    ]


def _mode_facet(qs):
    """[{value: 'Major', count}] derived from the related key's mode."""
    rows = (
        qs.values("key_model__mode").annotate(n=Count("pk"))
        .order_by("key_model__mode")
    )
    return [
        {"value": r["key_model__mode"], "count": r["n"]}
        for r in rows if r["key_model__mode"]
    ]


class ExerciseListView(APIView):
    """Flat uniform list of exercises from one or both systems.

    Query params:

    ``system``   ``relative`` | ``absolute`` — omit for both.
    ``texture``  ``mono`` | ``poly`` — omit for both.
    """

    def get(self, request):
        system = request.query_params.get("system", "").lower()
        texture = request.query_params.get("texture", "").lower()
        results = []

        if system in ("", "relative"):
            qs = RelativeLesson.objects.select_related("key_model").order_by(
                "key_model__name", "texture", "formula_name",
                "category", "inversion", "interval_name", "part", "variant",
            )
            if texture:
                qs = qs.filter(texture=texture)
            for lesson in qs:
                results.append({
                    "system": "relative",
                    "texture": lesson.texture,
                    "id": lesson.pk,
                    "name": lesson.display_name,
                    "key": lesson.key_model.name,
                    "formula_name": lesson.formula_name,
                    "category": lesson.category,
                    "inversion": lesson.inversion,
                    "interval_name": lesson.interval_name,
                    "part": lesson.part,
                    "variant": lesson.variant,
                    "url": reverse("lesson-detail", args=[lesson.pk], request=request),
                })

        if system in ("", "absolute"):
            qs = AbsoluteLesson.objects.order_by(
                "texture", "category", "span", "grades",
                "quality", "interval_size", "inversion",
                "part", "phase", "exercise_number",
            )
            if texture:
                qs = qs.filter(texture=texture)
            for lesson in qs:
                results.append({
                    "system": "absolute",
                    "texture": lesson.texture,
                    "id": lesson.pk,
                    "name": lesson.display_name,
                    "category": lesson.category,
                    "span": lesson.span,
                    "grades": lesson.grades,
                    "quality": lesson.quality,
                    "interval_size": lesson.interval_size,
                    "inversion": lesson.inversion,
                    "part": lesson.part,
                    "phase": lesson.phase,
                    "exercise_number": lesson.exercise_number,
                    "exercise_type": lesson.exercise_type,
                    "timed": lesson.timed,
                    "chromatic": lesson.chromatic,
                    "url": reverse("absolute-lesson-detail", args=[lesson.pk], request=request),
                })

        return Response({"count": len(results), "results": results})

# ---------------------------------------------------------------------------
# Facets result helpers — build the lesson summary list from .values() so the
# heavy ``raw`` column and nested bars/events are never loaded for the facets
# response (the frontend only needs scalar fields to filter / pick a lesson).
# ---------------------------------------------------------------------------

_REL_CATEGORY_LABELS = dict(RelativeLesson.PolyCategory.choices)


def _relative_facet_results(qs):
    """Lesson summary list for the relative FacetsView, built from .values()."""
    rows = qs.values(
        "id", "key_model__name", "texture", "formula_name",
        "category", "inversion", "interval_name", "part", "variant",
    ).order_by("key_model__name", "part", "variant")
    out = []
    for r in rows:
        cat = r["category"] or ""
        if r["texture"] == RelativeLesson.Texture.POLY:
            bits = [_REL_CATEGORY_LABELS.get(cat, cat)]
            if r["inversion"]:
                bits.append("-".join(r["inversion"]))
            if r["interval_name"]:
                bits.append(r["interval_name"])
            if r["part"]:
                bits.append(f"part {r['part']}")
            name = f"{r['key_model__name']} – " + " ".join(bits) + f" ({r['variant']})"
        else:
            name = f"{r['key_model__name']} – {r['formula_name']} {r['variant']}".strip()
        out.append({
            "id": r["id"], "name": name, "key": r["key_model__name"],
            "variant": r["variant"], "part": r["part"],
        })
    return out


def _absolute_facet_results(qs):
    """Lesson summary list for the absolute FacetsView, built from .values()."""
    rows = qs.values(
        "id", "category", "span", "grades", "quality", "interval_size",
        "inversion", "part", "phase", "exercise_number", "exercise_type",
        "timed",
    ).order_by("part", "phase", "exercise_number")
    out = []
    for r in rows:
        # display_name, reconstructed from scalars (mirrors the model property)
        bits = [r["category"]]
        if r["span"]:
            bits.append(r["span"])
        if r["grades"]:
            bits.append(r["grades"])
        if r["quality"]:
            bits.append(r["quality"])
        if r["interval_size"]:
            bits.append(r["interval_size"])
        if r["inversion"]:
            bits.append("-".join(r["inversion"]))
        if r["part"]:
            bits.append(f"part {r['part']}")
        if r["phase"]:
            bits.append(f"phase {r['phase']}")
        label = f"ex-{r['exercise_number']} {r['exercise_type'].replace('_', ' ')}"
        if r["timed"]:
            label += " (timed)"
        out.append({
            "id": r["id"], "name": " / ".join(bits) + f" – {label}",
            "category": r["category"], "quality": r["quality"],
            "interval_size": r["interval_size"], "inversion": r["inversion"],
            "phase": r["phase"], "part": r["part"],
            "exercise_number": r["exercise_number"],
            "exercise_type": r["exercise_type"], "timed": r["timed"],
        })
    return out
