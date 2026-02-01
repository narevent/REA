# users/admin.py
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import User, Instrument, UserInstrument


class UserInstrumentInline(admin.TabularInline):
    """
    Inline admin for user instruments
    """
    model = UserInstrument
    extra = 1


class UserAdmin(BaseUserAdmin):
    """
    Custom admin class for our User model
    """
    list_display = ('username', 'email', 'first_name', 'last_name', 'user_type', 'is_staff')
    list_filter = ('user_type', 'is_staff', 'is_superuser', 'date_joined')
    fieldsets = BaseUserAdmin.fieldsets + (
        ('Custom Fields', {'fields': ('user_type', 'date_of_birth')}),
    )
    add_fieldsets = BaseUserAdmin.add_fieldsets + (
        ('Custom Fields', {'fields': ('user_type', 'date_of_birth')}),
    )
    search_fields = ('username', 'email', 'first_name', 'last_name')
    ordering = ('username',)
    inlines = [UserInstrumentInline]


class InstrumentAdmin(admin.ModelAdmin):
    """
    Admin for Instrument model
    """
    list_display = ('name', 'family')
    list_filter = ('family',)
    search_fields = ('name', 'description')


class UserInstrumentAdmin(admin.ModelAdmin):
    """
    Admin for UserInstrument model
    """
    list_display = ('user', 'instrument', 'proficiency', 'years_of_experience')
    list_filter = ('proficiency', 'instrument')
    search_fields = ('user__username', 'instrument__name', 'notes')


admin.site.register(User, UserAdmin)
admin.site.register(Instrument, InstrumentAdmin)
admin.site.register(UserInstrument, UserInstrumentAdmin)