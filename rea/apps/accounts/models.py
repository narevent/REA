"""
User accounts for REA.

Three roles share one login:

  student  practises, and every completed session is recorded so progress can
           be read back over time (see `PracticeSession`).
  teacher  writes dictations in the score editor (/editor/) and keeps drafts
           of their own, and reads the answer key of any exercise so they can
           check a student's work without sitting the exercise themselves.
  admin    everything a teacher can do, and the curriculum itself: creating,
           replacing and deleting the exercises every student is given, and
           setting the house style.

The split is between *one teacher's own material* and *the method*.  A
dictation is a teacher's to write, change and throw away; a curriculum
exercise belongs to everybody using the method, and saving one replaces it
for every student practising it that minute.  Those are different acts with
different blast radii, and until now one role did both.

The project already had users when accounts were added, so the role lives on a
`Profile` attached one-to-one to Django's own `User` rather than in a custom
user model — swapping `AUTH_USER_MODEL` on an existing database is a migration
that buys nothing here.
"""

from django.conf import settings
from django.db import models
from django.utils import timezone


class Role(models.TextChoices):
    STUDENT = "student", "Student"
    TEACHER = "teacher", "Teacher"
    ADMIN = "admin", "Administrator"


class Difficulty(models.TextChoices):
    """How much room the exercises give a singer.

    Intonation is a skill being learned, not a tuner reading.  A student who
    sings a phrase recognisably in tune is doing the thing the exercise is
    teaching, and scoring that at 60 because they averaged forty cents sharp
    teaches them nothing except that the app is impossible.  So the window a
    note is judged in — and how readily the tracker treats a wobble as a
    different note — is the student's to set, and it starts wide.

    The numbers themselves live in the frontend, next to the scoring that uses
    them (`js/difficulty.js`); what is stored here is only which of the three
    the user chose, so it follows them between devices.
    """

    EASY = "easy", "Easy"
    MEDIUM = "medium", "Medium"
    HARD = "hard", "Hard"


class Profile(models.Model):
    """Per-user role and display details."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    role = models.CharField(
        max_length=16,
        choices=Role.choices,
        default=Role.STUDENT,
        help_text=(
            "Students are tracked; teachers write dictations; "
            "administrators own the curriculum."
        ),
    )
    display_name = models.CharField(
        max_length=80,
        blank=True,
        help_text="Shown instead of the username when set.",
    )
    difficulty = models.CharField(
        max_length=16,
        choices=Difficulty.choices,
        default=Difficulty.EASY,
        help_text="How much pitch error the exercises allow before scoring it down.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["user__username"]

    def __str__(self):
        return f"{self.user.username} ({self.get_role_display()})"

    @property
    def is_admin(self):
        return self.role == Role.ADMIN

    @property
    def is_teacher(self):
        """True for anyone who may author at all — an admin is a teacher with
        the curriculum added, not a different kind of user."""
        return self.role in (Role.TEACHER, Role.ADMIN)

    @property
    def is_student(self):
        return self.role == Role.STUDENT

    @property
    def name(self):
        """Best available human name for the user."""
        return self.display_name or self.user.get_full_name() or self.user.username


class PracticeSessionQuerySet(models.QuerySet):
    def for_user(self, user):
        return self.filter(user=user)

    def recent(self, days=30):
        return self.filter(created_at__gte=timezone.now() - timezone.timedelta(days=days))


class PracticeSession(models.Model):
    """
    One completed run of a practice chapter.

    Stored per attempt rather than as a running total, because the point is
    progress *over time*: bests and averages can always be derived from the
    log, but a log cannot be recovered from a total.  The lesson context
    (system / texture / key / formula) is denormalised onto the row so a
    session stays readable even if the underlying lesson is later edited or
    removed — this is a history, not a foreign-key graph.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="practice_sessions",
    )
    chapter_id = models.PositiveSmallIntegerField(help_text="Chapter number, 1-10.")
    chapter_key = models.CharField(max_length=32, help_text="Chapter mode key, e.g. sing_repeat.")
    chapter_title = models.CharField(max_length=120, blank=True)
    score = models.PositiveSmallIntegerField(help_text="Average score for the run, 0-100.")
    rounds = models.PositiveSmallIntegerField(default=0, help_text="Rounds completed in the run.")

    # Lesson context, denormalised (see class docstring).
    system = models.CharField(max_length=16, blank=True)     # relative | absolute
    texture = models.CharField(max_length=16, blank=True)    # mono | poly
    key_name = models.CharField(max_length=64, blank=True)
    formula = models.CharField(max_length=120, blank=True)

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    objects = PracticeSessionQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "-created_at"])]

    def __str__(self):
        return f"{self.user.username} ch{self.chapter_id} {self.score}/100"

    @property
    def passed(self):
        return self.score >= PASS_THRESHOLD


# Mirrors PASS_THRESHOLD in the frontend's chapters.js.  Kept here too so the
# dashboard can label a session without asking the browser.
PASS_THRESHOLD = 70
