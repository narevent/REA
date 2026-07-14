"""
Cross-domain intonation views.

The exercise list exposes lessons from both intonation systems —
*relative* (solfege / scale-degree) and *absolute* (absolute pitch) —
in one uniform list so clients can offer a single exercise picker with a
relative/absolute option.
"""

from rest_framework.response import Response
from rest_framework.reverse import reverse
from rest_framework.views import APIView

from .absolute.models import Lesson as AbsoluteLesson
from .relative.models import Lesson as RelativeLesson


class ExerciseListView(APIView):
    """List exercises from both systems.

    Query params:

    ``system``  ``relative`` | ``absolute`` — omit for both.
    """

    def get(self, request):
        system = request.query_params.get("system", "").lower()
        results = []

        if system in ("", "relative"):
            qs = RelativeLesson.objects.select_related("key_model").order_by(
                "key_model__name", "formula_name", "variant"
            )
            for lesson in qs:
                results.append({
                    "system": "relative",
                    "id": lesson.pk,
                    "name": f"{lesson.key_model.name} – {lesson.formula_name} {lesson.variant}".strip(),
                    "key": lesson.key_model.name,
                    "formula_name": lesson.formula_name,
                    "variant": lesson.variant,
                    "url": reverse("lesson-detail", args=[lesson.pk], request=request),
                })

        if system in ("", "absolute"):
            qs = AbsoluteLesson.objects.order_by(
                "category", "span", "grades", "part", "exercise_number"
            )
            for lesson in qs:
                results.append({
                    "system": "absolute",
                    "id": lesson.pk,
                    "name": lesson.display_name,
                    "category": lesson.category,
                    "span": lesson.span,
                    "grades": lesson.grades,
                    "part": lesson.part,
                    "exercise_number": lesson.exercise_number,
                    "exercise_type": lesson.exercise_type,
                    "timed": lesson.timed,
                    "chromatic": lesson.chromatic,
                    "url": reverse("absolute-lesson-detail", args=[lesson.pk], request=request),
                })

        return Response({"count": len(results), "results": results})
