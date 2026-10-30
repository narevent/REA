"""
Dictations: whole scores a teacher writes, and the phrases they are dictated in.

An intonation exercise is a row of bars, each of them something to sing.  A
dictation is a different kind of thing — a piece of music, often for more
than one instrument, with ties across barlines, repeats, dynamics — and the
student's task is not to sing a bar but to write down a phrase after hearing
it.  So it is kept apart: one document holding the full score, written in the
dictation editor, and a list of phrases cut from it.

The score is stored as a single JSON document rather than as rows.  A score
editor edits the whole thing at once (inserting a measure renumbers every
measure after it, in every part), the document is read and written whole,
and nothing queries inside it — so rows would buy only a diff negotiation
between the editor and the database.  Its shape is documented in
``static/rea_frontend/js/dictation/score.js``, which is its one reader and
writer.

A *phrase* is the unit a dictation is played in: a start note and an end note
in the score.  It is played as one piece — everything sounding in every part
between those two notes — which is how a classical dictation is given: the
teacher plays the first four bars three times, then the next phrase, and the
students write.
"""

from django.conf import settings
from django.db import models


class Dictation(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True,
        on_delete=models.SET_NULL, related_name="dictations",
        help_text="Who wrote it; the dictation outlives the account.",
    )
    title = models.CharField(max_length=120)
    composer = models.CharField(max_length=120, blank=True)
    description = models.TextField(blank=True)
    score = models.JSONField(default=dict, blank=True)
    phrases = models.JSONField(default=list, blank=True)
    published = models.BooleanField(
        default=False,
        help_text="Offered to students in the Dictation area.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("title", "id")

    def __str__(self) -> str:
        return self.title
