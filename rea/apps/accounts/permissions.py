"""
Role checks for the exercise editor.

The score editor page (`rea_frontend.views.EditorView`) and every endpoint
under `/api/editor/` are gated on these, so a student who finds the URL is
refused at the page *and* at each request the page would make.

Two gates, not one.  `is_teacher` answers "may this person author at all",
and opens the editor.  `is_admin` answers "may this person change the method
everybody is taught from", and guards the curriculum: saving into it,
replacing one of its exercises, deleting one, and setting the house style.
A teacher who is not an admin writes dictations and drafts — their own
material, which nobody else is practising — and that is the difference the
two roles are for.
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
    """May author at all: a teacher, an administrator, or Django staff."""
    if not user or not user.is_authenticated:
        return False
    return user.is_staff or user_role(user) in (Role.TEACHER, Role.ADMIN)


def is_admin(user):
    """May change the curriculum itself.

    Django staff count, so the person who can edit these rows in the admin
    site is never refused by the app in front of them.
    """
    if not user or not user.is_authenticated:
        return False
    return user.is_staff or user_role(user) == Role.ADMIN


#: The shelves a teacher who is not an administrator may write to — their own
#: material.  Everything else is the curriculum.
TEACHER_SHELVES = ("draft", "dictation")


def may_write_shelf(user, shelf):
    """Whether *user* may create or replace an exercise on *shelf*."""
    if is_admin(user):
        return True
    return is_teacher(user) and (shelf or "") in TEACHER_SHELVES


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


class IsAdmin(permissions.BasePermission):
    """DRF permission for the parts of the editor that own the curriculum."""

    message = "Only administrators can change the curriculum."

    def has_permission(self, request, view):
        return is_admin(request.user)


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


def require_shelf(user, shelf):
    """Refuse a write onto a shelf this user does not own.

    The message names the way out — save it as a dictation or a draft —
    because a teacher meeting this has not done anything wrong; they have
    reached for the one thing their role does not cover.
    """
    if may_write_shelf(user, shelf):
        return
    raise PermissionDenied(
        "Only administrators can save into the curriculum. "
        "Save this as a dictation or leave it in your drafts."
    )
