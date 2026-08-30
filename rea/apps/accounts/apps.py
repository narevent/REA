from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "rea.apps.accounts"
    label = "accounts"

    def ready(self):
        # Registers the signal that gives every new user a Profile.
        from . import signals  # noqa: F401
