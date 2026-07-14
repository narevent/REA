from django.contrib import admin

from .models import Bar, ChromaticBase, Lesson, MusicEvent


class MusicEventInline(admin.TabularInline):
    model = MusicEvent
    extra = 0


@admin.register(ChromaticBase)
class ChromaticBaseAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "clef", "tempo")


@admin.register(Lesson)
class LessonAdmin(admin.ModelAdmin):
    list_display = (
        "id", "category", "span", "grades", "part",
        "exercise_number", "exercise_type", "timed", "chromatic", "tempo",
    )
    list_filter = ("category", "span", "grades", "timed", "chromatic")
    search_fields = ("exercise_type", "source_file")


@admin.register(Bar)
class BarAdmin(admin.ModelAdmin):
    list_display = ("id", "base", "lesson", "bar_index")
    list_filter = ("lesson__category", "lesson__span")
    inlines = [MusicEventInline]


@admin.register(MusicEvent)
class MusicEventAdmin(admin.ModelAdmin):
    list_display = ("id", "bar", "event_index", "note_name", "alias_degree", "pitch_class")
    search_fields = ("note_name", "alias_degree")
