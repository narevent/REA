"""Import the absolute chromatic-base JSON file(s) into the database.

Usage::

    python manage.py import_absolute_base
    python manage.py import_absolute_base absolute/key_models/Base/Ap_12.json
"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand

from ...services.base_generation import import_chromatic_base


class Command(BaseCommand):
    help = "Import absolute key_models (chromatic base) JSON files into the database."

    def add_arguments(self, parser):
        parser.add_argument(
            "path",
            nargs="?",
            default="absolute/key_models",
            help="A file or directory of chromatic-base JSON files (relative to project root).",
        )
        parser.add_argument(
            "--clear",
            action="store_true",
            default=True,
            help="Delete existing bases with the same name before importing (default).",
        )
        parser.add_argument(
            "--no-clear", dest="clear", action="store_false", help="Keep existing bases."
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

        created = 0
        for fp in files:
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                self.stderr.write(self.style.ERROR(f"  ! {fp.name}: {exc}"))
                continue
            base = import_chromatic_base(data, fp.name, clear=options["clear"])
            self.stdout.write(self.style.SUCCESS(f"  + {base.name} ({base.bars.count()} bars)"))
            created += 1
        self.stdout.write(self.style.SUCCESS(f"\nImported {created} chromatic base(s)."))

    @staticmethod
    def _collect_files(target: Path) -> list[Path]:
        if target.is_file():
            return [target]
        if target.is_dir():
            return sorted(target.rglob("*.json"))
        return []
