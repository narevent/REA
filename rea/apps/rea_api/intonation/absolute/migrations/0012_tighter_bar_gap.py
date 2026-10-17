from django.db import migrations, models


def tighten(apps, schema_editor):
    """Every lesson still on the old 22px gap moves to the new 12px default.
    A gap somebody set on purpose is left as it is."""
    apps.get_model("absolute", "Lesson").objects.filter(mid_bar_space=22).update(mid_bar_space=12)


def loosen(apps, schema_editor):
    apps.get_model("absolute", "Lesson").objects.filter(mid_bar_space=12).update(mid_bar_space=22)


class Migration(migrations.Migration):

    dependencies = [
        ("absolute", "0011_alter_lesson_auto_align"),
    ]

    operations = [
        migrations.AlterField(
            model_name="lesson",
            name="mid_bar_space",
            field=models.PositiveSmallIntegerField(
                default=12,
                help_text="Whitespace between two bars on the page, in pixels.",
            ),
        ),
        migrations.RunPython(tighten, loosen),
    ]
