"""Rename the Exercise model/field to Lesson (the concept is now "lesson").

Preserves existing data by using RenameModel/RenameField instead of
drop-and-recreate.  The ``exercises`` folder on disk was renamed to
``lessons``; the API route and frontend now say "lessons" too.  The name
"exercise" is freed for a future view.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("relative", "0001_initial"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="Exercise",
            new_name="Lesson",
        ),
        migrations.RenameField(
            model_name="Bar",
            old_name="exercise",
            new_name="lesson",
        ),
        migrations.AlterUniqueTogether(
            name="Lesson",
            unique_together={("key_model", "formula_name", "variant")},
        ),
    ]