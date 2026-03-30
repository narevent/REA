from django.contrib import admin
from .models import Category, Approach, LessonType, Key, LessonGroup, Lesson, Exercise


@admin.register(Exercise)
class ExerciseAdmin(admin.ModelAdmin):
    list_display = ["id", "category", "polyphonic", "midi", "created"]
    list_filter = ["category", "polyphonic"]
    search_fields = ["midi"]
    readonly_fields = ["created", "modified"]


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    list_display = ["name", "label"]


@admin.register(Approach)
class ApproachAdmin(admin.ModelAdmin):
    list_display = ["name", "category"]
    list_filter = ["category"]


@admin.register(LessonType)
class LessonTypeAdmin(admin.ModelAdmin):
    list_display = ["name", "approach", "order"]
    list_filter = ["approach__category", "approach"]
    search_fields = ["name", "slug"]


@admin.register(Key)
class KeyAdmin(admin.ModelAdmin):
    list_display = ["tonic", "mode", "folder_code"]
    list_filter = ["mode"]


@admin.register(LessonGroup)
class LessonGroupAdmin(admin.ModelAdmin):
    list_display = ["name", "folder_name", "lesson_type", "parent", "key", "order"]
    list_filter = ["lesson_type__approach__category", "key__mode"]
    search_fields = ["name", "folder_name"]
    raw_id_fields = ["parent", "lesson_type", "key"]


@admin.register(Lesson)
class LessonAdmin(admin.ModelAdmin):
    list_display = ["title", "folder_name", "group", "order", "created"]
    list_filter = [
        "group__lesson_type__approach__category",
        "group__lesson_type__approach",
    ]
    search_fields = ["title", "folder_name"]
    raw_id_fields = ["group"]
    filter_horizontal = ["exercises"]
    readonly_fields = ["created", "modified"]