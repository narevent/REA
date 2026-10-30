from django.db import migrations, models


def tighten(apps, schema_editor):
    """Every style still on the 12px gap moves to the new 6px default.
    A gap somebody set on purpose is left as it is."""
    apps.get_model("rea_api", "ScoreStyle").objects.filter(mid_bar_space=12).update(mid_bar_space=6)


def loosen(apps, schema_editor):
    apps.get_model("rea_api", "ScoreStyle").objects.filter(mid_bar_space=6).update(mid_bar_space=12)


class Migration(migrations.Migration):

    dependencies = [
        ("rea_api", "0005_tighter_bar_gap"),
    ]

    operations = [
        migrations.AlterField(
            model_name="scorestyle",
            name="mid_bar_space",
            field=models.PositiveSmallIntegerField(
                default=6,
                help_text="Whitespace between two bars on the page, in pixels.",
            ),
        ),
        migrations.RunPython(tighten, loosen),
    ]
