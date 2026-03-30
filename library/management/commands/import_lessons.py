"""
Management command: import_midi_lessons

Walks a midi_lessons folder (produced by rmp_to_midi.py) and creates or
updates the full model hierarchy for every .mid file found.

Expected folder layout (mirrors the rmp source tree):
    <midi_root>/
        <Category>/               e.g. Tonal, Rhythm, Dictates
            <Approach>/           e.g. Absolute, Relative
                <LessonType>/     e.g. Absolute formula, Relative formula
                    [group …]/    any number of intermediate sub-folders
                        <lesson_folder>/
                            exercise.mid

Each leaf folder becomes a Lesson.
Each .mid file inside it becomes an Exercise linked to that Lesson.

Usage
-----
    python manage.py import_midi_lessons /path/to/midi_lessons
    python manage.py import_midi_lessons /path/to/midi_lessons --dry-run
    python manage.py import_midi_lessons /path/to/midi_lessons --clear

Options
-------
    --dry-run   Print what would be created without touching the database.
    --clear     Delete all existing Lesson + Exercise records before importing.
"""

import os
import re
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.text import slugify

from ...models import Category, Approach, LessonType, LessonGroup, Lesson, Exercise


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Minimum number of path segments needed between the midi root and a .mid file:
#   Category / Approach / LessonType / lesson_folder / file.mid  →  4 segments + file
MIN_DEPTH = 4


def folder_to_title(folder_name: str) -> str:
    """
    Convert a raw folder name to a human-readable title.

    '1_AF-8_1_dio'            → 'AF 8 1 dio'
    '3_1_ C-dur formula PR'   → 'C dur formula PR'
    'Dijatonika'              → 'Dijatonika'
    """
    # Strip leading numeric order prefix  (e.g. "1_", "3_2_ ")
    title = re.sub(r"^\d+[_\s]*(\d+[_\s]*)?", "", folder_name).strip()
    # Replace hyphens / underscores with spaces
    title = re.sub(r"[-_]+", " ", title).strip()
    return title or folder_name


def parse_approach(raw: str) -> str:
    """Map a folder name to a canonical Approach name value."""
    mapping = {
        "absolute": Approach.ABSOLUTE,
        "relative": Approach.RELATIVE,
    }
    return mapping.get(raw.lower(), raw.lower())


def parse_category(raw: str) -> str:
    """Map a folder name to a canonical Category name value."""
    mapping = {
        "tonal": Category.TONAL,
        "rhythm": Category.RHYTHM,
        "dictates": Category.DICTATES,
    }
    return mapping.get(raw.lower(), raw.lower())


def get_or_create_category(name_raw: str, dry_run: bool) -> "Category | None":
    name = parse_category(name_raw)
    if name not in dict(Category.CATEGORY_CHOICES):
        # Unknown top-level folder — treat as Tonal by default and warn
        return None
    if dry_run:
        return Category(name=name, label=name_raw)
    obj, _ = Category.objects.get_or_create(name=name, defaults={"label": name_raw})
    return obj


def get_or_create_approach(category: "Category", name_raw: str, dry_run: bool) -> "Approach | None":
    name = parse_approach(name_raw)
    if name not in dict(Approach.APPROACH_CHOICES):
        return None
    if dry_run:
        return Approach(category=category, name=name)
    obj, _ = Approach.objects.get_or_create(
        category=category, name=name
    )
    return obj


def get_or_create_lesson_type(approach: "Approach", name_raw: str, dry_run: bool) -> "LessonType":
    slug = slugify(name_raw)
    if dry_run:
        return LessonType(approach=approach, name=name_raw, slug=slug)
    obj, _ = LessonType.objects.get_or_create(
        approach=approach,
        slug=slug,
        defaults={"name": name_raw, "order": 0},
    )
    return obj


def get_or_create_group(
    *,
    parent: "LessonGroup | None",
    lesson_type: "LessonType | None",
    folder_name: str,
    order: int,
    dry_run: bool,
) -> "LessonGroup":
    """
    Get or create a LessonGroup node.
    Exactly one of `parent` or `lesson_type` should be non-None for root nodes.
    """
    name = folder_to_title(folder_name) or folder_name
    if dry_run:
        grp = LessonGroup(
            parent=parent,
            lesson_type=lesson_type,
            name=name,
            folder_name=folder_name,
            order=order,
        )
        grp.pk = -1  # sentinel so parent references work in dry-run prints
        return grp

    if parent is not None:
        obj, _ = LessonGroup.objects.get_or_create(
            parent=parent,
            folder_name=folder_name,
            defaults={"name": name, "lesson_type": None, "order": order},
        )
    else:
        obj, _ = LessonGroup.objects.get_or_create(
            lesson_type=lesson_type,
            parent=None,
            folder_name=folder_name,
            defaults={"name": name, "order": order},
        )
    return obj


def get_or_create_lesson(group: "LessonGroup", folder_name: str, order: int, dry_run: bool) -> "Lesson":
    title = folder_to_title(folder_name)
    if dry_run:
        return Lesson(group=group, folder_name=folder_name, title=title, order=order)
    obj, _ = Lesson.objects.get_or_create(
        group=group,
        folder_name=folder_name,
        defaults={"title": title, "order": order},
    )
    return obj


