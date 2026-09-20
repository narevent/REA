"""The house style: the look the library already has, written down.

Every exercise in the database was imported with this appearance and has
carried it as a set of unnamed defaults ever since.  Naming it makes it a
thing a teacher can apply, depart from, and come back to — and gives a new
exercise somewhere to start other than the field defaults, which are nobody's
house style in particular.
"""

from django.db import migrations


HOUSE = {
    "name": "House style",
    "description": "How the REA method is set: noteheads only, bars spaced to the line.",
    "is_default": True,
    # On the page: the spacing and wrapping the shared renderer has always
    # used, and the stems it has always hidden.  `auto_align` is off because
    # the renderer has never stretched a line — it shrinks one that overflows
    # and otherwise leaves the bars the width their notes ask for.
    "mid_bar_space": 22,
    "bars_per_row": 0,
    "align_to_center": False,
    "auto_align": False,
    "draw_only_note_heads": True,
    "are_all_notes_same_duration": False,
    # `separator_space` is not here: the field is added by a later migration,
    # and this one has to describe the table as it stands when it runs.
    "note_label_type": "",
    "bar_number_type": "none",
    # In the ear: the imported library's own pacing.
    "mid_bar_time": 0.1,
    "mute_last_played_notes_after_bar_finishes": False,
    "separator_time": 0.0,
    "separator_cancel_previous_note": False,
}


def create_house_style(apps, schema_editor):
    ScoreStyle = apps.get_model("rea_api", "ScoreStyle")
    ScoreStyle.objects.get_or_create(name=HOUSE["name"], defaults=HOUSE)


def drop_house_style(apps, schema_editor):
    ScoreStyle = apps.get_model("rea_api", "ScoreStyle")
    ScoreStyle.objects.filter(name=HOUSE["name"]).delete()


class Migration(migrations.Migration):

    dependencies = [("rea_api", "0001_initial")]

    operations = [migrations.RunPython(create_house_style, drop_house_style)]
