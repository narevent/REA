"""
Role checks for the exercise editor.

The score editor page (`rea_frontend.views.EditorView`) and every endpoint
under `/api/editor/` are gated on these, so a student who finds the URL is
refused at the page *and* at each request the page would make.
"""

from django.contrib.auth.decorators import user_passes_test
from django.core.exceptions import PermissionDenied
from rest_framework import permissions

from .models import Role


def user_role(user):
    """A user's role, or None when anonymous / profile-less."""
    if not user or not user.is_authenticated:
        return None
    profile = getattr(user, "profile", None)
    return profile.role if profile else None


def is_teacher(user):
    """Staff count as teachers so an admin is never locked out of authoring."""
    if not user or not user.is_authenticated:
        return False
    return user.is_staff or user_role(user) == Role.TEACHER


def is_student(user):
    return user_role(user) == Role.STUDENT


def teacher_required(view_func):
    """Django view decorator: signed in *and* a teacher."""
    return user_passes_test(is_teacher)(view_func)


class IsTeacher(permissions.BasePermission):
    """DRF permission for the exercise-editing endpoints."""

    message = "Only teachers can edit exercises."

    def has_permission(self, request, view):
        return is_teacher(request.user)


class IsTeacherOrReadOnly(permissions.BasePermission):
    """Anyone may read exercises; only teachers may change them."""

    message = "Only teachers can edit exercises."

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return is_teacher(request.user)


def require_teacher(user):
    """Imperative form, for use inside a view body."""
    if not is_teacher(user):
        raise PermissionDenied("Only teachers can edit exercises.")
