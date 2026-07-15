"""Import ``lessons`` JSON files (mono and poly) into the database.

Usage::

    python manage.py import_formula
    python manage.py import_formula relative/lessons/mono/Major/Octave
    python manage.py import_formula relative/lessons/poly/ChordsThirds

Files under a ``poly`` folder are imported as polyphonic (harmonic) lessons;
everything else as monophonic formula lessons.  Requires that the referenced
key models already exist in the database (run ``import_key_model`` first).
"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from ...models import KeyModel
from ...services.lesson_generation import generate_lesson_for_key, import_lesson
from ...services.poly_import import import_poly_lesson


class Command(BaseCommand):
    help = "Import lessons (formula) JSON files into the database."

    def add_arguments(self, parser):
        parser.add_argument(
            "path",
            nargs="?",
            default="relative/lessons",
            help="A file or directory of lesson JSON files (relative to project root).",
        )
        parser.add_argument(
            "--clear",
            action="store_true",
            default=True,
            help="Delete existing lessons with the same key/formula/variant before importing.",
        )
        parser.add_argument(
            "--no-clear", dest="clear", action="store_false", help="Keep existing lessons."
        )
        parser.add_argument(
            "--generate-all-keys",
            action="store_true",
            default=False,
            help=(
                "After importing, regenerate each lesson for every other key of the "
                "same mode (the key-independent recipe is replayed)."
            ),
        )

    def handle(self, *args, **options):
        data_dir = Path(settings.REA_DATA_DIR)
        target = Path(options["path"])
        if not target.is_absolute():
            target = data_dir.parent / target
        files = self._collect_files(target)
        if not files:
            self.stdout.write(self.style.WARNING(f"No JSON files found under {target}"))
            return

        if not KeyModel.objects.exists():
            raise CommandError(
                "No key models in the database. Run `import_key_model` first."
            )

        created = 0
        skipped = 0
        with transaction.atomic():
            for fp in files:
                rel = fp.relative_to(data_dir.parent)
                # ``_``-prefixed files are template/backup copies (their content
                # names a different key than the folder they live in) — skip them.
                if fp.name.startswith("_"):
                    skipped += 1
                    continue
                try:
                    data = json.loads(fp.read_text(encoding="utf-8"))
                except json.JSONDecodeError as exc:
                    self.stderr.write(self.style.ERROR(f"  ! {rel}: {exc}"))
                    continue
                is_poly = "poly" in rel.parts
                if is_poly:
                    ex = import_poly_lesson(data, str(rel), clear=options["clear"])
                else:
                    ex = import_lesson(data, str(rel), clear=options["clear"])
                if ex is None:
                    self.stderr.write(self.style.WARNING(f"  ~ {rel}: unparseable or no matching key model, skipped"))
                    skipped += 1
                    continue
                self.stdout.write(self.style.SUCCESS(f"  + {ex}"))
                created += 1

                if options["generate_all_keys"] and not is_poly:
                    self._regenerate_for_all_keys(ex)

        self.stdout.write(self.style.SUCCESS(
            f"\nImported {created} lesson(s); skipped {skipped}."
        ))

    def _regenerate_for_all_keys(self, source_ex):
        mode = source_ex.key_model.mode
        for km in KeyModel.objects.filter(mode=mode).exclude(pk=source_ex.key_model.pk):
            new_ex = generate_lesson_for_key(source_ex, km)
            self.stdout.write(self.style.SQLMANY_TO_ONE(
                f"    ↳ regenerated for {km.name}"
            ))

    @staticmethod
    def _collect_files(target: Path) -> list[Path]:
        if target.is_file():
            return [target]
        if target.is_dir():
            return sorted(target.rglob("*.json"))
        return []