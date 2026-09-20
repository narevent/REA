"""
Models that belong to no single intonation system.

There is one so far: a named set of the layout and pacing settings every
exercise carries — a *style*.  It lives here rather than in ``relative`` or
``absolute`` because a house style is the whole point: the same look, applied
to both systems, so a student does not meet two different-looking methods.
"""

from __future__ import annotations

from django.db import models

from .intonation.style import STYLE_FIELDS, StyledScore


class ScoreStyle(StyledScore):
    """A named appearance a teacher can apply to an exercise.

    Applying a style *copies* its values onto the exercise; nothing stays
    linked.  That is deliberate.  A linked style would mean editing the house
    style silently re-laid-out every exercise in the library — including the
    hundreds a teacher has already checked and the one a student is halfway
    through — and it would mean an exercise whose appearance cannot be
    answered from the exercise itself.  A copy makes a style what a teacher
    actually wants it to be: a way of not setting twelve fields by hand, and a
    starting point rather than a remote control.
    """

    name = models.CharField(max_length=64, unique=True)
    description = models.CharField(max_length=255, default="", blank=True)
    is_default = models.BooleanField(
        default=False,
        help_text="The house style: what a new exercise starts from.",
    )

    class Meta:
        app_label = "rea_api"
        ordering = ("-is_default", "name")

    def __str__(self) -> str:
        return f"{self.name}{' (house style)' if self.is_default else ''}"

    def save(self, *args, **kwargs):
        # One house style, always.  Enforced here rather than by a constraint
        # because the useful behaviour is "this one is now the house style",
        # not "that is not allowed".
        super().save(*args, **kwargs)
        if self.is_default:
            type(self).objects.exclude(pk=self.pk).filter(is_default=True).update(
                is_default=False
            )

    @classmethod
    def house(cls):
        """The house style, or None before one has been made."""
        return cls.objects.filter(is_default=True).first()

    def values(self) -> dict:
        """The style as a plain dict of the fields it sets."""
        return {field: getattr(self, field) for field in STYLE_FIELDS}

    def apply_to(self, lesson, save: bool = True):
        """Copy this style's settings onto *lesson*."""
        for field, value in self.values().items():
            setattr(lesson, field, value)
        if save:
            lesson.save(update_fields=list(STYLE_FIELDS))
        return lesson
