from django.contrib import admin

from .models import PracticeSession, Profile


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "role", "display_name", "created_at")
    list_filter = ("role",)
    search_fields = ("user__username", "user__email", "display_name")
    # Promoting a student to teacher is an admin action, and the only one when
    # REA_ALLOW_TEACHER_SELF_SIGNUP is off.
    list_editable = ("role",)


@admin.register(PracticeSession)
class PracticeSessionAdmin(admin.ModelAdmin):
    list_display = ("user", "chapter_id", "chapter_title", "score", "created_at")
    list_filter = ("chapter_id", "system", "texture")
    search_fields = ("user__username", "chapter_title", "key_name", "formula")
    date_hierarchy = "created_at"
    readonly_fields = ("created_at",)
