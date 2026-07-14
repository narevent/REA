from django.contrib import admin

from .models import (
    Bar,
    Lesson,
    KeyModel,
    MusicEvent,
    ScaleModel,
    ScaleModelPitch,
    ScaleModelTiming,
)


class ScaleModelTimingInline(admin.TabularInline):
    model = ScaleModelTiming
    extra = 0


class ScaleModelPitchInline(admin.TabularInline):
    model = ScaleModelPitch
    extra = 0


@admin.register(ScaleModel)
class ScaleModelAdmin(admin.ModelAdmin):
    list_display = ("id", "mode", "reference_key", "clef")
    list_filter = ("mode",)
    inlines = [ScaleModelTimingInline, ScaleModelPitchInline]


@admin.register(KeyModel)
class KeyModelAdmin(admin.ModelAdmin):
    list_display = ("id", "name", "mode", "root_pitch_class", "scale_model")
    list_filter = ("mode",)
    search_fields = ("name",)


class MusicEventInline(admin.TabularInline):
    model = MusicEvent
    extra = 0


@admin.register(Bar)
class BarAdmin(admin.ModelAdmin):
    list_display = ("id", "key_model", "lesson", "bar_index", "degree")
    list_filter = ("key_model__mode",)
    inlines = [MusicEventInline]


@admin.register(Lesson)
class LessonAdmin(admin.ModelAdmin):
    list_display = ("id", "key_model", "formula_name", "variant", "tempo")
    list_filter = ("formula_name",)


@admin.register(MusicEvent)
class MusicEventAdmin(admin.ModelAdmin):
    list_display = ("id", "bar", "event_index", "note_name", "alias_degree", "pitch_class")
    search_fields = ("note_name", "alias_degree")