"""
Turning a student's session log into the numbers a dashboard shows.

Everything here is derived from `PracticeSession` rows on demand rather than
kept as running totals, so the history stays the single source of truth: a
mis-recorded session can be deleted and every figure corrects itself.
"""

from collections import OrderedDict

from django.db.models import Avg, Count, Max
from django.utils import timezone

from .models import PASS_THRESHOLD, PracticeSession

# Chapter numbers and titles, mirroring the frontend's chapters.js.  Held here
# so the dashboard can name a chapter without the browser being involved.
CHAPTER_TITLES = OrderedDict([
    (1, "Listening"),
    (2, "Singing with repetition"),
    (3, "Guessing"),
    (4, "Guessing (timed)"),
    (5, "Singing proposed"),
    (6, "Guessing notes"),
    (7, "Guessing notes (timed)"),
    (8, "Singing proposed notes"),
    (9, "Singing proposed notes (timed)"),
    (10, "Guessing notes (multi)"),
])

TREND_DAYS = 30
RECENT_LIMIT = 12


def overview(user):
    """Headline figures: how much practice, how well, how consistently."""
    qs = PracticeSession.objects.for_user(user)
    agg = qs.aggregate(total=Count("id"), avg=Avg("score"), best=Max("score"))
    total = agg["total"] or 0
    chapters = chapter_breakdown(user)
    completed = sum(1 for c in chapters if c["completed"])
    return {
        "total_sessions": total,
        "average_score": round(agg["avg"]) if agg["avg"] is not None else None,
        "best_score": agg["best"],
        "chapters_completed": completed,
        "chapters_total": len(CHAPTER_TITLES),
        "streak_days": practice_streak_days(user),
        "last_practised": qs.values_list("created_at", flat=True).first(),
    }


def chapter_breakdown(user):
    """Per-chapter bests and attempts, in chapter order, including untouched ones."""
    rows = {
        r["chapter_id"]: r
        for r in PracticeSession.objects.for_user(user)
        .values("chapter_id")
        .annotate(attempts=Count("id"), best=Max("score"), avg=Avg("score"))
    }
    out = []
    for number, title in CHAPTER_TITLES.items():
        row = rows.get(number)
        best = row["best"] if row else None
        out.append({
            "number": number,
            "title": title,
            "attempts": row["attempts"] if row else 0,
            "best": best,
            "average": round(row["avg"]) if row and row["avg"] is not None else None,
            "completed": best is not None and best >= PASS_THRESHOLD,
        })
    return out


def daily_trend(user, days=TREND_DAYS):
    """
    Average score per day over the recent window, oldest first.

    Days without practice are included as gaps (`score` None) rather than
    dropped, so the chart's x-axis is real time and a fortnight off looks like
    a fortnight off.
    """
    since = timezone.now() - timezone.timedelta(days=days - 1)
    rows = (
        PracticeSession.objects.for_user(user)
        .filter(created_at__gte=since)
        .values_list("created_at", "score")
    )
    by_day = {}
    for created_at, score in rows:
        day = timezone.localtime(created_at).date()
        by_day.setdefault(day, []).append(score)

    today = timezone.localtime(timezone.now()).date()
    out = []
    for offset in range(days - 1, -1, -1):
        day = today - timezone.timedelta(days=offset)
        scores = by_day.get(day)
        out.append({
            "date": day,
            "score": round(sum(scores) / len(scores)) if scores else None,
            "sessions": len(scores) if scores else 0,
        })
    return out


def practice_streak_days(user):
    """Consecutive days practised, counting back from today (or yesterday)."""
    days = {
        timezone.localtime(dt).date()
        for dt in PracticeSession.objects.for_user(user).values_list("created_at", flat=True)
    }
    if not days:
        return 0
    today = timezone.localtime(timezone.now()).date()
    # Practising yesterday but not yet today still counts as a live streak.
    cursor = today if today in days else today - timezone.timedelta(days=1)
    streak = 0
    while cursor in days:
        streak += 1
        cursor -= timezone.timedelta(days=1)
    return streak


def recent_sessions(user, limit=RECENT_LIMIT):
    qs = PracticeSession.objects.for_user(user)[:limit]
    return [
        {
            "session": s,
            "title": s.chapter_title or CHAPTER_TITLES.get(s.chapter_id, f"Chapter {s.chapter_id}"),
            "passed": s.score >= PASS_THRESHOLD,
        }
        for s in qs
    ]


def trend_polyline(trend, width=520, height=90, pad=6):
    """
    Lay the daily trend out as SVG polyline points.

    Done here rather than in a template filter because the dashboard is a
    server-rendered page with no charting library: the shape of the data and
    the shape of the line are the same decision.  Returns "" when there is not
    enough data to draw a line.
    """
    points = [(i, d["score"]) for i, d in enumerate(trend) if d["score"] is not None]
    if len(points) < 2:
        return ""
    span = max(len(trend) - 1, 1)
    inner_w = width - 2 * pad
    inner_h = height - 2 * pad
    return " ".join(
        f"{pad + (i / span) * inner_w:.1f},{pad + (1 - score / 100) * inner_h:.1f}"
        for i, score in points
    )
