"""
The small API the practice app uses.

Only two things cross the wire: "I finished a run" and "who am I / what have I
done so far".  The app itself stays usable signed out — it keeps its own
localStorage progress — so these endpoints are additive, never a precondition
for practising.
"""

from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import progress as progress_calc
from .models import PracticeSession
from .permissions import is_teacher


class PracticeSessionSerializer(serializers.ModelSerializer):
    class Meta:
        model = PracticeSession
        fields = (
            "id", "chapter_id", "chapter_key", "chapter_title", "score", "rounds",
            "system", "texture", "key_name", "formula", "created_at",
        )
        read_only_fields = ("id", "created_at")

    def validate_score(self, value):
        if not 0 <= value <= 100:
            raise serializers.ValidationError("Score must be between 0 and 100.")
        return value

    def validate_chapter_id(self, value):
        if not 1 <= value <= 10:
            raise serializers.ValidationError("Chapter must be between 1 and 10.")
        return value


class SessionCreateView(APIView):
    """Record one completed run for the signed-in user."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = PracticeSessionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # The user is taken from the session, never from the payload.
        session = serializer.save(user=request.user)
        return Response(
            PracticeSessionSerializer(session).data,
            status=status.HTTP_201_CREATED,
        )


class MeView(APIView):
    """
    Who is signed in, and (for students) their progress so far.

    Returns 200 with `authenticated: false` rather than 401 when signed out:
    the app asks this on boot to decide whether to sync, and a missing session
    is an expected state, not an error.
    """

    permission_classes = []

    def get(self, request):
        user = request.user
        if not user.is_authenticated:
            return Response({"authenticated": False})

        profile = user.profile
        data = {
            "authenticated": True,
            "username": user.username,
            "name": profile.name,
            "role": profile.role,
            "is_teacher": is_teacher(user),
            "dashboard_url": "/accounts/profile/",
        }
        if not profile.is_teacher:
            overview = progress_calc.overview(user)
            data["progress"] = {
                "total_sessions": overview["total_sessions"],
                "average_score": overview["average_score"],
                "best_score": overview["best_score"],
                "chapters_completed": overview["chapters_completed"],
                "streak_days": overview["streak_days"],
                "chapters": {
                    c["number"]: {
                        "best": c["best"],
                        "attempts": c["attempts"],
                        "completed": c["completed"],
                    }
                    for c in progress_calc.chapter_breakdown(user)
                    if c["attempts"]
                },
            }
        return Response(data)
