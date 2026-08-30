"""Give every user a Profile, including ones created before this app existed."""

from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Profile


@receiver(post_save, sender=settings.AUTH_USER_MODEL)
def ensure_profile(sender, instance, created, **kwargs):
    # get_or_create rather than create-on-`created`: users that predate this
    # app (the project already had one) still need a profile the first time
    # they are saved, and a signup flow that sets the role itself must not
    # trip over a duplicate.
    Profile.objects.get_or_create(user=instance)
