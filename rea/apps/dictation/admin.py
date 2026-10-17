from django.contrib import admin

from .models import Dictation


@admin.register(Dictation)
class DictationAdmin(admin.ModelAdmin):
    list_display = ("title", "composer", "owner", "published", "updated_at")
    list_filter = ("published",)
    search_fields = ("title", "composer")
