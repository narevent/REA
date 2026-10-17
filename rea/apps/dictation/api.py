"""
The dictation API.

Teachers write dictations; students read the published ones.  A teacher sees
their own and everybody's published dictations, and may change only their
own — an administrator may change any.  The checks are made here, on every
request, whatever the page in front of them offers.
"""

from django.db.models import Q
from rest_framework import generics, permissions
from rest_framework.exceptions import PermissionDenied

from rea.apps.accounts.permissions import is_admin, is_teacher

from .models import Dictation
from .serializers import DictationSerializer, DictationSummarySerializer


def visible_to(user):
    """The dictations *user* may read."""
    if is_admin(user):
        return Dictation.objects.all()
    if is_teacher(user):
        return Dictation.objects.filter(Q(owner=user) | Q(published=True))
    return Dictation.objects.filter(published=True)


def may_change(user, dictation):
    return is_admin(user) or (is_teacher(user) and dictation.owner_id == user.id)


class DictationList(generics.ListCreateAPIView):
    permission_classes = [permissions.IsAuthenticated]
    # A teacher's handful of dictations, listed whole: the page has nothing to
    # page through.
    pagination_class = None

    def get_serializer_class(self):
        return DictationSerializer if self.request.method == "POST" else DictationSummarySerializer

    def get_queryset(self):
        queryset = visible_to(self.request.user).select_related("owner__profile")
        # `?mine=1` is the editor's list: what this teacher can change.
        if self.request.query_params.get("mine") and not is_admin(self.request.user):
            queryset = queryset.filter(owner=self.request.user)
        return queryset

    def perform_create(self, serializer):
        if not is_teacher(self.request.user):
            raise PermissionDenied("Only teachers write dictations.")
        serializer.save(owner=self.request.user)


class DictationDetail(generics.RetrieveUpdateDestroyAPIView):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = DictationSerializer

    def get_queryset(self):
        return visible_to(self.request.user)

    def perform_update(self, serializer):
        if not may_change(self.request.user, serializer.instance):
            raise PermissionDenied("Only the teacher who wrote this dictation may change it.")
        serializer.save()

    def perform_destroy(self, instance):
        if not may_change(self.request.user, instance):
            raise PermissionDenied("Only the teacher who wrote this dictation may delete it.")
        instance.delete()
