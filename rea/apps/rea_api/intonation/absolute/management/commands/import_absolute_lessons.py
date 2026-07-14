"""Import absolute ``lessons/mono`` JSON files into the database.

Usage::

    python manage.py import_absolute_lessons
    python manage.py import_absolute_lessons absolute/lessons/mono/Formula/Octave
    python manage.py import_absolute_lessons absolute/lessons/mono/FormulaInverse

Requires that the chromatic base already exists in the database
(run ``import_absolute_base`` first).
"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from ...models import ChromaticBase
from ...services.lesson_generation import import_lesson


class Command(BaseCommand):
    help = "Import absolute lessons (mono) JSON files into the database."

    def add_arguments(self, parser):
        parser.add_argument(
            "path",
            nargs="?",
            default="absolute/lessons/mono",
            help="A file or directory of lesson JSON files (relative to project root).",
        )
        parser.add_argument(
            "--clear",
            action="store_true",
            default=True,
            help="Delete existing lessons with the same identity before importing.",
        )
        parser.add_argument(
            "--no-clear", dest="clear", action="store_false", help="Keep existing lessons."
        )

    def handle(self, *args, **options):
        data_dir = Path(settings.REA_ABSOLUTE_DATA_DIR)
        target = Path(options["path"])
        if not target.is_absolute():
            target = data_dir.parent / target
        files = self._collect_files(target)
        if not files:
            self.stdout.write(self.style.WARNING(f"No JSON files found under {target}"))
            return

        if not ChromaticBase.objects.exists():
            raise CommandError(
                "No chromatic base in the database. Run `import_absolute_base` first."
            )

        created = 0
        skipped = 0
        for fp in files:
            rel = fp.relative_to(data_dir.parent)
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                self.stderr.write(self.style.ERROR(f"  ! {rel}: {exc}"))
                continue
            lesson = import_lesson(data, str(rel), clear=options["clear"])
            if lesson is None:
                self.stderr.write(self.style.WARNING(f"  ~ {rel}: unparseable path, skipped"))
                skipped += 1
                continue
            self.stdout.write(self.style.SUCCESS(f"  + {lesson.display_name}"))
            created += 1

        self.stdout.write(self.style.SUCCESS(
            f"\nImported {created} lesson(s); skipped {skipped}."
        ))

    @staticmethod
    def _collect_files(target: Path) -> list[Path]:
        if target.is_file():
            return [target]
        if target.is_dir():
            return sorted(target.rglob("*.json"))
        return []