def get_or_create_exercise(midi_path: str, dry_run: bool) -> "Exercise":
    """Create or retrieve an Exercise by its midi file path."""
    # Store path relative to the midi root so it matches Django's upload_to
    if dry_run:
        return Exercise(midi=midi_path)
    obj, _ = Exercise.objects.get_or_create(
        midi=midi_path,
        defaults={"category": "pitch"},
    )
    return obj


# ---------------------------------------------------------------------------
# Core walker
# ---------------------------------------------------------------------------

def walk_midi_root(midi_root: str, dry_run: bool, stdout, style):
    """
    Walk the midi_root tree and create/update model instances.

    Returns (lessons_created, exercises_created, skipped) counts.
    """
    lessons_created = 0
    exercises_created = 0
    skipped = 0

    midi_root = os.path.normpath(midi_root)

    for dirpath, dirnames, filenames in os.walk(midi_root):
        dirnames.sort()  # deterministic order
        mid_files = sorted(f for f in filenames if f.lower().endswith(".mid"))
        if not mid_files:
            continue

        # Build the relative path segments from midi_root → this folder
        rel = os.path.relpath(dirpath, midi_root)
        parts = rel.split(os.sep)  # e.g. ['Tonal', 'Absolute', 'Absolute formula', 'Octave', '1_AF-8_1_dio']

        if len(parts) < MIN_DEPTH:
            stdout.write(
                style.WARNING(
                    f"  Skipping '{rel}' — not deep enough "
                    f"(need {MIN_DEPTH}+ segments, got {len(parts)})"
                )
            )
            skipped += len(mid_files)
            continue

        # --- fixed spine ---
        category_raw, approach_raw, lesson_type_raw = parts[0], parts[1], parts[2]
        # Everything between lesson_type and the leaf folder = intermediate groups
        group_parts = parts[3:-1]   # may be empty
        lesson_folder = parts[-1]   # leaf folder name

        category = get_or_create_category(category_raw, dry_run)
        if category is None:
            stdout.write(style.WARNING(f"  Unknown category '{category_raw}' — skipping {rel}"))
            skipped += len(mid_files)
            continue

        approach = get_or_create_approach(category, approach_raw, dry_run)
        if approach is None:
            stdout.write(style.WARNING(f"  Unknown approach '{approach_raw}' — skipping {rel}"))
            skipped += len(mid_files)
            continue

        lesson_type = get_or_create_lesson_type(approach, lesson_type_raw, dry_run)

        # --- build group chain ---
        parent_group = None
        for idx, gpart in enumerate(group_parts):
            parent_group = get_or_create_group(
                parent=parent_group,
                lesson_type=lesson_type if parent_group is None else None,
                folder_name=gpart,
                order=idx,
                dry_run=dry_run,
            )

        # The leaf folder itself needs a group node too (so Lesson can hang off it)
        leaf_group = get_or_create_group(
            parent=parent_group,
            lesson_type=lesson_type if parent_group is None else None,
            folder_name=lesson_folder,
            order=len(group_parts),
            dry_run=dry_run,
        )

        # --- lesson ---
        lesson = get_or_create_lesson(leaf_group, lesson_folder, order=0, dry_run=dry_run)
        lessons_created += 1

        # --- exercises ---
        for midi_file in mid_files:
            # Store relative path from midi_root for portability
            rel_midi = os.path.join(rel, midi_file)
            exercise = get_or_create_exercise(rel_midi, dry_run)
            if not dry_run:
                lesson.exercises.add(exercise)
            exercises_created += 1

            if dry_run:
                stdout.write(f"    [DRY RUN] Would create: {rel}/{midi_file}")
            else:
                stdout.write(f"  ✓  {rel_midi}")

    return lessons_created, exercises_created, skipped


# ---------------------------------------------------------------------------
# Command
# ---------------------------------------------------------------------------

class Command(BaseCommand):
    help = (
        "Import .mid files from a midi_lessons folder tree into the Lesson / Exercise models. "
        "The folder structure must follow: <Category>/<Approach>/<LessonType>/[groups…]/<lesson>/<file>.mid"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "midi_root",
            type=str,
            help="Path to the root midi_lessons folder to import from.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            default=False,
            help="Simulate the import without writing to the database.",
        )
        parser.add_argument(
            "--clear",
            action="store_true",
            default=False,
            help="Delete all existing Lesson and Exercise records before importing.",
        )

    def handle(self, *args, **options):
        midi_root = options["midi_root"]
        dry_run = options["dry_run"]
        do_clear = options["clear"]

        if not os.path.isdir(midi_root):
            raise CommandError(f"'{midi_root}' is not a directory.")

        if dry_run:
            self.stdout.write(self.style.WARNING("--- DRY RUN — no database changes will be made ---\n"))

        if do_clear and not dry_run:
            self.stdout.write(self.style.WARNING("Clearing existing Lesson and Exercise records…"))
            Lesson.objects.all().delete()
            Exercise.objects.all().delete()
            self.stdout.write(self.style.SUCCESS("  Cleared.\n"))

        self.stdout.write(f"Scanning: {midi_root}\n")

        with transaction.atomic():
            lessons, exercises, skipped = walk_midi_root(
                midi_root, dry_run, self.stdout, self.style
            )
            if dry_run:
                # Roll back any accidental writes in dry-run mode
                transaction.set_rollback(True)

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(
            f"Done.  Lessons: {lessons}  |  Exercises: {exercises}  |  Skipped files: {skipped}"
        ))